// ── AI Gateway — server-side TTS ─────────────────────────────────────────────
// Everything the gateway needs to voice text by itself (rooms today):
//   - `kokoroTts(links)`: Kokoro 82M through the gateway's own routing (circuit breakers, per-call timeout, the
//     fastest of equivalent links first via link-reorder once there is more than one). One request per sentence:
//     no hedge, so a slow provider never costs a second call.
//   - `TtsStream`: the sentences of one stream (a room language) voiced in parallel when the provider is slow (one call
//     per waiting sentence, up to TTS_MAX_PARALLEL), delivered in order, at most TTS_MAX_WAITING waiting, and spoken
//     faster while the listeners have audio queued (`catchUpSpeed`: scheduled audio + sentences still being voiced).

import type { CircuitBreakerRegistry } from '../gateway/providers/cloud/circuit-breaker';
import type { TTSProvider } from '../gateway/providers/cloud/types';
import { routeRequest, type RouteTarget } from '../gateway/proxy/provider-routing';
import type { DeploymentController } from '../deployments/controller';
import { DeploymentTTSProvider } from '../deployments/inference-providers';

export const KOKORO_MODEL = 'hexgrad/kokoro-82m';

export const KOKORO_VOICES: Readonly<Record<string, string>> = {
  en: 'af_heart', fr: 'ff_siwis', es: 'ef_dora', pt: 'pf_dora', it: 'if_sara', ja: 'jf_alpha', zh: 'zf_xiaobei', hi: 'hf_alpha',
};

export const primaryLanguage = (lang: string): string => lang.split('-')[0]!.toLowerCase();

export const kokoroVoice = (lang: string): string | null => KOKORO_VOICES[primaryLanguage(lang)] ?? null;

export interface TtsClip { audio: Buffer; format: string; pcm?: AsyncIterable<Buffer> }

export const PCM_RATE = 24_000;
const PCM_BYTES_PER_MS = (PCM_RATE * 2) / 1000;
const WAV_HEAD_BYTES = 44;
const PCM_STALL_MS = 15_000;

export type LanguageTts = (text: string, lang: string, speed?: number) => Promise<TtsClip>;

export const TTS_CALL_TIMEOUT_MS = 15_000;

export function kokoroTts(links: () => Array<RouteTarget<TTSProvider>>, breakers?: CircuitBreakerRegistry): LanguageTts {
  return async (text, lang, speed) => {
    const voice = kokoroVoice(lang);
    if (!voice) throw new Error(`${KOKORO_MODEL} has no voice for ${lang}`);
    const targets = links().map(l => ({ ...l, hedgeAfterMs: 0, group: `eq:kokoro|voice:${voice}`, chainKey: 'tts:kokoro' }));
    const { result } = await routeRequest(
      targets,
      (t, signal) => t.provider.synthesize({ signal, stream: true, model: t.model ?? KOKORO_MODEL, input: text, voice, responseFormat: 'wav', ...(speed && speed !== 1 && { speed }) }),
      { stage: 'tts', timeoutMs: TTS_CALL_TIMEOUT_MS, retriesPerProvider: 0, ...(breakers && { breakers }) },
    );
    if (result.stream) return { audio: Buffer.alloc(0), format: 'pcm', pcm: pcmOfWavStream(result.stream) };
    if (result.audio.length <= WAV_HEAD_BYTES) throw new Error(`${KOKORO_MODEL}: empty audio`);
    return { audio: result.audio, format: 'wav' };
  };
}

export async function* pcmOfWavStream(stream: ReadableStream<Uint8Array>, stallMs = PCM_STALL_MS): AsyncGenerator<Buffer> {
  const reader = stream.getReader();
  let skip = WAV_HEAD_BYTES;
  let odd: Buffer = Buffer.alloc(0);
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no audio for ${stallMs} ms`)), stallMs); });
      const { value, done } = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
      if (done) return;
      let bytes = Buffer.concat([odd, Buffer.from(value)]);
      const head = Math.min(skip, bytes.length);
      skip -= head;
      bytes = bytes.subarray(head);
      const even = bytes.length - (bytes.length % 2);
      odd = bytes.subarray(even);
      if (even) yield bytes.subarray(0, even);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export function pcmToWav(pcm: Buffer, rate = PCM_RATE): Buffer {
  const head = Buffer.alloc(WAV_HEAD_BYTES);
  head.write('RIFF', 0); head.writeUInt32LE(pcm.length + 36, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

export const QWEN_CLONE_MODEL = 'Qwen/Qwen3-TTS-12Hz-0.6B-Base';

export const QWEN_LANGUAGES: readonly string[] = ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it'];

export const qwenSpeaks = (lang: string): boolean => QWEN_LANGUAGES.includes(primaryLanguage(lang));

export interface VoiceRef { refAudio: string; refText: string }

export type CloneTts = (text: string, lang: string, voice: VoiceRef) => Promise<TtsClip>;

export function qwenCloneTts(links: () => Array<RouteTarget<TTSProvider>>, breakers?: CircuitBreakerRegistry): CloneTts {
  return async (text, lang, voice) => {
    if (!qwenSpeaks(lang)) throw new Error(`${QWEN_CLONE_MODEL} does not speak ${lang}`);
    const targets = links().map(l => ({ ...l, hedgeAfterMs: 0, chainKey: 'tts:qwen-clone' }));
    const { result } = await routeRequest(
      targets,
      (t, signal) => t.provider.synthesize({
        signal, stream: true, model: t.model ?? QWEN_CLONE_MODEL, input: text, voice: 'clone', responseFormat: 'wav',
        extra: { task_type: 'Base', ref_audio: voice.refAudio, x_vector_only_mode: true, language: primaryLanguage(lang) },
      }),
      { stage: 'tts', timeoutMs: TTS_CALL_TIMEOUT_MS, retriesPerProvider: 1, ...(breakers && { breakers }) },
    );
    if (result.stream) return { audio: Buffer.alloc(0), format: 'pcm', pcm: trimStreamSilence(pcmOfWavStream(result.stream)) };
    if (!result.audio.length) throw new Error(`${QWEN_CLONE_MODEL}: empty audio`);
    return { audio: trimSilence(result.audio), format: 'wav' };
  };
}

export interface DeploymentClone { ready: () => boolean; synthesize: CloneTts }

export function deploymentClone(controller: Pick<DeploymentController, 'acquire' | 'get'>, name: string, breakers?: CircuitBreakerRegistry): DeploymentClone {
  const provider = new DeploymentTTSProvider(
    { get: (n) => controller.get(n), acquire: (n, opts) => controller.acquire(n, { ...opts, noWake: true }) },
    name, { waitMs: 0 },
  );
  return {
    ready: () => Boolean(controller.get(name)?.replicas?.some(r => r.phase === 'ready')),
    synthesize: qwenCloneTts(() => [{ providerId: `deployment:${name}`, provider, model: QWEN_CLONE_MODEL }], breakers),
  };
}

const SILENT_BELOW_PEAK = 0.1;
const TRIM_MARGIN_MS = 200;
const STREAM_LOUD_SAMPLE = 1000;

const loud = (pcm: Buffer, at: number): boolean => Math.abs(pcm.readInt16LE(at)) >= STREAM_LOUD_SAMPLE;

function firstLoud(pcm: Buffer): number {
  for (let at = 0; at + 1 < pcm.length; at += 2) if (loud(pcm, at)) return at;
  return -1;
}

function lastLoud(pcm: Buffer): number {
  for (let at = pcm.length - 2; at >= 0; at -= 2) if (loud(pcm, at)) return at;
  return -1;
}

export async function* trimStreamSilence(pcm: AsyncIterable<Buffer>, rate = PCM_RATE): AsyncGenerator<Buffer> {
  const margin = Math.round((rate * TRIM_MARGIN_MS) / 1000) * 2;
  let held: Buffer = Buffer.alloc(0);
  let started = false;
  for await (const chunk of pcm) {
    let data = Buffer.concat([held, chunk]);
    held = Buffer.alloc(0);
    if (lastLoud(data) < 0) {
      held = started ? data : data.subarray(Math.max(0, data.length - margin));
      continue;
    }
    if (!started) {
      data = data.subarray(Math.max(0, firstLoud(data) - margin));
      started = true;
    }
    const end = lastLoud(data) + 2;
    yield data.subarray(0, end);
    held = data.subarray(end);
  }
  if (started && held.length) yield held.subarray(0, Math.min(margin, held.length));
}

export function trimSilence(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.subarray(0, 4).toString('latin1') !== 'RIFF') return wav;
  let channels = 0, rate = 0, bits = 0, start = 0, end = 0;
  for (let at = 12; at + 8 <= wav.length;) {
    const id = wav.subarray(at, at + 4).toString('latin1');
    const size = wav.readUInt32LE(at + 4);
    if (id === 'fmt ') { channels = wav.readUInt16LE(at + 10); rate = wav.readUInt32LE(at + 12); bits = wav.readUInt16LE(at + 22); }
    if (id === 'data') { start = at + 8; end = Math.min(wav.length, start + size); break; }
    at += 8 + size + (size & 1);
  }
  if (!start || bits !== 16 || !channels || !rate) return wav;
  const frame = channels * 2;
  const win = Math.max(1, Math.round(rate / 50)) * frame;
  const loudness: number[] = [];
  for (let at = start; at + win <= end; at += win) {
    let sum = 0;
    for (let i = at; i < at + win; i += 2) sum += wav.readInt16LE(i) ** 2;
    loudness.push(Math.sqrt(sum / (win / 2)));
  }
  const peak = Math.max(0, ...loudness);
  const first = loudness.findIndex(l => l > peak * SILENT_BELOW_PEAK);
  if (!peak || first < 0) return wav;
  const last = loudness.length - 1 - [...loudness].reverse().findIndex(l => l > peak * SILENT_BELOW_PEAK);
  const margin = Math.round((rate * TRIM_MARGIN_MS) / 1000) * frame;
  const from = Math.max(start, start + first * win - margin);
  const to = Math.min(end, start + (last + 1) * win + margin);
  const header = Buffer.from(wav.subarray(0, start));
  header.writeUInt32LE(to - from, start - 4);
  header.writeUInt32LE(header.length + (to - from) - 8, 4);
  return Buffer.concat([header, wav.subarray(from, to)]);
}

export function wavDurationMs(buf: Buffer): number {
  if (buf.length < 44 || buf.subarray(0, 4).toString('latin1') !== 'RIFF') return 0;
  const byteRate = buf.readUInt32LE(28);
  return byteRate ? ((buf.length - 44) * 1000) / byteRate : 0;
}

export const clipDurationMs = (clip: TtsClip): number => (clip.format === 'wav' ? wavDurationMs(clip.audio) : mp3DurationMs(clip.audio));

export const TTS_MAX_SPEED = 1.3;
const SPEED_RAMP_MS = 20_000;

export function catchUpSpeed(queuedMs: number): number {
  return Math.round(Math.min(TTS_MAX_SPEED, 1 + Math.max(0, queuedMs) / SPEED_RAMP_MS) * 20) / 20;
}

const MP3_KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_RATES: Record<number, number[]> = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000] };

export function mp3DurationMs(buf: Buffer): number {
  let at = buf.subarray(0, 3).toString('latin1') === 'ID3' ? 10 + ((buf[6]! & 0x7f) << 21 | (buf[7]! & 0x7f) << 14 | (buf[8]! & 0x7f) << 7 | (buf[9]! & 0x7f)) : 0;
  let ms = 0;
  while (at + 4 <= buf.length) {
    const h = buf.readUInt32BE(at);
    const version = (h >>> 19) & 3, layer = (h >>> 17) & 3, kbpsIndex = (h >>> 12) & 15, rateIndex = (h >>> 10) & 3;
    if (h >>> 21 !== 0x7ff || version === 1 || layer !== 1 || kbpsIndex === 0 || kbpsIndex === 15 || rateIndex === 3) break;
    const rate = MP3_RATES[version]![rateIndex]!;
    const samples = version === 3 ? 1152 : 576;
    const kbps = (version === 3 ? MP3_KBPS_V1 : MP3_KBPS_V2)[kbpsIndex]!;
    at += Math.floor((samples / 8) * kbps * 1000 / rate) + ((h >>> 9) & 1);
    ms += (samples * 1000) / rate;
  }
  return ms;
}

export const TTS_MAX_PARALLEL = 6;
export const TTS_MAX_WAITING = 4;

export const PCM_CHUNK_MIN_BYTES = PCM_BYTES_PER_MS * 250;

export interface TtsStreamOptions {
  synthesize: (id: number, speed: number) => Promise<TtsClip | null>;
  deliver: (id: number, clip: TtsClip, streamed: boolean) => boolean;
  deliverChunk?: (id: number, pcm: Buffer, seq: number) => boolean;
  dropped: (id: number) => void;
  now: () => number;
}

interface Waiting { id: number; readyAt: number }
interface Job { id: number; clip?: TtsClip | null; parts: Buffer[]; sent: number; ended: boolean; muted: boolean }

export class TtsStream {
  private waiting: Waiting[] = [];
  private jobs: Job[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private playEnd = 0;
  private clipMs = 0;
  private closed = false;

  constructor(private readonly opts: TtsStreamOptions) {}

  has(id: number): boolean {
    return this.waiting.some(w => w.id === id) || this.jobs.some(j => j.id === id);
  }

  push(id: number, readyAt: number): void {
    this.waiting.push({ id, readyAt });
    this.waiting.sort((a, b) => a.id - b.id);
    if (this.waiting.length > TTS_MAX_WAITING) this.opts.dropped(this.waiting.shift()!.id);
    this.pump();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.waiting = [];
    this.jobs = [];
  }

  private pump(): void {
    if (this.timer || this.closed) return;
    while (this.waiting[0] && this.jobs.length < TTS_MAX_PARALLEL) {
      const wait = this.waiting[0].readyAt - this.opts.now();
      if (wait > 0) {
        this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
        this.timer.unref?.();
        return;
      }
      const job: Job = { id: this.waiting.shift()!.id, parts: [], sent: 0, ended: false, muted: false };
      this.jobs.push(job);
      const queuedMs = this.playEnd - this.opts.now() + (this.jobs.length - 1) * this.clipMs;
      void this.opts.synthesize(job.id, catchUpSpeed(queuedMs)).catch(() => null).then(async clip => {
        job.clip = clip;
        if (clip?.pcm) await this.read(job, clip.pcm);
        job.ended = true;
        this.flush();
        this.pump();
      });
    }
  }

  private async read(job: Job, pcm: AsyncIterable<Buffer>): Promise<void> {
    let pending: Buffer[] = [];
    let size = 0;
    const cut = () => { if (size) { job.parts.push(Buffer.concat(pending)); pending = []; size = 0; this.flush(); } };
    try {
      for await (const piece of pcm) {
        if (this.closed) return;
        pending.push(piece);
        size += piece.length;
        if (size >= PCM_CHUNK_MIN_BYTES) cut();
      }
    } catch {
      return void cut();
    }
    cut();
  }

  private flush(): void {
    if (this.closed) return;
    for (let job = this.jobs[0]; job; job = this.jobs[0]) {
      if (job.clip === undefined) return;
      if (job.clip?.pcm) this.sendParts(job);
      if (!job.ended) return;
      this.jobs.shift();
      const clip = job.clip?.pcm ? (job.parts.length ? { audio: pcmToWav(Buffer.concat(job.parts)), format: 'wav' } : null) : job.clip;
      if (!clip || job.muted || !this.opts.deliver(job.id, clip, Boolean(job.clip?.pcm))) continue;
      const ms = clipDurationMs(clip);
      this.clipMs = this.clipMs ? 0.7 * this.clipMs + 0.3 * ms : ms;
      this.playEnd = Math.max(this.opts.now(), this.playEnd) + ms;
    }
  }

  private sendParts(job: Job): void {
    while (!job.muted && job.sent < job.parts.length) {
      if (this.opts.deliverChunk?.(job.id, job.parts[job.sent]!, job.sent) === false) job.muted = true;
      job.sent++;
    }
  }
}
