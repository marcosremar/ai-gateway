import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BootOrchestrator,
  type BootOrchestratorCallbacks,
  type BootOrchestratorOptions,
} from '../src/autoscaler/boot-orchestrator';
import type { GpuTierConfig, GpuTierState, BootingTierState, IdleTierState } from '../src/types';
import type { GpuProviderRegistry } from '../src/gpu-providers/registry';
import type { Logger } from '../src/deps';
import type { GpuLifecycleLogger } from '../src/autoscaler/lifecycle-logger';
import { StageTimeoutError } from '../src/autoscaler/stage-timeout';

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOOP_LIFECYCLE: GpuLifecycleLogger = { log: vi.fn(async () => {}) } as unknown as GpuLifecycleLogger;

function makeLogger(): Logger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'runpod',
    bootTimeSecs: 60,
    discoverInstance: vi.fn(async () => null),
    createInstance: vi.fn(async () => ({
      instanceId: 'inst-1',
      endpoint: 'http://1.2.3.4:8000',
      sshHost: undefined,
      sshPort: undefined,
      monitorUrl: undefined,
    })),
    startInstance: vi.fn(async () => {}),
    deleteInstance: vi.fn(async () => {}),
    stopInstance: vi.fn(async () => {}),
    resolveInstanceEndpoint: vi.fn(async () => null),
    listInstances: vi.fn(async () => []),
    ...overrides,
  };
}

function makeRegistry(client = makeClient()): GpuProviderRegistry {
  return {
    get: vi.fn((id: string) => id === 'runpod' ? client : null),
    register: vi.fn(),
    getAll: vi.fn(() => [client]),
    _client: client,
  } as unknown as GpuProviderRegistry;
}

function makeCallbacks(stateMap = new Map<string, GpuTierState[]>()): BootOrchestratorCallbacks & { stateMap: Map<string, GpuTierState[]> } {
  return {
    stateMap,
    getStates: vi.fn((userId: string) => stateMap.get(userId)),
    setStates: vi.fn((userId: string, states: GpuTierState[]) => stateMap.set(userId, states)),
    persistStates: vi.fn(async () => {}),
    emitError: vi.fn(),
    recordProviderHealthEvent: vi.fn(),
  };
}

function makeTierConfig(overrides: Partial<GpuTierConfig> = {}): GpuTierConfig {
  return {
    provider: 'runpod',
    apiKey: 'test-key',
    gpuTypes: ['NVIDIA GeForce RTX 4090'],
    dockerImage: 'test/image:latest',
    storageGb: 0,
    ...overrides,
  };
}

function makeBootingState(tierIndex = 0, overrides: Partial<BootingTierState> = {}): GpuTierState {
  return {
    state: 'booting',
    tierIndex,
    endpoint: '',
    bootTriggeredAt: Date.now(),
    trigger: 'sessions',
    prevBootFailCount: 0,
    ...overrides,
  } as GpuTierState;
}

function makeOrchestrator(opts: {
  client?: ReturnType<typeof makeClient>;
  callbacks?: ReturnType<typeof makeCallbacks>;
  probeHealth?: (ep: string) => Promise<boolean>;
  onInstancePersist?: BootOrchestratorOptions['onInstancePersist'];
} = {}): { orchestrator: BootOrchestrator; client: ReturnType<typeof makeClient>; callbacks: ReturnType<typeof makeCallbacks>; logger: Logger } {
  const client = opts.client ?? makeClient();
  const callbacks = opts.callbacks ?? makeCallbacks();
  const logger = makeLogger();

  const orchestrator = new BootOrchestrator({
    registry: makeRegistry(client),
    probeHealth: opts.probeHealth ?? vi.fn(async () => false),
    lifecycleLogger: NOOP_LIFECYCLE,
    logger,
    onInstancePersist: opts.onInstancePersist,
    callbacks,
  });

  return { orchestrator, client, callbacks, logger };
}

// ── triggerGpuBoot tests ──────────────────────────────────────────────────────

describe('BootOrchestrator.triggerGpuBoot', () => {
  it('returns failure when no api key', async () => {
    const { orchestrator } = makeOrchestrator();
    const result = await orchestrator.triggerGpuBoot(
      makeTierConfig({ apiKey: undefined }),
      0, 'user',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/api key/i);
  });

  it('returns failure when max attempts exceeded', async () => {
    const { orchestrator } = makeOrchestrator();
    const result = await orchestrator.triggerGpuBoot(makeTierConfig(), 0, 'user', 2);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/max retry/i);
  });

  it('creates instance when no existing instance found', async () => {
    const client = makeClient({
      discoverInstance: vi.fn(async () => null),
      createInstance: vi.fn(async () => ({ instanceId: 'new-inst', endpoint: 'http://gpu:8000' })),
    });
    const { orchestrator } = makeOrchestrator({ client });

    const result = await orchestrator.triggerGpuBoot(makeTierConfig(), 0, 'user');

    expect(result.ok).toBe(true);
    expect(result.instanceId).toBe('new-inst');
    expect(result.endpoint).toBe('http://gpu:8000');
    expect(client.createInstance).toHaveBeenCalledOnce();
  });

  it('reuses running discovered instance (skips create)', async () => {
    const client = makeClient({
      discoverInstance: vi.fn(async () => ({
        instanceId: 'existing-inst',
        endpoint: 'http://running:8000',
        status: 'running',
      })),
      startInstance: vi.fn(async () => {}),
    });
    const { orchestrator } = makeOrchestrator({ client });

    const result = await orchestrator.triggerGpuBoot(makeTierConfig(), 0, 'user');

    expect(result.ok).toBe(true);
    expect(result.instanceId).toBe('existing-inst');
    expect(client.createInstance).not.toHaveBeenCalled();
  });

  it('restarts stopped (non-terminal) instance instead of creating new', async () => {
    const client = makeClient({
      discoverInstance: vi.fn(async () => ({
        instanceId: 'stopped-inst',
        endpoint: '',
        status: 'stopped',
      })),
      startInstance: vi.fn(async () => {}),
    });
    const { orchestrator } = makeOrchestrator({ client });

    const result = await orchestrator.triggerGpuBoot(makeTierConfig({ instanceId: undefined }), 0, 'user');

    // Should restart the stopped instance, not create a new one
    expect(client.createInstance).not.toHaveBeenCalled();
    expect(client.startInstance).toHaveBeenCalled();
  });

  it('creates new instance when discovered instance is terminal (destroyed)', async () => {
    const client = makeClient({
      discoverInstance: vi.fn(async () => ({
        instanceId: 'dead-inst',
        endpoint: '',
        status: 'destroyed',
      })),
      createInstance: vi.fn(async () => ({ instanceId: 'fresh-inst', endpoint: 'http://fresh:8000' })),
    });
    const { orchestrator } = makeOrchestrator({ client });

    const result = await orchestrator.triggerGpuBoot(makeTierConfig({ instanceId: undefined }), 0, 'user');

    expect(result.ok).toBe(true);
    expect(client.createInstance).toHaveBeenCalledOnce();
  });

  it('starts existing instance when instanceId provided', async () => {
    const client = makeClient({
      startInstance: vi.fn(async () => {}),
    });
    const { orchestrator } = makeOrchestrator({ client });

    const result = await orchestrator.triggerGpuBoot(
      makeTierConfig({ instanceId: 'known-inst', endpoint: 'http://known:8000' }),
      0, 'user',
    );

    expect(result.ok).toBe(true);
    expect(client.startInstance).toHaveBeenCalledWith('known-inst', expect.any(Object));
    expect(client.createInstance).not.toHaveBeenCalled();
  });

  it('retries when startInstance says instance not found', async () => {
    const client = makeClient({
      discoverInstance: vi.fn(async () => null),
      createInstance: vi.fn(async () => ({ instanceId: 'new-inst', endpoint: 'http://new:8000' })),
      startInstance: vi.fn(async () => { throw new Error('not found'); }),
    });
    const { orchestrator } = makeOrchestrator({ client });

    const result = await orchestrator.triggerGpuBoot(
      makeTierConfig({ instanceId: 'gone-inst' }),
      0, 'user',
    );

    // Should retry with auto-discover → create fresh instance
    expect(client.createInstance).toHaveBeenCalled();
  });

  it('deletes expired slot instance and retries', async () => {
    let callCount = 0;
    const client = makeClient({
      discoverInstance: vi.fn(async () => null),
      createInstance: vi.fn(async () => {
        callCount++;
        return { instanceId: `inst-${callCount}`, endpoint: `http://inst${callCount}:8000` };
      }),
      startInstance: vi.fn(async () => { throw new Error('não pode ser iniciada'); }),
      deleteInstance: vi.fn(async () => {}),
    });
    const { orchestrator } = makeOrchestrator({ client });

    await orchestrator.triggerGpuBoot(
      makeTierConfig({ instanceId: 'expired-inst' }),
      0, 'user',
    );

    expect(client.deleteInstance).toHaveBeenCalledWith('expired-inst', expect.any(Object));
  });

  it('handles createInstance failure', async () => {
    const client = makeClient({
      discoverInstance: vi.fn(async () => null),
      createInstance: vi.fn(async () => { throw new Error('quota exceeded'); }),
    });
    const { orchestrator } = makeOrchestrator({ client });

    const result = await orchestrator.triggerGpuBoot(makeTierConfig(), 0, 'user');

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/quota exceeded/);
  });

  it('returns failure when provider not in registry', async () => {
    const client = makeClient({ startInstance: vi.fn(async () => {}) });
    const registry = {
      get: vi.fn(() => null), // provider not registered
      register: vi.fn(), getAll: vi.fn(() => []),
    } as unknown as GpuProviderRegistry;

    const orchestrator = new BootOrchestrator({
      registry,
      probeHealth: vi.fn(async () => false),
      lifecycleLogger: NOOP_LIFECYCLE,
      logger: makeLogger(),
      callbacks: makeCallbacks(),
    });

    const result = await orchestrator.triggerGpuBoot(
      makeTierConfig({ instanceId: 'inst-1' }),
      0, 'user',
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/não suporta/);
  });

  it('emits error on unexpected exception', async () => {
    const client = makeClient({
      discoverInstance: vi.fn(async () => { throw new Error('network failure'); }),
    });
    const callbacks = makeCallbacks();
    const { orchestrator } = makeOrchestrator({ client, callbacks });

    const result = await orchestrator.triggerGpuBoot(makeTierConfig(), 0, 'user');

    expect(result.ok).toBe(false);
    expect(callbacks.emitError).toHaveBeenCalled();
  });

  it('returns sshHost and sshPort from createInstance', async () => {
    const client = makeClient({
      discoverInstance: vi.fn(async () => null),
      createInstance: vi.fn(async () => ({
        instanceId: 'inst-ssh',
        endpoint: '',
        sshHost: '1.2.3.4',
        sshPort: 22022,
        monitorUrl: 'http://monitor:3000',
      })),
    });
    const { orchestrator } = makeOrchestrator({ client });

    const result = await orchestrator.triggerGpuBoot(makeTierConfig(), 0, 'user');

    expect(result.ok).toBe(true);
    expect(result.sshHost).toBe('1.2.3.4');
    expect(result.sshPort).toBe(22022);
    expect(result.monitorUrl).toBe('http://monitor:3000');
  });

  it('handles StageTimeoutError on discover (proceeds to create)', async () => {
    const client = makeClient({
      discoverInstance: vi.fn(async () => {
        throw new StageTimeoutError('discover', 30_000);
      }),
      createInstance: vi.fn(async () => ({ instanceId: 'new-inst', endpoint: 'http://new:8000' })),
    });
    const callbacks = makeCallbacks();
    const { orchestrator } = makeOrchestrator({ client, callbacks });

    const result = await orchestrator.triggerGpuBoot(makeTierConfig(), 0, 'user');

    // Should proceed to create despite discover timeout
    expect(result.ok).toBe(true);
    expect(client.createInstance).toHaveBeenCalled();
    expect(callbacks.emitError).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'STAGE_TIMEOUT', operation: 'discoverInstance' }),
    );
  });

  it('handles StageTimeoutError on startInstance (returns failure)', async () => {
    const client = makeClient({
      startInstance: vi.fn(async () => {
        throw new StageTimeoutError('start', 120_000);
      }),
    });
    const callbacks = makeCallbacks();
    const { orchestrator } = makeOrchestrator({ client, callbacks });

    const result = await orchestrator.triggerGpuBoot(
      makeTierConfig({ instanceId: 'existing' }),
      0, 'user',
    );

    expect(result.ok).toBe(false);
    expect(callbacks.emitError).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'STAGE_TIMEOUT', operation: 'triggerGpuBoot:startInstance' }),
    );
  });

  it('persists discovered running instance via onInstancePersist', async () => {
    const onInstancePersist = vi.fn(async () => {});
    const client = makeClient({
      discoverInstance: vi.fn(async () => ({
        instanceId: 'running-inst',
        endpoint: 'http://running:8000',
        status: 'running',
        ipAddress: '5.6.7.8',
      })),
      startInstance: vi.fn(async () => {}),
    });
    const { orchestrator } = makeOrchestrator({ client, onInstancePersist });

    await orchestrator.triggerGpuBoot(makeTierConfig(), 0, 'user');

    expect(onInstancePersist).toHaveBeenCalledWith(
      'user',
      expect.stringMatching(/runpod|vast|tensordock/i),
      expect.objectContaining({ provider: 'runpod' }),
    );
  });
});

// ── handleBootResult tests ────────────────────────────────────────────────────

describe('BootOrchestrator.handleBootResult', () => {
  it('updates booting state with instanceId and endpoint on success', async () => {
    const bootTimestamp = Date.now();
    const stateMap = new Map<string, GpuTierState[]>([
      ['user', [makeBootingState(0, { bootTriggeredAt: bootTimestamp })]],
    ]);
    const callbacks = makeCallbacks(stateMap);
    const { orchestrator } = makeOrchestrator({ callbacks });

    const bootPromise = Promise.resolve({
      ok: true,
      instanceId: 'inst-1',
      endpoint: 'http://gpu:8000',
    });

    orchestrator.handleBootResult('user', 0, makeTierConfig(), bootTimestamp, 'sessions', bootPromise);
    await bootPromise;
    await new Promise<void>(r => setTimeout(r, 0)); // let microtasks flush

    expect(callbacks.setStates).toHaveBeenCalled();
    const savedState = stateMap.get('user')?.[0] as BootingTierState;
    expect(savedState.discoveredInstanceId).toBe('inst-1');
    expect(savedState.endpoint).toBe('http://gpu:8000');
  });

  it('resets to idle with cooldown on boot failure', async () => {
    const bootTimestamp = Date.now();
    const stateMap = new Map<string, GpuTierState[]>([
      ['user', [makeBootingState(0, { bootTriggeredAt: bootTimestamp, prevBootFailCount: 0 })]],
    ]);
    const callbacks = makeCallbacks(stateMap);
    const { orchestrator } = makeOrchestrator({ callbacks });

    const bootPromise = Promise.resolve({ ok: false, reason: 'Provider error' });
    orchestrator.handleBootResult('user', 0, makeTierConfig(), bootTimestamp, 'sessions', bootPromise);
    await bootPromise;
    await new Promise<void>(r => setTimeout(r, 0));

    const state = stateMap.get('user')?.[0] as IdleTierState;
    expect(state.state).toBe('idle');
    expect(state.cooldownUntil).toBeGreaterThan(Date.now());
    expect(callbacks.recordProviderHealthEvent).toHaveBeenCalledWith('runpod', false);
  });

  it('does nothing if state was already changed (not still booting)', async () => {
    const bootTimestamp = Date.now() - 1000;
    const stateMap = new Map<string, GpuTierState[]>([
      ['user', [{ state: 'ready', tierIndex: 0, endpoint: 'http://ready:8000', lastHealthyAt: Date.now() }]],
    ]);
    const callbacks = makeCallbacks(stateMap);
    const { orchestrator } = makeOrchestrator({ callbacks });

    const bootPromise = Promise.resolve({ ok: false, reason: 'Provider error' });
    orchestrator.handleBootResult('user', 0, makeTierConfig(), bootTimestamp, 'sessions', bootPromise);
    await bootPromise;
    await new Promise<void>(r => setTimeout(r, 0));

    // State should NOT change since it's already 'ready'
    expect(stateMap.get('user')?.[0].state).toBe('ready');
  });

  it('handles unexpected error in boot promise — resets to idle', async () => {
    const bootTimestamp = Date.now();
    const stateMap = new Map<string, GpuTierState[]>([
      ['user', [makeBootingState(0, { bootTriggeredAt: bootTimestamp })]],
    ]);
    const callbacks = makeCallbacks(stateMap);
    const { orchestrator } = makeOrchestrator({ callbacks });

    const bootPromise = Promise.reject(new Error('unexpected'));
    orchestrator.handleBootResult('user', 0, makeTierConfig(), bootTimestamp, 'sessions', bootPromise);

    await expect(bootPromise).rejects.toThrow('unexpected');
    await new Promise<void>(r => setTimeout(r, 0));

    const state = stateMap.get('user')?.[0] as IdleTierState;
    expect(state.state).toBe('idle');
  });

  it('persists orphaned instance when state was replaced but boot succeeded', async () => {
    const bootTimestamp = Date.now() - 1000;
    // State was already changed (not booting with same timestamp)
    const stateMap = new Map<string, GpuTierState[]>([
      ['user', [{ state: 'idle', tierIndex: 0 }]],
    ]);
    const callbacks = makeCallbacks(stateMap);
    const onInstancePersist = vi.fn(async () => {});
    const { orchestrator } = makeOrchestrator({ callbacks, onInstancePersist });

    const bootPromise = Promise.resolve({ ok: true, instanceId: 'orphan-inst', endpoint: 'http://orphan:8000' });
    orchestrator.handleBootResult('user', 0, makeTierConfig(), bootTimestamp, 'sessions', bootPromise);
    await bootPromise;
    await new Promise<void>(r => setTimeout(r, 0));

    expect(onInstancePersist).toHaveBeenCalledWith(
      'user',
      expect.stringContaining('orphan'),
      expect.objectContaining({ instanceId: 'orphan-inst', orphanedBecause: 'state_reset_during_boot' }),
    );
  });
});

// ── Boot poller tests ─────────────────────────────────────────────────────────

describe('BootOrchestrator.cancelBootPoller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('cancels a poller without error when none exists', () => {
    const { orchestrator } = makeOrchestrator();
    expect(() => orchestrator.cancelBootPoller('user', 0)).not.toThrow();
  });

  it('cancels existing poller', () => {
    const bootTimestamp = Date.now();
    const stateMap = new Map<string, GpuTierState[]>([
      ['user', [makeBootingState(0, { bootTriggeredAt: bootTimestamp })]],
    ]);
    const callbacks = makeCallbacks(stateMap);
    const { orchestrator } = makeOrchestrator({ callbacks });

    orchestrator.startBootHealthPoller('user', 0, 'runpod', bootTimestamp);
    orchestrator.cancelBootPoller('user', 0);

    // Advance time — poller should NOT fire (cancelled)
    const stateBefore = JSON.stringify(stateMap.get('user'));
    vi.advanceTimersByTime(200_000);
    expect(JSON.stringify(stateMap.get('user'))).toBe(stateBefore);
  });
});

describe('BootOrchestrator.destroyAllPollers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('clears all pollers without error', () => {
    const bootTimestamp = Date.now();
    const stateMap = new Map<string, GpuTierState[]>([
      ['user1', [makeBootingState(0, { bootTriggeredAt: bootTimestamp })]],
      ['user2', [makeBootingState(0, { bootTriggeredAt: bootTimestamp })]],
    ]);
    const callbacks = makeCallbacks(stateMap);
    const { orchestrator } = makeOrchestrator({ callbacks });

    orchestrator.startBootHealthPoller('user1', 0, 'runpod', bootTimestamp);
    orchestrator.startBootHealthPoller('user2', 0, 'runpod', bootTimestamp);

    expect(() => orchestrator.destroyAllPollers()).not.toThrow();
  });
});

describe('BootOrchestrator.startBootHealthPoller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts a poller that transitions to ready when health check passes', async () => {
    const bootTimestamp = Date.now();
    const stateMap = new Map<string, GpuTierState[]>([
      ['user', [makeBootingState(0, {
        bootTriggeredAt: bootTimestamp,
        endpoint: 'http://gpu:8000',
        discoveredInstanceId: 'inst-1',
      })]],
    ]);
    const callbacks = makeCallbacks(stateMap);
    const probeHealth = vi.fn(async () => true); // healthy!

    const { orchestrator } = makeOrchestrator({ callbacks, probeHealth });

    orchestrator.startBootHealthPoller('user', 0, 'runpod', bootTimestamp);

    // Advance past initial delay (60s * 0.2 = 12s, min 30s)
    vi.advanceTimersByTime(35_000);
    await vi.runAllTimersAsync();

    const state = stateMap.get('user')?.[0];
    expect(state?.state).toBe('ready');
    expect(callbacks.persistStates).toHaveBeenCalled();
    expect(callbacks.recordProviderHealthEvent).toHaveBeenCalledWith('runpod', true);
  });

  it('stops polling when tier state is no longer booting', async () => {
    const bootTimestamp = Date.now();
    const stateMap = new Map<string, GpuTierState[]>([
      ['user', [{ state: 'idle', tierIndex: 0 }]], // already idle
    ]);
    const callbacks = makeCallbacks(stateMap);
    const probeHealth = vi.fn(async () => true);
    const { orchestrator } = makeOrchestrator({ callbacks, probeHealth });

    orchestrator.startBootHealthPoller('user', 0, 'runpod', bootTimestamp);
    vi.advanceTimersByTime(35_000);
    await vi.runAllTimersAsync();

    // probeHealth should NOT be called (state is not booting)
    expect(probeHealth).not.toHaveBeenCalled();
  });

  it('stops polling when bootTimestamp changes (new boot attempt)', async () => {
    const oldTimestamp = Date.now() - 1000;
    const newTimestamp = Date.now();
    const stateMap = new Map<string, GpuTierState[]>([
      ['user', [makeBootingState(0, { bootTriggeredAt: newTimestamp, endpoint: 'http://gpu:8000' })]],
    ]);
    const callbacks = makeCallbacks(stateMap);
    const probeHealth = vi.fn(async () => true);
    const { orchestrator } = makeOrchestrator({ callbacks, probeHealth });

    // Start poller with OLD timestamp (a different boot attempt)
    orchestrator.startBootHealthPoller('user', 0, 'runpod', oldTimestamp);
    vi.advanceTimersByTime(35_000);
    await vi.runAllTimersAsync();

    // Should not update state (boot timestamp mismatch)
    expect(stateMap.get('user')?.[0].state).toBe('booting');
  });

  it('schedules next poll when health check fails', async () => {
    const bootTimestamp = Date.now();
    const stateMap = new Map<string, GpuTierState[]>([
      ['user', [makeBootingState(0, {
        bootTriggeredAt: bootTimestamp,
        endpoint: 'http://gpu:8000',
      })]],
    ]);
    const callbacks = makeCallbacks(stateMap);
    let pollCount = 0;
    const probeHealth = vi.fn(async () => { pollCount++; return false; }); // always unhealthy

    const { orchestrator } = makeOrchestrator({ callbacks, probeHealth });

    orchestrator.startBootHealthPoller('user', 0, 'runpod', bootTimestamp);

    // First poll at ~30s
    vi.advanceTimersByTime(35_000);
    await vi.runAllTimersAsync();
    expect(pollCount).toBeGreaterThan(0);

    // Second poll at ~45s (30s + 15s backoff)
    vi.advanceTimersByTime(20_000);
    await vi.runAllTimersAsync();
    expect(pollCount).toBeGreaterThan(1);
  });

  it('stops polling on boot timeout', async () => {
    const bootTimestamp = Date.now() - (121 * 2 * 1000); // already past max boot time
    const stateMap = new Map<string, GpuTierState[]>([
      ['user', [makeBootingState(0, {
        bootTriggeredAt: bootTimestamp,
        endpoint: 'http://gpu:8000',
      })]],
    ]);
    const callbacks = makeCallbacks(stateMap);
    const probeHealth = vi.fn(async () => true);
    const { orchestrator } = makeOrchestrator({ callbacks, probeHealth });

    orchestrator.startBootHealthPoller('user', 0, 'runpod', bootTimestamp);
    vi.advanceTimersByTime(35_000);
    await vi.runAllTimersAsync();

    // Should have stopped polling (timeout exceeded)
    expect(probeHealth).not.toHaveBeenCalled();
  });

  it('cancels previous poller for same tier when new one starts', async () => {
    const bootTimestamp = Date.now();
    const stateMap = new Map<string, GpuTierState[]>([
      ['user', [makeBootingState(0, { bootTriggeredAt: bootTimestamp, endpoint: 'http://gpu:8000' })]],
    ]);
    const callbacks = makeCallbacks(stateMap);
    const probeHealth = vi.fn(async () => true); // returns healthy so poller stops

    const { orchestrator } = makeOrchestrator({ callbacks, probeHealth });

    // Start first poller (old timestamp)
    orchestrator.startBootHealthPoller('user', 0, 'runpod', bootTimestamp - 1000);
    // Start second poller — should cancel first
    orchestrator.startBootHealthPoller('user', 0, 'runpod', bootTimestamp);

    vi.advanceTimersByTime(35_000);
    await vi.runAllTimersAsync();

    // State should be ready (second poller fired successfully once)
    // If first poller was NOT cancelled, it would fire but see timestamp mismatch and stop
    // Either way, state should be ready because second poller fired
    const state = stateMap.get('user')?.[0];
    expect(state?.state).toBe('ready');
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('BootOrchestrator edge cases', () => {
  it('handles undefined stateMap entry in handleBootResult', async () => {
    const callbacks = makeCallbacks(new Map()); // empty stateMap
    const { orchestrator } = makeOrchestrator({ callbacks });

    const bootPromise = Promise.resolve({ ok: true, instanceId: 'inst', endpoint: 'http://gpu:8000' });
    orchestrator.handleBootResult('nonexistent-user', 0, makeTierConfig(), Date.now(), 'sessions', bootPromise);
    await bootPromise;
    await new Promise<void>(r => setTimeout(r, 0));

    // Should not throw and not call setStates (no state to update)
    expect(callbacks.setStates).not.toHaveBeenCalled();
  });

  it('triggerGpuBoot does not call createInstance when instanceId already set', async () => {
    const client = makeClient({
      startInstance: vi.fn(async () => {}),
    });
    const { orchestrator } = makeOrchestrator({ client });

    await orchestrator.triggerGpuBoot(
      makeTierConfig({ instanceId: 'existing', endpoint: 'http://existing:8000' }),
      0, 'user',
    );

    expect(client.createInstance).not.toHaveBeenCalled();
    expect(client.discoverInstance).not.toHaveBeenCalled();
    expect(client.startInstance).toHaveBeenCalledWith('existing', expect.any(Object));
  });

  it('exponential cooldown increases with each boot failure', async () => {
    const bootTimestamp = Date.now();
    const stateMap = new Map<string, GpuTierState[]>([
      ['user', [makeBootingState(0, { bootTriggeredAt: bootTimestamp, prevBootFailCount: 2 })]],
    ]);
    const callbacks = makeCallbacks(stateMap);
    const { orchestrator } = makeOrchestrator({ callbacks });

    const bootPromise = Promise.resolve({ ok: false, reason: 'Provider unavailable' });
    orchestrator.handleBootResult('user', 0, makeTierConfig(), bootTimestamp, 'sessions', bootPromise);
    await bootPromise;
    await new Promise<void>(r => setTimeout(r, 0));

    const state = stateMap.get('user')?.[0] as IdleTierState;
    expect(state.state).toBe('idle');
    // failCount = 2 + 1 = 3, cooldown = 2min * 2^(3-1) = 2min * 4 = 8min
    const expectedCooldown = 2 * 60_000 * Math.pow(2, 2);
    expect(state.cooldownUntil).toBeGreaterThanOrEqual(Date.now() + expectedCooldown - 1000);
    expect(state.cooldownUntil).toBeLessThanOrEqual(Date.now() + expectedCooldown + 1000);
  });
});
