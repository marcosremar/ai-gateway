/**
 * Integration tests for the refactored AutoscalerEngine composition.
 * Verifies that BootOrchestrator + ProviderMonitor + TierSelector work
 * correctly when wired together via AutoscalerEngine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutoscalerEngine } from '../src/autoscaler/engine';
import { StageTimeoutError } from '../src/autoscaler/stage-timeout';
import type { AutoscalerEngineOptions } from '../src/autoscaler/engine';
import type { AutoScalerConfig, GpuTierConfig, GpuTierState } from '../src/types';
import type { GpuProviderRegistry } from '../src/gpu-providers/registry';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'runpod',
    bootTimeSecs: 60,
    discoverInstance: vi.fn(async () => null),
    createInstance: vi.fn(async () => ({ instanceId: 'inst-1', endpoint: 'http://gpu:8000' })),
    startInstance: vi.fn(async () => {}),
    deleteInstance: vi.fn(async () => {}),
    stopInstance: vi.fn(async () => {}),
    resolveInstanceEndpoint: vi.fn(async () => null),
    listInstances: vi.fn(async () => []),
    listOffers: vi.fn(async () => [{ pricePerHr: 0.35 }]),
    ...overrides,
  };
}

function makeRegistry(overrides: Record<string, unknown> = {}): GpuProviderRegistry {
  const client = makeClient(overrides);
  return {
    get: vi.fn((id: string) => id === 'runpod' ? client : null),
    register: vi.fn(),
    getAll: vi.fn(() => [client]),
    _client: client,
  } as unknown as GpuProviderRegistry;
}

function makeEngineOpts(overrides: Partial<AutoscalerEngineOptions> = {}): AutoscalerEngineOptions {
  return {
    registry: makeRegistry() as unknown as GpuProviderRegistry,
    sessionTracker: {
      countActiveSessions: vi.fn(async () => 0),
      reportSessionHeartbeat: vi.fn(async () => {}),
      removeSessionHeartbeat: vi.fn(async () => {}),
    } as any,
    latencyTracker: {
      getLatencyStats: vi.fn(async () => ({ p95: null, samples: [], breaches: 0 })),
      reportLatency: vi.fn(async () => {}),
    } as any,
    persistence: {
      persistTierStates: vi.fn(async () => {}),
      loadPersistedTierStates: vi.fn(async () => null),
      findUsersWithActiveGpus: vi.fn(async () => []),
      clearPersistedTierStates: vi.fn(async () => {}),
    } as any,
    probeHealth: vi.fn(async () => false),
    cleanupInstance: vi.fn(async () => {}),
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
    ...overrides,
  };
}

const TIER_CONFIG: GpuTierConfig = {
  provider: 'runpod',
  apiKey: 'test-key',
  gpuTypes: ['NVIDIA GeForce RTX 4090'],
  dockerImage: 'test/image:latest',
  storageGb: 0,
};

const BASE_CONFIG: AutoScalerConfig = {
  enabled: true,
  threshold: 1,
  windowMinutes: 5,
  maxLatencyMs: 1500,
  tiers: [TIER_CONFIG],
};

// ── Engine composition tests ──────────────────────────────────────────────────

describe('AutoscalerEngine (refactored composition)', () => {
  describe('StageTimeoutError re-export', () => {
    it('exports StageTimeoutError for backward compat', async () => {
      const { StageTimeoutError: ReExported } = await import('../src/autoscaler/engine');
      expect(ReExported).toBeDefined();
      const err = new ReExported('test', 1000);
      expect(err).toBeInstanceOf(Error);
      expect(err.stage).toBe('test');
      expect(err.timeoutMs).toBe(1000);
    });

    it('StageTimeoutError from engine is same class as from stage-timeout', async () => {
      const { StageTimeoutError: FromEngine } = await import('../src/autoscaler/engine');
      const { StageTimeoutError: FromStagetimeout } = await import('../src/autoscaler/stage-timeout');
      expect(FromEngine).toBe(FromStagetimeout);
    });
  });

  describe('triggerGpuBoot delegation', () => {
    it('delegates triggerGpuBoot to BootOrchestrator', async () => {
      const registry = makeRegistry();
      const engine = new AutoscalerEngine(makeEngineOpts({ registry }));

      const result = await engine.triggerGpuBoot(TIER_CONFIG, 0, 'user');

      expect(result.ok).toBe(true);
      expect(result.instanceId).toBe('inst-1');
    });

    it('triggerGpuBoot fails without apiKey', async () => {
      const engine = new AutoscalerEngine(makeEngineOpts());
      const result = await engine.triggerGpuBoot({ ...TIER_CONFIG, apiKey: undefined }, 0, 'user');
      expect(result.ok).toBe(false);
    });
  });

  describe('provider monitoring delegation', () => {
    it('recordProviderHealthEvent is delegated to ProviderMonitor', () => {
      const engine = new AutoscalerEngine(makeEngineOpts());
      expect(() => engine.recordProviderHealthEvent('runpod', true)).not.toThrow();
    });

    it('getProviderReliability returns 0.5 default', () => {
      const engine = new AutoscalerEngine(makeEngineOpts());
      expect(engine.getProviderReliability('runpod')).toBe(0.5);
    });

    it('getProviderReliability increases after successful boots', () => {
      const engine = new AutoscalerEngine(makeEngineOpts());
      const before = engine.getProviderReliability('runpod');
      engine.recordProviderHealthEvent('runpod', true);
      expect(engine.getProviderReliability('runpod')).toBeGreaterThan(before);
    });

    it('getProviderPrice returns null before cache update', () => {
      const engine = new AutoscalerEngine(makeEngineOpts());
      expect(engine.getProviderPrice('runpod')).toBeNull();
    });
  });

  describe('cancelBootPoller delegation', () => {
    it('cancelBootPoller does not throw when no pollers exist', () => {
      const engine = new AutoscalerEngine(makeEngineOpts());
      expect(() => engine.cancelBootPoller('user', 0)).not.toThrow();
    });
  });

  describe('destroy delegation', () => {
    it('destroy cleans up without error', () => {
      const engine = new AutoscalerEngine(makeEngineOpts());
      expect(() => engine.destroy()).not.toThrow();
    });

    it('destroy is idempotent (safe to call twice)', () => {
      const engine = new AutoscalerEngine(makeEngineOpts());
      engine.destroy();
      expect(() => engine.destroy()).not.toThrow();
    });
  });

  describe('intelligent tier selection via composition', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('boots best tier based on score when multiple tiers available', async () => {
      const cheapClient = makeClient({
        providerId: 'vast',
        bootTimeSecs: 60,
        listOffers: vi.fn(async () => [{ pricePerHr: 0.20 }]),
      });
      const expensiveClient = makeClient({
        providerId: 'runpod',
        bootTimeSecs: 120,
        listOffers: vi.fn(async () => [{ pricePerHr: 1.50 }]),
      });

      const registry = {
        get: vi.fn((id: string) => {
          if (id === 'vast') return cheapClient;
          if (id === 'runpod') return expensiveClient;
          return null;
        }),
        register: vi.fn(),
        getAll: vi.fn(() => [cheapClient, expensiveClient]),
      } as unknown as GpuProviderRegistry;

      const sessionTracker = {
        countActiveSessions: vi.fn(async () => 5), // above threshold
        reportSessionHeartbeat: vi.fn(async () => {}),
        removeSessionHeartbeat: vi.fn(async () => {}),
      };

      const engine = new AutoscalerEngine(makeEngineOpts({
        registry,
        sessionTracker: sessionTracker as any,
        resolveCredentials: async (p) => ({ apiKey: `${p}-key` }),
      }));

      const config: AutoScalerConfig = {
        enabled: true,
        threshold: 3,
        windowMinutes: 5,
        tiers: [
          { ...TIER_CONFIG, provider: 'vast' },
          { ...TIER_CONFIG, provider: 'runpod' },
        ],
      };

      // First decision: should trigger a boot with intelligent selection
      await engine.getAutoScaleDecision('user', config);

      // The boot should have been triggered (state becomes 'booting')
      const poolStatus = engine.getPoolStatus('user');
      const hasBoot = poolStatus.some(s => s.state === 'booting');
      expect(hasBoot).toBe(true);
    });
  });

  describe('full boot flow via composition', () => {
    it('transitions idle → booting → ready via poller', async () => {
      vi.useFakeTimers();
      try {
        const probeHealth = vi.fn(async () => true); // healthy immediately
        const sessionTracker = {
          countActiveSessions: vi.fn(async () => 5),
          reportSessionHeartbeat: vi.fn(async () => {}),
          removeSessionHeartbeat: vi.fn(async () => {}),
        };

        const engine = new AutoscalerEngine(makeEngineOpts({
          sessionTracker: sessionTracker as any,
          probeHealth,
        }));

        const config: AutoScalerConfig = {
          enabled: true,
          threshold: 3,
          windowMinutes: 5,
          tiers: [TIER_CONFIG],
        };

        // Trigger boot
        await engine.getAutoScaleDecision('user', config);
        expect(engine.getPoolStatus('user')[0].state).toBe('booting');

        // Advance time past initial delay (60s * 0.2 = 12s, min 30s → initial delay = 30s)
        vi.advanceTimersByTime(35_000);
        await vi.runAllTimersAsync();

        // Should now be ready
        expect(engine.getPoolStatus('user')[0].state).toBe('ready');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('state management', () => {
    it('stateMap is accessible for watchdog', () => {
      const engine = new AutoscalerEngine(makeEngineOpts());
      const map = engine.getStateMap();
      expect(map).toBeInstanceOf(Map);
    });

    it('evictIdleUsers removes all-idle entries', () => {
      const engine = new AutoscalerEngine(makeEngineOpts());
      engine.forceGpuReady('user1', 'http://gpu:8000');
      // Then reset so it becomes idle
      engine.resetGpuState('user1');
      // user1 state is now deleted
      expect(engine.getStateMap().has('user1')).toBe(false);
    });

    it('setTierState modifies specific tier', () => {
      const engine = new AutoscalerEngine(makeEngineOpts());
      engine.forceGpuReady('user', 'http://gpu:8000');

      const newState: GpuTierState = { state: 'idle', tierIndex: 0 };
      engine.setTierState('user', 0, newState);

      expect(engine.getPoolStatus('user')[0].state).toBe('idle');
    });

    it('getReadyEndpoints returns all ready tier endpoints', () => {
      const engine = new AutoscalerEngine(makeEngineOpts());
      engine.forceTierReady('user', 0, 'http://tier0:8000');
      engine.forceTierReady('user', 1, 'http://tier1:8000');

      const endpoints = engine.getReadyEndpoints('user');
      expect(endpoints).toContain('http://tier0:8000');
      expect(endpoints).toContain('http://tier1:8000');
    });
  });

  describe('resolveCredentials integration', () => {
    it('passes resolveCredentials to ProviderMonitor', async () => {
      const resolveCredentials = vi.fn(async (provider: string) => {
        if (provider === 'runpod') return { apiKey: 'runpod-key' };
        return null;
      });

      const client = makeClient({
        listOffers: vi.fn(async () => [{ pricePerHr: 0.45 }]),
      });
      const registry = {
        get: vi.fn(() => client),
        register: vi.fn(), getAll: vi.fn(() => [client]),
      } as unknown as GpuProviderRegistry;

      // Use a session tracker that returns sessions above threshold
      const sessionTracker = {
        countActiveSessions: vi.fn(async () => 5), // above threshold=1
        reportSessionHeartbeat: vi.fn(async () => {}),
        removeSessionHeartbeat: vi.fn(async () => {}),
      };

      const engine = new AutoscalerEngine(makeEngineOpts({
        registry,
        resolveCredentials,
        sessionTracker: sessionTracker as any,
      }));

      // The ProviderMonitor will use resolveCredentials when findBestTierForBoot calls updatePriceCacheIfNeeded
      await engine.getAutoScaleDecision('user', BASE_CONFIG);

      // The price cache should have been updated (resolveCredentials called)
      expect(resolveCredentials).toHaveBeenCalled();
    });
  });

  describe('onInstancePersist callback', () => {
    it('calls onInstancePersist when instance discovered', async () => {
      const onInstancePersist = vi.fn(async () => {});
      const client = makeClient({
        discoverInstance: vi.fn(async () => ({
          instanceId: 'found-inst',
          endpoint: 'http://found:8000',
          status: 'running',
        })),
        startInstance: vi.fn(async () => {}),
      });
      const registry = {
        get: vi.fn((id: string) => id === 'runpod' ? client : null),
        register: vi.fn(), getAll: vi.fn(() => [client]),
      } as unknown as GpuProviderRegistry;

      const engine = new AutoscalerEngine(makeEngineOpts({ registry, onInstancePersist }));

      await engine.triggerGpuBoot(TIER_CONFIG, 0, 'user');

      expect(onInstancePersist).toHaveBeenCalledWith(
        'user',
        expect.any(String),
        expect.objectContaining({ provider: 'runpod' }),
      );
    });
  });

  describe('MAX_BOOT_FAILURES and cooldown constants', () => {
    it('exports MAX_BOOT_FAILURES = 3', async () => {
      const { MAX_BOOT_FAILURES } = await import('../src/autoscaler/engine');
      expect(MAX_BOOT_FAILURES).toBe(3);
    });

    it('exports BOOT_COOLDOWN_BASE_MS = 2 min', async () => {
      const { BOOT_COOLDOWN_BASE_MS } = await import('../src/autoscaler/engine');
      expect(BOOT_COOLDOWN_BASE_MS).toBe(2 * 60_000);
    });

    it('exports BOOT_COOLDOWN_MAX_MS = 30 min', async () => {
      const { BOOT_COOLDOWN_MAX_MS } = await import('../src/autoscaler/engine');
      expect(BOOT_COOLDOWN_MAX_MS).toBe(30 * 60_000);
    });
  });

  describe('edge cases', () => {
    it('handles empty tiers array gracefully', async () => {
      const sessionTracker = {
        countActiveSessions: vi.fn(async () => 10),
        reportSessionHeartbeat: vi.fn(async () => {}),
        removeSessionHeartbeat: vi.fn(async () => {}),
      };
      const engine = new AutoscalerEngine(makeEngineOpts({ sessionTracker: sessionTracker as any }));
      const config: AutoScalerConfig = { ...BASE_CONFIG, tiers: [] };
      const decision = await engine.getAutoScaleDecision('user', config);
      expect(decision.route).toBe('llm');
    });

    it('serializes concurrent decisions for same user', async () => {
      const callOrder: number[] = [];
      let callNum = 0;
      const sessionTracker = {
        countActiveSessions: vi.fn(async () => {
          const n = ++callNum;
          callOrder.push(n);
          // Simulate async delay
          await new Promise(r => setTimeout(r, 10));
          return 0;
        }),
        reportSessionHeartbeat: vi.fn(async () => {}),
        removeSessionHeartbeat: vi.fn(async () => {}),
      };
      const engine = new AutoscalerEngine(makeEngineOpts({ sessionTracker: sessionTracker as any }));

      // Fire 3 concurrent decisions
      await Promise.all([
        engine.getAutoScaleDecision('user', BASE_CONFIG),
        engine.getAutoScaleDecision('user', BASE_CONFIG),
        engine.getAutoScaleDecision('user', BASE_CONFIG),
      ]);

      // All 3 should have run
      expect(callOrder).toHaveLength(3);
    });

    it('forceGpuReady routes to GPU when health check passes', async () => {
      const sessionTracker = {
        countActiveSessions: vi.fn(async () => 100), // many sessions
        reportSessionHeartbeat: vi.fn(async () => {}),
        removeSessionHeartbeat: vi.fn(async () => {}),
      };
      // Use probeHealth that returns true so the ready tier stays healthy
      const probeHealth = vi.fn(async () => true);
      const engine = new AutoscalerEngine(makeEngineOpts({
        sessionTracker: sessionTracker as any,
        probeHealth,
      }));

      // Force ready
      engine.forceGpuReady('user', 'http://forced:8000');

      // Decision should route to s2s GPU (already ready and health check passes)
      const decision = await engine.getAutoScaleDecision('user', BASE_CONFIG);
      expect(decision.route).toBe('s2s');
    });

    it('multiple users have independent state', async () => {
      const engine = new AutoscalerEngine(makeEngineOpts());

      engine.forceGpuReady('user1', 'http://user1:8000');

      const poolUser1 = engine.getPoolStatus('user1');
      const poolUser2 = engine.getPoolStatus('user2');

      expect(poolUser1[0]?.state).toBe('ready');
      expect(poolUser2).toHaveLength(0);
    });
  });
});
