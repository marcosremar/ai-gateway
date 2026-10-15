/**
 * Every alias chain ends in the cloud (owner decision 2026-10-12): a chain of STT, chat (LLM, translation) or TTS that
 * has only `deployment:` links answers 503 the moment its GPU is off (babelcast audit, 2026-10-12: `babelcast-stt` and
 * `babelcast-tts` had no cloud link, so the app could neither transcribe nor speak with the GPUs scaled to zero).
 *
 * A chain without a cloud link gets the stage's default appended — when an app sends its routes, when the stored
 * routes are loaded at boot, and when the chains are mounted (MODEL_ROUTES included) — and the gateway logs what it
 * added. Routes that explicitly ask for no cloud fallback (`"cloudFallback": false`) are refused.
 *
 * Defaults: the models parle already uses and measured as its fallback (gateway report 2026-10-12, M5/M6/M11):
 *   STT  OpenRouter whisper-large-v3-turbo (0.5–0.9 s), then Groq;
 *   chat OpenRouter gemini-2.5-flash-lite, reasoning off (0.42–0.62 s, against 0.77–1.38 s for llama-3.3-70b);
 *   TTS  OpenRouter MAI-Voice 2.1 flash, then Kokoro 82M — stock voices by the gender of the requested voice, since a
 *        cloud TTS cannot speak an app's cloned cast voice (`tts-fallback-voices.ts`).
 */

import type { ModelRoutesSpec, RouteEntrySpec } from './serve-providers';
import { KOKORO_TTS_MODEL } from './tts-fallback-voices';
import { OPENAI_COMPATIBLE } from '../gateway/providers/cloud/openai-compat/local-link';

type Stage = keyof ModelRoutesSpec;
const STAGES: Stage[] = ['chat', 'stt', 'tts'];

export const MAI_VOICE_TTS_MODEL = 'microsoft/mai-voice-2.1-flash';

export const DEFAULT_CLOUD_FALLBACK: Record<Stage, RouteEntrySpec[]> = {
  stt: [
    { provider: 'openrouter', model: 'openai/whisper-large-v3-turbo' },
    { provider: 'groq', model: 'whisper-large-v3-turbo' },
  ],
  chat: [{ provider: 'openrouter', model: 'google/gemini-2.5-flash-lite', extraBody: { reasoning: { enabled: false } } }],
  tts: [
    { provider: 'openrouter', model: MAI_VOICE_TTS_MODEL, voices: { feminine: 'en-US-Harper:MAI-Voice-2-Flash', masculine: 'en-US-Ethan:MAI-Voice-2-Flash' } },
    { provider: 'openrouter', model: KOKORO_TTS_MODEL, voices: { feminine: 'af_heart', masculine: 'am_michael' }, preferFallbackVoice: true },
  ],
};

export const isCloudLink = (e: RouteEntrySpec): boolean => e.provider !== 'deployment' && e.provider !== OPENAI_COMPATIBLE;

export interface CloudFallbackAdded { stage: Stage; alias: string; added: string[] }

/** The routes with the stage default appended to every chain that has no cloud link, and what was appended. */
export function withCloudFallback(routes: ModelRoutesSpec): { routes: ModelRoutesSpec; added: CloudFallbackAdded[] } {
  const out: ModelRoutesSpec = {};
  const added: CloudFallbackAdded[] = [];
  for (const stage of STAGES) {
    const byAlias = routes[stage];
    if (!byAlias) continue;
    out[stage] = {};
    for (const [alias, chain] of Object.entries(byAlias)) {
      // `*` is the generic chat fallback itself, not an alias.
      if (alias === '*' || chain.some(isCloudLink)) { out[stage]![alias] = chain; continue; }
      const defaults = DEFAULT_CLOUD_FALLBACK[stage];
      out[stage]![alias] = [...chain, ...defaults.map(e => structuredClone(e))];
      added.push({ stage, alias, added: defaults.map(e => `${e.provider}:${e.model}`) });
    }
  }
  return { routes: out, added };
}

/** `stage|provider|model|extraBody` of the defaults: targets the gateway itself adds, so an app key may name them too. */
export function defaultCloudTargets(): Set<string> {
  return new Set(STAGES.flatMap(stage => DEFAULT_CLOUD_FALLBACK[stage].map(e => `${stage}|${e.provider}|${e.model}|${JSON.stringify(e.extraBody ?? null)}`)));
}
