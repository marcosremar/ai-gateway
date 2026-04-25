/**
 * Autoscaler Unit Tests (#475-#505)
 *
 * Tests for autoscaler engine, boot orchestrator, load balancer,
 * session tracker, and tier selector.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutoscalerEngine, MAX_BOOT_FAILURES, BOOT_COOLDOWN_BASE_MS } from '../../src/autoscaler/engine';
import { BootOrchestrator } from '../../src/autoscaler/boot-orchestrator';
import { LoadBalancer, type LoadBalanceStrategy, type TierLatencyMetrics } from '../../src/autoscaler/load-balancer';
import { SessionTracker } from '../../src/autoscaler/session-tracker';
import { TierSelector } from '../../src/autoscaler/tier-selector';
import { LatencyTracker, computeP95, countRecentBreaches, LATENCY_BREACH_COUNT } from '../../src/autoscaler/latency-tracker';
import { StatePersistence } from '../../src/autoscaler/state-persistence';
import type { GpuTierConfig, GpuTierState, IdleTierState, BootingTierState, ReadyTierState } from '../../src/types';
import type { StateStore, KvStore, ListStore, HashStore, SessionResolver } from '../../src/deps';

// ── Helpers ──────────────────────────────────────────────────────────────────

const silentLogger = {
  debug: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createMemoryStateStore(): StateStore {
  const kv = new Map<string, { value: string; expiry?: number }>();
  const lists = new Map<string, string[]>();
  const hashes = new Map<string, Record<string, string>>();

  return {
    // KvStore
    get: async (key) => {
      const entry = kv.get(key);
      if (!entry) return null;
      if (entry.expiry && Date.now() > entry.expiry) { kv.delete(key); return null; }
      return entry.value;
    },
    set: async (key, value, ttlSecs?) => {
      kv.set(key, { value, expiry: ttlSecs ? Date.now() + ttlSecs * 1000 : undefined });
    },
    del: async (key) => { kv.delete(key); },
    scan: async (pattern) => {
      const prefix = pattern.replace(/\*/g, '');
      return [...kv.keys()].filter((k) => k.startsWith(prefix));
    },
    // ListStore
    rpush: async (key, value) => {
      const list = lists.get(key) ?? [];
      list.push(value);
      lists.set(key, list);
    },
    ltrim: async (key, start, stop) => {
      const list = lists.get(key) ?? [];
      const len = list.length;
      const s = start < 0 ? Math.max(len + start, 0) : start;
      const e = stop < 0 ? len + stop : stop;
      lists.set(key, list.slice(s, e + 1));
    },
    lrange: async (key, start, stop) => {
      const list = lists.get(key) ?? [];
      const len = list.length;
      const s = start < 0 ? Math.max(len + start, 0) : start;
      const e = stop < 0 ? len + stop : stop;
      return list.slice(s, e + 1);
    },
    // HashStore
    hset: async (key, field, value) => {
      const hash = hashes.get(key) ?? {};
      hash[field] = value;
      hashes.set(key, hash);
    },
    hdel: async (key, field) => {
      const hash = hashes.get(key);
      if (hash) delete hash[field];
    },
    hgetall: async (key) => {
      return hashes.get(key) ?? {};
    },
  };
}

function idleState(tierIndex: number, overrides: Partial<IdleTierState> = {}): IdleTierState {
  return { state: 'idle', tierIndex, ...overrides };
}

function bootingState(tierIndex: number, overrides: Partial<BootingTierState> = {}): BootingTierState {
  return {
    state: 'booting',
    tierIndex,
    endpoint: 'http://1.2.3.4:8000',
    bootTriggeredAt: Date.now(),
    trigger: 'manual' as const,
    prevBootFailCount: 0,
    ...overrides,
  };
}

function readyState(tierIndex: number, overrides: Partial<ReadyTierState> = {}): ReadyTierState {
  return {
    state: 'ready',
    tierIndex,
    endpoint: 'http://1.2.3.4:8000',
    activeGpuType: 'NVIDIA GeForce RTX 4090',
    readySince: Date.now(),
    lastUsed: Date.now(),
    trigger: 'manual' as const,
    ...overrides,
  };
}

function tierConfig(provider = 'runpod', overrides: Partial<GpuTierConfig> = {}): GpuTierConfig {
  return {
    provider: provider as GpuTierConfig['provider'],
    apiKey: 'test-key',
    dockerImage: 'test:latest',
    gpuTypes: ['NVIDIA GeForce RTX 4090'],
    ...overrides,
  };
}

// ── Engine Tests (#475-#481) ────────────────────────────────────────────────

describe('AutoscalerEngine', () => {
  // #475 — engine constants
  it('exports MAX_BOOT_FAILURES constant', () => {
    expect(MAX_BOOT_FAILURES).toBe(3);
  });

  it('exports BOOT_COOLDOWN_BASE_MS constant', () => {
    expect(BOOT_COOLDOWN_BASE_MS).toBeGreaterThan(0);
  });
});

// ── LatencyTracker Tests ─────────────────────────────────────────────────────

describe('LatencyTracker', () => {
  let store: StateStore;
  let tracker: LatencyTracker;

  beforeEach(() => {
    store = createMemoryStateStore();
    tracker = new LatencyTracker(store);
  });

  // #476 — reports and reads latency
  it('reports latency and reads stats', async () => {
    await tracker.reportLatency('user-1', 100);
    await tracker.reportLatency('user-1', 200);
    await tracker.reportLatency('user-1', 300);
    const stats = await tracker.getLatencyStats('user-1');
    expect(stats.samples).toHaveLength(3);
    expect(stats.p95).toBeDefined();
    expect(stats.p95).toBeGreaterThanOrEqual(200);
  });

  // #477 — empty stats
  it('returns null p95 for no data', async () => {
    const stats = await tracker.getLatencyStats('user-none');
    expect(stats.p95).toBeNull();
    expect(stats.samples).toEqual([]);
  });

  // #478 — breach count
  it('counts recent breaches correctly', async () => {
    for (let i = 0; i < 5; i++) {
      await tracker.reportLatency('user-1', 500);
    }
    const stats = await tracker.getLatencyStats('user-1', 300);
    expect(stats.breaches).toBe(LATENCY_BREACH_COUNT);
  });

  // #479 — computeP95 utility
  it('computeP95 works correctly', () => {
    expect(computeP95([])).toBeNull();
    expect(computeP95([100])).toBe(100);
    expect(computeP95([100, 200, 300, 400, 500])).toBe(500);
  });

  // #480 — countRecentBreaches utility
  it('countRecentBreaches counts from tail of array', () => {
    expect(countRecentBreaches([100, 200, 1000, 2000, 3000], 500)).toBe(3);
    expect(countRecentBreaches([100, 200, 300], 500)).toBe(0);
    expect(countRecentBreaches([], 500)).toBe(0);
  });

  // #481 — trims to WINDOW_SIZE
  it('trims to window size', async () => {
    for (let i = 0; i < 30; i++) {
      await tracker.reportLatency('user-1', i * 100);
    }
    const stats = await tracker.getLatencyStats('user-1');
    // LATENCY_WINDOW_SIZE is 20
    expect(stats.samples.length).toBeLessThanOrEqual(20);
  });
});

// ── StatePersistence Tests ───────────────────────────────────────────────────

describe('StatePersistence', () => {
  let store: StateStore;
  let persistence: StatePersistence;

  beforeEach(() => {
    store = createMemoryStateStore();
    persistence = new StatePersistence(store, silentLogger);
  });

  // #482 — persist and restore tier states
  it('persists and restores tier states', async () => {
    const states: GpuTierState[] = [
      idleState(0),
      readyState(1, { endpoint: 'http://test:8000' }),
    ];
    await persistence.persistTierStates('user-1', states);
    const restored = await persistence.loadPersistedTierStates('user-1');
    expect(restored).not.toBeNull();
    expect(restored).toHaveLength(2);
    expect(restored![1].state).toBe('ready');
  });

  // #483 — deletes key when all idle
  it('deletes key when all states are idle', async () => {
    // First persist some active states
    await persistence.persistTierStates('user-1', [readyState(0)]);
    // Then persist all-idle
    await persistence.persistTierStates('user-1', [idleState(0)]);
    const restored = await persistence.loadPersistedTierStates('user-1');
    expect(restored).toBeNull();
  });

  // #484 — returns null for non-existent user
  it('returns null for non-existent user', async () => {
    const restored = await persistence.loadPersistedTierStates('no-such-user');
    expect(restored).toBeNull();
  });
});

// ── Boot Orchestrator Tests (#485-#487) ──────────────────────────────────────

describe('BootOrchestrator', () => {
  // #485 — boot requires API key
  it('returns error when API key is missing', async () => {
    const mockCallbacks = {
      getStates: vi.fn().mockReturnValue([idleState(0)]),
      setStates: vi.fn(),
      persistStates: vi.fn(),
      emitError: vi.fn(),
      recordProviderHealthEvent: vi.fn(),
    };
    const orchestrator = new BootOrchestrator({
      registry: { getClient: vi.fn() } as any,
      probeHealth: vi.fn(),
      lifecycleLogger: { log: vi.fn(), query: vi.fn() } as any,
      logger: silentLogger,
      callbacks: mockCallbacks,
    });

    const result = await orchestrator.triggerGpuBoot(
      tierConfig('runpod', { apiKey: '' }),
      0,
      'user-1',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('apiKey');
  });

  // #486 — max retry attempts
  it('returns error when max retry attempts reached', async () => {
    const orchestrator = new BootOrchestrator({
      registry: { getClient: vi.fn() } as any,
      probeHealth: vi.fn(),
      lifecycleLogger: { log: vi.fn(), query: vi.fn() } as any,
      logger: silentLogger,
      callbacks: {
        getStates: vi.fn(),
        setStates: vi.fn(),
        persistStates: vi.fn(),
        emitError: vi.fn(),
        recordProviderHealthEvent: vi.fn(),
      },
    });

    const result = await orchestrator.triggerGpuBoot(tierConfig('runpod'), 0, 'user-1', 2);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Max retry');
  });

  // #487 — cleanup on boot pollers
  it('has bootPollers map for tracking active pollers', () => {
    const orchestrator = new BootOrchestrator({
      registry: { getClient: vi.fn() } as any,
      probeHealth: vi.fn(),
      lifecycleLogger: { log: vi.fn(), query: vi.fn() } as any,
      logger: silentLogger,
      callbacks: {
        getStates: vi.fn(),
        setStates: vi.fn(),
        persistStates: vi.fn(),
        emitError: vi.fn(),
        recordProviderHealthEvent: vi.fn(),
      },
    });
    expect((orchestrator as any).bootPollers).toBeDefined();
    expect((orchestrator as any).bootPollers.size).toBe(0);
  });
});

// ── Load Balancer Tests (#488-#495) ──────────────────────────────────────────

describe('LoadBalancer', () => {
  let store: StateStore;
  let lb: LoadBalancer;

  beforeEach(() => {
    store = createMemoryStateStore();
    lb = new LoadBalancer(store);
  });

  // #488 — hash strategy is deterministic
  it('hash strategy returns deterministic result for same userId', async () => {
    const tiers = [readyState(0), readyState(1), readyState(2)];
    const idx1 = await lb.selectTier('user-1', tiers, 'hash');
    const idx2 = await lb.selectTier('user-1', tiers, 'hash');
    expect(idx1).toBe(idx2);
  });

  // #489 — returns -1 for empty tiers
  it('returns -1 when no tiers available', async () => {
    const idx = await lb.selectTier('user-1', [], 'hash');
    expect(idx).toBe(-1);
  });

  // #490 — returns 0 for single tier
  it('returns 0 when only one tier available', async () => {
    const idx = await lb.selectTier('user-1', [readyState(0)], 'hash');
    expect(idx).toBe(0);
  });

  // #491 — least-latency falls back to hash when no data
  it('least-latency falls back to hash when no latency data', async () => {
    const tiers = [readyState(0), readyState(1)];
    const idx = await lb.selectTier('user-1', tiers, 'least-latency');
    // Should return valid index (hash fallback)
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(tiers.length);
  });

  // #492 — least-latency selects lowest EMA
  it('least-latency selects tier with lowest EMA latency', async () => {
    const tiers = [readyState(0), readyState(1)];
    // Report higher latency for tier 0
    await lb.reportTierLatency('user-1', 0, 500);
    await lb.reportTierLatency('user-1', 1, 100);
    const idx = await lb.selectTier('user-1', tiers, 'least-latency');
    expect(idx).toBe(1);
  });

  // #493 — round-robin rotates
  it('weighted-round-robin rotates through tiers', async () => {
    const tiers = [readyState(0), readyState(1), readyState(2)];
    const results = new Set<number>();
    for (let i = 0; i < 6; i++) {
      results.add(await lb.selectTier('user-1', tiers, 'weighted-round-robin'));
    }
    expect(results.size).toBe(3); // Should visit all 3
  });

  // #494 — atomic connection counts
  it('incrementConnections and decrementConnections are consistent', async () => {
    await lb.incrementConnections(0);
    await lb.incrementConnections(0);
    await lb.incrementConnections(0);
    await lb.decrementConnections(0);

    const metrics = await (lb as any).getTierConnections(0);
    expect(metrics.activeConnections).toBe(2);
  });

  // #495 — decrement never goes below 0
  it('decrementConnections never goes below 0', async () => {
    await lb.decrementConnections(5);
    await lb.decrementConnections(5);
    const count = (lb as any).connectionCounts.get(5) ?? 0;
    expect(count).toBe(0);
  });

  // Additional — EMA latency reporting
  it('reportTierLatency calculates EMA correctly', async () => {
    await lb.reportTierLatency('user-1', 0, 100);
    const first = await lb.getTierLatency('user-1', 0);
    expect(first).not.toBeNull();
    expect(first!.emaLatencyMs).toBe(100);
    expect(first!.sampleCount).toBe(1);

    await lb.reportTierLatency('user-1', 0, 200);
    const second = await lb.getTierLatency('user-1', 0);
    expect(second!.sampleCount).toBe(2);
    // EMA = 0.3 * 200 + 0.7 * 100 = 130
    expect(second!.emaLatencyMs).toBeCloseTo(130, 0);
  });

  // Additional — rate limiting (token bucket)
  it('checkRateLimit allows when tokens available', async () => {
    const result = await lb.checkRateLimit('client-1');
    expect(result.allowed).toBe(true);
    expect(result.remainingTokens).toBeGreaterThanOrEqual(0);
  });

  // Additional — affinity strategy
  it('affinity strategy is sticky', async () => {
    const tiers = [readyState(0), readyState(1)];
    const first = await lb.selectTier('user-1', tiers, 'affinity');
    const second = await lb.selectTier('user-1', tiers, 'affinity');
    expect(first).toBe(second);
  });
});

// ── Session Tracker Tests (#496-#501) ────────────────────────────────────────

describe('SessionTracker', () => {
  let store: StateStore;
  let tracker: SessionTracker;
  let mockResolver: SessionResolver;

  beforeEach(() => {
    store = createMemoryStateStore();
    mockResolver = {
      countDbSessions: vi.fn().mockResolvedValue(0),
      resolveTeacher: vi.fn().mockResolvedValue(null),
    };
    tracker = new SessionTracker(store, mockResolver, silentLogger);
  });

  // #496 — report and count heartbeats
  it('reports and counts heartbeat sessions', async () => {
    await tracker.reportSessionHeartbeat('user-1', 'session-a');
    await tracker.reportSessionHeartbeat('user-1', 'session-b');
    const count = await tracker.countActiveSessions('user-1', 5);
    expect(count).toBe(2);
  });

  // #497 — remove heartbeat
  it('removes a heartbeat session', async () => {
    await tracker.reportSessionHeartbeat('user-1', 'session-a');
    await tracker.removeSessionHeartbeat('user-1', 'session-a');
    const count = await tracker.countActiveSessions('user-1', 5);
    expect(count).toBe(0);
  });

  // #498 — expired heartbeats are not counted
  it('does not count expired heartbeats', async () => {
    // Report a heartbeat manually with an old timestamp
    await store.hset('autoscaler:heartbeats:user-1', 'old-session', String(Date.now() - 10 * 60_000));
    const count = await tracker.countActiveSessions('user-1', 5); // 5 minute window
    expect(count).toBe(0);
  });

  // #499 — teacher aggregation
  it('aggregates heartbeats to teacher', async () => {
    (mockResolver.resolveTeacher as ReturnType<typeof vi.fn>).mockResolvedValue('teacher-1');
    await tracker.reportSessionHeartbeat('student-1', 'session-1');
    // Wait for async aggregation to complete
    await new Promise((r) => setTimeout(r, 50));

    // Check that teacher has the aggregated heartbeat
    const teacherHeartbeats = await store.hgetall('autoscaler:heartbeats:teacher-1');
    expect(Object.keys(teacherHeartbeats).length).toBeGreaterThan(0);
  });

  // #500 — teacher cache is bounded
  it('teacher cache does not grow unbounded', () => {
    const cache = (tracker as any).teacherCache as Map<string, unknown>;
    // Reset the clean timer to allow immediate clean
    (tracker as any).lastTeacherCacheClean = 0;
    // Fill it with 11k entries that are expired
    for (let i = 0; i < 11000; i++) {
      cache.set(`student-${i}`, { teacherId: 'teacher', expiresAt: Date.now() - 1 });
    }
    // Trigger clean — all entries are expired so they should be removed
    (tracker as any).cleanTeacherCache();
    // After clean, expired entries should be removed
    expect(cache.size).toBeLessThanOrEqual(10000);
  });

  // #501 — takes max of DB sessions and heartbeats
  it('returns max of DB sessions and heartbeat sessions', async () => {
    (mockResolver.countDbSessions as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    await tracker.reportSessionHeartbeat('user-1', 'session-a');
    await tracker.reportSessionHeartbeat('user-1', 'session-b');
    const count = await tracker.countActiveSessions('user-1', 5);
    expect(count).toBe(5); // DB=5 > heartbeats=2
  });
});

// ── Tier Selector Tests (#502-#505) ──────────────────────────────────────────

describe('TierSelector', () => {
  let selector: TierSelector;

  beforeEach(() => {
    selector = new TierSelector({
      registry: { getClient: vi.fn() } as any,
      logger: silentLogger,
    });
  });

  // #502 — isTierEligibleForBoot checks idle state
  it('only idle tiers are eligible for boot', () => {
    expect(selector.isTierEligibleForBoot(tierConfig(), idleState(0))).toBe(true);
    expect(selector.isTierEligibleForBoot(tierConfig(), readyState(0))).toBe(false);
    expect(selector.isTierEligibleForBoot(tierConfig(), bootingState(0))).toBe(false);
  });

  // #503 — manualStop prevents boot
  it('manualStop prevents tier from being eligible', () => {
    expect(selector.isTierEligibleForBoot(
      tierConfig(),
      idleState(0, { manualStop: true }),
    )).toBe(false);
  });

  // #504 — unhealthy prevents boot
  it('unhealthy prevents tier from being eligible', () => {
    expect(selector.isTierEligibleForBoot(
      tierConfig(),
      idleState(0, { unhealthy: true }),
    )).toBe(false);
  });

  // #505 — cooldown prevents boot
  it('cooldown prevents tier from being eligible', () => {
    expect(selector.isTierEligibleForBoot(
      tierConfig(),
      idleState(0, { cooldownUntil: Date.now() + 60_000 }),
    )).toBe(false);
  });

  // Additional — expired cooldown allows boot
  it('expired cooldown allows boot', () => {
    expect(selector.isTierEligibleForBoot(
      tierConfig(),
      idleState(0, { cooldownUntil: Date.now() - 1000 }),
    )).toBe(true);
  });

  // Additional — selectBestTierSync returns -1 when no eligible tiers
  it('returns -1 when no tiers are eligible', () => {
    const tiers = [tierConfig('runpod')];
    const states: GpuTierState[] = [readyState(0)]; // ready = not eligible for boot
    const mockMonitor = {
      getPriceInfo: vi.fn().mockReturnValue(null),
      getPriceUpdateIntervalMs: vi.fn().mockReturnValue(300_000),
      getSuccessRate: vi.fn().mockReturnValue(null),
      getAvgLatency: vi.fn().mockReturnValue(null),
    } as any;
    const idx = selector.selectBestTierSync(tiers, states, 'user-1', mockMonitor);
    expect(idx).toBe(-1);
  });

  // Additional — calculateTierScore returns score > 0 for valid tier
  it('calculateTierScore returns positive score for eligible idle tier', () => {
    const mockMonitor = {
      getPriceInfo: vi.fn().mockReturnValue(null),
      getPriceUpdateIntervalMs: vi.fn().mockReturnValue(300_000),
      getReliabilityScore: vi.fn().mockReturnValue(0.5),
      getSuccessRate: vi.fn().mockReturnValue(null),
      getAvgLatency: vi.fn().mockReturnValue(null),
    } as any;
    // Override registry with one that has a get() method
    const selectorWithRegistry = new TierSelector({
      registry: {
        getClient: vi.fn(),
        get: vi.fn().mockReturnValue({ bootTimeSecs: 600 }),
      } as any,
      logger: silentLogger,
    });
    const score = selectorWithRegistry.calculateTierScore(tierConfig(), idleState(0), 'user-1', mockMonitor);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});
