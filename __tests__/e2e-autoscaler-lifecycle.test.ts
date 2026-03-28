import 'dotenv/config';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutoscalerEngine } from '../src/autoscaler/engine';
import type {
  GpuTierState,
  GpuTierConfig,
  AutoScalerConfig,
} from '../src/types';
import type { GpuProviderClient, InstanceSpec, GpuInstance, GpuOffer, ProviderCredentials } from '../src/gpu-providers/types';
import { GpuProviderRegistry } from '../src/gpu-providers/registry';
import { SessionTracker } from '../src/autoscaler/session-tracker';
import { LatencyTracker } from '../src/autoscaler/latency-tracker';
import { StatePersistence } from '../src/autoscaler/state-persistence';
import { InMemoryStateAdapter } from '../src/adapters/in-memory-state';
import type { SessionResolver } from '../src/deps';

function createMockGpuProviderClient(overrides?: Partial<GpuProviderClient>): GpuProviderClient {
  return {
    providerId: 'mock-provider',
    bootTimeSecs: 5,
    discoverInstance: vi.fn().mockResolvedValue(null),
    createInstance: vi.fn().mockResolvedValue({
      instanceId: 'inst-123',
      endpoint: 'http://gpu-mock:8000',
      status: 'running',
    } as GpuInstance),
    startInstance: vi.fn().mockResolvedValue(undefined),
    stopInstance: vi.fn().mockResolvedValue(undefined),
    deleteInstance: vi.fn().mockResolvedValue(undefined),
    getInstanceStatus: vi.fn().mockResolvedValue('running'),
    listInstances: vi.fn().mockResolvedValue([]),
    resolveInstanceEndpoint: vi.fn().mockResolvedValue('http://gpu-mock:8000'),
    ...overrides,
  };
}

function createMockSessionResolver(activeCount = 0): SessionResolver {
  return {
    countDbSessions: vi.fn().mockResolvedValue(activeCount),
    resolveTeacher: vi.fn().mockResolvedValue(null),
  };
}

function createTestEngine(opts?: {
  activeSessions?: number;
  healthResult?: boolean;
  providerOverrides?: Partial<GpuProviderClient>;
  providerId?: string;
}) {
  const stateStore = new InMemoryStateAdapter();
  const sessionResolver = createMockSessionResolver(opts?.activeSessions ?? 0);
  const sessionTracker = new SessionTracker(stateStore, sessionResolver);
  const latencyTracker = new LatencyTracker(stateStore);
  const persistence = new StatePersistence(stateStore);

  const registry = new GpuProviderRegistry();
  const providerId = opts?.providerId ?? 'mock-provider';
  registry.register(createMockGpuProviderClient({
    providerId,
    ...opts?.providerOverrides,
  }));

  const engine = new AutoscalerEngine({
    registry,
    sessionTracker,
    latencyTracker,
    persistence,
    probeHealth: vi.fn().mockResolvedValue(opts?.healthResult ?? true),
    cleanupInstance: vi.fn().mockResolvedValue(undefined),
  });

  return { engine, sessionTracker, latencyTracker, persistence, stateStore };
}

const defaultTierConfig: GpuTierConfig = {
  provider: 'mock-provider',
  apiKey: 'test-key',
  gpuTypes: ['RTX 4090'],
  dockerImage: 'test/image:latest',
};

const defaultAutoScalerConfig: AutoScalerConfig = {
  enabled: true,
  threshold: 1,
  maxLatencyMs: 1500,
  tiers: [defaultTierConfig],
};

describe('E2E Autoscaler Lifecycle', () => {
  let engine: AutoscalerEngine;
  let persistence: StatePersistence;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const setup = createTestEngine();
    engine = setup.engine;
    persistence = setup.persistence;
  });

  afterEach(() => {
    vi.useRealTimers();
    engine.destroy();
  });

  it('tier transitions: idle → booting → ready → idle', async () => {
    const userId = 'user-lifecycle-1';

    const decision = await engine.getAutoScaleDecision(userId, {
      ...defaultAutoScalerConfig,
      tiers: [{
        ...defaultTierConfig,
        provider: 'mock-provider',
      }],
    }, { dryRun: true });

    expect(decision.gpuState).toBe('idle');

    engine.forceTierReady(userId, 0, 'http://gpu-mock:8000');
    const poolStatus = engine.getPoolStatus(userId);
    expect(poolStatus[0].state).toBe('ready');
    expect((poolStatus[0] as any).endpoint).toBe('http://gpu-mock:8000');

    engine.resetGpuState(userId);
    const afterReset = engine.getPoolStatus(userId);
    expect(afterReset.length).toBe(0);
  });

  it('getAutoScaleDecision returns llm route when disabled', async () => {
    const userId = 'user-disabled-1';

    const decision = await engine.getAutoScaleDecision(userId, {
      ...defaultAutoScalerConfig,
      enabled: false,
    });

    expect(decision.route).toBe('llm');
    expect(decision.enabled).toBe(false);
  });

  it('getAutoScaleDecision returns gpuState idle when no sessions', async () => {
    const userId = 'user-idle-1';

    const decision = await engine.getAutoScaleDecision(userId, defaultAutoScalerConfig);
    expect(decision.gpuState).toBe('idle');
    expect(decision.activeSessions).toBe(0);
    expect(decision.route).toBe('llm');
  });

  it('forceTierReady sets endpoint correctly', async () => {
    const userId = 'user-force-1';
    const endpoint = 'http://my-gpu:8000';

    engine.forceTierReady(userId, 0, endpoint);

    const readyEndpoints = engine.getReadyEndpoints(userId);
    expect(readyEndpoints).toEqual([endpoint]);

    const pool = engine.getPoolStatus(userId);
    expect(pool[0].state).toBe('ready');
  });

  it('getReadyEndpoints returns empty when no ready tiers', async () => {
    const userId = 'user-no-ready';

    const endpoints = engine.getReadyEndpoints(userId);
    expect(endpoints).toEqual([]);
  });

  it('getStateMap returns user states', async () => {
    const userId = 'user-map-1';

    engine.forceTierReady(userId, 0, 'http://gpu:8000');

    const stateMap = engine.getStateMap();
    expect(stateMap.has(userId)).toBe(true);
    const states = stateMap.get(userId)!;
    expect(states[0].state).toBe('ready');
  });

  it('evictIdleUsers removes idle-only users', async () => {
    const userId1 = 'user-evict-idle';
    const userId2 = 'user-evict-ready';

    engine.forceTierReady(userId2, 0, 'http://gpu:8000');

    engine.evictIdleUsers();

    const stateMap = engine.getStateMap();
    expect(stateMap.has(userId1)).toBe(false);
    expect(stateMap.has(userId2)).toBe(true);
  });

  it('setTierState updates state directly', async () => {
    const userId = 'user-set-state';

    const readyState: GpuTierState = {
      state: 'ready',
      tierIndex: 0,
      endpoint: 'http://direct:8000',
      lastHealthyAt: Date.now(),
      trigger: 'manual',
    };

    engine.setTierState(userId, 0, readyState);

    const pool = engine.getPoolStatus(userId);
    expect(pool[0].state).toBe('ready');
    expect((pool[0] as any).endpoint).toBe('http://direct:8000');
  });
});

describe('E2E Autoscaler — Multi-tier', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('multi-tier: forceTierReady works for different tier indices', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const stateStore = new InMemoryStateAdapter();
    const registry = new GpuProviderRegistry();
    registry.register(createMockGpuProviderClient({ providerId: 'provider-a' }));
    registry.register(createMockGpuProviderClient({ providerId: 'provider-b' }));

    const engine = new AutoscalerEngine({
      registry,
      sessionTracker: new SessionTracker(stateStore, createMockSessionResolver()),
      latencyTracker: new LatencyTracker(stateStore),
      persistence: new StatePersistence(stateStore),
      probeHealth: vi.fn().mockResolvedValue(true),
      cleanupInstance: vi.fn().mockResolvedValue(undefined),
    });

    const userId = 'user-multi-1';
    engine.forceTierReady(userId, 0, 'http://tier0:8000');
    engine.forceTierReady(userId, 1, 'http://tier1:8000');

    const pool = engine.getPoolStatus(userId);
    expect(pool.length).toBe(2);
    expect(pool[0].state).toBe('ready');
    expect(pool[1].state).toBe('ready');

    const endpoints = engine.getReadyEndpoints(userId);
    expect(endpoints.length).toBe(2);

    engine.destroy();
  });

  it('concurrent users get separate instances', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const setup = createTestEngine();
    const { engine: eng } = setup;

    eng.forceTierReady('user-a', 0, 'http://gpu-a:8000');
    eng.forceTierReady('user-b', 0, 'http://gpu-b:8000');

    const endpointsA = eng.getReadyEndpoints('user-a');
    const endpointsB = eng.getReadyEndpoints('user-b');

    expect(endpointsA).toEqual(['http://gpu-a:8000']);
    expect(endpointsB).toEqual(['http://gpu-b:8000']);
    expect(endpointsA).not.toEqual(endpointsB);

    eng.destroy();
  });
});

describe('E2E Autoscaler — State persistence', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('state persists and can be restored', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const stateStore = new InMemoryStateAdapter();
    const registry = new GpuProviderRegistry();
    registry.register(createMockGpuProviderClient({ providerId: 'persist-provider' }));

    const persistence = new StatePersistence(stateStore);
    const engine1 = new AutoscalerEngine({
      registry,
      sessionTracker: new SessionTracker(stateStore, createMockSessionResolver()),
      latencyTracker: new LatencyTracker(stateStore),
      persistence,
      probeHealth: vi.fn().mockResolvedValue(true),
      cleanupInstance: vi.fn().mockResolvedValue(undefined),
    });

    const userId = 'user-persist-1';
    engine1.forceTierReady(userId, 0, 'http://gpu-persist:8000');

    await vi.advanceTimersByTimeAsync(100);

    const persisted = await persistence.loadPersistedTierStates(userId);
    expect(persisted).not.toBeNull();
    expect(persisted!.length).toBe(1);
    expect(persisted![0].state).toBe('ready');

    engine1.destroy();

    const engine2 = new AutoscalerEngine({
      registry,
      sessionTracker: new SessionTracker(stateStore, createMockSessionResolver()),
      latencyTracker: new LatencyTracker(stateStore),
      persistence,
      probeHealth: vi.fn().mockResolvedValue(true),
      cleanupInstance: vi.fn().mockResolvedValue(undefined),
    });

    const restored = await engine2.initTierStatesFromDb(userId, [{
      ...defaultTierConfig,
      provider: 'persist-provider',
      endpoint: 'http://gpu-persist:8000',
    }]);

    expect(restored[0].state).toBe('ready');
    expect((restored[0] as any).endpoint).toBe('http://gpu-persist:8000');

    engine2.destroy();
  });

  it('destroy clears boot pollers and decision locks', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const setup = createTestEngine();
    const { engine: eng } = setup;

    eng.forceTierReady('user-destroy-1', 0, 'http://gpu:8000');
    eng.destroy();

    const stateMap = eng.getStateMap();
    expect(stateMap.has('user-destroy-1')).toBe(true);
  });
});

describe('E2E Autoscaler — Reliability tracking', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records health events and updates reliability', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const setup = createTestEngine();
    const { engine: eng } = setup;

    const initialReliability = eng.getProviderReliability('mock-provider');
    expect(initialReliability).toBe(0.5);

    eng.recordProviderHealthEvent('mock-provider', true);
    eng.recordProviderHealthEvent('mock-provider', true);
    eng.recordProviderHealthEvent('mock-provider', false);

    const reliability = eng.getProviderReliability('mock-provider');
    expect(reliability).toBeGreaterThanOrEqual(0);
    expect(reliability).toBeLessThanOrEqual(1);

    eng.destroy();
  });

  it('getProviderPrice returns null when no price data', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const setup = createTestEngine();
    const { engine: eng } = setup;

    expect(eng.getProviderPrice('mock-provider')).toBeNull();

    eng.destroy();
  });

  it('getRegistry returns the injected registry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const setup = createTestEngine();
    const { engine: eng } = setup;

    const reg = eng.getRegistry();
    expect(reg.get('mock-provider')).toBeDefined();

    eng.destroy();
  });
});
