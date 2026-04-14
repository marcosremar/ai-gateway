/**
 * Tests for tracking/pricing.ts
 * - DEFAULT_PRICING_TABLE structure
 * - lookupPricing()
 * - estimateRequestCost()
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PRICING_TABLE,
  lookupPricing,
  estimateRequestCost,
  type ModelPricing,
} from '../../src/tracking/pricing';

describe('DEFAULT_PRICING_TABLE', () => {
  it('contains OpenAI models', () => {
    expect(DEFAULT_PRICING_TABLE['openai/gpt-4o']).toBeDefined();
    expect(DEFAULT_PRICING_TABLE['openai/gpt-4o-mini']).toBeDefined();
    expect(DEFAULT_PRICING_TABLE['openai/tts-1']).toBeDefined();
    expect(DEFAULT_PRICING_TABLE['openai/whisper-large-v3-turbo']).toBeDefined();
  });

  it('contains Groq models', () => {
    expect(DEFAULT_PRICING_TABLE['groq/llama-3.3-70b-versatile']).toBeDefined();
    expect(DEFAULT_PRICING_TABLE['groq/whisper-large-v3-turbo']).toBeDefined();
  });

  it('contains OpenRouter models', () => {
    expect(DEFAULT_PRICING_TABLE['openrouter/meta-llama/llama-3.3-70b-instruct']).toBeDefined();
  });

  it('contains Fireworks models', () => {
    expect(DEFAULT_PRICING_TABLE['fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct']).toBeDefined();
  });

  it('has correct structure for each entry', () => {
    for (const [key, pricing] of Object.entries(DEFAULT_PRICING_TABLE)) {
      expect(typeof pricing.inputPer1M).toBe('number');
      expect(typeof pricing.outputPer1M).toBe('number');
      expect(pricing.inputPer1M).toBeGreaterThanOrEqual(0);
      expect(pricing.outputPer1M).toBeGreaterThanOrEqual(0);
    }
  });

  it('GPU pipeline has zero pricing', () => {
    expect(DEFAULT_PRICING_TABLE['gpu/pipeline']).toEqual({ inputPer1M: 0, outputPer1M: 0 });
  });

  it('TensorDock has zero pricing', () => {
    expect(DEFAULT_PRICING_TABLE['tensordock/llama-3.1-70b-instruct']).toEqual({ inputPer1M: 0, outputPer1M: 0 });
  });
});

describe('lookupPricing', () => {
  it('finds exact provider/model match', () => {
    const result = lookupPricing('openai', 'gpt-4o');
    expect(result).toEqual({ inputPer1M: 2.50, outputPer1M: 10.00 });
  });

  it('finds groq model', () => {
    const result = lookupPricing('groq', 'llama-3.3-70b-versatile');
    expect(result).not.toBeNull();
    expect(result!.inputPer1M).toBe(0.59);
  });

  it('falls back to model-only lookup when provider/model not found', () => {
    const custom: Record<string, ModelPricing> = {
      'my-model': { inputPer1M: 1.0, outputPer1M: 2.0 },
    };
    const result = lookupPricing('unknown-provider', 'my-model', custom);
    expect(result).toEqual({ inputPer1M: 1.0, outputPer1M: 2.0 });
  });

  it('returns null for unknown provider and model', () => {
    const result = lookupPricing('unknown', 'unknown-model');
    expect(result).toBeNull();
  });

  it('uses custom pricing table when provided', () => {
    const custom: Record<string, ModelPricing> = {
      'custom/model-x': { inputPer1M: 5.0, outputPer1M: 10.0 },
    };
    const result = lookupPricing('custom', 'model-x', custom);
    expect(result).toEqual({ inputPer1M: 5.0, outputPer1M: 10.0 });
  });

  it('does not find model from default table in custom table', () => {
    const custom: Record<string, ModelPricing> = {};
    const result = lookupPricing('openai', 'gpt-4o', custom);
    expect(result).toBeNull();
  });

  it('uses default pricing table when not provided', () => {
    const result = lookupPricing('openai', 'gpt-4o-mini');
    expect(result).toEqual({ inputPer1M: 0.15, outputPer1M: 0.60 });
  });
});

describe('estimateRequestCost', () => {
  it('calculates cost for input tokens only', () => {
    // gpt-4o: $2.50 per 1M input tokens
    const cost = estimateRequestCost('openai', 'gpt-4o', 1_000_000, 0);
    expect(cost).toBeCloseTo(2.50);
  });

  it('calculates cost for output tokens only', () => {
    // gpt-4o: $10.00 per 1M output tokens
    const cost = estimateRequestCost('openai', 'gpt-4o', 0, 1_000_000);
    expect(cost).toBeCloseTo(10.00);
  });

  it('calculates combined cost', () => {
    // gpt-4o: 1000 input + 500 output
    // = (1000 * 2.50 + 500 * 10.00) / 1_000_000
    // = (2500 + 5000) / 1_000_000 = 0.0075
    const cost = estimateRequestCost('openai', 'gpt-4o', 1000, 500);
    expect(cost).toBeCloseTo(0.0075);
  });

  it('returns 0 for unknown model', () => {
    const cost = estimateRequestCost('unknown', 'unknown-model', 1000, 500);
    expect(cost).toBe(0);
  });

  it('returns 0 for GPU pipeline (zero pricing)', () => {
    const cost = estimateRequestCost('gpu', 'pipeline', 1_000_000, 1_000_000);
    expect(cost).toBe(0);
  });

  it('uses custom pricing table', () => {
    const custom: Record<string, ModelPricing> = {
      'custom/model': { inputPer1M: 2.0, outputPer1M: 4.0 },
    };
    const cost = estimateRequestCost('custom', 'model', 500_000, 250_000, custom);
    // (500000 * 2.0 + 250000 * 4.0) / 1_000_000 = (1000000 + 1000000) / 1_000_000 = 2.0
    expect(cost).toBeCloseTo(2.0);
  });

  it('returns 0 for zero tokens', () => {
    const cost = estimateRequestCost('openai', 'gpt-4o', 0, 0);
    expect(cost).toBe(0);
  });

  it('handles groq whisper (output=0)', () => {
    // whisper has 0 output cost
    const cost = estimateRequestCost('groq', 'whisper-large-v3-turbo', 1_000_000, 9999);
    // input cost: 1M * 0.04 / 1M = 0.04, output: 9999 * 0 = 0
    expect(cost).toBeCloseTo(0.04);
  });

  it('handles small token counts with precision', () => {
    const cost = estimateRequestCost('openai', 'gpt-4o-mini', 100, 50);
    // (100 * 0.15 + 50 * 0.60) / 1_000_000 = (15 + 30) / 1_000_000 = 0.000045
    expect(cost).toBeCloseTo(0.000045, 8);
  });
});
