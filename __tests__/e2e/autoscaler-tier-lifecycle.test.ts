import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  stopTier,
  startTier,
  deleteTier,
  restartTier,
  deployTier,
  getTierDetail,
  getAllTierDetails,
} from '@ai-gateway/autoscaler/tier-lifecycle';
import type { TierLifecycleDeps } from '@ai-gateway/autoscaler/tier-lifecycle';
import type {
  AutoScalerConfig,
  GpuTierState,
  IdleTierState,
  ReadyTierState,
  BootingTierState,
} from '@ai-gateway';

const defaultConfig: AutoScalerConfig = {
  enabled: true,
  threshold: 1,
  windowMinutes: 30,
  maxLatencyMs: 1500,
  tiers: [
    {
      provider: 'runpod',
      instanceId: 'pod-1',
      apiKey: 'key-1',
      authId: 'auth-1',
      endpoint: 'http://gpu0:8000',
    },
    { provider: 'runpod', instanceId: 'pod-2', apiKey: 'key-2', endpoint: 'http://gpu1:8000' },
  ],
};

function makeMockClient() {
  return {
    providerId: 'runpod',
    bootTimeSecs: 120,
    discoverInstance: vi.fn(),
    createInstance: vi
      .fn()
      .mockResolvedValue({ instanceId: 'new-pod', endpoint: 'http://new:8000' }),
    startInstance: vi.fn().mockResolvedValue(undefined),
    stopInstance: vi.fn().mockResolvedValue(undefined),
    deleteInstance: vi.fn().mockResolvedValue(undefined),
    getInstanceStatus: vi.fn().mockResolvedValue('RUNNING'),
    listInstances: vi.fn(),
    resolveInstanceEndpoint: vi.fn(),
  };
}

let poolStatus: GpuTierState[];
let mockClient: ReturnType<typeof makeMockClient>;

function makeDeps(overrides?: Partial<TierLifecycleDeps>): TierLifecycleDeps {
  mockClient = makeMockClient();
  return {
    engine: {
      getPoolStatus: vi.fn(() => poolStatus),
      setTierState: vi.fn((userId: string, idx: number, state: GpuTierState) => {
        poolStatus[idx] = state;
      }),
      cancelBootPoller: vi.fn(),
    } as any,
    registry: { get: vi.fn().mockReturnValue(mockClient) } as any,
    lifecycleLogger: { log: vi.fn() },
    loadConfig: vi.fn().mockResolvedValue(defaultConfig),
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

describe('stopTier', () => {
  beforeEach(() => {
    poolStatus = [
      {
        state: 'ready',
        tierIndex: 0,
        endpoint: 'http://gpu0:8000',
        lastHealthyAt: Date.now(),
        bootedAt: Date.now(),
      } as ReadyTierState,
    ];
  });

  it('stops a ready tier and sets state to idle', async () => {
    const deps = makeDeps();
    const result = await stopTier(deps, 'user-1', 0);
    expect(result.ok).toBe(true);
    expect(result.previousState).toBe('ready');
    expect(result.newState).toBe('idle');
    expect(mockClient.stopInstance).toHaveBeenCalledWith('pod-1', {
      apiKey: 'key-1',
      authId: 'auth-1',
    });
  });

  it('returns success for already-idle tier', async () => {
    poolStatus = [{ state: 'idle', tierIndex: 0 } as IdleTierState];
    const deps = makeDeps();
    const result = await stopTier(deps, 'user-1', 0);
    expect(result.ok).toBe(true);
    expect(result.previousState).toBe('idle');
    expect(result.newState).toBe('idle');
    expect(mockClient.stopInstance).not.toHaveBeenCalled();
  });

  it('treats 404 as success', async () => {
    const client = makeMockClient();
    client.stopInstance.mockRejectedValue(new Error('instance not found'));
    const deps = makeDeps({ registry: { get: vi.fn().mockReturnValue(client) } as any });
    const result = await stopTier(deps, 'user-1', 0);
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('idle');
  });

  it('returns error for real API failures', async () => {
    const client = makeMockClient();
    client.stopInstance.mockRejectedValue(new Error('server error'));
    const deps = makeDeps({ registry: { get: vi.fn().mockReturnValue(client) } as any });
    const result = await stopTier(deps, 'user-1', 0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('server error');
  });

  it('returns error when tier not found in config', async () => {
    const deps = makeDeps();
    const result = await stopTier(deps, 'user-1', 99);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('cancels boot poller', async () => {
    poolStatus = [
      {
        state: 'booting',
        tierIndex: 0,
        endpoint: '',
        bootTriggeredAt: Date.now(),
        trigger: 'manual',
        prevBootFailCount: 0,
      } as BootingTierState,
    ];
    const deps = makeDeps();
    await stopTier(deps, 'user-1', 0);
    expect(deps.engine.cancelBootPoller).toHaveBeenCalledWith('user-1', 0);
  });
});

describe('startTier', () => {
  beforeEach(() => {
    poolStatus = [{ state: 'idle', tierIndex: 0 } as IdleTierState];
  });

  it('starts an idle tier and sets state to booting', async () => {
    const deps = makeDeps();
    const result = await startTier(deps, 'user-1', 0);
    expect(result.ok).toBe(true);
    expect(result.previousState).toBe('idle');
    expect(result.newState).toBe('booting');
    expect(mockClient.startInstance).toHaveBeenCalledWith('pod-1', {
      apiKey: 'key-1',
      authId: 'auth-1',
    });
  });

  it('returns success if already booting', async () => {
    poolStatus = [
      {
        state: 'booting',
        tierIndex: 0,
        endpoint: '',
        bootTriggeredAt: Date.now(),
        trigger: 'manual',
        prevBootFailCount: 0,
      } as BootingTierState,
    ];
    const deps = makeDeps();
    const result = await startTier(deps, 'user-1', 0);
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('booting');
    expect(mockClient.startInstance).not.toHaveBeenCalled();
  });

  it('returns error when no instanceId configured', async () => {
    const config = {
      ...defaultConfig,
      tiers: [{ provider: 'runpod' as const, apiKey: 'key-1' }],
    };
    const deps = makeDeps({ loadConfig: vi.fn().mockResolvedValue(config) });
    const result = await startTier(deps, 'user-1', 0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('instanceId');
  });
});

describe('deleteTier', () => {
  beforeEach(() => {
    poolStatus = [
      {
        state: 'ready',
        tierIndex: 0,
        endpoint: 'http://gpu0:8000',
        lastHealthyAt: Date.now(),
      } as ReadyTierState,
    ];
  });

  it('stops then deletes instance and sets state to idle', async () => {
    const deps = makeDeps();
    const result = await deleteTier(deps, 'user-1', 0);
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('idle');
    expect(mockClient.stopInstance).toHaveBeenCalled();
    expect(mockClient.deleteInstance).toHaveBeenCalled();
  });

  it('continues to delete even if stop returns 404', async () => {
    const client = makeMockClient();
    client.stopInstance.mockRejectedValue(new Error('not found'));
    const deps = makeDeps({ registry: { get: vi.fn().mockReturnValue(client) } as any });
    const result = await deleteTier(deps, 'user-1', 0);
    expect(result.ok).toBe(true);
    expect(client.deleteInstance).toHaveBeenCalled();
  });

  it('returns error if delete fails with non-404', async () => {
    const client = makeMockClient();
    client.deleteInstance.mockRejectedValue(new Error('permission denied'));
    const deps = makeDeps({ registry: { get: vi.fn().mockReturnValue(client) } as any });
    const result = await deleteTier(deps, 'user-1', 0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('permission denied');
  });
});

describe('restartTier', () => {
  beforeEach(() => {
    poolStatus = [
      {
        state: 'ready',
        tierIndex: 0,
        endpoint: 'http://gpu0:8000',
        lastHealthyAt: Date.now(),
      } as ReadyTierState,
    ];
  });

  it('stops then starts the tier', async () => {
    const deps = makeDeps();
    const result = await restartTier(deps, 'user-1', 0);
    expect(result.ok).toBe(true);
    expect(result.previousState).toBe('ready');
    expect(result.newState).toBe('booting');
  });

  it('returns stop error if stop fails', async () => {
    const client = makeMockClient();
    client.stopInstance.mockRejectedValue(new Error('server error'));
    const deps = makeDeps({ registry: { get: vi.fn().mockReturnValue(client) } as any });
    const result = await restartTier(deps, 'user-1', 0);
    expect(result.ok).toBe(false);
  });
});

describe('deployTier', () => {
  beforeEach(() => {
    poolStatus = [{ state: 'idle', tierIndex: 0 } as IdleTierState];
  });

  it('creates a new instance and sets state to booting', async () => {
    const deps = makeDeps();
    const result = await deployTier(deps, 'user-1', 0);
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('booting');
    expect(result.instanceId).toBe('new-pod');
    expect(mockClient.createInstance).toHaveBeenCalled();
  });

  it('deletes existing instance first if not idle', async () => {
    poolStatus = [
      {
        state: 'ready',
        tierIndex: 0,
        endpoint: 'http://gpu0:8000',
        lastHealthyAt: Date.now(),
      } as ReadyTierState,
    ];
    const deps = makeDeps();
    const result = await deployTier(deps, 'user-1', 0);
    expect(result.ok).toBe(true);
    // stopInstance + deleteInstance from deleteTier, then createInstance from deploy
    expect(mockClient.stopInstance).toHaveBeenCalled();
    expect(mockClient.createInstance).toHaveBeenCalled();
  });

  it('returns error when no apiKey configured', async () => {
    const config = { ...defaultConfig, tiers: [{ provider: 'runpod' as const }] };
    const deps = makeDeps({ loadConfig: vi.fn().mockResolvedValue(config) });
    const result = await deployTier(deps, 'user-1', 0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('apiKey');
  });
});

describe('getTierDetail', () => {
  it('returns detail for a ready tier', async () => {
    poolStatus = [
      {
        state: 'ready',
        tierIndex: 0,
        endpoint: 'http://gpu0:8000',
        lastHealthyAt: 1000,
        bootedAt: 500,
      } as ReadyTierState,
    ];
    const deps = makeDeps();
    const detail = await getTierDetail(deps, 'user-1', 0);
    expect(detail).toBeTruthy();
    expect(detail!.state).toBe('ready');
    expect(detail!.endpoint).toBe('http://gpu0:8000');
    expect(detail!.providerStatus).toBe('RUNNING');
  });

  it('returns detail for an idle tier', async () => {
    poolStatus = [
      { state: 'idle', tierIndex: 0, unhealthy: true, bootFailCount: 2 } as IdleTierState,
    ];
    const deps = makeDeps();
    const detail = await getTierDetail(deps, 'user-1', 0);
    expect(detail!.state).toBe('idle');
    expect(detail!.unhealthy).toBe(true);
    expect(detail!.bootFailCount).toBe(2);
  });

  it('returns null for invalid tier index', async () => {
    poolStatus = [];
    const deps = makeDeps();
    const detail = await getTierDetail(deps, 'user-1', 99);
    expect(detail).toBeNull();
  });
});

describe('getAllTierDetails', () => {
  it('returns details for all tiers', async () => {
    poolStatus = [
      {
        state: 'ready',
        tierIndex: 0,
        endpoint: 'http://gpu0:8000',
        lastHealthyAt: 1000,
      } as ReadyTierState,
      { state: 'idle', tierIndex: 1 } as IdleTierState,
    ];
    const deps = makeDeps();
    const details = await getAllTierDetails(deps, 'user-1');
    expect(details).toHaveLength(2);
    expect(details[0].state).toBe('ready');
    expect(details[1].state).toBe('idle');
  });

  it('returns empty array when no config', async () => {
    const deps = makeDeps({ loadConfig: vi.fn().mockResolvedValue(null) });
    const details = await getAllTierDetails(deps, 'user-1');
    expect(details).toEqual([]);
  });
});
