/**
 * OpenAI-Compatible Proxy Server — pure Node.js http.createServer.
 * No Express/Hono dependency.
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { request as httpsRequest } from 'https';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, extname, resolve, sep } from 'path';
import { validateAuth } from './middleware/auth';
import { RateLimiter } from './middleware/rate-limit';
import { SECURITY_HEADERS, applySecurityHeaders } from '../../middleware/security-headers';
import { handleChatCompletions } from './routes/chat-completions';
import { inferenceKindOf } from './app-limits';
import { handleEmbeddings } from './routes/embeddings';
import { handleAudioSpeech } from './routes/audio-speech';
import { sttFilterStats } from './routes/stt-filter';
import { markNoWake, NO_WAKE_HEADER, noWakeStats, requestIsNoWake, withNoWakeScope } from './no-wake';
import { handleAudioTranscriptions } from './routes/audio-transcriptions';
import { handleModelsWithDynamic } from './routes/models';
import { handleImageGenerate, handleImageInpaint } from './routes/images';
import { createLogger, withLogContext } from '../../logger';
import { ApiKeyRegistry } from './middleware/api-keys';
import type { ProxyConfig, PrefixRoute, ProxyRequest, ProxyResponse } from './types';
import { isInternalSubrequest, SUBREQUEST_HEADER } from './internal-subrequest';
import {
  CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS, CORS_EXPOSE_HEADERS, errorTypeForStatus, requestIdOf,
} from './http-conventions';
import { minimalHealth, wantsDeepHealth, wantsHealthDetails } from './health-view';
import { traceOfRequest } from '../../telemetry/trace-context';
import { TRACE_ID_RESPONSE_HEADER } from '../../telemetry/contract';

const log = createLogger('proxy');

/** Max request body size: 100MB (audio files can be large) */
const MAX_BODY_SIZE = 100 * 1024 * 1024;

const BODY_READ_TIMEOUT_MS = parseInt(process.env.PROXY_BODY_READ_TIMEOUT_MS || '30000', 10);

class BodyTimeoutError extends Error {
  constructor(ms: number) {
    super(`Body read timed out after ${ms}ms`);
    this.name = 'BodyTimeoutError';
  }
}

/** A multipart body the parser refuses (truncated, oversized name, oversized file): the client's fault, not a 500. */
class MultipartError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'MultipartError';
  }
}

/** Body larger than the limit with no (or a lying) Content-Length, e.g. a chunked upload. Answered 413. */
class BodyTooLargeError extends Error {
  constructor(maxSize: number) {
    super(`Payload too large: body exceeds ${Math.round(maxSize / 1024 / 1024)}MB limit`);
    this.name = 'BodyTooLargeError';
  }
}

/** How long a refused upload may keep sending after the 413 before the socket is torn down. */
const LINGER_MS = 5_000;

/**
 * Close after answering a request whose body is still arriving, the way nginx does (lingering close). Destroying the
 * socket with unread upload in the receive buffer makes the kernel send an RST, which can wipe the 413 from the client's
 * buffer before it is read (ECONNRESET/EPIPE, flaky fault bench item 21). `Connection: close` is not enough: Node's
 * server then calls `destroySoon()` itself as soon as the response is flushed. So the response goes out keep-alive, the
 * rest of the body is drained, and the socket is ended once the upload stops; a timer caps the drain so a client that
 * never stops cannot hold the socket.
 */
function lingeringClose(req: IncomingMessage): void {
  const socket = req.socket;
  const timer = setTimeout(() => socket.destroy(), LINGER_MS);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
  req.once('end', () => socket.end());
  req.resume();
}

function readBody(req: IncomingMessage, maxSize = MAX_BODY_SIZE): Promise<Buffer> {
  const inner = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const onData = (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        // Stop keeping it, but do not destroy the socket yet: the client must still read the 413 (destroying here
        // reset the connection mid-upload, fault bench 2026-10-06 item 21). The caller closes it once answered.
        chunks.length = 0;
        req.off('data', onData);
        req.resume();
        reject(new BodyTooLargeError(maxSize));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
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

function sendResponse(res: ServerResponse, proxyRes: ProxyResponse, requestId: string): void {
  const existingCors = res.getHeader('Access-Control-Allow-Origin');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Request-Id': requestId,
    ...SECURITY_HEADERS,
    ...(existingCors !== undefined ? { 'Access-Control-Allow-Origin': String(existingCors) } : {}),
    ...proxyRes.headers,
  };

  // SSE streaming response — pipe ReadableStream to HTTP response.
  // Critical production concern (from LiteLLM postmortem + node-http-proxy
  // issue #1586): if the client disconnects mid-stream, the reader must
  // be cancelled to release the upstream connection. Without this, the
  // provider's response stream buffers indefinitely → memory leak.
  if (proxyRes.stream) {
    res.writeHead(proxyRes.status, headers);
    const reader = proxyRes.stream.getReader();
    let clientGone = false;
    // Detect client disconnect — fires on TCP reset, browser tab close, etc.
    res.on('close', () => {
      if (!clientGone) {
        clientGone = true;
        reader.cancel().catch(() => { /* already closed */ });
      }
    });
    (async () => {
      try {
        for (;;) {
          if (clientGone) break;
          const { done, value } = await reader.read();
          if (done) break;
          // Respect backpressure — but race 'drain' against 'close'/'error'.
          // If the client disconnects while the socket buffer is full, 'drain'
          // never fires on the destroyed socket, so awaiting it alone would hang
          // this loop forever and leak the reader + closure. Wake on either and
          // re-check clientGone.
          if (!res.write(value)) {
            await new Promise<void>((resolve) => {
              const cleanup = () => {
                res.off('drain', onWake);
                res.off('close', onWake);
                res.off('error', onWake);
              };
              const onWake = () => { cleanup(); resolve(); };
              res.once('drain', onWake);
              res.once('close', onWake);
              res.once('error', onWake);
            });
            if (clientGone) break;
          }
        }
      } catch {
        // Client disconnected mid-stream — not an error
      } finally {
        if (!clientGone) res.end();
      }
    })();
    return;
  }

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
  res.end(JSON.stringify({ error: { message, type: errorTypeForStatus(status) } }));
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
    throw new MultipartError('Malformed multipart body: missing closing boundary (truncated upload?)');
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

    // Bounds check for field names (prevent DoS via memory exhaustion)
    if (nameMatch && nameMatch[1].length > MAX_FIELD_NAME_LENGTH) {
      throw new MultipartError(`Field name too long (max ${MAX_FIELD_NAME_LENGTH} chars)`);
    }
    // Bounds check for filenames (prevent path traversal via oversized names)
    if (filenameMatch && filenameMatch[1].length > MAX_FILENAME_LENGTH) {
      throw new MultipartError(`Filename too long (max ${MAX_FILENAME_LENGTH} chars)`);
    }

    // Enforce max upload file size
    if (filenameMatch && partData.length > MAX_UPLOAD_SIZE_BYTES) {
      throw new MultipartError(
        `File "${filenameMatch[1]}" exceeds max upload size of ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB`, 413,
      );
    }

    // Warn on large uploads
    if (filenameMatch && partData.length > UPLOAD_WARN_THRESHOLD) {
      log.warn({ filename: filenameMatch[1], sizeMb: +(partData.length / (1024 * 1024)).toFixed(1) },
        'Large multipart upload');
    }

    // Enforce size limit on non-file text fields
    if (!filenameMatch && partData.length > MAX_FIELD_SIZE) {
      log.warn({ field: nameMatch?.[1], limitBytes: MAX_FIELD_SIZE },
        'Multipart text field exceeded limit, skipping');
      start = nextBoundary;
      continue;
    }

    // Enforce total upload size across all parts
    totalBytes += partData.length;
    if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
      throw new BodyTooLargeError(MAX_TOTAL_UPLOAD_BYTES);
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

/** Validate boundary per RFC 2046 (1-70 chars, alphanumeric + special chars). */
const MULTIPART_BOUNDARY_RE = /^[\w\-'()+,./:=? ]{1,70}$/;

/** Max length for a single field name in multipart (prevent memory exhaustion). */
const MAX_FIELD_NAME_LENGTH = 256;
/** Max length for a single filename in multipart (prevent path traversal). */
const MAX_FILENAME_LENGTH = 256;

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
      applySecurityHeaders(res);
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.on('error', () => { if (!res.writableEnded) res.end(); });
      proxyRes.pipe(res);
      // Clean up upstream if client disconnects mid-stream
      res.on('close', () => { proxyRes.destroy(); proxyReq.destroy(); });
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
  // `startsWith(staticDir)` alone admits sibling dirs that share a prefix
  // (e.g. /var/www → /var/wwwx/secret). Require an exact match OR a path
  // separator immediately after, which is what `relative()` semantics enforce.
  const isInsideStatic =
    resolvedPath === resolvedStaticDir ||
    resolvedPath.startsWith(resolvedStaticDir + sep);
  if (!isInsideStatic) {
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

  // Validate all candidates are within static dir — same prefix-trap fix as
  // above: accept exact match or `${dir}${sep}…`, never a sibling prefix.
  const validCandidates = candidates.filter(c => {
    const r = resolve(c);
    return r === resolvedStaticDir || r.startsWith(resolvedStaticDir + sep);
  });

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
    // Log error for debugging — silent catch hides socket issues
    } catch (err) {
      log.warn({ err, requestId, filePath }, 'Static file serve error');
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

/** Active connection counter. Exposed via /health so operators can detect
 *  connection leaks without attaching a debugger. A steadily rising count
 *  under constant load is the first signal of a stream not being cleaned up. */
let activeConnections = 0;
let peakConnections = 0;

/** Per-user concurrency limiter -- prevents a single user from monopolizing connections. */
const userConcurrency = new Map<string, number>();
const RESERVED_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
/**
 * Requests in flight per API key user. One key usually serves a whole application (parle: every student of a school
 * on the same key), so the old default of 20 turned a class of 25 speaking at once into 429s (prod stress 2026-10-06:
 * 21/50 served at 50 concurrent, the rest "Too many concurrent requests (limit: 20)"). The limit guards the gateway
 * against one runaway caller, not against an app's normal load; upstream capacity is governed by the providers.
 */
export const DEFAULT_MAX_CONCURRENT_PER_USER = 150;

/**
 * Per-user limits: `MAX_CONCURRENT_PER_USER` (default for every user) and `MAX_CONCURRENT_PER_USER_OVERRIDES`
 * (`user:limit,user:limit`, the user names of `API_KEYS="key:user"`). Bad entries are ignored.
 */
export function concurrencyLimits(env: Record<string, string | undefined> = process.env): { fallback: number; perUser: Map<string, number> } {
  const n = parseInt(env.MAX_CONCURRENT_PER_USER ?? '', 10);
  const fallback = Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENT_PER_USER;
  const perUser = new Map<string, number>();
  for (const item of (env.MAX_CONCURRENT_PER_USER_OVERRIDES ?? '').split(',')) {
    const at = item.lastIndexOf(':');
    if (at <= 0) continue;
    const limit = parseInt(item.slice(at + 1), 10);
    if (Number.isFinite(limit) && limit > 0) perUser.set(item.slice(0, at).trim(), limit);
  }
  return { fallback, perUser };
}

/** Runs the matching `publicRoutes` entry (it authenticates itself); false when none matches. */
async function runPublicRoute(
  config: ProxyConfig, req: IncomingMessage, res: ServerResponse, method: string, path: string, requestId: string,
): Promise<boolean> {
  const route = config.publicRoutes?.find(r => method === r.method.toUpperCase() && path === r.path);
  if (!route) return false;
  try {
    await route.handler(req, res);
  } catch (err) {
    log.error({ err, route: `${route.method} ${route.path}` }, 'Unhandled error in public route');
    if (!res.headersSent) sendError(res, 500, 'Internal server error', requestId);
  }
  return true;
}

export function createProxyServer(config: ProxyConfig): Server {
  const apiKeys = config.apiKeys || [];
  // Build the API key registry for user identity resolution.
  // Supports both legacy format ("key1,key2") and new format ("key1:user1,key2:user2").
  const keyRegistry = new ApiKeyRegistry(apiKeys.join(','));
  const rateLimiter = config.rateLimit ? new RateLimiter(config.rateLimit.rpm) : null;
  const concurrency = concurrencyLimits();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method?.toUpperCase() || 'GET';
    const url = req.url || '/';
    // Only a short [\w.-] id is echoed (headers, logs, error bodies); anything else is replaced by a fresh one, and the
    // request carries the effective id from here on (route handlers read it from the headers).
    const requestId = requestIdOf(req.headers['x-request-id']);
    req.headers['x-request-id'] = requestId;
    // W3C trace context (src/telemetry/trace-context.ts): the caller's traceparent, else a new trace. Echoed back and
    // propagated to replicas, so browser, gateway and edge events of one session share the trace id.
    const trace = traceOfRequest(req.headers, url);
    res.setHeader(TRACE_ID_RESPONSE_HEADER, trace.traceId);

    // Establish an AsyncLocalStorage frame so every log emitted during this
    // request (here AND inside any downstream async module) carries the same
    // requestId field. Correlation becomes automatic rather than manual
    // argument threading.
    // Plus a no-wake scope (no-wake.ts), switched on after auth when the request or its key user asks for it.
    void withNoWakeScope(() => withLogContext({ requestId, traceId: trace.traceId, spanId: trace.spanId },
      () => handleRequest(req, res, method, url, requestId)));
  });

  // The actual request handler runs inside the ALS frame established above.
  // Keeping it a named function rather than inlining keeps the stack trace
  // readable when errors are raised from deep inside a route handler.
  const handleRequest = async (req: IncomingMessage, res: ServerResponse, method: string, url: string, requestId: string): Promise<void> => {
    const reqStartMs = Date.now();

    // Track active connections for leak detection
    activeConnections++;
    if (activeConnections > peakConnections) peakConnections = activeConnections;
    res.on('close', () => { activeConnections--; });

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
        'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
        'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
        'X-Request-Id': requestId,
        ...SECURITY_HEADERS,
      });
      res.end();
      return;
    }

    // Set CORS origin header for all non-preflight responses
    if (allowedOrigin !== null) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
    }
    // Every answer carries the request id, including the routes that write their own response (s2s, deployments, apps).
    res.setHeader('X-Request-Id', requestId);

    // Only the minimal health check skips auth (the platform probe, the reaper and the SDK breaker send no token and
    // read the status alone). `?details=1` (stage chains) and `?deep=1` (upstream probes) need a key (health-view.ts).
    const urlPath = url.split('?')[0];
    const deepHealth = method === 'GET' && urlPath === '/health' && wantsDeepHealth(url);
    const detailedHealth = method === 'GET' && urlPath === '/health' && !deepHealth && wantsHealthDetails(url);
    if (method === 'GET' && urlPath === '/health' && !deepHealth && !detailedHealth) {
      sendResponse(res, { status: 200, body: minimalHealth() }, requestId);
      return;
    }

    // Self-authenticated routes (telemetry ingest: session tokens, replica signatures) run before the key check.
    if (await runPublicRoute(config, req, res, method, urlPath, requestId)) return;

    // Auth — resolve user identity from Bearer token.
    // When no keys are configured, restrict to localhost. When keys are
    // configured, validate and resolve the userId for logging + rate limiting.
    const authHeader = req.headers.authorization;
    let userId = 'anonymous';
    if (keyRegistry.size === 0) {
      const remoteAddr = req.socket?.remoteAddress || '';
      const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
      if (!isLocal) {
        sendError(res, 401, 'No GATEWAY_API_KEY configured — remote access denied. Set GATEWAY_API_KEY or connect from localhost.', requestId);
        return;
      }
      userId = 'localhost';
    } else {
      const token = (authHeader || '').replace(/^Bearer\s+/i, '');
      const resolved = keyRegistry.resolve(token);
      if (!resolved) {
        sendError(res, 401, 'Invalid or missing API key', requestId);
        return;
      }
      userId = resolved.userId;
    }
    // No-wake mode (no-wake.ts): deployment targets with no ready replica are skipped, never woken.
    if (requestIsNoWake(req.headers[NO_WAKE_HEADER], userId)) markNoWake();
    if (config.onAuth && authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, '');
      config.onAuth(token).catch((err) => {
        log.error('Auth callback failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }

    // Open mode (no keys, localhost only) is the operator's own machine: it sees everything. Otherwise the admin
    // decision is the authorizer's alone, on the key that passed auth above (an absent one is never admin).
    const bearer = (authHeader ?? '').replace(/^Bearer\s+/i, '');
    const callerIsAdmin = keyRegistry.size === 0 ? true : config.deepHealth?.authorize(bearer) === true;
    if (detailedHealth) {
      let details: Record<string, unknown> = {};
      try { details = config.healthDetails?.({ userId, admin: callerIsAdmin }) ?? {}; } catch (err) {
        log.error('health details failed', { error: err instanceof Error ? err.message : String(err) });
      }
      sendResponse(res, { status: 200, body: {
        ...minimalHealth(),
        // Gateway-wide counters: the operator's, not an app's.
        ...(callerIsAdmin ? { connections: { active: activeConnections, peak: peakConnections }, sttFilter: sttFilterStats(), noWake: noWakeStats() } : {}),
        ...details,
      } }, requestId);
      return;
    }
    if (deepHealth) {
      if (!config.deepHealth) { sendError(res, 404, 'Deep health is not enabled on this gateway', requestId); return; }
      // The key is valid (auth above): a non-admin one is forbidden, not unauthenticated.
      if (!callerIsAdmin) { sendError(res, 403, 'Deep health needs an admin API key', requestId); return; }
      try {
        const report = await config.deepHealth.report();
        sendResponse(res, { status: report.status, body: report.body }, requestId);
      } catch (err) {
        log.error({ err }, 'deep health failed');
        sendError(res, 500, 'Deep health check failed', requestId);
      }
      return;
    }

    // Per-user concurrent request limit (a gateway sub-request of a turn already counted is not counted again)
    if (userId !== 'anonymous' && !isInternalSubrequest(req.headers[SUBREQUEST_HEADER], req.socket?.remoteAddress)) {
      const currentConcurrent = userConcurrency.get(userId) || 0;
      const userLimit = concurrency.perUser.get(userId) ?? concurrency.fallback;
      if (currentConcurrent >= userLimit) {
        res.setHeader('Retry-After', 1);
        sendError(res, 429, `Too many concurrent requests (limit: ${userLimit})`, requestId);
        return;
      }
      userConcurrency.set(userId, currentConcurrent + 1);
      // Use 'close' (fires on both finish and abort) — 'finish' alone leaks the
      // counter on client disconnect / TCP reset, locking out the user after
      // ~MAX_CONCURRENT_PER_USER aborts. Idempotency guard prevents double-dec
      // on environments that fire both events.
      let decremented = false;
      const onComplete = () => {
        if (decremented) return;
        decremented = true;
        const c = userConcurrency.get(userId) || 1;
        if (c <= 1) userConcurrency.delete(userId);
        else userConcurrency.set(userId, c - 1);
      };
      res.on('close', onComplete);
      res.on('finish', onComplete);
    }

    // Rate limit — keyed by userId (resolved from API key above) so each
    // user gets their own token bucket. Falls back to IP for unauthenticated.
    if (rateLimiter) {
      const clientId = userId !== 'anonymous' ? `user:${userId}` : RateLimiter.clientId(req);
      const rl = rateLimiter.check(clientId);
      if (rl.limit > 0) {
        res.setHeader('X-RateLimit-Limit', rl.limit);
        res.setHeader('X-RateLimit-Remaining', rl.remaining);
        res.setHeader('X-RateLimit-Reset', rl.resetAt);
      }
      if (!rl.allowed) {
        res.setHeader('Retry-After', Math.max(1, rl.resetAt - Math.ceil(Date.now() / 1000)));
        sendError(res, 429, 'Rate limit exceeded', requestId);
        return;
      }
    }

    // Block the removed streaming transport routes (410)
    const path = url.split('?')[0];

    // Request-level logging: entry + auto-wired exit on res.end(). /health
    // is excluded to avoid flooding logs on Fly.io's 10s health probe.
    // userId is included so every log line for this request is attributable.
    if (path !== '/health') {
      log.log({ method, path, userId }, 'request received');
      const origEnd = res.end.bind(res);
      (res as { end: typeof res.end }).end = function (...args: Parameters<typeof res.end>) {
        const durationMs = Date.now() - reqStartMs;
        const upstreamMs = parseInt(res.getHeader('x-upstream-duration-ms') as string, 10) || undefined;
        const proxyMs = upstreamMs ? durationMs - upstreamMs : undefined;
        log.log({ method, path, userId, statusCode: res.statusCode, durationMs, upstreamMs, proxyMs }, 'request complete');
        return origEnd(...args);
      } as typeof res.end;
    }

    if (path === '/api/stream-audio' || path === '/ws/stream') {
      sendError(res, 410, `Streaming transport ${path} is removed. Use POST /v1/s2s (speech-to-speech) or POST /v1/chat/completions instead.`, requestId);
      return;
    }

    // Block WebSocket upgrades to streaming paths (except Next.js HMR in dev mode)
    if (req.headers.upgrade?.toLowerCase() === 'websocket') {
      if (config.nextDevUrl && path.startsWith('/_next/')) {
        proxyToNextDev(config.nextDevUrl, req, res);
        return;
      }
      sendError(res, 410, 'WebSocket transport is removed. Use POST /v1/s2s (speech-to-speech) or POST /v1/chat/completions instead.', requestId);
      return;
    }

    // Custom routes (bypass body parsing — handler owns the request)
    if (config.customRoutes) {
      for (const route of config.customRoutes) {
        if (method === route.method.toUpperCase() && path === route.path) {
          try {
            await route.handler(req, res);
          } catch (err) {
            log.error({ err, route: `${route.method} ${route.path}` },
              'Unhandled error in custom route');
            if (!res.headersSent) {
              sendError(res, 500, 'Internal server error', requestId);
            }
          }
          return;
        }
      }
    }

    // Prefix routes (pattern-matched, handler owns routing + response)
    if (config.prefixRoutes) {
      for (const route of config.prefixRoutes) {
        if (path.startsWith(route.prefix)) {
          try {
            const handled = route.handler(req, res, path, method);
            if (handled) return;
          } catch (err) {
            log.error({ err, prefix: route.prefix }, 'Unhandled error in prefix route');
            if (!res.headersSent) {
              sendError(res, 500, 'Internal server error', requestId);
            }
            return;
          }
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

    // Early Content-Length check: reject obviously oversized requests BEFORE
    // reading the body. Without this, Fly.io resets the connection (HTTP 000)
    // and the client gets no useful error. With this, the client gets a clean
    // 413 Payload Too Large with a message explaining the limit.
    // Found during production readiness testing (2026-04-12): oversized body
    // returned connection reset instead of a structured error.
    const declaredLength = parseInt(req.headers['content-length'] || '0', 10);
    if (declaredLength > MAX_BODY_SIZE) {
      sendError(res, 413, `Payload too large: ${Math.round(declaredLength / 1024 / 1024)}MB exceeds ${Math.round(MAX_BODY_SIZE / 1024 / 1024)}MB limit`, requestId);
      req.destroy();
      return;
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
            if (!MULTIPART_BOUNDARY_RE.test(boundary)) {
              sendError(res, 400, 'Invalid multipart boundary', requestId);
              return;
            }
            const parts = parseMultipart(rawBody, boundary);
            // Field names come from the client: a map without prototype, and no reserved names (CodeQL
            // js/remote-property-injection; `__proto__` would otherwise rewrite the object's prototype).
            const named = new Map<string, string>();
            let hasFile = false;
            for (const part of parts) {
              if (part.filename) {
                // File part — use its content as rawBody for the route handler
                rawBody = part.data;
                hasFile = true;
              } else if (part.name && !RESERVED_FIELD_NAMES.has(part.name)) {
                named.set(part.name, part.data.toString());
              }
            }
            const fields: Record<string, string> = Object.assign(Object.create(null), Object.fromEntries(named));
            // If no file part found, clear rawBody so downstream handlers
            // see length=0 and return 400 "audio data is required" instead
            // of trying to transcribe multipart boundary markers → 500.
            if (!hasFile) rawBody = Buffer.alloc(0);
            body = fields;
          }
        }
      }

      // The client leaving (tab closed, timeout, RST) aborts the upstream calls of this request: without it a
      // non-streamed chat / STT / TTS kept running (and billing) to the end (fault bench 2026-10-06, item 18).
      const clientGone = new AbortController();
      res.on('close', () => { if (!res.writableFinished) clientGone.abort(); });
      const proxyReq: ProxyRequest = {
        method,
        url,
        headers: req.headers as Record<string, string>,
        body,
        rawBody,
        signal: clientGone.signal,
      };

      let proxyRes: ProxyResponse;

      // Per-app limits (allowed models, max_tokens cap, daily budget) before any provider is called.
      // An s2s turn's own stages (loopback, internal sub-request) were charged once when the turn was admitted
      // (src/s2s/access.ts): their aliases are still checked, the daily budget is not charged twice.
      const kind = config.appLimits ? inferenceKindOf(method, path) : null;
      if (kind && config.appLimits) {
        const fields = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
        const charge = !isInternalSubrequest(req.headers[SUBREQUEST_HEADER], req.socket?.remoteAddress);
        const denial = config.appLimits.check(userId, kind, fields, { charge });
        if (denial) {
          if (denial.retryAfterSeconds) res.setHeader('Retry-After', denial.retryAfterSeconds);
          sendResponse(res, { status: denial.status, body: { error: { message: denial.message, type: denial.type } } }, requestId);
          return;
        }
      }

      // Route matching — on the path: a query string (`/v1/models?x=1`) must not turn a route into a 404.
      if (method === 'GET' && path === '/v1/models') {
        proxyRes = await handleModelsWithDynamic(config.providers);
      } else if (method === 'POST' && path === '/v1/chat/completions') {
        const { chat, chatRoutes, chatDynamicRoutes, unavailable } = config.providers;
        if (!chat && !chatRoutes && !chatDynamicRoutes && !unavailable?.chat) {
          proxyRes = { status: 404, body: { error: { message: 'No chat providers configured', type: 'invalid_request_error' } } };
        } else {
          proxyRes = await handleChatCompletions(
            proxyReq,
            chat ?? {},
            config.cache,
            config.hooks,
            config.providers.chatFallbackChain,
            config.guardrails,
            chatDynamicRoutes,
            { chatRoutes, unavailable: unavailable?.chat },
          );
        }
      } else if (method === 'POST' && path === '/v1/embeddings') {
        if (!config.providers.embedding) {
          proxyRes = { status: 404, body: { error: { message: 'No embedding providers configured', type: 'invalid_request_error' } } };
        } else {
          proxyRes = await handleEmbeddings(proxyReq, config.providers.embedding, config.cache);
        }
      } else if (method === 'POST' && path === '/v1/audio/speech') {
        if (!config.providers.tts && !config.providers.unavailable?.tts) {
          proxyRes = { status: 404, body: { error: { message: 'No TTS providers configured', type: 'invalid_request_error' } } };
        } else {
          proxyRes = await handleAudioSpeech(proxyReq, config.providers.tts ?? {}, config.providers.unavailable?.tts);
        }
      } else if (method === 'POST' && path === '/v1/audio/transcriptions') {
        if (!config.providers.stt && !config.providers.unavailable?.stt) {
          proxyRes = { status: 404, body: { error: { message: 'No STT providers configured', type: 'invalid_request_error' } } };
        } else {
          proxyRes = await handleAudioTranscriptions(proxyReq, config.providers.stt ?? {}, config.providers.unavailable?.stt);
        }
      } else if (method === 'POST' && path === '/v1/images/generate') {
        proxyRes = await handleImageGenerate(proxyReq, config.providers.image);
      } else if (method === 'POST' && path === '/v1/images/inpaint') {
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
      if (err instanceof BodyTooLargeError) {
        lingeringClose(req);
        sendError(res, 413, err.message, requestId);
        return;
      }
      if (err instanceof MultipartError) {
        sendError(res, err.status, err.message, requestId);
        return;
      }
      log.error({ err, requestId }, 'Internal error in proxy handler');
      sendError(res, 500, 'Internal server error', requestId);
    }
  };

  // Total request timeout — safety net that kills requests stuck longer than
  // 60s (e.g. a hung upstream + missing per-route timeout). Without this, a
  // single stuck request holds its connection slot forever, and under load
  // this leads to file descriptor exhaustion. 60s is 15× our chat SLO and
  // 2× the stream timeout — anything still alive after that is genuinely stuck.
  const TOTAL_REQUEST_TIMEOUT_MS = parseInt(process.env.PROXY_TOTAL_TIMEOUT_MS || '60000', 10);
  server.setTimeout(TOTAL_REQUEST_TIMEOUT_MS, (socket) => {
    log.warn({ timeoutMs: TOTAL_REQUEST_TIMEOUT_MS }, 'Request killed by total timeout');
    socket.destroy();
  });

  // Slowloris protection: limit time to receive headers and full request
  server.headersTimeout = 10_000;   // 10s — blocks slowloris
  server.requestTimeout = 30_000;   // 30s — total request limit

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
        const reqHeaders = (proxyReq as unknown as { headers?: Record<string, string> }).headers || {};
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
          Object.entries(reqHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
          '\r\n\r\n');
        if (proxyHead.length) socket.write(proxyHead);
        proxySocket.on('error', () => socket.destroy());
        socket.on('error', () => proxySocket.destroy());
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
        // Clean up both sides if either disconnects mid-stream
        socket.on('close', () => { proxySocket.destroy(); });
        proxySocket.on('close', () => { socket.destroy(); });
      });
      proxyReq.on('error', () => socket.destroy());
      proxyReq.end();
      return;
    }
    // All other WebSocket upgrades: return 410 Gone
    const body = JSON.stringify({ error: { message: 'WebSocket transport is removed. Use POST /v1/s2s (speech-to-speech) or POST /v1/chat/completions instead.', type: 'gone' } });
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
      log.log({ host: hostname, port }, 'Proxy listening');
      resolve(server);
    });
  });
}
