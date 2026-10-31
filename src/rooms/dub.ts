// ── AI Gateway — Live subtitle rooms: server-side dubbing ────────────────────
// When the presenter's app publishes text only, the gateway voices each line itself (through the gateway TTS module,
// src/tts, injected by serve.ts) for the languages someone is actually listening to. Voice, first that can:
//   1. the speaker's cloned voice (Qwen3-TTS Base) while the clone deployment already serves and a reference arrived;
//   2. Pocket TTS (own speech server, one native voice per language: en fr de pt es it nl) when it is mounted;
//   3. Kokoro (own speech server, then OpenRouter) — the languages Pocket lacks, and a Pocket 503 loading/busy or error.
// Spending rules:
//   - a language is voiced only while at least one viewer explicitly listens to it (`listen` message), it has a
//     non-empty translation in the line and a voice above speaks it;
//   - the presenter's own clips win: a language the presenter sent a clip for recently is left alone (other languages are
//     still voiced — the desktop app dubs one language, viewers may listen to another), and a line+language the
//     presenter voiced is never synthesized (checked before and after the call);
//   - a draft line (the presenter will still grow it) is not voiced; its final version is;
//   - each room language is a `TtsStream` (src/tts): more calls at once while the provider is slow, clips in line order,
//     a bounded backlog, faster speech while the listeners have audio queued; a translation goes out as soon as it is
//     ready, and a line+language is voiced once.
// Failures are logged, never thrown into the publish path.

import {
  KOKORO_VOICES, POCKET_LANGUAGE_CODES, QWEN_LANGUAGES, TTS_MAX_PARALLEL, TTS_MAX_SPEED, TtsStream, kokoroVoice, pocketRoomVoice, primaryLanguage as primary, qwenSpeaks, stretchClip, trimClip,
  type DeploymentClone, type LanguageTts, type TtsClip, type VoiceRef,
} from '../tts';
import type { LiveRoom } from './service';
import type { RoomLine } from './types';

export type RoomTranslate = (text: string, from: string | null, to: string) => Promise<string>;
export type RoomCondense = (text: string, lang: string, maxChars: number) => Promise<string>;

export interface ChatLike {
  chat(req: { model: string; messages: { role: 'system' | 'user'; content: string }[]; temperature?: number; timeoutMs?: number; extraBody?: Record<string, unknown> }): Promise<{ content: string }>;
}

const TRANSLATE_MODEL = 'google/gemini-2.5-flash-lite';
const TRANSLATE_TIMEOUT_MS = 6_000;
const CONDENSE_TIMEOUT_MS = 2_500;
const VOICE_CHARS_PER_SECOND = 16.5;
const SHORTEST_VOICE_SHARE = 0.6;
const WORTH_SHORTENING_SHARE = 0.9;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
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

export const spokenText = (reply: string): string => reply.replace(/\s*\(\d+[^)]*\)\s*$/u, '').replace(/[*"“”«»]/gu, '').trim();

export const openRouterCondense = (provider: ChatLike): RoomCondense => async (text, lang, maxChars) => {
  const res = await provider.chat({
    model: TRANSLATE_MODEL,
    temperature: 0,
    timeoutMs: CONDENSE_TIMEOUT_MS,
    extraBody: { reasoning: { enabled: false } },
    messages: [
      { role: 'system', content: `This is what a speaker just said, for a live voice-over in ${languageName(lang)}. Say the same thing in ${languageName(lang)} in at most ${maxChars} characters. The listener must get every idea, fact, name and number; the words can change freely, and only filler, repetition and wording may go. Reply with the new text only.` },
      { role: 'user', content: text },
    ],
  });
  return spokenText(res.content);
};

export type RoomVoiceClone = DeploymentClone;

/** Pocket TTS (serve.ts: `pocketTts` from src/tts) — the first non-clone voice for the languages it speaks. */
export interface RoomPocket {
  synthesize: LanguageTts;
  /** False while Pocket is not mounted (no POCKET_TTS_API_KEY): Kokoro alone, as before. */
  available: () => boolean;
}

export interface RoomDubberOptions {
  /** Kokoro: the voice of the languages Pocket does not speak, and the fallback when Pocket cannot answer. */
  synthesize: LanguageTts;
  pocket?: RoomPocket;
  clone?: RoomVoiceClone;
  /** False while the synthesizer cannot work (e.g. no API key): nothing is scheduled. Default: always available. */
  available?: () => boolean;
  /** Delivers a clip to the room's listeners of `lang`. */
  deliver: (room: LiveRoom, lineId: number, lang: string, clip: TtsClip, streamed: boolean) => void;
  deliverChunk: (room: LiveRoom, lineId: number, lang: string, pcm: Buffer, seq: number) => void;
  translate?: RoomTranslate;
  /** Says a text in fewer characters, keeping its whole meaning (never the subtitle); only in a `steadyDub` room. */
  condense?: RoomCondense;
  addTranslation: (room: LiveRoom, lineId: number, lang: string, text: string) => void;
  /** Wait after a line before voicing it, so the presenter's own clip can arrive first. */
  waitMs: number;
  /** A room whose presenter sent a clip within this window is not voiced by the server. */
  presenterQuietMs: number;
  now: () => number;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

interface LangState { stream: TtsStream; done: number[] }
interface RoomState { presenterAt: Map<string, number>; presenterKeys: Set<string>; langs: Map<string, LangState>; voices: Map<string, VoiceRef> }

/** Line ids remembered per language / presenter clips remembered per room (dedup only; old entries roll off). */
const DONE_KEEP = 64;
const PRESENTER_KEYS_KEEP = 512;

const KOKORO_LETTERS_PER_SECOND = 14;
const SLOWEST_PACE = 0.85;
const FASTEST_PACE = 1.2;

export function speakerPace(line: RoomLine): number {
  const letters = line.original.match(/\p{L}/gu)?.length ?? 0;
  if (!line.speechMs || letters < 10) return 1;
  const pace = (letters * 1000) / line.speechMs / KOKORO_LETTERS_PER_SECOND;
  return Math.min(FASTEST_PACE, Math.max(SLOWEST_PACE, pace));
}

export const speakable = (text: string): string => /[.!?…。！？][\s"'»”)]*$/u.test(text) ? text : `${text}.`;

export const pacedSpeed = (catchUp: number, line: RoomLine): number =>
  Math.round(Math.min(TTS_MAX_SPEED, catchUp * speakerPace(line)) * 20) / 20;

export class RoomDubber {
  private readonly rooms = new Map<string, RoomState>();

  constructor(private readonly opts: RoomDubberOptions) {}

  /** Languages the server can voice in this room (clone, Pocket or Kokoro). */
  voicedLanguages(room: LiveRoom): string[] {
    return room.meta.languages.filter(l => this.speaks(room, l));
  }

  setVoice(room: LiveRoom, lang: string, voice: VoiceRef): void {
    this.state(room.meta.code).voices.set(primary(lang), voice);
  }

  private cloning(room: LiveRoom): boolean {
    return !!this.rooms.get(room.meta.code)?.voices.size && !!this.opts.clone?.ready();
  }

  private speaks(room: LiveRoom, lang: string): boolean {
    return this.cloning(room) ? qwenSpeaks(lang) : this.stockSpeaks(lang);
  }

  /** Pocket is mounted and has a voice for `lang`. */
  private pocketSpeaks(lang: string): boolean {
    return pocketRoomVoice(lang) !== null && !!this.opts.pocket?.available();
  }

  /** The voices that need no reference: Pocket, then Kokoro. */
  private stockSpeaks(lang: string): boolean {
    return this.pocketSpeaks(lang) || kokoroVoice(lang) !== null;
  }

  /** Languages the presenter does not publish: the server translates and voices them for whoever picks one. */
  extraLanguages(room: LiveRoom): string[] {
    if (!this.opts.translate) return [];
    const taken = [...room.meta.languages, room.meta.originalLang ?? ''].map(primary);
    const stock = [...new Set([...Object.keys(KOKORO_VOICES), ...(this.opts.pocket?.available() ? POCKET_LANGUAGE_CODES : [])])];
    return (this.cloning(room) ? QWEN_LANGUAGES : stock).filter(l => !taken.includes(l));
  }

  private state(code: string): RoomState {
    let s = this.rooms.get(code);
    if (!s) { s = { presenterAt: new Map(), presenterKeys: new Set(), langs: new Map(), voices: new Map() }; this.rooms.set(code, s); }
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
    if (!line || line.draft || !this.speaks(room, lang)) return null;
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
    if (room.meta.serverDub === false || !this.available()) return;
    const s = this.state(room.meta.code);
    const at = room.index.get(lineId);
    const line = at === undefined ? undefined : room.lines[at];
    if (!line) return;
    for (const lang of new Set([...Object.keys(line.translations), ...this.extraLanguages(room)])) {
      if (!this.wanted(room, s, lineId, lang)) continue;
      const ls = s.langs.get(lang) ?? this.langState(room, s, lang);
      if (ls.done.some(d => d >= lineId) || ls.stream.has(lineId)) continue;
      ls.stream.push(lineId, this.opts.now() + (s.presenterAt.has(lang) ? this.opts.waitMs : 0));
    }
  }

  /** Kokoro or Pocket can work (a key is set). */
  private available(): boolean {
    return !this.opts.available || this.opts.available() || !!this.opts.pocket?.available();
  }

  private langState(room: LiveRoom, s: RoomState, lang: string): LangState {
    const ls: LangState = {
      done: [],
      stream: new TtsStream({
        now: this.opts.now,
        synthesize: (lineId, speed, merged) => this.voice(room, s, lang, ls, lineId, speed, merged),
        mergesWaiting: () => room.meta.steadyDub === true,
        deliver: (lineId, clip, streamed) => {
          // Re-check: the presenter may have voiced it meanwhile, the listeners may be gone.
          if (!this.stillWanted(room, s, lineId, lang)) return false;
          this.opts.deliver(room, lineId, lang, clip, streamed);
          return true;
        },
        deliverChunk: (lineId, pcm, seq) => {
          if (!this.stillWanted(room, s, lineId, lang)) return false;
          this.opts.deliverChunk(room, lineId, lang, pcm, seq);
          return true;
        },
        dropped: (lineId) => this.opts.log('rooms: server dub dropped stale line', { code: room.meta.code, lang, lineId }),
        // Pocket speaks one sentence at a time per language (a second call waits ≤ 2 s, then 503 busy → Kokoro, another
        // voice): one call at a time keeps the room on one voice. It speaks ~2× faster than real time, so the next line
        // is ready before the listeners finish this one.
        maxParallel: () => (!this.cloning(room) && this.pocketSpeaks(lang) ? 1 : TTS_MAX_PARALLEL),
      }),
    };
    s.langs.set(lang, ls);
    return ls;
  }

  private stillWanted(room: LiveRoom, s: RoomState, lineId: number, lang: string): boolean {
    return this.rooms.get(room.meta.code) === s && Boolean(this.wanted(room, s, lineId, lang)?.listen);
  }

  private async voice(room: LiveRoom, s: RoomState, lang: string, ls: LangState, lineId: number, speed: number, merged: number[]): Promise<TtsClip | null> {
    const want = this.wanted(room, s, lineId, lang);
    if (!want) return null;
    ls.done.push(...merged, lineId);
    if (ls.done.length > DONE_KEEP) ls.done.splice(0, ls.done.length - DONE_KEEP);
    try {
      const lines = [...merged.map(id => this.wanted(room, s, id, lang)?.line).filter(line => line !== undefined), want.line];
      const texts = await Promise.all(lines.map(async line => line.translations[lang]?.trim() || await this.translate(room, line, lang)));
      if (!want.listen) return null;
      const text = texts.map(speakable).join(' ');
      const voiced = room.meta.steadyDub ? await this.fitted(text, lines, lang) : texts.at(-1)!;
      return await this.speak(room, s, want.line, speakable(voiced), lang, speed);
    } catch (err) {
      this.opts.log('rooms: server dub failed', { code: room.meta.code, lang, lineId, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private async fitted(text: string, lines: RoomLine[], lang: string): Promise<string> {
    const spokenMs = lines.reduce((sum, line) => sum + (line.speechMs ?? 0), 0);
    const fits = lines.length > 1 ? 0 : spokenMs ? (spokenMs / 1000) * VOICE_CHARS_PER_SECOND : text.length;
    const maxChars = Math.round(Math.max(fits, text.length * SHORTEST_VOICE_SHARE));
    if (!this.opts.condense || maxChars >= text.length * WORTH_SHORTENING_SHARE) return text;
    try {
      const short = await this.opts.condense(text, lang, maxChars);
      return short && short.length < text.length ? short : text;
    } catch (err) {
      this.opts.log('rooms: shortening the dub failed, full text', { lang, error: errorText(err) });
      return text;
    }
  }

  private async speak(room: LiveRoom, s: RoomState, line: RoomLine, text: string, lang: string, speed: number): Promise<TtsClip> {
    const voice = this.cloning(room) ? s.voices.get(primary(line.originalLang ?? room.meta.originalLang ?? '')) : undefined;
    if (voice) {
      try {
        return this.paced(room, { ...await this.opts.clone!.synthesize(text, lang, voice), engine: 'clone' }, speed);
      } catch (err) {
        if (!this.stockSpeaks(lang)) throw err;
        this.opts.log('rooms: voice clone failed, stock voice instead', { code: room.meta.code, lang, lineId: line.id, error: errorText(err) });
      }
    }
    if (this.pocketSpeaks(lang)) {
      try {
        // No speed: Pocket has none (see pocketTts) — the speaker's pace and the catch-up apply to Kokoro only.
        return this.paced(room, this.trimmed(room, { ...await this.opts.pocket!.synthesize(text, lang), engine: 'pocket' }), speed);
      } catch (err) {
        if (!kokoroVoice(lang)) throw err;
        this.opts.log('rooms: Pocket failed, Kokoro instead', { code: room.meta.code, lang, lineId: line.id, error: errorText(err) });
      }
    }
    return this.trimmed(room, { ...await this.opts.synthesize(text, lang, pacedSpeed(speed, line)), engine: 'kokoro' });
  }

  private trimmed(room: LiveRoom, clip: TtsClip): TtsClip {
    return room.meta.steadyDub ? trimClip(clip) : clip;
  }

  private paced(room: LiveRoom, clip: TtsClip, speed: number): TtsClip {
    return room.meta.steadyDub ? stretchClip(clip, speed) : clip;
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
    for (const ls of s.langs.values()) ls.stream.close();
    this.rooms.delete(code);
  }

  stop(): void { for (const code of [...this.rooms.keys()]) this.forget(code); }
}
