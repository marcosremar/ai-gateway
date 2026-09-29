/**
 * Replicas: several endpoints of the same provider/model in one fallback chain (e.g. three Qwen3-TTS servers).
 * Each replica has its own cooldown, circuit breaker, adaptive timeout and performance ranking; a dead replica
 * fails over to the next one immediately and its siblings stay usable.
 */
import { describe, it, expect } from 'vitest';
import { withProviderFallback, CooldownTracker, type FallbackEntry } from '../../src/providers/fallback';
import { CircuitBreakerRegistry } from '../../src/providers/circuit-breaker';
import { PerformanceRanker } from '../../src/providers/performance-ranker';
import { AdaptiveTimeoutCalculator } from '../../src/providers/adaptive-timeout';
import { entryHealthKey } from '../../src/gateway/providers/cloud/entry-key';

const A = 'http://a.example:8000';
const B = 'http://b.example:8000';
const C = 'http://c.example:8000';
const replica = (endpoint: string): FallbackEntry => ({ provider: 'self-hosted', model: 'qwen3-tts', endpoint });

function serverError(status = 503): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** A fake fleet: `dead` endpoints throw, the others answer with their own name. */
function fleet(dead: Set<string>, calls: string[] = []) {
  return async (entry: FallbackEntry): Promise<string> => {
    calls.push(entry.endpoint!);
    if (dead.has(entry.endpoint!)) throw serverError();
    return `voice from ${entry.endpoint}`;
  };
}

describe('replica health keys', () => {
  it('keeps the plain provider id when there is no endpoint, so existing chains behave as before', () => {
    expect(entryHealthKey({ provider: 'groq' })).toBe('groq');
    expect(entryHealthKey({ provider: 'self-hosted', endpoint: A })).toBe(`self-hosted@${A}`);
  });
});

describe('withProviderFallback with three replicas', () => {
  it('goes straight to the next replica when one is down, and reports which one answered', async () => {
    const calls: string[] = [];
    const out = await withProviderFallback([replica(A), replica(B), replica(C)], fleet(new Set([A]), calls), {
      cooldownTracker: new CooldownTracker(), timeoutMs: 1000,
    });
    expect(calls).toEqual([A, B]);
    expect(out.result).toBe(`voice from ${B}`);
    expect(out.usedEndpoint).toBe(B);
    expect(out.attempts).toBe(2);
  });

  it('a dead replica cools down alone: its healthy siblings are never skipped', async () => {
    const tracker = new CooldownTracker();
    const dead = new Set([A]);
    const opts = { cooldownTracker: tracker, allowedFails: 2, cooldownMs: 60_000, timeoutMs: 1000 };
    for (let i = 0; i < 3; i++) await withProviderFallback([replica(A), replica(B), replica(C)], fleet(dead), opts);
    expect(tracker.isCoolingDown(replica(A))).toBe(true);
    expect(tracker.isCoolingDown(replica(B))).toBe(false);
    expect(tracker.isCoolingDown(replica(C))).toBe(false);
    // With A cooling down the chain does not even try it.
    const calls: string[] = [];
    await withProviderFallback([replica(A), replica(B), replica(C)], fleet(dead, calls), opts);
    expect(calls).toEqual([B]);
  });

  it('opens the circuit of the dead replica only', async () => {
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeoutMs: 60_000 });
    const opts = { cooldownTracker: new CooldownTracker(), circuitBreakers: breakers, allowedFails: 99, timeoutMs: 1000 };
    for (let i = 0; i < 3; i++) await withProviderFallback([replica(A), replica(B)], fleet(new Set([A])), opts);
    const stats = breakers.allStats();
    expect(stats[entryHealthKey(replica(A))]?.state).toBe('open');
    expect(stats[entryHealthKey(replica(B))]?.state).not.toBe('open');
    const calls: string[] = [];
    await withProviderFallback([replica(A), replica(B)], fleet(new Set([A]), calls), opts);
    expect(calls).toEqual([B]);
  });

  it('recovers: a replica that comes back is used again after its cooldown', async () => {
    const tracker = new CooldownTracker();
    const dead = new Set([A]);
    const opts = { cooldownTracker: tracker, allowedFails: 1, cooldownMs: 1, timeoutMs: 1000 };
    await withProviderFallback([replica(A), replica(B)], fleet(dead), opts);
    expect(tracker.isCoolingDown(replica(A))).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    dead.clear();
    const calls: string[] = [];
    const out = await withProviderFallback([replica(A), replica(B)], fleet(dead, calls), opts);
    expect(out.usedEndpoint).toBe(A);
    expect(calls).toEqual([A]);
  });

  it('fails only when every replica failed, with the last error', async () => {
    await expect(withProviderFallback([replica(A), replica(B), replica(C)], fleet(new Set([A, B, C])), {
      cooldownTracker: new CooldownTracker(), timeoutMs: 1000,
    })).rejects.toThrow(/503/);
  });

  it('orders replicas by their own observed latency (the slow one goes last), each ranked separately', async () => {
    const ranker = new PerformanceRanker({ minSamples: 3 });
    for (let i = 0; i < 5; i++) {
      ranker.record('tts', entryHealthKey(replica(A)), 'qwen3-tts', 900, true);
      ranker.record('tts', entryHealthKey(replica(B)), 'qwen3-tts', 120, true);
      ranker.record('tts', entryHealthKey(replica(C)), 'qwen3-tts', 300, true);
    }
    const ordered = ranker.rankChain('tts', [replica(A), replica(B), replica(C)]);
    expect(ordered.map((e) => e.endpoint)).toEqual([B, C, A]);
  });

  it('records each call on the replica that served it, so ranking follows real traffic', async () => {
    const ranker = new PerformanceRanker({ minSamples: 1 });
    const adaptive = new AdaptiveTimeoutCalculator();
    await withProviderFallback([replica(A), replica(B)], fleet(new Set([A])), {
      cooldownTracker: new CooldownTracker(), performanceRanker: ranker, adaptiveTimeout: adaptive, stage: 'tts', timeoutMs: 1000,
    });
    const statsA = ranker.getStats('tts', entryHealthKey(replica(A)), 'qwen3-tts');
    const statsB = ranker.getStats('tts', entryHealthKey(replica(B)), 'qwen3-tts');
    expect(statsA?.sampleCount).toBe(1);
    expect(statsA?.successRate).toBe(0);
    expect(statsB?.sampleCount).toBe(1);
    expect(statsB?.successRate).toBe(1);
  });
});
