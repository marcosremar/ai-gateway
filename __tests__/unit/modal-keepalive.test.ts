// ── ModalKeepalive unit suite ─────────────────────────────────────────────────
// Covers the timer-based keepalive class that pings Modal /health every 4 min
// and auto-stops after 20 min of inactivity.
//
// All timers and fetch are controlled — no real I/O.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModalKeepalive } from '../../src/gateway/pipeline/modal-keepalive';

// ── Constants mirrored from the SUT ──────────────────────────────────────────
const PING_INTERVAL_MS = 4 * 60_000; // 4 min
const IDLE_STOP_MS = 20 * 60_000;    // 20 min

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOkFetch(body: Record<string, unknown> = { uptime_s: 42, clone: true }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

function makeErrorFetch(status = 503) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({}),
  });
}

function makeThrowingFetch(msg = 'network failure') {
  return vi.fn().mockRejectedValue(new Error(msg));
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ModalKeepalive', () => {
  let ka: ModalKeepalive;

  beforeEach(() => {
    vi.useFakeTimers();
    // Default: fetch succeeds
    vi.stubGlobal('fetch', makeOkFetch());
    ka = new ModalKeepalive({ endpoint: 'http://modal.test' });
  });

  afterEach(() => {
    ka.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── touch() ─────────────────────────────────────────────────────────────────

  describe('touch()', () => {
    it('starts the ping interval timer', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      ka.touch();
      expect(setIntervalSpy).toHaveBeenCalledOnce();
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), PING_INTERVAL_MS);
    });

    it('does not create a second timer on repeated touch()', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      ka.touch();
      ka.touch();
      ka.touch();
      expect(setIntervalSpy).toHaveBeenCalledOnce();
    });

    it('is idempotent — calling 10 times creates exactly 1 interval', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      for (let i = 0; i < 10; i++) ka.touch();
      expect(setIntervalSpy).toHaveBeenCalledOnce();
    });

    it('updates lastTouchAt on every call', () => {
      vi.setSystemTime(1_000_000);
      ka.touch();
      // Advance time then touch again; second touch must update the idle clock
      vi.setSystemTime(2_000_000);
      ka.touch();
      // After 2nd touch, advancing < IDLE_STOP_MS should NOT auto-stop
      vi.advanceTimersByTime(PING_INTERVAL_MS);
      // fetch still running — keepalive is alive
      expect(fetch).toHaveBeenCalledWith(
        'http://modal.test/health',
        expect.objectContaining({ signal: expect.anything() }),
      );
    });
  });

  // ── stop() ──────────────────────────────────────────────────────────────────

  describe('stop()', () => {
    it('clears the interval timer', () => {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      ka.touch();
      ka.stop();
      expect(clearIntervalSpy).toHaveBeenCalledOnce();
    });

    it('is idempotent — calling stop() twice does not throw', () => {
      ka.touch();
      expect(() => { ka.stop(); ka.stop(); }).not.toThrow();
    });

    it('stop() before touch() does nothing', () => {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      ka.stop();
      expect(clearIntervalSpy).not.toHaveBeenCalled();
    });

    it('prevents further pings after stop()', async () => {
      ka.touch();
      ka.stop();
      // Advance past one ping interval
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + 100);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  // ── tick() — ping behaviour ─────────────────────────────────────────────────

  describe('tick() — ping', () => {
    it('pings the /health endpoint after one interval', async () => {
      ka.touch();
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      expect(fetch).toHaveBeenCalledWith(
        'http://modal.test/health',
        expect.objectContaining({ signal: expect.anything() }),
      );
    });

    it('pings 3 times across 3 intervals', async () => {
      ka.touch();
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 3);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('uses custom pingTimeoutMs for AbortSignal', async () => {
      const abortSpy = vi.spyOn(AbortSignal, 'timeout');
      const kaCustom = new ModalKeepalive({ endpoint: 'http://modal.test', pingTimeoutMs: 5_000 });
      kaCustom.touch();
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      expect(abortSpy).toHaveBeenCalledWith(5_000);
      kaCustom.stop();
    });

    it('uses default 30s timeout when pingTimeoutMs not set', async () => {
      const abortSpy = vi.spyOn(AbortSignal, 'timeout');
      ka.touch();
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      expect(abortSpy).toHaveBeenCalledWith(30_000);
    });

    it('handles non-ok HTTP response without throwing', async () => {
      vi.stubGlobal('fetch', makeErrorFetch(503));
      ka.touch();
      await expect(vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)).resolves.not.toThrow();
    });

    it('handles fetch network error without throwing', async () => {
      vi.stubGlobal('fetch', makeThrowingFetch());
      ka.touch();
      await expect(vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)).resolves.not.toThrow();
    });

    it('continues pinging after a transient error', async () => {
      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('transient');
        return { ok: true, status: 200, json: () => Promise.resolve({ uptime_s: 10, clone: false }) };
      });
      vi.stubGlobal('fetch', fetchMock);

      ka.touch();
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── tick() — idle auto-stop ──────────────────────────────────────────────────
  // IDLE_STOP_MS = 20min, PING_INTERVAL_MS = 4min.
  // The timer fires every 4 min and checks: Date.now() - lastTouchAt > 20min.
  // It takes 6 intervals (24 min) to exceed the threshold.

  describe('tick() — idle auto-stop', () => {
    it('auto-stops after 6 intervals (24 min idle) with no further touch()', async () => {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      ka.touch(); // lastTouchAt = T0

      // Advance 6 ping intervals. The 6th tick fires at T0 + 6*PING_INTERVAL_MS
      // = T0 + 24min, and 24min > IDLE_STOP_MS (20min), so it auto-stops.
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 6);

      expect(clearIntervalSpy).toHaveBeenCalledOnce();
    });

    it('does not auto-stop within 5 intervals (20 min exactly, boundary)', async () => {
      // At exactly 5 intervals: diff = 20min = IDLE_STOP_MS, check is >, so NOT stopped.
      ka.touch();
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 5);
      // Keepalive still alive — fetch was called 5 times
      expect(fetch).toHaveBeenCalledTimes(5);
    });

    it('does not auto-stop after one interval (4 min << 20 min idle threshold)', async () => {
      ka.touch();
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      // Keepalive alive — fetch was called once
      expect(fetch).toHaveBeenCalledOnce();
    });

    it('restarts after stop() + touch() cycle', async () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      ka.touch();  // start #1
      ka.stop();   // stop
      ka.touch();  // start #2

      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledOnce();
    });
  });
});
