import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runShadowStage } from '../../src/gateway/pipeline/shadow-mode';
import type { ShadowRunDeps } from '../../src/gateway/pipeline/shadow-mode';

function makeDeps(): { [K in keyof ShadowRunDeps]: ReturnType<typeof vi.fn> } & ShadowRunDeps {
  return {
    recordGpuLatency: vi.fn(),
    recordPerStageLatency: vi.fn(),
    recordShadowRun: vi.fn(),
    markGpuProductionReady: vi.fn(),
  };
}

/** Flush microtask queue so fire-and-forget .then()/.catch() chains complete. */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe('runShadowStage — fire-and-forget shadow mode runner', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  // ── Return value ──────────────────────────────────────────────────────────

  it('returns void immediately (does not return a promise)', () => {
    const result = runShadowStage('stt', 'http://gpu', 1000, () => Promise.resolve('ok'), deps);
    expect(result).toBeUndefined();
  });

  // ── Success path ──────────────────────────────────────────────────────────

  it('calls recordGpuLatency with measured ms on success', async () => {
    runShadowStage('stt', 'http://gpu', 1000, () => Promise.resolve('ok'), deps);
    await flushAsync();
    expect(deps.recordGpuLatency).toHaveBeenCalledTimes(1);
    const ms = deps.recordGpuLatency.mock.calls[0][0] as number;
    expect(typeof ms).toBe('number');
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it('calls recordPerStageLatency with the correct stage on success', async () => {
    runShadowStage('llm', 'http://gpu', 500, () => Promise.resolve(), deps);
    await flushAsync();
    expect(deps.recordPerStageLatency).toHaveBeenCalledTimes(1);
    expect(deps.recordPerStageLatency.mock.calls[0][0]).toBe('llm');
  });

  it('calls recordPerStageLatency with tts stage', async () => {
    runShadowStage('tts', 'http://gpu', 800, () => Promise.resolve(), deps);
    await flushAsync();
    expect(deps.recordPerStageLatency.mock.calls[0][0]).toBe('tts');
  });

  it('calls recordShadowRun with measured ms and targetMs on success', async () => {
    const TARGET = 1234;
    runShadowStage('stt', 'http://gpu', TARGET, () => Promise.resolve(), deps);
    await flushAsync();
    expect(deps.recordShadowRun).toHaveBeenCalledTimes(1);
    const [callMs, callTarget] = deps.recordShadowRun.mock.calls[0] as [number, number, () => void];
    expect(typeof callMs).toBe('number');
    expect(callTarget).toBe(TARGET);
  });

  it('passes an onPromote callback that calls markGpuProductionReady with the endpoint', async () => {
    const ENDPOINT = 'http://my-gpu:8000';
    runShadowStage('stt', ENDPOINT, 1000, () => Promise.resolve(), deps);
    await flushAsync();
    expect(deps.recordShadowRun).toHaveBeenCalledTimes(1);
    const onPromote = deps.recordShadowRun.mock.calls[0][2] as () => void;
    expect(typeof onPromote).toBe('function');
    // markGpuProductionReady not called yet (recordShadowRun decides when to promote)
    expect(deps.markGpuProductionReady).not.toHaveBeenCalled();
    // invoking onPromote calls markGpuProductionReady with the correct endpoint
    onPromote();
    expect(deps.markGpuProductionReady).toHaveBeenCalledOnce();
    expect(deps.markGpuProductionReady).toHaveBeenCalledWith(ENDPOINT);
  });

  it('calls all three dep functions in order on success', async () => {
    const callOrder: string[] = [];
    deps.recordGpuLatency.mockImplementation(() => callOrder.push('recordGpuLatency'));
    deps.recordPerStageLatency.mockImplementation(() => callOrder.push('recordPerStageLatency'));
    deps.recordShadowRun.mockImplementation(() => callOrder.push('recordShadowRun'));

    runShadowStage('stt', 'http://gpu', 1000, () => Promise.resolve(), deps);
    await flushAsync();
    expect(callOrder).toEqual(['recordGpuLatency', 'recordPerStageLatency', 'recordShadowRun']);
  });

  // ── Error isolation ───────────────────────────────────────────────────────

  it('does NOT call any dep when call() rejects', async () => {
    runShadowStage('stt', 'http://gpu', 1000, () => Promise.reject(new Error('GPU timeout')), deps);
    await flushAsync();
    expect(deps.recordGpuLatency).not.toHaveBeenCalled();
    expect(deps.recordPerStageLatency).not.toHaveBeenCalled();
    expect(deps.recordShadowRun).not.toHaveBeenCalled();
  });

  it('does NOT throw when call() rejects (error is swallowed)', async () => {
    await expect(async () => {
      runShadowStage('llm', 'http://gpu', 500, () => Promise.reject(new Error('failure')), deps);
      await flushAsync();
    }).not.toThrow();
  });

  it('does NOT throw when call() rejects with a non-Error value', async () => {
    await expect(async () => {
      runShadowStage('tts', 'http://gpu', 500, () => Promise.reject('string error'), deps);
      await flushAsync();
    }).not.toThrow();
  });

  // ── Stage variants ────────────────────────────────────────────────────────

  it('correctly passes stt stage to recordPerStageLatency', async () => {
    runShadowStage('stt', 'http://gpu', 1000, () => Promise.resolve(), deps);
    await flushAsync();
    expect(deps.recordPerStageLatency).toHaveBeenCalledWith('stt', expect.any(Number));
  });

  it('correctly passes llm stage to recordPerStageLatency', async () => {
    runShadowStage('llm', 'http://gpu', 1000, () => Promise.resolve(), deps);
    await flushAsync();
    expect(deps.recordPerStageLatency).toHaveBeenCalledWith('llm', expect.any(Number));
  });

  it('correctly passes tts stage to recordPerStageLatency', async () => {
    runShadowStage('tts', 'http://gpu', 1000, () => Promise.resolve(), deps);
    await flushAsync();
    expect(deps.recordPerStageLatency).toHaveBeenCalledWith('tts', expect.any(Number));
  });

  // ── Endpoint threading ────────────────────────────────────────────────────

  it('threads endpoint correctly through onPromote for each distinct endpoint', async () => {
    const ep1 = 'http://gpu-1:8000';
    const ep2 = 'http://gpu-2:9000';

    // Run two shadow stages with different endpoints
    let promote1: (() => void) | null = null;
    let promote2: (() => void) | null = null;
    const deps1 = makeDeps();
    deps1.recordShadowRun.mockImplementation((_ms, _t, cb: () => void) => { promote1 = cb; });
    const deps2 = makeDeps();
    deps2.recordShadowRun.mockImplementation((_ms, _t, cb: () => void) => { promote2 = cb; });

    runShadowStage('stt', ep1, 1000, () => Promise.resolve(), deps1);
    runShadowStage('stt', ep2, 1000, () => Promise.resolve(), deps2);
    await flushAsync();

    promote1?.();
    expect(deps1.markGpuProductionReady).toHaveBeenCalledWith(ep1);
    expect(deps1.markGpuProductionReady).not.toHaveBeenCalledWith(ep2);

    promote2?.();
    expect(deps2.markGpuProductionReady).toHaveBeenCalledWith(ep2);
    expect(deps2.markGpuProductionReady).not.toHaveBeenCalledWith(ep1);
  });

  // ── Concurrency: multiple shadow runs don't interfere ────────────────────

  it('runs multiple concurrent shadow stages independently', async () => {
    const results: string[] = [];
    const deps1 = { ...makeDeps(), recordGpuLatency: vi.fn(() => results.push('dep1')) };
    const deps2 = { ...makeDeps(), recordGpuLatency: vi.fn(() => results.push('dep2')) };

    runShadowStage('stt', 'http://gpu', 1000, () => Promise.resolve(), deps1);
    runShadowStage('llm', 'http://gpu', 500, () => Promise.resolve(), deps2);
    await flushAsync();

    expect(results).toContain('dep1');
    expect(results).toContain('dep2');
    expect(results).toHaveLength(2);
  });

  // ── Latency measurement ───────────────────────────────────────────────────

  it('measures non-negative latency for an async call', async () => {
    const DELAY = 20; // ms
    const slowCall = () => new Promise<void>((r) => setTimeout(r, DELAY));
    runShadowStage('stt', 'http://gpu', 1000, slowCall, deps);
    // Wait long enough for the delayed call to complete
    await new Promise((r) => setTimeout(r, DELAY + 50));
    expect(deps.recordGpuLatency).toHaveBeenCalledTimes(1);
    const ms = deps.recordGpuLatency.mock.calls[0][0] as number;
    // Timers may fire up to ~1 ms early against Date.now() rounding (CI flake on PR #47: 19 ≥ 20 failed).
    expect(ms).toBeGreaterThanOrEqual(DELAY - 2);
  });

  it('passes the same latency value to recordGpuLatency and recordPerStageLatency', async () => {
    runShadowStage('stt', 'http://gpu', 1000, () => Promise.resolve(), deps);
    await flushAsync();
    const latencyFromGpu = deps.recordGpuLatency.mock.calls[0][0] as number;
    const latencyFromStage = deps.recordPerStageLatency.mock.calls[0][1] as number;
    expect(latencyFromGpu).toBe(latencyFromStage);
  });
});
