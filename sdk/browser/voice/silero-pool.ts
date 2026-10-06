/**
 * Where Silero runs and how classifiers are handed out.
 *
 * Silero stays on WASM, not WebGPU: a ~2 MB stateful (LSTM) model scoring one 32 ms frame at a time would pay, per
 * frame, the dispatch, the state upload and the read-back (`mapAsync`) — a fixed cost larger than the whole inference —
 * and would compete for the GPU with the page's rendering.
 *
 * With `spawnWorker`, scoring runs in a worker (`silero-worker-host.ts`); a browser without `Worker`, or a worker that
 * does not come up, falls back to the main thread. Without `spawnWorker`, the main thread is the choice.
 */
import {
  configureOnnxWasm, createSileroVad, fetchSileroModel, sileroModelUrl, type OnnxRuntime, type OnnxWasmRuntime,
} from './silero';
import type { SileroBackend, WorkerLike } from './silero-worker-client';
import type { VoiceFrameClassifier } from './voice-activity';

/** What the detector needs from the consumer's bundle to run Silero. */
export interface SileroEngine {
  /** `() => import('onnxruntime-web/wasm')` in the consumer (the SDK has no ORT dependency). */
  loadOrt: () => Promise<OnnxWasmRuntime>;
  /** URL of `ort-wasm-simd-threaded.wasm` as the consumer's bundler serves it. */
  wasmUrl: string;
  /** Model URL; defaults to the model shipped with this package (`sileroModelUrl()`). */
  modelUrl?: string;
  /** Spawns the consumer's worker entry (`serveSileroWorker`); absent = main thread only. */
  spawnWorker?: () => WorkerLike;
  /** Test seam: classifier factory over the loaded runtime and model bytes. */
  createClassifier?: (ort: OnnxRuntime, model: Uint8Array) => Promise<VoiceFrameClassifier>;
}

const modelUrlOf = (engine: SileroEngine) => engine.modelUrl ?? sileroModelUrl();

/** Silero on the main thread: load ORT, configure WASM, fetch the model; `create()` opens a classifier over it. */
export async function sileroInThread(engine: SileroEngine): Promise<SileroBackend> {
  const ort = await engine.loadOrt();
  configureOnnxWasm(ort, engine.wasmUrl);
  const model = await fetchSileroModel(modelUrlOf(engine));
  const create = engine.createClassifier ?? createSileroVad;
  return { where: 'main', create: () => create(ort, model) };
}

export type SileroPoolEvent =
  | { kind: 'workerFallback'; error: string }
  | { kind: 'ready'; loadMs: number; where: SileroBackend['where'] }
  | { kind: 'extraInstance' }
  | { kind: 'error'; error: string };

export interface SileroPoolHooks {
  /** Log sink (the consumer maps these to its own log keys). */
  onEvent?: (event: SileroPoolEvent) => void;
  /** Clock for `loadMs` (defaults to `performance.now()`). */
  now?: () => number;
}

export interface SileroPool {
  /** Loads the backend once (retried after a failure) and proves the model with a first classifier. */
  load(): Promise<SileroBackend>;
  /** Model loaded: only then is a detector's "did not arm" a Silero verdict. */
  ready(): boolean;
  /** A classifier for one detector only: an idle one (reset) or a new session over the same model. */
  acquire(): Promise<VoiceFrameClassifier>;
  /** Gives a detector's classifier back to the idle bucket. */
  release(classifier: VoiceFrameClassifier | null): void;
  /** How many classifiers sit idle (test seam). */
  idleCount(): number;
}

async function backendOf(engine: SileroEngine, onEvent: (event: SileroPoolEvent) => void): Promise<SileroBackend> {
  if (!engine.spawnWorker || typeof Worker === 'undefined') return sileroInThread(engine);
  try {
    const base = typeof location === 'undefined' ? undefined : location.href;
    /* The worker client comes down with the VAD, off the page's boot. */
    const { loadSileroWorker } = await import('./silero-worker-client');
    const opts = { modelUrl: new URL(modelUrlOf(engine), base).href, wasmUrl: new URL(engine.wasmUrl, base).href };
    return await loadSileroWorker(opts, engine.spawnWorker);
  } catch (error) {
    onEvent({ kind: 'workerFallback', error: String(error) });
    return sileroInThread(engine);
  }
}

/**
 * Idle classifiers, one per detector that closed. Silero keeps state (LSTM + 64-sample context) inside the classifier:
 * two detectors on one classifier would interleave two microphones' frames in one state, and one's `reset()` would wipe
 * the other's. Each open detector gets its own; on close it goes back to the bucket (an ORT session cannot be freed
 * through the interface, so reusing it keeps the WASM heap from growing at every microphone opening).
 */
export function createSileroPool(engine: SileroEngine, hooks: SileroPoolHooks = {}): SileroPool {
  const onEvent = hooks.onEvent ?? (() => {});
  const now = hooks.now ?? (() => performance.now());
  const idle: VoiceFrameClassifier[] = [];
  let loading: Promise<SileroBackend> | null = null;
  let ready = false;

  const load = (): Promise<SileroBackend> => {
    loading ??= (async () => {
      const startedAt = now();
      const backend = await backendOf(engine, onEvent);
      /* The first session proves the model (and warms WASM) before a detector receives it. */
      idle.push(await backend.create());
      ready = true;
      onEvent({ kind: 'ready', loadMs: Math.round(now() - startedAt), where: backend.where });
      return backend;
    })();
    loading.catch((error) => {
      loading = null;
      onEvent({ kind: 'error', error: String(error) });
    });
    return loading;
  };

  return {
    load,
    ready: () => ready,
    async acquire() {
      const backend = await load();
      const reused = idle.pop();
      if (reused) {
        reused.reset();
        return reused;
      }
      onEvent({ kind: 'extraInstance' });
      return backend.create();
    },
    release(classifier) {
      if (classifier) idle.push(classifier);
    },
    idleCount: () => idle.length,
  };
}

/**
 * One classifier shared by every listener of a page, on the main thread (the student page's detector: one microphone,
 * one listener at a time). `load()` caches; `preload()` starts it early and forgets a failed load so the next
 * `load()` retries.
 */
export function createSharedSilero(engine: SileroEngine): { load(): Promise<VoiceFrameClassifier>; preload(): void } {
  let loading: Promise<VoiceFrameClassifier> | null = null;
  const load = () => {
    loading ??= sileroInThread(engine).then((backend) => backend.create());
    return loading;
  };
  return { load, preload: () => void load().catch(() => { loading = null; }) };
}
