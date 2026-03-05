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
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function blockKey(provider: string, apiKeyHash: string): string {
  return `${provider}:${apiKeyHash}`;
}

export class CreditBlockTracker {
  private blocks = new Map<string, number>(); // key → blockedUntil timestamp

  /** Record a 402 — immediately blocks this provider:key pair */
  recordBlock(provider: string, apiKeyHash: string): void {
    const key = blockKey(provider, apiKeyHash);
    this.blocks.set(key, Date.now() + BLOCK_TTL_MS);
  }

  /** Check if a provider:key pair is currently blocked */
  isBlocked(provider: string, apiKeyHash: string): boolean {
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
}

/** Default module-level singleton */
export const defaultCreditBlockTracker = new CreditBlockTracker();
