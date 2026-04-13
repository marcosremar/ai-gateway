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

  const payload: GpuTokenPayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }
  return payload;
}
