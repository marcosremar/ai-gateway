/**
 * API Key registry — maps Bearer tokens to user identities.
 *
 * Before this module, GATEWAY_API_KEYS was a flat comma-separated list
 * of equivalent tokens. Any token in the list was valid but there was no
 * way to know WHO was calling — rate limits, logs, and GPU deploys were
 * all anonymous.
 *
 * Now each key is associated with a user identity:
 *
 *   Format: GATEWAY_API_KEYS="key1:user1,key2:user2,plainkey"
 *
 *   - "key1:user1" → token "key1" maps to userId "user1"
 *   - "plainkey"   → token "plainkey" maps to userId "default" (backward compat)
 *
 * The registry is queried on every authenticated request. The resolved
 * userId is attached to the request context (pino log, rate limiter key,
 * GPU deploy attribution, etc.).
 */

import { timingSafeEqual } from 'crypto';

export interface ApiKeyEntry {
  /** The raw Bearer token. */
  key: string;
  /** The user identity associated with this key. */
  userId: string;
  /** Optional human-readable label (e.g. "marcos-dev", "production-bot"). */
  label?: string;
}

export class ApiKeyRegistry {
  private entries: ApiKeyEntry[] = [];

  constructor(raw?: string) {
    if (raw) this.load(raw);
  }

  /**
   * Parse GATEWAY_API_KEYS env var format:
   *   "key1:user1,key2:user2,plainkey"
   *   "key1:user1:label1,key2:user2"
   */
  load(raw: string): void {
    this.entries = raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(entry => {
        const parts = entry.split(':');
        if (parts.length >= 3) {
          return { key: parts[0], userId: parts[1], label: parts.slice(2).join(':') };
        }
        if (parts.length === 2) {
          return { key: parts[0], userId: parts[1] };
        }
        // Plain key without userId — backward compat
        return { key: entry, userId: 'default' };
      });
  }

  /** Check if a Bearer token is valid. Timing-safe. */
  validate(token: string): boolean {
    if (this.entries.length === 0) return false; // no keys configured = deny all
    return this.entries.some(e => safeEqual(token, e.key));
  }

  /** Resolve a Bearer token to its user identity. Returns null if invalid. */
  resolve(token: string): ApiKeyEntry | null {
    if (this.entries.length === 0) return null; // no keys = deny, don't default to anonymous
    for (const entry of this.entries) {
      if (safeEqual(token, entry.key)) return entry;
    }
    return null;
  }

  /** Get all valid keys (for the legacy validateAuth path). */
  keys(): string[] {
    return this.entries.map(e => e.key);
  }

  /** Number of registered keys. */
  get size(): number {
    return this.entries.length;
  }

  /** List all entries with keys masked (for /health or admin endpoints). */
  listMasked(): Array<{ userId: string; label?: string; keyPrefix: string }> {
    return this.entries.map(e => ({
      userId: e.userId,
      label: e.label,
      keyPrefix: e.key.slice(0, 8) + '...',
    }));
  }
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
