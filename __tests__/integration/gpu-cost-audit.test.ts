/**
 * GPU Cost Audit — real API, read-only.
 *
 * Validates that auditGpuCosts() can reach each provider and produce a
 * sensible inventory of non-instance cost leaks (RunPod network volumes,
 * stopped Vast.ai pods). Never calls deleteNetworkVolume.
 *
 * Requires VAST_API_KEY and/or RUNPOD_API_KEY. Skips if neither is set.
 */

import { describe, it, expect } from 'vitest';
import { loadEnv } from '../helpers';

await loadEnv();
const HAS_KEYS = (!!process.env.VAST_API_KEY || !!process.env.RUNPOD_API_KEY)
  && process.env.SKIP_GPU_TESTS !== '1';
const d = HAS_KEYS ? describe : describe.skip;

d('GPU cost audit — real API, read-only', () => {
  it('auditGpuCosts returns a well-formed report', async () => {
    const { auditGpuCosts } = await import('../../server/gpu-cost-audit');
    const report = await auditGpuCosts({ destroyOrphans: false });

    expect(report.ts).toBeTruthy();
    expect(Array.isArray(report.volumes.runpod)).toBe(true);
    expect(Array.isArray(report.stoppedPods)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(typeof report.volumes.totalMonthlyUsd).toBe('number');
    expect(typeof report.volumes.orphanCount).toBe('number');

    console.log(
      `[cost-audit] RunPod volumes=${report.volumes.runpod.length} ` +
      `orphans=${report.volumes.orphanCount} ` +
      `~$${report.volumes.totalMonthlyUsd.toFixed(2)}/month | ` +
      `stopped pods=${report.stoppedPods.length} | ` +
      `warnings=${report.warnings.length}`,
    );

    for (const v of report.volumes.runpod) {
      expect(v.id).toBeTruthy();
      expect(typeof v.sizeGb).toBe('number');
      expect(v.estMonthlyUsd).toBeCloseTo(v.sizeGb * 0.10, 3);
    }
  }, 30_000);

  it('destroy path is a no-op without RUNPOD_VOLUME_SWEEP_DESTROY=1 env', async () => {
    // Safety: even if the caller passes destroyOrphans:true, the env flag
    // must be explicitly set. This test proves the belt-and-braces works
    // so we can't accidentally nuke volumes from an integration run.
    const prev = process.env.RUNPOD_VOLUME_SWEEP_DESTROY;
    delete process.env.RUNPOD_VOLUME_SWEEP_DESTROY;
    try {
      const { auditGpuCosts } = await import('../../server/gpu-cost-audit');
      const report = await auditGpuCosts({ destroyOrphans: true });
      // Report returns but no deletes happened. Re-running gives the same volumes.
      const report2 = await auditGpuCosts({ destroyOrphans: false });
      expect(report2.volumes.runpod.length).toBe(report.volumes.runpod.length);
    } finally {
      if (prev !== undefined) process.env.RUNPOD_VOLUME_SWEEP_DESTROY = prev;
    }
  }, 30_000);
});
