/**
 * No-wake mode: a request that must never start (or keep starting) a rented machine.
 *
 * Found 2026-10-07: one STT request to the app route `parle-stt` woke a €1.47/h L40S, because that route's primary is
 * `deployment:parle-speech` and a cold primary is woken "for the next turns". A caller that only wants an answer now
 * (a test, a probe, a dev box, a batch job) can opt out:
 *
 *   - per request: header `X-Gateway-No-Wake: 1` (also `true`/`yes`);
 *   - per key user: `GATEWAY_NO_WAKE_USERS=user1,user2` (the user names of `API_KEYS="key:user"`), read per request.
 *
 * In that mode a deployment target with no ready replica (cold, stopped, booting, absent) is skipped with code `cold`
 * (neutral: no circuit, no cooldown) and the route falls to its cloud fallback; `/v1/s2s` goes composed; `invoke`
 * answers 503 cold. Nothing is woken and the deployment's idle clock is not touched. A replica that is already ready
 * is still used (it bills anyway; the request just does not keep a cold one coming).
 *
 * The flag lives in an AsyncLocalStorage frame the proxy server opens per request (`withNoWakeScope`), so deep code
 * (deployment providers, the s2s route, the loopback stage client) reads it without threading a parameter.
 */
import { AsyncLocalStorage } from 'async_hooks';

export const NO_WAKE_HEADER = 'x-gateway-no-wake';

interface NoWakeScope { noWake: boolean }

const als = new AsyncLocalStorage<NoWakeScope>();
let skips = 0;

/** Runs `fn` in a fresh per-request scope (no-wake off until `markNoWake`). */
export function withNoWakeScope<T>(fn: () => T): T {
  return als.run({ noWake: false }, fn);
}

/** Runs `fn` with no-wake on (tests, in-process callers outside the proxy server). */
export function runNoWake<T>(fn: () => T): T {
  return als.run({ noWake: true }, fn);
}

/** Turns no-wake on for the rest of the current request. No-op outside a scope. */
export function markNoWake(): void {
  const scope = als.getStore();
  if (scope) scope.noWake = true;
}

export function noWakeActive(): boolean {
  return als.getStore()?.noWake === true;
}

export function headerAsksNoWake(value: string | string[] | undefined): boolean {
  const v = (Array.isArray(value) ? value[0] : value)?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** `GATEWAY_NO_WAKE_USERS` (comma list of key users). */
export function noWakeUsers(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set((env.GATEWAY_NO_WAKE_USERS ?? '').split(',').map(u => u.trim()).filter(Boolean));
}

/** Whether a request (its header and its resolved key user) runs in no-wake mode. */
export function requestIsNoWake(header: string | string[] | undefined, userId: string, env: Record<string, string | undefined> = process.env): boolean {
  return headerAsksNoWake(header) || noWakeUsers(env).has(userId);
}

/** Counts one deployment target skipped (or one invoke refused) because of no-wake. */
export function recordNoWakeSkip(): void {
  skips++;
}

/** For `/health`. */
export function noWakeStats(): { skips: number } {
  return { skips };
}

/** Tests only. */
export function _resetNoWakeStats(): void {
  skips = 0;
}
