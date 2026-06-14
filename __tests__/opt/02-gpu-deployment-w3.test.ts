// ── Unit tests for GPU deployment optimizations — WAVE 3 (IDs 101-200) ──────
// Pure-helper tests only — no network, no provider/GPU calls, no real FS.
// Distinct from wave-1 (02-gpu-deployment.test.ts) and wave-2
// (02-gpu-deployment-w2.test.ts). See
// docs/optimizations/implemented/02-gpu-deployment-w3.md for the ID mapping.

import { describe, it, expect } from 'vitest';

import {
  actualCostExceedsCap,
  networkVolumeIsWasted,
} from '../../server/gpu-deploy-loop';
import { pickCheapestTierName } from '../../server/tier-ranking';
import { buildGpuCacheProviderQueries } from '../../server/gpu-type-cache';
import {
  idempotentResponseStatus,
  resolvedTiersError,
} from '../../server/gpu-handlers';
import { isPartialInstallFailure } from '../../server/pod-provisioner';
import { snapshotStoreFingerprint } from '../../server/gpu-snapshot';
import {
  defaultRaceInterruptible,
  normalizeResolvedEndpoint,
  resolutionDeadlineExceeded,
  combineHealthSignal,
} from '../../server/gpu-deploy-race';
import {
  evaluateCostValidation,
  classifyTemplateCheck,
  registryVerifiable,
  parseImageRegistry,
  isGhcrRegistry,
  MAX_REASONABLE_PRICE_PER_HR,
} from '../../src/preflight-checks';

// A fake GPU provider client — only identity matters for query building.
const fakeClient = () => ({ name: 'fake' } as any);

// ── #107: re-check the real selected-host cost against maxCostUsd ────────────
describe('#107 actualCostExceedsCap', () => {
  it('flags when the real host price exceeds the cap', () => {
    expect(actualCostExceedsCap(1.5, 1.0)).toBe(true);
  });

  it('passes when the real price is at or below the cap', () => {
    expect(actualCostExceedsCap(0.9, 1.0)).toBe(false);
    expect(actualCostExceedsCap(1.0, 1.0)).toBe(false);
  });

  it('never aborts when no cap is set', () => {
    expect(actualCostExceedsCap(99, undefined)).toBe(false);
    expect(actualCostExceedsCap(99, 0)).toBe(false);
    expect(actualCostExceedsCap(99, -1)).toBe(false);
  });

  it('never aborts when the real cost is unknown (0 / missing)', () => {
    expect(actualCostExceedsCap(0, 1.0)).toBe(false);
    expect(actualCostExceedsCap(undefined, 1.0)).toBe(false);
    expect(actualCostExceedsCap(null, 1.0)).toBe(false);
  });
});

// ── #179: warn when a network volume is attached to a pre-baked image ────────
describe('#179 networkVolumeIsWasted', () => {
  it('is wasted only when a volume is attached AND the image is pre-baked', () => {
    expect(networkVolumeIsWasted('vol-123', true)).toBe(true);
  });

  it('is not wasted when no volume is attached', () => {
    expect(networkVolumeIsWasted(undefined, true)).toBe(false);
    expect(networkVolumeIsWasted('', true)).toBe(false);
  });

  it('is not wasted when the image lazy-downloads (not pre-baked)', () => {
    expect(networkVolumeIsWasted('vol-123', false)).toBe(false);
    expect(networkVolumeIsWasted('vol-123', undefined)).toBe(false);
  });
});

// ── #141: cooldown-fallback picks the cheapest tier, not the first ──────────
describe('#141 pickCheapestTierName', () => {
  it('returns the lowest-cost-prior provider', () => {
    // Default priors: vast (0.35) < runpod (0.45) < modal (2.50).
    expect(pickCheapestTierName(['modal', 'runpod', 'vast'])).toBe('vast');
  });

  it('never returns the expensive provider just because it is first', () => {
    expect(pickCheapestTierName(['modal', 'vast'])).toBe('vast');
  });

  it('returns null for an empty list', () => {
    expect(pickCheapestTierName([])).toBeNull();
  });

  it('honors injected priors', () => {
    const priors = { a: 5, b: 1, c: 3 } as Record<string, number>;
    expect(pickCheapestTierName(['a', 'b', 'c'], priors)).toBe('b');
  });

  it('treats unknown providers as most-expensive', () => {
    // 'mystery' has no prior → Infinity; 'vast' (0.35) wins.
    expect(pickCheapestTierName(['mystery', 'vast'])).toBe('vast');
    // single unknown still returns it (better than nothing).
    expect(pickCheapestTierName(['mystery'])).toBe('mystery');
  });
});

// ── #188: GPU-type cache queries include Hyperstack + Vast-VM ────────────────
describe('#188 buildGpuCacheProviderQueries', () => {
  const clients = {
    runpod: fakeClient(), vast: fakeClient(), 'vast-vm': fakeClient(),
    tensordock: fakeClient(), modal: fakeClient(), hyperstack: fakeClient(),
  };

  it('includes hyperstack when its key is present', () => {
    const q = buildGpuCacheProviderQueries({ HYPERSTACK_API_KEY: 'hk' }, clients);
    expect(q.map(x => x.name)).toContain('hyperstack');
  });

  it('includes vast-vm (sharing the vast key) whenever vast is configured', () => {
    const q = buildGpuCacheProviderQueries({ VAST_API_KEY: 'vk' }, clients);
    const names = q.map(x => x.name);
    expect(names).toContain('vast');
    expect(names).toContain('vast-vm');
  });

  it('requires both key AND authId for tensordock', () => {
    const partial = buildGpuCacheProviderQueries({ TENSORDOCK_API_KEY: 'k' }, clients);
    expect(partial.map(x => x.name)).not.toContain('tensordock');
    const full = buildGpuCacheProviderQueries(
      { TENSORDOCK_API_KEY: 'k', TENSORDOCK_AUTH_ID: 'a' }, clients,
    );
    expect(full.map(x => x.name)).toContain('tensordock');
  });

  it('composes the modal credential from id:secret', () => {
    const q = buildGpuCacheProviderQueries(
      { MODAL_TOKEN_ID: 'id', MODAL_TOKEN_SECRET: 'sec' }, clients,
    );
    const modal = q.find(x => x.name === 'modal');
    expect(modal?.credentials.apiKey).toBe('id:sec');
  });

  it('returns empty when no keys are set', () => {
    expect(buildGpuCacheProviderQueries({}, clients)).toEqual([]);
  });

  it('skips a provider whose client is missing even if the key is set', () => {
    const q = buildGpuCacheProviderQueries({ HYPERSTACK_API_KEY: 'hk' }, { runpod: fakeClient() });
    expect(q).toEqual([]);
  });
});

// ── #123/#131: idempotent response echoes the real status ───────────────────
describe('#123/#131 idempotentResponseStatus', () => {
  it('maps the resting idle state to "creating"', () => {
    expect(idempotentResponseStatus('idle')).toBe('creating');
  });

  it('echoes a real in-flight / terminal status verbatim', () => {
    expect(idempotentResponseStatus('booting')).toBe('booting');
    expect(idempotentResponseStatus('ready')).toBe('ready');
    // A deploy that already failed must NOT masquerade as in-progress.
    expect(idempotentResponseStatus('error')).toBe('error');
  });
});

// ── #139: reject early when tier selection collapses to empty ────────────────
describe('#139 resolvedTiersError', () => {
  it('returns null when at least one tier remains', () => {
    expect(resolvedTiersError(1, [])).toBeNull();
    expect(resolvedTiersError(3, ['RunPod'])).toBeNull();
  });

  it('returns an error mentioning excluded providers when none remain', () => {
    const err = resolvedTiersError(0, ['RunPod', 'Vast.ai']);
    expect(err).toBeTruthy();
    expect(err).toContain('RunPod');
    expect(err).toContain('Vast.ai');
  });

  it('returns a generic error when none remain and nothing was excluded', () => {
    const err = resolvedTiersError(0, []);
    expect(err).toBeTruthy();
    expect(err).not.toContain('excluded:');
  });
});

// ── #187: partial (timeout) install failures are retryable ───────────────────
describe('#187 isPartialInstallFailure', () => {
  it('treats a killed-by-timeout result (code null + marker) as partial', () => {
    expect(isPartialInstallFailure({ code: null, stderr: 'boom\n[provisioner] timeout' })).toBe(true);
  });

  it('treats a genuine non-zero exit as NOT partial', () => {
    expect(isPartialInstallFailure({ code: 1, stderr: 'apt failed' })).toBe(false);
    expect(isPartialInstallFailure({ code: 127, stderr: 'command not found' })).toBe(false);
  });

  it('does not flag a null-code result without a timeout marker', () => {
    expect(isPartialInstallFailure({ code: null, stderr: 'connection reset' })).toBe(false);
    expect(isPartialInstallFailure({ code: null })).toBe(false);
  });
});

// ── #178: snapshot store fingerprint reacts to config changes ────────────────
describe('#178 snapshotStoreFingerprint', () => {
  it('changes when a bucket env var changes', () => {
    const a = snapshotStoreFingerprint({ R2_SNAPSHOTS_BUCKET: 'one' } as any);
    const b = snapshotStoreFingerprint({ R2_SNAPSHOTS_BUCKET: 'two' } as any);
    expect(a).not.toBe(b);
  });

  it('changes when a secret rotates (via length hashing) but does not leak it', () => {
    const a = snapshotStoreFingerprint({ R2_SNAPSHOTS_SECRET_KEY: 'short' } as any);
    const b = snapshotStoreFingerprint({ R2_SNAPSHOTS_SECRET_KEY: 'a-much-longer-secret' } as any);
    expect(a).not.toBe(b);
    // Secret value must not appear verbatim in the fingerprint.
    expect(a).not.toContain('short');
    expect(b).not.toContain('a-much-longer-secret');
  });

  it('is stable for identical config', () => {
    const env = { HYPERSTACK_SNAPSHOTS_BUCKET: 'b', HYPERSTACK_SNAPSHOTS_ENDPOINT: 'e' } as any;
    expect(snapshotStoreFingerprint(env)).toBe(snapshotStoreFingerprint(env));
  });
});

// ── #113: default interruptible/spot for throwaway race deploys ──────────────
describe('#113 defaultRaceInterruptible', () => {
  it('defaults to spot for a real multi-slot race', () => {
    expect(defaultRaceInterruptible(undefined, 4)).toBe(true);
    expect(defaultRaceInterruptible(undefined, 2)).toBe(true);
  });

  it('keeps on-demand for a single-instance deploy', () => {
    expect(defaultRaceInterruptible(undefined, 1)).toBe(false);
  });

  it('always honors an explicit caller choice', () => {
    expect(defaultRaceInterruptible(false, 8)).toBe(false);
    expect(defaultRaceInterruptible(true, 1)).toBe(true);
  });
});

// ── #168: normalize provider endpoint-resolution result shapes ───────────────
describe('#168 normalizeResolvedEndpoint', () => {
  it('passes through a bare URL string', () => {
    expect(normalizeResolvedEndpoint('http://host:8000')).toBe('http://host:8000');
  });

  it('unwraps the { endpoint } object shape', () => {
    expect(normalizeResolvedEndpoint({ endpoint: 'http://host:9000' })).toBe('http://host:9000');
  });

  it('returns null for empty / missing values', () => {
    expect(normalizeResolvedEndpoint(null)).toBeNull();
    expect(normalizeResolvedEndpoint(undefined)).toBeNull();
    expect(normalizeResolvedEndpoint('')).toBeNull();
    expect(normalizeResolvedEndpoint({ endpoint: null })).toBeNull();
    expect(normalizeResolvedEndpoint({})).toBeNull();
  });
});

// ── #149: bound the cumulative endpoint-resolution budget ────────────────────
describe('#149 resolutionDeadlineExceeded', () => {
  it('is false while within the budget', () => {
    expect(resolutionDeadlineExceeded(1_000, 5_000, 60_000)).toBe(false);
  });

  it('is true once the cumulative budget is met or exceeded', () => {
    expect(resolutionDeadlineExceeded(1_000, 61_000, 60_000)).toBe(true);
    expect(resolutionDeadlineExceeded(0, 60_000, 60_000)).toBe(true);
  });
});

// ── #155: per-fetch health timeout combined with the race signal ─────────────
describe('#155 combineHealthSignal', () => {
  it('uses AbortSignal.any when available, merging both signals', () => {
    let received: AbortSignal[] | null = null;
    const merged = new AbortController().signal;
    const sig = combineHealthSignal(new AbortController().signal, 8000, {
      any: (sigs) => { received = sigs; return merged; },
      timeout: () => new AbortController().signal,
    });
    expect(sig).toBe(merged);
    expect(received).toHaveLength(2); // race + per-fetch timeout
  });

  it('falls back to a real controller (never the race signal alone) without any()', () => {
    const race = new AbortController();
    const sig = combineHealthSignal(race.signal, 50, { any: undefined });
    // Distinct signal from the race signal — the fallback wraps its own controller
    // so the per-fetch timeout still applies.
    expect(sig).not.toBe(race.signal);
    expect(sig.aborted).toBe(false);
  });

  it('aborts immediately in the fallback if the race signal was already aborted', () => {
    const race = new AbortController();
    race.abort();
    const sig = combineHealthSignal(race.signal, 5000, { any: undefined });
    expect(sig.aborted).toBe(true);
  });
});

// ── #197: cost validation (absolute cap + relative spike) ────────────────────
describe('#197 evaluateCostValidation', () => {
  it('skips (warns) when no quote is provided', () => {
    const r = evaluateCostValidation(undefined);
    expect(r.passed).toBe(true);
    expect(r.warning).toBeTruthy();
  });

  it('hard-fails a quote above the absolute reasonableness cap', () => {
    const r = evaluateCostValidation(MAX_REASONABLE_PRICE_PER_HR + 1);
    expect(r.passed).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('passes a normal quote with no current price', () => {
    expect(evaluateCostValidation(0.5).passed).toBe(true);
  });

  it('warns on a >20% live price spike vs the quote', () => {
    const r = evaluateCostValidation(1.0, 1.5); // +50%
    expect(r.passed).toBe(true);
    expect(r.warning).toMatch(/spike/i);
  });

  it('does not warn when the live price is within the spike threshold', () => {
    const r = evaluateCostValidation(1.0, 1.1); // +10% < 20%
    expect(r.passed).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('hard-fails when the live price itself exceeds the absolute cap', () => {
    const r = evaluateCostValidation(0.5, MAX_REASONABLE_PRICE_PER_HR + 2);
    expect(r.passed).toBe(false);
  });
});

// ── #198: confirmed-missing template is a hard error, unknown is a warning ───
describe('#198 classifyTemplateCheck', () => {
  it('hard-fails when the API confirms the template is missing', () => {
    const r = classifyTemplateCheck('t-123', { reachable: true, found: false });
    expect(r.passed).toBe(false);
    expect(r.error).toContain('t-123');
  });

  it('passes when the template is found', () => {
    expect(classifyTemplateCheck('t-123', { reachable: true, found: true }).passed).toBe(true);
  });

  it('only warns (does not block) when the API is unreachable', () => {
    const r = classifyTemplateCheck('t-123', { reachable: false });
    expect(r.passed).toBe(true);
    expect(r.warning).toBeTruthy();
    expect(r.error).toBeUndefined();
  });
});

// ── #199: non-Docker-Hub registry verification policy ────────────────────────
describe('#199 registry verification policy', () => {
  it('parses registry/repo/tag for a ghcr image', () => {
    const p = parseImageRegistry('ghcr.io/acme/app:v2');
    expect(p.registry).toBe('ghcr.io');
    expect(p.repo).toBe('acme/app');
    expect(p.tag).toBe('v2');
  });

  it('defaults registry to docker.io and tag to latest', () => {
    const p = parseImageRegistry('library/ubuntu');
    expect(p.registry).toBe('docker.io');
    expect(p.tag).toBe('latest');
  });

  it('strips a digest before parsing the tag', () => {
    const p = parseImageRegistry('ghcr.io/acme/app@sha256:' + 'a'.repeat(64));
    expect(p.registry).toBe('ghcr.io');
    expect(p.repo).toBe('acme/app');
  });

  it('recognizes ghcr.io case-insensitively', () => {
    expect(isGhcrRegistry('ghcr.io')).toBe(true);
    expect(isGhcrRegistry('GHCR.IO')).toBe(true);
    expect(isGhcrRegistry('docker.io')).toBe(false);
  });

  it('marks docker.io verifiable, ghcr verifiable only with a token', () => {
    expect(registryVerifiable('docker.io').verifiable).toBe(true);
    expect(registryVerifiable('ghcr.io').verifiable).toBe(false);
    expect(registryVerifiable('ghcr.io', { ghcrToken: 'tok' }).verifiable).toBe(true);
  });

  it('marks other private registries as unverifiable', () => {
    const v = registryVerifiable('myregistry.example.com:5000');
    expect(v.verifiable).toBe(false);
    expect(v.reason).toBe('unsupported-registry');
  });
});
