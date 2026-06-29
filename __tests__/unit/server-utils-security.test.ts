// ── server/utils security-sensitive module unit suite ───────────────────────
// Covers:
//   server/utils/mask-key.ts        — maskKey, maskKeys
//   server/utils/graphql-safe.ts    — validateGraphQLQuery, buildGraphQLQuery
//   server/utils/response-factory.ts — sendJson, sendError, convenience helpers, handleRequest
//   server/utils/safe-exec.ts       — command allowlist + arg validation + result mapping
//
// All I/O is mocked — no real processes or network calls.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── child_process mock — must be hoisted before SUT import ──────────────────
let _execFileCb: ((err: unknown, stdout: string, stderr: string) => void) | null = null;
let _execFileSyncImpl: (() => Buffer | string) | null = null;

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: unknown, stdout: string, stderr: string) => void,
    ) => {
      if (_execFileCb) _execFileCb(null, '', ''); // overridden per-test
      // The per-test override is set via _execFileCb before the call resolves
    },
    execFileSync: (_cmd: string, _args: string[], _opts: unknown) => {
      if (_execFileSyncImpl) return _execFileSyncImpl();
      return Buffer.from('');
    },
  };
});

vi.mock('../../src/logger', () => {
  const noop = () => ({
    debug: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return { createLogger: noop, defaultLogger: noop() };
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. mask-key
// ─────────────────────────────────────────────────────────────────────────────

import { maskKey, maskKeys } from '../../server/utils/mask-key';

describe('maskKey', () => {
  it('returns *** for empty string', () => {
    expect(maskKey('')).toBe('***');
  });

  it('returns *** for null', () => {
    expect(maskKey(null)).toBe('***');
  });

  it('returns *** for undefined', () => {
    expect(maskKey(undefined)).toBe('***');
  });

  it('returns *** for key with exactly 8 characters (at threshold)', () => {
    expect(maskKey('abcdefgh')).toBe('***');
  });

  it('masks key longer than 8 chars with first-4 and last-4 visible', () => {
    expect(maskKey('gsk_abc123def456')).toBe('gsk_***f456');
  });

  it('masks a typical RunPod API key', () => {
    const masked = maskKey('ABCDEF1234567890GHIJ');
    expect(masked).toMatch(/^ABCD\*\*\*GHIJ$/);
  });

  it('masks a key of exactly 9 chars (one over threshold)', () => {
    expect(maskKey('123456789')).toBe('1234***6789');
  });

  it('does not expose middle characters', () => {
    const key = 'prefix_SECRETSECRET_suffix';
    const masked = maskKey(key);
    expect(masked).not.toContain('SECRET');
    expect(masked).toContain('pref');
    expect(masked).toContain('ffix');
  });
});

describe('maskKeys', () => {
  it('masks all values by default', () => {
    const result = maskKeys({ a: 'longApiKeyForA', b: 'longApiKeyForB' });
    expect(result.a).toContain('***');
    expect(result.b).toContain('***');
  });

  it('masks only specified keys', () => {
    const obj = { public: 'hello_world_xx', secret: 'ABCDEFGHIJKLMNO' };
    const result = maskKeys(obj, ['secret']);
    expect(result.secret).toContain('***');
  });

  it('returns *** for undefined values', () => {
    const result = maskKeys({ key: undefined });
    expect(result.key).toBe('***');
  });

  it('handles empty object', () => {
    expect(maskKeys({})).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. graphql-safe
// ─────────────────────────────────────────────────────────────────────────────

import { validateGraphQLQuery, buildGraphQLQuery } from '../../server/utils/graphql-safe';

describe('validateGraphQLQuery', () => {
  it('accepts a clean parameterized query', () => {
    expect(() =>
      validateGraphQLQuery(`
        query GetPod($podId: String!) {
          pod(input: { podId: $podId }) { id }
        }
      `),
    ).not.toThrow();
  });

  it('rejects template literal interpolation ${...}', () => {
    expect(() =>
      validateGraphQLQuery('{ pod(id: "${podId}") { id } }'),
    ).toThrow('dangerous');
  });

  it('rejects single-quote string concatenation', () => {
    expect(() =>
      validateGraphQLQuery("{ user(name: 'a' + 'b') { id } }"),
    ).toThrow('dangerous');
  });

  it('rejects double-quote string concatenation', () => {
    expect(() =>
      validateGraphQLQuery('{ user(name: "a" + "b") { id } }'),
    ).toThrow('dangerous');
  });

  it('rejects SQL-style DROP injection', () => {
    expect(() =>
      validateGraphQLQuery('{ foo }; DROP TABLE users'),
    ).toThrow('dangerous');
  });

  it('rejects SQL-style DELETE injection', () => {
    expect(() =>
      validateGraphQLQuery('{ foo }; DELETE FROM pods'),
    ).toThrow('dangerous');
  });

  it('is case-insensitive for SQL keywords', () => {
    expect(() =>
      validateGraphQLQuery('{ foo }; drop table pods'),
    ).toThrow('dangerous');
  });

  it('accepts dollar-sign variable declarations (not interpolation)', () => {
    expect(() =>
      validateGraphQLQuery('query Q($podId: String!) { pod(id: $podId) { id } }'),
    ).not.toThrow();
  });
});

describe('buildGraphQLQuery', () => {
  it('builds a query with no variables', () => {
    const { query, variables } = buildGraphQLQuery('query ListPods', ['id', 'status']);
    expect(query).toContain('query ListPods');
    expect(query).toContain('id');
    expect(query).toContain('status');
    expect(variables).toEqual({});
  });

  it('builds variable definitions and extracts values', () => {
    const { query, variables } = buildGraphQLQuery(
      'query GetPod',
      ['id', 'name'],
      { podId: { type: 'String', value: 'pod-123' } },
    );
    expect(query).toContain('$podId: String!');
    expect(variables).toEqual({ podId: 'pod-123' });
  });

  it('handles multiple variables with comma separation', () => {
    const { query } = buildGraphQLQuery(
      'mutation M',
      ['ok'],
      {
        a: { type: 'String', value: 'x' },
        b: { type: 'Int', value: 42 },
      },
    );
    expect(query).toContain('$a: String!');
    expect(query).toContain('$b: Int!');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. response-factory  (mocked ServerResponse)
// ─────────────────────────────────────────────────────────────────────────────

import {
  sendJson,
  sendError,
  sendBadRequest,
  sendUnauthorized,
  sendForbidden,
  sendNotFound,
  sendRateLimited,
  sendInternalServerError,
  handleRequest,
} from '../../server/utils/response-factory';
import type { ServerResponse } from 'http';

function makeMockRes() {
  let statusCode = 0;
  let writtenHeaders: Record<string, string> = {};
  let rawBody = '';
  const res = {
    writeHead: vi.fn((code: number, headers: Record<string, string>) => {
      statusCode = code;
      writtenHeaders = headers ?? {};
    }),
    end: vi.fn((body: string) => {
      rawBody = body;
    }),
    get statusCode() { return statusCode; },
    get headers() { return writtenHeaders; },
    get body() { return JSON.parse(rawBody || '{}'); },
  };
  return res as unknown as ServerResponse & {
    statusCode: number;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
}

describe('sendJson', () => {
  it('writes 200 with wrapped JSON body', () => {
    const res = makeMockRes();
    sendJson(res, { hello: 'world' });
    expect((res as any).statusCode).toBe(200);
    expect((res as any).body.data).toEqual({ hello: 'world' });
    expect((res as any).body.timestamp).toBeDefined();
  });

  it('includes requestId in header and body when provided', () => {
    const res = makeMockRes();
    sendJson(res, {}, { requestId: 'req-abc' });
    expect((res as any).headers['X-Request-Id']).toBe('req-abc');
    expect((res as any).body.requestId).toBe('req-abc');
  });

  it('sets security headers on every response', () => {
    const res = makeMockRes();
    sendJson(res, null);
    expect((res as any).headers['X-Content-Type-Options']).toBe('nosniff');
    expect((res as any).headers['X-Frame-Options']).toBe('DENY');
  });

  it('sets CORS header when corsOrigin provided', () => {
    const res = makeMockRes();
    sendJson(res, {}, { corsOrigin: 'https://example.com' });
    expect((res as any).headers['Access-Control-Allow-Origin']).toBe('https://example.com');
  });
});

describe('sendError', () => {
  it('writes the given status code', () => {
    const res = makeMockRes();
    sendError(res, 422, 'Unprocessable', 'VALIDATION');
    expect((res as any).statusCode).toBe(422);
  });

  it('includes message, code, and statusCode in body', () => {
    const res = makeMockRes();
    sendError(res, 400, 'Bad input', 'BAD_INPUT');
    const body = (res as any).body;
    expect(body.message).toBe('Bad input');
    expect(body.code).toBe('BAD_INPUT');
    expect(body.statusCode).toBe(400);
  });

  it('defaults error field to ERROR when no code given', () => {
    const res = makeMockRes();
    sendError(res, 500, 'oops');
    expect((res as any).body.error).toBe('ERROR');
  });
});

describe('sendBadRequest', () => {
  it('uses 400 status code with BAD_REQUEST code', () => {
    const res = makeMockRes();
    sendBadRequest(res, 'missing field');
    expect((res as any).statusCode).toBe(400);
    expect((res as any).body.code).toBe('BAD_REQUEST');
    expect((res as any).body.message).toBe('missing field');
  });
});

describe('sendUnauthorized', () => {
  it('uses 401 status code with default message', () => {
    const res = makeMockRes();
    sendUnauthorized(res);
    expect((res as any).statusCode).toBe(401);
    expect((res as any).body.message).toMatch(/auth/i);
  });

  it('uses custom message when provided', () => {
    const res = makeMockRes();
    sendUnauthorized(res, 'Token expired');
    expect((res as any).body.message).toBe('Token expired');
  });
});

describe('sendForbidden', () => {
  it('uses 403 status code with FORBIDDEN code', () => {
    const res = makeMockRes();
    sendForbidden(res);
    expect((res as any).statusCode).toBe(403);
    expect((res as any).body.code).toBe('FORBIDDEN');
  });
});

describe('sendNotFound', () => {
  it('uses 404 status code and includes resource in message', () => {
    const res = makeMockRes();
    sendNotFound(res, 'Pod');
    expect((res as any).statusCode).toBe(404);
    expect((res as any).body.message).toContain('Pod');
    expect((res as any).body.message).toContain('not found');
    expect((res as any).body.code).toBe('NOT_FOUND');
  });
});

describe('sendRateLimited', () => {
  it('uses 429 status code with RATE_LIMITED code', () => {
    const res = makeMockRes();
    sendRateLimited(res);
    expect((res as any).statusCode).toBe(429);
    expect((res as any).body.code).toBe('RATE_LIMITED');
  });

  it('sets Retry-After header when retryAfterMs provided', () => {
    const res = makeMockRes();
    sendRateLimited(res, 5000);
    expect((res as any).headers['Retry-After']).toBe('5');
  });

  it('rounds up Retry-After to the next whole second', () => {
    const res = makeMockRes();
    sendRateLimited(res, 1001);
    expect((res as any).headers['Retry-After']).toBe('2');
  });

  it('omits Retry-After header when retryAfterMs not provided', () => {
    const res = makeMockRes();
    sendRateLimited(res);
    expect((res as any).headers['Retry-After']).toBeUndefined();
  });
});

describe('sendInternalServerError', () => {
  it('uses 500 status code with INTERNAL_ERROR code', () => {
    const res = makeMockRes();
    sendInternalServerError(res);
    expect((res as any).statusCode).toBe(500);
    expect((res as any).body.code).toBe('INTERNAL_ERROR');
  });

  it('uses custom message', () => {
    const res = makeMockRes();
    sendInternalServerError(res, 'DB is down');
    expect((res as any).body.message).toBe('DB is down');
  });
});

describe('handleRequest', () => {
  it('calls sendJson with the resolved value on success', async () => {
    const res = makeMockRes();
    await handleRequest(null, res, async () => ({ ok: true }));
    expect((res as any).statusCode).toBe(200);
    expect((res as any).body.data).toEqual({ ok: true });
  });

  it('calls sendInternalServerError when fn throws an Error', async () => {
    const res = makeMockRes();
    await handleRequest(null, res, async () => { throw new Error('explode'); });
    expect((res as any).statusCode).toBe(500);
    expect((res as any).body.message).toBe('explode');
  });

  it('handles non-Error throws gracefully', async () => {
    const res = makeMockRes();
    await handleRequest(null, res, async () => { throw 'string error'; });
    expect((res as any).statusCode).toBe(500);
    expect((res as any).body.message).toBe('string error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. safe-exec — validation logic tested without spawning real processes
//    The child_process mock at the top intercepts execFile / execFileSync.
//    Per-test behaviour is controlled via _execFileCb / _execFileSyncImpl.
// ─────────────────────────────────────────────────────────────────────────────

import { safeExec, safeExecSync } from '../../server/utils/safe-exec';
import { execFile as mockedExecFile, execFileSync as mockedExecFileSync } from 'child_process';

// Re-wire the mock implementation per test via module-level variables.
// We replace the mock factory functions with per-test closures.
function withExecFile(
  impl: (cmd: string, args: string[], opts: unknown, cb: Function) => void,
  fn: () => Promise<void>,
): Promise<void> {
  (mockedExecFile as any).__impl = impl;
  return fn().finally(() => { delete (mockedExecFile as any).__impl; });
}

// Override the module mock to delegate to __impl
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (cmd: string, args: string[], opts: unknown, cb: Function) => {
      const impl = (mockedExecFile as any).__impl;
      if (impl) return impl(cmd, args, opts, cb);
      // Default: succeed with empty output
      setImmediate(() => cb(null, '', ''));
    },
    execFileSync: (cmd: string, args: string[], opts: unknown) => {
      const impl = (mockedExecFileSync as any).__impl;
      if (impl) return impl(cmd, args, opts);
      return Buffer.from('');
    },
  };
});

describe('safeExec — argument validation rejects shell metacharacters', () => {
  it.each([
    ['semicolon injection', 'hello; rm -rf /'],
    ['pipe injection', 'foo | cat /etc/passwd'],
    ['backtick injection', '`id`'],
    ['dollar injection', '$(cat /etc/passwd)'],
    ['redirect injection', '< /etc/passwd'],
    ['ampersand injection', 'cmd & bg'],
    ['backslash escape', 'path\\n..'],
    ['curly brace', '${HOME}'],
    ['exclamation mark', '!history'],
    ['gt redirect', '> /tmp/out'],
  ])('rejects argument with %s', async (_label, arg) => {
    await expect(safeExec('echo', [arg])).rejects.toThrow('dangerous');
  });
});

describe('safeExec — allowlist enforcement', () => {
  it('rejects command not in allowlist', async () => {
    await expect(
      safeExec('rm', ['-rf', '/'], { allowedCommands: new Set(['echo', 'ls']) }),
    ).rejects.toThrow('not in the allowed list');
  });

  it('accepts command in allowlist by basename (full path)', async () => {
    (mockedExecFile as any).__impl = (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: Function,
    ) => setImmediate(() => cb(null, 'ok', ''));

    const result = await safeExec('/usr/bin/echo', ['test'], {
      allowedCommands: new Set(['echo']),
    });
    expect(result.stdout).toBe('ok');
    delete (mockedExecFile as any).__impl;
  });

  it('allows any command when allowedCommands is empty (default)', async () => {
    (mockedExecFile as any).__impl = (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: Function,
    ) => setImmediate(() => cb(null, 'result', ''));

    const result = await safeExec('ls', []);
    expect(result.stdout).toBe('result');
    delete (mockedExecFile as any).__impl;
  });
});

describe('safeExec — result mapping', () => {
  beforeEach(() => { delete (mockedExecFile as any).__impl; });

  it('maps stdout and stderr from callback', async () => {
    (mockedExecFile as any).__impl = (_c: string, _a: string[], _o: unknown, cb: Function) =>
      setImmediate(() => cb(null, 'out', 'err'));

    const result = await safeExec('cmd', []);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    delete (mockedExecFile as any).__impl;
  });

  it('returns exitCode 0 on success (no error object)', async () => {
    (mockedExecFile as any).__impl = (_c: string, _a: string[], _o: unknown, cb: Function) =>
      setImmediate(() => cb(null, 'ok', ''));

    const result = await safeExec('cmd', []);
    expect(result.exitCode).toBe(0);
    delete (mockedExecFile as any).__impl;
  });

  it('captures signal from error', async () => {
    const err = Object.assign(new Error('killed'), { signal: 'SIGKILL' });
    (mockedExecFile as any).__impl = (_c: string, _a: string[], _o: unknown, cb: Function) =>
      setImmediate(() => cb(err, '', ''));

    const result = await safeExec('cmd', []);
    expect(result.signal).toBe('SIGKILL');
    delete (mockedExecFile as any).__impl;
  });

  it('truncates stdout to maxStdoutBytes', async () => {
    const longOutput = 'x'.repeat(2000);
    (mockedExecFile as any).__impl = (_c: string, _a: string[], _o: unknown, cb: Function) =>
      setImmediate(() => cb(null, longOutput, ''));

    const result = await safeExec('cmd', [], { maxStdoutBytes: 100 });
    expect(result.stdout.length).toBe(100);
    delete (mockedExecFile as any).__impl;
  });
});

describe('safeExecSync — argument validation', () => {
  it('rejects dangerous arguments', () => {
    expect(() => safeExecSync('echo', ['`rm -rf /`'])).toThrow('dangerous');
  });

  it('rejects command not in allowlist', () => {
    expect(() =>
      safeExecSync('rm', ['-rf', '/'], { allowedCommands: new Set(['echo']) }),
    ).toThrow('not in the allowed list');
  });
});

describe('safeExecSync — result mapping', () => {
  it('returns stdout on success', () => {
    (mockedExecFileSync as any).__impl = () => Buffer.from('sync-out');
    const result = safeExecSync('echo', ['hi']);
    expect(result.stdout).toBe('sync-out');
    expect(result.exitCode).toBe(0);
    delete (mockedExecFileSync as any).__impl;
  });

  it('returns exitCode from error.status on failure', () => {
    (mockedExecFileSync as any).__impl = () => {
      throw Object.assign(new Error('fail'), { status: 127, stdout: '', stderr: 'not found' });
    };
    const result = safeExecSync('missing-cmd', []);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe('not found');
    delete (mockedExecFileSync as any).__impl;
  });

  it('defaults exitCode to 1 when error has no status', () => {
    (mockedExecFileSync as any).__impl = () => { throw new Error('unknown'); };
    const result = safeExecSync('cmd', []);
    expect(result.exitCode).toBe(1);
    delete (mockedExecFileSync as any).__impl;
  });

  it('marks timedOut=true when error.code is ETIMEOUT', () => {
    (mockedExecFileSync as any).__impl = () => {
      throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT', status: 1, stdout: '', stderr: '' });
    };
    const result = safeExecSync('cmd', []);
    expect(result.timedOut).toBe(true);
    delete (mockedExecFileSync as any).__impl;
  });
});
