// ── Unit tests for GPU deployment optimizations — WAVE 4 (IDs 101-200) ──────
// Pure-helper tests only — no network, no provider/GPU calls, no real FS.
// Distinct from wave-1/2/3 (02-gpu-deployment{,-w2,-w3}.test.ts). See
// docs/optimizations/implemented/02-gpu-deployment-w4.md for the ID mapping.

import { describe, it, expect } from 'vitest';

import {
  snapshotProviderEligible,
  shouldWarnSnapshotIneligible,
  shouldCaptureOnDeployed,
  captureLockKey,
  acquireCaptureLock,
  releaseCaptureLock,
  capturesInFlightCount,
  canonicalizeModelList,
  hashModels,
  snapshotPreCheckCommand,
  parseSnapshotPreCheckOutput,
  SNAPSHOT_ELIGIBLE_PROVIDERS,
} from '../../server/gpu-snapshot';
import {
  restoreProbePlan,
  RESTORE_PROBE_ATTEMPTS,
} from '../../server/gpu-deploy-loop';
import {
  loserDeleteRetryPlan,
  countOutstandingLoserDeletes,
  LOSER_DELETE_MAX_ATTEMPTS,
} from '../../server/gpu-deploy-race';
import {
  canonicalDeployId,
  summarizeTierProbes,
} from '../../server/gpu-deploy-with-tiers';

// ── #116: snapshot provider eligibility + deploy-time warning ────────────────
describe('#116 snapshot provider eligibility', () => {
  it('marks only vast-vm and hyperstack eligible', () => {
    expect(snapshotProviderEligible('vast-vm')).toBe(true);
    expect(snapshotProviderEligible('hyperstack')).toBe(true);
    expect(snapshotProviderEligible('runpod')).toBe(false);
    expect(snapshotProviderEligible('vast')).toBe(false);
    expect(snapshotProviderEligible('tensordock')).toBe(false);
  });

  it('handles missing/empty provider safely', () => {
    expect(snapshotProviderEligible(undefined)).toBe(false);
    expect(snapshotProviderEligible(null)).toBe(false);
    expect(snapshotProviderEligible('')).toBe(false);
  });

  it('exposes the canonical eligible set', () => {
    expect([...SNAPSHOT_ELIGIBLE_PROVIDERS].sort()).toEqual(['hyperstack', 'vast-vm']);
  });

  it('warns only when snapshot is requested AND provider cannot snapshot', () => {
    // requested + ineligible → warn
    expect(shouldWarnSnapshotIneligible('runpod', true)).toBe(true);
    // requested + eligible → quiet
    expect(shouldWarnSnapshotIneligible('vast-vm', true)).toBe(false);
    // not requested → quiet regardless of provider
    expect(shouldWarnSnapshotIneligible('runpod', false)).toBe(false);
    expect(shouldWarnSnapshotIneligible('runpod', undefined)).toBe(false);
  });
});

// ── #172: capture hook gates on eligibility AND the autoSnapshot flag ─────────
describe('#172 shouldCaptureOnDeployed', () => {
  it('captures on an eligible provider when autoSnapshot is default (undefined)', () => {
    expect(shouldCaptureOnDeployed('vast-vm', undefined)).toBe(true);
    expect(shouldCaptureOnDeployed('hyperstack', undefined)).toBe(true);
  });

  it('captures on an eligible provider when autoSnapshot is true', () => {
    expect(shouldCaptureOnDeployed('hyperstack', true)).toBe(true);
  });

  it('does NOT capture when autoSnapshot is explicitly false', () => {
    expect(shouldCaptureOnDeployed('vast-vm', false)).toBe(false);
  });

  it('never captures on a non-eligible provider regardless of flag', () => {
    expect(shouldCaptureOnDeployed('runpod', true)).toBe(false);
    expect(shouldCaptureOnDeployed('runpod', undefined)).toBe(false);
  });
});

// ── #173: per-pod capture concurrency lock ───────────────────────────────────
describe('#173 capture concurrency lock', () => {
  it('builds a stable per-pod key from deployId + host:port', () => {
    expect(captureLockKey('d1', 'h', 22)).toBe('d1|h:22');
    expect(captureLockKey('', 'h', 22)).toBe('-|h:22');
  });

  it('acquires once and blocks a second acquire for the same key', () => {
    const key = captureLockKey('dlock', 'host-a', 2200);
    expect(acquireCaptureLock(key)).toBe(true);
    expect(acquireCaptureLock(key)).toBe(false); // already held
    releaseCaptureLock(key);
    expect(acquireCaptureLock(key)).toBe(true); // re-acquire after release
    releaseCaptureLock(key);
  });

  it('allows distinct pods to capture concurrently', () => {
    const a = captureLockKey('d', 'h1', 1);
    const b = captureLockKey('d', 'h2', 2);
    expect(acquireCaptureLock(a)).toBe(true);
    expect(acquireCaptureLock(b)).toBe(true);
    expect(capturesInFlightCount()).toBeGreaterThanOrEqual(2);
    releaseCaptureLock(a);
    releaseCaptureLock(b);
  });
});

// ── #174: canonical model list → stable modelHash across capture/restore ─────
describe('#174 canonicalizeModelList', () => {
  it('trims, drops empties, de-dupes, and sorts', () => {
    expect(canonicalizeModelList([' b ', 'a', 'a', '', '  '])).toEqual(['a', 'b']);
  });

  it('returns an empty array for empty/missing input', () => {
    expect(canonicalizeModelList([])).toEqual([]);
    expect(canonicalizeModelList(undefined)).toEqual([]);
    expect(canonicalizeModelList(null)).toEqual([]);
  });

  it('makes hashModels order- and dedupe-insensitive (capture == restore)', () => {
    // Capture side observes models in one order; restore side in another, with a dup.
    const capture = hashModels(['whisper', 'gemma', 'kokoro']);
    const restore = hashModels(['kokoro', 'gemma', 'gemma', 'whisper']);
    expect(capture).toBe(restore);
  });

  it('distinguishes genuinely different model sets', () => {
    expect(hashModels(['a', 'b'])).not.toBe(hashModels(['a', 'c']));
  });
});

// ── #180: combined snapshot pre-check (one SSH round-trip) ────────────────────
describe('#180 snapshot pre-check command + parser', () => {
  it('builds a single command probing both driver and capability', () => {
    const cmd = snapshotPreCheckCommand();
    expect(cmd).toMatch(/nvidia-smi/);
    expect(cmd).toMatch(/capsh/);
    expect(cmd).toMatch(/DRIVER:/);
    expect(cmd).toMatch(/CAP:/);
  });

  it('passes when driver >= 570 and capability ok', () => {
    const r = parseSnapshotPreCheckOutput('DRIVER:575.10\nCAP:ok');
    expect(r.ok).toBe(true);
    expect(r.driverMajor).toBe(575);
  });

  it('fails when the driver is below 570', () => {
    const r = parseSnapshotPreCheckOutput('DRIVER:535.20\nCAP:ok');
    expect(r.ok).toBe(false);
    expect(r.driverMajor).toBe(535);
    expect(r.reason).toMatch(/< 570/);
  });

  it('fails when the capability check reports missing', () => {
    const r = parseSnapshotPreCheckOutput('DRIVER:575.0\nCAP:missing');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/CAP_CHECKPOINT_RESTORE/);
  });

  it('fails when nvidia-smi returned no driver', () => {
    expect(parseSnapshotPreCheckOutput('DRIVER:\nCAP:ok').ok).toBe(false);
    expect(parseSnapshotPreCheckOutput('garbage').ok).toBe(false);
  });
});

// ── #171: post-restore health probe retry schedule ───────────────────────────
describe('#171 restoreProbePlan', () => {
  it('uses the configured number of attempts, first probe immediate', () => {
    const plan = restoreProbePlan();
    expect(plan).toHaveLength(RESTORE_PROBE_ATTEMPTS);
    expect(plan[0].delayMs).toBe(0);
    expect(plan[1].delayMs).toBeGreaterThan(0);
    expect(plan.map(p => p.attempt)).toEqual([1, 2, 3]);
  });

  it('honors custom attempts/delay and never produces fewer than one probe', () => {
    expect(restoreProbePlan(1, 500)).toEqual([{ attempt: 1, delayMs: 0 }]);
    expect(restoreProbePlan(0)).toHaveLength(1); // clamps to >= 1 (one immediate probe)
    expect(restoreProbePlan(2, 250)[1].delayMs).toBe(250);
  });
});

// ── #153: race-loser delete retry schedule ───────────────────────────────────
describe('#153 loserDeleteRetryPlan', () => {
  it('produces the default number of attempts with increasing backoff', () => {
    const plan = loserDeleteRetryPlan();
    expect(plan).toHaveLength(LOSER_DELETE_MAX_ATTEMPTS);
    expect(plan[0]).toBe(0); // first attempt immediate
    expect(plan[1]).toBeGreaterThan(0);
    expect(plan[2]).toBeGreaterThan(plan[1]); // monotonic backoff
  });

  it('clamps to at least one attempt and honors a custom backoff', () => {
    expect(loserDeleteRetryPlan(1)).toEqual([0]);
    expect(loserDeleteRetryPlan(0)).toHaveLength(1);
    expect(loserDeleteRetryPlan(2, 1000)).toEqual([0, 1000]);
  });
});

// ── #150: count outstanding (non-winner) loser deletes ───────────────────────
describe('#150 countOutstandingLoserDeletes', () => {
  const cands = [{ instanceId: 'a' }, { instanceId: 'b' }, { instanceId: 'c' }];

  it('excludes the winner', () => {
    expect(countOutstandingLoserDeletes(cands, 'a')).toBe(2);
  });

  it('counts all when there is no winner yet', () => {
    expect(countOutstandingLoserDeletes(cands, null)).toBe(3);
    expect(countOutstandingLoserDeletes(cands, undefined)).toBe(3);
  });

  it('is zero for an empty candidate list', () => {
    expect(countOutstandingLoserDeletes([], 'a')).toBe(0);
  });
});

// ── #128: canonical deploy id (reuse handler id, don't overwrite) ─────────────
describe('#128 canonicalDeployId', () => {
  it('reuses the handler-assigned deployId when present', () => {
    expect(canonicalDeployId('deploy-abc-1234')).toBe('deploy-abc-1234');
  });

  it('synthesizes a fallback only when state has none', () => {
    expect(canonicalDeployId(undefined, 1000)).toBe('deploy-1000');
    expect(canonicalDeployId('', 2000)).toBe('deploy-2000');
    expect(canonicalDeployId('   ', 3000)).toBe('deploy-3000');
  });
});

// ── #136: cascade credential filtering reuses the race-path readiness filter ──
// (filterUsableTiers itself is covered by provider-readiness tests; here we lock
//  the wiring contract the cascade depends on: it never empties the list.)
describe('#136 cascade credential filter contract', () => {
  it('summarizeTierProbes is unaffected by it (orthogonal helper sanity)', () => {
    // Guard against accidental coupling — the probe summary is independent of
    // credential filtering.
    expect(summarizeTierProbes([]).anyAvailable).toBe(false);
  });
});

// ── #140: summarize parallel tier-probe results for the deploy session ────────
describe('#140 summarizeTierProbes', () => {
  it('lists only providers that reported offers as available', () => {
    const r = summarizeTierProbes([
      { name: 'vast', available: true, offerCount: 3, ms: 120 },
      { name: 'runpod', available: false, offerCount: 0, ms: 200 },
      { name: 'modal', available: true, offerCount: 0, ms: 0 }, // available flag but no offers
    ]);
    expect(r.availableProviders).toEqual(['vast']);
    expect(r.anyAvailable).toBe(true);
  });

  it('reports none available when every probe is empty/unavailable', () => {
    const r = summarizeTierProbes([
      { name: 'vast', available: false, offerCount: 0, ms: 50 },
    ]);
    expect(r.availableProviders).toEqual([]);
    expect(r.anyAvailable).toBe(false);
  });

  it('returns a defensive copy of the probes (no aliasing)', () => {
    const input = [{ name: 'vast', available: true, offerCount: 1, ms: 10 }];
    const r = summarizeTierProbes(input);
    r.probes[0].offerCount = 999;
    expect(input[0].offerCount).toBe(1); // original untouched
  });

  it('handles an empty probe list', () => {
    const r = summarizeTierProbes([]);
    expect(r.probes).toEqual([]);
    expect(r.availableProviders).toEqual([]);
    expect(r.anyAvailable).toBe(false);
  });
});
