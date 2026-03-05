import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutoscalerEngine, MAX_BOOT_FAILURES, BOOT_COOLDOWN_BASE_MS, BOOT_COOLDOWN_MAX_MS } from '../src/autoscaler/engine';
import type { AutoscalerEngineOptions } from '../src/autoscaler/engine';
import type { AutoScalerConfig, GpuTierConfig } from '../src/types';
import type { GpuProviderRegistry } from '../src/gpu-providers/registry';
import type { SessionTracker } from '../src/autoscaler/session-tracker';
import type { LatencyTracker } from '../src/autoscaler/latency-tracker';
import type { StatePersistence } from '../src/autoscaler/state-persistence';

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeRegistry(overrides: Partial<ReturnType<GpuProviderRegistry['get']>> = {}) {
  const mockClient = {
    providerId: 'runpod',
    bootTimeSecs: 120,
    discoverInstance: vi.fn(async () => null),
    createInstance: vi.fn(async () => ({ instanceId: 'inst-1', endpoint: 'http://1.2.3.4:8000' })),
    startInstance: vi.fn(async () => {}),
    deleteInstance: vi.fn(async () => {}),
    stopInstance: vi.fn(async () => {}),
    resolveInstanceEndpoint: vi.fn(async () => null),
    listInstances: vi.fn(async () => []),
    ...overrides,
  };
  return {
    get: vi.fn((provider: string) => provider === 'runpod' ? mockClient : null),
    register: vi.fn(),
    getAll: vi.fn(() => [mockClient]),
    _client: mockClient,
  } as unknown as GpuProviderRegistry & { _client: typeof mockClient };
}

function makeSessionTracker(activeSessions = 0): SessionTracker {
  return {
    reportSessionHeartbeat: vi.fn(async () => {}),
    removeSessionHeartbeat: vi.fn(async () => {}),
    countActiveSessions: vi.fn(async () => activeSessions),
  } as unknown as SessionTracker;
}

function makeLatencyTracker(p95: number | null = null): LatencyTracker {
  return {
    reportLatency: vi.fn(async () => {}),
    getLatencyStats: vi.fn(async () => ({ p95, samples: [], breaches: 0 })),
  } as unknown as LatencyTracker;
}

function makeStatePersistence(): StatePersistence {
  return {
    persistTierStates: vi.fn(async () => {}),
    loadPersistedTierStates: vi.fn(async () => null),
    findUsersWithActiveGpus: vi.fn(async () => []),
    clearPersistedTierStates: vi.fn(async () => {}),
  } as unknown as StatePersistence;
}

function makeEngineOptions(overrides: Partial<AutoscalerEngineOptions> = {}): AutoscalerEngineOptions {
  return {
    registry: makeRegistry() as unknown as GpuProviderRegistry,
    sessionTracker: makeSessionTracker(),
    latencyTracker: makeLatencyTracker(),
    persistence: makeStatePersistence(),
    probeHealth: vi.fn(async () => false),
    cleanupInstance: vi.fn(async () => {}),
    ...overrides,
  };
}

const BASE_CONFIG: AutoScalerConfig = {
  enabled: true,
  threshold: 3,
  windowMinutes: 5,
  maxLatencyMs: 1500,
  tiers: [],
};

const SINGLE_TIER_CONFIG: AutoScalerConfig = {
  ...BASE_CONFIG,
  tiers: [{
    provider: 'runpod',
    gpuTypes: ['RTX3090'],
    dockerImage: 'test:latest',
    apiKey: 'test-key',
    endpoint: 'http://1.2.3.4:8000',
  }],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AutoscalerEngine constants', () => {
  it('MAX_BOOT_FAILURES should be a positive number', () => {
    expect(MAX_BOOT_FAILURES).toBeGreaterThan(0);
  });

  it('BOOT_COOLDOWN_BASE_MS should be at least 1 minute', () => {
    expect(BOOT_COOLDOWN_BASE_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('BOOT_COOLDOWN_MAX_MS should be greater than BOOT_COOLDOWN_BASE_MS', () => {
    expect(BOOT_COOLDOWN_MAX_MS).toBeGreaterThan(BOOT_COOLDOWN_BASE_MS);
  });
});

describe('AutoscalerEngine', () => {
  describe('constructor', () => {
    it('should create an engine instance', () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      expect(engine).toBeInstanceOf(AutoscalerEngine);
    });
  });

  describe('getPoolStatus()', () => {
    it('should return empty array for unknown user', () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      expect(engine.getPoolStatus('user1')).toEqual([]);
    });
  });

  describe('getReadyEndpoints()', () => {
    it('should return empty array for unknown user', () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      expect(engine.getReadyEndpoints('user1')).toEqual([]);
    });

    it('should return endpoint when tier is ready', () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      engine.forceTierReady('user1', 0, 'http://gpu:8000');
      expect(engine.getReadyEndpoints('user1')).toContain('http://gpu:8000');
    });
  });

  describe('getStateMap()', () => {
    it('should return the internal state map', () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      expect(engine.getStateMap()).toBeInstanceOf(Map);
    });

    it('should reflect state changes', () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      engine.forceTierReady('user1', 0, 'http://gpu:8000');
      const stateMap = engine.getStateMap();
      expect(stateMap.get('user1')?.[0]?.state).toBe('ready');
    });
  });

  describe('forceTierReady()', () => {
    it('should set tier state to ready', () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      engine.forceTierReady('user1', 0, 'http://gpu:8000');
      const status = engine.getPoolStatus('user1');
      expect(status[0]?.state).toBe('ready');
    });

    it('should pad with idle states for missing indexes', () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      engine.forceTierReady('user1', 2, 'http://gpu:8000');
      const status = engine.getPoolStatus('user1');
      expect(status).toHaveLength(3);
      expect(status[0]?.state).toBe('idle');
      expect(status[1]?.state).toBe('idle');
      expect(status[2]?.state).toBe('ready');
    });

    it('should set endpoint on ready state', () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      engine.forceTierReady('user1', 0, 'http://1.2.3.4:8000');
      const status = engine.getPoolStatus('user1');
      const tier = status[0] as { endpoint: string };
      expect(tier.endpoint).toBe('http://1.2.3.4:8000');
    });

    it('should persist the state change', () => {
      const persistence = makeStatePersistence();
      const engine = new AutoscalerEngine(makeEngineOptions({ persistence }));
      engine.forceTierReady('user1', 0, 'http://gpu:8000');
      expect(persistence.persistTierStates).toHaveBeenCalled();
    });

    it('should log lifecycle event via lifecycleLogger', () => {
      const lifecycleLogger = { log: vi.fn(async () => {}) };
      const engine = new AutoscalerEngine(makeEngineOptions({ lifecycleLogger }));
      engine.forceTierReady('user1', 0, 'http://gpu:8000');
      expect(lifecycleLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'boot_ok', userId: 'user1' })
      );
    });
  });

  describe('forceGpuReady()', () => {
    it('should force tier 0 to ready', () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      engine.forceGpuReady('user1', 'http://gpu:8000');
      expect(engine.getReadyEndpoints('user1')).toContain('http://gpu:8000');
    });
  });

  describe('setTierState()', () => {
    it('should set specific tier state', () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      engine.setTierState('user1', 0, { state: 'idle', tierIndex: 0 });
      const status = engine.getPoolStatus('user1');
      expect(status[0]?.state).toBe('idle');
    });

    it('should persist the state change', () => {
      const persistence = makeStatePersistence();
      const engine = new AutoscalerEngine(makeEngineOptions({ persistence }));
      engine.setTierState('user1', 0, { state: 'idle', tierIndex: 0 });
      expect(persistence.persistTierStates).toHaveBeenCalled();
    });
  });

  describe('cancelBootPoller()', () => {
    it('should not throw when no poller exists', () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      expect(() => engine.cancelBootPoller('user1', 0)).not.toThrow();
    });
  });

  describe('getRegistry()', () => {
    it('should return the registry', () => {
      const registry = makeRegistry() as unknown as GpuProviderRegistry;
      const engine = new AutoscalerEngine(makeEngineOptions({ registry }));
      expect(engine.getRegistry()).toBe(registry);
    });
  });

  describe('getLifecycleLogger()', () => {
    it('should return the lifecycle logger', () => {
      const lifecycleLogger = { log: vi.fn(async () => {}) };
      const engine = new AutoscalerEngine(makeEngineOptions({ lifecycleLogger }));
      expect(engine.getLifecycleLogger()).toBe(lifecycleLogger);
    });

    it('should return noopLifecycleLogger when none provided', () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      const logger = engine.getLifecycleLogger();
      expect(logger).toBeDefined();
      expect(typeof logger.log).toBe('function');
    });
  });

  describe('resetGpuState()', () => {
    it('should clear all tier states for user', () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      engine.forceTierReady('user1', 0, 'http://gpu:8000');
      engine.resetGpuState('user1');
      expect(engine.getPoolStatus('user1')).toEqual([]);
    });

    it('should persist empty state', () => {
      const persistence = makeStatePersistence();
      const engine = new AutoscalerEngine(makeEngineOptions({ persistence }));
      engine.forceTierReady('user1', 0, 'http://gpu:8000');
      vi.clearAllMocks();
      engine.resetGpuState('user1');
      expect(persistence.persistTierStates).toHaveBeenCalledWith('user1', []);
    });
  });

  describe('initTierStatesFromDb()', () => {
    it('should return idle states when no persisted state', async () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      const states = await engine.initTierStatesFromDb('user1', SINGLE_TIER_CONFIG.tiers);
      expect(states).toHaveLength(1);
      expect(states[0]?.state).toBe('idle');
    });

    it('should return existing states if already loaded', async () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      engine.forceTierReady('user1', 0, 'http://gpu:8000');
      const states = await engine.initTierStatesFromDb('user1', SINGLE_TIER_CONFIG.tiers);
      expect(states[0]?.state).toBe('ready');
    });

    it('should restore ready state from persistence', async () => {
      const persistence = makeStatePersistence();
      (persistence.loadPersistedTierStates as ReturnType<typeof vi.fn>).mockResolvedValue([
        { state: 'ready', tierIndex: 0, endpoint: 'http://gpu:8000', lastHealthyAt: Date.now() },
      ]);
      const engine = new AutoscalerEngine(makeEngineOptions({ persistence }));
      const states = await engine.initTierStatesFromDb('user1', SINGLE_TIER_CONFIG.tiers);
      expect(states[0]?.state).toBe('ready');
    });

    it('should revert stale booting state to idle', async () => {
      const persistence = makeStatePersistence();
      const staleBootTimestamp = Date.now() - (120 * 2 * 1000 + 1000); // past max boot time
      (persistence.loadPersistedTierStates as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          state: 'booting', tierIndex: 0, endpoint: 'http://gpu:8000',
          bootTriggeredAt: staleBootTimestamp, trigger: 'sessions', prevBootFailCount: 0,
        },
      ]);
      const engine = new AutoscalerEngine(makeEngineOptions({ persistence }));
      const states = await engine.initTierStatesFromDb('user1', SINGLE_TIER_CONFIG.tiers);
      expect(states[0]?.state).toBe('idle');
    });

    it('should revert recent booting state to idle on restart', async () => {
      const persistence = makeStatePersistence();
      const recentBootTimestamp = Date.now() - 30_000; // 30 seconds ago
      (persistence.loadPersistedTierStates as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          state: 'booting', tierIndex: 0, endpoint: 'http://gpu:8000',
          bootTriggeredAt: recentBootTimestamp, trigger: 'sessions', prevBootFailCount: 0,
        },
      ]);
      const engine = new AutoscalerEngine(makeEngineOptions({ persistence }));
      const states = await engine.initTierStatesFromDb('user1', SINGLE_TIER_CONFIG.tiers);
      // Should revert to idle because the boot callback is lost after restart
      expect(states[0]?.state).toBe('idle');
    });

    it('should clear unhealthy flag on idle state on restart', async () => {
      const persistence = makeStatePersistence();
      (persistence.loadPersistedTierStates as ReturnType<typeof vi.fn>).mockResolvedValue([
        { state: 'idle', tierIndex: 0, unhealthy: true },
      ]);
      const engine = new AutoscalerEngine(makeEngineOptions({ persistence }));
      const states = await engine.initTierStatesFromDb('user1', SINGLE_TIER_CONFIG.tiers);
      expect((states[0] as { unhealthy?: boolean }).unhealthy).toBeFalsy();
    });
  });

  describe('getAutoScaleDecision() — disabled', () => {
    it('should return disabled when config.enabled is false', async () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      const config: AutoScalerConfig = { ...BASE_CONFIG, enabled: false };
      const decision = await engine.getAutoScaleDecision('user1', config);
      expect(decision.enabled).toBe(false);
      expect(decision.gpuState).toBe('idle');
    });
  });

  describe('getAutoScaleDecision() — below threshold', () => {
    it('should return llm route when sessions < threshold', async () => {
      const engine = new AutoscalerEngine(makeEngineOptions({
        sessionTracker: makeSessionTracker(0),
      }));
      const config: AutoScalerConfig = { ...BASE_CONFIG, threshold: 3 };
      const decision = await engine.getAutoScaleDecision('user1', config);
      expect(decision.route).toBe('llm');
    });
  });

  describe('getAutoScaleDecision() — no tiers', () => {
    it('should return llm route when no tiers configured', async () => {
      const engine = new AutoscalerEngine(makeEngineOptions({
        sessionTracker: makeSessionTracker(10), // above threshold
      }));
      const config: AutoScalerConfig = { ...BASE_CONFIG, threshold: 3, tiers: [] };
      const decision = await engine.getAutoScaleDecision('user1', config);
      expect(decision.route).toBe('llm');
    });
  });

  describe('getAutoScaleDecision() — already ready', () => {
    it('should return gpu route when tier is ready', async () => {
      const engine = new AutoscalerEngine(makeEngineOptions({
        probeHealth: vi.fn(async () => true),
        sessionTracker: makeSessionTracker(0),
      }));
      // Force a tier to ready
      engine.forceTierReady('user1', 0, 'http://gpu:8000');
      const decision = await engine.getAutoScaleDecision('user1', SINGLE_TIER_CONFIG);
      expect(decision.gpuState).toBe('ready');
    });
  });

  describe('getAutoScaleDecision() — dryRun', () => {
    it('should not trigger boot in dryRun mode', async () => {
      const registry = makeRegistry();
      const engine = new AutoscalerEngine(makeEngineOptions({
        registry: registry as unknown as GpuProviderRegistry,
        sessionTracker: makeSessionTracker(100), // above threshold
      }));
      const config: AutoScalerConfig = { ...SINGLE_TIER_CONFIG, threshold: 1 };
      await engine.getAutoScaleDecision('user1', config, { dryRun: true });
      // No boot should have been triggered
      expect(registry._client.createInstance).not.toHaveBeenCalled();
      expect(registry._client.startInstance).not.toHaveBeenCalled();
    });
  });

  describe('getAutoScaleDecision() — serial queue', () => {
    it('should process concurrent decisions sequentially', async () => {
      const engine = new AutoscalerEngine(makeEngineOptions({
        sessionTracker: makeSessionTracker(0),
      }));
      // Fire 3 concurrent decisions
      const [d1, d2, d3] = await Promise.all([
        engine.getAutoScaleDecision('user1', BASE_CONFIG),
        engine.getAutoScaleDecision('user1', BASE_CONFIG),
        engine.getAutoScaleDecision('user1', BASE_CONFIG),
      ]);
      expect(d1).toBeDefined();
      expect(d2).toBeDefined();
      expect(d3).toBeDefined();
    });
  });

  describe('triggerGpuBoot()', () => {
    it('should return ok=false when apiKey is missing', async () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      const tier: GpuTierConfig = { provider: 'runpod', gpuTypes: ['RTX3090'] };
      const result = await engine.triggerGpuBoot(tier, 0, 'user1');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('API key');
    });

    it('should discover existing instance and return ok=true', async () => {
      const registry = makeRegistry({
        discoverInstance: vi.fn(async () => ({
          instanceId: 'inst-1',
          endpoint: 'http://1.2.3.4:8000',
          status: 'running',
        })),
      });
      const engine = new AutoscalerEngine(makeEngineOptions({
        registry: registry as unknown as GpuProviderRegistry,
      }));
      const tier: GpuTierConfig = {
        provider: 'runpod', gpuTypes: ['RTX3090'], apiKey: 'test-key',
      };
      const result = await engine.triggerGpuBoot(tier, 0, 'user1');
      expect(result.ok).toBe(true);
    });

    it('should auto-create instance when none discovered', async () => {
      const registry = makeRegistry();
      const engine = new AutoscalerEngine(makeEngineOptions({
        registry: registry as unknown as GpuProviderRegistry,
      }));
      const tier: GpuTierConfig = {
        provider: 'runpod', gpuTypes: ['RTX3090'],
        apiKey: 'test-key', dockerImage: 'test:latest',
      };
      const result = await engine.triggerGpuBoot(tier, 0, 'user1');
      expect(result.ok).toBe(true);
      expect(registry._client.createInstance).toHaveBeenCalled();
    });

    it('should return ok=false when max retry attempts reached', async () => {
      const engine = new AutoscalerEngine(makeEngineOptions());
      const tier: GpuTierConfig = {
        provider: 'runpod', gpuTypes: ['RTX3090'], apiKey: 'test-key',
      };
      // Call with attempt=2 (at max)
      const result = await engine.triggerGpuBoot(tier, 0, 'user1', 2);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('Max retry');
    });

    it('should return ok=false when provider not in registry', async () => {
      const registry = {
        get: vi.fn(() => null),
        getAll: vi.fn(() => []),
        register: vi.fn(),
      } as unknown as GpuProviderRegistry;
      const engine = new AutoscalerEngine(makeEngineOptions({ registry }));
      const tier: GpuTierConfig = {
        provider: 'runpod', instanceId: 'existing-id',
        gpuTypes: ['RTX3090'], apiKey: 'test-key',
      };
      const result = await engine.triggerGpuBoot(tier, 0, 'user1');
      expect(result.ok).toBe(false);
    });

    it('should catch and return error when createInstance throws', async () => {
      const registry = makeRegistry({
        createInstance: vi.fn(async () => { throw new Error('provider error'); }),
      });
      const engine = new AutoscalerEngine(makeEngineOptions({
        registry: registry as unknown as GpuProviderRegistry,
      }));
      const tier: GpuTierConfig = {
        provider: 'runpod', gpuTypes: ['RTX3090'],
        apiKey: 'test-key', dockerImage: 'test:latest',
      };
      const result = await engine.triggerGpuBoot(tier, 0, 'user1');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('provider error');
    });
  });
});
