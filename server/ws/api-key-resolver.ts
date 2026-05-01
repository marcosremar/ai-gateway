// ── API Key Resolver — multi-key auth + identity for the ws-server HTTP API ──
//
// Historically `server/ws/http-api-server.ts` accepted a single shared
// GATEWAY_API_KEY: every caller was indistinguishable. That meant every
// app/agent in the org could `gpu list` (seeing each other's GPUs) and
// `gpu terminate` (destroying each other's GPUs) without any guard.
//
// This module provides a lightweight identity layer:
//
//   - GATEWAY_API_KEYS env var  → multi-key registry (key:userId,key:userId,plainkey)
//   - GATEWAY_API_KEY env var   → still honored for back-compat (single anonymous key)
//   - resolveBearer(token)      → returns { ok, userId } where userId is
//                                 the per-app identity, or 'default' for the
//                                 legacy single-key path, or null if unknown.
//
// Handlers receive the resolved userId via the synthetic
// `x-aigw-user-id` header injected by the auth wrapper.

import { ApiKeyRegistry } from '../../src/gateway/proxy/middleware/api-keys';
import { timingSafeEqual } from 'crypto';

let cachedRegistry: ApiKeyRegistry | null = null;
let cachedRegistrySource = '';

/**
 * Lazy-build the registry from current env. Re-built when GATEWAY_API_KEYS
 * changes between calls (so tests / reloads work). Production sets it at
 * boot and leaves it alone — the cache hits the fast path.
 */
function getRegistry(): ApiKeyRegistry {
  const raw = process.env.GATEWAY_API_KEYS || '';
  if (cachedRegistry && cachedRegistrySource === raw) return cachedRegistry;
  cachedRegistry = new ApiKeyRegistry(raw);
  cachedRegistrySource = raw;
  return cachedRegistry;
}

export interface BearerResolution {
  ok: boolean;
  userId: string | null;
  /** True when the caller authenticated via the legacy single GATEWAY_API_KEY. */
  legacy: boolean;
}

/** Constant-time string compare; returns false on length mismatch. */
function safeEq(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) {
    // Equal-length compare anyway to avoid timing leak on length probe.
    timingSafeEqual(Buffer.from(a.padEnd(b.length, '\0')), Buffer.from(b.padEnd(a.length, '\0')));
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Resolve a Bearer token to a user identity.
 *
 *   1. Empty/missing token → unauthenticated (caller decides whether to allow).
 *   2. Matches an entry in GATEWAY_API_KEYS → returns its userId.
 *   3. Matches the legacy GATEWAY_API_KEY → returns 'default' with legacy=true.
 *   4. Otherwise → ok=false.
 */
export function resolveBearer(token: string): BearerResolution {
  if (!token) return { ok: false, userId: null, legacy: false };

  const registry = getRegistry();
  if (registry.size > 0) {
    const entry = registry.resolve(token);
    if (entry) return { ok: true, userId: entry.userId, legacy: false };
  }

  const single = process.env.GATEWAY_API_KEY || '';
  if (single && safeEq(token, single)) {
    return { ok: true, userId: 'default', legacy: true };
  }

  return { ok: false, userId: null, legacy: false };
}

/** Header name used to forward resolved identity to handlers. */
export const X_AIGW_USER_ID = 'x-aigw-user-id';

/**
 * Pull the resolved userId out of an inbound Node-style request. Returns
 * null when no auth was configured (loopback path) so handlers can decide
 * whether to treat the call as admin.
 */
export function readUserIdHeader(headers: Record<string, string | string[] | undefined> | undefined): string | null {
  if (!headers) return null;
  const raw = headers[X_AIGW_USER_ID];
  if (!raw) return null;
  return Array.isArray(raw) ? raw[0] : raw;
}
