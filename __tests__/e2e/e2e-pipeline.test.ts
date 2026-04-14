/**
 * E2E Pipeline: Audio → STT → LLM → TTS → Audio
 *
 * Full pipeline integration tests using real provider APIs.
 * Required env var: GROQ_API_KEY
 * Optional env var: OPENAI_API_KEY
 *
 * Run with:
 *   cd packages/ai-gateway && set -a && source ../../.env.local && set +a && bunx vitest run __tests__/e2e-pipeline.test.ts --reporter=verbose
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
  OpenAICompatLLMProvider,
  OpenAICompatSTTProvider,
} from '@ai-gateway';
import { OPENAI_STT_MODELS } from '@ai-gateway/providers/openai/models';
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
const HAS_OPENAI = !!process.env.OPENAI_API_KEY;

function makeOpenaiLLM() {
  return new OpenAICompatLLMProvider({
    providerId: 'openai',
    baseURL: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
  });
}

function makeOpenaiSTT() {
  return new OpenAICompatSTTProvider({
    providerId: 'openai',
    baseURL: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    models: OPENAI_STT_MODELS,
    defaultModel: 'gpt-4o-mini-transcribe',
  });
}

function createPipelineClient(): AIClient {
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

  if (HAS_OPENAI) {
    registry.register({
      id: 'openai',
      name: 'OpenAI',
      description: 'OpenAI provider',
      capabilities: ['llm', 'stt', 'tts'],
      requiresApiKey: true,
      llm: makeOpenaiLLM(),
      stt: makeOpenaiSTT(),
    });
  }

  return createAIClient({ registry, defaultProfile: 'voice' });
}

describe('E2E Pipeline: Audio → STT → LLM → TTS', () => {
  let client: AIClient;

  beforeAll(() => {
    client = createPipelineClient();
    console.log(`[e2e-pipeline] GROQ=${HAS_GROQ}, OPENAI=${HAS_OPENAI}`);
  });

  beforeEach(() => clearCooldowns());

  const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

  test('STT only: transcribe audio returns text', async () => {
    const audio = generateToneWav(1.0);
    try {
      const result = await client.transcribe(audio, {
        stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
      });
      expect(result.text).toBeTruthy();
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.provider).toBeDefined();
      expect(result.latencyMs).toBeGreaterThan(0);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
      throw err;
    }
  }, 60_000);

  test('LLM only: chat returns response', async () => {
    try {
      const result = await client.chat(
        [{ role: 'user', content: 'Say "hello" and nothing else.' }],
        { llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }], maxTokens: 20 },
      );
      expect(result.content).toBeTruthy();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.provider).toBeDefined();
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
      throw err;
    }
  }, 60_000);

  test('TTS only: synthesize returns audio buffer', async () => {
    try {
      const result = await client.synthesize('Hello world', {
        tts: [{ provider: 'groq', model: 'canopylabs/orpheus-v1-english' }],
        voice: 'autumn',
      });
      expect(result.audio).toBeInstanceOf(Buffer);
      expect(result.audio.length).toBeGreaterThan(0);
      expect(result.contentType).toBeTruthy();
      expect(result.provider).toBeDefined();
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
      throw err;
    }
  }, 60_000);

  test('Full pipeline: audio → text → response → audio', async () => {
    const audio = generateToneWav(1.0);
    try {
      const result = await client.pipeline(
        audio,
        'You are a helpful assistant. Keep responses under 20 words.',
        [],
        {
          stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
          llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }],
          tts: [{ provider: 'groq', model: 'canopylabs/orpheus-v1-english' }],
          voice: 'autumn',
          maxTokens: 50,
          fallbackOptions: { timeoutMs: 30_000, retriesPerProvider: 0 },
        },
      );
      expect(result.stt.text).toBeTruthy();
      expect(result.stt.provider).toBe('groq');
      expect(result.chat.content).toBeTruthy();
      expect(result.chat.provider).toBe('groq');
      expect(result.tts.audio).toBeInstanceOf(Buffer);
      expect(result.tts.audio.length).toBeGreaterThan(0);
      expect(result.totalLatencyMs).toBeGreaterThan(0);
      expect(result.usedGpu).toBe(false);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
      throw err;
    }
  }, 90_000);

  test('Pipeline with conversation history', async () => {
    const audio = generateToneWav(0.5);
    try {
      const result = await client.pipeline(
        audio,
        'You are a teacher. Answer briefly in one sentence.',
        [
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: '4' },
        ],
        {
          stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
          llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }],
          tts: [{ provider: 'groq', model: 'canopylabs/orpheus-v1-english' }],
          voice: 'autumn',
          maxTokens: 50,
          fallbackOptions: { timeoutMs: 30_000, retriesPerProvider: 0 },
        },
      );
      expect(result.chat.content).toBeTruthy();
      expect(result.chat.content.length).toBeGreaterThan(0);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
      throw err;
    }
  }, 90_000);
});
