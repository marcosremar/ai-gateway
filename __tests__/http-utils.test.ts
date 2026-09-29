/**
 * http-utils.ts — Unit Test Suite
 *
 * Covers:
 *   - JsonParseError / BodyTimeoutError error classes
 *   - withTimeout race resolution
 *   - validateLang and VALID_LANGS
 *   - validateCredential (length, prefix, pattern, empty handling)
 *   - validateGpuCredentials (per-provider delegation)
 *   - maskKey
 *   - getRouteBodyLimit (known routes + default fallback)
 *   - handleBodyError (BodyTimeoutError → 408, JsonParseError → 400, unknown → 400)
 *   - readJsonBody (valid JSON, empty body, prototype pollution, size limit)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';

import {
  JsonParseError,
  BodyTimeoutError,
  withTimeout,
  validateLang,
  VALID_LANGS,
  validateCredential,
  validateGpuCredentials,
  maskKey,
  getRouteBodyLimit,
  ROUTE_MAX_BYTES,
  MAX_BODY_BYTES,
  JSON_BODY_MAX_BYTES,
  handleBodyError,
  readJsonBody,
  sendJsonError,
} from '../server/http-utils';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMockResponse() {
  const res = {
    headersSent: false,
    writeHead: vi.fn(function (this: { headersSent: boolean }) { this.headersSent = true; }),
    end: vi.fn(),
  };
  return res as unknown as ServerResponse;
}

function makeRequest(body: string | Buffer, headers: Record<string, string> = {}): IncomingMessage {
  const pt = new PassThrough() as IncomingMessage;
  pt.headers = headers;
  if (body instanceof Buffer) {
    pt.push(body);
  } else {
    pt.push(Buffer.from(body));
  }
  pt.push(null);
  return pt;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Error classes
// ─────────────────────────────────────────────────────────────────────────────

describe('JsonParseError', () => {
  it('has name JsonParseError', () => {
    const err = new JsonParseError('bad token');
    expect(err.name).toBe('JsonParseError');
  });

  it('includes cause detail in message', () => {
    const cause = new SyntaxError('Unexpected token');
    const err = new JsonParseError(cause);
    expect(err.message).toContain('Unexpected token');
  });

  it('handles non-Error cause', () => {
    const err = new JsonParseError('plain string cause');
    expect(err.message).toContain('plain string cause');
  });

  it('is instanceof Error', () => {
    expect(new JsonParseError()).toBeInstanceOf(Error);
  });
});

describe('BodyTimeoutError', () => {
  it('has name BodyTimeoutError', () => {
    const err = new BodyTimeoutError('readJsonBody', 15_000);
    expect(err.name).toBe('BodyTimeoutError');
  });

  it('includes label and ms in message', () => {
    const err = new BodyTimeoutError('readRawBody', 30_000);
    expect(err.message).toContain('readRawBody');
    expect(err.message).toContain('30000');
  });

  it('is instanceof Error', () => {
    expect(new BodyTimeoutError('x', 1)).toBeInstanceOf(Error);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. withTimeout
// ─────────────────────────────────────────────────────────────────────────────

describe('withTimeout', () => {
  it('resolves with the promise value when it settles in time', async () => {
    const result = await withTimeout(Promise.resolve(42), 1_000, 'test');
    expect(result).toBe(42);
  });

  it('rejects with BodyTimeoutError when the promise exceeds the limit', async () => {
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 10, 'slowOp')).rejects.toBeInstanceOf(BodyTimeoutError);
  });

  it('BodyTimeoutError message includes label', async () => {
    const never = new Promise<never>(() => {});
    const err = await withTimeout(never, 10, 'myLabel').catch(e => e);
    expect(err).toBeInstanceOf(BodyTimeoutError);
    expect((err as BodyTimeoutError).message).toContain('myLabel');
  });

  it('propagates rejection from the promise itself', async () => {
    const rejected = Promise.reject(new Error('upstream error'));
    await expect(withTimeout(rejected, 1_000, 'test')).rejects.toThrow('upstream error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. validateLang
// ─────────────────────────────────────────────────────────────────────────────

describe('validateLang', () => {
  it('returns valid language codes as-is', () => {
    expect(validateLang('fr', 'en')).toBe('fr');
    expect(validateLang('en', 'fr')).toBe('en');
    expect(validateLang('es', 'en')).toBe('es');
    expect(validateLang('de', 'en')).toBe('de');
    expect(validateLang('ja', 'en')).toBe('ja');
    expect(validateLang('zh', 'en')).toBe('zh');
    expect(validateLang('it', 'en')).toBe('it');
    expect(validateLang('pt', 'en')).toBe('pt');
  });

  it('returns fallback for unknown language codes', () => {
    expect(validateLang('xx', 'en')).toBe('en');
    expect(validateLang('', 'fr')).toBe('fr');
    expect(validateLang('EN', 'en')).toBe('en'); // case-sensitive
  });

  it('VALID_LANGS contains at least the documented 8 codes', () => {
    for (const code of ['fr', 'en', 'es', 'pt', 'de', 'it', 'ja', 'zh']) {
      expect(VALID_LANGS.has(code)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. validateCredential
// ─────────────────────────────────────────────────────────────────────────────

describe('validateCredential', () => {
  it('returns null for an empty key (not provided)', () => {
    expect(validateCredential('', 'RunPod key')).toBeNull();
  });

  it('returns error when key is shorter than minLen', () => {
    const err = validateCredential('short', 'RunPod key', { minLen: 20 });
    expect(err).toContain('too short');
    expect(err).toContain('20');
  });

  it('returns error when key is longer than maxLen', () => {
    const err = validateCredential('x'.repeat(201), 'RunPod key', { maxLen: 200 });
    expect(err).toContain('too long');
    expect(err).toContain('200');
  });

  it('returns error when key does not start with required prefix', () => {
    const err = validateCredential('sk_wrong_prefix_longkey', 'OpenAI key', { prefix: 'rpa_', minLen: 10 });
    expect(err).toContain("must start with 'rpa_'");
  });

  it('returns null when prefix matches', () => {
    const err = validateCredential('rpa_abcdefghij1234567890', 'RunPod key', { prefix: 'rpa_', minLen: 10, maxLen: 100 });
    expect(err).toBeNull();
  });

  it('returns error when key does not match pattern', () => {
    const err = validateCredential('has!special@chars_long_enough', 'Vast key', { pattern: /^[0-9a-fA-F]+$/, minLen: 10 });
    expect(err).toContain('invalid format');
  });

  it('returns null when key matches hex pattern', () => {
    const hexKey = 'a1b2c3d4e5f6789012345678901234567890ab12';
    expect(validateCredential(hexKey, 'Vast key', { pattern: /^[0-9a-fA-F]+$/, minLen: 20, maxLen: 100 })).toBeNull();
  });

  it('uses default minLen=10 maxLen=200 when no opts provided', () => {
    // key length = 5 → too short with defaults
    expect(validateCredential('abcde', 'key')).toContain('too short');
    // key length = 10 → acceptable
    expect(validateCredential('abcdefghij', 'key')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. validateGpuCredentials
// ─────────────────────────────────────────────────────────────────────────────

describe('validateGpuCredentials', () => {
  it('returns null when all credentials are empty (nothing provided)', () => {
    expect(validateGpuCredentials({})).toBeNull();
  });

  it('validates RunPod API key prefix rpa_', () => {
    const err = validateGpuCredentials({ runpodApiKey: 'wrong_prefix_longkey1234' });
    expect(err).toContain("must start with 'rpa_'");
  });

  it('returns null for a valid RunPod API key', () => {
    expect(validateGpuCredentials({ runpodApiKey: 'rpa_abcdef1234567890abcdef' })).toBeNull();
  });

  it('validates Vast.ai API key as hex string', () => {
    const err = validateGpuCredentials({ vastApiKey: 'not-hex-value-but-long-enough!' });
    expect(err).toContain('invalid format');
  });

  it('returns null for a valid Vast.ai API key (hex, ≥20 chars)', () => {
    expect(validateGpuCredentials({ vastApiKey: 'a1b2c3d4e5f67890abcd12345678901234567890' })).toBeNull();
  });

  it('validates TensorDock API key as alphanumeric', () => {
    const err = validateGpuCredentials({ tensordockApiKey: 'contains-dashes-enough!length' });
    expect(err).toContain('invalid format');
  });

  it('returns null for a valid TensorDock API key', () => {
    expect(validateGpuCredentials({ tensordockApiKey: 'AbCdEfGhIj1234567890', tensordockAuthId: 'authid12345' })).toBeNull();
  });

  it('validates Modal Token ID minimum length', () => {
    const err = validateGpuCredentials({ modalTokenId: 'ab' });
    expect(err).toContain('too short');
  });

  it('validates Modal Token Secret minimum length', () => {
    const err = validateGpuCredentials({ modalTokenSecret: 'ab' });
    expect(err).toContain('too short');
  });

  it('returns null when only valid Modal credentials provided', () => {
    expect(validateGpuCredentials({ modalTokenId: 'ak-abcdefgh', modalTokenSecret: 'sk-secretkey12345678' })).toBeNull();
  });

  it('first violation wins (RunPod checked first)', () => {
    const err = validateGpuCredentials({
      runpodApiKey: 'wrong_and_also_too_short_longer',
      vastApiKey: 'bad',
    });
    // RunPod error expected first
    expect(err).toContain("must start with 'rpa_'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. maskKey
// ─────────────────────────────────────────────────────────────────────────────

describe('maskKey', () => {
  it('returns *** for keys shorter than 8 chars', () => {
    expect(maskKey('')).toBe('***');
    expect(maskKey('abc')).toBe('***');
    expect(maskKey('abcdefg')).toBe('***'); // length 7
  });

  it('shows first 3 and last 3 chars for keys ≥ 8 chars', () => {
    expect(maskKey('abcdef123')).toBe('abc***123');
    expect(maskKey('sk_test_1234567890')).toBe('sk_***890');
  });

  it('handles exactly 8-character keys', () => {
    expect(maskKey('abcdefgh')).toBe('abc***fgh');
  });

  it('does not include middle chars', () => {
    const key = 'rpa_MIDDLE_SECTION_end';
    const masked = maskKey(key);
    expect(masked.startsWith('rpa')).toBe(true);
    expect(masked.endsWith('end')).toBe(true);
    expect(masked).toContain('***');
    expect(masked).not.toContain('MIDDLE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. getRouteBodyLimit / ROUTE_MAX_BYTES
// ─────────────────────────────────────────────────────────────────────────────

describe('getRouteBodyLimit', () => {
  it('returns MAX_BODY_BYTES for unknown routes', () => {
    expect(getRouteBodyLimit('/v1/unknown')).toBe(MAX_BODY_BYTES);
    expect(getRouteBodyLimit('/')).toBe(MAX_BODY_BYTES);
  });

  it('applies 1MB limit for text-heavy endpoints', () => {
    expect(getRouteBodyLimit('/v1/translate')).toBe(1 * 1024 * 1024);
    expect(getRouteBodyLimit('/v1/chat/completions')).toBe(1 * 1024 * 1024);
    expect(getRouteBodyLimit('/v1/playground/llm')).toBe(1 * 1024 * 1024);
    expect(getRouteBodyLimit('/v1/config/providers')).toBe(512 * 1024);
  });

  it('applies small limits for config endpoints', () => {
    expect(getRouteBodyLimit('/v1/config/api-keys')).toBe(64 * 1024);
    expect(getRouteBodyLimit('/v1/config/labs')).toBe(64 * 1024);
    expect(getRouteBodyLimit('/v1/gpu/preflight')).toBe(64 * 1024);
    expect(getRouteBodyLimit('/v1/docker/build')).toBe(64 * 1024);
  });

  it('applies 16KB limit for heartbeat and alert endpoints', () => {
    expect(getRouteBodyLimit('/v1/gpu/heartbeat')).toBe(16 * 1024);
    expect(getRouteBodyLimit('/v1/errors/alerts/acknowledge')).toBe(16 * 1024);
  });

  it('MAX_BODY_BYTES is 50MB', () => {
    expect(MAX_BODY_BYTES).toBe(50 * 1024 * 1024);
  });

  it('ROUTE_MAX_BYTES has all documented routes', () => {
    const keys = Object.keys(ROUTE_MAX_BYTES);
    expect(keys).toContain('/v1/translate');
    expect(keys).toContain('/v1/chat/completions');
    expect(keys).toContain('/v1/config/api-keys');
    expect(keys).toContain('/v1/gpu/heartbeat');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. sendJsonError
// ─────────────────────────────────────────────────────────────────────────────

describe('sendJsonError', () => {
  it('sends status code and JSON error body', () => {
    const res = makeMockResponse();
    sendJsonError(res, 404, 'Not found', 'NOT_FOUND');
    expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
    const body = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(body.error.message).toBe('Not found');
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.status).toBe(404);
  });

  it('omits code field when not provided', () => {
    const res = makeMockResponse();
    sendJsonError(res, 500, 'Internal error');
    const body = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(body.error).not.toHaveProperty('code');
  });

  it('skips writeHead if headers already sent', () => {
    const res = makeMockResponse();
    (res as unknown as { headersSent: boolean }).headersSent = true;
    sendJsonError(res, 400, 'Bad', 'BAD');
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. handleBodyError
// ─────────────────────────────────────────────────────────────────────────────

describe('handleBodyError', () => {
  it('sends 408 for BodyTimeoutError', () => {
    const res = makeMockResponse();
    handleBodyError(res, new BodyTimeoutError('readBody', 15_000));
    expect(res.writeHead).toHaveBeenCalledWith(408, expect.anything());
    const body = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(body.error.code).toBe('REQUEST_TIMEOUT');
  });

  it('sends 400 with message for JsonParseError', () => {
    const res = makeMockResponse();
    handleBodyError(res, new JsonParseError('bad input'));
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
    const body = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(body.error.message).toContain('bad input');
  });

  it('sends 400 with "Invalid JSON body" for unknown errors', () => {
    const res = makeMockResponse();
    handleBodyError(res, new Error('unknown'));
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
    const body = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(body.error.message).toBe('Invalid JSON body');
  });

  it('sends 400 when no error is provided', () => {
    const res = makeMockResponse();
    handleBodyError(res);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. readJsonBody — stream-based
// ─────────────────────────────────────────────────────────────────────────────

describe('readJsonBody', () => {
  it('parses a valid JSON object', async () => {
    const req = makeRequest(JSON.stringify({ hello: 'world' }));
    const body = await readJsonBody(req);
    expect(body).toEqual({ hello: 'world' });
  });

  it('returns empty object for an empty body', async () => {
    const req = makeRequest('');
    const body = await readJsonBody(req);
    expect(body).toEqual({});
  });

  it('returns empty object for whitespace-only body', async () => {
    const req = makeRequest('   \n  ');
    const body = await readJsonBody(req);
    expect(body).toEqual({});
  });

  it('rejects with JsonParseError for invalid JSON', async () => {
    const req = makeRequest('not-valid-json');
    await expect(readJsonBody(req)).rejects.toBeInstanceOf(JsonParseError);
  });

  it('sanitizes __proto__ pollution — no own property named __proto__', async () => {
    const payload = '{"__proto__":{"isAdmin":true},"name":"test"}';
    const req = makeRequest(payload);
    const body = await readJsonBody(req);
    // The reviver drops __proto__ — verify no OWN property and no prototype leak
    expect(Object.prototype.hasOwnProperty.call(body, '__proto__')).toBe(false);
    expect((Object.prototype as Record<string, unknown>).isAdmin).toBeUndefined();
    expect((body as Record<string, unknown>).name).toBe('test');
  });

  it('sanitizes constructor key — no own constructor property after parse', async () => {
    const payload = JSON.stringify({ constructor: { evil: true }, safe: 1 });
    const req = makeRequest(payload);
    const body = await readJsonBody(req);
    // The reviver drops constructor — verify no OWN property named constructor
    expect(Object.prototype.hasOwnProperty.call(body, 'constructor')).toBe(false);
    expect(body.safe).toBe(1);
  });

  it('rejects when the body exceeds JSON_BODY_MAX_BYTES', async () => {
    const oversized = Buffer.alloc(JSON_BODY_MAX_BYTES + 1, 'x');
    const req = new PassThrough() as IncomingMessage;
    req.headers = {};
    const bodyPromise = readJsonBody(req);
    req.push(oversized);
    req.push(null);
    await expect(bodyPromise).rejects.toThrow(/too large/i);
  });

  it('JSON_BODY_MAX_BYTES is 2MB', () => {
    expect(JSON_BODY_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});
