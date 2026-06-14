/**
 * Optimization pass 07 (wave 5) — Security, Auth & Input Validation.
 *
 * Continuation of waves 1–4 (`07-security.test.ts`, `-w2`, `-w3`, `-w4`). Covers
 * a NEW, small batch of localized, SAFE hardening primitives. As in prior waves:
 * primitives ONLY — no previously-dead middleware (RBAC / CSRF / rate-limiter /
 * DLP engine) is wired into the live server path; the GPU-token wire format is
 * UNCHANGED (sign is untouched, verify only gains the ability to try more keys);
 * the vault on-disk blob format is unchanged.
 *
 *  - #620  gpu-token: verifyGpuTokenWithSecrets — wire-compatible N-key rotation
 *          verify (no `kid` claim added; sign unchanged).
 *  - #657  input-validator: isHttpUrl — positive http/https scheme allowlist.
 *  - #674  input-validator: Schemas.BoundedBase64 — decoded-byte-size cap on
 *          base64 fields (audio blobs etc).
 *  - #682  input-validator: redactPII — redaction mode (mask PII in place so a
 *          request can proceed), Luhn-gated card matches.
 *  - #677  providers/dlp: secureDefaultDlpConfig — enabled/block secure baseline.
 *  - #605  auth-middleware: isSingleSharedKeyMode — single-shared-key advisory
 *          predicate.
 *
 * Unit-only. No network surface is touched (no fetch is invoked).
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  signGpuToken,
  verifyGpuToken,
  verifyGpuTokenWithSecrets,
} from '../../src/auth/gpu-token';
import {
  isHttpUrl,
  redactPII,
  Schemas,
  validateInput,
} from '../../src/input-validator';
import { secureDefaultDlpConfig } from '../../src/providers/dlp';
import { detectPII } from '../../src/providers/dlp';
import { isSingleSharedKeyMode } from '../../src/auth-middleware';

// A valid Luhn test card (Visa test number) and a same-length non-Luhn run.
const VALID_CARD = '4111111111111111'; // passes Luhn
const FAKE_CARD = '4111111111111112'; // brand-prefix shaped, FAILS Luhn

const SECRET_A = 'A'.repeat(40); // >= 32 chars
const SECRET_B = 'B'.repeat(40);
const SECRET_C = 'C'.repeat(40);

const ENV_KEYS = ['GPU_ACCESS_SECRET', 'GPU_ACCESS_SECRET_PREVIOUS'] as const;
function snapshotEnv() {
  const prev: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prev[k] = process.env[k];
  return prev;
}
function restoreEnv(prev: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k]!;
  }
}

// ── #620 — verifyGpuTokenWithSecrets ─────────────────────────────────────────
describe('#620 verifyGpuTokenWithSecrets (wire-compatible multi-key rotation)', () => {
  let saved: Record<string, string | undefined>;
  afterEach(() => restoreEnv(saved));

  it('accepts a token against any secret in the candidate list', () => {
    saved = snapshotEnv();
    // Sign under SECRET_B specifically.
    process.env.GPU_ACCESS_SECRET = SECRET_B;
    const token = signGpuToken('user-123');

    // SECRET_B is in the middle of the list — must still verify.
    const payload = verifyGpuTokenWithSecrets(token, [SECRET_A, SECRET_B, SECRET_C]);
    expect(payload.uid).toBe('user-123');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
  });

  it('rejects when no candidate secret matches', () => {
    saved = snapshotEnv();
    process.env.GPU_ACCESS_SECRET = SECRET_B;
    const token = signGpuToken('user-x');
    expect(() => verifyGpuTokenWithSecrets(token, [SECRET_A, SECRET_C])).toThrow(/Invalid signature/);
  });

  it('skips short/garbage candidate secrets without matching them', () => {
    saved = snapshotEnv();
    process.env.GPU_ACCESS_SECRET = SECRET_A;
    const token = signGpuToken('user-y');
    // 'short' (< 32) is ignored; SECRET_A still verifies.
    expect(verifyGpuTokenWithSecrets(token, ['short', SECRET_A]).uid).toBe('user-y');
    // A list of ONLY short secrets can never match.
    expect(() => verifyGpuTokenWithSecrets(token, ['short', 'tiny'])).toThrow(/Invalid signature/);
  });

  it('does NOT change the wire format: a token verifies under BOTH entrypoints', () => {
    saved = snapshotEnv();
    process.env.GPU_ACCESS_SECRET = SECRET_A;
    const token = signGpuToken('user-z');
    // The token signed by signGpuToken (current secret) verifies via the legacy
    // single-key path AND via the new multi-key path — same bytes, no kid claim.
    expect(verifyGpuToken(token).uid).toBe('user-z');
    expect(verifyGpuTokenWithSecrets(token, [SECRET_A]).uid).toBe('user-z');
    // Token format is still exactly `<payloadB64>.<sig>` (two dot-separated parts).
    expect(token.split('.').length).toBe(2);
  });

  it('rejects malformed tokens and validates claim shape after signature', () => {
    saved = snapshotEnv();
    process.env.GPU_ACCESS_SECRET = SECRET_A;
    expect(() => verifyGpuTokenWithSecrets('no-dot', [SECRET_A])).toThrow(/Invalid token format/);
    // A correctly-signed-but-expired token still trips the expiry check.
    const now = Math.floor(Date.now() / 1000);
    const { createHmac } = require('crypto') as typeof import('crypto');
    const stale = JSON.stringify({ uid: 'u', iat: now - 1000, exp: now - 500 });
    const b64 = Buffer.from(stale).toString('base64url');
    const sig = createHmac('sha256', SECRET_A).update(b64).digest('base64url');
    expect(() => verifyGpuTokenWithSecrets(`${b64}.${sig}`, [SECRET_A])).toThrow(/Token expired/);
  });
});

// ── #657 — isHttpUrl ─────────────────────────────────────────────────────────
describe('#657 isHttpUrl (positive scheme allowlist)', () => {
  it('accepts http and https only', () => {
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('https://example.com/path?q=1')).toBe(true);
  });

  it('rejects file/ftp/gopher/data and other schemes', () => {
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('ftp://host/x')).toBe(false);
    expect(isHttpUrl('gopher://host')).toBe(false);
    expect(isHttpUrl('data:text/plain;base64,AAAA')).toBe(false);
  });

  it('fails closed on non-strings / unparseable input', () => {
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(12345 as unknown)).toBe(false);
  });
});

// ── #674 — Schemas.BoundedBase64 ─────────────────────────────────────────────
describe('#674 Schemas.BoundedBase64 (decoded-byte cap)', () => {
  it('accepts base64 whose decoded size is within the byte cap', () => {
    // 12 base64 chars (no padding) → 9 bytes.
    const schema = Schemas.BoundedBase64(16);
    const res = validateInput('QUJDREVGR0hJ', schema); // "ABCDEFGHI" → 9 bytes
    expect(res.ok).toBe(true);
  });

  it('rejects base64 whose DECODED size exceeds the cap', () => {
    const schema = Schemas.BoundedBase64(4); // 4-byte ceiling
    // 12 chars decode to 9 bytes > 4 → reject.
    const res = validateInput('QUJDREVGR0hJ', schema);
    expect(res.ok).toBe(false);
  });

  it('rejects non-base64 charset', () => {
    const schema = Schemas.BoundedBase64(1024);
    const res = validateInput('not*valid*b64!', schema);
    expect(res.ok).toBe(false);
  });

  it('accepts url-safe base64 with and without padding', () => {
    const schema = Schemas.BoundedBase64(1024);
    expect(validateInput('a-_b', schema).ok).toBe(true);
    expect(validateInput('YQ==', schema).ok).toBe(true); // "a"
  });

  it('a real ~3MB blob is rejected by a 2MB cap (the #674 scenario)', () => {
    const schema = Schemas.BoundedBase64(2 * 1024 * 1024);
    const big = 'A'.repeat(4 * 1024 * 1024); // ~3MB decoded
    expect(validateInput(big, schema).ok).toBe(false);
  });
});

// ── #682 — redactPII ─────────────────────────────────────────────────────────
describe('#682 redactPII (redaction mode, Luhn-gated cards)', () => {
  it('masks email and SSN in place and reports the types', () => {
    const r = redactPII('contact me at jane.doe@example.com or SSN 123-45-6789');
    expect(r.found).toBe(true);
    expect(r.redacted).not.toContain('jane.doe@example.com');
    expect(r.redacted).not.toContain('123-45-6789');
    expect(r.redacted).toContain('[REDACTED]');
    expect(r.types.sort()).toContain('email');
    expect(r.types.sort()).toContain('ssn');
  });

  it('redacts a Luhn-valid card but LEAVES a non-Luhn lookalike untouched', () => {
    const valid = redactPII(`card ${VALID_CARD}`);
    expect(valid.found).toBe(true);
    expect(valid.redacted).not.toContain(VALID_CARD);
    expect(valid.types).toContain('creditCard');

    const fake = redactPII(`order ${FAKE_CARD}`);
    // Same brand-prefix shape, fails Luhn → not treated as a card.
    expect(fake.types).not.toContain('creditCard');
    expect(fake.redacted).toContain(FAKE_CARD);
  });

  it('returns the input unchanged when no PII is present', () => {
    const r = redactPII('just an ordinary sentence with no secrets');
    expect(r.found).toBe(false);
    expect(r.redacted).toBe('just an ordinary sentence with no secrets');
    expect(r.types).toEqual([]);
  });

  it('honors a custom placeholder and is repeatable (stateless regex)', () => {
    const text = 'a@b.com and c@d.com';
    const first = redactPII(text, { placeholder: '<X>' });
    const second = redactPII(text, { placeholder: '<X>' });
    expect(first.redacted).toBe(second.redacted); // no leaked regex lastIndex
    expect(first.redacted).toBe('<X> and <X>');
  });

  it('handles empty / non-string input safely', () => {
    expect(redactPII('').found).toBe(false);
    expect(redactPII(undefined as unknown as string).redacted).toBe('');
  });
});

// ── #677 — secureDefaultDlpConfig ────────────────────────────────────────────
describe('#677 secureDefaultDlpConfig (secure baseline)', () => {
  it('is enabled and blocks by default (opt-out, not opt-in)', () => {
    const cfg = secureDefaultDlpConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.action).toBe('block');
    expect(cfg.patterns.creditCard).toBe(true);
    expect(cfg.patterns.ssn).toBe(true);
    expect(cfg.patterns.email).toBe(true);
    // Noisy detectors stay off unless explicitly enabled.
    expect(cfg.patterns.phone).toBe(false);
    expect(cfg.patterns.ipAddress).toBe(false);
  });

  it('actually detects PII when fed to the live detectPII (config is wired-shaped)', () => {
    const cfg = secureDefaultDlpConfig();
    const res = detectPII('my ssn is 123-45-6789', cfg);
    expect(res.detected).toBe(true);
    expect(res.action).toBe('block');
    expect(res.types).toContain('ssn');
  });

  it('allows overriding fields without mutating the default', () => {
    const cfg = secureDefaultDlpConfig({ action: 'flag', patterns: { phone: true } });
    expect(cfg.action).toBe('flag');
    expect(cfg.patterns.phone).toBe(true);
    // unspecified secure-baseline fields are preserved
    expect(cfg.patterns.ssn).toBe(true);
    expect(cfg.enabled).toBe(true);
  });
});

// ── #605 — isSingleSharedKeyMode ─────────────────────────────────────────────
describe('#605 isSingleSharedKeyMode (single-shared-key advisory)', () => {
  it('is true for exactly one key in a Set', () => {
    expect(isSingleSharedKeyMode(new Set(['only-key']))).toBe(true);
  });

  it('is false for multiple keys', () => {
    expect(isSingleSharedKeyMode(new Set(['k1', 'k2']))).toBe(false);
  });

  it('is false for an empty set (that is a no-auth concern, not shared-key)', () => {
    expect(isSingleSharedKeyMode(new Set())).toBe(false);
  });

  it('is false for a function validator (opaque — cannot assert single key)', () => {
    expect(isSingleSharedKeyMode((k: string) => k === 'x')).toBe(false);
  });
});
