/**
 * Bug: verifyGpuToken() does not validate that the decoded payload has
 * an `exp` field. The check `payload.exp < Math.floor(Date.now() / 1000)`
 * silently passes when `payload.exp` is undefined (NaN/undefined < number
 * is false), so a token whose payload is valid JSON but missing the
 * `exp` claim is accepted as eternal — bypassing expiry entirely.
 *
 * This matters when the signing path drifts (e.g. an old version that
 * didn't include exp, or a different code path that hand-crafts the
 * payload but forgets exp). HMAC alone doesn't catch a forgotten
 * required claim.
 *
 * Fix: assert payload shape (uid, iat, exp present and numeric).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { verifyGpuToken } from '../../src/auth/gpu-token';

describe('verifyGpuToken — strict payload shape', () => {
  const SECRET = 'a'.repeat(64);
  const prevSecret = process.env.GPU_ACCESS_SECRET;
  beforeEach(() => { process.env.GPU_ACCESS_SECRET = SECRET; });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.GPU_ACCESS_SECRET;
    else process.env.GPU_ACCESS_SECRET = prevSecret;
  });

  function makeToken(payload: object): string {
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
    return `${payloadB64}.${sig}`;
  }

  it('rejects tokens missing the exp field', () => {
    // Valid HMAC, but no exp claim — would silently bypass expiry.
    const t = makeToken({ uid: 'user1', iat: Math.floor(Date.now() / 1000) });
    expect(() => verifyGpuToken(t)).toThrow();
  });

  it('rejects tokens missing the uid field', () => {
    const now = Math.floor(Date.now() / 1000);
    const t = makeToken({ iat: now, exp: now + 60 });
    expect(() => verifyGpuToken(t)).toThrow();
  });

  it('still accepts well-formed valid tokens', () => {
    const now = Math.floor(Date.now() / 1000);
    const t = makeToken({ uid: 'user1', iat: now, exp: now + 60 });
    const payload = verifyGpuToken(t);
    expect(payload.uid).toBe('user1');
  });

  it('rejects tokens whose TTL window exceeds the advertised 60s lifetime', () => {
    const now = Math.floor(Date.now() / 1000);
    // Validly signed, not yet expired, but exp is 10 years out — must be rejected
    // so the 60s TTL guarantee holds even against a forged-long exp.
    const t = makeToken({ uid: 'user1', iat: now, exp: now + 10 * 365 * 24 * 3600 });
    expect(() => verifyGpuToken(t)).toThrow(/TTL/i);
  });

  it('rejects tokens issued far in the future', () => {
    const now = Math.floor(Date.now() / 1000);
    const future = now + 3600;
    const t = makeToken({ uid: 'user1', iat: future, exp: future + 60 });
    expect(() => verifyGpuToken(t)).toThrow(/future/i);
  });
});
