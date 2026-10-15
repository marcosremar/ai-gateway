/**
 * Recording one speaking turn and turning it into the WAV an STT accepts. Moved unchanged from parle
 * (`frontend/website/src/virtual-listen.ts`, 06/10/2026).
 */

/** Recording of one turn in progress. */
export interface TurnClip {
  running(): boolean;
  /** How long ago the clip started (ms), to drop a clip that is only silence. */
  age(now: number): number;
  start(track: MediaStreamTrack, now: number): void;
  /** Closes the clip and hands over the audio (or `null` if nothing was recorded). */
  finish(): Promise<Blob | null>;
  snapshot(): Promise<Blob | null>;
  cancel(): void;
}

/** Containers an STT endpoint accepts, in order of preference (Chrome/Android: webm; Safari: mp4). */
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

export function createTurnClip(): TurnClip {
  let recorder: MediaRecorder | null = null, chunks: Blob[] = [], startedAt = 0;
  const stopRecorder = (current: MediaRecorder) => { if (current.state !== 'inactive') current.stop(); };
  return {
    running: () => recorder !== null,
    age: (now) => (recorder ? now - startedAt : 0),
    start(track, now) {
      const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      const current = new MediaRecorder(new MediaStream([track]), mimeType ? { mimeType } : undefined);
      chunks = [];
      current.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      current.start();
      recorder = current;
      startedAt = now;
    },
    finish() {
      const current = recorder, mine = chunks;
      recorder = null;
      if (!current) return Promise.resolve(null);
      return new Promise((resolve) => {
        current.onstop = () => resolve(mine.length ? new Blob(mine, { type: current.mimeType || mine[0]!.type }) : null);
        stopRecorder(current);
      });
    },
    snapshot() {
      const current = recorder, mine = chunks;
      if (!current || current.state !== 'recording') return Promise.resolve(null);
      return new Promise((resolve) => {
        current.addEventListener('dataavailable', () => resolve(mine.length ? new Blob(mine, { type: current.mimeType || mine[0]!.type }) : null), { once: true });
        current.requestData();
      });
    },
    cancel() {
      const current = recorder;
      recorder = null;
      if (current) { current.ondataavailable = null; stopRecorder(current); }
    },
  };
}

/** Rate of the WAV sent to STT: speech models' rate (16 kHz mono). */
export const STT_RATE = 16_000;
/** Margin kept before and after the voice when trimming the clip (the first syllable's onset is weak). */
const EDGE_S = 0.3;

/**
 * Voiced span of a mono clip: from the first to the last peak above 10 % of the maximum (and above a noise floor), with
 * `EDGE_S` of margin. parle run of 28/09/2026 on a cloud phone: the «Bom dia!» clip started ~6 s before the speech,
 * only call hiss, and STT returned «Bonjour.»; the same speech without the silence came back «Bom dia.».
 */
export function voicedRange(samples: Float32Array, rate: number): [number, number] {
  let peak = 0;
  for (const x of samples) peak = Math.max(peak, Math.abs(x));
  const floor = Math.max(0.005, peak * 0.1);
  let first = 0, last = samples.length - 1;
  while (first < samples.length && Math.abs(samples[first]!) < floor) first++;
  while (last > first && Math.abs(samples[last]!) < floor) last--;
  if (first >= samples.length) return [0, samples.length];
  const edge = Math.round(EDGE_S * rate);
  return [Math.max(0, first - edge), Math.min(samples.length, last + 1 + edge)];
}

/** Mono PCM as 16-bit WAV (the container every STT in the chain accepts). */
export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) out.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  text(36, 'data'); out.setUint32(40, samples.length * 2, true);
  samples.forEach((x, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 0x7fff, true));
  return out.buffer;
}

/**
 * The recorded clip (webm/opus on Chrome, mp4 on Safari) as 16 kHz mono WAV, voiced span only. In webm the first STT
 * of the chain refused it and a short greeting after seconds of silence came back in French; in WAV the first one
 * accepts it. `null` = the browser could not decode it: send the original.
 */
export async function clipToWav(clip: Blob, audio: BaseAudioContext): Promise<Blob | null> {
  try {
    const decoded = await audio.decodeAudioData(await clip.arrayBuffer());
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * STT_RATE)), STT_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const mono = (await offline.startRendering()).getChannelData(0);
    const [from, to] = voicedRange(mono, STT_RATE);
    return new Blob([encodeWav(mono.subarray(from, to), STT_RATE)], { type: 'audio/wav' });
  } catch {
    return null;
  }
}
