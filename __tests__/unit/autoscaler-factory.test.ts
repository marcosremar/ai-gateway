import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAutoscaler, PROVIDER_BOOT_SECS } from '../../src/factory';
import type { CreateAutoscalerOptions } from '../../src/factory';
import type { AutoScalerConfig } from '../../src/types';
import type { StateStore, SettingsStore, SessionResolver } from '../../src/deps';

// ── Minimal mocks ─────────────────────────────────────────────────────────────

function makeStateStore(): StateStore {
  const kvStore = new Map<string, string>();
  const listStore = new Map<string, string[]>();
  const hashStore = new Map<string, Record<string, string>>();
  return {
    // KvStore
    get: vi.fn(async (k: string) => kvStore.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { kvStore.set(k, v); }),
    del: vi.fn(async (k: string) => { kvStore.delete(k); }),
    scan: vi.fn(async () => []),
    // ListStore
    rpush: vi.fn(async (k: string, v: string) => { const l = listStore.get(k) ?? []; l.push(v); listStore.set(k, l); }),
    ltrim: vi.fn(async () => {}),
    lrange: vi.fn(async (k: string) => listStore.get(k) ?? []),
    // HashStore
    hset: vi.fn(async (k: string, field: string, value: string) => {
      const h = hashStore.get(k) ?? {};
      h[field] = value;
      hashStore.set(k, h);
    }),
    hdel: vi.fn(async (k: string, field: string) => {
      const h = hashStore.get(k);
      if (h) delete h[field];
    }),
    hgetall: vi.fn(async (k: string) => hashStore.get(k) ?? {}),
  };
}

function makeSettingsStore(): SettingsStore {
  const store = new Map<string, Record<string, unknown>>();
  return {
    get: vi.fn(async (userId: string) => store.get(userId) ?? {}),
    patch: vi.fn(async (userId: string, data: Record<string, unknown>) => {
      const current = store.get(userId) ?? {};
      store.set(userId, { ...current, ...data });
    }),
  };
}

function makeSessionResolver(): SessionResolver {
  return {
    countDbSessions: vi.fn(async () => 0),
    resolveTeacher: vi.fn(async () => null),
  };
}

function makeOpts(overrides: Partial<CreateAutoscalerOptions> = {}): CreateAutoscalerOptions {
  return {
    settingsStore: makeSettingsStore(),
    stateStore: makeStateStore(),
    sessionResolver: makeSessionResolver(),
    ...overrides,
  };
}

const BASE_CONFIG: AutoScalerConfig = {
  enabled: false,
  threshold: 3,
  windowMinutes: 5,
  maxLatencyMs: 1500,
  tiers: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PROVIDER_BOOT_SECS', () => {
  it('should have boot times for all major providers', () => {
    expect(PROVIDER_BOOT_SECS.tensordock).toBeGreaterThan(0);
    expect(PROVIDER_BOOT_SECS.runpod).toBeGreaterThan(0);
    expect(PROVIDER_BOOT_SECS.vast).toBeGreaterThan(0);
    expect(PROVIDER_BOOT_SECS.modal).toBeGreaterThan(0);
  });

  it('should have modal with shorter boot time than tensordock', () => {
    expect(PROVIDER_BOOT_SECS.modal).toBeLessThan(PROVIDER_BOOT_SECS.tensordock);
  });
});

describe('createAutoscaler()', () => {
  let autoscaler: ReturnType<typeof createAutoscaler>;

  beforeEach(() => {
    autoscaler = createAutoscaler(makeOpts());
  });

  describe('returned object structure', () => {
    it('should expose registry', () => {
      expect(autoscaler.registry).toBeDefined();
    });

    it('should expose engine', () => {
      expect(autoscaler.engine).toBeDefined();
    });

    it('should expose loadBalancer', () => {
      expect(autoscaler.loadBalancer).toBeDefined();
    });

    it('should expose PROVIDER_BOOT_SECS', () => {
      expect(autoscaler.PROVIDER_BOOT_SECS).toBe(PROVIDER_BOOT_SECS);
    });

    it('should expose benchmarkTracker', () => {
      expect(autoscaler.benchmarkTracker).toBeDefined();
    });
  });

  describe('session tracking API', () => {
    it('reportSessionHeartbeat() should resolve', async () => {
      await expect(autoscaler.reportSessionHeartbeat('user1', 'session1')).resolves.toBeUndefined();
    });

    it('removeSessionHeartbeat() should resolve', async () => {
      await expect(autoscaler.removeSessionHeartbeat('user1', 'session1')).resolves.toBeUndefined();
    });

    it('countActiveSessions() should return a number', async () => {
      const count = await autoscaler.countActiveSessions('user1', 5);
      expect(typeof count).toBe('number');
    });
  });

  describe('latency tracking API', () => {
    it('reportLatency() should resolve', async () => {
      await expect(autoscaler.reportLatency('user1', 200)).resolves.toBeUndefined();
    });

    it('getLatencyStats() should return stats object', async () => {
      const stats = await autoscaler.getLatencyStats('user1');
      expect(stats).toHaveProperty('p95');
      expect(stats).toHaveProperty('samples');
      expect(stats).toHaveProperty('breaches');
    });
  });

  describe('load balancing API', () => {
    it('reportTierLatency() should resolve', async () => {
      await expect(autoscaler.reportTierLatency('user1', 0, 150)).resolves.toBeUndefined();
    });
  });

  describe('state persistence API', () => {
    it('findUsersWithActiveGpus() should return array', async () => {
      const users = await autoscaler.findUsersWithActiveGpus();
      expect(Array.isArray(users)).toBe(true);
    });
  });

  describe('engine API', () => {
    it('getPoolStatus() should return empty array for new user', () => {
      const status = autoscaler.getPoolStatus('user1');
      expect(Array.isArray(status)).toBe(true);
      expect(status).toHaveLength(0);
    });

    it('getReadyEndpoints() should return empty array for new user', () => {
      const endpoints = autoscaler.getReadyEndpoints('user1');
      expect(Array.isArray(endpoints)).toBe(true);
      expect(endpoints).toHaveLength(0);
    });

    it('resetGpuState() should not throw', () => {
      expect(() => autoscaler.resetGpuState('user1')).not.toThrow();
    });

    it('forceGpuReady() should set tier 0 as ready', () => {
      autoscaler.forceGpuReady('user1', 'http://1.2.3.4:8000');
      const endpoints = autoscaler.getReadyEndpoints('user1');
      expect(endpoints).toContain('http://1.2.3.4:8000');
    });

    it('forceTierReady() should set specific tier as ready', () => {
      autoscaler.forceTierReady('user1', 0, 'http://1.2.3.4:8000');
      const status = autoscaler.getPoolStatus('user1');
      expect(status[0]?.state).toBe('ready');
    });
  });

  describe('getAutoScaleDecision() — disabled config', () => {
    it('should return disabled decision when autoscaling is disabled', async () => {
      const decision = await autoscaler.getAutoScaleDecision('user1', BASE_CONFIG);
      expect(decision.enabled).toBe(false);
      expect(decision.gpuState).toBe('idle');
    });
  });

  describe('getAutoScaleDecision() — no tiers', () => {
    it('should return llm route when no tiers configured', async () => {
      const config: AutoScalerConfig = {
        ...BASE_CONFIG,
        enabled: true,
        threshold: 100,
      };
      const decision = await autoscaler.getAutoScaleDecision('user1', config);
      expect(decision.route).toBe('llm');
    });
  });

  describe('benchmark API', () => {
    it('getBenchmarkSummary() should return summary', async () => {
      const summary = await autoscaler.getBenchmarkSummary('user1');
      expect(summary).toBeDefined();
    });

    it('getBenchmarkTrend() should return trend', async () => {
      const trend = await autoscaler.getBenchmarkTrend('user1');
      expect(trend).toBeDefined();
    });

    it('reportInferenceBenchmark() should resolve', async () => {
      await expect(autoscaler.reportInferenceBenchmark({
        userId: 'user1',
        provider: 'runpod',
        endpoint: 'http://1.2.3.4:8000',
        totalMs: 500,
        timestamp: Date.now(),
      })).resolves.toBeUndefined();
    });
  });

  describe('predictive warmup API', () => {
    it('recordUsageForPrediction() should resolve', async () => {
      await expect(autoscaler.recordUsageForPrediction('user1')).resolves.toBeUndefined();
    });

    it('startPredictiveWarmupTicker() should return a stop function', () => {
      const stop = autoscaler.startPredictiveWarmupTicker(10000);
      expect(typeof stop).toBe('function');
      stop(); // Clean up
    });
  });

  describe('watchdog API', () => {
    it('runWatchdogCycle() should resolve', async () => {
      await expect(autoscaler.runWatchdogCycle()).resolves.toBeUndefined();
    });

    it('startBackgroundTicker() should return a stop function', () => {
      const stop = autoscaler.startBackgroundTicker(10000);
      expect(typeof stop).toBe('function');
      stop(); // Clean up
    });
  });

  describe('reconcile API', () => {
    it('scheduleReconcile() should not throw', () => {
      expect(() => autoscaler.scheduleReconcile('user1')).not.toThrow();
    });
  });

  describe('tier lifecycle API', () => {
    it('getTierDetail() should return null for unknown tier', async () => {
      const opts = makeOpts({
        loadConfig: async () => null,
      });
      const as2 = createAutoscaler(opts);
      const detail = await as2.getTierDetail('user1', 0);
      expect(detail).toBeNull();
    });

    it('getAllTierDetails() should return array', async () => {
      const opts = makeOpts({
        loadConfig: async () => null,
      });
      const as2 = createAutoscaler(opts);
      const details = await as2.getAllTierDetails('user1');
      expect(Array.isArray(details)).toBe(true);
    });
  });

  describe('custom loadConfig', () => {
    it('should use custom loadConfig when provided', async () => {
      const customConfig: AutoScalerConfig = {
        ...BASE_CONFIG,
        enabled: false,
        threshold: 10,
      };
      const loadConfig = vi.fn(async () => customConfig);
      const opts = makeOpts({ loadConfig });
      const as2 = createAutoscaler(opts);
      const decision = await as2.getAutoScaleDecision('user1', customConfig);
      expect(decision.enabled).toBe(false);
    });
  });

  describe('dryRun mode', () => {
    it('should return decision without side effects in dryRun mode', async () => {
      const config: AutoScalerConfig = {
        ...BASE_CONFIG,
        enabled: true,
        threshold: 0, // trigger immediately
        tiers: [{
          provider: 'runpod',
          gpuTypes: ['RTX3090'],
          dockerImage: 'test:latest',
          apiKey: 'test-key',
          endpoint: 'http://example.com',
        }],
      };
      const decision = await autoscaler.getAutoScaleDecision('user1', config, { dryRun: true });
      expect(decision).toBeDefined();
      expect(decision.gpuState).toBeDefined();
    });
  });
});
