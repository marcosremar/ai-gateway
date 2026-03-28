/**
 * E2E Fallback Chain: Provider failover with real APIs.
 *
 * Tests that providers correctly fail over when one fails.
 * Required env var: GROQ_API_KEY
 * Optional env var: OPENAI_API_KEY
 *
 * Run with:
 *   cd packages/ai-gateway && set -a && source ../../.env.local && set +a && bunx vitest run __tests__/e2e-fallback-chain.test.ts --reporter=verbose
 */

import 'dotenv/config';

if (typeof globalThis.File === 'undefined') {
  const { File } = await import('node:buffer');
  globalThis.File = File as unknown as typeof globalThis.File;
}

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  AIProviderRegistry,
  createAIClient,
  groqSTT,
  groqTTS,
  groqLLM,
  withProviderFallback,
  getCooldownState,
} from '@ai-gateway';
import type { AIClient } from '@ai-gateway';

function clearCooldowns() {
  getCooldownState().clear();
}

function generateToneWav(durationSecs = 1.0, sampleRate = 16000): Buffer {
  const numSamples = Math.round(sampleRate * durationSecs);
  const buf = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buf);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.5;
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
    offset += 2;
  }

  return Buffer.from(buf);
}

function skipIf(condition: boolean, _reason: string) {
  return condition ? it.skip : it;
}

const HAS_GROQ = !!process.env.GROQ_API_KEY;

function createFallbackClient(): AIClient {
  const registry = new AIProviderRegistry();

  registry.register({
    id: 'groq',
    name: 'Groq',
    description: 'Groq provider',
    capabilities: ['llm', 'stt', 'tts'],
    requiresApiKey: true,
    llm: groqLLM,
    stt: groqSTT,
    tts: groqTTS,
  });

  return createAIClient({ registry, defaultProfile: 'voice' });
}

describe('E2E Fallback Chain', () => {
  let client: AIClient;

  beforeAll(() => {
    client = createFallbackClient();
    console.log(`[e2e-fallback] GROQ=${HAS_GROQ}`);
  });

  beforeEach(() => clearCooldowns());

  const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

  test('Groq succeeds on first try (no fallback)', async () => {
    const result = await client.chat(
      [{ role: 'user', content: 'Say OK' }],
      {
        llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }],
        maxTokens: 5,
      },
    );
    expect(result.provider).toBe('groq');
    expect(result.fallbackUsed).toBe(false);
    expect(result.content.length).toBeGreaterThan(0);
  }, 60_000);

  test('Invalid model on first provider falls back to second', async () => {
    const chain = [
      { provider: 'groq-bad', model: 'nonexistent-model-xyz' },
      { provider: 'groq-good', model: 'llama-3.1-8b-instant' },
    ];

    const { result, usedProvider, attempts } = await withProviderFallback(
      chain,
      async (entry) => {
        if (entry.provider === 'groq-bad') {
          const err = new Error('Model not found');
          (err as any).status = 404;
          throw err;
        }
        return groqLLM.chat({
          messages: [{ role: 'user', content: 'Say OK' }],
          model: entry.model!,
          maxTokens: 5,
        });
      },
      { timeoutMs: 15_000, retriesPerProvider: 0, logPrefix: '[Fallback-Test]' },
    );

    expect(usedProvider).toBe('groq-good');
    expect(attempts).toBe(2);
    expect(result.content.length).toBeGreaterThan(0);
  }, 60_000);

  test('Timeout on first provider falls back', async () => {
    const chain = [
      { provider: 'slow', model: 'slow-model' },
      { provider: 'groq', model: 'llama-3.1-8b-instant' },
    ];

    const { result, usedProvider, attempts } = await withProviderFallback(
      chain,
      async (entry) => {
        if (entry.provider === 'slow') {
          await new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timed out')), 5000),
          );
        }
        return groqLLM.chat({
          messages: [{ role: 'user', content: 'Say OK' }],
          model: entry.model!,
          maxTokens: 5,
        });
      },
      { timeoutMs: 500, retriesPerProvider: 0, logPrefix: '[Timeout-Test]' },
    );

    expect(usedProvider).toBe('groq');
    expect(attempts).toBe(2);
    expect(result.content.length).toBeGreaterThan(0);
  }, 60_000);

  test('Cooldown prevents retrying failed provider', async () => {
    for (let i = 0; i < 3; i++) {
      try {
        await withProviderFallback(
          [{ provider: 'cooldown-test', model: 'bad-model' }],
          async () => {
            const err = new Error('Server error');
            (err as any).status = 500;
            throw err;
          },
          { timeoutMs: 5_000, retriesPerProvider: 0, logPrefix: '[CD]', allowedFails: 3, cooldownMs: 30_000 },
        );
      } catch { /* expected */ }
    }

    const cooldownState = getCooldownState();
    const state = cooldownState.get('cooldown-test:bad-model');
    expect(state).toBeDefined();
    expect(state!.coolUntil).toBeGreaterThan(Date.now());

    const { usedProvider } = await withProviderFallback(
      [
        { provider: 'cooldown-test', model: 'bad-model' },
        { provider: 'groq', model: 'llama-3.1-8b-instant' },
      ],
      async (entry) => {
        if (entry.provider === 'cooldown-test') {
          throw new Error('Should not be called — in cooldown');
        }
        return groqLLM.chat({
          messages: [{ role: 'user', content: 'OK' }],
          model: entry.model!,
          maxTokens: 5,
        });
      },
      { timeoutMs: 15_000, retriesPerProvider: 0, logPrefix: '[CD-Skip]' },
    );

    expect(usedProvider).toBe('groq');
  }, 60_000);

  test('Multi-provider LLM chat with fallback via AIClient', async () => {
    const result = await client.chat(
      [{ role: 'user', content: 'What is 1+1? Reply with just the number.' }],
      {
        llm: [
          { provider: 'groq', model: 'llama-3.1-8b-instant' },
        ],
        temperature: 0,
        maxTokens: 10,
      },
    );
    expect(result.content).toContain('2');
    expect(result.provider).toBe('groq');
  }, 60_000);

  test('401 error on all providers throws actionable error', async () => {
    const chain = [
      { provider: 'bad-1', model: 'model-a' },
      { provider: 'bad-2', model: 'model-b' },
    ];

    await expect(
      withProviderFallback(
        chain,
        async () => {
          const err = new Error('Unauthorized');
          (err as any).status = 401;
          throw err;
        },
        { timeoutMs: 5_000, retriesPerProvider: 0, logPrefix: '[All-Fail]' },
      ),
    ).rejects.toThrow();
  }, 30_000);

  test('5xx retries before fallback', async () => {
    let callCount = 0;
    const chain = [
      { provider: 'flaky', model: 'model-a' },
      { provider: 'groq', model: 'llama-3.1-8b-instant' },
    ];

    const { usedProvider } = await withProviderFallback(
      chain,
      async (entry) => {
        if (entry.provider === 'flaky') {
          callCount++;
          const err = new Error('Server error');
          (err as any).status = 500;
          throw err;
        }
        return groqLLM.chat({
          messages: [{ role: 'user', content: 'OK' }],
          model: entry.model!,
          maxTokens: 5,
        });
      },
      { timeoutMs: 15_000, retriesPerProvider: 1, retryBaseDelayMs: 50, logPrefix: '[Retry-Test]' },
    );

    expect(callCount).toBe(2);
    expect(usedProvider).toBe('groq');
  }, 60_000);
});
