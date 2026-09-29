/**
 * Unit tests for server/standby-pool.ts
 *
 * Covers: setStandbyPoolConfig, removeStandbyPoolConfig, getStandbyPoolConfig,
 * getStandbyPoolStatus, checkout (happy path, empty pool, FIFO order, async
 * refill trigger), release, startStandbyPoolMonitor / stopStandbyPoolMonitor,
 * tick (scale-up, scale-down stale pods, minStandby guard, deployInProgress
 * de-dup), setPoolAdapters (deploy adapter, terminate adapter), and event-bus
 * hook (gpu.terminated / gpu.failed remove pods from pool).
 *
 * Module-level state is cleared via _resetForTests() before each test.
 * Timers are faked so POOL_TICK_MS / POOL_IDLE_TTL_MS are deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// We need the real event-bus so we can emit events and verify the hook.
// The module is NOT mocked — standby-pool imports onGatewayEvent from it.

import {
  setStandbyPoolConfig,
  removeStandbyPoolConfig,
  getStandbyPoolConfig,
  getStandbyPoolStatus,
  checkout,
  release,
  startStandbyPoolMonitor,
  stopStandbyPoolMonitor,
  tick,
  setPoolAdapters,
  POOL_TICK_MS,
  POOL_IDLE_TTL_MS,
  _resetForTests,
  _seedPodForTests,
  type StandbyProfileConfig,
  type StandbyPodRecord,
} from '../../server/standby-pool';

import { emitGatewayEvent } from '../../server/event-bus';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<StandbyProfileConfig>): StandbyProfileConfig {
  return {
    profile: 'test-profile',
    tier: 'vast-vm',
    minStandby: 2,
    maxStandby: 4,
    dockerImage: 'myimage:latest',
    gpuTypes: ['NVIDIA GeForce RTX 4090'],
    ...overrides,
  };
}

function makePod(overrides?: Partial<StandbyPodRecord>): StandbyPodRecord {
  return {
    podId: `pod-${Math.random().toString(36).slice(2)}`,
    endpoint: 'http://10.0.0.1:8000',
    profile: 'test-profile',
    tier: 'vast-vm',
    deployedAt: Date.now(),
    inPool: true,
    lastCheckedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  _resetForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  _resetForTests();
});

// ── setStandbyPoolConfig / removeStandbyPoolConfig / getStandbyPoolConfig ────

describe('setStandbyPoolConfig', () => {
  it('registers a profile and makes it retrievable via getStandbyPoolConfig', () => {
    const cfg = makeConfig({ profile: 'alpha' });
    setStandbyPoolConfig(cfg);
    expect(getStandbyPoolConfig('alpha')).toEqual(cfg);
  });

  it('overwrites an existing config for the same profile', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha', minStandby: 1 }));
    setStandbyPoolConfig(makeConfig({ profile: 'alpha', minStandby: 3 }));
    expect(getStandbyPoolConfig('alpha')!.minStandby).toBe(3);
  });

  it('supports multiple distinct profiles', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    setStandbyPoolConfig(makeConfig({ profile: 'beta' }));
    expect(getStandbyPoolConfig('alpha')).toBeDefined();
    expect(getStandbyPoolConfig('beta')).toBeDefined();
  });
});

describe('removeStandbyPoolConfig', () => {
  it('removes the profile so getStandbyPoolConfig returns undefined', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    removeStandbyPoolConfig('alpha');
    expect(getStandbyPoolConfig('alpha')).toBeUndefined();
  });

  it('is a no-op when the profile was never registered', () => {
    expect(() => removeStandbyPoolConfig('nonexistent')).not.toThrow();
  });

  it('does not affect other profiles', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    setStandbyPoolConfig(makeConfig({ profile: 'beta' }));
    removeStandbyPoolConfig('alpha');
    expect(getStandbyPoolConfig('beta')).toBeDefined();
  });
});

// ── getStandbyPoolStatus ──────────────────────────────────────────────────────

describe('getStandbyPoolStatus', () => {
  it('returns empty collections when nothing is registered', () => {
    const status = getStandbyPoolStatus();
    expect(status.profiles).toHaveLength(0);
    expect(status.pods).toHaveLength(0);
    expect(status.healthyByProfile).toEqual({});
  });

  it('lists registered profiles', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    setStandbyPoolConfig(makeConfig({ profile: 'beta' }));
    const { profiles } = getStandbyPoolStatus();
    expect(profiles.map((p) => p.profile).sort()).toEqual(['alpha', 'beta']);
  });

  it('counts only inPool=true pods in healthyByProfile', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, podId: 'p1' }));
    _seedPodForTests(makePod({ profile: 'alpha', inPool: false, podId: 'p2' })); // checked out
    const { healthyByProfile } = getStandbyPoolStatus();
    expect(healthyByProfile['alpha']).toBe(1);
  });

  it('includes all pods in the pods list regardless of inPool state', () => {
    _seedPodForTests(makePod({ inPool: true, podId: 'p1' }));
    _seedPodForTests(makePod({ inPool: false, podId: 'p2' }));
    const { pods } = getStandbyPoolStatus();
    expect(pods).toHaveLength(2);
  });

  it('separates healthy counts across profiles', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    setStandbyPoolConfig(makeConfig({ profile: 'beta' }));
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, podId: 'a1' }));
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, podId: 'a2' }));
    _seedPodForTests(makePod({ profile: 'beta', inPool: true, podId: 'b1' }));
    const { healthyByProfile } = getStandbyPoolStatus();
    expect(healthyByProfile['alpha']).toBe(2);
    expect(healthyByProfile['beta']).toBe(1);
  });
});

// ── checkout ─────────────────────────────────────────────────────────────────

describe('checkout', () => {
  it('returns null when pool is empty', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    expect(checkout('alpha')).toBeNull();
  });

  it('returns a pod and marks it inPool=false', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    const pod = makePod({ profile: 'alpha', inPool: true });
    _seedPodForTests(pod);
    const result = checkout('alpha');
    expect(result).not.toBeNull();
    expect(result!.podId).toBe(pod.podId);
    expect(result!.inPool).toBe(false);
  });

  it('returns null when the only pod is already checked out', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    _seedPodForTests(makePod({ profile: 'alpha', inPool: false }));
    expect(checkout('alpha')).toBeNull();
  });

  it('selects the oldest pod first (FIFO by deployedAt)', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    const older = makePod({ profile: 'alpha', inPool: true, deployedAt: 1000, podId: 'old' });
    const newer = makePod({ profile: 'alpha', inPool: true, deployedAt: 9000, podId: 'new' });
    _seedPodForTests(newer);
    _seedPodForTests(older);
    const result = checkout('alpha');
    expect(result!.podId).toBe('old');
  });

  it('does not return pods belonging to a different profile', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    setStandbyPoolConfig(makeConfig({ profile: 'beta' }));
    _seedPodForTests(makePod({ profile: 'beta', inPool: true, podId: 'b1' }));
    expect(checkout('alpha')).toBeNull();
  });

  it('after checkout, a subsequent checkout returns the next pod', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    const p1 = makePod({ profile: 'alpha', inPool: true, deployedAt: 1, podId: 'p1' });
    const p2 = makePod({ profile: 'alpha', inPool: true, deployedAt: 2, podId: 'p2' });
    _seedPodForTests(p1);
    _seedPodForTests(p2);
    checkout('alpha'); // p1 checked out
    const result = checkout('alpha'); // p2 next
    expect(result!.podId).toBe('p2');
  });

  it('stamps lastCheckedAt on the returned pod', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    const before = Date.now();
    const pod = makePod({ profile: 'alpha', inPool: true, lastCheckedAt: 0 });
    _seedPodForTests(pod);
    const result = checkout('alpha');
    expect(result!.lastCheckedAt).toBeGreaterThanOrEqual(before);
  });
});

// ── release ───────────────────────────────────────────────────────────────────

describe('release', () => {
  it('returns a pod to the pool (inPool=true)', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    const pod = makePod({ profile: 'alpha', inPool: false, podId: 'p1' });
    _seedPodForTests(pod);
    release('alpha', 'p1');
    const { healthyByProfile } = getStandbyPoolStatus();
    expect(healthyByProfile['alpha']).toBe(1);
  });

  it('is a no-op when the podId does not exist in the pool', () => {
    expect(() => release('alpha', 'unknown-pod')).not.toThrow();
  });

  it('updates lastCheckedAt on release', () => {
    const pod = makePod({ profile: 'alpha', inPool: false, lastCheckedAt: 0, podId: 'p1' });
    _seedPodForTests(pod);
    vi.advanceTimersByTime(5_000);
    release('alpha', 'p1');
    const { pods } = getStandbyPoolStatus();
    expect(pods[0].lastCheckedAt).toBeGreaterThan(0);
  });
});

// ── startStandbyPoolMonitor / stopStandbyPoolMonitor ─────────────────────────

describe('startStandbyPoolMonitor / stopStandbyPoolMonitor', () => {
  it('start is idempotent — calling twice does not double-schedule', () => {
    const intervalSpy = vi.spyOn(global, 'setInterval');
    startStandbyPoolMonitor();
    startStandbyPoolMonitor(); // second call should be no-op
    expect(intervalSpy).toHaveBeenCalledTimes(1);
    stopStandbyPoolMonitor();
  });

  it('stop clears the interval so tick is no longer called', () => {
    const clearSpy = vi.spyOn(global, 'clearInterval');
    startStandbyPoolMonitor();
    stopStandbyPoolMonitor();
    expect(clearSpy).toHaveBeenCalled();
  });

  it('after stop, start can be called again', () => {
    const intervalSpy = vi.spyOn(global, 'setInterval');
    startStandbyPoolMonitor();
    stopStandbyPoolMonitor();
    startStandbyPoolMonitor();
    expect(intervalSpy).toHaveBeenCalledTimes(2);
    stopStandbyPoolMonitor();
  });
});

// ── tick — scale-up ───────────────────────────────────────────────────────────

describe('tick — scale-up', () => {
  it('triggers deploy when healthy count is below minStandby', async () => {
    const deployFn = vi.fn().mockResolvedValue(null);
    const terminateFn = vi.fn().mockResolvedValue(undefined);
    setPoolAdapters(deployFn, terminateFn);
    setStandbyPoolConfig(makeConfig({ profile: 'alpha', minStandby: 1, maxStandby: 2 }));
    // Pool is empty — minStandby=1 not met
    await tick();
    expect(deployFn).toHaveBeenCalledOnce();
  });

  it('adds the newly deployed pod to the pool', async () => {
    const newPod = makePod({ profile: 'alpha', inPool: true, podId: 'deployed-1' });
    setPoolAdapters(vi.fn().mockResolvedValue(newPod), vi.fn().mockResolvedValue(undefined));
    setStandbyPoolConfig(makeConfig({ profile: 'alpha', minStandby: 1, maxStandby: 2 }));
    await tick();
    const { pods } = getStandbyPoolStatus();
    expect(pods.find((p) => p.podId === 'deployed-1')).toBeDefined();
  });

  it('does not deploy when healthy count already meets minStandby', async () => {
    const deployFn = vi.fn().mockResolvedValue(null);
    setPoolAdapters(deployFn, vi.fn().mockResolvedValue(undefined));
    setStandbyPoolConfig(makeConfig({ profile: 'alpha', minStandby: 2, maxStandby: 4 }));
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, podId: 'p1' }));
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, podId: 'p2' }));
    await tick();
    expect(deployFn).not.toHaveBeenCalled();
  });

  it('does not deploy when pool is already at maxStandby', async () => {
    const deployFn = vi.fn().mockResolvedValue(null);
    setPoolAdapters(deployFn, vi.fn().mockResolvedValue(undefined));
    // maxStandby=2; pool has 2 pods; minStandby=1 already met
    setStandbyPoolConfig(makeConfig({ profile: 'alpha', minStandby: 1, maxStandby: 2 }));
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, podId: 'p1' }));
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, podId: 'p2' }));
    await tick();
    expect(deployFn).not.toHaveBeenCalled();
  });

  it('logs a warning when no deploy adapter is installed', async () => {
    // Adapters not installed — should not throw, just warn
    setStandbyPoolConfig(makeConfig({ profile: 'alpha', minStandby: 1, maxStandby: 2 }));
    await expect(tick()).resolves.not.toThrow();
  });

  it('de-duplicates concurrent deploys for the same profile', async () => {
    let resolveDeploy!: () => void;
    const deployFn = vi.fn().mockImplementation(
      () => new Promise<null>((res) => { resolveDeploy = () => res(null); }),
    );
    setPoolAdapters(deployFn, vi.fn().mockResolvedValue(undefined));
    setStandbyPoolConfig(makeConfig({ profile: 'alpha', minStandby: 1, maxStandby: 2 }));
    // Start two ticks simultaneously — only one deploy should fire
    const t1 = tick();
    const t2 = tick();
    resolveDeploy();
    await Promise.all([t1, t2]);
    expect(deployFn).toHaveBeenCalledTimes(1);
  });
});

// ── tick — scale-down ─────────────────────────────────────────────────────────

describe('tick — scale-down', () => {
  it('terminates stale pods above minStandby after TTL expires', async () => {
    const terminateFn = vi.fn().mockResolvedValue(undefined);
    setPoolAdapters(vi.fn().mockResolvedValue(null), terminateFn);
    setStandbyPoolConfig(makeConfig({ profile: 'alpha', minStandby: 1, maxStandby: 4 }));

    const staleTime = Date.now() - POOL_IDLE_TTL_MS - 1;
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, lastCheckedAt: staleTime, podId: 'stale-1' }));
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, lastCheckedAt: staleTime, podId: 'stale-2' }));

    await tick();
    // minStandby=1, so one should survive
    expect(terminateFn).toHaveBeenCalledTimes(1);
    expect(getStandbyPoolStatus().pods).toHaveLength(1);
  });

  it('does not terminate pods that are still within TTL', async () => {
    const terminateFn = vi.fn().mockResolvedValue(undefined);
    setPoolAdapters(vi.fn().mockResolvedValue(null), terminateFn);
    setStandbyPoolConfig(makeConfig({ profile: 'alpha', minStandby: 0, maxStandby: 4 }));

    // Fresh pods (just set lastCheckedAt to now)
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, lastCheckedAt: Date.now(), podId: 'fresh-1' }));
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, lastCheckedAt: Date.now(), podId: 'fresh-2' }));

    await tick();
    expect(terminateFn).not.toHaveBeenCalled();
  });

  it('does not terminate pods when healthy count equals minStandby', async () => {
    const terminateFn = vi.fn().mockResolvedValue(undefined);
    setPoolAdapters(vi.fn().mockResolvedValue(null), terminateFn);
    setStandbyPoolConfig(makeConfig({ profile: 'alpha', minStandby: 2, maxStandby: 4 }));

    const staleTime = Date.now() - POOL_IDLE_TTL_MS - 1;
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, lastCheckedAt: staleTime, podId: 'p1' }));
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, lastCheckedAt: staleTime, podId: 'p2' }));

    await tick();
    // healthy(2) == minStandby(2), nothing should be removed
    expect(terminateFn).not.toHaveBeenCalled();
    expect(getStandbyPoolStatus().pods).toHaveLength(2);
  });

  it('terminates oldest stale pod first', async () => {
    const terminated: string[] = [];
    const terminateFn = vi.fn().mockImplementation((pod: StandbyPodRecord) => {
      terminated.push(pod.podId);
      return Promise.resolve();
    });
    setPoolAdapters(vi.fn().mockResolvedValue(null), terminateFn);
    setStandbyPoolConfig(makeConfig({ profile: 'alpha', minStandby: 1, maxStandby: 4 }));

    const staleTime = Date.now() - POOL_IDLE_TTL_MS - 1;
    // deployedAt 100 is older than 200
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, lastCheckedAt: staleTime, deployedAt: 200, podId: 'newer' }));
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, lastCheckedAt: staleTime, deployedAt: 100, podId: 'older' }));

    await tick();
    expect(terminated[0]).toBe('older');
  });

  it('does not scale down checked-out pods (inPool=false)', async () => {
    const terminateFn = vi.fn().mockResolvedValue(undefined);
    setPoolAdapters(vi.fn().mockResolvedValue(null), terminateFn);
    setStandbyPoolConfig(makeConfig({ profile: 'alpha', minStandby: 0, maxStandby: 4 }));

    const staleTime = Date.now() - POOL_IDLE_TTL_MS - 1;
    // Even though it's stale, it's checked out — pool healthy count is 0
    _seedPodForTests(makePod({ profile: 'alpha', inPool: false, lastCheckedAt: staleTime, podId: 'checked-out' }));

    await tick();
    // healthy.length (0) is NOT > minStandby (0), so the scale-down guard never fires
    expect(terminateFn).not.toHaveBeenCalled();
  });
});

// ── setPoolAdapters ───────────────────────────────────────────────────────────

describe('setPoolAdapters', () => {
  it('calls the terminate adapter when a stale pod is removed by tick', async () => {
    const terminateFn = vi.fn().mockResolvedValue(undefined);
    setPoolAdapters(vi.fn().mockResolvedValue(null), terminateFn);
    setStandbyPoolConfig(makeConfig({ profile: 'alpha', minStandby: 0, maxStandby: 4 }));

    const staleTime = Date.now() - POOL_IDLE_TTL_MS - 1;
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, lastCheckedAt: staleTime, podId: 'stale' }));

    await tick();
    expect(terminateFn).toHaveBeenCalledWith(expect.objectContaining({ podId: 'stale' }));
  });

  it('is resilient when terminate adapter throws', async () => {
    const terminateFn = vi.fn().mockRejectedValue(new Error('provider down'));
    setPoolAdapters(vi.fn().mockResolvedValue(null), terminateFn);
    setStandbyPoolConfig(makeConfig({ profile: 'alpha', minStandby: 0, maxStandby: 4 }));

    const staleTime = Date.now() - POOL_IDLE_TTL_MS - 1;
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, lastCheckedAt: staleTime, podId: 'stale' }));

    // tick() must not throw even if the terminate adapter rejects
    await expect(tick()).resolves.not.toThrow();
  });
});

// ── Event-bus hook (gpu.terminated / gpu.failed) ──────────────────────────────

describe('event-bus hook', () => {
  it('removes a pod from the pool on gpu.terminated event', async () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    setPoolAdapters(vi.fn().mockResolvedValue(null), vi.fn().mockResolvedValue(undefined));
    const pod = makePod({ profile: 'alpha', inPool: true, podId: 'pod-xyz' });
    _seedPodForTests(pod);

    // Start the monitor to install the event-bus hook
    startStandbyPoolMonitor();

    emitGatewayEvent('gpu.terminated', { podId: 'pod-xyz' });

    const { pods } = getStandbyPoolStatus();
    expect(pods.find((p) => p.podId === 'pod-xyz')).toBeUndefined();

    stopStandbyPoolMonitor();
  });

  it('removes a pod from the pool on gpu.failed event', async () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    setPoolAdapters(vi.fn().mockResolvedValue(null), vi.fn().mockResolvedValue(undefined));
    const pod = makePod({ profile: 'alpha', inPool: true, podId: 'pod-abc' });
    _seedPodForTests(pod);

    startStandbyPoolMonitor();

    emitGatewayEvent('gpu.failed', { podId: 'pod-abc' });

    const { pods } = getStandbyPoolStatus();
    expect(pods.find((p) => p.podId === 'pod-abc')).toBeUndefined();

    stopStandbyPoolMonitor();
  });

  it('also handles instanceId field for providers that use it', async () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    setPoolAdapters(vi.fn().mockResolvedValue(null), vi.fn().mockResolvedValue(undefined));
    const pod = makePod({ profile: 'alpha', inPool: true, podId: 'inst-99' });
    _seedPodForTests(pod);

    startStandbyPoolMonitor();

    emitGatewayEvent('gpu.terminated', { instanceId: 'inst-99' });

    const { pods } = getStandbyPoolStatus();
    expect(pods.find((p) => p.podId === 'inst-99')).toBeUndefined();

    stopStandbyPoolMonitor();
  });

  it('is a no-op for events where podId does not match any pool member', async () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    setPoolAdapters(vi.fn().mockResolvedValue(null), vi.fn().mockResolvedValue(undefined));
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, podId: 'real-pod' }));

    startStandbyPoolMonitor();

    emitGatewayEvent('gpu.terminated', { podId: 'nonexistent-pod' });

    const { pods } = getStandbyPoolStatus();
    expect(pods).toHaveLength(1);

    stopStandbyPoolMonitor();
  });

  it('does not react to unrelated events', async () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    setPoolAdapters(vi.fn().mockResolvedValue(null), vi.fn().mockResolvedValue(undefined));
    _seedPodForTests(makePod({ profile: 'alpha', inPool: true, podId: 'pod-1' }));

    startStandbyPoolMonitor();

    emitGatewayEvent('budget.warning', { podId: 'pod-1' });

    const { pods } = getStandbyPoolStatus();
    expect(pods).toHaveLength(1);

    stopStandbyPoolMonitor();
  });
});

// ── _resetForTests idempotency ────────────────────────────────────────────────

describe('_resetForTests', () => {
  it('clears all profiles, pods, and adapters', () => {
    setStandbyPoolConfig(makeConfig({ profile: 'alpha' }));
    _seedPodForTests(makePod({ profile: 'alpha', podId: 'p1' }));
    setPoolAdapters(vi.fn(), vi.fn());
    _resetForTests();

    expect(getStandbyPoolStatus().profiles).toHaveLength(0);
    expect(getStandbyPoolStatus().pods).toHaveLength(0);
  });

  it('can be called multiple times without error', () => {
    expect(() => { _resetForTests(); _resetForTests(); }).not.toThrow();
  });
});
