/**
 * Silero VAD v5 frame classifier (Silero Team 2021, "Silero VAD: pre-trained enterprise-grade Voice Activity Detector",
 * github.com/snakers4/silero-vad, no DOI). 16 kHz, 512-sample frames plus the 64-sample context of the previous frame,
 * LSTM state `[2, 1, 128]` carried between frames.
 *
 * The ONNX runtime is injected (onnxruntime-web in the browser, onnxruntime-node in tests/benches): the SDK carries no
 * runtime dependency, and the consumer's bundler decides where the WASM file is served from.
 */
import type { VoiceFrameClassifier } from './voice-activity';

export const SILERO_SAMPLE_RATE = 16_000;
export const SILERO_FRAME_SAMPLES = 512;
const CONTEXT_SAMPLES = 64;
const STATE_SIZE = 2 * 128;

/** Minimal tensor surface used here (structurally compatible with `onnxruntime-common`'s `Tensor`). */
export interface OnnxTensor {
  readonly data: unknown;
}

/** Minimal session surface used here (structurally compatible with `onnxruntime-common`'s `InferenceSession`). */
export interface OnnxSession {
  run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor | undefined>>;
}

/** The part of an onnxruntime module the classifier needs (`onnxruntime-web`, `onnxruntime-node`). */
export interface OnnxRuntime {
  InferenceSession: { create(model: Uint8Array, options?: unknown): Promise<OnnxSession> };
  Tensor: new (type: 'float32' | 'int64', data: Float32Array | BigInt64Array, dims: readonly number[]) => OnnxTensor;
}

/** An onnxruntime-web module (`import('onnxruntime-web/wasm')`): the runtime plus its WASM settings. */
export interface OnnxWasmRuntime extends OnnxRuntime {
  env: { wasm: { numThreads?: number; wasmPaths?: unknown } };
}

/**
 * URL of the Silero v5 model shipped with this package (`silero_vad.onnx`, ~2.3 MB). Bundlers that understand
 * `new URL(..., import.meta.url)` (Vite, webpack 5, esbuild with a loader) emit it as an asset.
 */
export function sileroModelUrl(): string {
  return new URL('./silero_vad.onnx', import.meta.url).href;
}

export async function fetchSileroModel(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

/** One classifier with its own LSTM state over the given model bytes. */
export async function createSileroVad(ort: OnnxRuntime, model: Uint8Array): Promise<VoiceFrameClassifier> {
  const session = await ort.InferenceSession.create(model);
  const sampleRate = new ort.Tensor('int64', BigInt64Array.from([BigInt(SILERO_SAMPLE_RATE)]), []);
  let state = new Float32Array(STATE_SIZE);
  let context = new Float32Array(CONTEXT_SAMPLES);
  return {
    async probability(frame) {
      const input = new Float32Array(CONTEXT_SAMPLES + frame.length);
      input.set(context);
      input.set(frame, CONTEXT_SAMPLES);
      const out = await session.run({
        input: new ort.Tensor('float32', input, [1, input.length]),
        state: new ort.Tensor('float32', state, [2, 1, 128]),
        sr: sampleRate,
      });
      state = new Float32Array(out.stateN!.data as Float32Array);
      context = frame.slice(frame.length - CONTEXT_SAMPLES);
      return (out.output!.data as Float32Array)[0]!;
    },
    reset() {
      state = new Float32Array(STATE_SIZE);
      context = new Float32Array(CONTEXT_SAMPLES);
    },
  };
}

/** Configures onnxruntime-web the way the detector runs it: one WASM thread, the given `.wasm` URL. */
export function configureOnnxWasm(ort: OnnxWasmRuntime, wasmUrl: string): void {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { wasm: wasmUrl };
}
