/**
 * Tests for sdk/browser/voice/silero-pool.ts — where Silero runs and how classifiers are handed out.
 *
 * Silero keeps state (LSTM + context) inside the classifier: one classifier shared by two detectors (parle: the
 * conversation's and the questionnaire's spoken item) interleaved two microphones in one state, and one's `reset()`
 * wiped the other's. Each open detector gets its own; on close it goes back to the bucket and the next detector reuses
 * it (no new ORT session at every microphone opening).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSharedSilero,
  createSileroPool,
  type OnnxWasmRuntime,
  type SileroEngine,
  type SileroPoolEvent,
  type VoiceFrameClassifier,
  type WorkerLike,
} from '../../sdk/browser/voice/index';

function engine(extra: Partial<SileroEngine> = {}) {
  const created: Array<{ resets: number }> = [];
  const ort = { env: { wasm: {} } } as unknown as OnnxWasmRuntime;
  const createClassifier = vi.fn(async (): Promise<VoiceFrameClassifier> => {
    const me = { resets: 0 };
    created.push(me);
    return { probability: async () => 0.9, reset: () => { me.resets += 1; } };
  });
  const loadOrt = vi.fn(async () => ort);
  const value: SileroEngine = { loadOrt, wasmUrl: 'https://x/ort.wasm', modelUrl: 'https://x/m.onnx', createClassifier, ...extra };
  return { engine: value, created, ort, loadOrt, createClassifier };
}

describe('Silero pool', () => {
  let fetched: string[];
  beforeEach(() => {
    fetched = [];
    vi.stubGlobal('fetch', async (url: string) => (fetched.push(url), new Response(new Uint8Array([1, 2, 3]))));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('main thread without spawnWorker: configures WASM, proves the model with a first classifier, reports ready', async () => {
    const { engine: e, ort, created } = engine();
    const events: SileroPoolEvent[] = [];
    let clock = 100;
    const pool = createSileroPool(e, { onEvent: (event) => events.push(event), now: () => (clock += 7) });
    expect(pool.ready()).toBe(false);
    const backend = await pool.load();
    expect(backend.where).toBe('main');
    expect(ort.env.wasm).toEqual({ numThreads: 1, wasmPaths: { wasm: 'https://x/ort.wasm' } });
    expect(fetched).toEqual(['https://x/m.onnx']);
    expect(pool.ready()).toBe(true);
    expect(pool.idleCount()).toBe(1);
    expect(created).toHaveLength(1);
    expect(events).toEqual([{ kind: 'ready', loadMs: 7, where: 'main' }]);
  });

  it('one classifier per open detector; a released one is reused (reset) instead of a new session', async () => {
    const { engine: e, created } = engine();
    const events: SileroPoolEvent[] = [];
    const pool = createSileroPool(e, { onEvent: (event) => events.push(event) });
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(a).not.toBe(b);
    expect(created).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'extraInstance')).toHaveLength(1);
    pool.release(b);
    expect(pool.idleCount()).toBe(1);
    const c = await pool.acquire();
    expect(c).toBe(b);
    expect(created[1]!.resets).toBeGreaterThanOrEqual(1);
    expect(created).toHaveLength(2);
    pool.release(null);
    expect(pool.idleCount()).toBe(0);
  });

  it('a worker that does not come up falls back to the main thread and says so', async () => {
    vi.stubGlobal('Worker', class {});
    const spawnWorker = (): WorkerLike => { throw new Error('no worker entry'); };
    const { engine: e } = engine({ spawnWorker });
    const events: SileroPoolEvent[] = [];
    const backend = await createSileroPool(e, { onEvent: (event) => events.push(event) }).load();
    expect(backend.where).toBe('main');
    expect(events[0]).toEqual({ kind: 'workerFallback', error: 'Error: no worker entry' });
    expect(events[1]).toMatchObject({ kind: 'ready', where: 'main' });
  });

  it('a failed load is reported and retried on the next call', async () => {
    const { engine: e, loadOrt } = engine();
    loadOrt.mockRejectedValueOnce(new Error('wasm 404'));
    const events: SileroPoolEvent[] = [];
    const pool = createSileroPool(e, { onEvent: (event) => events.push(event) });
    await expect(pool.load()).rejects.toThrow('wasm 404');
    await vi.waitFor(() => expect(events).toContainEqual({ kind: 'error', error: 'Error: wasm 404' }));
    await expect(pool.load()).resolves.toMatchObject({ where: 'main' });
  });

  it('shared classifier: one load for the page; a failed preload is forgotten so the next load retries', async () => {
    const { engine: e, loadOrt, createClassifier } = engine();
    loadOrt.mockRejectedValueOnce(new Error('offline'));
    const shared = createSharedSilero(e);
    shared.preload();
    await vi.waitFor(() => expect(loadOrt).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = await shared.load();
    expect(await shared.load()).toBe(first);
    expect(createClassifier).toHaveBeenCalledTimes(1);
  });

  it('defaults to the model shipped with the package', async () => {
    const { engine: e } = engine({ modelUrl: undefined });
    await createSileroPool(e).load();
    expect(fetched[0]).toMatch(/silero_vad\.onnx$/);
  });
});
