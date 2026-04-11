/**
 * OpenAI-Compatible Proxy Server — pure Node.js http.createServer.
 * No Express/Hono dependency.
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { request as httpsRequest } from 'https';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, extname, resolve } from 'path';
import { validateAuth } from './middleware/auth';
import { RateLimiter } from './middleware/rate-limit';
import { handleChatCompletions } from './routes/chat-completions';
import { handleEmbeddings } from './routes/embeddings';
import { handleAudioSpeech } from './routes/audio-speech';
import { handleAudioTranscriptions } from './routes/audio-transcriptions';
import { handleModels } from './routes/models';
import { handleImageGenerate, handleImageInpaint } from './routes/images';
import type { ProxyConfig, ProxyRequest, ProxyResponse } from './types';

/** Max request body size: 100MB (audio files can be large) */
const MAX_BODY_SIZE = 100 * 1024 * 1024;

const BODY_READ_TIMEOUT_MS = parseInt(process.env.PROXY_BODY_READ_TIMEOUT_MS || '30000', 10);

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
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)));
    req.on('error', reject);
  });
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      req.destroy();
      reject(new BodyTimeoutError(BODY_READ_TIMEOUT_MS));
    }, BODY_READ_TIMEOUT_MS);
  });
  return Promise.race([inner, timeoutPromise]).finally(() => clearTimeout(timeoutHandle));
}

/** Security headers applied to all responses */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

function sendResponse(res: ServerResponse, proxyRes: ProxyResponse, requestId: string): void {
  const existingCors = res.getHeader('Access-Control-Allow-Origin');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Request-Id': requestId,
    ...SECURITY_HEADERS,
    ...(existingCors !== undefined ? { 'Access-Control-Allow-Origin': String(existingCors) } : {}),
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
  const existingCors = res.getHeader('Access-Control-Allow-Origin');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...SECURITY_HEADERS,
    ...(requestId ? { 'X-Request-Id': requestId } : {}),
    ...(existingCors !== undefined ? { 'Access-Control-Allow-Origin': String(existingCors) } : {}),
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

/** Reverse-proxy a request to the Next.js dev server for HMR support. */
function proxyToNextDev(nextDevUrl: string, req: IncomingMessage, res: ServerResponse): void {
  const target = new URL(req.url || '/', nextDevUrl);
  const proxyReq = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
    target,
    { method: req.method, headers: { ...req.headers, host: target.host } },
    (proxyRes: IncomingMessage) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.on('error', () => { if (!res.writableEnded) res.end(); });
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Next.js dev server not running. Start it with: cd ai-gateway/web && bun run dev');
    } else if (!res.writableEnded) {
      res.end();
    }
  });
  req.on('error', () => { proxyReq.destroy(); });
  req.pipe(proxyReq);
}

function serveStaticFile(staticDir: string, urlPath: string, res: ServerResponse, requestId: string): boolean {
  // Prevent path traversal — resolve to absolute path and verify it stays within staticDir
  const resolvedStaticDir = resolve(staticDir);
  const decodedPath = decodeURIComponent(urlPath).replace(/\/+/g, '/');
  const resolvedPath = resolve(resolvedStaticDir, decodedPath.replace(/^\/+/, ''));
  if (!resolvedPath.startsWith(resolvedStaticDir)) {
    res.writeHead(403, { 'Content-Type': 'application/json', 'X-Request-Id': requestId, ...SECURITY_HEADERS });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return true;
  }
  const safePath = decodedPath;

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

  // Validate all candidates are within static dir
  const validCandidates = candidates.filter(c => resolve(c).startsWith(resolvedStaticDir));

  for (const filePath of validCandidates) {
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
    const corsOriginsEnv = process.env.CORS_ORIGINS || 'http://localhost:4000,http://localhost:3000';
    const requestOrigin = req.headers.origin || '';
    let allowedOrigin: string | null = '*';
    if (corsOriginsEnv !== '*') {
      const allowedOrigins = corsOriginsEnv.split(',').map(o => o.trim()).filter(Boolean);
      const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin);
      if (isLocal || allowedOrigins.includes(requestOrigin)) {
        allowedOrigin = requestOrigin;
      } else {
        // Non-matching origin: omit CORS header so browser blocks the request
        allowedOrigin = null;
      }
    }

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        ...(allowedOrigin !== null ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
        'X-Request-Id': requestId,
        ...SECURITY_HEADERS,
      });
      res.end();
      return;
    }

    // Set CORS origin header for all non-preflight responses
    if (allowedOrigin !== null) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    }

    // Skip auth for health endpoint (Fly.io health checks don't send tokens)
    const urlPath = url.split('?')[0];
    if (method === 'GET' && urlPath === '/health') {
      sendResponse(res, { status: 200, body: { status: 'ok' } }, requestId);
      return;
    }

    // Auth — when no API keys are configured, restrict to localhost-only requests
    const authHeader = req.headers.authorization;
    if (apiKeys.length === 0) {
      const remoteAddr = req.socket?.remoteAddress || '';
      const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
      if (!isLocal) {
        sendError(res, 401, 'No GATEWAY_API_KEY configured — remote access denied. Set GATEWAY_API_KEY or connect from localhost.', requestId);
        return;
      }
    } else if (!validateAuth(authHeader, apiKeys)) {
      sendError(res, 401, 'Invalid or missing API key', requestId);
      return;
    } else if (config.onAuth && authHeader) {
      // Authenticated — load per-user profile from DB (non-blocking, best-effort)
      const token = authHeader.replace(/^Bearer\s+/i, '');
      config.onAuth(token).catch(() => {});
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
    if (path === '/api/stream-audio' || path === '/ws/stream') {
      sendError(res, 410, `Streaming transport ${path} is removed. Use POST /v1/speech instead.`, requestId);
      return;
    }

    // Block WebSocket upgrades to streaming paths (except Next.js HMR in dev mode)
    if (req.headers.upgrade?.toLowerCase() === 'websocket') {
      if (config.nextDevUrl && path.startsWith('/_next/')) {
        proxyToNextDev(config.nextDevUrl, req, res);
        return;
      }
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

    // Dev mode: proxy to Next.js dev server (HMR support)
    if (config.nextDevUrl && !path.startsWith('/v1/') && path !== '/health' && path !== '/metrics') {
      proxyToNextDev(config.nextDevUrl, req, res);
      return;
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
            // Validate boundary to prevent injection attacks (RFC 2046: up to 70 chars, alphanumeric + some symbols)
            if (!/^[\w\-'()+,./:=? ]{1,70}$/.test(boundary)) {
              sendError(res, 400, 'Invalid multipart boundary', requestId);
              return;
            }
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
          proxyRes = await handleChatCompletions(proxyReq, config.providers.chat, config.cache, config.hooks, config.providers.chatFallbackChain);
        }
      } else if (method === 'POST' && url === '/v1/embeddings') {
        if (!config.providers.embedding) {
          proxyRes = { status: 404, body: { error: { message: 'No embedding providers configured', type: 'invalid_request_error' } } };
        } else {
          proxyRes = await handleEmbeddings(proxyReq, config.providers.embedding, config.cache);
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
      } else if (method === 'POST' && url === '/v1/images/generate') {
        proxyRes = await handleImageGenerate(proxyReq, config.providers.image);
      } else if (method === 'POST' && url === '/v1/images/inpaint') {
        proxyRes = await handleImageInpaint(proxyReq, config.providers.image);
      // /health is handled before auth (line 345) — no need to match here
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

  // Handle all WebSocket upgrade requests — proxy HMR to Next.js dev server, block everything else with 410
  server.on('upgrade', (req: IncomingMessage, socket: import('net').Socket, head: Buffer) => {
    const path = req.url || '/';
    if (config.nextDevUrl && path.startsWith('/_next/')) {
      const nextUrl = config.nextDevUrl;
      const target = new URL(path, nextUrl);
      const proxyReq = httpRequest(target, {
        method: 'GET',
        headers: { ...req.headers, host: target.host },
      });
      proxyReq.on('upgrade', (_: unknown, proxySocket: import('net').Socket, proxyHead: Buffer) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
          Object.entries((_ as any).headers || {}).map(([k, v]: [string, any]) => `${k}: ${v}`).join('\r\n') +
          '\r\n\r\n');
        if (proxyHead.length) socket.write(proxyHead);
        proxySocket.on('error', () => socket.destroy());
        socket.on('error', () => proxySocket.destroy());
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
      });
      proxyReq.on('error', () => socket.destroy());
      proxyReq.end();
      return;
    }
    // All other WebSocket upgrades: return 410 Gone
    const body = JSON.stringify({ error: { message: 'WebSocket transport is removed. Use POST /v1/speech instead.', type: 'gone' } });
    socket.write(
      `HTTP/1.1 410 Gone\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    socket.end();
  });

  return server;
}

/** Start the proxy server and return a promise that resolves when listening */
export function startProxy(config: ProxyConfig): Promise<Server> {
  const server = createProxyServer(config);
  const port = config.port || 4000;
  const hostname = config.hostname || process.env.GATEWAY_HOST || '127.0.0.1';

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
