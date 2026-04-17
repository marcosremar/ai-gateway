/**
 * Phase B4 — standby pool behaviour.
 *
 * Verifies checkout/release/tick refills. Deploy + terminate are stubbed
 * via setPoolAdapters so no real GPU is involved.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as pool from '../server/standby-pool';

function makeRecord(partial: Partial<pool.StandbyPodRecord> = {}): pool.StandbyPodRecord {
  return {
    podId: `pod-${Math.random().toString(36).slice(2, 8)}`,
    endpoint: 'http://10.0.0.1:8000',
    profile: 'babelcast',
    tier: 'vast-vm',
    deployedAt: Date.now(),
    inPool: true,
    lastCheckedAt: Date.now(),
    ...partial,
  };
}

describe('standby pool', () => {
  beforeEach(() => {
    pool._resetForTests();
  });

  it('returns null from checkout when no pods are ready', () => {
    pool.setStandbyPoolConfig({
      profile: 'babelcast',
      tier: 'vast-vm',
      minStandby: 1,
      maxStandby: 2,
      dockerImage: 'foo',
      gpuTypes: ['RTX 4090'],
    });
    expect(pool.checkout('babelcast')).toBeNull();
  });

  it('returns the oldest ready pod on checkout', () => {
    pool.setStandbyPoolConfig({
      profile: 'babelcast',
      tier: 'vast-vm',
      minStandby: 1,
      maxStandby: 2,
      dockerImage: 'foo',
      gpuTypes: ['RTX 4090'],
    });
    const a = makeRecord({ podId: 'a', deployedAt: Date.now() - 60_000 });
    const b = makeRecord({ podId: 'b', deployedAt: Date.now() });
    pool._seedPodForTests(a);
    pool._seedPodForTests(b);

    const picked = pool.checkout('babelcast');
    expect(picked?.podId).toBe('a');
    // Status updated — no longer in pool
    expect(picked?.inPool).toBe(false);
  });

  it('tick triggers deploy when below minStandby', async () => {
    const deployFn = vi.fn(async (cfg: pool.StandbyProfileConfig) =>
      makeRecord({ podId: `new-${cfg.profile}`, profile: cfg.profile, tier: cfg.tier }),
    );
    const terminateFn = vi.fn(async () => {});
    pool.setPoolAdapters(deployFn, terminateFn);
    pool.setStandbyPoolConfig({
      profile: 'babelcast',
      tier: 'vast-vm',
      minStandby: 1,
      maxStandby: 2,
      dockerImage: 'foo',
      gpuTypes: ['RTX 4090'],
    });
    await pool.tick();
    expect(deployFn).toHaveBeenCalledTimes(1);
    const status = pool.getStandbyPoolStatus();
    expect(status.healthyByProfile.babelcast).toBe(1);
  });

  it('tick does nothing when already at minStandby', async () => {
    const deployFn = vi.fn();
    const terminateFn = vi.fn();
    pool.setPoolAdapters(deployFn as any, terminateFn);
    pool.setStandbyPoolConfig({
      profile: 'babelcast',
      tier: 'vast-vm',
      minStandby: 1,
      maxStandby: 2,
      dockerImage: 'foo',
      gpuTypes: ['RTX 4090'],
    });
    pool._seedPodForTests(makeRecord({ profile: 'babelcast' }));
    await pool.tick();
    expect(deployFn).not.toHaveBeenCalled();
  });

  it('checkout triggers async refill when adapter is set', async () => {
    const deployFn = vi.fn(async (cfg: pool.StandbyProfileConfig) => makeRecord({ profile: cfg.profile, tier: cfg.tier }));
    const terminateFn = vi.fn(async () => {});
    pool.setPoolAdapters(deployFn, terminateFn);
    pool.setStandbyPoolConfig({
      profile: 'babelcast',
      tier: 'vast-vm',
      minStandby: 1,
      maxStandby: 2,
      dockerImage: 'foo',
      gpuTypes: ['RTX 4090'],
    });
    pool._seedPodForTests(makeRecord({ podId: 'seed', profile: 'babelcast' }));
    const picked = pool.checkout('babelcast');
    expect(picked).not.toBeNull();
    // Allow the microtask to fire
    await new Promise((r) => setTimeout(r, 0));
    expect(deployFn).toHaveBeenCalled();
  });

  it('release toggles inPool back to true', () => {
    pool.setStandbyPoolConfig({
      profile: 'babelcast',
      tier: 'vast-vm',
      minStandby: 1,
      maxStandby: 2,
      dockerImage: 'foo',
      gpuTypes: ['RTX 4090'],
    });
    const r = makeRecord({ inPool: false });
    pool._seedPodForTests(r);
    pool.release('babelcast', r.podId);
    const status = pool.getStandbyPoolStatus();
    expect(status.healthyByProfile.babelcast).toBe(1);
  });
});
