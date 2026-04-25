/**
 * standby-pool offloadOnIdle — verifies that when a hyperstack profile has
 * offloadOnIdle=true, idle pool slots are offloaded via the SSH bench-file
 * protocol instead of hibernated or terminated. The VM keeps running (so no
 * billing savings on Hyperstack) but wake-on-request becomes ~2-5s vs
 * ~60-90s for hibernate.
 *
 * Stubs both `../server/providers` (so no real GPU client is constructed)
 * and `../src/gateway/providers/gpu/vm-offload` (so no real SSH).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const offloadCalls: Array<{ host: string; port: number }> = [];
const emitted: Array<{ event: string; data: any }> = [];
const providerCalls: string[] = [];

vi.mock('../src/gateway/providers/gpu/vm-offload', () => ({
  offloadVm: async (target: { host: string; port: number }) => {
    offloadCalls.push({ host: target.host, port: target.port });
    return true;
  },
}));

vi.mock('../server/providers', () => {
  const hyperstackStub = {
    providerId: 'hyperstack',
    async createInstance() {
      return {
        instanceId: 'hs-offload-1',
        endpoint: 'http://hs.example/',
        status: 'running',
        sshHost: '10.0.0.77',
        sshPort: 22,
      };
    },
    async deleteInstance() {
      providerCalls.push('hyperstack:deleteInstance');
    },
    async stopInstance() {
      providerCalls.push('hyperstack:stopInstance');
    },
    async startInstance() {
      providerCalls.push('hyperstack:startInstance');
    },
    async hibernate() {
      providerCalls.push('hyperstack:hibernate');
    },
    async hibernateRestore() {
      providerCalls.push('hyperstack:hibernateRestore');
    },
  };
  return { vastVm: hyperstackStub, hyperstack: hyperstackStub };
});

vi.mock('../src/logger', () => ({
  createLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
}));

vi.mock('../server/event-bus', async () => {
  const real = await vi.importActual<typeof import('../server/event-bus')>('../server/event-bus');
  return {
    ...real,
    emitGatewayEvent: (event: string, data: any) => {
      emitted.push({ event, data });
    },
  };
});

describe('standby-pool offloadOnIdle', () => {
  beforeEach(async () => {
    offloadCalls.length = 0;
    emitted.length = 0;
    providerCalls.length = 0;
    delete process.env.VAST_API_KEY;
    delete process.env.HYPERSTACK_API_KEY;
    delete process.env.STANDBY_POOL_GLOBAL_MAX;
    // Short-circuit pool health wait.
    // @ts-expect-error override global fetch for test
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { _resetForTests } = await import('../server/standby-pool');
    _resetForTests();
    const { _resetAdapterForTests } = await import('../server/standby-pool-adapter');
    _resetAdapterForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hyperstack tier + offloadOnIdle=true → offloadVm called, no hibernate, no delete', async () => {
    process.env.HYPERSTACK_API_KEY = 'hk';
    const { installPoolAdaptersIfEnabled } = await import('../server/standby-pool-adapter');
    installPoolAdaptersIfEnabled();
    const { setStandbyPoolConfig, tick, _seedPodForTests, getStandbyPoolStatus } =
      await import('../server/standby-pool');

    setStandbyPoolConfig({
      profile: 'offload-profile',
      tier: 'hyperstack',
      minStandby: 0,
      maxStandby: 0,
      dockerImage: 'ok:latest',
      gpuTypes: ['L40S'],
      offloadOnIdle: true,
    });

    const ancient = Date.now() - 20 * 60_000;
    _seedPodForTests({
      podId: 'hs-off-2',
      endpoint: 'http://hs-off.example/',
      profile: 'offload-profile',
      tier: 'hyperstack',
      deployedAt: ancient,
      inPool: true,
      lastCheckedAt: ancient,
      sshHost: '10.0.0.77',
      sshPort: 22,
    });

    await tick();
    // tick schedules async terminate — flush microtasks.
    await new Promise((r) => setTimeout(r, 20));

    expect(offloadCalls.length).toBe(1);
    expect(offloadCalls[0]).toEqual({ host: '10.0.0.77', port: 22 });
    expect(providerCalls).not.toContain('hyperstack:hibernate');
    expect(providerCalls).not.toContain('hyperstack:deleteInstance');
    const stopped = emitted.find((e) => e.event === 'gpu.stopped');
    expect(stopped).toBeTruthy();
    expect(stopped!.data.pausedMode).toBe('offload');
    expect(stopped!.data.wakeOnRequest).toBe(true);
    // Pod is removed from pool on successful offload (pool manages membership).
    expect(getStandbyPoolStatus().pods.find((p) => p.podId === 'hs-off-2')).toBeUndefined();
  });

  it('offloadOnIdle=true with hibernateOnIdle=true → offload wins (no hibernate call)', async () => {
    process.env.HYPERSTACK_API_KEY = 'hk';
    const { installPoolAdaptersIfEnabled } = await import('../server/standby-pool-adapter');
    installPoolAdaptersIfEnabled();
    const { setStandbyPoolConfig, tick, _seedPodForTests } =
      await import('../server/standby-pool');

    setStandbyPoolConfig({
      profile: 'offload-priority',
      tier: 'hyperstack',
      minStandby: 0,
      maxStandby: 0,
      dockerImage: 'ok:latest',
      gpuTypes: ['L40S'],
      offloadOnIdle: true,
      hibernateOnIdle: true, // both set — offload must take precedence
    });

    const ancient = Date.now() - 20 * 60_000;
    _seedPodForTests({
      podId: 'hs-both-1',
      endpoint: 'http://hs-both.example/',
      profile: 'offload-priority',
      tier: 'hyperstack',
      deployedAt: ancient,
      inPool: true,
      lastCheckedAt: ancient,
      sshHost: '10.0.0.88',
      sshPort: 22,
    });

    await tick();
    await new Promise((r) => setTimeout(r, 20));

    expect(offloadCalls.length).toBe(1);
    expect(providerCalls).not.toContain('hyperstack:hibernate');
    expect(providerCalls).not.toContain('hyperstack:deleteInstance');
  });

  it('offloadOnIdle=true but pod has no sshHost → falls through to legacy terminate', async () => {
    process.env.HYPERSTACK_API_KEY = 'hk';
    const { installPoolAdaptersIfEnabled } = await import('../server/standby-pool-adapter');
    installPoolAdaptersIfEnabled();
    const { setStandbyPoolConfig, tick, _seedPodForTests } =
      await import('../server/standby-pool');

    setStandbyPoolConfig({
      profile: 'offload-nossh',
      tier: 'hyperstack',
      minStandby: 0,
      maxStandby: 0,
      dockerImage: 'ok:latest',
      gpuTypes: ['L40S'],
      offloadOnIdle: true,
    });

    const ancient = Date.now() - 20 * 60_000;
    _seedPodForTests({
      podId: 'hs-nossh-1',
      endpoint: 'http://hs-nossh.example/',
      profile: 'offload-nossh',
      tier: 'hyperstack',
      deployedAt: ancient,
      inPool: true,
      lastCheckedAt: ancient,
      // sshHost/sshPort intentionally omitted
    });

    await tick();
    await new Promise((r) => setTimeout(r, 20));

    expect(offloadCalls.length).toBe(0);
    // Without sshHost, the adapter skips offload and uses the existing
    // terminate path (hibernateOnIdle is false → deleteInstance).
    expect(providerCalls).toContain('hyperstack:deleteInstance');
  });
});
