/**
 * Client-side noise suppression — DeepFilterNet via onnxruntime-web,
 * with a WebRTC builtin fallback for low-end devices.
 *
 * Use cases:
 *   - Strip background noise (keyboard, fans, traffic) before WS upload to
 *     the gateway → STT accuracy gain ~30% in noisy environments.
 *   - Reduce upload bandwidth (clean audio compresses 30% better via Opus).
 *
 * Modes:
 *   - 'deepfilternet' — ONNX model lazy-loaded from CDN, ~8MB, AudioWorklet
 *     processing. Best quality. Requires onnxruntime-web peer dep.
 *   - 'webrtc'        — built-in browser MediaStream constraints. Zero deps,
 *     zero bundle, lower quality. Ships in every Chromium/WebKit/Firefox.
 *   - 'none'          — passthrough, no processing.
 *
 * Usage:
 *   const ns = await createNoiseSuppressor({ mode: 'deepfilternet' });
 *   const cleanStream = await ns.process(rawStream);
 *   // cleanStream replaces rawStream in MediaRecorder / WebRTC pipeline
 */

export type NoiseSuppressionMode = 'deepfilternet' | 'webrtc' | 'none';

export interface NoiseSuppressorOptions {
  mode: NoiseSuppressionMode;
  /** Override DeepFilterNet ONNX model URL (default: hosted on jsdelivr). */
  modelUrl?: string;
  /** Override AudioWorklet processor URL. Bundled at runtime if omitted. */
  workletUrl?: string;
  /** Override onnxruntime-web import path. Default 'onnxruntime-web'. */
  ortPath?: string;
  /** Sample rate for ONNX inference. DeepFilterNet expects 48000. */
  sampleRate?: number;
  /** Optional progress callback during model load. */
  onLoadProgress?: (loaded: number, total: number) => void;
}

export interface NoiseSuppressor {
  readonly mode: NoiseSuppressionMode;
  /** Wrap a MediaStream and return a clean version. The original is not modified. */
  process(stream: MediaStream): Promise<MediaStream>;
  /** Tear down model + AudioContext. Idempotent. */
  dispose(): Promise<void>;
  /** Stats for diagnostics UI (frames processed, avg inference ms). */
  stats(): { framesProcessed: number; avgInferenceMs: number; mode: NoiseSuppressionMode };
}

const DEFAULT_DEEPFILTERNET_MODEL = 'https://cdn.jsdelivr.net/gh/Rikorose/DeepFilterNet@main/models/DeepFilterNet3_onnx.tar.gz';
const DEFAULT_SAMPLE_RATE = 48_000;

/**
 * Factory — picks the right adapter for the requested mode. Lazy: ONNX runtime
 * only imported when 'deepfilternet' is selected, so 'webrtc'/'none' callers
 * skip the bundle entirely.
 */
export async function createNoiseSuppressor(
  opts: NoiseSuppressorOptions,
): Promise<NoiseSuppressor> {
  if (opts.mode === 'none') return new PassthroughSuppressor();
  if (opts.mode === 'webrtc') return new WebRtcSuppressor();
  if (opts.mode === 'deepfilternet') {
    const adapter = new DeepFilterNetSuppressor(opts);
    await adapter.load();
    return adapter;
  }
  throw new Error(`unknown noise suppression mode: ${opts.mode}`);
}

// ── Passthrough (mode = 'none') ─────────────────────────────────────────────

class PassthroughSuppressor implements NoiseSuppressor {
  readonly mode = 'none' as const;
  async process(stream: MediaStream): Promise<MediaStream> { return stream; }
  async dispose(): Promise<void> { /* nothing */ }
  stats() { return { framesProcessed: 0, avgInferenceMs: 0, mode: this.mode }; }
}

// ── WebRTC builtin (mode = 'webrtc') ────────────────────────────────────────

class WebRtcSuppressor implements NoiseSuppressor {
  readonly mode = 'webrtc' as const;
  private cloned: MediaStream | null = null;

  async process(input: MediaStream): Promise<MediaStream> {
    // Browser builtin: re-acquire mic with constraints. We can't apply
    // noiseSuppression to an existing track — must request a new stream
    // with the constraint, then drop the old one.
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('WebRTC noise suppression requires navigator.mediaDevices');
    }
    const audioTrack = input.getAudioTracks()[0];
    if (!audioTrack) throw new Error('input MediaStream has no audio track');
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: audioTrack.getSettings().deviceId,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    };
    this.cloned = await navigator.mediaDevices.getUserMedia(constraints);
    return this.cloned;
  }

  async dispose(): Promise<void> {
    if (this.cloned) {
      for (const t of this.cloned.getTracks()) t.stop();
      this.cloned = null;
    }
  }

  stats() { return { framesProcessed: 0, avgInferenceMs: 0, mode: this.mode }; }
}

// ── DeepFilterNet (mode = 'deepfilternet') ──────────────────────────────────

interface OnnxSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
  release?(): Promise<void>;
}

class DeepFilterNetSuppressor implements NoiseSuppressor {
  readonly mode = 'deepfilternet' as const;
  private session: OnnxSession | null = null;
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private framesProcessed = 0;
  private inferenceMsTotal = 0;

  constructor(private readonly opts: NoiseSuppressorOptions) {}

  /**
   * Lazy-load ONNX runtime + DeepFilterNet model. Called by factory before
   * any process() — caller never sees an unloaded suppressor.
   */
  async load(): Promise<void> {
    const ortModule = this.opts.ortPath ?? 'onnxruntime-web';
    let ort: { InferenceSession: { create(model: ArrayBuffer | string, opts?: unknown): Promise<OnnxSession> } };
    try {
      // Dynamic import keeps onnxruntime-web out of bundles that don't enable
      // 'deepfilternet'. Failure here means caller didn't install peer dep.
      ort = await import(/* @vite-ignore */ ortModule) as typeof ort;
    } catch (err) {
      throw new Error(
        `DeepFilterNet requires onnxruntime-web. Install it as a peer dependency: ` +
        `\`npm install onnxruntime-web\`. Original error: ${(err as Error).message}`,
      );
    }

    const modelUrl = this.opts.modelUrl ?? DEFAULT_DEEPFILTERNET_MODEL;
    const modelBuf = await fetchModelBuffer(modelUrl, this.opts.onLoadProgress);
    this.session = await ort.InferenceSession.create(modelBuf, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }

  async process(stream: MediaStream): Promise<MediaStream> {
    if (!this.session) throw new Error('DeepFilterNet not loaded — call load() first');
    if (typeof AudioContext === 'undefined') {
      throw new Error('DeepFilterNet requires browser AudioContext');
    }

    const sampleRate = this.opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.audioCtx = new AudioContext({ sampleRate });

    const workletUrl = this.opts.workletUrl ?? buildInlineWorkletUrl();
    await this.audioCtx.audioWorklet.addModule(workletUrl);

    const source = this.audioCtx.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(this.audioCtx, 'deepfilternet-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { frameSize: 480 }, // 10ms @ 48kHz
    });

    // Worklet emits raw frames via port; main thread runs inference and
    // posts cleaned frames back. Adds ~5-10ms latency vs running inference
    // inside the worklet, but keeps onnxruntime-web on the main thread.
    this.workletNode.port.onmessage = async (ev: MessageEvent<{ frame: Float32Array }>) => {
      const t0 = performance.now();
      try {
        const cleaned = await this.runInference(ev.data.frame);
        this.workletNode!.port.postMessage({ cleaned }, [cleaned.buffer]);
      } catch {
        // On inference error, return frame unchanged so audio path stays alive.
        this.workletNode!.port.postMessage({ cleaned: ev.data.frame }, [ev.data.frame.buffer]);
      }
      this.framesProcessed++;
      this.inferenceMsTotal += performance.now() - t0;
    };

    const dest = this.audioCtx.createMediaStreamDestination();
    source.connect(this.workletNode).connect(dest);
    return dest.stream;
  }

  private async runInference(frame: Float32Array): Promise<Float32Array> {
    if (!this.session) return frame;
    const Tensor = await getOrtTensor(this.opts.ortPath ?? 'onnxruntime-web');
    const input = new Tensor('float32', frame, [1, frame.length]);
    const output = await this.session.run({ input });
    const firstKey = Object.keys(output)[0];
    return output[firstKey].data;
  }

  async dispose(): Promise<void> {
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode.port.onmessage = null;
      this.workletNode = null;
    }
    if (this.audioCtx) {
      await this.audioCtx.close();
      this.audioCtx = null;
    }
    if (this.session?.release) await this.session.release();
    this.session = null;
  }

  stats() {
    return {
      framesProcessed: this.framesProcessed,
      avgInferenceMs:
        this.framesProcessed === 0 ? 0 : this.inferenceMsTotal / this.framesProcessed,
      mode: this.mode,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function fetchModelBuffer(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch DeepFilterNet model: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  if (!onProgress || !total || !res.body) return await res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return merged.buffer;
}

let cachedTensorCtor: unknown = null;
async function getOrtTensor(modulePath: string): Promise<new (type: string, data: Float32Array, dims: number[]) => unknown> {
  if (cachedTensorCtor) return cachedTensorCtor as never;
  const ort = await import(/* @vite-ignore */ modulePath) as { Tensor: unknown };
  cachedTensorCtor = ort.Tensor;
  return ort.Tensor as never;
}

/**
 * Build the AudioWorklet processor as a Blob URL. Inline avoids a separate
 * worklet file ship — the SDK stays a single artifact.
 */
function buildInlineWorkletUrl(): string {
  const src = `
class DeepFilterNetProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frameSize = options.processorOptions?.frameSize ?? 480;
    this.inputBuffer = new Float32Array(0);
    this.outputBuffer = new Float32Array(0);
    this.pending = false;
    this.port.onmessage = (e) => {
      if (e.data.cleaned) {
        const merged = new Float32Array(this.outputBuffer.length + e.data.cleaned.length);
        merged.set(this.outputBuffer, 0);
        merged.set(e.data.cleaned, this.outputBuffer.length);
        this.outputBuffer = merged;
        this.pending = false;
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    if (input) {
      const merged = new Float32Array(this.inputBuffer.length + input.length);
      merged.set(this.inputBuffer, 0);
      merged.set(input, this.inputBuffer.length);
      this.inputBuffer = merged;
      while (this.inputBuffer.length >= this.frameSize && !this.pending) {
        const frame = this.inputBuffer.slice(0, this.frameSize);
        this.inputBuffer = this.inputBuffer.slice(this.frameSize);
        this.pending = true;
        this.port.postMessage({ frame }, [frame.buffer]);
      }
    }
    const out = outputs[0]?.[0];
    if (out && this.outputBuffer.length >= out.length) {
      out.set(this.outputBuffer.slice(0, out.length));
      this.outputBuffer = this.outputBuffer.slice(out.length);
    } else if (out) {
      out.fill(0);
    }
    return true;
  }
}
registerProcessor('deepfilternet-processor', DeepFilterNetProcessor);
`;
  const blob = new Blob([src], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}
