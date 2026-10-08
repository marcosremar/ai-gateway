/**
 * Realtime session tokens (docs/realtime.md § Token) — the one credential a browser holds for a realtime session.
 *
 * JWT HS256. The key is per deployment and never leaves the gateway or the replica:
 *
 *     key = HMAC-SHA256(key = <deployment replicaToken>, message = "aigw-rt-v1")   (32 raw bytes)
 *
 * The replica derives the same key from its token file (the `X-Aigw-Token` its nginx gate checks), so it verifies a
 * token without calling the gateway. Claims: `sid` (session id), `app`, `dep` (deployment), `rep` (replica id), `cfg`
 * (base64url of the session config JSON, ≤ 6 KB), `iat`, `exp` (seconds, `exp - iat` ≤ 15 min).
 *
 * The token is signed, not encrypted: the browser can read `cfg` (system prompt, history). Nothing secret goes there.
 * Test vectors shared with the edge implementation: docs/realtime-token-vectors.json.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';

export const RT_KEY_INFO = 'aigw-rt-v1';
/** Longest session a token may cover (contract: exp ≤ 15 min). */
export const RT_MAX_TTL_SECONDS = 900;
/** Largest `cfg` claim (base64url characters). Longer history goes in `config_update` once connected. */
export const RT_MAX_CFG_CHARS = 6 * 1024;
export const RT_MAX_CFG_REF_CHARS = 32 * 1024;
/** Tolerated clock skew between the gateway and a replica for `iat`. */
const IAT_SKEW_SECONDS = 60;

export interface RealtimeClaims {
  sid: string;
  app: string;
  dep: string;
  rep: string;
  cfg: string;
  iat: number;
  exp: number;
  cfd?: string;
}

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

export function b64url(data: Uint8Array | string): string {
  return Buffer.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64url');
}

function fromB64url(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  return Buffer.from(text, 'base64url');
}

/** The per-deployment signing key (32 bytes), derived from the replica token. */
export function deriveRealtimeKey(replicaToken: string): Buffer {
  return createHmac('sha256', replicaToken).update(RT_KEY_INFO).digest();
}

export function encodeSessionConfig(config: Record<string, unknown>): string {
  return b64url(JSON.stringify(config));
}

export function configDigest(cfg: string): string {
  return createHash('sha256').update(cfg).digest('base64url');
}

export function decodeSessionConfig(cfg: string): Record<string, unknown> | null {
  const raw = fromB64url(cfg);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function sign(input: string, key: Uint8Array): Buffer {
  return createHmac('sha256', key).update(input).digest();
}

/** Claims serialized in a fixed order (sid, app, dep, rep, cfg, iat, exp) so the vectors are byte-exact. */
export function signSessionToken(claims: RealtimeClaims, key: Uint8Array): string {
  const ordered = { sid: claims.sid, app: claims.app, dep: claims.dep, rep: claims.rep, cfg: claims.cfg, iat: claims.iat, exp: claims.exp, ...(claims.cfd ? { cfd: claims.cfd } : {}) };
  const input = `${b64url(JSON.stringify(HEADER))}.${b64url(JSON.stringify(ordered))}`;
  return `${input}.${sign(input, key).toString('base64url')}`;
}

function claimsOf(value: unknown): RealtimeClaims | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  const str = (k: string) => typeof c[k] === 'string' && (c[k] as string).length > 0;
  if (!str('sid') || !str('app') || !str('dep') || !str('rep') || typeof c.cfg !== 'string') return null;
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return null;
  if (c.cfd !== undefined && typeof c.cfd !== 'string') return null;
  return c as unknown as RealtimeClaims;
}

/**
 * The claims WITHOUT checking the signature — only to learn which deployment's key verifies the token. Never trust
 * the result for anything else.
 */
export function peekClaims(token: string): RealtimeClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = fromB64url(parts[1]!);
  if (!payload) return null;
  try { return claimsOf(JSON.parse(payload.toString('utf8'))); } catch { return null; }
}

export type VerifyFailure = 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid' | 'ttl_too_long' | 'cfg_too_large';

/** Verified claims, or why not. `nowSeconds` = unix seconds. */
export function verifySessionToken(token: string, key: Uint8Array, nowSeconds: number): { claims: RealtimeClaims } | { error: VerifyFailure } {
  const parts = token.split('.');
  if (parts.length !== 3) return { error: 'malformed' };
  const [h, p, s] = parts as [string, string, string];
  const header = fromB64url(h);
  const signature = fromB64url(s);
  if (!header || !signature) return { error: 'malformed' };
  try {
    const parsed = JSON.parse(header.toString('utf8')) as { alg?: unknown; typ?: unknown };
    if (parsed.alg !== 'HS256') return { error: 'malformed' };
  } catch { return { error: 'malformed' }; }
  const expected = sign(`${h}.${p}`, key);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return { error: 'bad_signature' };
  const claims = peekClaims(token);
  if (!claims) return { error: 'malformed' };
  if (claims.cfg.length > RT_MAX_CFG_CHARS) return { error: 'cfg_too_large' };
  if (claims.exp - claims.iat > RT_MAX_TTL_SECONDS) return { error: 'ttl_too_long' };
  if (claims.iat > nowSeconds + IAT_SKEW_SECONDS) return { error: 'not_yet_valid' };
  if (claims.exp <= nowSeconds) return { error: 'expired' };
  return { claims };
}
