// ── BabelCast Gateway — HTTP Utilities ──────────────────────────────────────
// readRawBody, readJsonBody, validateLang, handleBodyError, maskKey,
// getOrCreateRequestId, setRequestIdHeader, validateCredential, validateGpuCredentials,
// error classes.

import type { IncomingMessage, ServerResponse } from 'http';
import { gunzipSync } from 'zlib';

export class JsonParseError extends Error {
  constructor(cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Invalid JSON body: ${detail}`);
    this.name = 'JsonParseError';
  }
}

export class BodyTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'BodyTimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new BodyTimeoutError(label, ms)), ms),
    ),
  ]);
}

const JSON_BODY_TIMEOUT_MS = 15_000;
const RAW_BODY_TIMEOUT_MS = 30_000;

export function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const inner = new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw.trim()) { resolve({}); return; }  // empty body is OK (optional JSON)
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new JsonParseError(e)); }
    });
    req.on('error', reject);
  });
  return withTimeout(inner, JSON_BODY_TIMEOUT_MS, 'readJsonBody');
}

const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB

export function readRawBody(req: IncomingMessage, res?: ServerResponse): Promise<Buffer> | null {
  const contentLength = req.headers['content-length'];
  if (contentLength) {
    const cl = parseInt(contentLength, 10);
    if (!isNaN(cl) && cl > MAX_BODY_BYTES) {
      if (res) {
        sendJsonError(res, 413, 'Payload Too Large', 'PAYLOAD_TOO_LARGE');
      }
      return null;
    }
  }
  const isGzip = req.headers['content-encoding'] === 'gzip';
  const inner = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body too large (>${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      // Transparent gzip decompression for compressed audio payloads
      if (isGzip && body.length > 0) {
        try {
          body = gunzipSync(body);
        } catch {
          reject(new Error('Failed to decompress gzip body'));
          return;
        }
      }
      resolve(body);
    });
    req.on('error', reject);
  });
  return withTimeout(inner, RAW_BODY_TIMEOUT_MS, 'readRawBody');
}

export const langNames: Record<string, string> = {
  fr: 'French', en: 'English', es: 'Spanish', pt: 'Portuguese',
  de: 'German', it: 'Italian', ja: 'Japanese', zh: 'Chinese',
};
export const VALID_LANGS = new Set(Object.keys(langNames));

export function validateLang(code: string, fallback: string): string {
  return VALID_LANGS.has(code) ? code : fallback;
}

export function handleBodyError(res: ServerResponse, err?: unknown): void {
  if (err instanceof BodyTimeoutError) {
    sendJsonError(res, 408, 'Request Timeout', 'REQUEST_TIMEOUT');
    return;
  }
  const message = err instanceof JsonParseError ? err.message : 'Invalid JSON body';
  sendJsonError(res, 400, message, 'BAD_REQUEST');
}

// ── GPU credential validation ───────────────────────────────────────────────

export function validateCredential(
  key: string,
  name: string,
  opts?: { prefix?: string; pattern?: RegExp; minLen?: number; maxLen?: number },
): string | null {
  if (!key) return null; // empty/missing is fine — means not provided
  const maxLen = opts?.maxLen ?? 200;
  const minLen = opts?.minLen ?? 10;
  if (key.length > maxLen) return `${name} is too long (max ${maxLen} chars)`;
  if (key.length < minLen) return `${name} is too short (min ${minLen} chars)`;
  if (opts?.prefix && !key.startsWith(opts.prefix)) return `${name} must start with '${opts.prefix}', got '${key.slice(0, 6)}...'`;
  if (opts?.pattern && !opts.pattern.test(key)) return `${name} has invalid format`;
  return null;
}

export function validateGpuCredentials(creds: {
  runpodApiKey?: string;
  vastApiKey?: string;
  tensordockApiKey?: string;
  tensordockAuthId?: string;
  modalTokenId?: string;
  modalTokenSecret?: string;
}): string | null {
  return (
    validateCredential(creds.runpodApiKey || '', 'RunPod API key', { prefix: 'rpa_', minLen: 20, maxLen: 100 }) ||
    validateCredential(creds.vastApiKey || '', 'Vast.ai API key', { pattern: /^[0-9a-fA-F]+$/, minLen: 20, maxLen: 100 }) ||
    validateCredential(creds.tensordockApiKey || '', 'TensorDock API key', { pattern: /^[a-zA-Z0-9]+$/, minLen: 10, maxLen: 100 }) ||
    validateCredential(creds.tensordockAuthId || '', 'TensorDock Auth ID', { pattern: /^[a-zA-Z0-9-]+$/, minLen: 5, maxLen: 100 }) ||
    validateCredential(creds.modalTokenId || '', 'Modal Token ID', { minLen: 5, maxLen: 100 }) ||
    validateCredential(creds.modalTokenSecret || '', 'Modal Token Secret', { minLen: 5, maxLen: 200 }) ||
    null
  );
}

// ── Request ID helpers ────────────────────────────────────────────────────────

export function getOrCreateRequestId(req: IncomingMessage): string {
  const existing = req.headers['x-request-id'];
  if (typeof existing === 'string' && existing.length > 0) return existing;
  return crypto.randomUUID();
}

export function setRequestIdHeader(res: ServerResponse, requestId: string) {
  res.setHeader('X-Request-ID', requestId);
}

/** Mask a secret key for safe logging: shows first 3 + last 3 chars for keys >= 8, otherwise '***'. */
export function maskKey(key: string): string {
  if (key.length >= 8) {
    return `${key.slice(0, 3)}***${key.slice(-3)}`;
  }
  return '***';
}

/**
 * Send a standardized JSON error response.
 * Format: { error: { message, code?, status } }
 */
export function sendJsonError(
  res: ServerResponse,
  status: number,
  message: string,
  code?: string,
): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
  }
  res.end(JSON.stringify({
    error: {
      message,
      ...(code ? { code } : {}),
      status,
    },
  }));
}
