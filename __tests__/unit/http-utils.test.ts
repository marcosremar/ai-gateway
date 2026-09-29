// ── http-utils pure-function unit suite ─────────────────────────────────────
// Tests for: validateCredential, validateGpuCredentials, maskKey,
// validateLang, getRouteBodyLimit — no I/O, no mocks needed.

import { describe, it, expect } from 'vitest';
import {
  validateCredential,
  validateGpuCredentials,
  maskKey,
  validateLang,
  getRouteBodyLimit,
  MAX_BODY_BYTES,
  ROUTE_MAX_BYTES,
} from '../../server/http-utils';

// ── validateCredential ────────────────────────────────────────────────────────

describe('validateCredential', () => {
  it('returns null for empty string (not provided)', () => {
    expect(validateCredential('', 'My Key')).toBeNull();
  });

  it('returns null for valid key with no constraints', () => {
    expect(validateCredential('abcdefghij', 'Test Key')).toBeNull();
  });

  it('rejects key shorter than minLen', () => {
    const err = validateCredential('short', 'API key', { minLen: 10 });
    expect(err).toMatch(/too short/);
    expect(err).toMatch(/10/);
  });

  it('rejects key longer than maxLen', () => {
    const err = validateCredential('a'.repeat(201), 'API key', { maxLen: 200 });
    expect(err).toMatch(/too long/);
    expect(err).toMatch(/200/);
  });

  it('maxLen checked before minLen', () => {
    // A key that exceeds maxLen should report too-long, not too-short
    const err = validateCredential('a'.repeat(15), 'Key', { minLen: 5, maxLen: 10 });
    expect(err).toMatch(/too long/);
  });

  it('rejects key that does not start with required prefix', () => {
    const err = validateCredential('wrongprefix_abc123', 'RunPod key', { prefix: 'rpa_', minLen: 10 });
    expect(err).toMatch(/must start with/);
    expect(err).toContain("'rpa_'");
  });

  it('accepts key that starts with required prefix', () => {
    const key = 'rpa_' + 'a'.repeat(20);
    expect(validateCredential(key, 'RunPod key', { prefix: 'rpa_', minLen: 10 })).toBeNull();
  });

  it('rejects key that fails pattern check', () => {
    const err = validateCredential('invalid!@#key', 'Vast key', { pattern: /^[0-9a-fA-F]+$/, minLen: 5 });
    expect(err).toMatch(/invalid format/);
  });

  it('accepts key that matches pattern', () => {
    expect(validateCredential('deadbeef1234abcd', 'Vast key', { pattern: /^[0-9a-fA-F]+$/, minLen: 10 })).toBeNull();
  });

  it('prefix check comes before pattern check', () => {
    // key lacks prefix AND fails pattern; error should mention prefix
    const err = validateCredential('a'.repeat(20), 'Key', { prefix: 'rpa_', pattern: /^rpa_/, minLen: 10 });
    expect(err).toMatch(/must start with/);
  });

  it('uses default minLen=10 when not specified', () => {
    expect(validateCredential('123456789', 'Key')).toMatch(/too short/);
    expect(validateCredential('1234567890', 'Key')).toBeNull();
  });

  it('uses default maxLen=200 when not specified', () => {
    expect(validateCredential('a'.repeat(200), 'Key')).toBeNull();
    expect(validateCredential('a'.repeat(201), 'Key')).toMatch(/too long/);
  });

  it('error message includes field name', () => {
    const err = validateCredential('x', 'Secret Token', { minLen: 20 });
    expect(err).toContain('Secret Token');
  });
});

// ── validateGpuCredentials ────────────────────────────────────────────────────

describe('validateGpuCredentials', () => {
  it('returns null when all credentials are absent (none provided)', () => {
    expect(validateGpuCredentials({})).toBeNull();
  });

  it('returns null when all provided credentials are valid', () => {
    expect(validateGpuCredentials({
      runpodApiKey: 'rpa_' + 'a'.repeat(20),
      vastApiKey: 'a1b2c3d4e5f6a1b2c3d4',
    })).toBeNull();
  });

  it('rejects malformed RunPod key (missing rpa_ prefix)', () => {
    const err = validateGpuCredentials({ runpodApiKey: 'invalid_key_that_is_long_enough' });
    expect(err).toMatch(/RunPod/);
    expect(err).toMatch(/must start with/);
  });

  it('rejects RunPod key that is too short', () => {
    const err = validateGpuCredentials({ runpodApiKey: 'rpa_short' });
    expect(err).toMatch(/RunPod/);
    expect(err).toMatch(/too short/);
  });

  it('rejects Vast.ai key with non-hex characters', () => {
    const err = validateGpuCredentials({ vastApiKey: 'g'.repeat(20) });
    expect(err).toMatch(/Vast/);
    expect(err).toMatch(/invalid format/);
  });

  it('accepts valid Vast.ai key (hex only)', () => {
    expect(validateGpuCredentials({ vastApiKey: 'deadbeef'.repeat(3) })).toBeNull();
  });

  it('rejects TensorDock key with special characters', () => {
    const err = validateGpuCredentials({ tensordockApiKey: 'key!@#$%^&*()x'.padEnd(12, 'a') });
    expect(err).toMatch(/TensorDock API key/);
  });

  it('accepts valid TensorDock key (alphanumeric)', () => {
    expect(validateGpuCredentials({ tensordockApiKey: 'abc123xyz9876543' })).toBeNull();
  });

  it('rejects TensorDock authId that is too short', () => {
    const err = validateGpuCredentials({ tensordockAuthId: 'x' });
    expect(err).toMatch(/TensorDock Auth ID/);
    expect(err).toMatch(/too short/);
  });

  it('rejects Modal token that is too short', () => {
    const err = validateGpuCredentials({ modalTokenId: 'abc' });
    expect(err).toMatch(/Modal Token ID/);
    expect(err).toMatch(/too short/);
  });

  it('accepts valid Modal token', () => {
    expect(validateGpuCredentials({ modalTokenId: 'validtoken123' })).toBeNull();
  });

  it('reports first failing credential, not all', () => {
    // Both runpod (bad prefix) and vast (bad hex) are wrong;
    // runpod is checked first so that error wins
    const err = validateGpuCredentials({
      runpodApiKey: 'wrongprefix_long_enough_key',
      vastApiKey: 'notvalidhex'.repeat(3),
    });
    expect(err).toMatch(/RunPod/);
  });

  it('ignores credentials not provided (undefined treated as empty)', () => {
    expect(validateGpuCredentials({ runpodApiKey: undefined, vastApiKey: undefined })).toBeNull();
  });
});

// ── maskKey ───────────────────────────────────────────────────────────────────

describe('maskKey', () => {
  it('masks keys >= 8 chars: first 3 + *** + last 3', () => {
    expect(maskKey('abcdefghi')).toBe('abc***ghi');
  });

  it('exactly 8 chars — shows first 3 and last 3', () => {
    expect(maskKey('12345678')).toBe('123***678');
  });

  it('long key only exposes boundary chars', () => {
    expect(maskKey('STARTMIDDLEEND')).toBe('STA***END');
  });

  it('returns *** for keys shorter than 8 chars', () => {
    expect(maskKey('short')).toBe('***');
    expect(maskKey('1234567')).toBe('***');
  });

  it('returns *** for empty string', () => {
    expect(maskKey('')).toBe('***');
  });

  it('returns *** for 1-char string', () => {
    expect(maskKey('x')).toBe('***');
  });
});

// ── validateLang ──────────────────────────────────────────────────────────────

describe('validateLang', () => {
  it('accepts all known language codes', () => {
    const knownCodes = ['fr', 'en', 'es', 'pt', 'de', 'it', 'ja', 'zh'];
    for (const code of knownCodes) {
      expect(validateLang(code, 'en')).toBe(code);
    }
  });

  it('returns fallback for unknown code', () => {
    expect(validateLang('xx', 'en')).toBe('en');
  });

  it('returns fallback for empty string', () => {
    expect(validateLang('', 'fr')).toBe('fr');
  });

  it('is case-sensitive (uppercase rejected)', () => {
    expect(validateLang('EN', 'fr')).toBe('fr');
    expect(validateLang('FR', 'en')).toBe('en');
  });

  it('fallback itself can be any string', () => {
    expect(validateLang('unknown', 'default-lang')).toBe('default-lang');
  });
});

// ── getRouteBodyLimit ─────────────────────────────────────────────────────────

describe('getRouteBodyLimit', () => {
  it('returns 1MB for /v1/translate', () => {
    expect(getRouteBodyLimit('/v1/translate')).toBe(1 * 1024 * 1024);
  });

  it('returns 1MB for /v1/chat/completions', () => {
    expect(getRouteBodyLimit('/v1/chat/completions')).toBe(1 * 1024 * 1024);
  });

  it('returns 512KB for /v1/config/providers', () => {
    expect(getRouteBodyLimit('/v1/config/providers')).toBe(512 * 1024);
  });

  it('returns 64KB for /v1/config/api-keys', () => {
    expect(getRouteBodyLimit('/v1/config/api-keys')).toBe(64 * 1024);
  });

  it('returns 16KB for /v1/gpu/heartbeat', () => {
    expect(getRouteBodyLimit('/v1/gpu/heartbeat')).toBe(16 * 1024);
  });

  it('returns MAX_BODY_BYTES (50MB) for unknown routes', () => {
    expect(getRouteBodyLimit('/v1/speech')).toBe(MAX_BODY_BYTES);
    expect(getRouteBodyLimit('/v1/transcribe')).toBe(MAX_BODY_BYTES);
    expect(getRouteBodyLimit('/unknown/path')).toBe(MAX_BODY_BYTES);
  });

  it('is case-sensitive (wrong case falls through to default)', () => {
    expect(getRouteBodyLimit('/V1/translate')).toBe(MAX_BODY_BYTES);
    expect(getRouteBodyLimit('/v1/Translate')).toBe(MAX_BODY_BYTES);
  });

  it('exact match only — prefix match not allowed', () => {
    expect(getRouteBodyLimit('/v1/translate/extra')).toBe(MAX_BODY_BYTES);
  });

  it('all ROUTE_MAX_BYTES entries are present and return their configured value', () => {
    for (const [route, expected] of Object.entries(ROUTE_MAX_BYTES)) {
      expect(getRouteBodyLimit(route)).toBe(expected);
    }
  });
});
