/**
 * Builtin tools registry — pre-registered safe tools exposed via
 * POST /v1/tools/dispatch with `{ kind: 'builtin', name: 'http_get' }`.
 *
 * Each builtin is conservative by design: SSRF guard on URLs, path whitelist
 * on file reads, fixed timeouts. Adding new builtins MUST preserve those
 * invariants — the public dispatch endpoint runs untrusted LLM-generated
 * input.
 */

import { readFile, stat } from 'fs/promises';
import path from 'path';
import { isPrivateUrlResolved } from '../src/gateway/pipeline/ssrf-protection';
import type { ToolHandler } from '../src/llm-context';

export interface BuiltinContext {
  /** Whitelisted directories for read_file. Caller-controlled — empty list disables read_file. */
  allowedReadDirs?: string[];
  /** Max bytes to read from any single source (default 256KB). */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export function listBuiltinTools(): string[] {
  return ['current_time', 'http_get', 'read_file', 'json_extract'];
}

export function makeBuiltin(name: string, ctx: BuiltinContext = {}): ToolHandler | null {
  switch (name) {
    case 'current_time':
      return makeCurrentTime();
    case 'http_get':
      return makeHttpGet(ctx);
    case 'read_file':
      return makeReadFile(ctx);
    case 'json_extract':
      return makeJsonExtract();
    default:
      return null;
  }
}

function makeCurrentTime(): ToolHandler {
  return {
    name: 'current_time',
    invoke: async (input) => {
      const tz = (input as { timezone?: string })?.timezone ?? 'UTC';
      const now = new Date();
      let formatted: string;
      try {
        formatted = now.toLocaleString('en-US', { timeZone: tz });
      } catch {
        formatted = now.toISOString();
      }
      return JSON.stringify({ iso: now.toISOString(), epoch_ms: now.getTime(), formatted, timezone: tz });
    },
  };
}

function makeHttpGet(ctx: BuiltinContext): ToolHandler {
  const maxBytes = ctx.maxBytes ?? DEFAULT_MAX_BYTES;
  return {
    name: 'http_get',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    invoke: async (input, runCtx) => {
      const url = (input as { url?: unknown })?.url;
      if (typeof url !== 'string' || !url) throw new Error('http_get requires {url:string}');
      let parsed: URL;
      try { parsed = new URL(url); }
      catch { throw new Error(`http_get: invalid url "${url}"`); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`http_get: unsupported protocol "${parsed.protocol}"`);
      }
      if (await isPrivateUrlResolved(url)) {
        throw new Error(`http_get: url resolves to private address (SSRF blocked)`);
      }
      const res = await fetch(url, { method: 'GET', signal: runCtx.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`http_get: HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const reader = res.body?.getReader();
      if (!reader) {
        const txt = await res.text();
        return txt.slice(0, maxBytes);
      }
      let received = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel();
          throw new Error(`http_get: response exceeds max ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return buf.toString('utf8');
    },
  };
}

function makeReadFile(ctx: BuiltinContext): ToolHandler {
  const allowed = (ctx.allowedReadDirs ?? []).map((d) => path.resolve(d));
  const maxBytes = ctx.maxBytes ?? DEFAULT_MAX_BYTES;
  return {
    name: 'read_file',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    invoke: async (input) => {
      if (allowed.length === 0) throw new Error('read_file: no allowed directories configured');
      const filePath = (input as { path?: unknown })?.path;
      if (typeof filePath !== 'string' || !filePath) throw new Error('read_file requires {path:string}');
      const resolved = path.resolve(filePath);
      const inAllowed = allowed.some((root) => resolved === root || resolved.startsWith(root + path.sep));
      if (!inAllowed) throw new Error(`read_file: path "${resolved}" outside allowed dirs`);
      const st = await stat(resolved);
      if (!st.isFile()) throw new Error(`read_file: "${resolved}" is not a regular file`);
      if (st.size > maxBytes) throw new Error(`read_file: file size ${st.size} exceeds max ${maxBytes}`);
      const buf = await readFile(resolved);
      return buf.toString('utf8');
    },
  };
}

function makeJsonExtract(): ToolHandler {
  return {
    name: 'json_extract',
    invoke: async (input) => {
      const { json, path: jsonPath } = (input as { json?: unknown; path?: unknown }) ?? {};
      if (typeof jsonPath !== 'string') throw new Error('json_extract requires {json:any, path:string}');
      let value: unknown = typeof json === 'string' ? JSON.parse(json) : json;
      if (jsonPath === '' || jsonPath === '$') return JSON.stringify(value);
      const parts = jsonPath.replace(/^\$\.?/, '').split(/[.[\]]/).filter(Boolean);
      for (const part of parts) {
        if (value === null || value === undefined) {
          throw new Error(`json_extract: cannot resolve "${part}" on null/undefined`);
        }
        if (Array.isArray(value)) {
          const idx = Number(part);
          if (!Number.isInteger(idx)) throw new Error(`json_extract: array index must be integer, got "${part}"`);
          value = value[idx];
        } else if (typeof value === 'object') {
          value = (value as Record<string, unknown>)[part];
        } else {
          throw new Error(`json_extract: cannot index into ${typeof value}`);
        }
      }
      return JSON.stringify(value ?? null);
    },
  };
}
