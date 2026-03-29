/**
 * Cross-Provider — Integration Tests (Real APIs)
 *
 * Tests that exercise the same interface across multiple providers,
 * validating consistent behavior and type contracts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { groqSTT, groqTTS, groqLLM } from '../src/providers/groq';
import { fireworksSTT, fireworksLLM } from '../src/providers/fireworks';
import { openrouterLLM } from '../src/providers/openrouter';
import { OpenAISTTProvider } from '../src/providers/openai/openai-stt';
import { OpenAITTSProvider } from '../src/providers/openai/openai-tts';
import { OpenAICompatLLMProvider } from '../src/providers/openai-compat/openai-compat-llm';
import type { STTProvider, TTSProvider, LLMProvider, ChatResponse } from '../src/providers/types';
import { loadEnv, makeTestWav, timed } from './helpers';

beforeAll(() => loadEnv());

// NOTE: OpenAI direct tests require a valid OPENAI_API_KEY.
// If the key is deactivated, OpenAI tests will throw SKIP errors.

// ─── STT Cross-Provider ──────────────────────────────────────────────────────

interface STTTestCase {
  name: string;
  provider: STTProvider;
  model: string;
  envKey: string;
}

const sttProviders: STTTestCase[] = [
  { name: 'Groq', provider: groqSTT, model: 'whisper-large-v3-turbo', envKey: 'GROQ_API_KEY' },
  // OpenAI STT skipped when key is deactivated — tested in openai-integration.test.ts
  { name: 'Fireworks', provider: fireworksSTT, model: 'whisper-v3-turbo', envKey: 'FIREWORKS_API_KEY' },
];

describe('Cross-Provider STT', () => {
  for (const { name, provider, model, envKey } of sttProviders) {
    it(`${name}: transcribe returns STTResponse contract`, async () => {
      if (!process.env[envKey]) return;
      const audio = makeTestWav(1.0);

      let result: Awaited<ReturnType<typeof provider.transcribe>>, ms: number;
      try {
        ({ result, ms } = await timed(() => provider.transcribe({ audio, model })));
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403) return; // key invalid / no credits
        throw err;
      }

      // Contract: must have text string
      expect(typeof result.text).toBe('string');
      // providerId must match
      expect(provider.providerId).toBeTruthy();
      // isConfigured must return true
      expect(provider.isConfigured()).toBe(true);
      // getModels must return non-empty array
      expect(provider.getModels().length).toBeGreaterThan(0);

      console.log(`  ${name} STT: "${result.text.slice(0, 50)}" (${ms}ms)`);
    });
  }
});

// ─── TTS Cross-Provider ──────────────────────────────────────────────────────

interface TTSTestCase {
  name: string;
  provider: TTSProvider;
  model: string;
  voice: string;
  envKey: string;
}

const ttsProviders: TTSTestCase[] = [
  { name: 'Groq', provider: groqTTS, model: 'canopylabs/orpheus-v1-english', voice: 'autumn', envKey: 'GROQ_API_KEY' },
  // OpenAI TTS skipped when key is deactivated — tested in openai-integration.test.ts
];

describe('Cross-Provider TTS', () => {
  for (const { name, provider, model, voice, envKey } of ttsProviders) {
    it(`${name}: synthesize returns TTSResponse contract`, async () => {
      if (!process.env[envKey]) return;

      let result: Awaited<ReturnType<typeof provider.synthesize>>, ms: number;
      try {
        ({ result, ms } = await timed(() =>
          provider.synthesize({ input: 'Integration test audio.', model, voice, responseFormat: 'wav' }),
        ));
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403) return;
        throw err;
      }

      // Contract: audio Buffer, contentType string
      expect(result.audio).toBeInstanceOf(Buffer);
      expect(result.audio.length).toBeGreaterThan(100);
      expect(typeof result.contentType).toBe('string');
      expect(provider.providerId).toBeTruthy();
      expect(provider.getModels().length).toBeGreaterThan(0);

      console.log(`  ${name} TTS: ${result.audio.length} bytes, ${result.contentType} (${ms}ms)`);
    });
  }
});

// ─── LLM Cross-Provider ─────────────────────────────────────────────────────

interface LLMTestCase {
  name: string;
  provider: LLMProvider;
  model: string;
  envKey: string;
}

const llmProviders: LLMTestCase[] = [
  { name: 'Groq', provider: groqLLM, model: 'llama-3.3-70b-versatile', envKey: 'GROQ_API_KEY' },
  // OpenAI LLM skipped when key is deactivated — tested in openai-integration.test.ts
  { name: 'Fireworks', provider: fireworksLLM, model: 'accounts/fireworks/models/llama-v3p3-70b-instruct', envKey: 'FIREWORKS_API_KEY' },
  { name: 'OpenRouter', provider: openrouterLLM, model: 'openai/gpt-4o-mini', envKey: 'OPENROUTER_API_KEY' },
];

describe('Cross-Provider LLM', () => {
  for (const { name, provider, model, envKey } of llmProviders) {
    it(`${name}: chat returns ChatResponse contract`, async () => {
      if (!process.env[envKey]) return;

      let result: Awaited<ReturnType<typeof provider.chat>>, ms: number;
      try {
        ({ result, ms } = await timed(() =>
          provider.chat({
            messages: [
              { role: 'system', content: 'Reply with exactly one word.' },
              { role: 'user', content: 'What is 1 + 1?' },
            ],
            model,
            temperature: 0,
            maxTokens: 10,
          }),
        ));
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403) return;
        throw err;
      }

      // Contract: content string, model string
      expect(typeof result.content).toBe('string');
      expect(result.content.length).toBeGreaterThan(0);
      expect(typeof result.model).toBe('string');
      // Usage should be present
      expect(result.usage).toBeDefined();
      expect(result.usage!.totalTokens).toBeGreaterThan(0);
      expect(result.usage!.promptTokens).toBeGreaterThan(0);
      expect(result.usage!.completionTokens).toBeGreaterThan(0);

      console.log(`  ${name} LLM: "${result.content}" — ${result.usage!.totalTokens} tokens (${ms}ms)`);
    });
  }

  it('all providers return consistent ChatResponse shape', async () => {
    const results: Array<{ name: string; response: ChatResponse }> = [];

    for (const { name, provider, model, envKey } of llmProviders) {
      if (!process.env[envKey]) continue;

      try {
        const response = await provider.chat({
          messages: [{ role: 'user', content: 'Say "test".' }],
          model,
          maxTokens: 5,
        });
        results.push({ name, response });
      } catch (err: unknown) {
        // Skip providers with auth/billing errors (deactivated keys or no credits)
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403) continue;
        throw err;
      }
    }

    if (results.length < 2) return;

    // All should have the same shape
    for (const { name, response } of results) {
      expect(response).toHaveProperty('content');
      expect(response).toHaveProperty('model');
      expect(response).toHaveProperty('usage');
      expect(typeof response.content).toBe('string');
      expect(typeof response.model).toBe('string');
    }

    console.log(`  Verified ${results.length} providers return consistent ChatResponse`);
  });
});
