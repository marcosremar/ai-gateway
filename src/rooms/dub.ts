// ── AI Gateway — Live subtitle rooms: server-side dubbing ────────────────────
// When the presenter's app publishes text only, the gateway voices each line itself (Kokoro 82M through OpenRouter,
// MAI-Voice as fallback, each attempt time-bounded; injected by serve.ts as a `RoomSynthesize`) for the languages someone is actually listening to. Spending rules:
//   - a language is voiced only while at least one viewer explicitly listens to it (`listen` message), it has a
//     non-empty translation in the line and Kokoro has a voice for it;
//   - the presenter's own clips win: a language the presenter sent a clip for recently is left alone (other languages are
//     still voiced — the desktop app dubs one language, viewers may listen to another), and a line+language the
//     presenter voiced is never synthesized (checked before and after the call);
//   - a draft line (the presenter will still grow it) is not voiced; its final version is;
//   - per room and language one call at a time, every line voiced in order, each at least `waitMs` after it arrived;
//     past ROOM_DUB_QUEUE_MAX waiting lines the oldest is dropped (a backlog cannot build up), and a line+language is
//     voiced once;
//   - the listeners hear the clips back to back: the more audio they still have queued, the faster Kokoro speaks
//     (`dubSpeed`, up to ROOM_DUB_MAX_SPEED) so the voice catches up instead of the page dropping sentences.
// Failures are logged, never thrown into the publish path.

import type { LiveRoom } from './service';
import type { RoomLine } from './types';

/** Kokoro v1.0 voice per language (primary subtag). Languages Kokoro does not speak are not voiced. */
export const KOKORO_ROOM_VOICES: Readonly<Record<string, string>> = {
  en: 'af_heart', fr: 'ff_siwis', es: 'ef_dora', pt: 'pf_dora', it: 'if_sara', ja: 'jf_alpha', zh: 'zf_xiaobei', hi: 'hf_alpha',
};

/** The Kokoro voice for a room language (`pt-BR` → `pf_dora`), or null when Kokoro does not speak it. */
export function kokoroVoice(lang: string): string | null {
  return KOKORO_ROOM_VOICES[primary(lang)] ?? null;
}

const primary = (lang: string): string => lang.split('-')[0]!.toLowerCase();

export type RoomTranslate = (text: string, from: string | null, to: string) => Promise<string>;

export interface ChatLike {
  chat(req: { model: string; messages: { role: 'system' | 'user'; content: string }[]; temperature?: number; timeoutMs?: number; extraBody?: Record<string, unknown> }): Promise<{ content: string }>;
}

const TRANSLATE_MODEL = 'google/gemini-2.5-flash-lite';
const TRANSLATE_TIMEOUT_MS = 6_000;
const languageName = (code: string): string => new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;

export const openRouterTranslate = (provider: ChatLike): RoomTranslate => async (text, from, to) => {
  const res = await provider.chat({
    model: TRANSLATE_MODEL,
    temperature: 0,
    timeoutMs: TRANSLATE_TIMEOUT_MS,
    extraBody: { reasoning: { enabled: false } },
    messages: [
      { role: 'system', content: `Translate this live subtitle${from ? ` from ${languageName(from)}` : ''} into ${languageName(to)}. Reply with the translation only.` },
      { role: 'user', content: text },
    ],
  });
  return res.content.trim();
};

/** One synthesized clip: audio bytes and their container (`mp3`, `wav`…). */
export interface RoomClip { audio: Buffer; format: string }

/** Speech synthesis for rooms: text + room language → clip. Throws on failure; `signal` aborts the upstream call. */
export type RoomSynthesize = (text: string, lang: string, signal?: AbortSignal, speed?: number) => Promise<RoomClip>;

/** The structural slice of a TTS provider used by the room synthesizers (the OpenRouter provider fits). */
export interface TtsLike {
  synthesize(req: { input: string; model: string; voice: string; responseFormat?: 'mp3'; signal?: AbortSignal; speed?: number }): Promise<{ audio: Buffer }>;
}

export const KOKORO_MODEL = 'hexgrad/kokoro-82m';
export const MAI_MODEL = 'microsoft/mai-voice-2.1-flash';

/** MAI-Voice voice per language: the fallback when Kokoro is stuck or failing. Only voices already used in production. */
export const MAI_ROOM_VOICES: Readonly<Record<string, string>> = {
  en: 'en-US-Harper:MAI-Voice-2-Flash', fr: 'fr-FR-Soleil:MAI-Voice-2-Flash', pt: 'pt-BR-Luana:MAI-Voice-2-Flash',
};

/**
 * Budget of one synthesis attempt. The OpenRouter SDK client has no timeout of its own (SDK default: 10 min) and a
 * room language is voiced one call at a time, so a stuck call would mute that language; a line is a sentence, which
 * Kokoro voices in about a second.
 */
export const ROOM_DUB_ATTEMPT_TIMEOUT_MS = 8_000;

function openRouterSynthesize(provider: TtsLike, model: string, voices: Readonly<Record<string, string>>, honoursSpeed: boolean): RoomSynthesize {
  return async (text, lang, signal, speed) => {
    const voice = voices[lang.split('-')[0]!.toLowerCase()];
    if (!voice) throw new Error(`${model} has no voice for ${lang}`);
    const res = await provider.synthesize({ input: text, model, voice, responseFormat: 'mp3', signal, ...(honoursSpeed && speed && speed !== 1 && { speed }) });
    if (!res.audio.length) throw new Error(`${model}: empty audio`);
    return { audio: res.audio, format: 'mp3' };
  };
}

/** Kokoro 82M (mp3) through an OpenAI-compatible TTS provider — OpenRouter in production. */
export const kokoroSynthesize = (provider: TtsLike): RoomSynthesize => openRouterSynthesize(provider, KOKORO_MODEL, KOKORO_ROOM_VOICES, true);

/** MAI-Voice 2.1 Flash (mp3) through OpenRouter, for the languages in `MAI_ROOM_VOICES`. */
export const maiSynthesize = (provider: TtsLike): RoomSynthesize => openRouterSynthesize(provider, MAI_MODEL, MAI_ROOM_VOICES, false);

async function withTimeout<T>(call: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { const err = new Error(`timed out after ${ms} ms`); ctl.abort(err); reject(err); }, ms);
  });
  try { return await Promise.race([call(ctl.signal), timedOut]); } finally { clearTimeout(timer); }
}

/**
 * Tries each synthesizer in order, each bounded by `attemptTimeoutMs` (aborted, and abandoned even if it ignores the
 * abort): a stuck or failing voice passes to the next one and holds the language for at most one budget per attempt.
 */
export function synthesizeWithFallback(chain: RoomSynthesize[], attemptTimeoutMs = ROOM_DUB_ATTEMPT_TIMEOUT_MS): RoomSynthesize {
  return async (text, lang, _signal, speed) => {
    const errors: string[] = [];
    for (const synth of chain) {
      try {
        return await withTimeout(signal => synth(text, lang, signal, speed), attemptTimeoutMs);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    throw new Error(errors.join('; ') || 'no synthesizer');
  };
}

export interface RoomDubberOptions {
  synthesize: RoomSynthesize;
  /** False while the synthesizer cannot work (e.g. no API key): nothing is scheduled. Default: always available. */
  available?: () => boolean;
  /** Delivers a clip to the room's listeners of `lang`. */
  deliver: (room: LiveRoom, lineId: number, lang: string, clip: RoomClip) => void;
  translate?: RoomTranslate;
  addTranslation: (room: LiveRoom, lineId: number, lang: string, text: string) => void;
  /** Wait after a line before voicing it, so the presenter's own clip can arrive first. */
  waitMs: number;
  /** A room whose presenter sent a clip within this window is not voiced by the server. */
  presenterQuietMs: number;
  now: () => number;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

interface QueuedLine { lineId: number; readyAt: number }
interface LangState { queue: QueuedLine[]; busy: boolean; timer: ReturnType<typeof setTimeout> | null; done: number[]; playEnd: number }
interface RoomState { presenterAt: Map<string, number>; presenterKeys: Set<string>; langs: Map<string, LangState> }

/** Line ids remembered per language / presenter clips remembered per room (dedup only; old entries roll off). */
const DONE_KEEP = 64;
const PRESENTER_KEYS_KEEP = 512;
export const ROOM_DUB_QUEUE_MAX = 4;

export const ROOM_DUB_MAX_SPEED = 1.3;
const SPEED_RAMP_MS = 20_000;
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

export function dubSpeed(backlogMs: number): number {
  return Math.round(Math.min(ROOM_DUB_MAX_SPEED, 1 + Math.max(0, backlogMs) / SPEED_RAMP_MS) * 20) / 20;
}


export class RoomDubber {
  private readonly rooms = new Map<string, RoomState>();

  constructor(private readonly opts: RoomDubberOptions) {}

  /** Languages the server can voice in this room (Kokoro-supported). */
  voicedLanguages(room: LiveRoom): string[] {
    return room.meta.languages.filter(l => kokoroVoice(l) !== null);
  }

  /** Kokoro languages the presenter does not publish: the server translates and voices them for whoever picks one. */
  extraLanguages(room: LiveRoom): string[] {
    if (!this.opts.translate) return [];
    const taken = [...room.meta.languages, room.meta.originalLang ?? ''].map(primary);
    return Object.keys(KOKORO_ROOM_VOICES).filter(l => !taken.includes(l));
  }

  private state(code: string): RoomState {
    let s = this.rooms.get(code);
    if (!s) { s = { presenterAt: new Map(), presenterKeys: new Set(), langs: new Map() }; this.rooms.set(code, s); }
    return s;
  }

  /** Whether the presenter sent a clip in `lang` within the quiet window (its own voice wins for that language). */
  private presenterActive(s: RoomState, lang: string): boolean {
    return this.opts.now() - (s.presenterAt.get(lang) ?? -Infinity) < this.opts.presenterQuietMs;
  }

  /** The presenter published a clip: it wins over the server for that line and, for a while, for that language. */
  onPresenterClip(room: LiveRoom, lineId: number, lang: string): void {
    const s = this.state(room.meta.code);
    s.presenterAt.set(lang, this.opts.now());
    s.presenterKeys.add(`${lineId}:${lang}`);
    if (s.presenterKeys.size > PRESENTER_KEYS_KEEP) s.presenterKeys.delete(s.presenterKeys.values().next().value!);
  }

  /** The line, when someone listens to `lang` (voice) or reads an extra language (text), under every spending condition. */
  private wanted(room: LiveRoom, s: RoomState, lineId: number, lang: string): { line: RoomLine; listen: boolean } | null {
    if (room.meta.ended || room.meta.serverDub === false) return null;
    if (this.presenterActive(s, lang) || s.presenterKeys.has(`${lineId}:${lang}`)) return null;
    const at = room.index.get(lineId);
    const line = at === undefined ? undefined : room.lines[at];
    if (!line || line.draft || !kokoroVoice(lang)) return null;
    const translated = !!line.translations[lang]?.trim();
    const translatable = !!this.opts.translate && !!line.original.trim() && primary(line.originalLang ?? room.meta.originalLang ?? '') !== primary(lang);
    if (!translated && !translatable) return null;
    const extra = !room.meta.languages.includes(lang);
    let read = false;
    for (const v of room.viewers) {
      if (v.listening?.(lang)) return { line, listen: true };
      read ||= extra && !translated && v.reading?.(lang) === true;
    }
    return read ? { line, listen: false } : null;
  }

  /** A line was published (added or replaced), or a viewer changed language: schedule what someone listens to or reads. */
  onLine(room: LiveRoom, lineId: number): void {
    if (room.meta.serverDub === false || (this.opts.available && !this.opts.available())) return;
    const s = this.state(room.meta.code);
    const at = room.index.get(lineId);
    const line = at === undefined ? undefined : room.lines[at];
    if (!line) return;
    for (const lang of new Set([...Object.keys(line.translations), ...this.extraLanguages(room)])) {
      if (!this.wanted(room, s, lineId, lang)) continue;
      let ls = s.langs.get(lang);
      if (!ls) { ls = { queue: [], busy: false, timer: null, done: [], playEnd: 0 }; s.langs.set(lang, ls); }
      if (ls.done.some(d => d >= lineId) || ls.queue.some(q => q.lineId === lineId)) continue;
      ls.queue.push({ lineId, readyAt: this.opts.now() + (s.presenterAt.has(lang) ? this.opts.waitMs : 0) });
      ls.queue.sort((a, b) => a.lineId - b.lineId);
      if (ls.queue.length > ROOM_DUB_QUEUE_MAX) this.opts.log('rooms: server dub dropped stale line', { code: room.meta.code, lang, lineId: ls.queue.shift()!.lineId });
      this.next(room, s, lang, ls);
    }
  }

  private next(room: LiveRoom, s: RoomState, lang: string, ls: LangState): void {
    if (ls.busy || ls.timer || this.rooms.get(room.meta.code) !== s) return;
    const head = ls.queue[0];
    if (!head) return;
    const wait = head.readyAt - this.opts.now();
    if (wait > 0) {
      ls.timer = setTimeout(() => { ls.timer = null; this.next(room, s, lang, ls); }, wait);
      ls.timer.unref?.();
      return;
    }
    ls.queue.shift();
    void this.run(room, s, lang, ls, head.lineId);
  }

  private async run(room: LiveRoom, s: RoomState, lang: string, ls: LangState, lineId: number): Promise<void> {
    const want = this.wanted(room, s, lineId, lang);
    if (!want) { this.next(room, s, lang, ls); return; }
    ls.busy = true;
    ls.done.push(lineId);
    if (ls.done.length > DONE_KEEP) ls.done.shift();
    try {
      const text = want.line.translations[lang]?.trim() || await this.translate(room, want.line, lang);
      if (!want.listen) return;
      const clip = await this.opts.synthesize(text, lang, undefined, dubSpeed(ls.playEnd - this.opts.now()));
      // Re-check: the presenter may have voiced it meanwhile, the listeners may be gone.
      if (this.wanted(room, s, lineId, lang)?.listen) {
        this.opts.deliver(room, lineId, lang, clip);
        ls.playEnd = Math.max(this.opts.now(), ls.playEnd) + mp3DurationMs(clip.audio);
      }
    } catch (err) {
      this.opts.log('rooms: server dub failed', { code: room.meta.code, lang, lineId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      ls.busy = false;
      this.next(room, s, lang, ls);
    }
  }

  private async translate(room: LiveRoom, line: RoomLine, lang: string): Promise<string> {
    const text = await this.opts.translate!(line.original, line.originalLang ?? room.meta.originalLang, lang);
    if (!text) throw new Error('empty translation');
    this.opts.addTranslation(room, line.id, lang, text);
    return text;
  }

  /** The room left memory or ended: pending work is dropped. */
  forget(code: string): void {
    const s = this.rooms.get(code);
    if (!s) return;
    for (const ls of s.langs.values()) { if (ls.timer) clearTimeout(ls.timer); ls.timer = null; ls.queue = []; }
    this.rooms.delete(code);
  }

  stop(): void { for (const code of [...this.rooms.keys()]) this.forget(code); }
}
