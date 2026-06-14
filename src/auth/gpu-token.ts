import { createHmac, timingSafeEqual } from 'crypto';

export interface GpuTokenPayload {
  uid: string;    // userId
  iat: number;    // issued at (epoch seconds)
  exp: number;    // expires at (epoch seconds)
}

const TTL_SECONDS = 60;

/**
 * Small tolerance (seconds) applied to the `exp` check so a pod whose clock
 * runs a few seconds ahead of the issuer does not reject otherwise-fresh
 * tokens. Kept tiny — it widens the replay window by at most this much, and
 * NTP drift between cooperating hosts is normally sub-second. Documented as a
 * deliberate trade-off; operators who need zero skew can run strict NTP.
 */
const CLOCK_SKEW_SECONDS = 5;

function getSecret(): string {
  const secret = process.env.GPU_ACCESS_SECRET;
  if (!secret) throw new Error('GPU_ACCESS_SECRET not set');
  if (secret.length < 32) throw new Error('GPU_ACCESS_SECRET must be at least 32 characters');
  return secret;
}

export function signGpuToken(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: GpuTokenPayload = { uid: userId, iat: now, exp: now + TTL_SECONDS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

export function verifyGpuToken(token: string): GpuTokenPayload {
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) throw new Error('Invalid token format');

  const expectedSig = createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid signature');
  }

  // A valid HMAC only proves the bytes were signed by a secret holder — it
  // does not prove the payload is well-formed JSON. base64url that decodes to
  // non-JSON would otherwise throw a raw `SyntaxError` here, leaking the
  // implementation detail and bypassing the intended "Invalid token payload"
  // error. Normalize it.
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  } catch {
    throw new Error('Invalid token payload');
  }
  // Validate required claims explicitly. Without this, a token whose
  // payload was valid JSON but missing `exp` would slip past the expiry
  // check (`undefined < now` evaluates to false → never expires) and a
  // missing `uid` would propagate to downstream authz with `undefined`
  // identity. HMAC verification only proves the payload was signed by
  // someone holding the secret — it doesn't enforce shape.
  const claims = raw as Record<string, unknown>;
  if (
    claims === null ||
    typeof claims !== 'object' ||
    typeof claims.uid !== 'string' || claims.uid.length === 0 ||
    typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) ||
    typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)
  ) {
    throw new Error('Invalid token payload');
  }
  const payload: GpuTokenPayload = { uid: claims.uid, iat: claims.iat, exp: claims.exp };
  // Allow a small clock-skew grace so a pod a few seconds ahead of the issuer
  // doesn't reject a token that is in fact still within its TTL.
  if (payload.exp < Math.floor(Date.now() / 1000) - CLOCK_SKEW_SECONDS) {
    throw new Error('Token expired');
  }
  return payload;
}

/**
 * Decode the token payload WITHOUT verifying the HMAC signature.
 *
 * Intended only for logging/diagnostics (e.g. "which uid issued this expired
 * token"). It performs NO authentication — never gate access on its result.
 *
 * SECURITY NOTE (#625): the `uid` in a GPU token is plain base64url, readable
 * by anyone holding the token. That is acceptable for an HMAC-signed token (the
 * signature provides integrity, not confidentiality) — but it means callers
 * MUST NOT place PII or other secrets in `userId`. This helper makes that
 * readability explicit.
 *
 * @returns the decoded claims, or null if the payload isn't well-formed.
 */
export function readGpuTokenClaimsUnverified(token: string): GpuTokenPayload | null {
  const payloadB64 = token.split('.')[0];
  if (!payloadB64) return null;
  try {
    const raw = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as Record<string, unknown>;
    if (
      raw === null ||
      typeof raw !== 'object' ||
      typeof raw.uid !== 'string' ||
      typeof raw.iat !== 'number' ||
      typeof raw.exp !== 'number'
    ) {
      return null;
    }
    return { uid: raw.uid, iat: raw.iat, exp: raw.exp };
  } catch {
    return null;
  }
}
