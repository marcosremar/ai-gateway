/**
 * Bug: cleanupVastInstances/cleanupTensordockInstances/cleanupModalApps/
 * cleanupHyperstackInstances bypass the new double-flag safety guard.
 *
 * The header comment of gpu-orphan-cleanup.ts (forensic incident 2026-04-26)
 * says nuking untracked instances now requires BOTH:
 *   1. <PROVIDER>_ACCOUNT_OWNED=1
 *   2. AIGW_<PROVIDER>_NUKE_UNTRACKED=1
 *
 * sweepOrphanInstances() correctly enforces this via nukeUntrackedAllowed().
 * But cleanupVastInstances() and friends still pass `prefixesForProvider(...)`
 * which returns [] when ACCOUNT_OWNED=1 alone — bypassing the second guard
 * and reverting to the unsafe single-flag kill-all behavior.
 *
 * This test documents the expected behavior: with ACCOUNT_OWNED=1 but NOT
 * NUKE_UNTRACKED=1, the prefix safety filter should still apply.
 */
import { describe, it, expect, afterEach } from 'vitest';

describe('cleanup bypass of double-flag safety guard', () => {
  afterEach(() => {
    delete process.env.VAST_ACCOUNT_OWNED;
    delete process.env.AIGW_VAST_NUKE_UNTRACKED;
    delete process.env.RUNPOD_ACCOUNT_OWNED;
    delete process.env.AIGW_RUNPOD_NUKE_UNTRACKED;
  });

  it('prefixesForProvider returns the GATEWAY_NAME_PREFIXES when ACCOUNT_OWNED=1 but NUKE_UNTRACKED is not set', async () => {
    process.env.VAST_ACCOUNT_OWNED = '1';
    // NUKE_UNTRACKED intentionally NOT set
    const { prefixesForProvider, GATEWAY_NAME_PREFIXES } = await import('../../server/gpu-orphan-cleanup');

    // Without the second flag, the safety filter must still apply.
    // Returning [] means "kill-all" which violates the documented double-flag guard.
    const result = prefixesForProvider('vast');
    expect(result).toEqual(GATEWAY_NAME_PREFIXES);
  });

  it('prefixesForProvider returns [] only when BOTH ACCOUNT_OWNED=1 AND NUKE_UNTRACKED=1', async () => {
    process.env.VAST_ACCOUNT_OWNED = '1';
    process.env.AIGW_VAST_NUKE_UNTRACKED = '1';
    const { prefixesForProvider } = await import('../../server/gpu-orphan-cleanup');
    expect(prefixesForProvider('vast')).toEqual([]);
  });

  it('same guard applies to runpod', async () => {
    process.env.RUNPOD_ACCOUNT_OWNED = '1';
    // NUKE_UNTRACKED not set
    const { prefixesForProvider, GATEWAY_NAME_PREFIXES } = await import('../../server/gpu-orphan-cleanup');
    expect(prefixesForProvider('runpod')).toEqual(GATEWAY_NAME_PREFIXES);
  });
});
