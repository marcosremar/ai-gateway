/**
 * OpenAI-Compatible Proxy Server — pure Node.js http.createServer.
 * No Express/Hono dependency.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, extname } from 'path';
import { validateAuth } from './middleware/auth';
import { RateLimiter } from './middleware/rate-limit';
import { handleChatCompletions } from './routes/chat-completions';
import { handleEmbeddings } from './routes/embeddings';
import { handleAudioSpeech } from './routes/audio-speech';
import { handleAudioTranscriptions } from './routes/audio-transcriptions';
import { handleModels } from './routes/models';
import type { ProxyConfig, ProxyRequest, ProxyResponse } from './types';

/** Max request body size: 100MB (audio files can be large) */
const MAX_BODY_SIZE = 100 * 1024 * 1024;

const BODY_READ_TIMEOUT_MS = 30_000;

class BodyTimeoutError extends Error {
  constructor(ms: number) {
    super(`Body read timed out after ${ms}ms`);
    this.name = 'BodyTimeoutError';
  }
}

function readBody(req: IncomingMessage, maxSize = MAX_BODY_SIZE): Promise<Buffer> {
  const inner = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        req.destroy();
        reject(new Error(`Request body too large (limit: ${Math.round(maxSize / 1024 / 1024)}MB)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  return Promise.race([
    inner,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new BodyTimeoutError(BODY_READ_TIMEOUT_MS)), BODY_READ_TIMEOUT_MS),
    ),
  ]);
}

/** Security headers applied to all responses */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

function sendResponse(res: ServerResponse, proxyRes: ProxyResponse, requestId: string): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Request-Id': requestId,
    ...SECURITY_HEADERS,
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

function sendError(res: ServerResponse, status: number, message: string, requestId?: string): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...SECURITY_HEADERS,
    ...(requestId ? { 'X-Request-Id': requestId } : {}),
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify({ error: { message, type: 'server_error' } }));
}

interface MultipartPart {
  name?: string;
  filename?: string;
  data: Buffer;
}

/** Max size for a single text field in multipart (1MB) */
const MAX_FIELD_SIZE = 1 * 1024 * 1024;
/** Max number of parts in multipart request */
const MAX_PARTS = 20;
/** Max upload file size (configurable via MAX_UPLOAD_SIZE_MB env var, default 50MB) */
const MAX_UPLOAD_SIZE_BYTES = (parseInt(process.env.MAX_UPLOAD_SIZE_MB || '50', 10)) * 1024 * 1024;
/** Max total upload size across all parts (configurable via MAX_TOTAL_UPLOAD_SIZE_MB env var, default 100MB) */
const MAX_TOTAL_UPLOAD_BYTES = (parseInt(process.env.MAX_TOTAL_UPLOAD_SIZE_MB || '100', 10)) * 1024 * 1024;
/** Warn threshold for large uploads (10MB) */
const UPLOAD_WARN_THRESHOLD = 10 * 1024 * 1024;

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  let totalBytes = 0;
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const endBuf = Buffer.from(`--${boundary}--`);

  // Validate that the body contains the closing boundary
  if (body.indexOf(endBuf) === -1) {
    throw new Error('Malformed multipart body: missing closing boundary (truncated upload?)');
  }

  let start = body.indexOf(boundaryBuf);
  if (start === -1) return parts;

  while (true) {
    if (parts.length >= MAX_PARTS) break;

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

    // Enforce max upload file size
    if (filenameMatch && partData.length > MAX_UPLOAD_SIZE_BYTES) {
      throw new Error(
        `File "${filenameMatch[1]}" exceeds max upload size of ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB`,
      );
    }

    // Warn on large uploads
    if (filenameMatch && partData.length > UPLOAD_WARN_THRESHOLD) {
      console.warn(
        `[multipart] Large upload: file "${filenameMatch[1]}" is ${(partData.length / (1024 * 1024)).toFixed(1)}MB`,
      );
    }

    // Enforce size limit on non-file text fields
    if (!filenameMatch && partData.length > MAX_FIELD_SIZE) {
      console.warn(`[multipart] Field "${nameMatch?.[1]}" exceeds ${MAX_FIELD_SIZE} byte limit, skipping`);
      start = nextBoundary;
      continue;
    }

    // Enforce total upload size across all parts
    totalBytes += partData.length;
    if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
      throw new Error(`Total upload size exceeds limit (${MAX_TOTAL_UPLOAD_BYTES / (1024 * 1024)}MB)`);
    }

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

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

function serveStaticFile(staticDir: string, urlPath: string, res: ServerResponse, requestId: string): boolean {
  // Prevent path traversal
  const safePath = urlPath.replace(/\.\./g, '').replace(/\/+/g, '/');

  // Try exact file, then with .html, then as directory/index.html
  const candidates = [
    join(staticDir, safePath),
    join(staticDir, safePath + '.html'),
    join(staticDir, safePath, 'index.html'),
  ];

  // For root path, try index.html
  if (safePath === '/') {
    candidates.unshift(join(staticDir, 'index.html'));
  }

  for (const filePath of candidates) {
    try {
      if (!existsSync(filePath)) continue;
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;

      const ext = extname(filePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const content = readFileSync(filePath);

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': content.length.toString(),
        'X-Request-Id': requestId,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
        ...SECURITY_HEADERS,
      });
      res.end(content);
      return true;
    } catch {
      continue;
    }
  }

  // SPA fallback: serve index.html for non-file paths (client-side routing)
  const indexPath = join(staticDir, 'index.html');
  if (existsSync(indexPath) && !extname(safePath)) {
    try {
      const content = readFileSync(indexPath);
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Length': content.length.toString(),
        'X-Request-Id': requestId,
        'Cache-Control': 'no-cache',
        ...SECURITY_HEADERS,
      });
      res.end(content);
      return true;
    } catch {
      // fall through
    }
  }

  return false;
}

export function createProxyServer(config: ProxyConfig): Server {
  const apiKeys = config.apiKeys || [];
  const rateLimiter = config.rateLimit ? new RateLimiter(config.rateLimit.rpm) : null;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method?.toUpperCase() || 'GET';
    const url = req.url || '/';
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();

    // CORS origin validation
    const corsOriginsEnv = process.env.CORS_ORIGINS || '*';
    const requestOrigin = req.headers.origin || '';
    let allowedOrigin = '*';
    if (corsOriginsEnv !== '*') {
      const allowedOrigins = corsOriginsEnv.split(',').map(o => o.trim()).filter(Boolean);
      const isLocalhost = /^http:\/\/localhost(:\d+)?$/.test(requestOrigin);
      if (isLocalhost || allowedOrigins.includes(requestOrigin)) {
        allowedOrigin = requestOrigin;
      } else {
        allowedOrigin = allowedOrigins[0] || '*';
      }
    }

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'X-Request-Id': requestId,
        ...SECURITY_HEADERS,
      });
      res.end();
      return;
    }

    // Set CORS origin header for all non-preflight responses
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);

    // Auth
    const authHeader = req.headers.authorization;
    if (!validateAuth(authHeader, apiKeys)) {
      sendError(res, 401, 'Invalid or missing API key', requestId);
      return;
    }

    // Rate limit
    if (rateLimiter) {
      const clientId = RateLimiter.clientId(req);
      if (!rateLimiter.check(clientId)) {
        sendError(res, 429, 'Rate limit exceeded', requestId);
        return;
      }
    }

    // Block direct streaming transport routes — clients must use POST /v1/speech
    const path = url.split('?')[0];
    if (path === '/api/stream-audio' || path === '/ws/stream' || path === '/api/offer') {
      sendError(res, 410, `Streaming transport ${path} is removed. Use POST /v1/speech instead.`, requestId);
      return;
    }

    // Block WebSocket upgrades to streaming paths
    if (req.headers.upgrade?.toLowerCase() === 'websocket') {
      sendError(res, 410, 'WebSocket transport is removed. Use POST /v1/speech instead.', requestId);
      return;
    }

    // Custom routes (bypass body parsing — handler owns the request)
    if (config.customRoutes) {
      for (const route of config.customRoutes) {
        if (method === route.method.toUpperCase() && path === route.path) {
          try {
            await route.handler(req, res);
          } catch (err) {
            console.error(`[ai-gateway] Unhandled error in custom route ${route.method} ${route.path}:`, err);
            if (!res.headersSent) {
              sendError(res, 500, 'Internal server error', requestId);
            }
          }
          return;
        }
      }
    }

    // Static file serving — serve web UI assets before body parsing
    if (method === 'GET' && config.staticDir && !path.startsWith('/v1/') && path !== '/health' && path !== '/metrics') {
      if (serveStaticFile(config.staticDir, path, res, requestId)) return;
    }

    try {
      let rawBody = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
      let body: unknown = {};
      if (rawBody.length > 0) {
        const contentType = req.headers['content-type'] || '';
        if (!contentType) {
          sendError(res, 400, 'Content-Type header is required for POST requests', requestId);
          return;
        }
        if (contentType.includes('application/json')) {
          try { body = JSON.parse(rawBody.toString()); } catch {
            sendError(res, 400, 'Invalid JSON in request body', requestId);
            return;
          }
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
      } else if (method === 'GET' && config.staticDir && serveStaticFile(config.staticDir, path, res, requestId)) {
        return; // static file served
      } else {
        proxyRes = { status: 404, body: { error: { message: `Route not found: ${method} ${url}`, type: 'invalid_request_error' } } };
      }

      sendResponse(res, proxyRes, requestId);
    } catch (err) {
      if (err instanceof BodyTimeoutError) {
        sendError(res, 408, 'Request Timeout', requestId);
        return;
      }
      console.error(`[ai-gateway] Internal error (${requestId}):`, err);
      sendError(res, 500, 'Internal server error', requestId);
    }
  });

  return server;
}

/** Start the proxy server and return a promise that resolves when listening */
export function startProxy(config: ProxyConfig): Promise<Server> {
  const server = createProxyServer(config);
  const port = config.port || 4000;
  const hostname = config.hostname || '0.0.0.0';

  return new Promise((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use — another gateway instance may be running`));
      } else {
        reject(err);
      }
    });
    server.listen(port, hostname, () => {
      console.log(`[ai-gateway proxy] Listening on ${hostname}:${port}`);
      resolve(server);
    });
  });
}
