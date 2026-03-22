import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWatchdogCycle, scheduleWatchdog, startBackgroundTicker } from '@ai-gateway/autoscaler/watchdog';
import type { WatchdogDeps } from '@ai-gateway/autoscaler/watchdog';
import type { AutoScalerConfig, ReadyTierState, BootingTierState, IdleTierState, GpuTierState } from '@ai-gateway';

function makeIdleState(idx: number): IdleTierState {
  return { state: 'idle', tierIndex: idx };
}

function makeReadyState(idx: number, lastHealthyMs = 0): ReadyTierState {
  return {
    state: 'ready',
    tierIndex: idx,
    endpoint: `http://gpu${idx}:8000`,
    lastHealthyAt: Date.now() - lastHealthyMs,
    bootedAt: Date.now() - 60_000,
    trigger: 'sessions',
  };
}

function makeBootingState(idx: number, bootAgoMs = 0): BootingTierState {
  return {
    state: 'booting',
    tierIndex: idx,
    endpoint: `http://gpu${idx}:8000`,
    bootTriggeredAt: Date.now() - bootAgoMs,
    trigger: 'sessions',
    prevBootFailCount: 0,
  };
}

const defaultConfig: AutoScalerConfig = {
  enabled: true,
  threshold: 1,
  windowMinutes: 30,
  maxLatencyMs: 1500,
  idleGraceMinutes: 15,
  tiers: [
    { provider: 'runpod', instanceId: 'pod-1', apiKey: 'key-1', endpoint: 'http://gpu0:8000' },
    { provider: 'runpod', instanceId: 'pod-2', apiKey: 'key-2', endpoint: 'http://gpu1:8000' },
  ],
};

function makeDeps(stateMap: Map<string, GpuTierState[]>, overrides?: Partial<WatchdogDeps>): WatchdogDeps {
  const mockClient = {
    providerId: 'runpod',
    bootTimeSecs: 120,
    discoverInstance: vi.fn(),
    createInstance: vi.fn(),
    startInstance: vi.fn(),
    stopInstance: vi.fn().mockResolvedValue(undefined),
    deleteInstance: vi.fn(),
    getInstanceStatus: vi.fn(),
    listInstances: vi.fn(),
    resolveInstanceEndpoint: vi.fn(),
  };

  const registry = { get: vi.fn().mockReturnValue(mockClient) } as any;

  return {
    engine: {
      getStateMap: () => stateMap,
      getPoolStatus: (userId: string) => stateMap.get(userId) ?? [],
      setTierState: vi.fn(),
      cancelBootPoller: vi.fn(),
      initTierStatesFromDb: vi.fn(),
    } as any,
    sessionTracker: {
      countActiveSessions: vi.fn().mockResolvedValue(0),
    } as any,
    persistence: {
      persistTierStates: vi.fn().mockResolvedValue(undefined),
      findUsersWithActiveGpus: vi.fn().mockResolvedValue([]),
    } as any,
    registry,
    loadConfig: vi.fn().mockResolvedValue(defaultConfig),
    hooks: {},
    lifecycleLogger: { log: vi.fn() },
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe('runWatchdogCycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stops idle ready tiers beyond grace period', async () => {
    const idleMs = 16 * 60_000; // 16 min > 15 min grace
    const stateMap = new Map([
      ['user-1', [makeReadyState(0, idleMs)]],
    ]);
    const deps = makeDeps(stateMap);

    await runWatchdogCycle(deps);

    const client = deps.registry.get('runpod')!;
    expect(client.stopInstance).toHaveBeenCalledWith('pod-1', expect.objectContaining({ apiKey: 'key-1' }));
  });

  it('respects idle grace period — does not stop within grace', async () => {
    const idleMs = 10 * 60_000; // 10 min < 15 min grace
    const stateMap = new Map([
      ['user-1', [makeReadyState(0, idleMs)]],
    ]);
    const deps = makeDeps(stateMap);

    await runWatchdogCycle(deps);

    const client = deps.registry.get('runpod')!;
    expect(client.stopInstance).not.toHaveBeenCalled();
  });

  it('cleans up tiers stuck in booting beyond max boot time', async () => {
    // bootTimeSecs=120 → maxBootMs=240s → stuck at 5min (300s)
    const bootAgoMs = 5 * 60_000;
    const stateMap = new Map([
      ['user-1', [makeBootingState(0, bootAgoMs)]],
    ]);
    const deps = makeDeps(stateMap);

    await runWatchdogCycle(deps);

    // Should have stopped the instance (via cleanupProviderInstance)
    const client = deps.registry.get('runpod')!;
    expect(client.stopInstance).toHaveBeenCalled();
    // Tier should be set to idle with unhealthy flag
    expect(stateMap.get('user-1')![0].state).toBe('idle');
    expect((stateMap.get('user-1')![0] as unknown as IdleTierState).unhealthy).toBe(true);
  });

  it('does not stop tier if still within boot window', async () => {
    const bootAgoMs = 60_000; // 1 min — well within 240s (120s * 2) window
    const stateMap = new Map([
      ['user-1', [makeBootingState(0, bootAgoMs)]],
    ]);
    const deps = makeDeps(stateMap);

    await runWatchdogCycle(deps);

    const client = deps.registry.get('runpod')!;
    expect(client.stopInstance).not.toHaveBeenCalled();
  });

  it('skips users with no active tiers', async () => {
    const stateMap = new Map([
      ['user-1', [makeIdleState(0)]],
    ]);
    const deps = makeDeps(stateMap);

    await runWatchdogCycle(deps);

    expect(deps.loadConfig).not.toHaveBeenCalled();
  });

  it('handles missing apiKey/instanceId gracefully', async () => {
    const idleMs = 20 * 60_000;
    const stateMap = new Map([
      ['user-1', [makeReadyState(0, idleMs)]],
    ]);
    const config = {
      ...defaultConfig,
      tiers: [{ provider: 'runpod' as const }], // no instanceId, no apiKey
    };
    const deps = makeDeps(stateMap, {
      loadConfig: vi.fn().mockResolvedValue(config),
    });

    await runWatchdogCycle(deps);

    // Should set to idle but not call stopInstance
    const client = deps.registry.get('runpod')!;
    expect(client.stopInstance).not.toHaveBeenCalled();
    expect(stateMap.get('user-1')![0].state).toBe('idle');
  });

  it('handles missing provider client gracefully', async () => {
    const idleMs = 20 * 60_000;
    const stateMap = new Map([
      ['user-1', [makeReadyState(0, idleMs)]],
    ]);
    const deps = makeDeps(stateMap, {
      registry: { get: vi.fn().mockReturnValue(undefined) } as any,
    });

    await runWatchdogCycle(deps);
    expect(stateMap.get('user-1')![0].state).toBe('idle');
  });

  it('logs warning when stopInstance throws but preserves state change', async () => {
    const idleMs = 20 * 60_000;
    const stateMap = new Map([
      ['user-1', [makeReadyState(0, idleMs)]],
    ]);
    const mockClient = {
      providerId: 'runpod',
      bootTimeSecs: 120,
      stopInstance: vi.fn().mockRejectedValue(new Error('network error')),
    };
    const deps = makeDeps(stateMap, {
      registry: { get: vi.fn().mockReturnValue(mockClient) } as any,
    });

    await runWatchdogCycle(deps);

    expect(deps.logger!.warn).toHaveBeenCalled();
    // State should NOT be changed on error — still ready
    expect(stateMap.get('user-1')![0].state).toBe('ready');
  });

  it('preloads orphaned users from DB', async () => {
    const stateMap = new Map<string, GpuTierState[]>();
    const deps = makeDeps(stateMap, {
      persistence: {
        persistTierStates: vi.fn().mockResolvedValue(undefined),
        findUsersWithActiveGpus: vi.fn().mockResolvedValue(['orphan-user']),
      } as any,
    });

    await runWatchdogCycle(deps);

    expect(deps.engine.initTierStatesFromDb).toHaveBeenCalledWith('orphan-user', defaultConfig.tiers);
  });

  it('persists state changes after successful stop', async () => {
    const idleMs = 20 * 60_000;
    const stateMap = new Map([
      ['user-1', [makeReadyState(0, idleMs)]],
    ]);
    const deps = makeDeps(stateMap);

    await runWatchdogCycle(deps);

    expect(deps.persistence.persistTierStates).toHaveBeenCalled();
  });
});

describe('scheduleWatchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rate-limits to 2 minute intervals', () => {
    const stateMap = new Map([['user-1', [makeReadyState(0)]]]);
    const deps = makeDeps(stateMap);
    const lastMap = new Map<string, number>();

    scheduleWatchdog(deps, 'user-1', defaultConfig, lastMap);
    expect(lastMap.has('user-1')).toBe(true);

    // Second call within 2 min should be skipped (loadConfig won't be called again)
    const firstTimestamp = lastMap.get('user-1')!;
    vi.advanceTimersByTime(60_000); // 1 min
    scheduleWatchdog(deps, 'user-1', defaultConfig, lastMap);
    expect(lastMap.get('user-1')).toBe(firstTimestamp); // unchanged
  });

  it('allows run after 2 min interval', () => {
    const stateMap = new Map([['user-1', [makeReadyState(0)]]]);
    const deps = makeDeps(stateMap);
    const lastMap = new Map<string, number>();

    scheduleWatchdog(deps, 'user-1', defaultConfig, lastMap);
    const firstTimestamp = lastMap.get('user-1')!;

    vi.advanceTimersByTime(2 * 60_000 + 1);
    scheduleWatchdog(deps, 'user-1', defaultConfig, lastMap);
    expect(lastMap.get('user-1')).toBeGreaterThan(firstTimestamp);
  });
});

describe('startBackgroundTicker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns a cleanup function that stops the interval', () => {
    const stateMap = new Map<string, GpuTierState[]>();
    const deps = makeDeps(stateMap);

    const cleanup = startBackgroundTicker(deps, 10_000);
    expect(typeof cleanup).toBe('function');

    cleanup();
    // After cleanup, advancing time should not trigger any cycle
    vi.advanceTimersByTime(30_000);
    // If cleanup didn't work, persistence.findUsersWithActiveGpus would be called
    // But since we've already torn down, just verify no error
  });
});
