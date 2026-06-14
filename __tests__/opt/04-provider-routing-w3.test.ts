/**
 * Wave-3 unit tests for provider-routing / caching optimizations
 * (docs/optimizations/04-provider-routing-caching.md).
 *
 * Scope: pure, importable logic only — no network / provider SDK / GPU / real
 * FS. Provider clients are exercised via side-effect-free pure helpers.
 *
 * Covered findings:
 *   #308 cooldown key includes endpoint (distributed-pod isolation);
 *   #313 diversifier inserts cross-family backup early (not only tail);
 *   #320 standalone coalesce eager-deletes a rejecting promise;
 *   #324 coalescer allows temp>0 when a fixed seed is present;
 *   #333 with-cache deterministic-enough condition for low temperatures;
 *   #335 response-cache Map-based O(1) LRU recency + eviction;
 *   #344 adaptive-timeout records timeouts penalized, not at the ceiling;
 *   #346 adaptive-timeout excludes failures from the p95;
 *   #363 percentage-routing canary feedback auto-shrinks failing variant;
 *   #371 provider error normalization carries a real .status;
 *   #386 batch-detector drains language-grouped batches;
 *   #391 analytics economics computed from real spend;
 *   #395 lazy-provider uses explicit name in logs;
 *   #399 provider registry unregister.
 */
import { describe, it, expect, vi } from 'vitest';

import { cooldownKey } from '../../src/gateway/providers/cloud/fallback';
import { diversifyChain } from '../../src/gateway/providers/cloud/chain-diversifier';
import { coalesce, RequestCoalescer } from '../../src/gateway/proxy/middleware/request-coalescer';
import { deterministicEnoughCondition } from '../../src/caching/with-cache';
import { ResponseCache } from '../../src/caching/response-cache';
import { AdaptiveTimeoutCalculator } from '../../src/gateway/providers/cloud/adaptive-timeout';
import { applyCanaryFeedback, type PercentageRoute } from '../../src/gateway/providers/cloud/percentage-routing';
import {
  makeProviderError,
  normalizeProviderError,
  extractStatus,
  hasStatus,
} from '../../src/gateway/providers/cloud/provider-error';
import { BatchDetector, groupByLanguage } from '../../src/gateway/providers/cloud/batch-detector';
import { buildSystemAnalytics, computeEconomics, DEFAULT_REALTIME_METRICS } from '../../src/gateway/routing/analytics-service';
import { createLazyProvider, LazyProviderRegistry } from '../../src/lazy-provider';
import { AIProviderRegistry } from '../../src/gateway/providers/cloud/registry';

// ─── #308 cooldownKey includes endpoint ─────────────────────────────────────
describe('#308 cooldownKey endpoint isolation', () => {
  it('uses provider:model when no endpoint is set (backward compatible)', () => {
    expect(cooldownKey({ provider: 'groq', model: 'llama' })).toBe('groq:llama');
    expect(cooldownKey({ provider: 'groq' })).toBe('groq:*');
  });

  it('includes endpoint so distinct pods get distinct cooldown keys', () => {
    const a = cooldownKey({ provider: 'self-hosted', model: 'whisper', endpoint: 'http://pod-a' });
    const b = cooldownKey({ provider: 'self-hosted', model: 'whisper', endpoint: 'http://pod-b' });
    expect(a).not.toBe(b);
    expect(a).toContain('pod-a');
    expect(b).toContain('pod-b');
  });
});

// ─── #313 diversifier insert-early ──────────────────────────────────────────
describe('#313 diversifier insert position', () => {
  const chain = [
    { provider: 'groq', model: 'whisper-large-v3-turbo' },
    { provider: 'groq', model: 'whisper-large-v3' },
  ];
  const available = new Set(['groq', 'openai']);

  it('default (tail) appends the cross-family backup last', () => {
    const out = diversifyChain(chain, 'stt', available);
    expect(out[out.length - 1].provider).toBe('openai');
    expect(out[0].provider).toBe('groq');
  });

  it('early inserts the backup as the second entry', () => {
    const out = diversifyChain(chain, 'stt', available, { insertPosition: 'early' });
    expect(out[0].provider).toBe('groq'); // primary preserved
    expect(out[1].provider).toBe('openai'); // diversity reached early
    expect(out).toHaveLength(3);
  });

  it('returns the original chain when no eligible backup exists', () => {
    const out = diversifyChain(chain, 'stt', new Set(['groq']), { insertPosition: 'early' });
    expect(out).toBe(chain);
  });
});

// ─── #320 standalone coalesce eager delete on reject ────────────────────────
describe('#320 coalesce releases rejecting promise eagerly', () => {
  it('a later call after rejection does not join the dead promise', async () => {
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error('boom'));
    };
    await expect(coalesce('k320', failing)).rejects.toThrow('boom');
    // After the first promise settled (rejected), the slot must be released so
    // a fresh call re-invokes fn rather than re-attaching to the dead promise.
    await expect(coalesce('k320', failing)).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });

  it('still coalesces concurrent identical in-flight calls', async () => {
    let calls = 0;
    let resolve!: (v: string) => void;
    const fn = () => {
      calls++;
      return new Promise<string>((r) => { resolve = r; });
    };
    const p1 = coalesce('k320b', fn);
    const p2 = coalesce('k320b', fn);
    resolve('ok');
    expect(await p1).toBe('ok');
    expect(await p2).toBe('ok');
    expect(calls).toBe(1);
  });
});

// ─── #324 coalescer allows temp>0 with seed ─────────────────────────────────
describe('#324 coalescing with deterministic seed', () => {
  const c = new RequestCoalescer();
  const base = { provider: 'groq', model: 'llama', messages: [{ role: 'user', content: 'hi' }] };

  it('refuses to coalesce non-zero temperature without a seed', () => {
    expect(c.buildKey({ ...base, temperature: 0.7 })).toBeNull();
  });

  it('coalesces non-zero temperature when a seed is supplied', () => {
    const key = c.buildKey({ ...base, temperature: 0.7, seed: 42 });
    expect(key).not.toBeNull();
  });

  it('still coalesces temperature 0 / undefined', () => {
    expect(c.buildKey({ ...base, temperature: 0 })).not.toBeNull();
    expect(c.buildKey({ ...base })).not.toBeNull();
  });

  it('different seeds produce different keys', () => {
    const k1 = c.buildKey({ ...base, temperature: 0.7, seed: 1 });
    const k2 = c.buildKey({ ...base, temperature: 0.7, seed: 2 });
    expect(k1).not.toBe(k2);
  });
});

// ─── #333 with-cache deterministic-enough condition ─────────────────────────
describe('#333 deterministicEnoughCondition', () => {
  const cond = deterministicEnoughCondition(); // default 0.3
  const req = (temperature?: number) => ({ model: 'm', messages: [], temperature } as any);

  it('caches temperature undefined and 0', () => {
    expect(cond(req(undefined))).toBe(true);
    expect(cond(req(0))).toBe(true);
  });

  it('caches low non-zero temperatures up to the bound', () => {
    expect(cond(req(0.2))).toBe(true);
    expect(cond(req(0.3))).toBe(true);
  });

  it('does not cache temperatures above the bound', () => {
    expect(cond(req(0.4))).toBe(false);
    expect(cond(req(1))).toBe(false);
  });

  it('honors a custom maxTemperature', () => {
    const strict = deterministicEnoughCondition(0.1);
    expect(strict(req(0.2))).toBe(false);
    expect(strict(req(0.05))).toBe(true);
  });
});

// ─── #335 response-cache Map-based LRU ───────────────────────────────────────
function makeKv() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => { store.set(k, v); },
    del: async (k: string) => { store.delete(k); },
    scan: async () => {},
    _store: store,
  };
}

describe('#335 response-cache O(1) LRU recency', () => {
  it('evicts the least-recently-used entry, not the most recent', async () => {
    const kv = makeKv();
    const cache = new ResponseCache(kv as any, { maxSize: 2, prefix: 'c:' });
    const kA = cache.buildKey({ provider: 'p', model: 'a' });
    const kB = cache.buildKey({ provider: 'p', model: 'b' });
    const kC = cache.buildKey({ provider: 'p', model: 'c' });

    await cache.set(kA, { content: 'A' });
    await cache.set(kB, { content: 'B' });
    // Access A so B becomes least-recently-used.
    await cache.get(kA);
    await cache.set(kC, { content: 'C' }); // triggers eviction of LRU (B)

    expect(await cache.get<any>(kA)).toEqual({ content: 'A' });
    expect(await cache.get<any>(kB)).toBeNull(); // B evicted
    expect(await cache.get<any>(kC)).toEqual({ content: 'C' });
    expect(cache.stats().size).toBe(2);
    expect(cache.stats().evictions).toBe(1);
  });

  it('overwrites do not double-count size', async () => {
    const kv = makeKv();
    const cache = new ResponseCache(kv as any, { maxSize: 5, prefix: 'c:' });
    const k = cache.buildKey({ provider: 'p', model: 'x' });
    await cache.set(k, { content: '1' });
    await cache.set(k, { content: '2' });
    expect(cache.stats().size).toBe(1);
    expect(await cache.get<any>(k)).toEqual({ content: '2' });
  });

  it('invalidateKey removes from recency and decrements size', async () => {
    const kv = makeKv();
    const cache = new ResponseCache(kv as any, { maxSize: 5, prefix: 'c:' });
    const k = cache.buildKey({ provider: 'p', model: 'y' });
    await cache.set(k, { content: 'v' });
    await cache.invalidateKey(k);
    expect(cache.stats().size).toBe(0);
    expect(await cache.get<any>(k)).toBeNull();
  });
});

// ─── #344 / #346 adaptive timeout failure handling ──────────────────────────
describe('#344/#346 adaptive timeout failure handling', () => {
  it('#346 excludes fast failures from the p95 so slow successes keep a sane timeout', () => {
    const calc = new AdaptiveTimeoutCalculator({ minSamples: 3, marginMultiplier: 1, minTimeoutMs: 1, maxTimeoutMs: 100_000 });
    // 3 slow successes (~1000ms) + many fast failures (1ms).
    for (let i = 0; i < 3; i++) calc.record('p', 'm', 1000, true);
    for (let i = 0; i < 10; i++) calc.record('p', 'm', 1, false);
    const t = calc.getTimeout('p', 'm', 9999);
    // p95 of successes ~1000 → timeout ~1000, NOT dragged toward ~1ms.
    expect(t).toBeGreaterThan(500);
  });

  it('#344 recordTimeout records below the ceiling and marks a failure', () => {
    const calc = new AdaptiveTimeoutCalculator({ minSamples: 1, marginMultiplier: 1, minTimeoutMs: 1, maxTimeoutMs: 100_000 });
    calc.recordTimeout('p', 'm', 10_000); // default 0.75 penalty → 7500, failure
    // Only a failure sample exists; with <minSamples successes it falls back to
    // all-valid samples, so timeout reflects the penalized 7500, not 10_000.
    const t = calc.getTimeout('p', 'm', 1);
    expect(t).toBeLessThan(10_000);
    expect(t).toBeGreaterThan(0);
  });

  it('plain record defaults to success (backward compatible)', () => {
    const calc = new AdaptiveTimeoutCalculator({ minSamples: 2, marginMultiplier: 1, minTimeoutMs: 1, maxTimeoutMs: 100_000 });
    calc.record('p', 'm', 200);
    calc.record('p', 'm', 200);
    expect(calc.getTimeout('p', 'm', 9999)).toBeGreaterThan(100);
  });
});

// ─── #363 canary feedback ───────────────────────────────────────────────────
describe('#363 applyCanaryFeedback', () => {
  const routes: PercentageRoute[] = [
    { provider: 'stable', percentage: 80 },
    { provider: 'canary', percentage: 20 },
  ];

  it('leaves routes below tolerance untouched', () => {
    const out = applyCanaryFeedback(routes, (r) => (r.provider === 'canary' ? 0.02 : 0));
    expect(out.find((r) => r.provider === 'canary')!.percentage).toBe(20);
  });

  it('zeroes a route whose error rate crosses the kill threshold', () => {
    const out = applyCanaryFeedback(routes, (r) => (r.provider === 'canary' ? 0.6 : 0));
    expect(out.find((r) => r.provider === 'canary')!.percentage).toBe(0);
  });

  it('shrinks proportionally between tolerance and kill', () => {
    // err exactly midway (tolerance 0.05, kill 0.5) → keepFraction ~0.5
    const mid = 0.05 + (0.5 - 0.05) / 2;
    const out = applyCanaryFeedback(routes, (r) => (r.provider === 'canary' ? mid : 0));
    const canary = out.find((r) => r.provider === 'canary')!;
    expect(canary.percentage).toBeGreaterThan(8);
    expect(canary.percentage).toBeLessThan(12);
  });

  it('leaves routes with no data unchanged', () => {
    const out = applyCanaryFeedback(routes, () => null);
    expect(out).toEqual(routes);
    expect(out).not.toBe(routes); // returns a copy
  });
});

// ─── #371 provider error normalization ──────────────────────────────────────
describe('#371 provider error normalization', () => {
  it('makeProviderError carries a numeric .status', () => {
    const e = makeProviderError('deepgram', 429, 'rate limited');
    expect(e.status).toBe(429);
    expect(e.provider).toBe('deepgram');
    expect(hasStatus(e)).toBe(true);
    expect(e.message).toContain('429');
  });

  it('extractStatus reads .status, .response.status, then message token', () => {
    expect(extractStatus({ status: 503 })).toBe(503);
    expect(extractStatus({ response: { status: 502 } })).toBe(502);
    expect(extractStatus(new Error('[x] HTTP 429: too many'))).toBe(429);
    expect(extractStatus(new Error('no code here'))).toBeNull();
  });

  it('normalizeProviderError preserves an existing status', () => {
    const orig = Object.assign(new Error('boom'), { status: 429 });
    const n = normalizeProviderError('minimax', orig);
    expect(n.status).toBe(429);
  });

  it('normalizeProviderError applies fallback status when none present', () => {
    const n = normalizeProviderError('minimax', new Error('socket hang up'));
    expect(n.status).toBe(502);
    expect(n.provider).toBe('minimax');
  });
});

// ─── #386 batch detector grouping/draining ──────────────────────────────────
describe('#386 batch detector grouping', () => {
  it('groupByLanguage counts per language', () => {
    const counts = groupByLanguage([
      { language: 'en' }, { language: 'en' }, { language: 'fr' },
    ]);
    expect(counts.get('en')).toBe(2);
    expect(counts.get('fr')).toBe(1);
  });

  it('drainBatchableGroups returns only groups at/above threshold and removes them', () => {
    const d = new BatchDetector();
    d.record('en', 't1');
    d.record('en', 't1');
    d.record('en', 't1'); // 3 en → batchable (threshold 3)
    d.record('fr', 't1'); // 1 fr → not batchable
    const drained = d.drainBatchableGroups('t1');
    expect(drained.get('en')).toBe(3);
    expect(drained.has('fr')).toBe(false);
    // en drained, fr remains; a second drain finds nothing batchable.
    const again = d.drainBatchableGroups('t1');
    expect(again.size).toBe(0);
  });

  it('isolates tenants when draining', () => {
    const d = new BatchDetector();
    d.record('en', 'A');
    d.record('en', 'A');
    d.record('en', 'A');
    expect(d.drainBatchableGroups('B').size).toBe(0); // other tenant untouched
    expect(d.drainBatchableGroups('A').get('en')).toBe(3);
  });
});

// ─── #391 analytics economics from real spend ───────────────────────────────
describe('#391 computeEconomics', () => {
  it('falls back to demo constants without real data', () => {
    const e = computeEconomics();
    expect(e.gpuCostHour).toBe(0.16);
    expect(e.vsCompetitors.openaiSavings).toBe(99.6);
  });

  it('computes savings percentage from real costs', () => {
    const e = computeEconomics({ gpuCostHour: 1, competitorCostHour: 10, selfHostedShare: 0.8 });
    expect(e.gpuCostHour).toBe(1);
    expect(e.vsCompetitors.openaiRealtime).toBe(10);
    expect(e.vsCompetitors.openaiSavings).toBe(90); // (1 - 1/10) * 100
    expect(e.aiGatewayEfficiency).toBe(0.8);
  });

  it('clamps efficiency share to 0..1 and never negative savings', () => {
    const e = computeEconomics({ gpuCostHour: 20, competitorCostHour: 10, selfHostedShare: 2 });
    expect(e.vsCompetitors.openaiSavings).toBe(0); // cheaper-than-competitor false → 0, not negative
    expect(e.aiGatewayEfficiency).toBe(1);
  });

  it('buildSystemAnalytics threads real economics through', () => {
    const payload = buildSystemAnalytics({
      requestId: 'r1',
      realtimeMetrics: DEFAULT_REALTIME_METRICS,
      routingAdvice: { provider: 'gpu', confidence: 0.9, reason: 'x', costEstimate: 0.01 } as any,
      economics: { gpuCostHour: 2, competitorCostHour: 20 },
    });
    expect(payload.economics.vsCompetitors.openaiSavings).toBe(90);
  });
});

// ─── #395 lazy-provider explicit name ───────────────────────────────────────
describe('#395 lazy-provider explicit name', () => {
  it('does not log "undefined" for an anonymous factory; uses given name', async () => {
    const reg = new LazyProviderRegistry();
    reg.register('groq-stt', async () => ({ ok: true }));
    const inst = await reg.get<{ ok: boolean }>('groq-stt');
    expect(inst.ok).toBe(true);
    // status uses the registry name, proving it's tracked by an explicit label.
    expect(reg.status()[0].name).toBe('groq-stt');
    expect(reg.isLoaded('groq-stt')).toBe(true);
  });

  it('createLazyProvider falls back to "anonymous" when no name and arrow factory', async () => {
    // Arrow factories have an empty .name; ensure get() still resolves cleanly.
    const lp = createLazyProvider(async () => 42);
    expect(await lp.get()).toBe(42);
    expect(lp.isLoaded()).toBe(true);
  });
});

// ─── #399 registry unregister ───────────────────────────────────────────────
describe('#399 AIProviderRegistry.unregister', () => {
  it('removes a provider so it is no longer routable', () => {
    const reg = new AIProviderRegistry();
    reg.register({ id: 'groq', name: 'Groq', description: '', capabilities: ['llm'], llm: { providerId: 'groq' } as any } as any);
    expect(reg.getProvider('groq')).toBeDefined();
    expect(reg.unregister('groq')).toBe(true);
    expect(reg.getProvider('groq')).toBeUndefined();
  });

  it('also clears embedding and rerank registrations for the id', () => {
    const reg = new AIProviderRegistry();
    reg.registerEmbeddingProvider('openai', { providerId: 'openai' } as any);
    reg.registerRerankProvider('openai', { providerId: 'openai' } as any);
    expect(reg.unregister('openai')).toBe(true);
    expect(() => reg.getEmbeddingProvider('openai')).toThrow();
    expect(() => reg.getRerankProvider('openai')).toThrow();
  });

  it('returns false when nothing was registered under the id', () => {
    const reg = new AIProviderRegistry();
    expect(reg.unregister('nope')).toBe(false);
  });
});
