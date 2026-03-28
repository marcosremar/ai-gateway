/**
 * E2E Concurrency: Multiple simultaneous requests.
 *
 * Tests parallelism and state isolation under concurrent load.
 * Required env var: GROQ_API_KEY
 *
 * Run with:
 *   cd packages/ai-gateway && set -a && source ../../.env.local && set +a && bunx vitest run __tests__/e2e-concurrency.test.ts --reporter=verbose
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

function createConcurrencyClient(): AIClient {
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

describe('E2E Concurrency', () => {
  let client: AIClient;

  beforeAll(() => {
    client = createConcurrencyClient();
    console.log(`[e2e-concurrency] GROQ=${HAS_GROQ}`);
  });

  beforeEach(() => clearCooldowns());

  const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

  test('10 simultaneous chat requests all succeed', async () => {
    const prompts = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      content: `What is ${i + 1}+${i + 1}? Reply with just the number.`,
    }));

    const t0 = Date.now();
    const results = await Promise.all(
      prompts.map(msg =>
        client.chat([msg], {
          llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }],
          temperature: 0,
          maxTokens: 10,
        }),
      ),
    );
    const totalTime = Date.now() - t0;

    expect(results).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(results[i].content).toBeTruthy();
      expect(results[i].content.length).toBeGreaterThan(0);
      expect(results[i].provider).toBe('groq');
      const expected = String((i + 1) * 2);
      expect(results[i].content).toContain(expected);
    }

    const singleTimeEstimate = 2000;
    expect(totalTime).toBeLessThan(singleTimeEstimate * 10);
  }, 120_000);

  test('Mixed stages: 5 STT + 5 LLM simultaneously', async () => {
    const audio = generateToneWav(0.5);

    const sttPromises = Array.from({ length: 5 }, () =>
      client.transcribe(audio, {
        stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
      }),
    );

    const llmPromises = Array.from({ length: 5 }, (_, i) =>
      client.chat(
        [{ role: 'user', content: `Say "test ${i}" and nothing else.` }],
        {
          llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }],
          maxTokens: 20,
        },
      ),
    );

    const [sttResults, llmResults] = await Promise.all([
      Promise.all(sttPromises),
      Promise.all(llmPromises),
    ]);

    expect(sttResults).toHaveLength(5);
    for (const r of sttResults) {
      expect(r.text).toBeDefined();
      expect(typeof r.text).toBe('string');
      expect(r.provider).toBe('groq');
    }

    expect(llmResults).toHaveLength(5);
    for (const r of llmResults) {
      expect(r.content).toBeTruthy();
      expect(r.content.length).toBeGreaterThan(0);
      expect(r.provider).toBe('groq');
    }
  }, 120_000);

  test('Rate limiting: many rapid sequential requests still work', async () => {
    const results: any[] = [];
    for (let i = 0; i < 20; i++) {
      const result = await client.chat(
        [{ role: 'user', content: `Count: ${i}. Say OK.` }],
        {
          llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }],
          maxTokens: 5,
        },
      );
      results.push(result);
    }

    expect(results).toHaveLength(20);
    for (const r of results) {
      expect(r.content.length).toBeGreaterThan(0);
      expect(r.provider).toBe('groq');
    }
  }, 180_000);
});
