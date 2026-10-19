/**
 * The gateway's own CPU speech server (`docker/kokoro-stream`) as a TTS target of the alias chains (`PUT
 * /v1/apps/:app/routes`), next to the rooms that already use it (`kokoroStreamTTS`):
 *
 *   - `{"provider": "kokoro-stream", "model": "hexgrad/kokoro-82m"}` — the streaming Kokoro the rooms speak with
 *     (`KOKORO_STREAM_URL` + `KOKORO_STREAM_API_KEY`). Mounted only when the key is set.
 *   - `{"provider": "pocket", "model": "pocket"}` — Pocket TTS (Kyutai, CPU) in the same server process
 *     (`POCKET_TTS=1` there). Mounted only when `POCKET_TTS_API_KEY` is set on the gateway (`POCKET_TTS_URL`, default
 *     `KOKORO_STREAM_URL`: the same server), so a gateway whose speech server has no Pocket yet keeps working.
 *
 * Both answer PCM only (24 kHz s16 mono; the gateway wraps it as WAV), so a request for mp3/opus/aac/flac skips them
 * (HTTP 415, a refusal: the chain moves on, no breaker is fed). The voice is chosen here from the request's `language`
 * (the desktop app sends "French", "Portuguese"… — the Qwen3-TTS names — or an ISO code) because both servers speak
 * the language of the voice: an English voice reading Portuguese is not understood. A voice the server knows is kept
 * when it speaks that language (`pf_dora`, `rafael`); any other (a Qwen3 preset like "Ryan", a cloned cast id) gets
 * the language's own voice, by gender where the server has one. No language and no voice that says it → refused.
 */

import { OpenAICompatTTSProvider, type OpenAICompatTTSConfig } from '../openai-compat/openai-compat-tts';
import type { ModelInfo, ProviderId, TTSAudioFormat, TTSProvider, TTSRequest, TTSResponse, VoiceInfo } from '../types';
import { genderOfVoice, type VoiceGender } from '../../../../config/tts-fallback-voices';
import { KOKORO_STREAM_PROVIDER, OWN_SPEECH_KEY_ENV, POCKET_PROVIDER } from './ids';

export * from './ids';

export const POCKET_MODEL = 'pocket';
const PCM_RATE = 24_000;
const SERVED_FORMATS: ReadonlySet<TTSAudioFormat> = new Set(['wav', 'pcm']);

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  english: 'en', french: 'fr', portuguese: 'pt', spanish: 'es', italian: 'it', german: 'de', dutch: 'nl',
  hindi: 'hi', japanese: 'ja', chinese: 'zh', korean: 'ko', russian: 'ru',
};

/** "Portuguese" / "pt-BR" / "pt" → "pt"; null when it is not a language this module knows. */
export function languageCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (LANGUAGE_NAMES[v]) return LANGUAGE_NAMES[v]!;
  const iso = /^([a-z]{2})([-_][a-z]{2,4})?$/.exec(v);
  return iso && Object.values(LANGUAGE_NAMES).includes(iso[1]!) ? iso[1]! : null;
}

/** Qwen3-TTS CustomVoice presets (the desktop app's `config::SPEAKERS`): their gender, for a stock voice of the same. */
export const QWEN_PRESET_GENDERS: Readonly<Record<string, VoiceGender>> = {
  Ryan: 'masculine', Aiden: 'masculine', Dylan: 'masculine', Eric: 'masculine', Uncle_Fu: 'masculine',
  Vivian: 'feminine', Serena: 'feminine', Ono_Anna: 'feminine', Sohee: 'feminine',
};

const genderOf = (voice: string): VoiceGender => genderOfVoice({ voice }, QWEN_PRESET_GENDERS);

// ── Kokoro (docker/kokoro-stream/export.py `VOICES`: one voice per language, all feminine) ──────────────────────────

/** The voices the streaming Kokoro carries, by language. Its phonemizer is picked by the voice's first letter. */
export const KOKORO_STREAM_VOICES: Readonly<Record<string, string>> = {
  en: 'af_heart', es: 'ef_dora', fr: 'ff_siwis', pt: 'pf_dora', it: 'if_sara', hi: 'hf_alpha',
};
const KOKORO_LETTER_LANGUAGE: Readonly<Record<string, string>> = { a: 'en', b: 'en', e: 'es', f: 'fr', i: 'it', p: 'pt', h: 'hi', j: 'ja', z: 'zh' };

/** Language of a Kokoro voice id (`pf_dora` → pt), null for anything else. */
export function kokoroVoiceLanguage(voice: string): string | null {
  const m = /^([a-z])[fm]_[a-z]+$/.exec(voice);
  return m ? KOKORO_LETTER_LANGUAGE[m[1]!] ?? null : null;
}

/** The streaming Kokoro's voice for this request, or null when it has none for the language. */
export function kokoroStreamVoice(requested: string, language: string | null): string | null {
  const lang = language ?? kokoroVoiceLanguage(requested);
  if (!lang) return null;
  if (Object.values(KOKORO_STREAM_VOICES).includes(requested) && kokoroVoiceLanguage(requested) === lang) return requested;
  return KOKORO_STREAM_VOICES[lang] ?? null;
}

// ── Pocket TTS (pocket_tts 3.3 predefined voices; one model per language) ─────────────────────────────────────────

/** Languages with a Pocket TTS model (its `config/<name>.yaml`), by ISO code. */
export const POCKET_LANGUAGES: Readonly<Record<string, string>> = {
  en: 'english', fr: 'french', de: 'german', pt: 'portuguese', es: 'spanish', it: 'italian', nl: 'dutch',
};

/** Predefined voices and the language each was recorded in (any of them speaks every language, with an accent). */
export const POCKET_VOICES: Readonly<Record<string, string>> = {
  rafael: 'pt', estelle: 'fr', lola: 'es', giovanni: 'it', juergen: 'de', daan: 'nl',
  alba: 'en', marius: 'en', javert: 'en', jean: 'en', fantine: 'en', cosette: 'en', eponine: 'en', azelma: 'en',
  anna: 'en', vera: 'en', charles: 'en', paul: 'en', george: 'en', mary: 'en', jane: 'en', michael: 'en', eve: 'en',
  bill_boerst: 'en', peter_yearsley: 'en', stuart_bell: 'en', caro_davy: 'en',
};

/** A Pocket voice per language and gender: the native voice, and for the other gender the closest one it has. */
export const POCKET_DEFAULT_VOICES: Readonly<Record<string, Record<VoiceGender, string>>> = {
  pt: { masculine: 'rafael', feminine: 'estelle' },
  fr: { masculine: 'jean', feminine: 'estelle' },
  es: { masculine: 'rafael', feminine: 'lola' },
  it: { masculine: 'giovanni', feminine: 'lola' },
  de: { masculine: 'juergen', feminine: 'alba' },
  en: { masculine: 'marius', feminine: 'alba' },
  nl: { masculine: 'daan', feminine: 'alba' },
};

/** Pocket voice + language for this request, or null when Pocket has no model for the language. */
export function pocketVoice(requested: string, language: string | null): { voice: string; language: string } | null {
  const own = Object.prototype.hasOwnProperty.call(POCKET_VOICES, requested) ? requested : null;
  const lang = language ?? (own ? POCKET_VOICES[own]! : kokoroVoiceLanguage(requested));
  if (!lang || !POCKET_LANGUAGES[lang]) return null;
  return { voice: own ?? POCKET_DEFAULT_VOICES[lang]![genderOf(requested)], language: lang };
}

// ── Providers ─────────────────────────────────────────────────────────────────────────────────────────────────────

const refused = (status: number, message: string) => Object.assign(new Error(message), { status, skipRetry: true });

/** OpenAI-compatible client of the speech server that also sends the request's `language` (Pocket needs it). */
class SpeechServerTTS extends OpenAICompatTTSProvider {
  protected override bodyExtras(request: TTSRequest): Record<string, unknown> {
    const language = request.extra?.language;
    return typeof language === 'string' && language ? { language } : {};
  }
}

const serverConfig = (providerId: ProviderId, baseURL: string, envKey: string): OpenAICompatTTSConfig => ({
  providerId, baseURL, envKey, models: [], voices: [], defaultFormat: 'pcm', allowedFormats: ['pcm'],
  passthroughVoices: true, pcmAsWavRate: PCM_RATE, streamAudio: true,
});

/**
 * A route target on the speech server: refuses what it cannot speak (format, language) before any call, and sends
 * the voice of the request's language.
 */
export class OwnSpeechTTS implements TTSProvider {
  readonly providerId: ProviderId;

  constructor(private readonly inner: TTSProvider, readonly engine: 'kokoro' | 'pocket') {
    this.providerId = inner.providerId;
  }

  isConfigured(): boolean { return (this.inner as { isConfigured?: () => boolean }).isConfigured?.() ?? true; }
  getModels(): ModelInfo[] { return []; }
  getVoices(): VoiceInfo[] { return []; }

  /** The request the server gets, or why this target cannot take it (thrown as a refusal). */
  prepare(request: TTSRequest): TTSRequest {
    const format = request.responseFormat ?? 'wav';
    if (!SERVED_FORMATS.has(format)) throw refused(415, `${this.engine} on the speech server answers wav or pcm, not ${format}`);
    const language = languageCode(request.extra?.language);
    if (this.engine === 'kokoro') {
      const voice = kokoroStreamVoice(request.voice, language);
      if (!voice) throw refused(400, `the speech server's Kokoro has no voice for ${language ?? `"${request.voice}" without a language`}`);
      return { ...request, voice, responseFormat: format, extra: language ? { language } : {} };
    }
    const pocket = pocketVoice(request.voice, language);
    if (!pocket) throw refused(400, `Pocket TTS does not speak ${language ?? `"${request.voice}" without a language`}`);
    return { ...request, model: POCKET_MODEL, voice: pocket.voice, responseFormat: format, extra: { language: pocket.language } };
  }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    return this.inner.synthesize(this.prepare(request));
  }

  async synthesizeStream(request: TTSRequest): Promise<ReadableStream<Uint8Array>> {
    return this.inner.synthesizeStream(this.prepare(request));
  }
}

const DEFAULT_SPEECH_SERVER = 'http://127.0.0.1:8899/v1';

/** The route targets, built from the environment (read at mount: a changed URL needs a restart, like the rooms'). */
export function ownSpeechProviders(env: Record<string, string | undefined> = process.env): Record<string, OwnSpeechTTS> {
  const kokoroUrl = env.KOKORO_STREAM_URL?.trim() || DEFAULT_SPEECH_SERVER;
  const pocketUrl = env.POCKET_TTS_URL?.trim() || kokoroUrl;
  return {
    [KOKORO_STREAM_PROVIDER]: new OwnSpeechTTS(new SpeechServerTTS(serverConfig('self-hosted', kokoroUrl, OWN_SPEECH_KEY_ENV[KOKORO_STREAM_PROVIDER]!)), 'kokoro'),
    [POCKET_PROVIDER]: new OwnSpeechTTS(new SpeechServerTTS(serverConfig('self-hosted', pocketUrl, OWN_SPEECH_KEY_ENV[POCKET_PROVIDER]!)), 'pocket'),
  };
}
