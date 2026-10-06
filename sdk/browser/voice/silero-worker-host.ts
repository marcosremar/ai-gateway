/**
 * The Silero worker's body. On the main thread, ORT-WASM scoring of one 32 ms frame at a time opened 100–260 ms gaps
 * between game frames on a Mali-G610 cloud phone while the learner spoke (parle profile, 30/09/2026): the microphone
 * frame queue was scored as a microtask chain that never yielded to `requestAnimationFrame`. Here the same work runs
 * off it; the main thread only exchanges 2 KB messages.
 *
 * One chain serialises everything: single-threaded ORT (`numThreads = 1`) does not run two sessions at once, and each
 * classifier's frame → reset order is arrival order.
 *
 * The consumer's worker entry is three lines (the SDK carries no ORT dependency, the bundler resolves it there):
 *
 *   import * as ort from 'onnxruntime-web/wasm';
 *   import { serveSileroWorker } from '@parle/ai-gateway/voice';
 *   serveSileroWorker(self, ort);
 */
import { configureOnnxWasm, createSileroVad, fetchSileroModel, type OnnxWasmRuntime } from './silero';
import type { VoiceFrameClassifier } from './voice-activity';
import type { SileroWorkerReply, SileroWorkerRequest } from './silero-worker-protocol';

/** The worker global scope, as far as the host uses it. */
export interface SileroWorkerScope {
  onmessage: ((event: MessageEvent<SileroWorkerRequest>) => void) | null;
  postMessage(message: SileroWorkerReply): void;
}

export function serveSileroWorker(scope: SileroWorkerScope, ort: OnnxWasmRuntime): void {
  let model: Uint8Array | null = null;
  const classifiers = new Map<number, VoiceFrameClassifier>();
  let chain: Promise<unknown> = Promise.resolve();
  const reply = (message: SileroWorkerReply): void => scope.postMessage(message);

  const init = async (modelUrl: string, wasmUrl: string): Promise<void> => {
    const startedAt = performance.now();
    try {
      configureOnnxWasm(ort, wasmUrl);
      model = await fetchSileroModel(modelUrl);
      reply({ kind: 'ready', loadMs: Math.round(performance.now() - startedAt) });
    } catch (error) {
      reply({ kind: 'failed', error: String(error) });
    }
  };

  const handle = async (message: SileroWorkerRequest): Promise<void> => {
    if (message.kind === 'init') return init(message.modelUrl, message.wasmUrl);
    if (message.kind === 'open') {
      try {
        if (!model) throw new Error('silero.notReady');
        classifiers.set(message.id, await createSileroVad(ort, model));
        reply({ kind: 'opened', id: message.id });
      } catch (error) {
        reply({ kind: 'openFailed', id: message.id, error: String(error) });
      }
      return;
    }
    if (message.kind === 'reset') {
      classifiers.get(message.id)?.reset();
      return;
    }
    const classifier = classifiers.get(message.id);
    if (!classifier) {
      reply({ kind: 'frameFailed', seq: message.seq, error: `silero.unknownClassifier ${message.id}` });
      return;
    }
    try {
      reply({ kind: 'probability', seq: message.seq, value: await classifier.probability(message.frame) });
    } catch (error) {
      reply({ kind: 'frameFailed', seq: message.seq, error: String(error) });
    }
  };

  scope.onmessage = (event) => {
    const message = event.data;
    chain = chain.then(() => handle(message), () => handle(message));
  };
}
