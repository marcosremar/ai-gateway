/**
 * Stock voices of TTS fallbacks that cannot clone, chosen by the GENDER of the voice the client asked for.
 *
 * An app may ask its alias for a cloned cast voice (`br-f-01`, `pt-PT-1baab6`, …) that only its self-hosted
 * deployment knows. A route entry with `voices: { feminine, masculine }` gives the fallback a stock voice of the same
 * gender — the character keeps at least its gender when the GPU is cold. The app sends the entry (and, when its voice
 * ids do not say the gender, a `voiceGenders` table) in its routes (`PUT /v1/apps/:app/routes`); the gateway's code
 * names no app.
 *
 * Known stock voices of the OpenRouter TTS models an app may put in such an entry:
 *
 *   gender           Qwen-Audio 3.0 TTS Flash (OpenRouter)   Kokoro 82M (OpenRouter)
 *   feminine         Cherry                                   pf_dora   (pt-BR female)
 *   masculine        Ethan                                    pm_alex   (pt-BR male)
 *
 * Qwen-Audio: Cherry and Ethan are the multilingual stock voices of the Qwen TTS family (DashScope voice list;
 * Portuguese is among its languages). Kokoro: the two Brazilian Portuguese voices of Kokoro v1.0 (`pf_dora`, `pm_alex`).
 *
 * Gender of the requested voice, in order: the entry's `voiceGenders` table, the `xx-f-` / `xx-m-` slug pattern, the
 * gender letter of the request's Kokoro `fallback_voice` (`pf_…`, `pm_…`), else feminine.
 */

export type VoiceGender = 'feminine' | 'masculine';

export interface VoiceByGender { feminine: string; masculine: string }

export const QWEN_AUDIO_TTS_MODEL = 'qwen/qwen-audio-3.0-tts-flash';
export const QWEN_AUDIO_VOICES: VoiceByGender = { feminine: 'Cherry', masculine: 'Ethan' };

export const KOKORO_TTS_MODEL = 'hexgrad/kokoro-82m';
export const KOKORO_VOICES: VoiceByGender = { feminine: 'pf_dora', masculine: 'pm_alex' };

export function genderOfVoice(
  request: { voice: string; fallbackVoice?: string }, genders: Record<string, VoiceGender> = {},
): VoiceGender {
  const known = Object.prototype.hasOwnProperty.call(genders, request.voice) ? genders[request.voice] : undefined;
  if (known) return known;
  const slug = /^[a-z]{2}-([fm])-/i.exec(request.voice);
  if (slug) return slug[1].toLowerCase() === 'm' ? 'masculine' : 'feminine';
  const kokoro = /^[a-z]([fm])_/i.exec(request.fallbackVoice ?? '');
  if (kokoro) return kokoro[1].toLowerCase() === 'm' ? 'masculine' : 'feminine';
  return 'feminine';
}

/**
 * `RouteTarget.voiceFor` for a stock-voice fallback. `preferFallbackVoice`: the request's own `fallback_voice` wins
 * (e.g. a client that computes the Kokoro voice per character, like `pm_santa` for deep voices).
 */
export function voiceForGender(
  voices: VoiceByGender, opts: { preferFallbackVoice?: boolean; genders?: Record<string, VoiceGender> } = {},
) {
  return (request: { voice: string; fallbackVoice?: string }): string =>
    (opts.preferFallbackVoice && request.fallbackVoice) || voices[genderOfVoice(request, opts.genders)];
}
