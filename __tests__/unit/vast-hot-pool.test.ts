/**
 * VastHotPool — in-memory claim/release warm pool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VastHotPool } from '../../src/compute/vast-hot-pool';
import type { GpuInstance, InstanceSpec, ProviderCredentials } from '../../src/gateway/providers/gpu/types';

const creds: ProviderCredentials = { apiKey: 'test-key' };
const createSpec: InstanceSpec = {
  dockerImage: 'test:latest',
  offerPolicy: 'desktop',
  maxPricePerHr: 0.2,
};

function makeInst(id: string): GpuInstance {
  return { instanceId: id, endpoint: `http://${id}`, status: 'running' };
}

describe('VastHotPool', () => {
  let createInstance: ReturnType<typeof vi.fn>;
  let deleteInstance: ReturnType<typeof vi.fn>;
  let seq: number;

  beforeEach(() => {
    seq = 0;
    createInstance = vi.fn(async () => makeInst(`inst-${++seq}`));
    deleteInstance = vi.fn(async () => {});
  });

  function pool(opts: { minWarm?: number; maxSize?: number } = {}) {
    return new VastHotPool({
      client: { createInstance, deleteInstance },
      credentials: creds,
      createSpec,
      minWarm: opts.minWarm ?? 0,
      maxSize: opts.maxSize ?? 4,
    });
  }

  it('acquire provisions when no warm idle', async () => {
    const p = pool();
    const inst = await p.acquire();
    expect(inst.instanceId).toBe('inst-1');
    expect(createInstance).toHaveBeenCalledWith(createSpec, creds);
    expect(p.claimedCount).toBe(1);
    expect(p.idleCount).toBe(0);
  });

  it('acquire claims warm idle from refill', async () => {
    const p = pool({ minWarm: 1, maxSize: 1 });
    await p.refill();
    expect(p.idleCount).toBe(1);
    expect(createInstance).toHaveBeenCalledTimes(1);

    const inst = await p.acquire();
    expect(inst.instanceId).toBe('inst-1');
    // maxSize=1 and claimed=1 → refill cannot create another
    await p.refill();
    expect(createInstance).toHaveBeenCalledTimes(1);
    expect(p.claimedCount).toBe(1);
    expect(p.idleCount).toBe(0);
  });

  it('release destroys and does not return to idle', async () => {
    const p = pool({ minWarm: 0 });
    const inst = await p.acquire();
    await p.release(inst.instanceId);
    expect(deleteInstance).toHaveBeenCalledWith(inst.instanceId, creds);
    expect(p.claimedCount).toBe(0);
    expect(p.idleCount).toBe(0);
  });

  it('refill respects maxSize', async () => {
    const p = pool({ minWarm: 5, maxSize: 2 });
    await p.refill();
    expect(p.idleCount).toBe(2);
    expect(createInstance).toHaveBeenCalledTimes(2);
  });
});
