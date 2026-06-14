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

/**
 * Optional PREVIOUS signing secret, used only on the VERIFY path during a
 * secret rotation (#619).
 *
 * Rotating `GPU_ACCESS_SECRET` instantly invalidates every token already issued
 * under the old secret — any in-flight request signed seconds before the swap is
 * rejected. Supplying `GPU_ACCESS_SECRET_PREVIOUS` lets `verifyGpuToken` accept
 * tokens signed by EITHER the current or the previous secret for the overlap
 * window, then the operator drops the previous value once the 60s TTL has fully
 * cycled.
 *
 * IMPORTANT: this changes nothing on the wire — `signGpuToken` always signs with
 * the CURRENT secret, and the token format is byte-identical. Only verification
 * gains a second acceptable key. Returns null when unset or too short to be a
 * real secret (a short/garbage value is ignored rather than weakening verify).
 */
function getPreviousSecret(): string | null {
  const secret = process.env.GPU_ACCESS_SECRET_PREVIOUS;
  if (!secret || secret.length < 32) return null;
  return secret;
}

/** Constant-time HMAC comparison against one secret. */
function sigMatches(payloadB64: string, sig: string, secret: string): boolean {
  const expectedSig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(sigBuf, expectedBuf);
}

export function signGpuToken(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: GpuTokenPayload = { uid: userId, iat: now, exp: now + TTL_SECONDS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/**
 * Parse + validate the claims of a token whose signature has ALREADY been
 * verified. Shared by `verifyGpuToken` and `verifyGpuTokenWithSecrets` so the
 * payload-shape / expiry rules stay identical no matter which verify entrypoint
 * accepted the signature. Throws the same normalized errors as before.
 */
function decodeVerifiedPayload(payloadB64: string): GpuTokenPayload {
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
 * Verify a token against an EXPLICIT list of candidate secrets (#620).
 *
 * `verifyGpuToken` accepts the current secret (+ optionally one previous one via
 * `GPU_ACCESS_SECRET_PREVIOUS`). A rotation that must overlap MORE than two
 * secrets — e.g. several pods mid-rollout, or a staged multi-key migration —
 * needs to verify against an arbitrary set. This is the wire-compatible
 * generalization: `signGpuToken` is UNCHANGED (still no `kid` claim, byte-
 * identical tokens), only verification gains the ability to try N keys.
 *
 * All candidate comparisons use the same constant-time `sigMatches`, and EVERY
 * candidate is evaluated (no early return on first match) so acceptance timing
 * doesn't reveal which key — or how many keys — matched. Short/garbage secrets
 * (< 32 chars) are skipped. Throws the same errors as `verifyGpuToken`.
 *
 * NOTE: a per-token `kid` claim (the full #620 design) is intentionally NOT
 * added here because it would change the on-the-wire token format; this helper
 * is the safe subset that needs no format change.
 */
export function verifyGpuTokenWithSecrets(token: string, secrets: readonly string[]): GpuTokenPayload {
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) throw new Error('Invalid token format');

  let matched = false;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 32) continue;
    // Evaluate every candidate (bitwise-OR accumulate) — do NOT short-circuit,
    // so the number of HMAC computations is independent of which/how-many match.
    matched = sigMatches(payloadB64, sig, secret) || matched;
  }
  if (!matched) throw new Error('Invalid signature');

  return decodeVerifiedPayload(payloadB64);
}

export function verifyGpuToken(token: string): GpuTokenPayload {
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) throw new Error('Invalid token format');

  // Accept the CURRENT secret, or (during rotation) the PREVIOUS one. Both
  // comparisons run constant-time; we always evaluate the previous-secret branch
  // when it is configured so acceptance timing doesn't reveal which key matched.
  const previous = getPreviousSecret();
  const matchesCurrent = sigMatches(payloadB64, sig, getSecret());
  const matchesPrevious = previous !== null && sigMatches(payloadB64, sig, previous);
  if (!matchesCurrent && !matchesPrevious) {
    throw new Error('Invalid signature');
  }

  // Signature verified — decode + validate claims (shape, required fields,
  // expiry) via the shared helper so both verify entrypoints behave identically.
  return decodeVerifiedPayload(payloadB64);
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
