// ── AI Gateway — ucast.me accounts: password hashing ────────────────────────
// argon2id through Bun.password (the gateway runs on Bun). Under Node (the vitest runner) Bun is absent: scrypt from
// node:crypto stands in, with its own `$scrypt$` prefix so a hash always verifies with the algorithm that made it.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

interface BunPassword {
  hash(password: string, opts: { algorithm: 'argon2id'; memoryCost?: number; timeCost?: number }): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

function bunPassword(): BunPassword | null {
  const bun = (globalThis as { Bun?: { password?: BunPassword } }).Bun;
  return bun?.password ?? null;
}

const scrypt = (password: string, salt: Buffer, len: number) => new Promise<Buffer>((resolve, reject) => {
  scryptCb(password, salt, len, { N: 16_384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)));
});

export async function hashPassword(password: string): Promise<string> {
  const bun = bunPassword();
  // OWASP argon2id baseline: 19 MiB, 2 iterations.
  if (bun) return bun.hash(password, { algorithm: 'argon2id', memoryCost: 19_456, timeCost: 2 });
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32);
  return `$scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (hash.startsWith('$scrypt$')) {
    const [, , salt, key] = hash.split('$');
    if (!salt || !key) return false;
    const want = Buffer.from(key, 'base64');
    const got = await scrypt(password, Buffer.from(salt, 'base64'), want.length);
    return got.length === want.length && timingSafeEqual(got, want);
  }
  const bun = bunPassword();
  if (!bun) return false;
  try { return await bun.verify(password, hash); } catch { return false; }
}

let dummy: Promise<string> | null = null;
/** A hash to verify against when the e-mail is unknown, so a login takes the same time either way. */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(18).toString('base64'));
  return dummy;
}

/** null when acceptable, else the reason (pt-BR). */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'Informe uma senha.';
  if (password.length < PASSWORD_MIN) return `A senha precisa ter pelo menos ${PASSWORD_MIN} caracteres.`;
  if (password.length > PASSWORD_MAX) return `A senha pode ter no máximo ${PASSWORD_MAX} caracteres.`;
  return null;
}
