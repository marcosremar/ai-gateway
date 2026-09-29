/**
 * Unit tests for src/auth/gpu-token.ts.
 *
 * Covers: signGpuToken, verifyGpuToken — HMAC-SHA256 signing,
 * TTL enforcement (60s), clock-skew tolerance (30s), timing-safe
 * comparison, and payload shape validation.
 *
 * Uses vi.setSystemTime to control clock without real delays.
 * Module is imported statically since getSecret() reads process.env
 * at call time (not module load time), so env changes apply immediately.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import { signGpuToken, verifyGpuToken } from '../src/auth/gpu-token';

// ── helpers ───────────────────────────────────────────────────────────────────

const VALID_SECRET = 'supersecretkey1234567890abcdef12'; // 32+ chars
const ALT_SECRET   = 'differentsecretkey1234567890zzzz';

function setSecret(val: string | undefined) {
  if (val === undefined) delete process.env.GPU_ACCESS_SECRET;
  else process.env.GPU_ACCESS_SECRET = val;
}

/** Build a signed token with an arbitrary payload using the current env secret. */
function craftToken(payload: object): string {
  const secret = process.env.GPU_ACCESS_SECRET!;
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

// ── signGpuToken ──────────────────────────────────────────────────────────────

describe('signGpuToken', () => {
  beforeEach(() => {
    setSecret(VALID_SECRET);
    vi.useFakeTimers();
  });

  afterEach(() => {
    setSecret(undefined);
    vi.useRealTimers();
  });

  it('returns a two-part base64url-encoded token', () => {
    const token = signGpuToken('user-1');
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('payload encodes uid, iat, and exp', () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);
    const token = signGpuToken('alice');
    const [payloadB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    expect(payload.uid).toBe('alice');
    expect(payload.iat).toBe(now);
    expect(payload.exp).toBe(now + 60);
  });

  it('signature is an HMAC-SHA256 of the payload under the secret', () => {
    vi.setSystemTime(1700000000000);
    const token = signGpuToken('bob');
    const [payloadB64, sig] = token.split('.');
    const expected = createHmac('sha256', VALID_SECRET).update(payloadB64).digest('base64url');
    expect(sig).toBe(expected);
  });

  it('throws when GPU_ACCESS_SECRET is not set', () => {
    setSecret(undefined);
    expect(() => signGpuToken('x')).toThrow('GPU_ACCESS_SECRET not set');
  });

  it('throws when GPU_ACCESS_SECRET is shorter than 32 characters', () => {
    setSecret('tooshort');
    expect(() => signGpuToken('x')).toThrow('at least 32 characters');
  });

  it('produces different tokens for different userIds', () => {
    vi.setSystemTime(1700000000000);
    expect(signGpuToken('alice')).not.toBe(signGpuToken('bob'));
  });

  it('produces different tokens for the same user at different times', () => {
    vi.setSystemTime(1700000000000);
    const t1 = signGpuToken('same-user');
    vi.setSystemTime(1700000001000);
    const t2 = signGpuToken('same-user');
    expect(t1).not.toBe(t2);
  });
});

// ── verifyGpuToken ────────────────────────────────────────────────────────────

describe('verifyGpuToken', () => {
  beforeEach(() => {
    setSecret(VALID_SECRET);
    vi.useFakeTimers();
  });

  afterEach(() => {
    setSecret(undefined);
    vi.useRealTimers();
  });

  it('round-trips: sign then verify returns the original payload', () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);
    const token = signGpuToken('carol');
    const payload = verifyGpuToken(token);
    expect(payload.uid).toBe('carol');
    expect(payload.iat).toBe(now);
    expect(payload.exp).toBe(now + 60);
  });

  it('accepts a token verified within the 60s TTL', () => {
    const mintAt = 1700000000000;
    vi.setSystemTime(mintAt);
    const token = signGpuToken('dave');
    vi.setSystemTime(mintAt + 59_000);
    expect(() => verifyGpuToken(token)).not.toThrow();
  });

  it('rejects an expired token (past exp)', () => {
    const mintAt = 1700000000000;
    vi.setSystemTime(mintAt);
    const token = signGpuToken('eve');
    vi.setSystemTime(mintAt + 61_000);
    expect(() => verifyGpuToken(token)).toThrow('expired');
  });

  it('rejects a token with a tampered signature', () => {
    vi.setSystemTime(1700000000000);
    const token = signGpuToken('frank');
    const [payload] = token.split('.');
    expect(() => verifyGpuToken(`${payload}.invalidsig`)).toThrow(/Invalid signature|Invalid token format/);
  });

  it('rejects a token with a tampered payload (but original sig)', () => {
    vi.setSystemTime(1700000000000);
    const token = signGpuToken('grace');
    const [, sig] = token.split('.');
    const fakePayload = Buffer.from(
      JSON.stringify({ uid: 'hacker', iat: 1700000000, exp: 9999999999 }),
    ).toString('base64url');
    expect(() => verifyGpuToken(`${fakePayload}.${sig}`)).toThrow('Invalid signature');
  });

  it('rejects a token missing the signature part (no dot)', () => {
    const payloadOnly = Buffer.from(
      JSON.stringify({ uid: 'x', iat: 1700000000, exp: 1700000060 }),
    ).toString('base64url');
    expect(() => verifyGpuToken(payloadOnly)).toThrow('Invalid token format');
  });

  it('rejects an empty string', () => {
    expect(() => verifyGpuToken('')).toThrow('Invalid token format');
  });

  it('rejects a token whose payload is not valid JSON', () => {
    vi.setSystemTime(1700000000000);
    const badPayload = Buffer.from('this is not json').toString('base64url');
    const sig = createHmac('sha256', VALID_SECRET).update(badPayload).digest('base64url');
    expect(() => verifyGpuToken(`${badPayload}.${sig}`)).toThrow();
  });

  it('rejects a token payload missing uid', () => {
    vi.setSystemTime(1700000000000);
    const token = craftToken({ iat: 1700000000, exp: 1700000060 });
    expect(() => verifyGpuToken(token)).toThrow('Invalid token payload');
  });

  it('rejects a token payload with empty uid string', () => {
    vi.setSystemTime(1700000000000);
    const token = craftToken({ uid: '', iat: 1700000000, exp: 1700000060 });
    expect(() => verifyGpuToken(token)).toThrow('Invalid token payload');
  });

  it('rejects a token payload missing iat', () => {
    vi.setSystemTime(1700000000000);
    const token = craftToken({ uid: 'x', exp: 1700000060 });
    expect(() => verifyGpuToken(token)).toThrow('Invalid token payload');
  });

  it('rejects a token payload missing exp', () => {
    vi.setSystemTime(1700000000000);
    const token = craftToken({ uid: 'x', iat: 1700000000 });
    expect(() => verifyGpuToken(token)).toThrow('Invalid token payload');
  });

  it('rejects a token where iat is beyond the 30s clock-skew tolerance', () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);
    // iat 100s in the future — exceeds 30s skew
    const token = craftToken({ uid: 'x', iat: now + 100, exp: now + 160 });
    expect(() => verifyGpuToken(token)).toThrow('issued in the future');
  });

  it('accepts a token with iat within the 30s clock-skew tolerance', () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);
    // iat 20s in the future — within skew
    const token = craftToken({ uid: 'skewuser', iat: now + 20, exp: now + 80 });
    expect(() => verifyGpuToken(token)).not.toThrow();
  });

  it('rejects a token whose exp-iat window exceeds max TTL (60s + 30s skew)', () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);
    // exp - iat = 200 > 90
    const token = craftToken({ uid: 'x', iat: now, exp: now + 200 });
    expect(() => verifyGpuToken(token)).toThrow('TTL exceeds maximum');
  });

  it('rejects a token signed with a different secret', () => {
    vi.setSystemTime(1700000000000);
    // Craft a token with the alternate secret
    const origSecret = VALID_SECRET;
    setSecret(ALT_SECRET);
    const token = signGpuToken('harry');
    // Verify with the original (different) secret
    setSecret(origSecret);
    expect(() => verifyGpuToken(token)).toThrow('Invalid signature');
  });

  it('throws when GPU_ACCESS_SECRET is not set during verification', () => {
    setSecret(undefined);
    expect(() => verifyGpuToken('payload.sig')).toThrow('GPU_ACCESS_SECRET not set');
  });
});
