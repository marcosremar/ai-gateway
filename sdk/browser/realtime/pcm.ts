/**
 * PCM helpers of the WebSocket rung (docs/realtime.md § Audio): PCM16 little-endian mono, 16 kHz upstream and 24 kHz
 * downstream, 20 ms frames, each binary WS message prefixed by one header byte (0x01 = audio).
 */

export const WS_AUDIO_HEADER = 0x01;
export const UPSTREAM_RATE = 16_000;
export const DOWNSTREAM_RATE = 24_000;
export const FRAME_MS = 20;

export const samplesPerFrame = (rate: number, frameMs = FRAME_MS) => Math.round((rate * frameMs) / 1000);

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const x = Math.max(-1, Math.min(1, input[i]!));
    out[i] = x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff);
  }
  return out;
}

export function int16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i]! / (input[i]! < 0 ? 0x8000 : 0x7fff);
  return out;
}

/** One binary WS message: 0x01 then the samples as little-endian int16 (endianness explicit, not the host's). */
export function encodeAudioFrame(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(1 + pcm.length * 2);
  out[0] = WS_AUDIO_HEADER;
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(1 + i * 2, pcm[i]!, true);
  return out;
}

/** The samples of a binary WS message, or null when it is not audio (unknown header, odd length). */
export function decodeAudioFrame(data: ArrayBuffer | Uint8Array): Int16Array | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 1 || bytes[0] !== WS_AUDIO_HEADER || (bytes.length - 1) % 2 !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array((bytes.length - 1) / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(1 + i * 2, true);
  return out;
}

export function trimLeadingSilence(samples: Float32Array, rate: number, threshold = 0.01): Float32Array {
  const loud = samples.findIndex(x => Math.abs(x) > threshold);
  return loud < 0 ? samples : samples.subarray(Math.max(0, loud - Math.round(rate / 100)));
}

/**
 * Streaming linear resampler: chunks in, chunks out, the fractional position carried across calls so a stream cut in
 * 128-sample render quanta comes out continuous. Linear interpolation is enough for speech to Whisper / from TTS
 * (both band-limited well under the lower Nyquist); it is what keeps the worklet cheap.
 */
export class LinearResampler {
  private readonly step: number;
  private pos = 0;
  private last = 0;
  private primed = false;

  constructor(readonly fromRate: number, readonly toRate: number) {
    if (!(fromRate > 0) || !(toRate > 0)) throw new Error('sample rates must be positive');
    this.step = fromRate / toRate;
  }

  push(input: Float32Array): Float32Array {
    if (this.fromRate === this.toRate) return input.slice();
    if (!input.length) return new Float32Array(0);
    // Virtual signal: [last, ...input]; `pos` indexes it (0 = `last`). Before the first chunk there is no `last`.
    const src = (i: number) => (i === 0 ? this.last : input[i - 1]!);
    let pos = this.primed ? this.pos : 1;
    const end = input.length; // last index of the virtual signal
    const out: number[] = [];
    while (pos <= end) {
      const i = Math.floor(pos);
      const frac = pos - i;
      out.push(frac === 0 || i + 1 > end ? src(i) : src(i) + (src(i + 1) - src(i)) * frac);
      pos += this.step;
    }
    this.pos = pos - end;
    this.last = input[input.length - 1]!;
    this.primed = true;
    return Float32Array.from(out);
  }
}

/** Cuts a sample stream into fixed frames (20 ms), keeping the remainder for the next push. */
export class FrameChunker {
  private pending = new Float32Array(0);

  constructor(readonly frameSamples: number) {}

  push(input: Float32Array): Float32Array[] {
    const merged = new Float32Array(this.pending.length + input.length);
    merged.set(this.pending);
    merged.set(input, this.pending.length);
    const frames: Float32Array[] = [];
    let at = 0;
    for (; at + this.frameSamples <= merged.length; at += this.frameSamples) frames.push(merged.slice(at, at + this.frameSamples));
    this.pending = merged.slice(at);
    return frames;
  }
}
