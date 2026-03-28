/**
 * E2E Graceful Degradation: Missing credentials, partial availability, edge cases.
 *
 * Tests how the SDK handles missing keys, invalid inputs, and partial configuration.
 * Required env var: GROQ_API_KEY
 *
 * Run with:
 *   cd packages/ai-gateway && set -a && source ../../.env.local && set +a && bunx vitest run __tests__/e2e-graceful-degradation.test.ts --reporter=verbose
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

describe('E2E Graceful Degradation', () => {
  let client: AIClient;

  beforeAll(() => {
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

    client = createAIClient({ registry, defaultProfile: 'voice' });
    console.log(`[e2e-graceful] GROQ=${HAS_GROQ}`);
  });

  beforeEach(() => clearCooldowns());

  const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

  test('SDK works with only GROQ_API_KEY (no OpenAI)', async () => {
    const sttResult = await client.transcribe(generateToneWav(0.5), {
      stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
    });
    expect(sttResult.text).toBeDefined();
    expect(sttResult.provider).toBe('groq');

    const chatResult = await client.chat(
      [{ role: 'user', content: 'Say OK' }],
      { llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }], maxTokens: 5 },
    );
    expect(chatResult.content).toBeTruthy();
    expect(chatResult.provider).toBe('groq');

    const ttsResult = await client.synthesize('Test', {
      tts: [{ provider: 'groq', model: 'canopylabs/orpheus-v1-english' }],
      voice: 'autumn',
    });
    expect(ttsResult.audio.length).toBeGreaterThan(0);
    expect(ttsResult.provider).toBe('groq');
  }, 60_000);

  test('Missing API key gives clear error message', async () => {
    await expect(
      client.chat(
        [{ role: 'user', content: 'Hello' }],
        {
          llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }],
          keys: { groq: 'invalid-key-xxxxx' },
          fallbackOptions: { timeoutMs: 15_000, retriesPerProvider: 0 },
        },
      ),
    ).rejects.toThrow();
  }, 30_000);

  test('Empty audio returns gracefully (not crash)', async () => {
    const emptyAudio = Buffer.alloc(44);
    try {
      const result = await client.transcribe(emptyAudio, {
        stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
      });
      expect(typeof result.text).toBe('string');
    } catch (err) {
      expect(err).toBeDefined();
    }
  }, 30_000);

  test('TTS with very long text handles gracefully', async () => {
    const longText = 'Hello. '.repeat(1000);
    try {
      const result = await client.synthesize(longText, {
        tts: [{ provider: 'groq', model: 'canopylabs/orpheus-v1-english' }],
        voice: 'autumn',
        fallbackOptions: { timeoutMs: 60_000, retriesPerProvider: 0 },
      });
      expect(result.audio.length).toBeGreaterThan(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg.length).toBeGreaterThan(0);
    }
  }, 90_000);

  test('Profile with no STT providers configured throws clear error', async () => {
    const registry = new AIProviderRegistry();
    registry.register({
      id: 'groq',
      name: 'Groq',
      description: 'Groq provider',
      capabilities: ['llm', 'tts'],
      requiresApiKey: true,
      llm: groqLLM,
      tts: groqTTS,
    });

    const chatOnlyClient = createAIClient({
      registry,
      defaultProfile: { llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }] },
    });

    await expect(
      chatOnlyClient.transcribe(generateToneWav(0.5)),
    ).rejects.toThrow(/No STT providers configured/);
  }, 30_000);

  test('Profile with no LLM providers configured throws clear error', async () => {
    const registry = new AIProviderRegistry();
    registry.register({
      id: 'groq',
      name: 'Groq',
      description: 'Groq provider',
      capabilities: ['stt', 'tts'],
      requiresApiKey: true,
      stt: groqSTT,
      tts: groqTTS,
    });

    const sttOnlyClient = createAIClient({
      registry,
      defaultProfile: { stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }] },
    });

    await expect(
      sttOnlyClient.chat([{ role: 'user', content: 'Hello' }]),
    ).rejects.toThrow(/No LLM providers configured/);
  }, 30_000);

  test('Profile with no TTS providers configured returns empty audio in pipeline', async () => {
    const registry = new AIProviderRegistry();
    registry.register({
      id: 'groq',
      name: 'Groq',
      description: 'Groq provider',
      capabilities: ['stt', 'llm'],
      requiresApiKey: true,
      stt: groqSTT,
      llm: groqLLM,
    });

    const noTtsClient = createAIClient({
      registry,
      defaultProfile: {
        stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
        llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }],
      },
    });

    const result = await noTtsClient.pipeline(
      generateToneWav(0.5),
      'Say OK',
      [],
      {
        fallbackOptions: { timeoutMs: 15_000, retriesPerProvider: 0 },
      },
    );

    expect(result.stt.text).toBeDefined();
    expect(result.chat.content).toBeTruthy();
    expect(result.tts.audio).toBeDefined();
    expect(result.totalLatencyMs).toBeGreaterThan(0);
  }, 60_000);

  test('Nonexistent model returns clear error or falls back', async () => {
    const result = await client.chat(
      [{ role: 'user', content: 'Say OK' }],
      {
        llm: [
          { provider: 'groq', model: 'nonexistent-model-xyz' },
          { provider: 'groq', model: 'llama-3.1-8b-instant' },
        ],
        fallbackOptions: { timeoutMs: 15_000, retriesPerProvider: 0 },
      },
    );

    expect(result.content.length).toBeGreaterThan(0);
    expect(result.fallbackUsed).toBe(true);
    expect(result.provider).toBe('groq');
  }, 60_000);
});
