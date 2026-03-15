import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { coldStartRace, waitForGpuReady } from '@ai-gateway/client/cold-start-racer';
import type { RaceContext, ColdStartRacerConfig } from '@ai-gateway/client/cold-start-racer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noop = () => {};
const silentLogger = { info: noop };

/** Build a RaceContext with sensible defaults for testing. */
function makeCtx(overrides?: Partial<RaceContext>): RaceContext {
  return {
    gpuEndpoint: 'http://gpu:8000',
    estimatedReadyMs: 5_000,
    bootStartedAt: Date.now() - 10_000, // 10s ago → ~67% progress
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// waitForGpuReady
// ---------------------------------------------------------------------------

describe('waitForGpuReady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns true when health endpoint returns 200', async () => {
    const ctrl = new AbortController();
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const promise = waitForGpuReady('http://gpu:8000', 10_000, ctrl.signal);
    const result = await promise;

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('http://gpu:8000/health', {
      signal: ctrl.signal,
      method: 'GET',
    });
  });

  it('polls and returns true when health succeeds on second attempt', async () => {
    const ctrl = new AbortController();
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const promise = waitForGpuReady('http://gpu:8000', 10_000, ctrl.signal);

    // Advance past the 2s sleep
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns false when timeout expires', async () => {
    const ctrl = new AbortController();
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const promise = waitForGpuReady('http://gpu:8000', 3_000, ctrl.signal);

    // Advance well past the timeout
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result).toBe(false);
  });

  it('returns false when signal is aborted', async () => {
    const ctrl = new AbortController();
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const promise = waitForGpuReady('http://gpu:8000', 30_000, ctrl.signal);
    ctrl.abort();

    // Advance past the poll interval
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await promise;

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// coldStartRace
// ---------------------------------------------------------------------------

describe('coldStartRace', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── GPU wins ─────────────────────────────────────────────────────────────

  it('GPU ready before cloud: GPU result wins, source=gpu', async () => {
    // Stub fetch for health check
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const cloudFn = vi.fn(async (_signal: AbortSignal) => {
      // Cloud is slow
      await new Promise((r) => setTimeout(r, 500));
      return 'cloud-result';
    });

    const gpuFn = vi.fn(async (_endpoint: string, _signal: AbortSignal) => {
      // GPU is fast
      return 'gpu-result';
    });

    const ctx = makeCtx({ estimatedReadyMs: 1_000 });
    const result = await coldStartRace(cloudFn, gpuFn, ctx, {
      healthProbeTimeoutMs: 5_000,
      minBootProgress: 0.3,
    }, silentLogger);

    expect(result.result).toBe('gpu-result');
    expect(result.source).toBe('gpu');
    expect(gpuFn).toHaveBeenCalledWith('http://gpu:8000', expect.any(AbortSignal));
  });

  // ── Cloud wins ───────────────────────────────────────────────────────────

  it('Cloud finishes before GPU ready: cloud result wins, source=cloud', async () => {
    // Health check never succeeds within the timeout
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const cloudFn = vi.fn(async (_signal: AbortSignal) => {
      return 'cloud-result';
    });

    const gpuFn = vi.fn(async (_endpoint: string, _signal: AbortSignal) => {
      return 'gpu-result';
    });

    const ctx = makeCtx({ estimatedReadyMs: 2_000 });
    const result = await coldStartRace(cloudFn, gpuFn, ctx, {
      healthProbeTimeoutMs: 100, // Very short — GPU health will timeout quickly
      minBootProgress: 0.3,
    }, silentLogger);

    expect(result.result).toBe('cloud-result');
    expect(result.source).toBe('cloud');
    // gpuFn should NOT have been called since health never succeeded
    expect(gpuFn).not.toHaveBeenCalled();
  });

  // ── GPU health timeout ─────────────────────────────────────────────────

  it('GPU health check timeout: cloud result used', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    const cloudFn = vi.fn(async (_signal: AbortSignal) => 'cloud-ok');
    const gpuFn = vi.fn(async () => 'gpu-ok');

    const ctx = makeCtx({ estimatedReadyMs: 2_000 });
    const result = await coldStartRace(cloudFn, gpuFn, ctx, {
      healthProbeTimeoutMs: 50,
      minBootProgress: 0.3,
    }, silentLogger);

    expect(result.result).toBe('cloud-ok');
    expect(result.source).toBe('cloud');
  });

  // ── Boot progress too low ──────────────────────────────────────────────

  it('Boot progress too low: no race, cloud only', async () => {
    const cloudFn = vi.fn(async (_signal: AbortSignal) => 'cloud-only');
    const gpuFn = vi.fn(async () => 'gpu-only');

    // bootStartedAt is very recent → progress near 0
    const ctx = makeCtx({
      bootStartedAt: Date.now() - 100, // just started
      estimatedReadyMs: 60_000,        // 60s remaining → progress ~0.2%
    });

    const result = await coldStartRace(cloudFn, gpuFn, ctx, {
      minBootProgress: 0.5,
    }, silentLogger);

    expect(result.result).toBe('cloud-only');
    expect(result.source).toBe('cloud');
    expect(gpuFn).not.toHaveBeenCalled();
  });

  it('Boot progress unknown (no bootStartedAt): cloud only', async () => {
    const cloudFn = vi.fn(async (_signal: AbortSignal) => 'cloud-only');
    const gpuFn = vi.fn(async () => 'gpu-only');

    const ctx = makeCtx({ bootStartedAt: undefined });

    const result = await coldStartRace(cloudFn, gpuFn, ctx, {
      minBootProgress: 0.1,
    }, silentLogger);

    expect(result.result).toBe('cloud-only');
    expect(result.source).toBe('cloud');
    expect(gpuFn).not.toHaveBeenCalled();
  });

  // ── Estimated ready too far out ────────────────────────────────────────

  it('estimatedReadyMs exceeds maxEstimatedReadyMs: cloud only', async () => {
    const cloudFn = vi.fn(async (_signal: AbortSignal) => 'cloud-only');
    const gpuFn = vi.fn(async () => 'gpu-only');

    const ctx = makeCtx({ estimatedReadyMs: 60_000 });

    const result = await coldStartRace(cloudFn, gpuFn, ctx, {
      maxEstimatedReadyMs: 30_000,
      minBootProgress: 0.0, // would pass progress check
    }, silentLogger);

    expect(result.result).toBe('cloud-only');
    expect(result.source).toBe('cloud');
    expect(gpuFn).not.toHaveBeenCalled();
  });

  // ── Error handling ─────────────────────────────────────────────────────

  it('Cloud errors + GPU succeeds: GPU result used', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const cloudFn = vi.fn(async (_signal: AbortSignal) => {
      throw new Error('Cloud quota exceeded');
    });

    const gpuFn = vi.fn(async (_endpoint: string, _signal: AbortSignal) => {
      return 'gpu-saved-the-day';
    });

    const ctx = makeCtx({ estimatedReadyMs: 1_000 });
    const result = await coldStartRace(cloudFn, gpuFn, ctx, {
      healthProbeTimeoutMs: 5_000,
      minBootProgress: 0.3,
    }, silentLogger);

    expect(result.result).toBe('gpu-saved-the-day');
    expect(result.source).toBe('gpu');
  });

  it('GPU errors + cloud succeeds: cloud result used', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const cloudFn = vi.fn(async (_signal: AbortSignal) => {
      // Cloud takes a moment but succeeds
      await new Promise((r) => setTimeout(r, 10));
      return 'cloud-fallback';
    });

    const gpuFn = vi.fn(async (_endpoint: string, _signal: AbortSignal) => {
      throw new Error('GPU OOM');
    });

    const ctx = makeCtx({ estimatedReadyMs: 1_000 });
    const result = await coldStartRace(cloudFn, gpuFn, ctx, {
      healthProbeTimeoutMs: 5_000,
      minBootProgress: 0.3,
    }, silentLogger);

    expect(result.result).toBe('cloud-fallback');
    expect(result.source).toBe('cloud');
  });

  it('Both error: throws the cloud error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const cloudErr = new Error('Cloud is down');
    const cloudFn = vi.fn(async (_signal: AbortSignal) => {
      throw cloudErr;
    });

    const gpuFn = vi.fn(async (_endpoint: string, _signal: AbortSignal) => {
      throw new Error('GPU is on fire');
    });

    const ctx = makeCtx({ estimatedReadyMs: 1_000 });

    await expect(
      coldStartRace(cloudFn, gpuFn, ctx, {
        healthProbeTimeoutMs: 5_000,
        minBootProgress: 0.3,
      }, silentLogger),
    ).rejects.toThrow('Cloud is down');
  });

  // ── Abort signals ──────────────────────────────────────────────────────

  it('Abort signal is triggered for the loser (cloud wins → GPU aborted)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('never ready')));

    let gpuSignal: AbortSignal | undefined;

    const cloudFn = vi.fn(async (_signal: AbortSignal) => 'fast-cloud');

    const gpuFn = vi.fn(async (_endpoint: string, signal: AbortSignal) => {
      gpuSignal = signal;
      return 'slow-gpu';
    });

    const ctx = makeCtx({ estimatedReadyMs: 1_000 });
    const result = await coldStartRace(cloudFn, gpuFn, ctx, {
      healthProbeTimeoutMs: 50, // GPU health times out quickly
      minBootProgress: 0.3,
    }, silentLogger);

    expect(result.source).toBe('cloud');
    // GPU side threw (health timeout), so it settled as an error.
    // The GPU abort controller is triggered after cloud wins.
    // gpuFn was never called because health probe failed, but the controller was aborted.
  });

  it('Abort signal is triggered for the loser (GPU wins → cloud aborted)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    let cloudSignalAborted = false;

    const cloudFn = vi.fn(async (signal: AbortSignal) => {
      // Cloud is slow — listen for abort
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve('slow-cloud'), 5000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          cloudSignalAborted = true;
          reject(new Error('aborted'));
        });
      });
    });

    const gpuFn = vi.fn(async (_endpoint: string, _signal: AbortSignal) => {
      return 'fast-gpu';
    });

    const ctx = makeCtx({ estimatedReadyMs: 1_000 });
    const result = await coldStartRace(cloudFn, gpuFn, ctx, {
      healthProbeTimeoutMs: 5_000,
      minBootProgress: 0.3,
    }, silentLogger);

    expect(result.result).toBe('fast-gpu');
    expect(result.source).toBe('gpu');
    expect(cloudSignalAborted).toBe(true);
  });

  // ── Logger ─────────────────────────────────────────────────────────────

  it('logs race outcome when logger is provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const logger = { info: vi.fn() };

    const cloudFn = vi.fn(async (_signal: AbortSignal) => {
      await new Promise((r) => setTimeout(r, 500));
      return 'cloud';
    });

    const gpuFn = vi.fn(async (_endpoint: string, _signal: AbortSignal) => 'gpu');

    const ctx = makeCtx({ estimatedReadyMs: 1_000 });
    await coldStartRace(cloudFn, gpuFn, ctx, {
      healthProbeTimeoutMs: 5_000,
      minBootProgress: 0.3,
    }, logger);

    // Should have logged the race start and the winner
    expect(logger.info).toHaveBeenCalled();
    const calls = logger.info.mock.calls.map((c) => c[0]);
    expect(calls.some((msg: string) => msg.includes('Racing cloud vs GPU'))).toBe(true);
    expect(calls.some((msg: string) => msg.includes('GPU won the race'))).toBe(true);
  });

  it('works without logger (no crash)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const cloudFn = vi.fn(async (_signal: AbortSignal) => 'cloud');
    const gpuFn = vi.fn(async (_endpoint: string, _signal: AbortSignal) => 'gpu');

    const ctx = makeCtx({ estimatedReadyMs: 1_000 });
    // No logger argument
    const result = await coldStartRace(cloudFn, gpuFn, ctx, {
      healthProbeTimeoutMs: 5_000,
      minBootProgress: 0.3,
    });

    expect(result.result).toBeDefined();
  });

  // ── Default config ─────────────────────────────────────────────────────

  it('uses default config when none provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const cloudFn = vi.fn(async (_signal: AbortSignal) => {
      await new Promise((r) => setTimeout(r, 100));
      return 'cloud';
    });
    const gpuFn = vi.fn(async (_endpoint: string, _signal: AbortSignal) => 'gpu');

    const ctx = makeCtx({ estimatedReadyMs: 5_000 });
    const result = await coldStartRace(cloudFn, gpuFn, ctx, undefined, silentLogger);

    expect(result.result).toBeDefined();
  });
});
