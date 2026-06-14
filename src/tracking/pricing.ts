/**
 * Default pricing table — cost per 1M tokens for known providers/models.
 *
 * Prices are approximations. Override with your own table if needed.
 */

export interface ModelPricing {
  /** Cost in USD per 1M input tokens */
  inputPer1M: number;
  /** Cost in USD per 1M output tokens */
  outputPer1M: number;
}

/**
 * #529 — per-unit pricing for providers that DON'T bill per token.
 *
 * `estimateRequestCost` multiplies the token-based {@link ModelPricing} by
 * `inputTokens`, but OpenAI TTS bills per *character* and Whisper/STT bills per
 * *audio-minute*. Passing characters or minutes as "tokens" silently produces a
 * meaningless cost. This type lets callers price by the unit the provider
 * actually invoices, so TTS/STT spend is real instead of an artifact of token
 * counts that don't exist for audio.
 */
export type CostUnit = 'token' | 'character' | 'minute' | 'request';

export interface UnitPricing {
  /** What the provider actually bills for. */
  unit: CostUnit;
  /** USD per 1 unit (e.g. per character, per audio-minute, per request). */
  usdPerUnit: number;
}

/**
 * #529 — per-unit (char/minute/request) rates for audio models that don't bill
 * per token. Keyed like {@link DEFAULT_PRICING_TABLE} ("provider/model" then
 * "model"). Use {@link estimateUnitCost} with the matching unit count.
 *
 * Rates are approximations; keep them in sync with {@link PRICING_TABLE_AS_OF}.
 */
export const DEFAULT_UNIT_PRICING: Record<string, UnitPricing> = {
  // OpenAI TTS — billed per character ($15 / 1M chars = $0.000015/char).
  'openai/tts-1': { unit: 'character', usdPerUnit: 15.0 / 1_000_000 },
  'openai/tts-1-hd': { unit: 'character', usdPerUnit: 30.0 / 1_000_000 },
  'openai/gpt-4o-mini-tts': { unit: 'character', usdPerUnit: 0.60 / 1_000_000 },
  // STT / transcription — billed per audio-minute.
  'openai/whisper-large-v3-turbo': { unit: 'minute', usdPerUnit: 0.006 },
  'openai/gpt-4o-transcribe': { unit: 'minute', usdPerUnit: 0.006 },
  'openai/gpt-4o-mini-transcribe': { unit: 'minute', usdPerUnit: 0.003 },
  'groq/whisper-large-v3-turbo': { unit: 'minute', usdPerUnit: 0.00067 }, // ~$0.04/hr
  'deepgram/nova-2': { unit: 'minute', usdPerUnit: 0.0043 },
  // ElevenLabs — per character.
  'elevenlabs/eleven_multilingual_v2': { unit: 'character', usdPerUnit: 0.00018 },
};

/**
 * #530 — revision stamp for {@link DEFAULT_PRICING_TABLE}. Provider prices drift
 * quarterly; an undated table silently mis-bills with stale rates. Bump this
 * (YYYY-MM-DD) whenever a rate changes. {@link isPricingStale} flags a table
 * that has not been reviewed within N months.
 */
export const PRICING_TABLE_AS_OF = '2026-06-14';

/**
 * True when the pricing table is older than `maxAgeMonths` (default 6) relative
 * to `now`. Lets a startup check / test warn when rates may be out of date.
 */
export function isPricingStale(maxAgeMonths = 6, now: Date = new Date()): boolean {
  const asOf = new Date(`${PRICING_TABLE_AS_OF}T00:00:00Z`);
  if (Number.isNaN(asOf.getTime())) return true; // unparseable stamp = treat as stale
  const ageMs = now.getTime() - asOf.getTime();
  const maxAgeMs = maxAgeMonths * 30 * 24 * 60 * 60 * 1000; // ~30-day months
  return ageMs > maxAgeMs;
}

/**
 * Key format: "provider/model" or just "model" for provider-agnostic pricing.
 */
export const DEFAULT_PRICING_TABLE: Record<string, ModelPricing> = {
  // OpenAI
  'openai/gpt-4o': { inputPer1M: 2.50, outputPer1M: 10.00 },
  'openai/gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.60 },
  'openai/gpt-4o-mini-tts': { inputPer1M: 0.60, outputPer1M: 2.40 },
  'openai/gpt-4o-mini-realtime-preview': { inputPer1M: 0.60, outputPer1M: 2.40 },
  'openai/gpt-4o-realtime-preview': { inputPer1M: 5.00, outputPer1M: 20.00 },
  'openai/gpt-4o-transcribe': { inputPer1M: 0.36, outputPer1M: 0 },
  'openai/gpt-4o-mini-transcribe': { inputPer1M: 0.18, outputPer1M: 0 },
  'openai/whisper-large-v3-turbo': { inputPer1M: 0.36, outputPer1M: 0 },
  'openai/tts-1': { inputPer1M: 15.00, outputPer1M: 0 },
  'openai/tts-1-hd': { inputPer1M: 30.00, outputPer1M: 0 },

  // Groq
  'groq/llama-3.3-70b-versatile': { inputPer1M: 0.59, outputPer1M: 0.79 },
  'groq/llama-3.1-8b-instant': { inputPer1M: 0.05, outputPer1M: 0.08 },
  'groq/whisper-large-v3-turbo': { inputPer1M: 0.04, outputPer1M: 0 },
  'groq/gemma2-9b-it': { inputPer1M: 0.20, outputPer1M: 0.20 },
  'groq/canopylabs/orpheus-v1-english': { inputPer1M: 0.15, outputPer1M: 0 },

  // OpenRouter
  'openrouter/meta-llama/llama-3.3-70b-instruct': { inputPer1M: 0.39, outputPer1M: 0.39 },
  'openrouter/google/gemma-2-9b-it': { inputPer1M: 0.08, outputPer1M: 0.08 },

  // Fireworks
  'fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct': { inputPer1M: 0.59, outputPer1M: 0.79 },
  'fireworks/accounts/fireworks/models/whisper-v3-turbo': { inputPer1M: 0.15, outputPer1M: 0 },

  // TensorDock — billed per hour (GPU rental), not per token
  // Token counts are tracked for observability but costUsd is set to 0 at call site
  'tensordock/llama-3.1-70b-instruct': { inputPer1M: 0, outputPer1M: 0 },

  // ElevenLabs (per character pricing, approximated as per 1M tokens)
  'elevenlabs/eleven_multilingual_v2': { inputPer1M: 3.00, outputPer1M: 0 },

  // Deepgram
  'deepgram/nova-2': { inputPer1M: 0.36, outputPer1M: 0 },

  // GPU (self-hosted) — effectively free per token
  'gpu/pipeline': { inputPer1M: 0, outputPer1M: 0 },
};

/**
 * Look up pricing for a provider+model combination.
 * Tries "provider/model" first, then just "model".
 */
export function lookupPricing(
  provider: string,
  model: string,
  pricingTable: Record<string, ModelPricing> = DEFAULT_PRICING_TABLE,
): ModelPricing | null {
  return pricingTable[`${provider}/${model}`] ?? pricingTable[model] ?? null;
}

/**
 * Estimate cost for a single request given token counts.
 */
export function estimateRequestCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricingTable?: Record<string, ModelPricing>,
): number {
  const pricing = lookupPricing(provider, model, pricingTable);
  if (!pricing) {
    console.warn(`[spend-tracker] No pricing found for ${provider}/${model}, cost estimate will be 0`);
    return 0;
  }
  return (inputTokens * pricing.inputPer1M + outputTokens * pricing.outputPer1M) / 1_000_000;
}

/**
 * #529 — look up the per-unit (char/minute/request) rate for a provider+model.
 * Tries "provider/model" then "model"; returns null when there's no per-unit
 * entry (caller should fall back to the token-based table).
 */
export function lookupUnitPricing(
  provider: string,
  model: string,
  unitTable: Record<string, UnitPricing> = DEFAULT_UNIT_PRICING,
): UnitPricing | null {
  return unitTable[`${provider}/${model}`] ?? unitTable[model] ?? null;
}

/**
 * #529 — estimate cost for a request priced by a real billing unit
 * (characters for TTS, audio-minutes for STT, etc.) rather than tokens.
 *
 * @param units the count in the model's billing unit (chars, minutes, …).
 * @returns USD cost, or null when no per-unit rate exists for the model
 *          (so the caller can decide whether to fall back to token pricing).
 */
export function estimateUnitCost(
  provider: string,
  model: string,
  units: number,
  unitTable?: Record<string, UnitPricing>,
): number | null {
  const pricing = lookupUnitPricing(provider, model, unitTable);
  if (!pricing) return null;
  const safeUnits = Number.isFinite(units) && units > 0 ? units : 0;
  return safeUnits * pricing.usdPerUnit;
}

/**
 * #531 — amortize an hourly GPU/TensorDock rental over the wall-clock time a
 * single request occupied the GPU.
 *
 * GPU and TensorDock entries are priced at $0/token ("billed per hour"), so a
 * per-request GPU cost was previously unknowable. Attribute the rental to the
 * requests it served: `costPerHr × (stageLatencyMs / 3_600_000)`. This is a
 * busy-time amortization — it does NOT include idle time (that's the blended
 * daily figure, see #532) — giving a lower-bound marginal cost per request.
 *
 * @param costPerHr   the deploy's hourly rental rate (USD).
 * @param latencyMs   wall-clock ms the request spent on the GPU.
 */
export function amortizeHourlyCost(costPerHr: number, latencyMs: number): number {
  const hr = Number.isFinite(costPerHr) && costPerHr > 0 ? costPerHr : 0;
  const ms = Number.isFinite(latencyMs) && latencyMs > 0 ? latencyMs : 0;
  return (hr * ms) / 3_600_000;
}
