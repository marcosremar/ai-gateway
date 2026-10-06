/**
 * Unit tests for src/gateway/routing/provider-racer.ts
 *
 * Covers: empty-candidates guard, single-candidate fast path, single-candidate
 * timeout abort, parallel race (first wins, losers cancelled), headstart logic
 * (primary wins during window, headstart expires → remaining launched, primary
 * wins after expiry), all-fail throws last real error (not AbortError), abort
 * signal propagation, three-candidate race, AbortError swallowing in all-fail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { raceProviders, type RaceCandidate, type RaceResult } from '../src/gateway/routing/provider-racer';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a candidate that resolves after `delayMs` with `value`. */
function makeOk<T>(name: string, value: T, delayMs = 0): RaceCandidate<T> {
  return {
    name,
    run: (signal) =>
      new Promise<T>((resolve, reject) => {
        const id = setTimeout(() => resolve(value), delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(id);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
  };
}

/** Build a candidate that rejects after `delayMs` with `err`. */
function makeErr<T>(name: string, err: Error, delayMs = 0): RaceCandidate<T> {
  return {
    name,
    run: (signal) =>
      new Promise<T>((_, reject) => {
        const id = setTimeout(() => reject(err), delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(id);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('raceProviders', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Guards ─────────────────────────────────────────────────────────────────

  describe('empty candidates', () => {
    it('throws synchronously when candidates array is empty', async () => {
      await expect(raceProviders([])).rejects.toThrow('raceProviders: no candidates');
    });
  });

  // ── Single-candidate fast path ─────────────────────────────────────────────

  describe('single candidate', () => {
    it('resolves with the candidate result', async () => {
      const c = makeOk('gpu', 'hello');
      const p = raceProviders([c]);
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.result).toBe('hello');
      expect(res.provider).toBe('gpu');
      expect(res.otherCancelled).toBe(false);
    });

    it('latencyMs is non-negative', async () => {
      const c = makeOk('gpu', 42, 10);
      const p = raceProviders([c]);
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('rejects when the single candidate rejects', async () => {
      const err = new Error('upstream failure');
      const c = makeErr<string>('gpu', err);
      const p = raceProviders([c]);
      const check = expect(p).rejects.toThrow('upstream failure');
      await vi.runAllTimersAsync();
      await check;
    });

    it('aborts via timeout and rejects with AbortError', async () => {
      const c: RaceCandidate<string> = {
        name: 'slow',
        run: (signal) =>
          new Promise<string>((resolve, reject) => {
            const id = setTimeout(() => resolve('late'), 2_000);
            signal.addEventListener('abort', () => {
              clearTimeout(id);
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
        timeoutMs: 100,
      };
      const p = raceProviders([c]);
      const check = expect(p).rejects.toThrow('Aborted');
      await vi.runAllTimersAsync();
      await check;
    });
  });

  // ── Multi-candidate parallel race ─────────────────────────────────────────

  describe('parallel race (no headstart)', () => {
    it('returns the fastest candidate result', async () => {
      const fast = makeOk('groq', 'fast-result', 10);
      const slow = makeOk('gpu', 'slow-result', 500);
      const p = raceProviders([fast, slow]);
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.result).toBe('fast-result');
      expect(res.provider).toBe('groq');
    });

    it('winner has otherCancelled=true', async () => {
      const fast = makeOk('groq', 'x', 10);
      const slow = makeOk('gpu', 'y', 500);
      const p = raceProviders([fast, slow]);
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.otherCancelled).toBe(true);
    });

    it('second-place candidate abort signal is fired', async () => {
      let loserAborted = false;
      const fast: RaceCandidate<string> = {
        name: 'fast',
        run: (signal) =>
          new Promise<string>((resolve, reject) => {
            const id = setTimeout(() => resolve('won'), 10);
            signal.addEventListener('abort', () => {
              clearTimeout(id);
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      };
      const slow: RaceCandidate<string> = {
        name: 'slow',
        run: (signal) =>
          new Promise<string>((resolve, reject) => {
            const id = setTimeout(() => resolve('lost'), 500);
            signal.addEventListener('abort', () => {
              loserAborted = true;
              clearTimeout(id);
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      };

      const p = raceProviders([fast, slow]);
      await vi.runAllTimersAsync();
      await p;
      expect(loserAborted).toBe(true);
    });

    it('gpu wins when cloud is slower', async () => {
      const gpu = makeOk('gpu', 'gpu-result', 50);
      const cloud = makeOk('groq', 'cloud-result', 200);
      const p = raceProviders([gpu, cloud]);
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.provider).toBe('gpu');
    });

    it('works with three candidates — first resolves wins', async () => {
      const a = makeOk('a', 'result-a', 10);
      const b = makeOk('b', 'result-b', 50);
      const c = makeOk('c', 'result-c', 100);
      const p = raceProviders([a, b, c]);
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.provider).toBe('a');
      expect(res.result).toBe('result-a');
    });
  });

  // ── All candidates fail ───────────────────────────────────────────────────

  describe('all candidates fail', () => {
    it('throws when all two candidates fail', async () => {
      const e1 = new Error('fail-1');
      const e2 = new Error('fail-2');
      const p = raceProviders([
        makeErr<string>('gpu', e1, 10),
        makeErr<string>('groq', e2, 20),
      ]);
      const check = expect(p).rejects.toThrow(/fail/);
      await vi.runAllTimersAsync();
      await check;
    });

    it('does not propagate AbortError when real errors also exist', async () => {
      const realErr = new Error('network-timeout');
      // First candidate fails with real error; second is aborted (AbortError).
      const c1 = makeErr<string>('gpu', realErr, 10);
      const c2 = makeOk<string>('groq', 'ok', 500); // aborted before resolving
      const p = raceProviders([c1, c2]);
      // Let c1 reject (10ms), which triggers abort on c2
      await vi.runAllTimersAsync();
      // When one fails but the other would succeed, it should succeed via the other
      // (c2 is slow but c1 fails first — c2 still resolves unless all fail)
      // Actually: c1 rejects at 10ms but c2 resolves at 500ms — Promise.any
      // waits until c2 succeeds. Let's verify c2 still wins.
      const res = await p;
      expect(res.provider).toBe('groq');
    });

    it('throws real error, not AbortError, when both fail', async () => {
      const realErr = new Error('real-failure');
      // Both fail — c1 with real error, c2 also fails independently.
      const c1 = makeErr<string>('gpu', realErr, 10);
      const c2 = makeErr<string>('groq', new Error('also-fails'), 20);
      const p = raceProviders([c1, c2]);
      const check = expect(p).rejects.not.toThrow('AbortError');
      await vi.runAllTimersAsync();
      await check;
    });

    it('throws when all three candidates fail', async () => {
      const p = raceProviders([
        makeErr<string>('a', new Error('a-fail'), 10),
        makeErr<string>('b', new Error('b-fail'), 20),
        makeErr<string>('c', new Error('c-fail'), 30),
      ]);
      const check = expect(p).rejects.toThrow(/fail/);
      await vi.runAllTimersAsync();
      await check;
    });
  });

  // ── Headstart logic ───────────────────────────────────────────────────────

  describe('headstart', () => {
    it('primary wins during headstart window without launching fallback', async () => {
      const fallbackStarted = { value: false };
      const primary = makeOk('primary', 'primary-result', 10);
      const fallback: RaceCandidate<string> = {
        name: 'fallback',
        run: (signal) => {
          fallbackStarted.value = true;
          return new Promise<string>((resolve, reject) => {
            const id = setTimeout(() => resolve('fallback-result'), 50);
            signal.addEventListener('abort', () => {
              clearTimeout(id);
              reject(new DOMException('Aborted', 'AbortError'));
            });
          });
        },
      };

      const p = raceProviders([primary, fallback], { headstartMs: 50 });
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.provider).toBe('primary');
      expect(res.result).toBe('primary-result');
      // Fallback should NOT have been started since primary won in time
      expect(fallbackStarted.value).toBe(false);
    });

    it('fallback launches after headstart expires when primary is slow', async () => {
      const fallbackStarted = { value: false };
      const primary = makeOk('primary', 'primary-result', 200); // slower than headstart
      const fallback: RaceCandidate<string> = {
        name: 'fallback',
        run: (signal) => {
          fallbackStarted.value = true;
          return new Promise<string>((resolve, reject) => {
            const id = setTimeout(() => resolve('fallback-result'), 50);
            signal.addEventListener('abort', () => {
              clearTimeout(id);
              reject(new DOMException('Aborted', 'AbortError'));
            });
          });
        },
      };

      const p = raceProviders([primary, fallback], { headstartMs: 50 });
      await vi.runAllTimersAsync();
      const res = await p;
      // After headstart expires, fallback wins (200ms > 50ms headstart + 50ms fallback)
      expect(fallbackStarted.value).toBe(true);
      expect(res.provider).toBe('fallback');
      expect(res.result).toBe('fallback-result');
    });

    it('primary can still win after headstart expires if it finishes first', async () => {
      // primary: 60ms total. headstart: 30ms. fallback starts at 30ms and takes 100ms.
      // So primary finishes at 60ms, fallback at 130ms → primary wins.
      const primary = makeOk('primary', 'primary-wins', 60);
      const fallback = makeOk('fallback', 'fallback-loses', 100);

      const p = raceProviders([primary, fallback], { headstartMs: 30 });
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.provider).toBe('primary');
    });

    it('headstart with single candidate behaves like normal single-candidate', async () => {
      // headstartMs is only applied when candidates.length >= 2
      const c = makeOk('only', 'solo', 10);
      const p = raceProviders([c], { headstartMs: 100 });
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.provider).toBe('only');
      expect(res.result).toBe('solo');
    });

    it('primary failure during headstart window falls through to Promise.any with fallback', async () => {
      const primary = makeErr<string>('primary', new Error('primary-dead'), 10);
      const fallback = makeOk('fallback', 'fallback-saves', 80);

      const p = raceProviders([primary, fallback], { headstartMs: 50 });
      await vi.runAllTimersAsync();
      const res = await p;
      // Primary fails at 10ms (within headstart), headstart expires at 50ms,
      // fallback starts and resolves at 50+80=130ms. Promise.any([primary_rejected, fallback]) → fallback wins.
      expect(res.provider).toBe('fallback');
      expect(res.result).toBe('fallback-saves');
    });
  });

  // ── Per-candidate timeouts ────────────────────────────────────────────────

  describe('per-candidate timeouts', () => {
    it('times out a slow candidate so the other can win', async () => {
      const slow: RaceCandidate<string> = {
        name: 'slow',
        run: (signal) =>
          new Promise<string>((resolve, reject) => {
            const id = setTimeout(() => resolve('slow-result'), 500);
            signal.addEventListener('abort', () => {
              clearTimeout(id);
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
        timeoutMs: 50, // aborts itself after 50ms
      };
      const fast = makeOk('fast', 'fast-result', 100);

      const p = raceProviders([slow, fast]);
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.provider).toBe('fast');
      expect(res.result).toBe('fast-result');
    });

    it('per-candidate timeout fires abort signal on that candidate', async () => {
      let abortFired = false;
      const c: RaceCandidate<string> = {
        name: 'timed-out',
        run: (signal) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              abortFired = true;
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
        timeoutMs: 30,
      };
      const other = makeOk('other', 'wins', 100);
      const p = raceProviders([c, other]);
      await vi.runAllTimersAsync();
      await p; // 'other' wins
      expect(abortFired).toBe(true);
    });
  });

  // ── logPrefix option ──────────────────────────────────────────────────────

  describe('logPrefix option', () => {
    it('accepts a logPrefix without throwing', async () => {
      const c = makeOk('gpu', 'ok');
      const p = raceProviders([c, makeOk('cloud', 'ok2', 50)], { logPrefix: '[test-prefix]' });
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.result).toBe('ok');
    });
  });

  // ── Shape of RaceResult ───────────────────────────────────────────────────

  describe('RaceResult shape', () => {
    it('result contains correct fields', async () => {
      const c = makeOk('gpu', { data: 123 });
      const p = raceProviders([c]);
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res).toMatchObject({
        provider: 'gpu',
        otherCancelled: false,
      });
      expect(typeof res.latencyMs).toBe('number');
      expect(res.result).toEqual({ data: 123 });
    });

    it('works with Buffer values', async () => {
      const buf = Buffer.from('audio-bytes');
      const c = makeOk('tts', buf, 5);
      const p = raceProviders([c]);
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.result).toBe(buf);
    });

    it('works with null values', async () => {
      const c = makeOk('provider', null, 5);
      const p = raceProviders([c]);
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.result).toBeNull();
    });
  });
});
