/**
 * Bug: standby-pool tick() scales DOWN past minStandby because the
 * inner loop's stop guard reads `healthy.length` from a snapshot array
 * that never shrinks. `pool.delete(podId)` removes from the global
 * pool Map but the local `healthy` array stays at its initial length,
 * so the `if (healthy.length <= cfg.minStandby) break` guard never
 * fires. Result: every stale pod above minStandby gets terminated in
 * a single tick, then refillProfile redeploys back up — pointless
 * churn and extra deploy cost.
 *
 * Correct behaviour: stop terminating once the running count would
 * drop to minStandby.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setStandbyPoolConfig,
  setPoolAdapters,
  tick,
  getStandbyPoolStatus,
  _resetForTests,
  _seedPodForTests,
} from '../../server/standby-pool';

describe('standby-pool tick — minStandby floor on scale-down', () => {
  beforeEach(() => _resetForTests());

  it('keeps at least minStandby pods even if all are stale (TTL exceeded)', async () => {
    setStandbyPoolConfig({
      profile: 'p1',
      tier: 'vast-vm',
      minStandby: 2,
      maxStandby: 5,
      dockerImage: 'img',
      gpuTypes: ['a'],
    });

    let terminated = 0;
    setPoolAdapters(
      async () => null, // no refill in this test (we want to observe scale-down only)
      async () => { terminated++; },
    );

    // Seed 5 stale pods (lastCheckedAt long ago — well past 15min TTL).
    const veryOldTs = Date.now() - 60 * 60 * 1000; // 1h ago
    for (let i = 0; i < 5; i++) {
      _seedPodForTests({
        podId: `pod-${i}`,
        endpoint: `http://1.2.3.${i}`,
        profile: 'p1',
        tier: 'vast-vm',
        deployedAt: veryOldTs,
        inPool: true,
        lastCheckedAt: veryOldTs,
      });
    }
    expect(getStandbyPoolStatus().pods.length).toBe(5);

    await tick();

    const remaining = getStandbyPoolStatus().pods.length;
    // Should leave minStandby (2) running; 3 should have been terminated.
    expect(remaining).toBe(2);
    expect(terminated).toBe(3);
  });
});
