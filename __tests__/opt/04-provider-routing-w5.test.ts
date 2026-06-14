/**
 * Wave-5 unit tests for provider-routing / caching optimizations
 * (docs/optimizations/04-provider-routing-caching.md).
 *
 * Scope: pure, importable logic only — no network / provider SDK calls / GPU /
 * real FS. Provider behavior is exercised through side-effect-free exported
 * helpers, exactly like waves 2-4.
 *
 * Covered findings (NEW this wave):
 *   #302 all-cooled-down bypass excludes credit-blocked / circuit-open providers;
 *   #372 openai-compat timeout errors are marked so the fallback layer
 *        classifies them as timeouts (move-on, no retry);
 *   #373 OpenAI STT + TTS share the connection pool via the client cache;
 *   #374 the English-only Groq TTS fallback is gated on target language;
 *   #377 openai-compat estimates token usage when the provider omits it.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  computeAllCooledDown,
  isTimeoutError,
  type FallbackEntry,
} from '../../src/gateway/providers/cloud/fallback';
import {
  estimateTokensFromChars,
  estimateUsage,
  markTimeout,
} from '../../src/gateway/providers/cloud/openai-compat/openai-compat-llm';
import { isGroqTtsLanguageCompatible } from '../../src/gateway/providers/cloud/groq';
import {
  getOrCreateClient,
  getCacheStats,
  clearClientCache,
} from '../../src/gateway/providers/cloud/openai-compat/client-cache';
import type { ChatMessage } from '../../src/gateway/providers/cloud/types';

// ─── #302 all-cooled-down bypass viability ───────────────────────────────────
describe('#302 computeAllCooledDown excludes credit-blocked / circuit-open', () => {
  const chain: FallbackEntry[] = [
    { provider: 'groq', model: 'a' },
    { provider: 'openai', model: 'b' },
  ];

  it('returns false when no entry is cooling down', () => {
    expect(computeAllCooledDown(chain, () => false)).toBe(false);
  });

  it('returns false for an empty chain', () => {
    expect(computeAllCooledDown([], () => true)).toBe(false);
  });

  it('returns true (legacy behavior) when all cooling down and no viability fn', () => {
    expect(computeAllCooledDown(chain, () => true)).toBe(true);
  });

  it('returns true when all cooling down but at least one is still viable', () => {
    // groq is blocked/open, openai is viable → still worth bypassing for openai.
    const viable = (e: FallbackEntry) => e.provider === 'openai';
    expect(computeAllCooledDown(chain, () => true, viable)).toBe(true);
  });

  it('returns false when all cooling down AND every entry is non-viable (#302)', () => {
    // Both credit-blocked / circuit-open → retrying them just burns guaranteed
    // failures, so the bypass must NOT fire.
    expect(computeAllCooledDown(chain, () => true, () => false)).toBe(false);
  });

  it('requires EVERY entry cooling down before considering the bypass', () => {
    // Only the first is cooling down → not "all cooled down".
    const coolingDown = (e: FallbackEntry) => e.provider === 'groq';
    expect(computeAllCooledDown(chain, coolingDown, () => true)).toBe(false);
  });
});

// ─── #372 timeout marker ─────────────────────────────────────────────────────
describe('#372 markTimeout makes errors classifiable as timeouts', () => {
  it('marks an error so fallback isTimeoutError recognizes it', () => {
    const err = markTimeout(new Error('chat() timed out after 120000ms'));
    expect(isTimeoutError(err)).toBe(true);
  });

  it('attaches a 408 status for reliable classification', () => {
    const err = markTimeout(new Error('timed out'));
    expect((err as { status?: number }).status).toBe(408);
  });

  it('a plain error is NOT seen as a timeout', () => {
    expect(isTimeoutError(new Error('some upstream 500'))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError('string')).toBe(false);
  });
});

// ─── #373 OpenAI STT/TTS share the client cache ──────────────────────────────
describe('#373 OpenAI providers reuse the shared client cache', () => {
  beforeEach(() => clearClientCache());

  it('STT and TTS sharing one key reuse a single OpenAI client instance', async () => {
    // Import lazily after the cache is cleared. The providers route getClient()
    // through getOrCreateClient with the OpenAI base + key.
    const { OpenAISTTProvider } = await import(
      '../../src/gateway/providers/cloud/openai/openai-stt'
    );
    const { OpenAITTSProvider } = await import(
      '../../src/gateway/providers/cloud/openai/openai-tts'
    );

    const stt = new OpenAISTTProvider().withApiKey('sk-shared-key');
    const tts = new OpenAITTSProvider().withApiKey('sk-shared-key');

    // Only one cache entry exists for the shared base+key combination.
    expect(getCacheStats().size).toBe(1);

    // Both providers must reference the exact same cached client object —
    // proving they share one connection pool rather than each holding their own.
    const sttClient = (stt as unknown as { client: unknown }).client;
    const ttsClient = (tts as unknown as { client: unknown }).client;
    expect(sttClient).toBe(ttsClient);
    expect(sttClient).toBe(getOrCreateClient('https://api.openai.com/v1', 'sk-shared-key'));
  });

  it('different keys produce different cached clients', async () => {
    const { OpenAITTSProvider } = await import(
      '../../src/gateway/providers/cloud/openai/openai-tts'
    );
    new OpenAITTSProvider().withApiKey('sk-key-a');
    new OpenAITTSProvider().withApiKey('sk-key-b');
    expect(getCacheStats().size).toBe(2);
  });
});

// ─── #374 Groq English-only TTS language gating ──────────────────────────────
describe('#374 Groq TTS fallback gated on target language', () => {
  it('blocks the English-only orpheus model for non-English targets', () => {
    expect(isGroqTtsLanguageCompatible('fr', 'canopylabs/orpheus-v1-english')).toBe(false);
    expect(isGroqTtsLanguageCompatible('pt-BR', 'canopylabs/orpheus-v1-english')).toBe(false);
    expect(isGroqTtsLanguageCompatible('Spanish', 'canopylabs/orpheus-v1-english')).toBe(false);
  });

  it('allows English targets (code, region, and name forms)', () => {
    expect(isGroqTtsLanguageCompatible('en', 'canopylabs/orpheus-v1-english')).toBe(true);
    expect(isGroqTtsLanguageCompatible('en-US', 'canopylabs/orpheus-v1-english')).toBe(true);
    expect(isGroqTtsLanguageCompatible('English', 'canopylabs/orpheus-v1-english')).toBe(true);
  });

  it('defaults to allowed when language is unspecified', () => {
    expect(isGroqTtsLanguageCompatible(undefined, 'canopylabs/orpheus-v1-english')).toBe(true);
  });

  it('uses the English-only orpheus default model when none is given', () => {
    expect(isGroqTtsLanguageCompatible('fr')).toBe(false);
    expect(isGroqTtsLanguageCompatible('en')).toBe(true);
  });

  it('does not gate non-English-only models (future multilingual voices)', () => {
    expect(isGroqTtsLanguageCompatible('fr', 'playai-tts-multilingual')).toBe(true);
  });
});

// ─── #377 usage estimation when provider omits usage ─────────────────────────
describe('#377 estimateUsage backfills token counts', () => {
  it('estimateTokensFromChars uses ~4 chars/token and never negative', () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(-5)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1); // rounds up, min 1
    expect(estimateTokensFromChars(8)).toBe(2);
    expect(estimateTokensFromChars(10)).toBe(3); // ceil(10/4)
  });

  it('produces non-zero prompt + completion + total tokens', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a translator.' },
      { role: 'user', content: 'Translate hello to French.' },
    ];
    const usage = estimateUsage(messages, 'Bonjour le monde');
    expect(usage.promptTokens).toBeGreaterThan(0);
    expect(usage.completionTokens).toBeGreaterThan(0);
    expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);
  });

  it('handles multimodal content parts by flattening text', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image_url', image_url: { url: 'http://x/y.png' } },
        ],
      },
    ];
    const usage = estimateUsage(messages, 'a cat');
    // Only the text part ('describe this' = 13 chars) should count toward prompt.
    expect(usage.promptTokens).toBe(estimateTokensFromChars('describe this'.length));
    expect(usage.completionTokens).toBe(estimateTokensFromChars('a cat'.length));
  });

  it('empty completion yields zero completion tokens', () => {
    const usage = estimateUsage([{ role: 'user', content: 'hi' }], '');
    expect(usage.completionTokens).toBe(0);
    expect(usage.promptTokens).toBeGreaterThan(0);
  });
});
