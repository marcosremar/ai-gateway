/**
 * Credit Block Tracker
 *
 * Tracks providers that returned 402 (payment required / no credits).
 * A single 402 immediately blocks the provider:apiKeyHash pair for BLOCK_TTL_MS.
 *
 * Separate from CooldownTracker because:
 *   - Key: "provider:apiKeyHash" (credit is per-account, not per-model)
 *   - TTL: 5 minutes (vs 60s for cooldown)
 *   - Threshold: 1 (immediate block on first 402)
 */

import { createHash } from 'crypto';

const BLOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function blockKey(provider: string, apiKeyHash: string): string {
  return `${provider}:${apiKeyHash}`;
}

export class CreditBlockTracker {
  private blocks = new Map<string, number>(); // key → blockedUntil timestamp
  private lastSweep = Date.now();
  /** Optional per-provider TTL overrides (ms). Falls back to BLOCK_TTL_MS. */
  private readonly ttlOverrides: Record<string, number>;

  /**
   * @param ttlOverrides Optional per-provider block TTL (ms). A provider whose
   *   402 is a transient rate-limit (not real credit exhaustion) can recover
   *   sooner than the flat 5-minute window, avoiding over-routing to pricier
   *   fallbacks (#311). Example: `{ groq: 30_000 }`.
   */
  constructor(ttlOverrides: Record<string, number> = {}) {
    this.ttlOverrides = ttlOverrides;
  }

  /** Resolve the block TTL for a provider (override or global default). */
  private ttlFor(provider: string): number {
    const override = this.ttlOverrides[provider];
    return typeof override === 'number' && override > 0 ? override : BLOCK_TTL_MS;
  }

  /** Remove expired entries to prevent unbounded growth. */
  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < 5 * 60_000) return;
    this.lastSweep = now;
    for (const [key, until] of this.blocks) {
      if (until <= now) this.blocks.delete(key);
    }
  }

  /** Record a 402 — immediately blocks this provider:key pair */
  recordBlock(provider: string, apiKeyHash: string): void {
    this.sweep();
    const key = blockKey(provider, apiKeyHash);
    this.blocks.set(key, Date.now() + this.ttlFor(provider));
  }

  /** Check if a provider:key pair is currently blocked */
  isBlocked(provider: string, apiKeyHash: string): boolean {
    // Sweep on reads too — under low 402 volume recordBlock may not fire for a
    // long time, leaving expired entries (and a stale `size`) in the map until
    // a same-key read or capacity hit (#315).
    this.sweep();
    const key = blockKey(provider, apiKeyHash);
    const until = this.blocks.get(key);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.blocks.delete(key);
    return false;
  }

  /** Clear block for a specific provider (or all blocks if no apiKeyHash given) */
  clear(provider: string, apiKeyHash?: string): void {
    if (apiKeyHash) {
      this.blocks.delete(blockKey(provider, apiKeyHash));
    } else {
      for (const key of [...this.blocks.keys()]) {
        if (key.startsWith(`${provider}:`)) {
          this.blocks.delete(key);
        }
      }
    }
  }

  /** Number of currently active blocks (for monitoring) */
  get size(): number {
    return this.blocks.size;
  }

  /** Serialize active blocks to a plain object for persistence. */
  toJSON(): Record<string, number> {
    const now = Date.now();
    const result: Record<string, number> = {};
    for (const [key, until] of this.blocks) {
      if (until > now) result[key] = until;
    }
    return result;
  }

  /** Restore blocks from a previously persisted object. */
  fromJSON(data: Record<string, number>): void {
    const now = Date.now();
    for (const [key, until] of Object.entries(data)) {
      if (typeof until === 'number' && until > now) {
        this.blocks.set(key, until);
      }
    }
  }
}

/** Default module-level singleton */
export const defaultCreditBlockTracker = new CreditBlockTracker();
