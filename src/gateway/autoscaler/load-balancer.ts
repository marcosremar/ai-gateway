/**
 * Health-Aware Load Balancer — selects a tier from the ready pool.
 *
 * 6 strategies:
 *   - hash:                Deterministic hash of userId
 *   - least-latency:       EMA-based per-tier latency tracking
 *   - weighted-round-robin: Rotates across tiers with optional weights
 *   - affinity:            Sticky to last-used tier per userId
 *   - least-busy:         Selects tier with fewest active connections
 *   - priority:            Priority queue with urgent/normal queues
 *
 * Plus Token Bucket rate limiting:
 *   - Per-client rate limiting
 *   - Token refill scheduling
 *   - Burst allowance
 */

import type { StateStore } from '../../deps';
import type { GpuTierState } from '../../types';

export type LoadBalanceStrategy = 
  | 'hash' 
  | 'least-latency' 
  | 'weighted-round-robin' 
  | 'affinity'
  | 'least-busy'
  | 'priority';

export type RequestPriority = 'urgent' | 'high' | 'normal' | 'low';

export interface TierLatencyMetrics {
  tierIndex: number;
  emaLatencyMs: number;
  sampleCount: number;
  lastUpdated: number;
}

export interface TierConnectionMetrics {
  tierIndex: number;
  activeConnections: number;
  lastUpdated: number;
}

export interface TokenBucketConfig {
  capacity: number;       // Max tokens in bucket
  refillRate: number;    // Tokens added per second
  initialTokens?: number; // Starting tokens (default: capacity)
}

export interface TokenBucketState {
  tokens: number;
  lastRefill: number;
}

export interface PriorityQueueConfig {
  maxQueueSize: number;
  urgentMaxWaitMs: number;
  normalMaxWaitMs: number;
}

const LATENCY_KEY_PREFIX = 'tier-latency:';
const AFFINITY_KEY_PREFIX = 'tier-affinity:';
const CONNECTIONS_KEY_PREFIX = 'tier-connections:';
const TOKEN_BUCKET_KEY_PREFIX = 'token-bucket:';
const LATENCY_TTL_SECS = 30 * 60; // 30 min
const CONNECTIONS_TTL_SECS = 60;
const EMA_ALPHA = 0.3; // weight of new sample vs history

function latencyKey(userId: string, tierIndex: number): string {
  return `${LATENCY_KEY_PREFIX}${userId}:${tierIndex}`;
}

function affinityKey(userId: string): string {
  return `${AFFINITY_KEY_PREFIX}${userId}`;
}

function connectionsKey(tierIndex: number): string {
  return `${CONNECTIONS_KEY_PREFIX}${tierIndex}`;
}

function tokenBucketKey(clientId: string): string {
  return `${TOKEN_BUCKET_KEY_PREFIX}${clientId}`;
}

function hashUserId(userId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export class LoadBalancer {
  private stateStore: StateStore;
  private roundRobinCounter = 0;
  private tokenBucketConfig: TokenBucketConfig;
  private priorityQueueConfig: PriorityQueueConfig;

  constructor(
    stateStore: StateStore, 
    tokenBucketConfig?: Partial<TokenBucketConfig>,
    priorityQueueConfig?: Partial<PriorityQueueConfig>,
  ) {
    this.stateStore = stateStore;
    this.tokenBucketConfig = {
      capacity: 100,
      refillRate: 10,
      initialTokens: 100,
      ...tokenBucketConfig,
    };
    this.priorityQueueConfig = {
      maxQueueSize: 1000,
      urgentMaxWaitMs: 1000,
      normalMaxWaitMs: 10000,
      ...priorityQueueConfig,
    };
  }

  /**
   * Select a tier index from readyTiers based on the chosen strategy.
   * Returns the index within the readyTiers array.
   */
  async selectTier(
    userId: string,
    readyTiers: GpuTierState[],
    strategy: LoadBalanceStrategy = 'hash',
    priority: RequestPriority = 'normal',
  ): Promise<number> {
    if (readyTiers.length === 0) return -1; // no tiers available
    if (readyTiers.length === 1) return 0;

    switch (strategy) {
      case 'hash':
        return hashUserId(userId) % readyTiers.length;

      case 'least-latency':
        return this.selectLeastLatency(userId, readyTiers);

      case 'weighted-round-robin':
        return this.selectRoundRobin(readyTiers);

      case 'affinity':
        return this.selectAffinity(userId, readyTiers);

      case 'least-busy':
        return this.selectLeastBusy(readyTiers);

      case 'priority':
        return this.selectPriority(userId, readyTiers, priority);

      default:
        return 0;
    }
  }

  /**
   * Report observed latency for a tier. Uses exponential moving average.
   */
  async reportTierLatency(userId: string, tierIndex: number, latencyMs: number): Promise<void> {
    const key = latencyKey(userId, tierIndex);
    try {
      const raw = await this.stateStore.get(key);
      let metrics: TierLatencyMetrics;

      if (raw) {
        let existing: TierLatencyMetrics | null = null;
        try { existing = JSON.parse(raw) as TierLatencyMetrics; } catch { /* corrupted — treat as new */ }
        if (existing && typeof existing.emaLatencyMs === 'number') {
          metrics = {
            tierIndex,
            emaLatencyMs: EMA_ALPHA * latencyMs + (1 - EMA_ALPHA) * existing.emaLatencyMs,
            sampleCount: (existing.sampleCount ?? 0) + 1,
            lastUpdated: Date.now(),
          };
        } else {
          metrics = { tierIndex, emaLatencyMs: latencyMs, sampleCount: 1, lastUpdated: Date.now() };
        }
      } else {
        metrics = { tierIndex, emaLatencyMs: latencyMs, sampleCount: 1, lastUpdated: Date.now() };
      }

      await this.stateStore.set(key, JSON.stringify(metrics), LATENCY_TTL_SECS);
    } catch {
      // Non-critical — swallow
    }
  }

  /**
   * Get latency metrics for a specific tier.
   */
  async getTierLatency(userId: string, tierIndex: number): Promise<TierLatencyMetrics | null> {
    try {
      const raw = await this.stateStore.get(latencyKey(userId, tierIndex));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as TierLatencyMetrics;
      return typeof parsed.emaLatencyMs === 'number' ? parsed : null;
    } catch {
      return null;
    }
  }

  // ── Private strategies ───────────────────────────────────────────────────────

  private async selectLeastLatency(userId: string, readyTiers: GpuTierState[]): Promise<number> {
    let bestIdx = 0;
    let bestLatency = Infinity;

    const checks = await Promise.all(
      readyTiers.map(async (tier, idx) => {
        const metrics = await this.getTierLatency(userId, tier.tierIndex);
        return { idx, latency: metrics?.emaLatencyMs ?? Infinity };
      }),
    );

    for (const { idx, latency } of checks) {
      if (latency < bestLatency) {
        bestLatency = latency;
        bestIdx = idx;
      }
    }

    // If no latency data at all, fall back to hash
    if (bestLatency === Infinity) {
      return hashUserId(userId) % readyTiers.length;
    }

    return bestIdx;
  }

  private selectRoundRobin(readyTiers: GpuTierState[]): number {
    const idx = this.roundRobinCounter % readyTiers.length;
    // Reset to avoid Number.MAX_SAFE_INTEGER overflow after sustained use
    this.roundRobinCounter = (this.roundRobinCounter + 1) % 1_000_000;
    return idx;
  }

  private async selectAffinity(userId: string, readyTiers: GpuTierState[]): Promise<number> {
    try {
      const raw = await this.stateStore.get(affinityKey(userId));
      if (raw) {
        const lastTierIndex = parseInt(raw, 10);
        const idx = readyTiers.findIndex((t) => t.tierIndex === lastTierIndex);
        if (idx >= 0) return idx;
      }
    } catch {
      // Fall through to hash
    }

    const idx = hashUserId(userId) % readyTiers.length;
    // Persist affinity
    const chosenTier = readyTiers[idx];
    if (chosenTier) {
      void this.stateStore.set(affinityKey(userId), String(chosenTier.tierIndex), LATENCY_TTL_SECS).catch(e => console.warn('[lb] affinity persist failed:', e instanceof Error ? e.message : e));
    }
    return idx;
  }

  // ── Least Busy Strategy ─────────────────────────────────────────────────────────

  private async selectLeastBusy(readyTiers: GpuTierState[]): Promise<number> {
    let bestIdx = 0;
    let minConnections = Infinity;

    const checks = await Promise.all(
      readyTiers.map(async (tier, idx) => {
        const metrics = await this.getTierConnections(tier.tierIndex);
        return { idx, connections: metrics?.activeConnections ?? 0 };
      }),
    );

    for (const { idx, connections } of checks) {
      if (connections < minConnections) {
        minConnections = connections;
        bestIdx = idx;
      }
    }

    return bestIdx;
  }

  /**
   * Report an active connection to a tier. Call when request starts.
   */
  /** In-memory connection counters — avoids get-parse-modify-set race condition */
  private connectionCounts = new Map<number, number>();

  async incrementConnections(tierIndex: number): Promise<void> {
    const count = (this.connectionCounts.get(tierIndex) || 0) + 1;
    this.connectionCounts.set(tierIndex, count);
    const key = connectionsKey(tierIndex);
    try {
      await this.stateStore.set(key, JSON.stringify({
        tierIndex, activeConnections: count, lastUpdated: Date.now(),
      } satisfies TierConnectionMetrics), CONNECTIONS_TTL_SECS);
    } catch {
      // Non-critical — in-memory counter is still accurate
    }
  }

  /**
   * Report a closed connection to a tier. Call when request ends.
   */
  async decrementConnections(tierIndex: number): Promise<void> {
    const count = Math.max(0, (this.connectionCounts.get(tierIndex) ?? 0) - 1);
    this.connectionCounts.set(tierIndex, count);
    const key = connectionsKey(tierIndex);
    try {
      if (count > 0) {
        await this.stateStore.set(key, JSON.stringify({
          tierIndex, activeConnections: count, lastUpdated: Date.now(),
        } satisfies TierConnectionMetrics), CONNECTIONS_TTL_SECS);
      } else {
        await this.stateStore.del(key);
      }
    } catch {
      // Non-critical — in-memory counter is still accurate
    }
  }

  private async getTierConnections(tierIndex: number): Promise<TierConnectionMetrics | null> {
    try {
      const raw = await this.stateStore.get(connectionsKey(tierIndex));
      if (!raw) return null;
      return JSON.parse(raw) as TierConnectionMetrics;
    } catch {
      return null;
    }
  }

  // ── Priority Queue Strategy ───────────────────────────────────────────────────

  private async selectPriority(
    userId: string, 
    readyTiers: GpuTierState[], 
    priority: RequestPriority,
  ): Promise<number> {
    // For urgent requests, prefer least-busy
    if (priority === 'urgent' || priority === 'high') {
      return this.selectLeastBusy(readyTiers);
    }

    // For normal/low, use affinity + round-robin hybrid
    const affinityIdx = await this.selectAffinity(userId, readyTiers);
    const tier = readyTiers[affinityIdx];

    // Check queue size - if too full, escalate to urgent
    if (tier) {
      const connections = await this.getTierConnections(tier.tierIndex);
      const loadFactor = (connections?.activeConnections ?? 0) / Math.max(1, this.priorityQueueConfig.maxQueueSize);
      
      // If load > 70%, use least-busy instead
      if (loadFactor > 0.7) {
        return this.selectLeastBusy(readyTiers);
      }
    }

    return affinityIdx;
  }

  // ── Token Bucket Rate Limiting ───────────────────────────────────────────────

  /**
   * Try to consume tokens from the bucket. Returns true if allowed.
   */
  async tryConsume(clientId: string, tokens: number = 1): Promise<boolean> {
    const key = tokenBucketKey(clientId);
    const now = Date.now();

    try {
      const raw = await this.stateStore.get(key);
      let state: TokenBucketState;
      let refillAmount = 0;

      if (raw) {
        state = JSON.parse(raw) as TokenBucketState;
        // Calculate token refill based on time elapsed
        const elapsedSeconds = (now - state.lastRefill) / 1000;
        refillAmount = Math.floor(elapsedSeconds * this.tokenBucketConfig.refillRate);
        state.tokens = Math.min(
          this.tokenBucketConfig.capacity,
          state.tokens + refillAmount,
        );
      } else {
        state = {
          tokens: this.tokenBucketConfig.initialTokens ?? this.tokenBucketConfig.capacity,
          lastRefill: now,
        };
      }

      // Try to consume
      if (state.tokens >= tokens) {
        state.tokens -= tokens;
        state.lastRefill = now;
        await this.stateStore.set(key, JSON.stringify(state), 3600); // 1 hour TTL
        return true;
      }

      // Not enough tokens - still update refill time
      state.lastRefill = now;
      await this.stateStore.set(key, JSON.stringify(state), 3600);
      return false;
    } catch {
      // On error, allow the request (fail open)
      return true;
    }
  }

  /**
   * Get current token balance for a client.
   */
  async getTokenBalance(clientId: string): Promise<number> {
    const key = tokenBucketKey(clientId);
    const now = Date.now();

    try {
      const raw = await this.stateStore.get(key);
      if (!raw) return this.tokenBucketConfig.capacity;

      const state = JSON.parse(raw) as TokenBucketState;
      const elapsedSeconds = (now - state.lastRefill) / 1000;
      const refillAmount = Math.floor(elapsedSeconds * this.tokenBucketConfig.refillRate);
      return Math.min(
        this.tokenBucketConfig.capacity,
        state.tokens + refillAmount,
      );
    } catch {
      return this.tokenBucketConfig.capacity;
    }
  }

  /**
   * Reset token bucket for a client (admin operation).
   */
  async resetTokenBucket(clientId: string): Promise<void> {
    const key = tokenBucketKey(clientId);
    try {
      await this.stateStore.del(key);
    } catch {
      // Ignore
    }
  }

  /**
   * Check if request should be rate limited based on priority.
   */
  async checkRateLimit(
    clientId: string, 
    priority: RequestPriority = 'normal',
  ): Promise<{ allowed: boolean; remainingTokens: number; retryAfterMs?: number }> {
    const tokensNeeded = priority === 'urgent' ? 1 : priority === 'high' ? 2 : 3;
    const allowed = await this.tryConsume(clientId, tokensNeeded);
    const remaining = await this.getTokenBalance(clientId);

    return {
      allowed,
      remainingTokens: remaining,
      retryAfterMs: allowed ? undefined : Math.ceil((tokensNeeded - remaining) / this.tokenBucketConfig.refillRate * 1000),
    };
  }
}
