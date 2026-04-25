/**
 * Idle pause — provider-aware dispatch between stop and hibernate.
 *
 * Verifies:
 *   - Hyperstack + allowHibernate=true → client.hibernate() called.
 *   - Hyperstack + allowHibernate=false → client.stopInstance() called.
 *   - Non-hyperstack provider with allowHibernate=true → falls back to
 *     stopInstance (safety: hibernate is hyperstack-only today).
 *   - Client without `hibernate` method → falls back to stopInstance.
 *   - Resume: pausedMode='hibernate' + hyperstack → hibernateRestore().
 *   - Resume: pausedMode='stop' → startInstance().
 *   - Resume: pausedMode='hibernate' on non-hyperstack → startInstance().
 *   - standby-pool-adapter poolTerminate with hibernateOnIdle=true on
 *     hyperstack tier → hibernate() instead of deleteInstance().
 *   - poolTerminate with hibernateOnIdle=false or vast-vm tier →
 *     deleteInstance() (existing destructive behaviour preserved).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GpuProviderClient, ProviderCredentials } from '../src/gpu-providers/types';
import {
  pauseInstanceForIdle,
  resumeInstanceFromIdle,
} from '../src/gateway/providers/gpu/idle-pause';

function makeStubClient(providerId: string, opts: { withHibernate: boolean }) {
  const calls: string[] = [];
  const client: Partial<GpuProviderClient> & {
    hibernate?: (id: string, creds: ProviderCredentials) => Promise<void>;
    hibernateRestore?: (id: string, creds: ProviderCredentials) => Promise<void>;
  } = {
    providerId,
    bootTimeSecs: 60,
    async stopInstance(_id: string, _creds: ProviderCredentials) {
      calls.push('stopInstance');
    },
    async startInstance(_id: string, _creds: ProviderCredentials) {
      calls.push('startInstance');
    },
    async deleteInstance(_id: string, _creds: ProviderCredentials) {
      calls.push('deleteInstance');
    },
    // Other GpuProviderClient methods are irrelevant to this test — we
    // cast through `unknown` when passing to helper functions.
  };
  if (opts.withHibernate) {
    client.hibernate = async () => {
      calls.push('hibernate');
    };
    client.hibernateRestore = async () => {
      calls.push('hibernateRestore');
    };
  }
  return { client: client as unknown as GpuProviderClient, calls };
}

const CREDS: ProviderCredentials = { apiKey: 'k' };

describe('pauseInstanceForIdle', () => {
  it('hyperstack + allowHibernate=true calls hibernate() and returns "hibernate"', async () => {
    const { client, calls } = makeStubClient('hyperstack', { withHibernate: true });
    const mode = await pauseInstanceForIdle('hyperstack', 'vm-1', CREDS, client, {
      allowHibernate: true,
    });
    expect(mode).toBe('hibernate');
    expect(calls).toEqual(['hibernate']);
  });

  it('hyperstack + allowHibernate=false falls back to stopInstance', async () => {
    const { client, calls } = makeStubClient('hyperstack', { withHibernate: true });
    const mode = await pauseInstanceForIdle('hyperstack', 'vm-1', CREDS, client, {
      allowHibernate: false,
    });
    expect(mode).toBe('stop');
    expect(calls).toEqual(['stopInstance']);
  });

  it('non-hyperstack provider + allowHibernate=true still calls stopInstance (safety)', async () => {
    const { client, calls } = makeStubClient('vast', { withHibernate: true });
    const mode = await pauseInstanceForIdle('vast', 'vm-1', CREDS, client, {
      allowHibernate: true,
    });
    expect(mode).toBe('stop');
    expect(calls).toEqual(['stopInstance']);
  });

  it('client missing hibernate method → stopInstance', async () => {
    const { client, calls } = makeStubClient('hyperstack', { withHibernate: false });
    const mode = await pauseInstanceForIdle('hyperstack', 'vm-1', CREDS, client, {
      allowHibernate: true,
    });
    expect(mode).toBe('stop');
    expect(calls).toEqual(['stopInstance']);
  });

  it('default opts (no allowHibernate) preserves legacy stop behaviour', async () => {
    const { client, calls } = makeStubClient('hyperstack', { withHibernate: true });
    const mode = await pauseInstanceForIdle('hyperstack', 'vm-1', CREDS, client);
    expect(mode).toBe('stop');
    expect(calls).toEqual(['stopInstance']);
  });
});

describe('resumeInstanceFromIdle', () => {
  it('pausedMode=hibernate on hyperstack → hibernateRestore()', async () => {
    const { client, calls } = makeStubClient('hyperstack', { withHibernate: true });
    await resumeInstanceFromIdle('hyperstack', 'vm-1', CREDS, client, 'hibernate');
    expect(calls).toEqual(['hibernateRestore']);
  });

  it('pausedMode=stop → startInstance()', async () => {
    const { client, calls } = makeStubClient('hyperstack', { withHibernate: true });
    await resumeInstanceFromIdle('hyperstack', 'vm-1', CREDS, client, 'stop');
    expect(calls).toEqual(['startInstance']);
  });

  it('pausedMode=hibernate on non-hyperstack provider → startInstance() (safety)', async () => {
    const { client, calls } = makeStubClient('vast', { withHibernate: true });
    await resumeInstanceFromIdle('vast', 'vm-1', CREDS, client, 'hibernate');
    expect(calls).toEqual(['startInstance']);
  });

  it('undefined pausedMode → startInstance() (legacy default)', async () => {
    const { client, calls } = makeStubClient('hyperstack', { withHibernate: true });
    await resumeInstanceFromIdle('hyperstack', 'vm-1', CREDS, client, undefined);
    expect(calls).toEqual(['startInstance']);
  });
});

// ── standby-pool-adapter integration ─────────────────────────────────────
// Reuses the same mocking pattern as standby-pool-adapter.test.ts — stub
// both vast-vm and hyperstack clients behind `server/providers`.

const calls: string[] = [];

vi.mock('../server/providers', () => {
  const hyperstackStub = {
    providerId: 'hyperstack',
    async createInstance() {
      return {
        instanceId: 'hs-1',
        endpoint: 'http://hs.example/',
        status: 'running',
      };
    },
    async deleteInstance() {
      calls.push('hyperstack:deleteInstance');
    },
    async stopInstance() {
      calls.push('hyperstack:stopInstance');
    },
    async startInstance() {
      calls.push('hyperstack:startInstance');
    },
    async hibernate() {
      calls.push('hyperstack:hibernate');
    },
    async hibernateRestore() {
      calls.push('hyperstack:hibernateRestore');
    },
  };
  const vastStub = {
    providerId: 'vast-vm',
    async createInstance() {
      return {
        instanceId: 'vv-1',
        endpoint: 'http://vv.example/',
        status: 'running',
      };
    },
    async deleteInstance() {
      calls.push('vast-vm:deleteInstance');
    },
    async stopInstance() {
      calls.push('vast-vm:stopInstance');
    },
    async startInstance() {
      calls.push('vast-vm:startInstance');
    },
    // no hibernate — vast-vm doesn't support it
  };
  return { vastVm: vastStub, hyperstack: hyperstackStub };
});

vi.mock('../src/logger', () => ({
  createLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
}));

const emitted: Array<{ event: string; data: any }> = [];
vi.mock('../server/event-bus', async () => {
  const real = await vi.importActual<typeof import('../server/event-bus')>('../server/event-bus');
  return {
    ...real,
    emitGatewayEvent: (event: string, data: any) => {
      emitted.push({ event, data });
    },
  };
});

describe('standby-pool-adapter hibernateOnIdle', () => {
  beforeEach(async () => {
    calls.length = 0;
    emitted.length = 0;
    delete process.env.VAST_API_KEY;
    delete process.env.HYPERSTACK_API_KEY;
    delete process.env.STANDBY_POOL_GLOBAL_MAX;
    // Short-circuit health wait.
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

  it('hyperstack tier + hibernateOnIdle=true → hibernate() on terminate, emits gpu.stopped', async () => {
    process.env.HYPERSTACK_API_KEY = 'hk';
    const { installPoolAdaptersIfEnabled } = await import('../server/standby-pool-adapter');
    installPoolAdaptersIfEnabled();
    const {
      setStandbyPoolConfig,
      tick,
      getStandbyPoolStatus,
      _seedPodForTests,
    } = await import('../server/standby-pool');

    setStandbyPoolConfig({
      profile: 'hibernate-profile',
      tier: 'hyperstack',
      minStandby: 0,
      maxStandby: 0,
      dockerImage: 'ok:latest',
      gpuTypes: ['H100'],
      hibernateOnIdle: true,
      hibernateWakeOnRequest: true,
    });

    // Seed an existing pod that's already "old" enough to be scaled down:
    // deployedAt well in the past + lastCheckedAt old enough to clear
    // POOL_IDLE_TTL_MS (15min).
    const ancient = Date.now() - 20 * 60_000;
    _seedPodForTests({
      podId: 'hs-2',
      endpoint: 'http://hs2.example/',
      profile: 'hibernate-profile',
      tier: 'hyperstack',
      deployedAt: ancient,
      inPool: true,
      lastCheckedAt: ancient,
    });

    // Bump minStandby back to 0 so tick schedules teardown of the seeded pod.
    setStandbyPoolConfig({
      profile: 'hibernate-profile',
      tier: 'hyperstack',
      minStandby: 0,
      maxStandby: 0,
      dockerImage: 'ok:latest',
      gpuTypes: ['H100'],
      hibernateOnIdle: true,
      hibernateWakeOnRequest: true,
    });

    await tick();
    // tick() triggers terminate async — give the microtask queue one flush
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls).toContain('hyperstack:hibernate');
    expect(calls).not.toContain('hyperstack:deleteInstance');
    const stopped = emitted.find((e) => e.event === 'gpu.stopped');
    expect(stopped).toBeTruthy();
    expect(stopped!.data.pausedMode).toBe('hibernate');
    expect(stopped!.data.wakeOnRequest).toBe(true);
    expect(getStandbyPoolStatus().pods.find((p) => p.podId === 'hs-2')).toBeUndefined();
  });

  it('hyperstack tier + hibernateOnIdle=false → deleteInstance() (legacy behaviour)', async () => {
    process.env.HYPERSTACK_API_KEY = 'hk';
    const { installPoolAdaptersIfEnabled } = await import('../server/standby-pool-adapter');
    installPoolAdaptersIfEnabled();
    const {
      setStandbyPoolConfig,
      tick,
      _seedPodForTests,
    } = await import('../server/standby-pool');

    setStandbyPoolConfig({
      profile: 'terminate-profile',
      tier: 'hyperstack',
      minStandby: 0,
      maxStandby: 0,
      dockerImage: 'ok:latest',
      gpuTypes: ['H100'],
      // hibernateOnIdle omitted → defaults to false
    });

    const ancient = Date.now() - 20 * 60_000;
    _seedPodForTests({
      podId: 'hs-3',
      endpoint: 'http://hs3.example/',
      profile: 'terminate-profile',
      tier: 'hyperstack',
      deployedAt: ancient,
      inPool: true,
      lastCheckedAt: ancient,
    });

    await tick();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls).toContain('hyperstack:deleteInstance');
    expect(calls).not.toContain('hyperstack:hibernate');
    expect(emitted.some((e) => e.event === 'gpu.terminated')).toBe(true);
  });

  it('vast-vm tier + hibernateOnIdle=true → falls back to deleteInstance (no hibernate support)', async () => {
    process.env.VAST_API_KEY = 'vk';
    const { installPoolAdaptersIfEnabled } = await import('../server/standby-pool-adapter');
    installPoolAdaptersIfEnabled();
    const {
      setStandbyPoolConfig,
      tick,
      _seedPodForTests,
    } = await import('../server/standby-pool');

    setStandbyPoolConfig({
      profile: 'vast-hibernate-profile',
      tier: 'vast-vm',
      minStandby: 0,
      maxStandby: 0,
      dockerImage: 'ok:latest',
      gpuTypes: ['RTX 4090'],
      hibernateOnIdle: true, // requested but vast-vm doesn't support it
    });

    const ancient = Date.now() - 20 * 60_000;
    _seedPodForTests({
      podId: 'vv-2',
      endpoint: 'http://vv2.example/',
      profile: 'vast-hibernate-profile',
      tier: 'vast-vm',
      deployedAt: ancient,
      inPool: true,
      lastCheckedAt: ancient,
    });

    await tick();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // hibernateOnIdle=true caused pauseInstanceForIdle to be invoked; since
    // vast-vm's client lacks `hibernate`, the helper fell back to
    // `stopInstance`. The adapter emits gpu.stopped with pausedMode='stop'.
    expect(calls).toContain('vast-vm:stopInstance');
    expect(calls).not.toContain('vast-vm:deleteInstance');
    const stopped = emitted.find((e) => e.event === 'gpu.stopped');
    expect(stopped).toBeTruthy();
    expect(stopped!.data.pausedMode).toBe('stop');
  });
});
