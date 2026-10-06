import type { VoiceFrameClassifier } from './voice-activity';
import type { SileroWorkerReply, SileroWorkerRequest } from './silero-worker-protocol';

/** Who makes Silero classifiers: the worker (default) or, without it, the main thread. */
export interface SileroBackend {
  where: 'worker' | 'main';
  create(): Promise<VoiceFrameClassifier>;
}

/** The part of `Worker` the client uses (a fake in tests). */
export interface WorkerLike {
  postMessage(message: SileroWorkerRequest): void;
  onmessage: ((event: MessageEvent<SileroWorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

/** How long the worker may take to come up (download the model) before speech falls back to the main thread. */
export const SILERO_WORKER_READY_TIMEOUT_MS = 20_000;

interface Waiter<T> {
  ok: (value: T) => void;
  fail: (error: Error) => void;
}

/**
 * Silero in a worker (`serveSileroWorker`): each `create()` opens a classifier with its own state in there and returns a
 * `VoiceFrameClassifier` that only exchanges messages. A worker that dies rejects what was pending and what comes after
 * (the caller logs it, as an ORT failure on the main thread). Rejects if the worker does not come up.
 *
 * `spawn` is the consumer's: only its bundler knows how to emit the worker entry
 * (`new Worker(new URL('./my-worker.ts', import.meta.url), { type: 'module' })`).
 */
export function loadSileroWorker(
  opts: { modelUrl: string; wasmUrl: string },
  spawn: () => WorkerLike,
  timeoutMs = SILERO_WORKER_READY_TIMEOUT_MS,
): Promise<SileroBackend> {
  return new Promise<SileroBackend>((resolve, reject) => {
    let worker: WorkerLike;
    try {
      worker = spawn();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const frames = new Map<number, Waiter<number>>();
    const opens = new Map<number, Waiter<void>>();
    let nextSeq = 1;
    let nextId = 1;
    let dead: Error | null = null;
    let ready = false;
    const die = (error: Error): void => {
      dead ??= error;
      for (const waiter of [...frames.values(), ...opens.values()]) waiter.fail(dead);
      frames.clear();
      opens.clear();
      worker.terminate();
      if (!ready) reject(dead);
    };
    const timer = setTimeout(() => { if (!ready) die(new Error('silero.workerTimeout')); }, timeoutMs);
    const classifier = (id: number): VoiceFrameClassifier => ({
      probability: (frame) => new Promise<number>((ok, fail) => {
        if (dead) return fail(dead);
        const seq = nextSeq++;
        frames.set(seq, { ok, fail });
        worker.postMessage({ kind: 'frame', id, seq, frame });
      }),
      reset: () => {
        if (!dead) worker.postMessage({ kind: 'reset', id });
      },
    });
    worker.onerror = (event) => {
      event.preventDefault?.();
      die(new Error(`silero.workerError ${event.message ?? ''}`));
    };
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.kind === 'ready') {
        ready = true;
        clearTimeout(timer);
        resolve({
          where: 'worker',
          create: () => new Promise<VoiceFrameClassifier>((ok, fail) => {
            if (dead) return fail(dead);
            const id = nextId++;
            opens.set(id, { ok: () => ok(classifier(id)), fail });
            worker.postMessage({ kind: 'open', id });
          }),
        });
        return;
      }
      if (msg.kind === 'failed') {
        clearTimeout(timer);
        die(new Error(msg.error));
        return;
      }
      if (msg.kind === 'opened' || msg.kind === 'openFailed') {
        const waiter = opens.get(msg.id);
        opens.delete(msg.id);
        if (msg.kind === 'opened') waiter?.ok();
        else waiter?.fail(new Error(msg.error));
        return;
      }
      const waiter = frames.get(msg.seq);
      frames.delete(msg.seq);
      if (msg.kind === 'probability') waiter?.ok(msg.value);
      else waiter?.fail(new Error(msg.error));
    };
    worker.postMessage({ kind: 'init', ...opts });
  });
}
