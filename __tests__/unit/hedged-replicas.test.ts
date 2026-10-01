/**
 * Hedged calls over replicas: a slow replica is not waited for, a failing one hands over at once, the winner cancels the
 * others, and health stays per replica.
 */
import { describe, it, expect } from 'vitest';
import { withHedgedReplicas } from '../../src/gateway/routing/hedged-replicas';
import { CooldownTracker, type FallbackEntry } from '../../src/gateway/providers/cloud/fallback';

const A: FallbackEntry = { provider: 'qwen', model: 'own', endpoint: 'http://a' };
const B: FallbackEntry = { provider: 'qwen', model: 'own', endpoint: 'http://b' };
const C: FallbackEntry = { provider: 'qwen', model: 'own', endpoint: 'http://c' };

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
});
const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

/** Fake fleet: per endpoint, how long it takes and whether it fails. */
function fleet(spec: Record<string, { ms: number; fail?: number }>, log: string[] = []) {
  return async (entry: FallbackEntry, signal: AbortSignal): Promise<string> => {
    const { ms, fail } = spec[entry.endpoint!]!;
    log.push(`start ${entry.endpoint}`);
    await sleep(ms, signal);
    if (fail) throw http(fail);
    log.push(`done ${entry.endpoint}`);
    return `voice ${entry.endpoint}`;
  };
}

describe('withHedgedReplicas', () => {
  it('a fast primary answers alone: no second request, not hedged', async () => {
    const log: string[] = [];
    const out = await withHedgedReplicas([A, B], fleet({ 'http://a': { ms: 10 }, 'http://b': { ms: 10 } }, log), { hedgeAfterMs: 80 });
    expect(out).toMatchObject({ usedEndpoint: 'http://a', attempts: 1, hedged: false });
    expect(log).toEqual(['start http://a', 'done http://a']);
  });

  it('a slow primary is hedged after hedgeAfterMs: the second wins without waiting for the slow one, and the slow one is aborted', async () => {
    const log: string[] = [];
    const t0 = Date.now();
    const out = await withHedgedReplicas([A, B], fleet({ 'http://a': { ms: 2000 }, 'http://b': { ms: 20 } }, log), { hedgeAfterMs: 60 });
    expect(out).toMatchObject({ usedEndpoint: 'http://b', attempts: 2, hedged: true });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(log).toEqual(['start http://a', 'start http://b', 'done http://b']); // a never finished: aborted
  });

  it('a failing primary hands over at once, without waiting for the hedge timer', async () => {
    const t0 = Date.now();
    const out = await withHedgedReplicas([A, B], fleet({ 'http://a': { ms: 5, fail: 503 }, 'http://b': { ms: 5 } }), { hedgeAfterMs: 1000 });
    expect(out).toMatchObject({ usedEndpoint: 'http://b', attempts: 2, hedged: false });
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it('never more than maxParallel attempts in flight', async () => {
    let live = 0;
    let peak = 0;
    const out = await withHedgedReplicas([A, B, C], async (entry, signal) => {
      live++; peak = Math.max(peak, live);
      try { await sleep(entry === C ? 10 : 400, signal); return entry.endpoint!; } finally { live--; }
    }, { hedgeAfterMs: 20, maxParallel: 2 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(out.usedEndpoint).toBeDefined();
  });

  it('only a replica that FAILED cools down; one that merely lost the race by being slow does not', async () => {
    const tracker = new CooldownTracker();
    await withHedgedReplicas([A, B], fleet({ 'http://a': { ms: 1000 }, 'http://b': { ms: 5 } }), { hedgeAfterMs: 30, cooldownTracker: tracker, allowedFails: 1 });
    expect(tracker.isCoolingDown(A)).toBe(false);
    await withHedgedReplicas([A, B], fleet({ 'http://a': { ms: 5, fail: 503 }, 'http://b': { ms: 5 } }), { cooldownTracker: tracker, allowedFails: 1 });
    expect(tracker.isCoolingDown(A)).toBe(true);
    expect(tracker.isCoolingDown(B)).toBe(false);
  });

  it('cooling replicas are skipped; if all are cooling, all are tried anyway', async () => {
    const tracker = new CooldownTracker();
    tracker.recordFailure(A, 1, 60_000);
    const log: string[] = [];
    await withHedgedReplicas([A, B], fleet({ 'http://a': { ms: 5 }, 'http://b': { ms: 5 } }, log), { cooldownTracker: tracker });
    expect(log).toEqual(['start http://b', 'done http://b']);
    tracker.recordFailure(B, 1, 60_000);
    const out = await withHedgedReplicas([A, B], fleet({ 'http://a': { ms: 5 }, 'http://b': { ms: 5 } }), { cooldownTracker: tracker });
    expect(out.usedEndpoint).toBe('http://a');
  });

  it('a bad request (4xx) is not tried on the other replica and does not cool the first one down', async () => {
    const tracker = new CooldownTracker();
    const log: string[] = [];
    await expect(withHedgedReplicas([A, B], fleet({ 'http://a': { ms: 5, fail: 400 }, 'http://b': { ms: 5 } }, log), { cooldownTracker: tracker, allowedFails: 1 }))
      .rejects.toThrow(/400/);
    expect(log).toEqual(['start http://a']);
    expect(tracker.isCoolingDown(A)).toBe(false);
  });

  it('every replica failing rejects with the last error; a per-attempt timeout counts as a failure and hands over', async () => {
    await expect(withHedgedReplicas([A, B], fleet({ 'http://a': { ms: 5, fail: 503 }, 'http://b': { ms: 5, fail: 502 } }), { cooldownTracker: new CooldownTracker() }))
      .rejects.toThrow(/502/);
    const out = await withHedgedReplicas([A, B], fleet({ 'http://a': { ms: 2000 }, 'http://b': { ms: 5 } }), { timeoutMs: 40, hedgeAfterMs: 5000, cooldownTracker: new CooldownTracker() });
    expect(out.usedEndpoint).toBe('http://b');
  });

  it('reports every attempt: winners with their latency, aborted losers as censored lower bounds, failures as not ok', async () => {
    const outcomes: Array<[string, boolean, boolean]> = [];
    await withHedgedReplicas([A, B], fleet({ 'http://a': { ms: 1000 }, 'http://b': { ms: 10 } }), {
      hedgeAfterMs: 40, cooldownTracker: new CooldownTracker(),
      onOutcome: (entry, o) => outcomes.push([entry.endpoint!, o.ok, o.censored]),
    });
    expect(outcomes).toEqual(expect.arrayContaining([['http://b', true, false], ['http://a', true, true]]));
    const failures: Array<[string, boolean]> = [];
    await withHedgedReplicas([A, B], fleet({ 'http://a': { ms: 5, fail: 503 }, 'http://b': { ms: 5 } }), {
      cooldownTracker: new CooldownTracker(), onOutcome: (entry, o) => failures.push([entry.endpoint!, o.ok]),
    });
    expect(failures).toEqual([['http://a', false], ['http://b', true]]);
  });

  it('no replicas rejects clearly', async () => {
    await expect(withHedgedReplicas([], fleet({}))).rejects.toThrow(/no replicas/);
  });
});
