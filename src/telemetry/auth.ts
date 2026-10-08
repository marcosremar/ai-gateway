/**
 * Who may write telemetry (`POST /v1/telemetry/events`) — three credentials, checked by the route itself (the proxy's
 * key check would refuse the browser and the edge):
 *
 *   (a) app key   `Authorization: Bearer <GATEWAY_API_KEYS key>` — server to server (e.g. the parle backend). Refused
 *                 when the request comes from a browser (`Origin` / `Sec-Fetch-*` present) and for the SANDBOX_TOKEN
 *                 family: a master key must never sit in a page.
 *   (b) session   `Authorization: Bearer <realtime session JWT>` (or `token` in the body, for `navigator.sendBeacon`
 *                 which cannot set headers). HS256 with key = HMAC-SHA256(deployment replicaToken, "aigw-rt-v1"), the
 *                 realtime contract (docs/realtime.md). `sid`/`app`/`dep`/`rep` come from the token, never the body.
 *                 Accepted up to `sessionGraceSeconds` (default 120) after `exp`, so the last batch of a session —
 *                 often flushed on `pagehide` — still lands.
 *   (c) edge      `Authorization: Bearer <hex HMAC-SHA256(replicaToken, "aigw-telemetry-v1")>` + `X-Aigw-Replica:
 *                 <replicaId>`. The gateway looks the replica up, verifies with its deployment's token and stamps
 *                 `deployment` / `replicaId` itself.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { TELEMETRY_EDGE_HMAC_INFO } from './contract';

/** Realtime session key info (must equal src/realtime/token.ts RT_KEY_INFO). */
export const RT_SESSION_KEY_INFO = 'aigw-rt-v1';

export type TelemetryPrincipal =
  | { kind: 'app'; app: string }
  | { kind: 'session'; app: string; sessionId: string; deployment: string; replicaId: string }
  | { kind: 'edge'; deployment: string; replicaId: string; app?: string };

export interface AuthFailure {
  status: 401 | 403;
  code: 'missing_credentials' | 'invalid_key' | 'browser_app_key' | 'master_key' | 'bad_session_token' | 'session_expired'
    | 'unknown_deployment' | 'unknown_replica' | 'bad_edge_signature';
  error: string;
}

export interface TelemetryAuthDeps {
  /** App key → app (user id of GATEWAY_API_KEYS `key:user`), or null. */
  resolveAppKey(token: string): string | null;
  /** SANDBOX_TOKEN and its aliases: never accepted here, even when they are also client keys. */
  isMasterKey?(token: string): boolean;
  /** Deployment → its replica token (and owning app). */
  deployment(name: string): { replicaToken: string; app?: string } | null;
  /** Replica id → its deployment, the deployment's replica token and owning app. */
  replica(replicaId: string): { deployment: string; replicaToken: string; app?: string } | null;
  /**
   * Optional realtime verifier (e.g. an adapter over `RealtimeService.resolveToken`, injected so this module never
   * imports realtime code). Claims it returns are trusted; `null` falls back to the built-in HS256 check below, so a
   * session whose replica is already gone can still flush its last events. The adapter must not require liveness.
   */
  resolveSessionToken?(token: string): { sid: string; app: string; dep: string; rep: string } | null;
  now?: () => number;
  sessionGraceSeconds?: number;
}

export interface TelemetryAuthInput {
  authorization?: string;
  replica?: string;
  origin?: string;
  secFetchSite?: string;
  /** `token` field of the body (beacon). */
  bodyToken?: string;
}

const fail = (status: AuthFailure['status'], code: AuthFailure['code'], error: string): AuthFailure => ({ status, code, error });

export function edgeTelemetrySignature(replicaToken: string): string {
  return createHmac('sha256', replicaToken).update(TELEMETRY_EDGE_HMAC_INFO).digest('hex');
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const isJwt = (t: string) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t);

function decodePart(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

interface SessionClaims { sid: string; app: string; dep: string; rep: string; iat: number; exp: number }

function claimsOf(payload: Record<string, unknown> | null): SessionClaims | null {
  if (!payload) return null;
  const s = (k: string) => typeof payload[k] === 'string' && (payload[k] as string).length > 0 && (payload[k] as string).length <= 128;
  if (!s('sid') || !s('app') || !s('dep') || !s('rep') || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return null;
  return payload as unknown as SessionClaims;
}

/** Verifies a realtime session token (contract of src/realtime/token.ts) and returns the session principal. */
export function verifySessionPrincipal(token: string, deps: TelemetryAuthDeps): TelemetryPrincipal | AuthFailure {
  let injected: ReturnType<NonNullable<TelemetryAuthDeps['resolveSessionToken']>> = null;
  try { injected = deps.resolveSessionToken?.(token) ?? null; } catch { injected = null; }
  if (injected) return { kind: 'session', app: injected.app, sessionId: injected.sid, deployment: injected.dep, replicaId: injected.rep };
  const [h, p, s] = token.split('.') as [string, string, string];
  const header = decodePart(h);
  const claims = claimsOf(decodePart(p));
  if (!header || header.alg !== 'HS256' || !claims) return fail(401, 'bad_session_token', 'Malformed realtime session token');
  const dep = deps.deployment(claims.dep);
  if (!dep) return fail(401, 'unknown_deployment', 'Session token names an unknown deployment');
  const key = createHmac('sha256', dep.replicaToken).update(RT_SESSION_KEY_INFO).digest();
  const expected = createHmac('sha256', key).update(`${h}.${p}`).digest();
  if (!sameBytes(Buffer.from(s, 'base64url'), expected)) return fail(401, 'bad_session_token', 'Invalid realtime session token');
  const nowS = Math.floor((deps.now ?? Date.now)() / 1000);
  if (claims.iat > nowS + 60) return fail(401, 'bad_session_token', 'Session token not yet valid');
  if (claims.exp + (deps.sessionGraceSeconds ?? 120) <= nowS) return fail(401, 'session_expired', 'Realtime session token expired');
  return { kind: 'session', app: claims.app, sessionId: claims.sid, deployment: claims.dep, replicaId: claims.rep };
}

function verifyEdge(replicaId: string, signature: string, deps: TelemetryAuthDeps): TelemetryPrincipal | AuthFailure {
  const replica = deps.replica(replicaId);
  if (!replica) return fail(401, 'unknown_replica', 'Unknown replica');
  const given = /^[0-9a-f]{64}$/i.test(signature) ? Buffer.from(signature.toLowerCase(), 'hex') : Buffer.alloc(0);
  if (!sameBytes(given, Buffer.from(edgeTelemetrySignature(replica.replicaToken), 'hex'))) {
    return fail(401, 'bad_edge_signature', 'Invalid edge telemetry signature');
  }
  return { kind: 'edge', deployment: replica.deployment, replicaId, ...(replica.app ? { app: replica.app } : {}) };
}

export function authenticateTelemetry(input: TelemetryAuthInput, deps: TelemetryAuthDeps): TelemetryPrincipal | AuthFailure {
  const bearer = (input.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  const replica = input.replica?.trim();
  if (replica) return verifyEdge(replica, bearer, deps);
  const sessionToken = bearer && isJwt(bearer) ? bearer : !bearer && input.bodyToken && isJwt(input.bodyToken) ? input.bodyToken : null;
  if (sessionToken) return verifySessionPrincipal(sessionToken, deps);
  if (!bearer) return fail(401, 'missing_credentials', 'Telemetry needs an app key, a realtime session token or an edge signature');
  if (deps.isMasterKey?.(bearer)) return fail(403, 'master_key', 'The master token is not accepted for telemetry');
  if (input.origin || input.secFetchSite) {
    return fail(403, 'browser_app_key', 'App keys are server-to-server only; a browser sends its realtime session token');
  }
  const app = deps.resolveAppKey(bearer);
  if (!app) return fail(401, 'invalid_key', 'Invalid API key');
  return { kind: 'app', app };
}

export function isAuthFailure(v: TelemetryPrincipal | AuthFailure): v is AuthFailure {
  return 'status' in v;
}
