// ── AI Gateway — Live subtitle rooms: server-side dubbing ────────────────────
// When the presenter's app publishes text only, the gateway voices each line itself (Kokoro 82M through OpenRouter,
// injected by serve.ts as a `RoomSynthesize`) for the languages someone is actually listening to. Spending rules:
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

/** Speech synthesis for rooms: text + voice → clip. Throws on failure. */
export type RoomSynthesize = (text: string, voice: string) => Promise<RoomClip>;

/** The structural slice of a TTS provider used by `kokoroSynthesize` (the OpenRouter provider fits). */
export interface TtsLike {
  synthesize(req: { input: string; model: string; voice: string; responseFormat?: 'mp3' }): Promise<{ audio: Buffer }>;
}

export const KOKORO_MODEL = 'hexgrad/kokoro-82m';

/** Kokoro 82M (mp3) through an OpenAI-compatible TTS provider — OpenRouter in production. */
export function kokoroSynthesize(provider: TtsLike): RoomSynthesize {
  return async (text, voice) => {
    const res = await provider.synthesize({ input: text, model: KOKORO_MODEL, voice, responseFormat: 'mp3' });
    if (!res.audio.length) throw new Error('empty audio');
    return { audio: res.audio, format: 'mp3' };
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
    const voice = kokoroVoice(lang);
    if (!text || !voice) return;
    ls.busy = true;
    ls.done.push(lineId);
    if (ls.done.length > DONE_KEEP) ls.done.shift();
    try {
      const clip = await this.opts.synthesize(text, voice);
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
