import { createHmac, timingSafeEqual } from 'crypto';

export interface GpuTokenPayload {
  uid: string;    // userId
  iat: number;    // issued at (epoch seconds)
  exp: number;    // expires at (epoch seconds)
}

const TTL_SECONDS = 60;

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

  const raw = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  // Validate required claims explicitly. Without this, a token whose
  // payload was valid JSON but missing `exp` would slip past the expiry
  // check (`undefined < now` evaluates to false → never expires) and a
  // missing `uid` would propagate to downstream authz with `undefined`
  // identity. HMAC verification only proves the payload was signed by
  // someone holding the secret — it doesn't enforce shape.
  if (
    raw === null ||
    typeof raw !== 'object' ||
    typeof raw.uid !== 'string' || raw.uid.length === 0 ||
    typeof raw.iat !== 'number' || !Number.isFinite(raw.iat) ||
    typeof raw.exp !== 'number' || !Number.isFinite(raw.exp)
  ) {
    throw new Error('Invalid token payload');
  }
  const payload: GpuTokenPayload = { uid: raw.uid, iat: raw.iat, exp: raw.exp };
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }
  return payload;
}
