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

export const KOKORO_MODEL = 'hexgrad/kokoro-82m';

export const KOKORO_VOICES: Readonly<Record<string, string>> = {
  en: 'af_heart', fr: 'ff_siwis', es: 'ef_dora', pt: 'pf_dora', it: 'if_sara', ja: 'jf_alpha', zh: 'zf_xiaobei', hi: 'hf_alpha',
};

export const primaryLanguage = (lang: string): string => lang.split('-')[0]!.toLowerCase();

export const kokoroVoice = (lang: string): string | null => KOKORO_VOICES[primaryLanguage(lang)] ?? null;

export interface TtsClip { audio: Buffer; format: string }

export type LanguageTts = (text: string, lang: string, speed?: number) => Promise<TtsClip>;

export const TTS_CALL_TIMEOUT_MS = 15_000;

export function kokoroTts(links: () => Array<RouteTarget<TTSProvider>>, breakers?: CircuitBreakerRegistry): LanguageTts {
  return async (text, lang, speed) => {
    const voice = kokoroVoice(lang);
    if (!voice) throw new Error(`${KOKORO_MODEL} has no voice for ${lang}`);
    const targets = links().map(l => ({ ...l, hedgeAfterMs: 0, group: `eq:kokoro|voice:${voice}`, chainKey: 'tts:kokoro' }));
    const { result } = await routeRequest(
      targets,
      (t, signal) => t.provider.synthesize({ signal, model: t.model ?? KOKORO_MODEL, input: text, voice, responseFormat: 'mp3', ...(speed && speed !== 1 && { speed }) }),
      { stage: 'tts', timeoutMs: TTS_CALL_TIMEOUT_MS, retriesPerProvider: 0, ...(breakers && { breakers }) },
    );
    if (!result.audio.length) throw new Error(`${KOKORO_MODEL}: empty audio`);
    return { audio: result.audio, format: 'mp3' };
  };
}

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

export interface TtsStreamOptions {
  synthesize: (id: number, speed: number) => Promise<TtsClip | null>;
  deliver: (id: number, clip: TtsClip) => boolean;
  dropped: (id: number) => void;
  now: () => number;
}

interface Waiting { id: number; readyAt: number }
interface Job { id: number; clip?: TtsClip | null }

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
      const job: Job = { id: this.waiting.shift()!.id };
      this.jobs.push(job);
      const queuedMs = this.playEnd - this.opts.now() + (this.jobs.length - 1) * this.clipMs;
      void this.opts.synthesize(job.id, catchUpSpeed(queuedMs)).catch(() => null).then(clip => {
        job.clip = clip;
        this.flush();
        this.pump();
      });
    }
  }

  private flush(): void {
    if (this.closed) return;
    while (this.jobs[0] && this.jobs[0].clip !== undefined) {
      const { id, clip } = this.jobs.shift()!;
      if (!clip || !this.opts.deliver(id, clip)) continue;
      const ms = mp3DurationMs(clip.audio);
      this.clipMs = this.clipMs ? 0.7 * this.clipMs + 0.3 * ms : ms;
      this.playEnd = Math.max(this.opts.now(), this.playEnd) + ms;
    }
  }
}
