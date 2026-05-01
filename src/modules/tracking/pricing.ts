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
