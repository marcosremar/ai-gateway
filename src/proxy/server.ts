/**
 * OpenAI-Compatible Proxy Server — pure Node.js http.createServer.
 * No Express/Hono dependency.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { validateAuth } from './middleware/auth';
import { RateLimiter } from './middleware/rate-limit';
import { handleChatCompletions } from './routes/chat-completions';
import { handleEmbeddings } from './routes/embeddings';
import { handleAudioSpeech } from './routes/audio-speech';
import { handleAudioTranscriptions } from './routes/audio-transcriptions';
import { handleModels } from './routes/models';
import type { ProxyConfig, ProxyRequest, ProxyResponse } from './types';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendResponse(res: ServerResponse, proxyRes: ProxyResponse): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...proxyRes.headers,
  };

  res.writeHead(proxyRes.status, headers);

  if (Buffer.isBuffer(proxyRes.body)) {
    res.end(proxyRes.body);
  } else if (typeof proxyRes.body === 'string') {
    res.end(proxyRes.body);
  } else {
    res.end(JSON.stringify(proxyRes.body));
  }
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'server_error' } }));
}

interface MultipartPart {
  name?: string;
  filename?: string;
  data: Buffer;
}

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const endBuf = Buffer.from(`--${boundary}--`);

  let start = body.indexOf(boundaryBuf);
  if (start === -1) return parts;

  while (true) {
    start += boundaryBuf.length;
    // Skip \r\n after boundary
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;

    const nextBoundary = body.indexOf(boundaryBuf, start);
    if (nextBoundary === -1) break;

    const partBuf = body.subarray(start, nextBoundary);

    // Split headers from body at \r\n\r\n
    const headerEnd = partBuf.indexOf('\r\n\r\n');
    if (headerEnd === -1) { start = nextBoundary; continue; }

    const headerStr = partBuf.subarray(0, headerEnd).toString();
    let partData = partBuf.subarray(headerEnd + 4);
    // Trim trailing \r\n before boundary
    if (partData.length >= 2 && partData[partData.length - 2] === 0x0d && partData[partData.length - 1] === 0x0a) {
      partData = partData.subarray(0, partData.length - 2);
    }

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);

    parts.push({
      name: nameMatch?.[1],
      filename: filenameMatch?.[1],
      data: Buffer.from(partData),
    });

    // Check if next boundary is the end marker
    if (body.indexOf(endBuf, nextBoundary) === nextBoundary) break;
    start = nextBoundary;
  }

  return parts;
}

export function createProxyServer(config: ProxyConfig): Server {
  const apiKeys = config.apiKeys || [];
  const rateLimiter = config.rateLimit ? new RateLimiter(config.rateLimit.rpm) : null;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method?.toUpperCase() || 'GET';
    const url = req.url || '/';

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    // Auth
    const authHeader = req.headers.authorization;
    if (!validateAuth(authHeader, apiKeys)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }

    // Rate limit
    if (rateLimiter) {
      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
      if (!rateLimiter.check(ip)) {
        sendError(res, 429, 'Rate limit exceeded');
        return;
      }
    }

    // Block direct streaming transport routes — clients must use POST /v1/speech
    const path = url.split('?')[0];
    if (path === '/api/stream-audio' || path === '/ws/stream' || path === '/api/offer') {
      sendError(res, 410, `Streaming transport ${path} is removed. Use POST /v1/speech instead.`);
      return;
    }

    // Block WebSocket upgrades to streaming paths
    if (req.headers.upgrade?.toLowerCase() === 'websocket') {
      sendError(res, 410, 'WebSocket transport is removed. Use POST /v1/speech instead.');
      return;
    }

    // Custom routes (bypass body parsing — handler owns the request)
    if (config.customRoutes) {
      for (const route of config.customRoutes) {
        if (method === route.method.toUpperCase() && path === route.path) {
          await route.handler(req, res);
          return;
        }
      }
    }

    try {
      let rawBody = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
      let body: unknown = {};
      if (rawBody.length > 0) {
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('application/json')) {
          try { body = JSON.parse(rawBody.toString()); } catch { body = {}; }
        } else if (contentType.includes('multipart/form-data')) {
          // Extract text fields from multipart body so route handlers can read body.model etc.
          const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
          if (boundaryMatch) {
            const boundary = boundaryMatch[1];
            const parts = parseMultipart(rawBody, boundary);
            const fields: Record<string, string> = {};
            for (const part of parts) {
              if (part.filename) {
                // File part — use its content as rawBody for the route handler
                rawBody = part.data;
              } else if (part.name) {
                fields[part.name] = part.data.toString();
              }
            }
            body = fields;
          }
        }
      }

      const proxyReq: ProxyRequest = {
        method,
        url,
        headers: req.headers as Record<string, string>,
        body,
        rawBody,
      };

      let proxyRes: ProxyResponse;

      // Route matching
      if (method === 'GET' && url === '/v1/models') {
        proxyRes = handleModels(config.providers);
      } else if (method === 'POST' && url === '/v1/chat/completions') {
        if (!config.providers.chat) {
          proxyRes = { status: 404, body: { error: { message: 'No chat providers configured', type: 'invalid_request_error' } } };
        } else {
          proxyRes = await handleChatCompletions(proxyReq, config.providers.chat, config.cache, config.hooks);
        }
      } else if (method === 'POST' && url === '/v1/embeddings') {
        if (!config.providers.embedding) {
          proxyRes = { status: 404, body: { error: { message: 'No embedding providers configured', type: 'invalid_request_error' } } };
        } else {
          proxyRes = await handleEmbeddings(proxyReq, config.providers.embedding);
        }
      } else if (method === 'POST' && url === '/v1/audio/speech') {
        if (!config.providers.tts) {
          proxyRes = { status: 404, body: { error: { message: 'No TTS providers configured', type: 'invalid_request_error' } } };
        } else {
          proxyRes = await handleAudioSpeech(proxyReq, config.providers.tts);
        }
      } else if (method === 'POST' && url === '/v1/audio/transcriptions') {
        if (!config.providers.stt) {
          proxyRes = { status: 404, body: { error: { message: 'No STT providers configured', type: 'invalid_request_error' } } };
        } else {
          proxyRes = await handleAudioTranscriptions(proxyReq, config.providers.stt);
        }
      } else if (method === 'GET' && url === '/health') {
        proxyRes = { status: 200, body: { status: 'ok' } };
      } else {
        proxyRes = { status: 404, body: { error: { message: `Route not found: ${method} ${url}`, type: 'invalid_request_error' } } };
      }

      sendResponse(res, proxyRes);
    } catch (err) {
      sendError(res, 500, String(err));
    }
  });

  return server;
}

/** Start the proxy server and return a promise that resolves when listening */
export function startProxy(config: ProxyConfig): Promise<Server> {
  const server = createProxyServer(config);
  const port = config.port || 4000;
  const hostname = config.hostname || '0.0.0.0';

  return new Promise((resolve) => {
    server.listen(port, hostname, () => {
      console.log(`[ai-gateway proxy] Listening on ${hostname}:${port}`);
      resolve(server);
    });
  });
}
