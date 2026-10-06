/**
 * Voices of the parle TTS fallbacks (OpenRouter), chosen by the GENDER of the cast voice the client asked for.
 *
 * The parle client asks `parle-tts` for a cast voice id (`br-f-01`, `pt-PT-1baab6`, …): the self-hosted Qwen3-TTS
 * Base clones it from its reference recording. The fallbacks cannot clone, so each one gets a stock voice of the same
 * gender — the character keeps at least its gender when the GPU is cold.
 *
 *   gender           Qwen-Audio 3.0 TTS Flash (OpenRouter)   Kokoro 82M (OpenRouter)
 *   feminine         Cherry                                   pf_dora   (pt-BR female)
 *   masculine        Ethan                                    pm_alex   (pt-BR male)
 *
 * Qwen-Audio: Cherry and Ethan are the multilingual stock voices of the Qwen TTS family (DashScope voice list;
 * Portuguese is among its languages). Kokoro: the two Brazilian Portuguese voices of Kokoro v1.0 (`pf_dora`,
 * `pm_alex`); `pm_santa` (deep) is chosen by the parle client itself and arrives as `fallback_voice`.
 *
 * Gender of the requested voice, in order: the cast table below (copy of parle `backend/speech/qwen-voices.json`),
 * the `br-f-` / `br-m-` slug pattern, the gender letter of the request's Kokoro `fallback_voice` (`pf_…`, `pm_…`),
 * else feminine.
 */

export type VoiceGender = 'feminine' | 'masculine';

export interface VoiceByGender { feminine: string; masculine: string }

export const QWEN_AUDIO_TTS_MODEL = 'qwen/qwen-audio-3.0-tts-flash';
export const QWEN_AUDIO_VOICES: VoiceByGender = { feminine: 'Cherry', masculine: 'Ethan' };

export const KOKORO_TTS_MODEL = 'hexgrad/kokoro-82m';
export const KOKORO_VOICES: VoiceByGender = { feminine: 'pf_dora', masculine: 'pm_alex' };

/** parle cast voices (backend/speech/qwen-voices.json) → gender. */
export const CAST_VOICE_GENDER: Record<string, VoiceGender> = {
  'pt-PT-1baab6': 'masculine',
  'pt-PT-259e66': 'masculine',
  'pt-PT-2537db': 'feminine',
  'pt-PT-2e0907': 'feminine',
  'br-f-01': 'feminine',
  'br-f-03': 'feminine',
  'br-f-04': 'feminine',
  'br-m-02': 'masculine',
  'br-m-04': 'masculine',
  'br-m-08': 'masculine',
};

export function genderOfVoice(request: { voice: string; fallbackVoice?: string }): VoiceGender {
  const cast = CAST_VOICE_GENDER[request.voice];
  if (cast) return cast;
  const slug = /^[a-z]{2}-([fm])-/i.exec(request.voice);
  if (slug) return slug[1].toLowerCase() === 'm' ? 'masculine' : 'feminine';
  const kokoro = /^[a-z]([fm])_/i.exec(request.fallbackVoice ?? '');
  if (kokoro) return kokoro[1].toLowerCase() === 'm' ? 'masculine' : 'feminine';
  return 'feminine';
}

/**
 * `RouteTarget.voiceFor` for a stock-voice fallback. `preferFallbackVoice`: the request's own `fallback_voice` wins
 * (the parle client computes the Kokoro voice per character, e.g. `pm_santa` for deep voices).
 */
export function voiceForGender(voices: VoiceByGender, preferFallbackVoice = false) {
  return (request: { voice: string; fallbackVoice?: string }): string =>
    (preferFallbackVoice && request.fallbackVoice) || voices[genderOfVoice(request)];
}
