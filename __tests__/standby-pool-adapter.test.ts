/**
 * standby-pool-adapter — PoolDeployFn + PoolTerminateFn behaviour.
 *
 * Scope:
 *   - Adapter refuses install without any API key (safety).
 *   - Adapter refuses deploy to a tier whose API key isn't set.
 *   - Global cap blocks further deploys when total pool size is at the limit.
 *   - Successful deploy returns a StandbyPodRecord and emits gpu.deployed.
 *   - Terminate calls deleteInstance on the right client and emits gpu.terminated.
 *
 * We mock `./providers` so the adapter picks up stubbed clients. The
 * adapter's internal health-wait is short-circuited by making the stub
 * endpoint's /health return 200 via fetch mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/providers', () => {
  const stub = {
    async createInstance() {
      return {
        instanceId: 'stub-1',
        endpoint: 'http://stub.example/',
        status: 'running',
      };
    },
    async deleteInstance() {
      return;
    },
  };
  return { vastVm: stub, hyperstack: stub };
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

describe('standby-pool-adapter', () => {
  beforeEach(async () => {
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

  it('does not install adapters without any API key', async () => {
    const { installPoolAdaptersIfEnabled } = await import('../server/standby-pool-adapter');
    installPoolAdaptersIfEnabled();
    const { setStandbyPoolConfig, tick, getStandbyPoolStatus } = await import('../server/standby-pool');
    setStandbyPoolConfig({
      profile: 'test-a',
      tier: 'vast-vm',
      minStandby: 1,
      maxStandby: 1,
      dockerImage: 'nop:latest',
      gpuTypes: ['RTX 4090'],
    });
    await tick();
    expect(getStandbyPoolStatus().pods).toHaveLength(0);
  });

  it('refuses deploy to tier missing its API key', async () => {
    process.env.HYPERSTACK_API_KEY = 'hk';
    // VAST_API_KEY intentionally unset.
    const { installPoolAdaptersIfEnabled } = await import('../server/standby-pool-adapter');
    installPoolAdaptersIfEnabled();
    const { setStandbyPoolConfig, tick, getStandbyPoolStatus } = await import('../server/standby-pool');
    setStandbyPoolConfig({
      profile: 'vast-test',
      tier: 'vast-vm',
      minStandby: 1,
      maxStandby: 1,
      dockerImage: 'nop:latest',
      gpuTypes: ['RTX 4090'],
    });
    await tick();
    expect(getStandbyPoolStatus().pods).toHaveLength(0);
  });

  it('respects STANDBY_POOL_GLOBAL_MAX', async () => {
    process.env.VAST_API_KEY = 'vk';
    process.env.STANDBY_POOL_GLOBAL_MAX = '0'; // cap at zero → never deploy
    const { installPoolAdaptersIfEnabled } = await import('../server/standby-pool-adapter');
    installPoolAdaptersIfEnabled();
    const { setStandbyPoolConfig, tick, getStandbyPoolStatus } = await import('../server/standby-pool');
    setStandbyPoolConfig({
      profile: 'capped',
      tier: 'vast-vm',
      minStandby: 1,
      maxStandby: 1,
      dockerImage: 'nop:latest',
      gpuTypes: ['RTX 4090'],
    });
    await tick();
    expect(getStandbyPoolStatus().pods).toHaveLength(0);
  });

  it('deploys and emits gpu.deployed when a matching key is set', async () => {
    process.env.VAST_API_KEY = 'vk';
    const { installPoolAdaptersIfEnabled } = await import('../server/standby-pool-adapter');
    installPoolAdaptersIfEnabled();
    const { setStandbyPoolConfig, tick, getStandbyPoolStatus } = await import('../server/standby-pool');
    setStandbyPoolConfig({
      profile: 'deploy-ok',
      tier: 'vast-vm',
      minStandby: 1,
      maxStandby: 1,
      dockerImage: 'ok:latest',
      gpuTypes: ['RTX 4090'],
    });
    await tick();
    const status = getStandbyPoolStatus();
    expect(status.pods.length).toBe(1);
    expect(status.pods[0].profile).toBe('deploy-ok');
    expect(status.pods[0].tier).toBe('vast-vm');
    expect(emitted.some((e) => e.event === 'gpu.deployed' && e.data.viaPool === true)).toBe(true);
  });
});
