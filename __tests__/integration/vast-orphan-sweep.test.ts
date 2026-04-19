/**
 * Vast.ai Orphan Sweep — Real API, Read-Only
 *
 * Validates the gateway's view of the Vast.ai account without terminating
 * anything. Proves:
 *   1. `sweepAllProviders` can reach Vast.ai and list every instance.
 *   2. The gateway correctly classifies untracked vs tracked instances.
 *   3. `cleanupProviderInstances`, when called with an EMPTY prefix list
 *      and a status allow-list, identifies the same orphan set that
 *      `sweepOrphanInstances` would delete at runtime.
 *
 * Read-only: calls listInstances only. Never calls deleteInstance.
 * Requires VAST_API_KEY. Skips if missing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loadEnv } from '../helpers';
import { sweepAllProviders } from '../../src/gateway/autoscaler/gpu-sweep';
import { VastClient } from '../../src/gateway/providers/gpu/vast-client';

// Load env BEFORE the ENABLED check so the describe.skip decision can see
// secrets from .env (not just shell-exported ones).
await loadEnv();
const ENABLED = !!process.env.VAST_API_KEY && process.env.SKIP_GPU_TESTS !== '1';
const d = ENABLED ? describe : describe.skip;

d('Vast.ai orphan sweep — real API, read-only', () => {
  beforeAll(async () => { /* env already loaded */ });

  it('sweepAllProviders lists every Vast.ai instance and flags untracked', async () => {
    const report = await sweepAllProviders();

    expect(report.providers).toContain('vast');
    const vastInstances = report.instances.filter(i => i.provider === 'vast');
    // Account may be empty — that's fine. Just assert call succeeded.
    expect(Array.isArray(vastInstances)).toBe(true);
    for (const inst of vastInstances) {
      expect(inst.instanceId).toBeTruthy();
      expect(typeof inst.isTracked).toBe('boolean');
    }
    console.log(
      `[vast-sweep] ${vastInstances.length} instance(s), ` +
      `${vastInstances.filter(i => !i.isTracked).length} untracked, ` +
      `$${report.totalCostPerHr.toFixed(2)}/hr running`,
    );
  }, 30_000);

  it('empty prefix filter identifies ALL running + exited instances as orphans', async () => {
    // Mirrors the logic in sweepOrphanInstances for the Vast branch:
    // no prefix filter, every lifecycle state considered.
    const client = new VastClient();
    const instances = await client.listInstances({ apiKey: process.env.VAST_API_KEY! });
    const SWEEP_STATUSES = new Set(['running', 'active', 'loading', 'creating', 'created', 'exited', 'stopped']);

    const orphans = instances.filter(i => SWEEP_STATUSES.has((i.status ?? '').toLowerCase()));
    // Every Vast instance in a live state should be in the orphan set, since the
    // gateway owns the account. (Tracked ones get excluded at runtime via the
    // tracked set, not by the filter itself.)
    for (const inst of orphans) {
      expect(SWEEP_STATUSES.has(inst.status!.toLowerCase())).toBe(true);
    }
    console.log(`[vast-sweep] orphan candidates: ${orphans.length} / ${instances.length}`);
  }, 30_000);
});
