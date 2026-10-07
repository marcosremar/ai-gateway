/**
 * Browser audio of the WS and clip rungs: microphone → 16 kHz PCM16 20 ms frames (AudioWorklet), and a 24 kHz (or any
 * rate) PCM player on an AudioWorklet ring buffer. WebRTC needs neither: the browser's own Opus stack carries audio.
 */
import { FrameChunker, LinearResampler, floatToInt16, int16ToFloat, samplesPerFrame } from './pcm';

/** Posts each render quantum (mono, the context's rate) to the main thread. */
export const CAPTURE_WORKLET = `class AigwRtCapture extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch && ch.length) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor('aigw-rt-capture', AigwRtCapture);`;

/**
 * Ring buffer (60 s at the context rate; the oldest audio is dropped when full). Messages in: Float32Array samples, or
 * 'flush' (barge-in). Messages out: 'playing' / 'idle' when the buffer starts or stops feeding the output.
 */
export const PLAYER_WORKLET = `class AigwRtPlayer extends AudioWorkletProcessor {
  constructor() {
    super(); this.buf = new Float32Array(sampleRate * 60); this.r = 0; this.w = 0; this.n = 0; this.on = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d === 'flush') { this.r = 0; this.w = 0; this.n = 0; return; }
      for (let i = 0; i < d.length; i++) {
        if (this.n === this.buf.length) { this.r = (this.r + 1) % this.buf.length; this.n--; }
        this.buf[this.w] = d[i]; this.w = (this.w + 1) % this.buf.length; this.n++;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (this.n > 0) { out[i] = this.buf[this.r]; this.r = (this.r + 1) % this.buf.length; this.n--; } else out[i] = 0;
    }
    const on = this.n > 0;
    if (on !== this.on) { this.on = on; this.port.postMessage(on ? 'playing' : 'idle'); }
    return true;
  }
}
registerProcessor('aigw-rt-player', AigwRtPlayer);`;

async function addWorklet(context: BaseAudioContext, source: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
}

export interface PcmCapture { stop(): void }

/** Microphone → `rate` Hz PCM16 frames of `frameMs` (default 16 kHz / 20 ms: 320 samples). */
export async function createPcmCapture(stream: MediaStream, opts: { rate: number; frameMs?: number; onFrame: (pcm: Int16Array) => void }): Promise<PcmCapture> {
  const context = new AudioContext();
  await context.resume().catch(() => {});
  await addWorklet(context, CAPTURE_WORKLET);
  const node = new AudioWorkletNode(context, 'aigw-rt-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
  const source = context.createMediaStreamSource(stream);
  const resampler = new LinearResampler(context.sampleRate, opts.rate);
  const chunker = new FrameChunker(samplesPerFrame(opts.rate, opts.frameMs));
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    for (const frame of chunker.push(resampler.push(e.data))) opts.onFrame(floatToInt16(frame));
  };
  source.connect(node);
  return {
    stop() {
      node.port.onmessage = null;
      source.disconnect();
      void context.close().catch(() => {});
    },
  };
}

export interface PcmPlayer {
  /** PCM16 at `rate` (the player resamples to its context). */
  pushPcm16(pcm: Int16Array, rate: number): void;
  pushFloat(samples: Float32Array, rate: number): void;
  /** Drops what is queued (barge-in). */
  flush(): void;
  readonly playing: boolean;
  /** Resolves when nothing is queued any more. */
  idle(): Promise<void>;
  /** Decodes a container (mp3, wav, ogg…) and queues it. */
  pushEncoded(data: ArrayBuffer): Promise<void>;
  close(): void;
}

export async function createPcmPlayer(opts: { rate: number; onPlaying?: (playing: boolean) => void }): Promise<PcmPlayer> {
  let context: AudioContext;
  try { context = new AudioContext({ sampleRate: opts.rate, latencyHint: 'interactive' }); } catch { context = new AudioContext(); }
  await context.resume().catch(() => {});
  await addWorklet(context, PLAYER_WORKLET);
  const node = new AudioWorkletNode(context, 'aigw-rt-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  node.connect(context.destination);
  const resamplers = new Map<number, LinearResampler>();
  let playing = false;
  let queued = false;
  const waiters: Array<() => void> = [];
  node.port.onmessage = (e: MessageEvent<string>) => {
    playing = e.data === 'playing';
    if (!playing) { queued = false; for (const w of waiters.splice(0)) w(); }
    opts.onPlaying?.(playing);
  };
  const toContext = (samples: Float32Array, rate: number) => {
    if (rate === context.sampleRate) return samples;
    let r = resamplers.get(rate);
    if (!r) { r = new LinearResampler(rate, context.sampleRate); resamplers.set(rate, r); }
    return r.push(samples);
  };
  const player: PcmPlayer = {
    pushFloat(samples, rate) {
      if (!samples.length) return;
      queued = true;
      const out = toContext(samples, rate);
      node.port.postMessage(out, [out.buffer]);
    },
    pushPcm16(pcm, rate) { player.pushFloat(int16ToFloat(pcm), rate); },
    async pushEncoded(data) {
      const decoded = await context.decodeAudioData(data.slice(0));
      player.pushFloat(decoded.getChannelData(0).slice(), decoded.sampleRate);
    },
    flush() {
      node.port.postMessage('flush');
      queued = false;
      for (const w of waiters.splice(0)) w();
    },
    get playing() { return playing || queued; },
    idle() { return playing || queued ? new Promise<void>(r => waiters.push(r)) : Promise.resolve(); },
    close() {
      for (const w of waiters.splice(0)) w();
      node.port.onmessage = null;
      node.disconnect();
      void context.close().catch(() => {});
    },
  };
  return player;
}
