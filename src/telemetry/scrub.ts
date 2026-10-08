/**
 * Privacy scrubber for telemetry attributes (docs/api/telemetry.md § Privacy). Runs on EVERY event the gateway stores,
 * whoever sent it, the gateway's own included. Telemetry is a research instrument over student sessions, so it may
 * hold lengths, counts, durations and codes — never audio, transcript or LLM text, keys/tokens, or a raw IP.
 *
 * Rules, in order:
 *   1. a key matching SENSITIVE_KEY (text|transcript|prompt|content|audio|token|key|secret|authorization, any case)
 *      with a STRING value is dropped; with a number/boolean/null it is kept (`promptTokens: 120`, `textLen: 42`,
 *      `audioMs: 900` are counts, not content);
 *   2. a string longer than 200 chars is dropped (free text);
 *   3. a string that looks like a credential (JWT, `Bearer …`, `sk-…`, ≥ 32 hex/base64url chars) is dropped;
 *   4. a string that IS an IP address (v4 or v6) is replaced by `ip:<12 hex of HMAC-SHA256(salt, ip)>`;
 *   5. keys beyond 32, keys longer than 64 chars or outside `[A-Za-z0-9_.-]` are dropped.
 * Every drop is counted (`redacted`), so a source that leaks is visible in the ingest response and the counters.
 */

import { createHmac, randomBytes } from 'crypto';
import { isIP } from 'net';
import { TELEMETRY_LIMITS, TELEMETRY_SENSITIVE_KEY, type TelemetryAttrs } from './contract';

export const SENSITIVE_KEY = TELEMETRY_SENSITIVE_KEY;
const SAFE_KEY = /^[A-Za-z0-9_.-]+$/;
const CREDENTIAL = /^(bearer\s|basic\s|sk-|eyJ[A-Za-z0-9_-]+\.)|^[A-Fa-f0-9]{32,}$|^[A-Za-z0-9_-]{40,}$/i;
const V4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
const V6_BRACKETED = /^\[([0-9A-Fa-f:.]+)\](?::\d{1,5})?$/;

export interface ScrubResult {
  attrs: TelemetryAttrs | undefined;
  redacted: number;
}

/** Salt for IP hashes: TELEMETRY_IP_SALT, else random per process (hashes then only correlate within one run). */
let ipSalt = process.env.TELEMETRY_IP_SALT || randomBytes(16).toString('hex');

export function _setIpSaltForTests(salt: string): void {
  ipSalt = salt;
}

export function hashIp(ip: string): string {
  return `ip:${createHmac('sha256', ipSalt).update(ip.toLowerCase()).digest('hex').slice(0, 12)}`;
}

/** An IP address, bare or with a port (`1.2.3.4:5`, `[::1]:5`). */
export function looksLikeIp(value: string): boolean {
  if (isIP(value)) return true;
  const inner = V4_WITH_PORT.exec(value)?.[1] ?? V6_BRACKETED.exec(value)?.[1];
  return inner !== undefined && isIP(inner) !== 0;
}

/** One scalar value after the rules above; `undefined` = dropped. */
function scrubValue(key: string, value: unknown): TelemetryAttrs[string] | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  if (SENSITIVE_KEY.test(key)) return undefined;
  if (value.length > TELEMETRY_LIMITS.maxAttrString) return undefined;
  if (looksLikeIp(value)) return hashIp(value);
  if (CREDENTIAL.test(value)) return undefined;
  return value;
}

export function scrubAttrs(attrs: Record<string, unknown> | undefined): ScrubResult {
  if (!attrs) return { attrs: undefined, redacted: 0 };
  const out: TelemetryAttrs = {};
  let kept = 0;
  let redacted = 0;
  for (const [key, value] of Object.entries(attrs)) {
    if (kept >= TELEMETRY_LIMITS.maxAttrs || key.length > TELEMETRY_LIMITS.maxAttrKey || !SAFE_KEY.test(key)) {
      redacted++;
      continue;
    }
    const clean = scrubValue(key, value);
    if (clean === undefined) {
      redacted++;
      continue;
    }
    out[key] = clean;
    kept++;
  }
  return { attrs: kept ? out : undefined, redacted };
}
