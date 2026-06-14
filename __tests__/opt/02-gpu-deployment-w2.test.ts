// ── Unit tests for GPU deployment optimizations — WAVE 2 (IDs 101-200) ──────
// Pure-helper tests only — no network, no provider/GPU calls, no real FS.
// Distinct from the wave-1 file (02-gpu-deployment.test.ts).
// See docs/optimizations/implemented/02-gpu-deployment-w2.md for the mapping.

import { describe, it, expect } from 'vitest';

import {
  buildRacePairs,
  storageGbForProvider,
  summarizeRaceWaste,
} from '../../server/gpu-deploy-race';
import {
  validateProviderChain,
  KNOWN_PROVIDER_CHAIN_TOKENS,
} from '../../server/config';
import {
  DEFAULT_GPU_ORDER,
  isConfiguredButDeprioritized,
} from '../../server/gpu-deploy-tiers';
import {
  refreshSnapshotOnReuse,
  shouldAutoDisableSnapshot,
  SNAPSHOT_AUTO_DISABLE_FAILURES,
  getCudaCheckpointCommit,
  cudaCheckpointUrlFor,
  DEFAULT_CUDA_CHECKPOINT_COMMIT,
  matchSnapshot,
  SNAPSHOT_MAX_AGE_MS,
  type SnapshotCatalogEntry,
} from '../../server/gpu-snapshot';
import {
  deployTimeoutMinForProvider,
  deployTimeoutMsForProvider,
} from '../../server/gpu-deploy-loop';
import {
  budgetProjectionHours,
  formatFallbackAlert,
  formatFallbackStatus,
} from '../../server/gpu-deploy-with-tiers';
import { cacheValidationOutcome } from '../../server/gpu-type-cache';
import {
  resolveGpuVramGb,
  gpuTypesWithSufficientVramFromOffers,
  keepaliveWithinSessionCap,
  MAX_KEEPALIVE_SESSION_MS,
} from '../../server/gpu-handlers';
import {
  spotEffectivePrice,
  rankOffersBySpotPreference,
} from '../../server/gpu-auto-select';
import {
  isSafeSshUser,
  sshUserHost,
} from '../../server/pod-provisioner';
import { modalIsCostDeprioritized } from '../../server/tier-ranking';
import { detectModelSizeClass, estimateVramFromImage } from '../../src/gpu-compat';

// Minimal GpuTier-like object — buildRacePairs only touches `.name`/identity.
const mkTier = (name: string) => ({ name, label: name, apiKey: 'k', client: {} } as any);

// ── #147: bounded race-pair generation ──────────────────────────────────────
describe('#147 buildRacePairs', () => {
  it('returns empty for no tiers or non-positive raceN', () => {
    expect(buildRacePairs([], ['4090'], 4)).toEqual([]);
    expect(buildRacePairs([mkTier('vast')], ['4090'], 0)).toEqual([]);
  });

  it('interleaves providers (diversity-first) before repeating a tier', () => {
    const pairs = buildRacePairs([mkTier('vast'), mkTier('runpod')], ['4090', 'a6000'], 4);
    // First two pairs come from distinct providers.
    expect(pairs[0].tier.name).toBe('vast');
    expect(pairs[1].tier.name).toBe('runpod');
  });

  it('is bounded: never generates an unbounded number of pairs', () => {
    // Old loop produced raceN*2+1 every call; new helper caps at raceN+1.
    const pairs = buildRacePairs([mkTier('vast')], ['4090'], 8);
    expect(pairs.length).toBeLessThanOrEqual(9); // raceN + 1
    expect(pairs.length).toBeGreaterThanOrEqual(1);
  });

  it('handles null gpuTypes (provider default) without throwing', () => {
    const pairs = buildRacePairs([mkTier('modal')], [], 2);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs[0].gpuType).toBeNull();
  });

  it('produces enough pairs to fill raceN slots via modulo', () => {
    const pairs = buildRacePairs([mkTier('vast'), mkTier('runpod')], ['4090'], 5);
    // Two distinct combos, but at least 1 pair so `pairs[i % len]` is safe.
    expect(pairs.length).toBeGreaterThanOrEqual(2);
  });
});

// ── #156: provider storage default preserves configured 0 ───────────────────
describe('#156 storageGbForProvider', () => {
  it('honors an explicit positive override verbatim', () => {
    expect(storageGbForProvider('vast', 75)).toBe(75);
    expect(storageGbForProvider('runpod', 10)).toBe(10);
  });

  it('preserves a configured 0 ("use provider default") instead of masking to 50', () => {
    // modal/hyperstack default to 0 in DEFAULT_STORAGE_GB.
    expect(storageGbForProvider('modal')).toBe(0);
    expect(storageGbForProvider('hyperstack')).toBe(0);
  });

  it('uses the provider default when no override is given', () => {
    expect(storageGbForProvider('vast')).toBe(100);
    expect(storageGbForProvider('runpod')).toBe(20);
  });

  it('ignores zero/negative overrides and falls back to provider default', () => {
    expect(storageGbForProvider('vast', 0)).toBe(100);
    expect(storageGbForProvider('vast', -5)).toBe(100);
  });

  it('falls back to 50 only for a provider with no map entry', () => {
    expect(storageGbForProvider('totally-unknown' as any)).toBe(50);
  });
});

// ── #119: per-provider race-waste aggregation ───────────────────────────────
describe('#119 summarizeRaceWaste', () => {
  it('aggregates wasted cost per provider', () => {
    const out = summarizeRaceWaste([
      { provider: 'vast', wastedUsd: 0.10 },
      { provider: 'vast', wastedUsd: 0.05 },
      { provider: 'runpod', wastedUsd: 0.20 },
    ]);
    expect(out.byProvider.vast).toBeCloseTo(0.15);
    expect(out.byProvider.runpod).toBeCloseTo(0.20);
    expect(out.totalUsd).toBeCloseTo(0.35);
  });

  it('treats non-finite / negative waste as 0', () => {
    const out = summarizeRaceWaste([
      { provider: 'vast', wastedUsd: NaN },
      { provider: 'vast', wastedUsd: -1 },
    ]);
    expect(out.byProvider.vast).toBe(0);
    expect(out.totalUsd).toBe(0);
  });

  it('returns empty for no losers', () => {
    expect(summarizeRaceWaste([])).toEqual({ byProvider: {}, totalUsd: 0 });
  });
});

// ── #145: PROVIDER_CHAIN validation ─────────────────────────────────────────
describe('#145 validateProviderChain', () => {
  it('accepts all known GPU + AI tokens', () => {
    expect(validateProviderChain(['gpu', 'runpod', 'vast', 'vast-vm', 'modal', 'groq'])).toEqual([]);
  });

  it('flags typos like "vastai"', () => {
    expect(validateProviderChain(['vastai', 'runpod'])).toEqual(['vastai']);
  });

  it('ignores empty tokens', () => {
    expect(validateProviderChain(['', 'groq', ''])).toEqual([]);
  });

  it('hyperstack/snapgpu are known even though not in GPU_PROVIDER_IDS', () => {
    expect(KNOWN_PROVIDER_CHAIN_TOKENS.has('hyperstack')).toBe(true);
    expect(KNOWN_PROVIDER_CHAIN_TOKENS.has('snapgpu')).toBe(true);
    expect(validateProviderChain(['hyperstack', 'snapgpu'])).toEqual([]);
  });
});

// ── #144: TensorDock configured-but-deprioritized detection ─────────────────
describe('#144 isConfiguredButDeprioritized', () => {
  it('flags TensorDock when creds present but not in chain or default order', () => {
    expect(isConfiguredButDeprioritized('tensordock', true, ['vast', 'runpod'])).toBe(true);
  });

  it('does not flag when TensorDock is explicitly in the chain', () => {
    expect(isConfiguredButDeprioritized('tensordock', true, ['tensordock', 'vast'])).toBe(false);
  });

  it('does not flag when creds are absent', () => {
    expect(isConfiguredButDeprioritized('tensordock', false, ['vast'])).toBe(false);
  });

  it('does not flag a provider that is in the default order', () => {
    expect(DEFAULT_GPU_ORDER).toContain('vast');
    expect(isConfiguredButDeprioritized('vast', true, [])).toBe(false);
  });
});

// ── #115: refresh snapshot createdAt on reuse ───────────────────────────────
describe('#115 refreshSnapshotOnReuse', () => {
  const entry: SnapshotCatalogEntry = {
    imageHash: 'img', modelHash: 'mdl', provider: 'vast-vm', driverMajor: 570,
    r2Key: 'k', createdAt: 1_000, sizeBytes: 10,
  };

  it('bumps createdAt to now and leaves other fields intact', () => {
    const refreshed = refreshSnapshotOnReuse(entry, 9_999);
    expect(refreshed.createdAt).toBe(9_999);
    expect(refreshed.imageHash).toBe('img');
    expect(refreshed.r2Key).toBe('k');
    expect(entry.createdAt).toBe(1_000); // input not mutated
  });

  it('keeps a hot snapshot matchable past the original TTL after refresh', () => {
    const now = entry.createdAt + SNAPSHOT_MAX_AGE_MS + 1; // would be stale
    const key = { imageHash: 'img', modelHash: 'mdl', provider: 'vast-vm', driverMajor: 570 };
    // Stale before refresh.
    expect(matchSnapshot([entry], key, now)).toBeNull();
    // Fresh after refresh.
    const refreshed = refreshSnapshotOnReuse(entry, now);
    expect(matchSnapshot([refreshed], key, now)).not.toBeNull();
  });
});

// ── #177: snapshot auto-disable after N restore failures ────────────────────
describe('#177 shouldAutoDisableSnapshot', () => {
  it('disables at or above the threshold', () => {
    expect(shouldAutoDisableSnapshot(SNAPSHOT_AUTO_DISABLE_FAILURES)).toBe(true);
    expect(shouldAutoDisableSnapshot(SNAPSHOT_AUTO_DISABLE_FAILURES + 1)).toBe(true);
  });

  it('keeps trying below the threshold', () => {
    expect(shouldAutoDisableSnapshot(0)).toBe(false);
    expect(shouldAutoDisableSnapshot(SNAPSHOT_AUTO_DISABLE_FAILURES - 1)).toBe(false);
  });

  it('respects a custom threshold', () => {
    expect(shouldAutoDisableSnapshot(2, 5)).toBe(false);
    expect(shouldAutoDisableSnapshot(5, 5)).toBe(true);
  });

  it('default threshold is a small positive integer', () => {
    expect(SNAPSHOT_AUTO_DISABLE_FAILURES).toBeGreaterThan(0);
  });
});

// ── #176: pin cuda-checkpoint commit (not moving `main`) ────────────────────
describe('#176 getCudaCheckpointCommit', () => {
  it('defaults to a pinned 40-hex SHA, never bare "main"', () => {
    expect(getCudaCheckpointCommit({} as NodeJS.ProcessEnv)).toBe(DEFAULT_CUDA_CHECKPOINT_COMMIT);
    expect(DEFAULT_CUDA_CHECKPOINT_COMMIT).not.toBe('main');
    expect(DEFAULT_CUDA_CHECKPOINT_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });

  it('honors an explicit env override', () => {
    expect(getCudaCheckpointCommit({ CUDA_CHECKPOINT_COMMIT: 'abc123' } as any)).toBe('abc123');
  });

  it('ignores a blank override', () => {
    expect(getCudaCheckpointCommit({ CUDA_CHECKPOINT_COMMIT: '  ' } as any)).toBe(DEFAULT_CUDA_CHECKPOINT_COMMIT);
  });

  it('builds the raw GitHub URL for a commit', () => {
    expect(cudaCheckpointUrlFor('deadbeef')).toBe(
      'https://raw.githubusercontent.com/NVIDIA/cuda-checkpoint/deadbeef/bin/x86_64_Linux/cuda-checkpoint',
    );
  });
});

// ── #200: per-provider deploy timeout ───────────────────────────────────────
describe('#200 deployTimeoutMinForProvider', () => {
  it('gives slow providers a longer floor than the global default', () => {
    expect(deployTimeoutMinForProvider('tensordock', 15)).toBe(45);
  });

  it('never lowers below the configured global default', () => {
    // RunPod floor is 15, but if operator set global 30, honor 30.
    expect(deployTimeoutMinForProvider('runpod', 30)).toBe(30);
    expect(deployTimeoutMinForProvider('runpod', 10)).toBe(15);
  });

  it('falls back to the global default for unknown providers', () => {
    expect(deployTimeoutMinForProvider('mystery', 22)).toBe(22);
  });

  it('ms variant is the minute variant × 60000', () => {
    expect(deployTimeoutMsForProvider('tensordock', 15)).toBe(45 * 60_000);
  });
});

// ── #106: budget projection hours ───────────────────────────────────────────
describe('#106 budgetProjectionHours', () => {
  it('defaults to 2h with no hints', () => {
    expect(budgetProjectionHours({})).toBe(2);
  });

  it('derives a shorter window from a short idle timeout', () => {
    // 15-min idle × 1.5 headroom = 0.375h, clamped to >= 0.25.
    expect(budgetProjectionHours({ idleTimeoutMin: 15 })).toBeCloseTo(0.375);
  });

  it('clamps to the [0.25, 8] hour range', () => {
    expect(budgetProjectionHours({ idleTimeoutMin: 1 })).toBe(0.25);
    expect(budgetProjectionHours({ idleTimeoutMin: 10_000 })).toBe(8);
  });
});

// ── #146: consistent (English) fallback alert strings ───────────────────────
describe('#146 fallback alert formatting', () => {
  it('alert is English, not mixed Portuguese', () => {
    const msg = formatFallbackAlert('Vast.ai', 'RunPod');
    expect(msg).toBe('Vast.ai unavailable — falling back to RunPod.');
    expect(msg).not.toMatch(/indispon|fallback como|usando/i);
  });

  it('status line mentions both providers', () => {
    const s = formatFallbackStatus('Vast.ai', 'RunPod');
    expect(s).toContain('Vast.ai');
    expect(s).toContain('RunPod');
    expect(s).toMatch(/trying/i);
  });
});

// ── #189: cache-validation outcome classification ───────────────────────────
describe('#189 cacheValidationOutcome', () => {
  it('returns no-filter when no GPU types requested', () => {
    expect(cacheValidationOutcome(0, 5)).toBe('no-filter');
  });

  it('returns cache-empty when types requested but cache is empty (skip + warn)', () => {
    expect(cacheValidationOutcome(2, 0)).toBe('cache-empty');
  });

  it('returns validated when there is a cache to check against', () => {
    expect(cacheValidationOutcome(2, 10)).toBe('validated');
  });
});

// ── #195: unknown GPU VRAM falls back to offer-reported value ───────────────
describe('#195 resolveGpuVramGb / gpuTypesWithSufficientVramFromOffers', () => {
  it('prefers the static map when present', () => {
    expect(resolveGpuVramGb('NVIDIA GeForce RTX 4090')).toBe(24);
  });

  it('falls back to provider-reported VRAM for unmapped GPUs', () => {
    expect(resolveGpuVramGb('NVIDIA RTX 6000 Ada', 48)).toBe(48);
  });

  it('returns null when neither map nor offer knows the GPU', () => {
    expect(resolveGpuVramGb('Unknown GPU')).toBeNull();
  });

  it('keeps an unmapped-but-big-enough GPU using offer VRAM (was wrongly rejected)', () => {
    const kept = gpuTypesWithSufficientVramFromOffers(
      ['NVIDIA RTX 6000 Ada'],
      40,
      { 'NVIDIA RTX 6000 Ada': 48 },
    );
    expect(kept).toEqual(['NVIDIA RTX 6000 Ada']);
  });

  it('drops a truly unknown GPU (no map, no offer VRAM)', () => {
    expect(gpuTypesWithSufficientVramFromOffers(['Mystery GPU'], 16)).toEqual([]);
  });

  it('drops an offer-reported GPU that is too small', () => {
    expect(
      gpuTypesWithSufficientVramFromOffers(['Tiny GPU'], 24, { 'Tiny GPU': 8 }),
    ).toEqual([]);
  });
});

// ── #114: spot vs on-demand price delta in auto-select ──────────────────────
describe('#114 spotEffectivePrice / rankOffersBySpotPreference', () => {
  it('discounts spot offers only when the workload tolerates preemption', () => {
    const spot = { pricePerHr: 1.0, interruptible: true };
    expect(spotEffectivePrice(spot, true, 0.8)).toBeCloseTo(0.8);
    expect(spotEffectivePrice(spot, false, 0.8)).toBe(1.0); // not tolerant → no discount
  });

  it('leaves on-demand offers unchanged', () => {
    expect(spotEffectivePrice({ pricePerHr: 1.0, interruptible: false }, true)).toBe(1.0);
  });

  it('ranks a cheaper-effective spot ahead of an equal-priced on-demand', () => {
    const offers = [
      { id: 'ondemand', pricePerHr: 1.0, interruptible: false },
      { id: 'spot', pricePerHr: 1.0, interruptible: true },
    ];
    const ranked = rankOffersBySpotPreference(offers, true, 0.8);
    expect(ranked[0].id).toBe('spot');
  });

  it('preserves order when not tolerating spot', () => {
    const offers = [
      { id: 'a', pricePerHr: 1.0, interruptible: false },
      { id: 'b', pricePerHr: 1.0, interruptible: true },
    ];
    const ranked = rankOffersBySpotPreference(offers, false);
    expect(ranked.map((o) => o.id)).toEqual(['a', 'b']);
  });
});

// ── #185: provisioner configurable SSH user ─────────────────────────────────
describe('#185 isSafeSshUser / sshUserHost', () => {
  it('accepts normal usernames', () => {
    expect(isSafeSshUser('root')).toBe(true);
    expect(isSafeSshUser('ubuntu')).toBe(true);
    expect(isSafeSshUser('user_1.dev')).toBe(true);
  });

  it('rejects unsafe usernames (shell metachars, spaces, empty)', () => {
    expect(isSafeSshUser('')).toBe(false);
    expect(isSafeSshUser('a b')).toBe(false);
    expect(isSafeSshUser('a;rm -rf /')).toBe(false);
    expect(isSafeSshUser('$(whoami)')).toBe(false);
  });

  it('defaults to root and falls back to root for unsafe users', () => {
    expect(sshUserHost('1.2.3.4')).toBe('root@1.2.3.4');
    expect(sshUserHost('1.2.3.4', 'ubuntu')).toBe('ubuntu@1.2.3.4');
    expect(sshUserHost('1.2.3.4', 'bad;user')).toBe('root@1.2.3.4');
  });
});

// ── #135: Modal stays cost-deprioritized (kept last on P50 ties) ────────────
describe('#135 modalIsCostDeprioritized', () => {
  it('Modal has the highest cost prior so it never wins a near-tie', () => {
    expect(modalIsCostDeprioritized()).toBe(true);
  });

  it('would be false if Modal were not the most expensive prior', () => {
    expect(
      modalIsCostDeprioritized({
        runpod: 5, vast: 1, 'vast-vm': 1, tensordock: 1, snapgpu: 1, modal: 2, hyperstack: 1,
      } as any),
    ).toBe(false);
  });
});

// ── #194: VRAM size-class regex anchored to model-name tokens ───────────────
describe('#194 detectModelSizeClass', () => {
  it('detects genuine model sizes', () => {
    expect(detectModelSizeClass('llama-70b-instruct')).toBe('70b');
    expect(detectModelSizeClass('qwen2.5-7b')).toBe('7b');
    expect(detectModelSizeClass('gemma-3b-it')).toBe('3b');
    expect(detectModelSizeClass('mistral-7b-v0.1')).toBe('7b');
  });

  it('does NOT match a size token glued after a letter/digit (e.g. mixtral-8x7b)', () => {
    // `7b` in `8x7b` is preceded by `x` (word char) so it is intentionally not
    // a standalone size token — anchoring rejects it rather than guessing.
    expect(detectModelSizeClass('mixtral-8x7b')).toBeNull();
  });

  it('does NOT match a dotted version like cuda12.7b (the bug)', () => {
    // Previously `\b(7b)\b` matched the "7b" in "cuda12.7b".
    expect(detectModelSizeClass('myimage:cuda12.7b')).toBeNull();
  });

  it('does NOT match digits glued inside an unrelated token', () => {
    expect(detectModelSizeClass('build20247b')).toBeNull();
    expect(detectModelSizeClass('sha256:ab70bcd')).toBeNull();
  });

  it('returns null when there is no size hint', () => {
    expect(detectModelSizeClass('whisper-large-v3')).toBeNull();
  });

  it('largest class wins when several appear', () => {
    expect(detectModelSizeClass('pipeline-7b-and-70b')).toBe('70b');
  });
});

describe('#194 estimateVramFromImage uses anchored detection', () => {
  it('estimates VRAM for a real 70B image', () => {
    const { vramGb } = estimateVramFromImage('llama-70b:q4');
    expect(vramGb).toBeGreaterThan(0);
  });

  it('does not mis-estimate from a version string in env', () => {
    const { vramGb } = estimateVramFromImage('app:latest', { BUILD: 'cuda12.7b' });
    expect(vramGb).toBe(0); // no real model hint
  });
});

// ── #167: keepalive max-session cap ─────────────────────────────────────────
describe('#167 keepaliveWithinSessionCap', () => {
  it('allows keepalive within the session window', () => {
    const now = 100 * MAX_KEEPALIVE_SESSION_MS; // large enough that startedAt stays positive
    expect(keepaliveWithinSessionCap(now - 60_000, now)).toBe(true);
  });

  it('blocks keepalive once the session exceeds the ceiling', () => {
    const now = 100 * MAX_KEEPALIVE_SESSION_MS;
    expect(keepaliveWithinSessionCap(now - (MAX_KEEPALIVE_SESSION_MS + 1), now)).toBe(false);
  });

  it('does not penalize an unknown start time', () => {
    expect(keepaliveWithinSessionCap(0, 1_000_000)).toBe(true);
  });

  it('respects a custom max', () => {
    expect(keepaliveWithinSessionCap(0, 5_000, 1_000)).toBe(true); // startedAt 0 → unknown
    expect(keepaliveWithinSessionCap(1, 5_000, 1_000)).toBe(false); // 4999 >= 1000
  });
});
