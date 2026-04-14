/**
 * Cross-Provider — Integration Tests (Real APIs)
 *
 * Tests that exercise the same interface across multiple providers,
 * validating consistent behavior and type contracts.
 *
 * Cost minimization:
 * - STT/TTS: 1 call per provider (shared via beforeAll per describe block)
 * - LLM: ONE beforeAll collects all provider results; individual contract tests
 *   AND the shape-consistency test reuse the same collected results (3 calls, not 6).
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

function skipOn(err: unknown): boolean {
  const s = (err as Record<string, unknown>)?.status;
  return s === 401 || s === 402 || s === 403 || s === 429;
}

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
  const audio = makeTestWav(1.0);
  const results = new Map<string, Awaited<ReturnType<typeof groqSTT.transcribe>>>();

  // 1 call per available provider
  beforeAll(async () => {
    for (const { name, provider, model, envKey } of sttProviders) {
      if (!process.env[envKey]) continue;
      try {
        const { result } = await timed(() => provider.transcribe({ audio, model }));
        results.set(name, result);
      } catch (err: unknown) {
        if (!skipOn(err)) throw err;
      }
    }
  });

  for (const { name, provider, envKey } of sttProviders) {
    it(`${name}: transcribe returns STTResponse contract`, () => {
      if (!process.env[envKey]) return;
      const result = results.get(name);
      if (!result) return; // auth/billing/rate-limit — skip gracefully

      expect(typeof result.text).toBe('string');
      expect(provider.providerId).toBeTruthy();
      expect(provider.isConfigured()).toBe(true);
      expect(provider.getModels().length).toBeGreaterThan(0);

      console.log(`  ${name} STT: "${result.text.slice(0, 50)}"`);
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
  const results = new Map<string, Awaited<ReturnType<typeof groqTTS.synthesize>>>();

  // 1 call per available provider
  beforeAll(async () => {
    for (const { name, provider, model, voice, envKey } of ttsProviders) {
      if (!process.env[envKey]) continue;
      try {
        const { result } = await timed(() =>
          provider.synthesize({ input: 'Integration test audio.', model, voice, responseFormat: 'wav' }),
        );
        results.set(name, result);
      } catch (err: unknown) {
        if (!skipOn(err)) throw err;
      }
    }
  });

  for (const { name, provider, envKey } of ttsProviders) {
    it(`${name}: synthesize returns TTSResponse contract`, () => {
      if (!process.env[envKey]) return;
      const result = results.get(name);
      if (!result) return; // auth/billing/rate-limit — skip gracefully

      expect(result.audio).toBeInstanceOf(Buffer);
      expect(result.audio.length).toBeGreaterThan(100);
      expect(typeof result.contentType).toBe('string');
      expect(provider.providerId).toBeTruthy();
      expect(provider.getModels().length).toBeGreaterThan(0);

      console.log(`  ${name} TTS: ${result.audio.length} bytes, ${result.contentType}`);
    });
  }
});

// ─── LLM Cross-Provider ─────────────────────────────────────────────────────
//
// KEY OPTIMIZATION: ONE beforeAll collects all results (3 calls).
// Both individual contract tests AND shape-consistency test reuse those results.
// Previously: 3 calls (individual loop) + 3 calls (shape test) = 6 total.
// Now: 3 calls total — 50% reduction.

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
  const collected: Array<{ name: string; response: ChatResponse; ms: number }> = [];

  // Collect ALL results in ONE beforeAll — reused by every it() below
  beforeAll(async () => {
    for (const { name, provider, model, envKey } of llmProviders) {
      if (!process.env[envKey]) continue;
      try {
        const { result: response, ms } = await timed(() =>
          provider.chat({
            messages: [
              { role: 'system', content: 'Reply with exactly one word.' },
              { role: 'user', content: 'What is 1 + 1?' },
            ],
            model,
            temperature: 0,
            maxTokens: 10,
          }),
        );
        collected.push({ name, response, ms });
      } catch (err: unknown) {
        if (!skipOn(err)) throw err; // auth/billing/rate-limit — skip provider silently
      }
    }
  });

  // Individual contract tests — zero extra API calls
  for (const { name, envKey } of llmProviders) {
    it(`${name}: chat returns ChatResponse contract`, () => {
      if (!process.env[envKey]) return;
      const entry = collected.find(r => r.name === name);
      if (!entry) return; // auth/billing/rate-limit — skip gracefully

      const { response, ms } = entry;
      expect(typeof response.content).toBe('string');
      expect(response.content.length).toBeGreaterThan(0);
      expect(typeof response.model).toBe('string');
      expect(response.usage).toBeDefined();
      expect(response.usage!.totalTokens).toBeGreaterThan(0);
      expect(response.usage!.promptTokens).toBeGreaterThan(0);
      expect(response.usage!.completionTokens).toBeGreaterThan(0);

      console.log(`  ${name} LLM: "${response.content}" — ${response.usage!.totalTokens} tokens (${ms}ms)`);
    });
  }

  // Shape-consistency test — reuses same collected results, zero extra calls
  it('all providers return consistent ChatResponse shape', () => {
    if (collected.length < 2) return;

    for (const { name, response } of collected) {
      expect(response).toHaveProperty('content');
      expect(response).toHaveProperty('model');
      expect(response).toHaveProperty('usage');
      expect(typeof response.content).toBe('string');
      expect(typeof response.model).toBe('string');
    }

    console.log(`  Verified ${collected.length} providers return consistent ChatResponse`);
  });
});
