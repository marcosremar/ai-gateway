/**
 * Wave-2 unit tests for provider-routing / caching optimizations
 * (docs/optimizations/04-provider-routing-caching.md).
 *
 * Scope: pure, importable logic only — no network / provider SDK / GPU / real
 * FS. Provider clients that `new OpenAI()` at call time are exercised via the
 * side-effect-free pure helpers extracted alongside them (resolveOpenAISttModel,
 * resolveOpenAIVoice, buildDeepgramParams). Everything else is a pure class or
 * function tested directly.
 *
 * Covered findings:
 *   #301 cooldown default; #304 5xx reuse; #305 hash-less credit block;
 *   #307 context-upgrade dedupe; #309 tried/skipped reporting;
 *   #311/#315 credit-block per-provider TTL + read-sweep;
 *   #336/#337/#338 caching-layer LRU + sweep + memoize guard;
 *   #343 circuit-breaker HALF_OPEN probe deadline;
 *   #345 adaptive-timeout p95 memo;
 *   #350/#351 TTFAC success-filtered stats + front-load ranking;
 *   #353 perf-ranker configurable neutral anchor;
 *   #355 EWMA cold tie-break by cost;
 *   #358/#359/#360/#361 percentage-routing normalize/granularity/availability/fields;
 *   #367 OpenAI STT cheaper default; #368/#369 Deepgram knobs;
 *   #375 OpenAI TTS unknown-voice remap flag;
 *   #387 batch-detector per-tenant isolation;
 *   #388/#389 cloud-health endpoints;
 *   #390 hybrid-router decommissioned-model default;
 *   #397/#312 classification widening unblocks fallback chains.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  selectPercentageRoute,
  selectRandomRoute,
  normalizeRouteWeights,
  buildPercentageRoutes,
  type PercentageRoute,
} from '../../src/gateway/providers/cloud/percentage-routing';
import { ProviderClassification } from '../../src/gateway/providers/cloud/classification';
import { buildFallbackChain, type UserProviderSettings } from '../../src/gateway/providers/cloud/chain-builder';
import {
  withProviderFallback,
  CooldownTracker,
  type FallbackEntry,
} from '../../src/gateway/providers/cloud/fallback';
import { CreditBlockTracker } from '../../src/gateway/providers/cloud/credit-block';
import { CircuitBreaker } from '../../src/gateway/providers/cloud/circuit-breaker';
import { AdaptiveTimeoutCalculator } from '../../src/gateway/providers/cloud/adaptive-timeout';
import { TtfacTracker } from '../../src/gateway/providers/cloud/ttfac-tracker';
import { PerformanceRanker } from '../../src/gateway/providers/cloud/performance-ranker';
import { EWMATracker } from '../../src/gateway/routing/ewma-tracker';
import { Cache, memoize } from '../../src/caching-layer';
import { resolveOpenAISttModel, DEFAULT_OPENAI_STT_MODEL } from '../../src/gateway/providers/cloud/openai/openai-stt';
import { resolveOpenAIVoice, OPENAI_DEFAULT_VOICE } from '../../src/gateway/providers/cloud/openai/openai-tts';
import { buildDeepgramParams } from '../../src/gateway/providers/cloud/deepgram/index';
import { BatchDetector } from '../../src/gateway/providers/cloud/batch-detector';
import type { STTRequest } from '../../src/gateway/providers/cloud/types';

const fe = (provider: string, model?: string): FallbackEntry => ({ provider, model });
const route = (provider: string, percentage: number, extra: Partial<PercentageRoute> = {}): PercentageRoute => ({
  provider, percentage, ...extra,
});

/** A no-op logger so fallback tests don't spam console (matches deps.Logger). */
const silentLogger = { debug: () => {}, log: () => {}, warn: () => {}, error: () => {} };

// ════════════════════════════════════════════════════════════════════════════
// #358 / #359 / #360 / #361 — percentage routing
// ════════════════════════════════════════════════════════════════════════════
describe('percentage routing (opt #358/#359/#360/#361)', () => {
  it('normalizeRouteWeights scales an under-allocation up to a 100 total (#358)', () => {
    const out = normalizeRouteWeights([route('a', 10), route('b', 30)]); // sum 40
    const total = out.reduce((s, r) => s + r.percentage, 0);
    expect(total).toBeCloseTo(100, 6);
    // Relative proportions preserved: b is 3x a.
    expect(out[1].percentage / out[0].percentage).toBeCloseTo(3, 6);
  });

  it('normalizeRouteWeights shrinks an over-allocation so later routes stay reachable (#358)', () => {
    const out = normalizeRouteWeights([route('a', 80), route('b', 80)]); // sum 160
    expect(out.reduce((s, r) => s + r.percentage, 0)).toBeCloseTo(100, 6);
    expect(out[0].percentage).toBeCloseTo(50, 6);
  });

  it('normalizeRouteWeights returns input copy when total is zero', () => {
    const out = normalizeRouteWeights([route('a', 0), route('b', 0)]);
    expect(out.map((r) => r.percentage)).toEqual([0, 0]);
  });

  it('sticky selection is deterministic and distributes across the full range (#359)', () => {
    const routes = [route('a', 50), route('b', 50)];
    // Same key → same route (sticky/deterministic).
    const k1 = selectPercentageRoute({ routes, hashKey: 'user-1' });
    expect(selectPercentageRoute({ routes, hashKey: 'user-1' })).toEqual(k1);
    // Over many distinct keys, BOTH routes are reachable (32-bit granularity
    // is not collapsed to one bucket).
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const r = selectPercentageRoute({ routes, hashKey: `user-${i}` });
      if (r) seen.add(r.provider);
    }
    expect(seen.has('a')).toBe(true);
    expect(seen.has('b')).toBe(true);
  });

  it('excludes unavailable providers before sticky selection (#360)', () => {
    const routes = [route('groq', 100), route('openai', 0)];
    // groq is "credit-blocked" → must never be returned even at 100% weight.
    const picked = selectPercentageRoute({
      routes,
      hashKey: 'anyone',
      isAvailable: (r) => r.provider !== 'groq',
    });
    expect(picked?.provider).toBe('openai');
  });

  it('returns null when every route is filtered out as unavailable (#360)', () => {
    const picked = selectPercentageRoute({
      routes: [route('groq', 100)],
      hashKey: 'x',
      isAvailable: () => false,
    });
    expect(picked).toBeNull();
  });

  it('non-sticky random selection also respects the availability filter (#360)', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      const picked = selectPercentageRoute({
        routes: [route('groq', 50), route('openai', 50)],
        hashKey: 'x',
        sticky: false,
        isAvailable: (r) => r.provider === 'openai',
      });
      expect(picked?.provider).toBe('openai');
    } finally {
      spy.mockRestore();
    }
  });

  it('selectRandomRoute honors weights via Math.random', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0); // lands in first bucket
    try {
      expect(selectRandomRoute([route('a', 90), route('b', 10)])?.provider).toBe('a');
    } finally {
      spy.mockRestore();
    }
  });

  it('buildPercentageRoutes preserves endpoint + metadata (#361)', () => {
    const out = buildPercentageRoutes([
      { provider: 'gpu', model: 'm', weight: 30, endpoint: 'https://pod-a', metadata: { pod: 'A' } },
      { provider: 'groq', weight: 70 },
    ]);
    expect(out[0]).toEqual({ provider: 'gpu', model: 'm', percentage: 30, endpoint: 'https://pod-a', metadata: { pod: 'A' } });
    expect(out[1]).toEqual({ provider: 'groq', model: undefined, percentage: 70 });
    expect('endpoint' in out[1]).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #397 / #312 — classification widening unblocks fallback chains
// ════════════════════════════════════════════════════════════════════════════
describe('provider classification widening (opt #397/#312)', () => {
  it('treats deepgram/elevenlabs/minimax/fal as cloud providers', () => {
    for (const p of ['deepgram', 'elevenlabs', 'minimax', 'fal']) {
      expect(ProviderClassification.isCloud(p)).toBe(true);
    }
    // still excludes GPU + local
    expect(ProviderClassification.isCloud('runpod')).toBe(false);
    expect(ProviderClassification.isCloud('ollama')).toBe(false);
  });

  it('a deepgram STT pipeline stage now survives buildFallbackChain (#312)', () => {
    const settings: UserProviderSettings = {
      activeProvider: 'openai',
      keys: {},
      pipelineStages: { stt: { provider: 'deepgram', model: 'nova-3' } },
    };
    const chain = buildFallbackChain(settings, 'stt');
    expect(chain).toEqual([{ provider: 'deepgram', model: 'nova-3' }]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #305 / #309 — credit-block keying without an apiKeyHash + accurate reporting
// ════════════════════════════════════════════════════════════════════════════
describe('fallback credit-block without key hash (opt #305/#309)', () => {
  it('blocks a hash-less provider after it returns 402 and skips it on the next run', async () => {
    const credit = new CreditBlockTracker();
    const cooldown = new CooldownTracker();
    const opts = {
      logger: silentLogger,
      cooldownTracker: cooldown,
      creditBlockTracker: credit,
      // NOTE: no apiKeyHashes — historically this bypassed the 402 block.
    };

    // First run: groq 402, falls to openai.
    const err402 = Object.assign(new Error('payment required'), { status: 402 });
    const first = await withProviderFallback(
      [fe('groq', 'm'), fe('openai', 'm')],
      async (entry) => {
        if (entry.provider === 'groq') throw err402;
        return 'ok';
      },
      opts,
    );
    expect(first.usedProvider).toBe('openai');

    // groq is now credit-blocked even though no key hash was configured (#305).
    expect(credit.isBlocked('groq', '__provider__')).toBe(true);

    // Second run: groq is pre-filtered out; the fn is never invoked for groq.
    const calls: string[] = [];
    const second = await withProviderFallback(
      [fe('groq', 'm'), fe('openai', 'm')],
      async (entry) => {
        calls.push(entry.provider);
        return 'ok2';
      },
      opts,
    );
    expect(second.usedProvider).toBe('openai');
    expect(calls).toEqual(['openai']); // groq skipped, not attempted
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #307 — context-window upgrade is not spliced if already present in the chain
// ════════════════════════════════════════════════════════════════════════════
describe('fallback context-window upgrade dedupe (opt #307)', () => {
  it('does not attempt the same provider/model twice on context overflow', async () => {
    const attempts: Array<string> = [];
    // Chain already contains the upgrade target (groq/big). A context overflow
    // on groq/small must NOT splice a second groq/big attempt.
    const chain = [fe('groq', 'small'), fe('groq', 'big')];
    const ctxErr = Object.assign(new Error('context_length_exceeded'), { code: 'context_length_exceeded' });

    await withProviderFallback(
      chain,
      async (entry) => {
        const key = `${entry.provider}/${entry.model}`;
        attempts.push(key);
        if (entry.model === 'small') throw ctxErr; // context overflow
        return 'ok';
      },
      {
        logger: silentLogger,
        cooldownTracker: new CooldownTracker(),
        creditBlockTracker: new CreditBlockTracker(),
        contextWindowFallbacks: { small: 'big' },
      },
    );

    // groq/big appears exactly once (the existing chain entry), not twice.
    expect(attempts.filter((a) => a === 'groq/big').length).toBe(1);
    expect(attempts).toEqual(['groq/small', 'groq/big']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #301 — cooldown defaults: omitting cooldownMs applies the documented 15s
// ════════════════════════════════════════════════════════════════════════════
describe('fallback cooldown default (opt #301)', () => {
  it('applies the 15s default cooldown when cooldownMs is omitted', () => {
    const tracker = new CooldownTracker();
    const entry = fe('groq', 'm');
    // allowedFails=1, default cooldownMs (15_000) — one failure trips cooldown.
    tracker.recordFailure(entry, 1, 15_000);
    expect(tracker.isCoolingDown(entry)).toBe(true);
    const state = tracker.getState().get('groq:m');
    expect(state?.lastCooldownMs).toBe(15_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #304 — 5xx retry still works after MOVE_ON statuses are handled
// ════════════════════════════════════════════════════════════════════════════
describe('fallback 5xx retry (opt #304 — reuse extracted status)', () => {
  it('retries a 5xx on the same provider before moving on', async () => {
    let groqCalls = 0;
    const res = await withProviderFallback(
      [fe('groq', 'm'), fe('openai', 'm')],
      async (entry) => {
        if (entry.provider === 'groq') {
          groqCalls++;
          if (groqCalls === 1) throw Object.assign(new Error('boom'), { status: 503 });
          return 'groq-recovered';
        }
        return 'openai';
      },
      {
        logger: silentLogger,
        cooldownTracker: new CooldownTracker(),
        creditBlockTracker: new CreditBlockTracker(),
        retriesPerProvider: 1,
        retryBaseDelayMs: 1,
      },
    );
    expect(groqCalls).toBe(2); // retried the 5xx on groq
    expect(res.usedProvider).toBe('groq');
    expect(res.result).toBe('groq-recovered');
  });

  it('a 429 moves on immediately (no in-provider retry)', async () => {
    let groqCalls = 0;
    const res = await withProviderFallback(
      [fe('groq', 'm'), fe('openai', 'm')],
      async (entry) => {
        if (entry.provider === 'groq') { groqCalls++; throw Object.assign(new Error('rate'), { status: 429 }); }
        return 'openai';
      },
      {
        logger: silentLogger,
        cooldownTracker: new CooldownTracker(),
        creditBlockTracker: new CreditBlockTracker(),
        retriesPerProvider: 2,
        retryBaseDelayMs: 1,
      },
    );
    expect(groqCalls).toBe(1); // 429 never retried in-provider
    expect(res.usedProvider).toBe('openai');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #311 / #315 — credit-block per-provider TTL + read-time sweep
// ════════════════════════════════════════════════════════════════════════════
describe('CreditBlockTracker TTL + read sweep (opt #311/#315)', () => {
  it('honors a per-provider TTL override shorter than the 5-min default (#311)', () => {
    vi.useFakeTimers();
    try {
      const tracker = new CreditBlockTracker({ groq: 30_000 }); // 30s
      tracker.recordBlock('groq', 'h');
      expect(tracker.isBlocked('groq', 'h')).toBe(true);
      vi.advanceTimersByTime(31_000);
      expect(tracker.isBlocked('groq', 'h')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a provider without an override still uses the 5-min default', () => {
    vi.useFakeTimers();
    try {
      const tracker = new CreditBlockTracker({ groq: 30_000 });
      tracker.recordBlock('openai', 'h');
      vi.advanceTimersByTime(31_000); // past groq's TTL, well within default
      expect(tracker.isBlocked('openai', 'h')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sweeps expired entries during an isBlocked read so size does not leak (#315)', () => {
    vi.useFakeTimers();
    try {
      const tracker = new CreditBlockTracker({ groq: 1_000 });
      tracker.recordBlock('groq', 'h');
      expect(tracker.size).toBe(1);
      // Advance past TTL + the 5-min sweep cadence so the read triggers a sweep.
      vi.advanceTimersByTime(6 * 60_000);
      expect(tracker.isBlocked('other', 'x')).toBe(false); // unrelated read
      expect(tracker.size).toBe(0); // expired groq entry swept on read
    } finally {
      vi.useRealTimers();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #343 — circuit breaker HALF_OPEN probe deadline auto-reset
// ════════════════════════════════════════════════════════════════════════════
describe('CircuitBreaker HALF_OPEN probe deadline (opt #343)', () => {
  it('allows a fresh probe after an abandoned one exceeds the probe deadline', () => {
    let clock = 0;
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 100,
      probeTimeoutMs: 50,
      now: () => clock,
    });

    cb.recordFailure();                 // open
    expect(cb.allowRequest()).toBe(false);

    clock = 100;                        // reset window elapsed → HALF_OPEN probe
    expect(cb.allowRequest()).toBe(true);
    expect(cb.getStats().state).toBe('half_open');

    // Probe is abandoned (no record). A second probe is blocked while in-flight.
    clock = 120;
    expect(cb.allowRequest()).toBe(false);

    // After the probe deadline, a new probe is allowed (no longer stuck).
    clock = 160; // 160 - 100 = 60 > probeTimeoutMs(50)
    expect(cb.allowRequest()).toBe(true);
  });

  it('a successful probe closes the circuit', () => {
    let clock = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10, now: () => clock });
    cb.recordFailure();
    clock = 10;
    expect(cb.allowRequest()).toBe(true);
    cb.recordSuccess();
    expect(cb.getStats().state).toBe('closed');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #345 — adaptive timeout memoizes the p95 computation between samples
// ════════════════════════════════════════════════════════════════════════════
describe('AdaptiveTimeoutCalculator p95 memo (opt #345)', () => {
  it('returns a stable timeout and recomputes after a new sample', () => {
    const calc = new AdaptiveTimeoutCalculator({ minSamples: 3, marginMultiplier: 1, minTimeoutMs: 0, maxTimeoutMs: 100_000 });
    for (let i = 0; i < 5; i++) calc.record('groq', 'm', 1000);
    const t1 = calc.getTimeout('groq', 'm', 5000);
    const t2 = calc.getTimeout('groq', 'm', 5000); // served from memo
    expect(t2).toBe(t1);
    expect(t1).toBe(1000); // p95 of all-1000 samples * margin 1

    // A new much larger sample invalidates the memo and lifts the timeout.
    for (let i = 0; i < 5; i++) calc.record('groq', 'm', 5000);
    const t3 = calc.getTimeout('groq', 'm', 5000);
    expect(t3).toBeGreaterThan(t1);
  });

  it('falls back to the default below minSamples', () => {
    const calc = new AdaptiveTimeoutCalculator({ minSamples: 10 });
    calc.record('groq', 'm', 1000);
    expect(calc.getTimeout('groq', 'm', 4242)).toBe(4242);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #350 / #351 — TTFAC stats exclude failures; ranking front-loads fast entries
// ════════════════════════════════════════════════════════════════════════════
describe('TtfacTracker success filtering + front-load ranking (opt #350/#351)', () => {
  it('excludes failed samples from the percentile + sampleCount (#350)', () => {
    const t = new TtfacTracker({ enabled: true, minSamples: 1 });
    t.record('p', 'm', 1000, 1200, true);
    t.record('p', 'm', 5, 5, false);   // fast failure — must be ignored
    t.record('p', 'm', 1000, 1200, true);
    const stats = t.getStats('p', 'm');
    expect(stats.sampleCount).toBe(2);          // only the 2 successes
    expect(stats.ttfacP50).toBe(1000);          // not pulled down to ~5ms
  });

  it('moves a proven-fast scored provider ahead of a high-priority unscored entry (#351)', () => {
    const t = new TtfacTracker({ enabled: true, minSamples: 3, ttfacWeight: 1 });
    // 'fast' has samples; 'cold' (configured first) has none.
    for (let i = 0; i < 3; i++) t.record('fast', 'm', 50, 60, true);
    const ranked = t.rankByTtfac([fe('cold', 'm'), fe('fast', 'm')]);
    expect(ranked[0].provider).toBe('fast');   // promoted to the front
    expect(ranked[1].provider).toBe('cold');
  });

  it('a provider with only failures is treated as unscored (kept after scored)', () => {
    const t = new TtfacTracker({ enabled: true, minSamples: 3, ttfacWeight: 1 });
    for (let i = 0; i < 3; i++) t.record('broken', 'm', 1, 1, false); // all failures
    for (let i = 0; i < 3; i++) t.record('good', 'm', 100, 120, true);
    const ranked = t.rankByTtfac([fe('broken', 'm'), fe('good', 'm')]);
    expect(ranked[0].provider).toBe('good');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #353 — performance ranker neutral anchor is configurable per stage
// ════════════════════════════════════════════════════════════════════════════
describe('PerformanceRanker configurable neutral anchor (opt #353)', () => {
  it('accepts neutralScoreMs without throwing and still ranks fresh samples', () => {
    // A sub-300ms anchor suited for TTS. We can't easily observe the private
    // decay blend, but a fresh (non-stale) fast provider must still rank ahead
    // of a fresh slow one regardless of the anchor.
    const ranker = new PerformanceRanker({ minSamples: 2, neutralScoreMs: 150 });
    for (let i = 0; i < 3; i++) {
      ranker.record('tts', 'fast', 'm', 80, true);
      ranker.record('tts', 'slow', 'm', 900, true);
    }
    const ranked = ranker.rankChain('tts', [fe('slow', 'm'), fe('fast', 'm')]);
    expect(ranked[0].provider).toBe('fast');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #355 — EWMA cold tie-break by cost
// ════════════════════════════════════════════════════════════════════════════
describe('EWMATracker cold tie-break (opt #355)', () => {
  it('picks the cheapest provider when all candidates are cold and a cost lookup is given', () => {
    const t = new EWMATracker();
    const cost: Record<string, number> = { expensive: 10, cheap: 1 };
    // 'expensive' listed first; without the cost tie-break it would win.
    const best = t.pickBest(['expensive', 'cheap'], (p) => cost[p] ?? null);
    expect(best).toBe('cheap');
  });

  it('still prefers a provider with real latency data over cold ones', () => {
    const t = new EWMATracker();
    t.record('warm', 100);
    const best = t.pickBest(['cold', 'warm'], () => 1);
    expect(best).toBe('warm');
  });

  it('falls back to configured order when no cost lookup is supplied', () => {
    const t = new EWMATracker();
    expect(t.pickBest(['a', 'b'])).toBe('a');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #336 / #337 / #338 — caching-layer LRU + sweep + memoize guard
// ════════════════════════════════════════════════════════════════════════════
describe('caching-layer Cache LRU + memoize (opt #336/#337/#338)', () => {
  it('evicts the least-recently-USED entry, not the just-inserted one (#336)', () => {
    vi.useFakeTimers();
    try {
      const cache = new Cache<string, number>({ maxSize: 2, ttlMs: 60_000 });
      cache.set('a', 1);
      vi.advanceTimersByTime(10);
      cache.set('b', 2);
      vi.advanceTimersByTime(10);
      cache.get('a'); // touch 'a' → 'b' is now LRU (older lastAccess)
      vi.advanceTimersByTime(10);
      cache.set('c', 3); // capacity hit → must evict 'b' (LRU), keep fresh 'c' + touched 'a'
      expect(cache.get('a')).toBe(1);
      expect(cache.get('c')).toBe(3);
      expect(cache.get('b')).toBeNull(); // evicted
    } finally {
      vi.useRealTimers();
    }
  });

  it('prefers evicting an already-expired entry on overflow (#336)', () => {
    vi.useFakeTimers();
    try {
      const cache = new Cache<string, number>({ maxSize: 2, ttlMs: 1000 });
      cache.set('old', 1, 10);   // expires fast
      cache.set('keep', 2, 60_000);
      vi.advanceTimersByTime(50); // 'old' now expired
      cache.set('new', 3, 60_000); // overflow → drop expired 'old'
      expect(cache.get('keep')).toBe(2);
      expect(cache.get('new')).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('startSweep schedules an unref-able interval and is idempotent (#337)', () => {
    vi.useFakeTimers();
    try {
      const cache = new Cache<string, number>({ ttlMs: 100 });
      cache.set('x', 1, 100);
      cache.startSweep(1000);
      cache.startSweep(1000); // idempotent — no second timer
      vi.advanceTimersByTime(1500); // sweep fires, 'x' is expired
      // Internal map cleared by sweep — keys() reflects it.
      expect(cache.keys()).not.toContain('x');
      cache.stopSweep();
    } finally {
      vi.useRealTimers();
    }
  });

  it('memoize does not cache a rejected async result (#338)', async () => {
    let calls = 0;
    const fn = memoize(async (fail: boolean) => {
      calls++;
      if (fail) throw new Error('nope');
      return 'ok';
    });
    await expect(fn(true)).rejects.toThrow('nope');
    // Second identical call must re-invoke (rejection was not memoized).
    await expect(fn(true)).rejects.toThrow('nope');
    expect(calls).toBe(2);
  });

  it('memoize caches a successful async result', async () => {
    let calls = 0;
    const fn = memoize(async (x: number) => { calls++; return x * 2; });
    expect(await fn(21)).toBe(42);
    expect(await fn(21)).toBe(42);
    expect(calls).toBe(1);
  });

  it('memoize does not cache a sync null/undefined result (#338)', () => {
    let calls = 0;
    const fn = memoize((x: number) => { calls++; return x === 0 ? null : x; });
    expect(fn(0)).toBeNull();
    expect(fn(0)).toBeNull();
    expect(calls).toBe(2); // null never memoized
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #367 / #375 — OpenAI STT default + TTS unknown-voice remap flag
// ════════════════════════════════════════════════════════════════════════════
describe('OpenAI provider pure helpers (opt #367/#375)', () => {
  it('defaults OpenAI STT to the cheaper mini model, honoring explicit overrides (#367)', () => {
    expect(resolveOpenAISttModel()).toBe(DEFAULT_OPENAI_STT_MODEL);
    expect(DEFAULT_OPENAI_STT_MODEL).toBe('gpt-4o-mini-transcribe');
    expect(resolveOpenAISttModel('whisper-1')).toBe('whisper-1');
  });

  it('flags an unknown TTS voice as remapped instead of silently substituting (#375)', () => {
    const known = new Set(['nova', 'alloy', 'shimmer']);
    expect(resolveOpenAIVoice('alloy', known)).toEqual({ voice: 'alloy', wasRemapped: false });
    expect(resolveOpenAIVoice('bogus', known)).toEqual({ voice: OPENAI_DEFAULT_VOICE, wasRemapped: true });
    // Unspecified voice → default, but not flagged as a (user error) remap.
    expect(resolveOpenAIVoice(undefined, known)).toEqual({ voice: OPENAI_DEFAULT_VOICE, wasRemapped: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #368 / #369 — Deepgram query param building
// ════════════════════════════════════════════════════════════════════════════
describe('buildDeepgramParams (opt #368/#369)', () => {
  const base = (extra: Partial<STTRequest> = {}): STTRequest => ({ audio: Buffer.from(''), model: 'nova-3', ...extra });

  it('does not force smart_format on by default (#369)', () => {
    const p = buildDeepgramParams(base());
    expect(p.has('smart_format')).toBe(false);
  });

  it('enables smart_format only when explicitly opted in (#369)', () => {
    const p = buildDeepgramParams(base({ smartFormat: true }));
    expect(p.get('smart_format')).toBe('true');
  });

  it('does not toggle punctuate when word timestamps are requested (#368)', () => {
    const p = buildDeepgramParams(base({ wordTimestamps: true }));
    expect(p.has('punctuate')).toBe(false); // Nova returns words natively
  });

  it('passes through VAD/endpointing knobs', () => {
    const p = buildDeepgramParams(base({ language: 'fr', vad: { endpointingMs: 300, utteranceEndMs: 1000, vadEvents: true } }));
    expect(p.get('language')).toBe('fr');
    expect(p.get('endpointing')).toBe('300');
    expect(p.get('utterance_end_ms')).toBe('1000');
    expect(p.get('vad_events')).toBe('true');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #387 — batch detector per-tenant isolation
// ════════════════════════════════════════════════════════════════════════════
describe('BatchDetector per-tenant isolation (opt #387)', () => {
  it('counts same-language requests within the window and isolates tenants', () => {
    const d = new BatchDetector();
    d.record('fr', 'tenant-A');
    d.record('fr', 'tenant-A');
    expect(d.record('fr', 'tenant-A')).toBe(3); // 3rd → opportunity
    expect(d.getOpportunityCount('tenant-A')).toBe(1);

    // Tenant B is completely independent — its window is empty.
    expect(d.record('fr', 'tenant-B')).toBe(1);
    expect(d.getOpportunityCount('tenant-B')).toBe(0);

    // Aggregate total spans both tenants.
    expect(d.getOpportunityCount()).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #390 — hybrid router no longer defaults to a decommissioned Groq model
// (asserted indirectly: the constant is gone from the routing default path).
// ════════════════════════════════════════════════════════════════════════════
describe('hybrid-router default model (opt #390)', () => {
  it('source no longer uses the decommissioned mixtral default', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/gateway/routing/hybrid-router.ts'),
      'utf-8',
    );
    // The non-speech Groq default must be a current model, not mixtral-8x7b.
    expect(src).toContain("pipelineType === 'speech' ? this.deps.groqLlmModel() : 'llama-3.3-70b-versatile'");
  });
});
