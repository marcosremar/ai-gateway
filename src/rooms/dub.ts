// ── AI Gateway — Live subtitle rooms: server-side dubbing ────────────────────
// When the presenter's app publishes text only, the gateway voices each line itself (Kokoro 82M through OpenRouter,
// MAI-Voice as fallback, each attempt time-bounded; injected by serve.ts as a `RoomSynthesize`) for the languages someone is actually listening to. Spending rules:
//   - a language is voiced only while at least one viewer explicitly listens to it (`listen` message), it has a
//     non-empty translation in the line and Kokoro has a voice for it;
//   - the presenter's own clips win: a room whose presenter sent a clip recently is left alone, and a line+language the
//     presenter voiced is never synthesized (checked before and after the call);
//   - per room and language one call at a time and one pending line: a newer line replaces an older pending one
//     (stale lines are dropped, a backlog cannot build up), and a line+language is voiced once.
// Failures are logged, never thrown into the publish path.

import type { LiveRoom } from './service';

/** Kokoro v1.0 voice per language (primary subtag). Languages Kokoro does not speak are not voiced. */
export const KOKORO_ROOM_VOICES: Readonly<Record<string, string>> = {
  en: 'af_heart', fr: 'ff_siwis', es: 'ef_dora', pt: 'pf_dora', it: 'if_sara', ja: 'jf_alpha', zh: 'zf_xiaobei', hi: 'hf_alpha',
};

/** The Kokoro voice for a room language (`pt-BR` → `pf_dora`), or null when Kokoro does not speak it. */
export function kokoroVoice(lang: string): string | null {
  return KOKORO_ROOM_VOICES[lang.split('-')[0]!.toLowerCase()] ?? null;
}

/** One synthesized clip: audio bytes and their container (`mp3`, `wav`…). */
export interface RoomClip { audio: Buffer; format: string }

/** Speech synthesis for rooms: text + room language → clip. Throws on failure; `signal` aborts the upstream call. */
export type RoomSynthesize = (text: string, lang: string, signal?: AbortSignal) => Promise<RoomClip>;

/** The structural slice of a TTS provider used by the room synthesizers (the OpenRouter provider fits). */
export interface TtsLike {
  synthesize(req: { input: string; model: string; voice: string; responseFormat?: 'mp3'; signal?: AbortSignal }): Promise<{ audio: Buffer }>;
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

function openRouterSynthesize(provider: TtsLike, model: string, voices: Readonly<Record<string, string>>): RoomSynthesize {
  return async (text, lang, signal) => {
    const voice = voices[lang.split('-')[0]!.toLowerCase()];
    if (!voice) throw new Error(`${model} has no voice for ${lang}`);
    const res = await provider.synthesize({ input: text, model, voice, responseFormat: 'mp3', signal });
    if (!res.audio.length) throw new Error(`${model}: empty audio`);
    return { audio: res.audio, format: 'mp3' };
  };
}

/** Kokoro 82M (mp3) through an OpenAI-compatible TTS provider — OpenRouter in production. */
export const kokoroSynthesize = (provider: TtsLike): RoomSynthesize => openRouterSynthesize(provider, KOKORO_MODEL, KOKORO_ROOM_VOICES);

/** MAI-Voice 2.1 Flash (mp3) through OpenRouter, for the languages in `MAI_ROOM_VOICES`. */
export const maiSynthesize = (provider: TtsLike): RoomSynthesize => openRouterSynthesize(provider, MAI_MODEL, MAI_ROOM_VOICES);

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
  return async (text, lang) => {
    const errors: string[] = [];
    for (const synth of chain) {
      try {
        return await withTimeout(signal => synth(text, lang, signal), attemptTimeoutMs);
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
  /** Wait after a line before voicing it, so the presenter's own clip can arrive first. */
  waitMs: number;
  /** A room whose presenter sent a clip within this window is not voiced by the server. */
  presenterQuietMs: number;
  now: () => number;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

interface LangState { pending: number | null; busy: boolean; timer: ReturnType<typeof setTimeout> | null; done: number[] }
interface RoomState { presenterAt: number; presenterKeys: Set<string>; langs: Map<string, LangState> }

/** Line ids remembered per language / presenter clips remembered per room (dedup only; old entries roll off). */
const DONE_KEEP = 64;
const PRESENTER_KEYS_KEEP = 512;

export class RoomDubber {
  private readonly rooms = new Map<string, RoomState>();

  constructor(private readonly opts: RoomDubberOptions) {}

  /** Languages the server can voice in this room (Kokoro-supported). */
  voicedLanguages(room: LiveRoom): string[] {
    return room.meta.languages.filter(l => kokoroVoice(l) !== null);
  }

  private state(code: string): RoomState {
    let s = this.rooms.get(code);
    if (!s) { s = { presenterAt: -Infinity, presenterKeys: new Set(), langs: new Map() }; this.rooms.set(code, s); }
    return s;
  }

  private presenterActive(s: RoomState): boolean {
    return this.opts.now() - s.presenterAt < this.opts.presenterQuietMs;
  }

  /** The presenter published a clip: it wins over the server for that line and, for a while, for the whole room. */
  onPresenterClip(room: LiveRoom, lineId: number, lang: string): void {
    const s = this.state(room.meta.code);
    s.presenterAt = this.opts.now();
    s.presenterKeys.add(`${lineId}:${lang}`);
    if (s.presenterKeys.size > PRESENTER_KEYS_KEEP) s.presenterKeys.delete(s.presenterKeys.values().next().value!);
  }

  /** Whether a line+language should be voiced right now (every spending condition). */
  private eligible(room: LiveRoom, s: RoomState, lineId: number, lang: string): string | null {
    if (room.meta.ended || room.meta.serverDub === false) return null;
    if (this.presenterActive(s) || s.presenterKeys.has(`${lineId}:${lang}`)) return null;
    const at = room.index.get(lineId);
    const text = at === undefined ? '' : (room.lines[at]?.translations[lang] ?? '').trim();
    if (!text || !kokoroVoice(lang)) return null;
    for (const v of room.viewers) if (v.listening?.(lang)) return text;
    return null;
  }

  /** A line was published (added or replaced): schedule its voicing for the languages being listened to. */
  onLine(room: LiveRoom, lineId: number): void {
    if (room.meta.serverDub === false || (this.opts.available && !this.opts.available())) return;
    const s = this.state(room.meta.code);
    if (this.presenterActive(s)) return;
    const at = room.index.get(lineId);
    const line = at === undefined ? undefined : room.lines[at];
    if (!line) return;
    for (const lang of Object.keys(line.translations)) {
      if (!this.eligible(room, s, lineId, lang)) continue;
      let ls = s.langs.get(lang);
      if (!ls) { ls = { pending: null, busy: false, timer: null, done: [] }; s.langs.set(lang, ls); }
      if (ls.done.includes(lineId)) continue;
      if (ls.pending !== null && ls.pending > lineId) continue; // an older line arriving late: already stale
      if (ls.pending !== null && ls.pending !== lineId) this.opts.log('rooms: server dub dropped stale line', { code: room.meta.code, lang, lineId: ls.pending });
      ls.pending = lineId;
      if (!ls.timer && !ls.busy) ls.timer = this.arm(room, s, lang, ls);
    }
  }

  private arm(room: LiveRoom, s: RoomState, lang: string, ls: LangState): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => { ls.timer = null; void this.run(room, s, lang, ls); }, this.opts.waitMs);
    t.unref?.();
    return t;
  }

  private async run(room: LiveRoom, s: RoomState, lang: string, ls: LangState): Promise<void> {
    const lineId = ls.pending;
    ls.pending = null;
    if (lineId === null || ls.busy || this.rooms.get(room.meta.code) !== s) return;
    const text = this.eligible(room, s, lineId, lang);
    if (!text) return;
    ls.busy = true;
    ls.done.push(lineId);
    if (ls.done.length > DONE_KEEP) ls.done.shift();
    try {
      const clip = await this.opts.synthesize(text, lang);
      // Re-check: the presenter may have voiced it meanwhile, the listeners may be gone.
      if (this.eligible(room, s, lineId, lang)) this.opts.deliver(room, lineId, lang, clip);
    } catch (err) {
      this.opts.log('rooms: server dub failed', { code: room.meta.code, lang, lineId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      ls.busy = false;
      if (ls.pending !== null && !ls.timer) ls.timer = this.arm(room, s, lang, ls);
    }
  }

  /** The room left memory or ended: pending work is dropped. */
  forget(code: string): void {
    const s = this.rooms.get(code);
    if (!s) return;
    for (const ls of s.langs.values()) { if (ls.timer) clearTimeout(ls.timer); ls.timer = null; ls.pending = null; }
    this.rooms.delete(code);
  }

  stop(): void { for (const code of [...this.rooms.keys()]) this.forget(code); }
}
