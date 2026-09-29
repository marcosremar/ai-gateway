/**
 * Unit tests for src/gateway/routing/provider-racer.ts — raceProviders().
 *
 * Tests cover:
 *   - zero / one candidate edge cases
 *   - true parallel race (headstartMs = 0 or omitted)
 *   - headstart path: primary wins, headstart expires, primary fails during headstart (bug fix)
 *   - all-fail path (AggregateError surfacing)
 *   - per-candidate timeout
 *   - loser AbortSignal cancellation
 *   - AbortError filtering in the all-fail path
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { raceProviders, type RaceCandidate } from '../../src/gateway/routing/provider-racer';

// Helper: build a candidate whose run() resolves after `delayMs` with `value`.
function makeCandidate<T>(
  name: string,
  value: T,
  delayMs: number,
): RaceCandidate<T> {
  return {
    name,
    run: (_signal: AbortSignal) =>
      new Promise<T>(resolve => setTimeout(() => resolve(value), delayMs)),
  };
}

// Helper: build a candidate whose run() rejects after `delayMs` with `message`.
function makeFailingCandidate<T>(
  name: string,
  message: string,
  delayMs: number,
): RaceCandidate<T> {
  return {
    name,
    run: (_signal: AbortSignal) =>
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), delayMs)),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe('raceProviders — edge cases', () => {
  it('throws when called with no candidates', async () => {
    await expect(raceProviders([])).rejects.toThrow('raceProviders: no candidates');
  });

  it('resolves with a single candidate', async () => {
    const result = await raceProviders([makeCandidate('a', 42, 5)]);
    expect(result.result).toBe(42);
    expect(result.provider).toBe('a');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.otherCancelled).toBe(false);
  });

  it('propagates rejection from a single failing candidate', async () => {
    await expect(
      raceProviders([makeFailingCandidate('a', 'boom', 5)]),
    ).rejects.toThrow('boom');
  });
});

// ── Per-candidate timeout ──────────────────────────────────────────────────

describe('raceProviders — per-candidate timeout', () => {
  it('aborts single candidate when timeoutMs elapses', async () => {
    let aborted = false;
    const c: RaceCandidate<number> = {
      name: 'slow',
      timeoutMs: 20,
      run: (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
          // Never resolves on its own
        }),
    };
    await expect(raceProviders([c])).rejects.toThrow('aborted');
    expect(aborted).toBe(true);
  });
});

// ── Parallel race (headstartMs = 0) ───────────────────────────────────────

describe('raceProviders — parallel race', () => {
  it('returns first winner and cancels loser', async () => {
    let loserAborted = false;
    const fast = makeCandidate('fast', 'win', 10);
    const slow: RaceCandidate<string> = {
      name: 'slow',
      run: (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => { loserAborted = true; reject(new Error('aborted')); });
        }),
    };

    const result = await raceProviders([fast, slow]);
    // Give the abort event time to fire
    await new Promise(r => setTimeout(r, 5));

    expect(result.result).toBe('win');
    expect(result.provider).toBe('fast');
    expect(loserAborted).toBe(true);
  });

  it('falls back to second when first fails', async () => {
    const result = await raceProviders([
      makeFailingCandidate('a', 'fail-a', 5),
      makeCandidate('b', 'ok-b', 20),
    ]);
    expect(result.result).toBe('ok-b');
    expect(result.provider).toBe('b');
  });

  it('throws when all candidates fail', async () => {
    await expect(
      raceProviders([
        makeFailingCandidate('a', 'fail-a', 5),
        makeFailingCandidate('b', 'fail-b', 10),
      ]),
    ).rejects.toThrow('fail-b');
  });
});

// ── Headstart race ─────────────────────────────────────────────────────────

describe('raceProviders — headstart path', () => {
  it('primary wins within headstart window', async () => {
    // Primary resolves in 10ms, headstart 50ms, secondary takes 100ms
    const result = await raceProviders(
      [makeCandidate('gpu', 'gpu-result', 10), makeCandidate('cloud', 'cloud-result', 100)],
      { headstartMs: 50 },
    );
    expect(result.result).toBe('gpu-result');
    expect(result.provider).toBe('gpu');
  });

  it('launches remaining candidates when headstart expires', async () => {
    // Primary takes 80ms, headstart 20ms, secondary takes 30ms total
    const result = await raceProviders(
      [makeCandidate('gpu', 'gpu-result', 80), makeCandidate('cloud', 'cloud-result', 30)],
      { headstartMs: 20 },
    );
    // After headstart expires cloud starts; cloud (30ms) beats gpu (80ms)
    expect(result.result).toBe('cloud-result');
    expect(result.provider).toBe('cloud');
  });

  it('falls back to remaining candidates when primary fails DURING headstart window', async () => {
    // BUG FIX regression test:
    // Before fix: primary rejection during headstart propagated out of Promise.race,
    // the catch block re-threw it as a plain Error, and no fallback was tried.
    // After fix: the rejection is caught in the headstart race and treated as expiry,
    // so remaining candidates are launched and the successful cloud response is returned.
    const result = await raceProviders(
      [
        makeFailingCandidate('gpu', 'gpu-crashed', 10),   // fails in 10ms
        makeCandidate('cloud', 'cloud-ok', 50),           // succeeds in 50ms
      ],
      { headstartMs: 200 },                               // headstart > gpu failure time
    );
    expect(result.result).toBe('cloud-ok');
    expect(result.provider).toBe('cloud');
  });

  it('throws when primary fails during headstart AND all remaining also fail', async () => {
    await expect(
      raceProviders(
        [
          makeFailingCandidate('gpu', 'gpu-crashed', 10),
          makeFailingCandidate('cloud', 'cloud-crashed', 30),
        ],
        { headstartMs: 200 },
      ),
    ).rejects.toThrow();
  });

  it('uses secondary over tertiary when secondary is faster', async () => {
    const result = await raceProviders(
      [
        makeCandidate('gpu', 'gpu', 200),
        makeCandidate('cloud-a', 'a', 40),
        makeCandidate('cloud-b', 'b', 80),
      ],
      { headstartMs: 10 },
    );
    expect(result.result).toBe('a');
    expect(result.provider).toBe('cloud-a');
  });
});

// ── AbortError filtering ───────────────────────────────────────────────────

describe('raceProviders — AbortError filtering in all-fail path', () => {
  it('surfaces the real error over a DOMException AbortError when both candidates fail', async () => {
    // Candidate B uses per-candidate timeout to generate a real AbortError via AbortController.
    // Candidate A fails later with a real Error.
    // raceProviders should surface the real error, not the AbortError.
    const realError: RaceCandidate<number> = {
      name: 'real-failure',
      run: (_signal) =>
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('real problem')), 30),
        ),
    };
    const abortVictim: RaceCandidate<number> = {
      name: 'abort-victim',
      timeoutMs: 10, // per-candidate timeout aborts this one first
      run: (signal) =>
        new Promise<number>((_, reject) => {
          // Reject with the abort signal reason (a DOMException AbortError)
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    };

    // abortVictim fails first (10ms) with DOMException AbortError;
    // realError fails second (30ms) with a regular Error.
    // AggregateError from Promise.any contains both; only real Error passes the filter.
    await expect(raceProviders([realError, abortVictim])).rejects.toThrow('real problem');
  });
});
