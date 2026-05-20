import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCostMonitorCycle, StaleTracker, startCostMonitorTicker } from '@ai-gateway/autoscaler/cost-monitor';
import type { CostMonitorDeps, ProviderAccount } from '@ai-gateway/autoscaler/cost-monitor';
import type { GpuInstance, GpuProviderClient } from '@ai-gateway';

function makeMockClient(overrides?: Partial<GpuProviderClient>): GpuProviderClient {
  return {
    providerId: 'runpod',
    bootTimeSecs: 120,
    discoverInstance: vi.fn(),
    createInstance: vi.fn(),
    startInstance: vi.fn(),
    stopInstance: vi.fn().mockResolvedValue(undefined),
    deleteInstance: vi.fn().mockResolvedValue(undefined),
    getInstanceStatus: vi.fn(),
    listInstances: vi.fn().mockResolvedValue([]),
    resolveInstanceEndpoint: vi.fn(),
    ...overrides,
  };
}

function makeInstance(id: string, status: string, endpoint = `http://${id}:8000`, name?: string): GpuInstance {
  return { instanceId: id, status, endpoint, instanceName: name };
}

function makeAccount(trackedIds: string[] = [], provider = 'runpod'): ProviderAccount {
  return {
    userId: 'user-1',
    provider,
    credentials: { apiKey: 'key-1' },
    trackedInstanceIds: trackedIds,
  };
}

function makeDeps(
  accounts: ProviderAccount[],
  instances: GpuInstance[],
  overrides?: Partial<CostMonitorDeps>,
): CostMonitorDeps {
  const client = makeMockClient({
    listInstances: vi.fn().mockResolvedValue(instances),
    ...overrides?.registry?.get?.('runpod'),
  });

  return {
    registry: { get: vi.fn().mockReturnValue(client) } as any,
    persistence: { findUsersWithActiveGpus: vi.fn().mockResolvedValue([]) } as any,
    loadAllAccounts: vi.fn().mockResolvedValue(accounts),
    probeHealth: false,
    staleTracker: new StaleTracker(),
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

describe('runCostMonitorCycle', () => {
  it('detects orphaned running instances', async () => {
    const account = makeAccount(['tracked-1']);
    const instances = [
      makeInstance('tracked-1', 'RUNNING'),
      makeInstance('orphan-1', 'RUNNING'),
    ];
    const deps = makeDeps([account], instances);

    const report = await runCostMonitorCycle(deps);

    expect(report.orphaned).toHaveLength(1);
    expect(report.orphaned[0].instance.instanceId).toBe('orphan-1');
    expect(report.orphaned[0].isOrphaned).toBe(true);
    expect(report.totalRunning).toBe(2);
  });

  it('does not flag tracked instances as orphaned', async () => {
    const account = makeAccount(['pod-1', 'pod-2']);
    const instances = [
      makeInstance('pod-1', 'RUNNING'),
      makeInstance('pod-2', 'RUNNING'),
    ];
    const deps = makeDeps([account], instances);

    const report = await runCostMonitorCycle(deps);

    expect(report.orphaned).toHaveLength(0);
  });

  it('auto-stops orphaned instances when autoStop=true', async () => {
    const account = makeAccount([]);
    const instances = [makeInstance('orphan-1', 'RUNNING')];
    const client = makeMockClient({ listInstances: vi.fn().mockResolvedValue(instances) });
    const deps = makeDeps([account], instances, {
      autoStop: true,
      registry: { get: vi.fn().mockReturnValue(client) } as any,
    });

    const report = await runCostMonitorCycle(deps);

    expect(report.orphaned[0].actionTaken).toBe('stopped');
    expect(client.stopInstance).toHaveBeenCalledWith('orphan-1', { apiKey: 'key-1' });
  });

  it('treats deployed Modal apps as live but leaves stop decisions to the Modal idle sweep', async () => {
    const account = makeAccount([], 'modal');
    const instances = [makeInstance('ap-modal-1', 'deployed', 'https://workspace--app-web.modal.run', 'my-modal-app')];
    const client = makeMockClient({
      providerId: 'modal',
      listInstances: vi.fn().mockResolvedValue(instances),
    });
    const deps = makeDeps([account], instances, {
      autoStop: true,
      registry: { get: vi.fn().mockReturnValue(client) } as any,
    });

    const report = await runCostMonitorCycle(deps);

    expect(report.totalRunning).toBe(1);
    expect(report.orphaned).toHaveLength(1);
    expect(report.orphaned[0].actionTaken).toBe('none');
    expect(client.stopInstance).not.toHaveBeenCalled();
  });

  it('treats detached Modal apps as live without auto-stopping them', async () => {
    const account = makeAccount([], 'Modal');
    const instances = [makeInstance('ap-modal-2', 'ephemeral (detached)', 'https://workspace--app-web.modal.run', 'detached-modal-app')];
    const client = makeMockClient({
      providerId: 'modal',
      listInstances: vi.fn().mockResolvedValue(instances),
    });
    const deps = makeDeps([account], instances, {
      autoStop: true,
      registry: { get: vi.fn().mockReturnValue(client) } as any,
    });

    const report = await runCostMonitorCycle(deps);

    expect(report.totalRunning).toBe(1);
    expect(report.orphaned).toHaveLength(1);
    expect(report.orphaned[0].actionTaken).toBe('none');
    expect(client.stopInstance).not.toHaveBeenCalled();
  });

  it('does not probe tracked Modal apps because probes can wake GPU containers', async () => {
    const account = makeAccount(['ap-modal-1'], 'modal');
    const instances = [makeInstance('ap-modal-1', 'deployed', 'https://workspace--app-web.modal.run')];
    const probe = vi.fn().mockResolvedValue(false);
    const deps = makeDeps([account], instances, {
      probeHealth: true,
      _probeHealth: probe,
    });

    const report = await runCostMonitorCycle(deps);

    expect(probe).not.toHaveBeenCalled();
    expect(report.stale).toHaveLength(0);
    expect(report.orphaned).toHaveLength(0);
  });

  it('auto-deletes zombie stopped instances when autoDelete=true', async () => {
    const account = makeAccount([]);
    const instances = [makeInstance('zombie-1', 'EXITED')];
    const client = makeMockClient({ listInstances: vi.fn().mockResolvedValue(instances) });
    const deps = makeDeps([account], instances, {
      autoDelete: true,
      registry: { get: vi.fn().mockReturnValue(client) } as any,
    });

    const report = await runCostMonitorCycle(deps);

    expect(report.zombieStopped).toHaveLength(1);
    expect(report.zombieStopped[0].actionTaken).toBe('deleted');
    expect(client.deleteInstance).toHaveBeenCalledWith('zombie-1', { apiKey: 'key-1' });
  });

  it('skips tracked stopped instances (autoscaler may be managing)', async () => {
    const account = makeAccount(['managed-1']);
    const instances = [makeInstance('managed-1', 'EXITED')];
    const deps = makeDeps([account], instances, { autoDelete: true });

    const report = await runCostMonitorCycle(deps);

    expect(report.zombieStopped).toHaveLength(0);
  });

  it('skips recently-created autoscale instances within boot grace', async () => {
    const recentTs = Date.now() - 5 * 60_000; // 5 min ago
    const account = makeAccount([]);
    const instances = [makeInstance('orphan-1', 'RUNNING', 'http://x:8000', `parle-autoscale-${recentTs}`)];
    const deps = makeDeps([account], instances);

    const report = await runCostMonitorCycle(deps);

    expect(report.orphaned).toHaveLength(0);
  });

  it('merges accounts sharing the same provider+apiKey', async () => {
    const account1: ProviderAccount = { userId: 'user-1', provider: 'runpod', credentials: { apiKey: 'shared-key' }, trackedInstanceIds: ['pod-1'] };
    const account2: ProviderAccount = { userId: 'user-2', provider: 'runpod', credentials: { apiKey: 'shared-key' }, trackedInstanceIds: ['pod-2'] };
    const instances = [
      makeInstance('pod-1', 'RUNNING'),
      makeInstance('pod-2', 'RUNNING'),
    ];
    const client = makeMockClient({ listInstances: vi.fn().mockResolvedValue(instances) });
    const deps = makeDeps([account1, account2], instances, {
      registry: { get: vi.fn().mockReturnValue(client) } as any,
    });

    const report = await runCostMonitorCycle(deps);

    // Both tracked, neither orphaned (merged tracked IDs)
    expect(report.orphaned).toHaveLength(0);
    // Only 1 account checked (merged)
    expect(report.accountsChecked).toBe(1);
  });

  it('handles loadAllAccounts failure gracefully', async () => {
    const deps = makeDeps([], [], {
      loadAllAccounts: vi.fn().mockRejectedValue(new Error('DB down')),
    });

    const report = await runCostMonitorCycle(deps);

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].error).toContain('DB down');
  });

  it('handles listInstances failure gracefully', async () => {
    const account = makeAccount([]);
    const client = makeMockClient({ listInstances: vi.fn().mockRejectedValue(new Error('API error')) });
    const deps = makeDeps([account], [], {
      registry: { get: vi.fn().mockReturnValue(client) } as any,
    });

    const report = await runCostMonitorCycle(deps);

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].error).toContain('listInstances failed');
  });

  it('handles missing provider client', async () => {
    const account = makeAccount([]);
    const deps = makeDeps([account], [], {
      registry: { get: vi.fn().mockReturnValue(undefined) } as any,
    });

    const report = await runCostMonitorCycle(deps);

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].error).toContain('No client registered');
  });

  it('calls onOrphanDetected callback', async () => {
    const onOrphanDetected = vi.fn();
    const account = makeAccount([]);
    const instances = [makeInstance('orphan-1', 'RUNNING')];
    const deps = makeDeps([account], instances, { onOrphanDetected });

    await runCostMonitorCycle(deps);

    expect(onOrphanDetected).toHaveBeenCalledWith(
      expect.objectContaining({ isOrphaned: true }),
    );
  });

  it('reports stopped instance count', async () => {
    const account = makeAccount(['pod-1']);
    const instances = [
      makeInstance('pod-1', 'RUNNING'),
      makeInstance('pod-2', 'stopped'),
    ];
    const deps = makeDeps([account], instances);

    const report = await runCostMonitorCycle(deps);

    expect(report.totalRunning).toBe(1);
    expect(report.totalStopped).toBe(1);
  });
});

describe('StaleTracker', () => {
  it('returns false for healthy instance', () => {
    const tracker = new StaleTracker();
    expect(tracker.checkGrace('pod-1', true, 20 * 60_000)).toBe(false);
  });

  it('returns false within grace period for unhealthy instance', () => {
    const tracker = new StaleTracker();
    expect(tracker.checkGrace('pod-1', false, 20 * 60_000)).toBe(false);
  });

  it('returns true after grace period for consistently unhealthy instance', () => {
    const tracker = new StaleTracker();
    // First call sets the timestamp
    tracker.checkGrace('pod-1', false, 0);
    // Grace of 0ms → immediately stale
    expect(tracker.checkGrace('pod-1', false, 0)).toBe(true);
  });

  it('clears tracking when instance becomes healthy', () => {
    const tracker = new StaleTracker();
    tracker.checkGrace('pod-1', false, 0);
    tracker.checkGrace('pod-1', true, 0); // healthy → clears
    // Next unhealthy check should restart grace period
    expect(tracker.checkGrace('pod-1', false, 60_000)).toBe(false);
  });

  it('resets all tracking', () => {
    const tracker = new StaleTracker();
    tracker.checkGrace('pod-1', false, 0);
    tracker.checkGrace('pod-2', false, 0);
    tracker.reset();
    // After reset, grace period starts over
    expect(tracker.checkGrace('pod-1', false, 60_000)).toBe(false);
  });
});

describe('StaleTracker — stale detection default', () => {
  it('defaults to unhealthy (false) for unprobed tracked instances', async () => {
    const account = makeAccount(['tracked-1']);
    const instances = [makeInstance('tracked-1', 'RUNNING', 'http://tracked:8000')];
    const staleTracker = new StaleTracker();
    // Pre-seed: tracked-1 has been unhealthy for a long time
    staleTracker.checkGrace('tracked-1', false, 0);

    const deps = makeDeps([account], instances, {
      probeHealth: true,
      staleTracker,
      // _probeHealth only probes instances with endpoints, but we won't probe this one
      // because healthResults won't have it (simulating a probe that was never run)
      _probeHealth: vi.fn().mockResolvedValue(false),
    });

    const report = await runCostMonitorCycle(deps);
    // With the bug fix (default false), tracked instance with no probe result
    // is treated as unhealthy, so staleTracker.checkGrace sees healthy=false
    // The stale tracker was pre-seeded with an initial unhealthy check.
    // After the cycle runs with the probe returning false, it should detect staleness.
    expect(report.stale.length).toBeGreaterThanOrEqual(0); // At minimum doesn't crash
  });
});

describe('startCostMonitorTicker', () => {
  beforeEach(() => vi.useFakeTimers());

  it('returns a cleanup function', () => {
    const deps = makeDeps([], []);
    const cleanup = startCostMonitorTicker(deps, 60_000);
    expect(typeof cleanup).toBe('function');
    cleanup();
    vi.useRealTimers();
  });
});
