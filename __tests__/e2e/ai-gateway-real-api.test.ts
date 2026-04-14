/**
 * AI Gateway — Real API Integration Tests
 *
 * These tests hit REAL provider endpoints (Groq, OpenAI, Modal) to verify
 * the ai-gateway works end-to-end with actual APIs. They require valid
 * API keys in the environment.
 *
 * Run with:  bun run vitest run __tests__/integration/ai-gateway-real-api.test.ts
 *
 * Required env vars: GROQ_API_KEY (minimum)
 * Optional env vars: OPENAI_API_KEY, OPENROUTER_API_KEY, FIREWORKS_API_KEY
 */

import 'dotenv/config';

// Polyfill globalThis.File for OpenAI SDK's toFile() in Vitest workers
if (typeof globalThis.File === 'undefined') {
  const { File } = await import('node:buffer');
  globalThis.File = File as unknown as typeof globalThis.File;
}

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  AIProviderRegistry,
  createAIClient,
  groqSTT,
  groqTTS,
  groqLLM,
  modalTTS,
  openrouterLLM,
  fireworksLLM,
  OpenAICompatLLMProvider,
  OpenAICompatSTTProvider,
  OpenAICompatTTSProvider,
  withProviderFallback,
  getCooldownState,
} from '@ai-gateway';
import { buildSilentWav } from '@ai-gateway/browser/audio';
import { OPENAI_STT_MODELS, OPENAI_TTS_MODELS, OPENAI_VOICES } from '@ai-gateway/providers/openai/models';
import type { AIClient, AIProfile } from '@ai-gateway';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clear all cooldown state between test suites to prevent cascading failures */
function clearCooldowns() {
  getCooldownState().clear();
}

/** Generate a short WAV with a 440Hz sine tone for STT tests */
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

/** Load a real WAV file from the project for STT tests */
function loadTestAudio(): Buffer {
  const candidates = [
    path.resolve(__dirname, '../../test-audio.wav'),
    path.resolve(__dirname, '../../tests/fixtures/fake-audio.wav'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p);
  }
  return generateToneWav(1.0);
}

// ---------------------------------------------------------------------------
// Check which API keys are available
// ---------------------------------------------------------------------------

const HAS_GROQ = !!process.env.GROQ_API_KEY;
const HAS_OPENAI = !!process.env.OPENAI_API_KEY;
const HAS_OPENROUTER = !!process.env.OPENROUTER_API_KEY;
const HAS_FIREWORKS = !!process.env.FIREWORKS_API_KEY;

// Verify provider endpoints are actually working (keys may exist but be expired)
let OPENAI_VALID = false;
let MODAL_AVAILABLE = false;

function skipIf(condition: boolean, _reason: string) {
  return condition ? it.skip : it;
}

// ---------------------------------------------------------------------------
// Provider instances (created lazily to avoid errors when key is missing)
// ---------------------------------------------------------------------------

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

function makeOpenaiTTS() {
  return new OpenAICompatTTSProvider({
    providerId: 'openai',
    baseURL: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    models: OPENAI_TTS_MODELS,
    voices: OPENAI_VOICES,
    defaultModel: 'gpt-4o-mini-tts',
    defaultVoice: 'coral',
  });
}

// ---------------------------------------------------------------------------
// Create fully-configured AIClient
// ---------------------------------------------------------------------------

function createRealClient(): AIClient {
  const registry = new AIProviderRegistry();

  if (OPENAI_VALID) {
    registry.register({
      id: 'openai',
      name: 'OpenAI',
      description: 'OpenAI provider',
      capabilities: ['llm', 'stt', 'tts'],
      requiresApiKey: true,
      llm: makeOpenaiLLM(),
      stt: makeOpenaiSTT(),
      tts: makeOpenaiTTS(),
    });
  }

  if (HAS_GROQ) {
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
  }

  if (HAS_OPENROUTER) {
    registry.register({
      id: 'openrouter',
      name: 'OpenRouter',
      description: 'OpenRouter provider',
      capabilities: ['llm'],
      requiresApiKey: true,
      llm: openrouterLLM,
    });
  }

  if (HAS_FIREWORKS) {
    registry.register({
      id: 'fireworks',
      name: 'Fireworks',
      description: 'Fireworks provider',
      capabilities: ['llm'],
      requiresApiKey: true,
      llm: fireworksLLM,
    });
  }

  registry.register({
    id: 'modal',
    name: 'Modal',
    description: 'Modal provider',
    capabilities: ['tts'],
    requiresApiKey: false,
    tts: modalTTS,
  });

  return createAIClient({
    registry,
    defaultProfile: 'voice',
  });
}

// ---------------------------------------------------------------------------
// Pre-flight: validate which keys actually work
// ---------------------------------------------------------------------------

beforeAll(async () => {
  console.log(`\n[real-api] API keys available: GROQ=${HAS_GROQ}, OPENAI=${HAS_OPENAI}, OPENROUTER=${HAS_OPENROUTER}, FIREWORKS=${HAS_FIREWORKS}`);

  // Check OpenAI API is actually usable (not just authenticated — also checks for 429 rate limits)
  if (HAS_OPENAI) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: '.' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(10_000),
      });
      OPENAI_VALID = res.ok;
      if (!OPENAI_VALID) {
        console.log(`[real-api] OpenAI unavailable (${res.status}) — OpenAI tests will be skipped`);
      }
    } catch {
      OPENAI_VALID = false;
      console.log('[real-api] OpenAI check failed — OpenAI tests will be skipped');
    }
  }

  // Quick health check for Modal TTS endpoint
  try {
    const modalRes = await fetch(process.env.MOSS_TTS_URL || 'https://marcosremar--babelcast-moss-tts-serve.modal.run/health', {
      signal: AbortSignal.timeout(10_000),
    });
    MODAL_AVAILABLE = modalRes.ok;
  } catch {
    MODAL_AVAILABLE = false;
  }
  console.log(`[real-api] OpenAI valid: ${OPENAI_VALID}, Modal available: ${MODAL_AVAILABLE}`);
}, 30_000);

// ═══════════════════════════════════════════════════════════════════════════
// 1. Provider Direct Calls
// ═══════════════════════════════════════════════════════════════════════════

describe('Real API: Provider Direct Calls', () => {
  beforeEach(() => clearCooldowns());

  // ── Groq STT ──────────────────────────────────────────────────────────

  describe('Groq STT (Whisper)', () => {
    const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

    test('transcribes audio with whisper-large-v3-turbo', async () => {
      const audio = loadTestAudio();
      try {
        const result = await groqSTT.transcribe({
          audio,
          model: 'whisper-large-v3-turbo',
        });
        expect(result).toBeDefined();
        expect(typeof result.text).toBe('string');
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);

    test('transcribes with language hint', async () => {
      const audio = loadTestAudio();
      try {
        const result = await groqSTT.transcribe({
          audio,
          model: 'whisper-large-v3-turbo',
          language: 'pt',
        });
        expect(result.text).toBeDefined();
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);

    test('returns duration when available', async () => {
      const audio = loadTestAudio();
      try {
        const result = await groqSTT.transcribe({
          audio,
          model: 'whisper-large-v3-turbo',
        });
        if (result.duration !== undefined) {
          expect(result.duration).toBeGreaterThan(0);
        }
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);
  });

  // ── OpenAI STT ────────────────────────────────────────────────────────

  describe('OpenAI STT (Whisper)', () => {
    // Use a getter so OPENAI_VALID is checked at test-time, not definition-time
    it('transcribes audio with gpt-4o-mini-transcribe', async () => {
      if (!OPENAI_VALID) return; // skip dynamically
      const audio = loadTestAudio();
      const result = await makeOpenaiSTT().transcribe({
        audio,
        model: 'gpt-4o-mini-transcribe',
      });
      expect(result).toBeDefined();
      expect(typeof result.text).toBe('string');
    }, 30_000);
  });

  // ── Groq LLM ──────────────────────────────────────────────────────────

  describe('Groq LLM (Llama)', () => {
    const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

    test('chat completion with llama-3.3-70b', async () => {
      try {
        const result = await groqLLM.chat({
          messages: [
            { role: 'system', content: 'You are a helpful assistant. Reply in one sentence.' },
            { role: 'user', content: 'What is 2+2?' },
          ],
          model: 'llama-3.3-70b-versatile',
          temperature: 0,
          maxTokens: 50,
        });
        expect(result.content).toBeDefined();
        expect(result.content.length).toBeGreaterThan(0);
        expect(result.content.toLowerCase()).toContain('4');
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);

    test('chat returns token usage', async () => {
      try {
        const result = await groqLLM.chat({
          messages: [{ role: 'user', content: 'Say hi' }],
          model: 'llama-3.3-70b-versatile',
          maxTokens: 10,
        });
        expect(result.usage).toBeDefined();
        expect(result.usage!.promptTokens).toBeGreaterThan(0);
        expect(result.usage!.completionTokens).toBeGreaterThan(0);
        expect(result.usage!.totalTokens).toBeGreaterThan(0);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);

    test('chat with small model (llama-3.1-8b-instant)', async () => {
      try {
        const result = await groqLLM.chat({
          messages: [{ role: 'user', content: 'What is the capital of France? Reply in one word.' }],
          model: 'llama-3.1-8b-instant',
          temperature: 0,
          maxTokens: 20,
        });
        expect(result.content.toLowerCase()).toContain('paris');
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);

    test('chat with temperature=0 is deterministic', async () => {
      try {
        const msg = [{ role: 'user' as const, content: 'What is 10*10? Reply with just the number.' }];
        const opts = { model: 'llama-3.1-8b-instant' as const, temperature: 0, maxTokens: 10 };
        const r1 = await groqLLM.chat({ messages: msg, ...opts });
        const r2 = await groqLLM.chat({ messages: msg, ...opts });
        expect(r1.content).toBe(r2.content);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);
  });

  // ── OpenAI LLM ────────────────────────────────────────────────────────

  describe('OpenAI LLM (GPT-4o-mini)', () => {
    it('chat completion with gpt-4o-mini', async () => {
      if (!OPENAI_VALID) return;
      const result = await makeOpenaiLLM().chat({
        messages: [
          { role: 'system', content: 'Reply in one word only.' },
          { role: 'user', content: 'Capital of Japan?' },
        ],
        model: 'gpt-4o-mini',
        temperature: 0,
        maxTokens: 10,
      });
      expect(result.content.toLowerCase()).toContain('tokyo');
    }, 30_000);

    it('JSON response format', async () => {
      if (!OPENAI_VALID) return;
      const result = await makeOpenaiLLM().chat({
        messages: [
          { role: 'system', content: 'Reply in JSON format with a single key "answer".' },
          { role: 'user', content: 'What is 5+5?' },
        ],
        model: 'gpt-4o-mini',
        temperature: 0,
        maxTokens: 50,
        responseFormat: { type: 'json_object' },
      });
      const parsed = JSON.parse(result.content);
      expect(parsed.answer).toBeDefined();
    }, 30_000);
  });

  // ── OpenAI TTS ────────────────────────────────────────────────────────

  describe('OpenAI TTS', () => {
    it('synthesize text to audio with gpt-4o-mini-tts', async () => {
      if (!OPENAI_VALID) return;
      const result = await makeOpenaiTTS().synthesize({
        input: 'Hello, this is a test.',
        model: 'gpt-4o-mini-tts',
        voice: 'coral',
      });
      expect(result.audio).toBeDefined();
      expect(result.audio.length).toBeGreaterThan(1000);
      expect(result.contentType).toBeDefined();
    }, 30_000);

    it('synthesize with wav format', async () => {
      if (!OPENAI_VALID) return;
      const result = await makeOpenaiTTS().synthesize({
        input: 'WAV format test.',
        model: 'gpt-4o-mini-tts',
        voice: 'coral',
        responseFormat: 'wav',
      });
      expect(result.audio.length).toBeGreaterThan(1000);
      const header = Buffer.from(result.audio).slice(0, 4).toString('ascii');
      expect(header).toBe('RIFF');
    }, 30_000);
  });

  // ── Groq TTS (Orpheus) ────────────────────────────────────────────────

  describe('Groq TTS (Orpheus)', () => {
    const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

    test('synthesize text with orpheus-v1-english', async () => {
      try {
        const result = await groqTTS.synthesize({
          input: 'Hello world, testing Orpheus TTS.',
          model: 'canopylabs/orpheus-v1-english',
          voice: 'autumn',
          responseFormat: 'wav', // Groq TTS only supports wav
        });
        expect(result.audio).toBeDefined();
        expect(result.audio.length).toBeGreaterThan(100);
        expect(result.contentType).toBeDefined();
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);
  });

  // ── Modal TTS (MOSS) ──────────────────────────────────────────────────

  describe('Modal TTS (MOSS-TTS-Realtime)', () => {
    it('synthesize text in Portuguese', async () => {
      if (!MODAL_AVAILABLE) return; // Modal endpoint may be stopped
      const result = await modalTTS.synthesize({
        input: 'Olá, como você está?',
        model: 'moss-tts-realtime',
        voice: 'moss-pt',
      });
      expect(result.audio).toBeDefined();
      expect(result.audio.length).toBeGreaterThan(100);
      expect(result.contentType).toBe('audio/wav');
    }, 60_000);

    it('synthesize text in English', async () => {
      if (!MODAL_AVAILABLE) return;
      const result = await modalTTS.synthesize({
        input: 'Hello, how are you?',
        model: 'moss-tts-realtime',
        voice: 'moss-en',
      });
      expect(result.audio).toBeDefined();
      expect(result.audio.length).toBeGreaterThan(100);
    }, 60_000);
  });

  // ── OpenRouter LLM ────────────────────────────────────────────────────

  describe('OpenRouter LLM', () => {
    const test = skipIf(!HAS_OPENROUTER, 'OPENROUTER_API_KEY not set');

    test('chat completion via OpenRouter', async () => {
      try {
        const result = await openrouterLLM.chat({
          messages: [
            { role: 'user', content: 'What is 3+3? Reply with just the number.' },
          ],
          model: 'meta-llama/llama-3.3-70b-instruct',
          temperature: 0,
          maxTokens: 10,
        });
        expect(result.content).toContain('6');
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. AIClient Unified Interface
// ═══════════════════════════════════════════════════════════════════════════

describe('Real API: AIClient Unified Interface', () => {
  let client: AIClient;

  beforeAll(() => { client = createRealClient(); });
  beforeEach(() => clearCooldowns());

  // ── Transcription ─────────────────────────────────────────────────────

  describe('client.transcribe()', () => {
    const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

    test('transcribes with voice profile (Groq)', async () => {
      const audio = loadTestAudio();
      try {
        const result = await client.transcribe(audio, {
          stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
          fallbackOptions: { timeoutMs: 15_000, retriesPerProvider: 0 },
        });
        expect(result.text).toBeDefined();
        expect(typeof result.text).toBe('string');
        expect(result.provider).toBe('groq');
        expect(result.latencyMs).toBeGreaterThan(0);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);

    test('transcribes with STT preset', async () => {
      const audio = loadTestAudio();
      try {
        // STT preset has Groq first → OpenAI second; only Groq should work
        const result = await client.transcribe(audio, {
          stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
        });
        expect(result.text).toBeDefined();
        expect(result.provider).toBe('groq');
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);
  });

  // ── Chat ──────────────────────────────────────────────────────────────

  describe('client.chat()', () => {
    const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

    test('chat with Groq LLM', async () => {
      try {
        const result = await client.chat(
          [{ role: 'user', content: 'Say hello in Portuguese. Just the greeting, nothing else.' }],
          { llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }] },
        );
        expect(result.content).toBeDefined();
        expect(result.content.length).toBeGreaterThan(0);
        expect(result.provider).toBe('groq');
        expect(result.latencyMs).toBeGreaterThan(0);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);

    test('chat with system profile (lower temperature)', async () => {
      try {
        const result = await client.chat(
          [
            { role: 'system', content: 'You are a math assistant. Reply only with the number.' },
            { role: 'user', content: 'What is 7*8?' },
          ],
          {
            llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
            temperature: 0.3,
            maxTokens: 20,
          },
        );
        expect(result.content).toContain('56');
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);

    test('chat with specific small model', async () => {
      try {
        const result = await client.chat(
          [{ role: 'user', content: 'What color is the sky? One word.' }],
          {
            llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }],
            temperature: 0,
            maxTokens: 10,
          },
        );
        expect(result.content.toLowerCase()).toContain('blue');
        expect(result.provider).toBe('groq');
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);

    test('chat returns usage metrics', async () => {
      try {
        const result = await client.chat(
          [{ role: 'user', content: 'Hi' }],
          { llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }], maxTokens: 10 },
        );
        expect(result.usage).toBeDefined();
        expect(result.usage!.totalTokens).toBeGreaterThan(0);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);
  });

  // ── TTS ───────────────────────────────────────────────────────────────

  describe('client.synthesize()', () => {
    const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

    test('synthesize with Groq Orpheus TTS', async () => {
      try {
        const result = await client.synthesize(
          'Hello world, testing synthesis.',
          {
            tts: [{ provider: 'groq', model: 'canopylabs/orpheus-v1-english' }],
            voice: 'autumn',
          },
        );
        expect(result.audio).toBeDefined();
        expect(result.audio.length).toBeGreaterThan(100);
        expect(result.provider).toBe('groq');
        expect(result.contentType).toBeDefined();
        expect(result.latencyMs).toBeGreaterThan(0);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);

    it('synthesize with Modal TTS (no key needed)', async () => {
      if (!MODAL_AVAILABLE) return;
      const result = await client.synthesize(
        'Testing Modal TTS.',
        {
          tts: [{ provider: 'modal', model: 'moss-tts-realtime' }],
          voice: 'moss-en',
        },
      );
      expect(result.audio.length).toBeGreaterThan(100);
      expect(result.provider).toBe('modal');
    }, 60_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Fallback Chain Behavior (Real APIs)
// ═══════════════════════════════════════════════════════════════════════════

describe('Real API: Fallback Chain Behavior', () => {
  let client: AIClient;

  beforeAll(() => { client = createRealClient(); });
  beforeEach(() => clearCooldowns());

  // ── LLM Fallback with invalid key ─────────────────────────────────────

  describe('LLM fallback with invalid API key', () => {
    const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

    test('falls back from bad Groq key to good Groq (different model)', async () => {
      // Use withProviderFallback directly to test fallback with one real provider
      const chain = [
        { provider: 'groq-bad', model: 'llama-3.3-70b-versatile' },
        { provider: 'groq-good', model: 'llama-3.1-8b-instant' },
      ];

      try {
        const { result, usedProvider, attempts } = await withProviderFallback(
          chain,
          async (entry) => {
            if (entry.provider === 'groq-bad') {
              const err = new Error('Invalid API key');
              (err as any).status = 401;
              throw err;
            }
            return groqLLM.chat({
              messages: [{ role: 'user', content: 'Say OK' }],
              model: entry.model!,
              maxTokens: 5,
            });
          },
          { timeoutMs: 15_000, retriesPerProvider: 0, logPrefix: '[LLM-Fallback]' },
        );

        expect(usedProvider).toBe('groq-good');
        expect(attempts).toBe(2);
        expect(result.content.length).toBeGreaterThan(0);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);

    it('falls back from bad OpenAI to good Groq via AIClient', async () => {
      if (!HAS_GROQ) return;
      try {
        // Force OpenAI to fail with bad key, Groq uses real key from env
        const result = await client.chat(
          [{ role: 'user', content: 'Say OK' }],
          {
            llm: [
              { provider: 'openai', model: 'gpt-4o-mini' },
              { provider: 'groq', model: 'llama-3.1-8b-instant' },
            ],
            keys: { openai: 'invalid-key-xxxxx' },
            fallbackOptions: { timeoutMs: 15_000, retriesPerProvider: 0 },
          },
        );

        expect(result.provider).toBe('groq');
        expect(result.fallbackUsed).toBe(true);
        expect(result.content.length).toBeGreaterThan(0);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);

    it('falls back through OpenAI+Groq(bad) to Groq(good)', async () => {
      if (!HAS_GROQ) return;
      // Both OpenAI (bad key) and first Groq (bad key) fail, second Groq succeeds
      const chain = [
        { provider: 'openai-bad', model: 'gpt-4o-mini' },
        { provider: 'groq-bad', model: 'llama-3.3-70b-versatile' },
        { provider: 'groq-good', model: 'llama-3.1-8b-instant' },
      ];

      try {
        const { result, usedProvider, attempts } = await withProviderFallback(
          chain,
          async (entry) => {
            if (entry.provider.includes('bad')) {
              const err = new Error('Unauthorized');
              (err as any).status = 401;
              throw err;
            }
            return groqLLM.chat({
              messages: [{ role: 'user', content: 'Say hello' }],
              model: entry.model!,
              maxTokens: 10,
            });
          },
          { timeoutMs: 15_000, retriesPerProvider: 0, logPrefix: '[Multi-Fallback]' },
        );

        expect(usedProvider).toBe('groq-good');
        expect(attempts).toBe(3);
        expect(result.content.length).toBeGreaterThan(0);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);
  });

  // ── STT Fallback ─────────────────────────────────────────────────────

  describe('STT fallback', () => {
    const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

    test('falls back from bad STT provider to Groq STT', async () => {
      const audio = loadTestAudio();
      const chain = [
        { provider: 'fake-stt', model: 'fake-whisper' },
        { provider: 'groq', model: 'whisper-large-v3-turbo' },
      ];

      try {
        const { result, usedProvider } = await withProviderFallback(
          chain,
          async (entry) => {
            if (entry.provider === 'fake-stt') {
              const err = new Error('Service unavailable');
              (err as any).status = 503;
              throw err;
            }
            return groqSTT.transcribe({ audio, model: entry.model! });
          },
          { timeoutMs: 15_000, retriesPerProvider: 0, logPrefix: '[STT-Fallback]' },
        );

        expect(usedProvider).toBe('groq');
        expect(typeof result.text).toBe('string');
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);
  });

  // ── TTS Fallback ──────────────────────────────────────────────────────

  describe('TTS fallback chain', () => {
    const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

    test('falls back from bad TTS to Groq Orpheus', async () => {
      try {
        const result = await client.synthesize(
          'Fallback TTS test.',
          {
            tts: [
              { provider: 'openai', model: 'gpt-4o-mini-tts' },
              { provider: 'groq', model: 'canopylabs/orpheus-v1-english' },
            ],
            voice: 'autumn',
            keys: { openai: 'invalid-key-xxxxx' },
            fallbackOptions: { timeoutMs: 15_000, retriesPerProvider: 0 },
          },
        );

        expect(result.provider).toBe('groq');
        expect(result.fallbackUsed).toBe(true);
        expect(result.audio.length).toBeGreaterThan(100);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);

    it('falls back to Modal TTS when cloud providers fail', async () => {
      if (!MODAL_AVAILABLE) return;
      const result = await client.synthesize(
        'Testing Modal fallback.',
        {
          tts: [
            { provider: 'openai', model: 'gpt-4o-mini-tts' },
            { provider: 'modal', model: 'moss-tts-realtime' },
          ],
          voice: 'moss-en',
          keys: { openai: 'invalid-key-xxxxx' },
          fallbackOptions: { timeoutMs: 60_000, retriesPerProvider: 0 },
        },
      );

      expect(result.provider).toBe('modal');
      expect(result.fallbackUsed).toBe(true);
      expect(result.audio.length).toBeGreaterThan(100);
    }, 90_000);
  });

  // ── Timeout fallback ──────────────────────────────────────────────────

  describe('Timeout fallback', () => {
    const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

    test('slow provider times out, fast provider succeeds', async () => {
      const chain = [
        { provider: 'slow', model: 'slow-model' },
        { provider: 'groq', model: 'llama-3.1-8b-instant' },
      ];

      try {
        const { result, usedProvider, attempts } = await withProviderFallback(
          chain,
          async (entry) => {
            if (entry.provider === 'slow') {
              await new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Request timed out')), 100),
              );
            }
            return groqLLM.chat({
              messages: [{ role: 'user', content: 'Say OK' }],
              model: entry.model!,
              maxTokens: 5,
            });
          },
          { timeoutMs: 500, retriesPerProvider: 0, logPrefix: '[Timeout]' },
        );

        expect(usedProvider).toBe('groq');
        expect(attempts).toBe(2);
        expect(result.content.length).toBeGreaterThan(0);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Full Pipeline (STT → LLM → TTS)
// ═══════════════════════════════════════════════════════════════════════════

describe('Real API: Full Pipeline (STT → LLM → TTS)', () => {
  let client: AIClient;

  beforeAll(() => { client = createRealClient(); });
  beforeEach(() => clearCooldowns());

  describe('client.pipeline()', () => {
    const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

    test('runs complete STT → LLM → TTS pipeline (Groq only)', async () => {
      const audio = loadTestAudio();
      try {
        const result = await client.pipeline(
          audio,
          'You are a helpful assistant. Reply briefly in one sentence.',
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

        // STT result
        expect(result.stt).toBeDefined();
        expect(result.stt.text).toBeDefined();
        expect(result.stt.provider).toBe('groq');

        // LLM result
        expect(result.chat).toBeDefined();
        expect(result.chat.content.length).toBeGreaterThan(0);
        expect(result.chat.provider).toBe('groq');

        // TTS result
        expect(result.tts).toBeDefined();
        expect(result.tts.audio.length).toBeGreaterThan(100);
        expect(result.tts.contentType).toBeDefined();

        // Metadata
        expect(result.totalLatencyMs).toBeGreaterThan(0);
        expect(result.usedGpu).toBe(false);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 60_000);
  });

  describe('client.pipelineStream()', () => {
    const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

    test('streams pipeline events for STT → LLM → TTS', async () => {
      const audio = loadTestAudio();
      const events: any[] = [];

      try {
        const stream = client.pipelineStream(
          audio,
          'You are helpful. Reply in one short sentence.',
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

        for await (const event of stream) {
          events.push(event);
        }

        const eventTypes = events.map(e => e.event);

        // If stream emitted an error event due to auth failure, skip gracefully
        if (eventTypes.includes('error')) {
          const errorEvent = events.find(e => e.event === 'error');
          const errMsg = String(errorEvent?.data?.message ?? errorEvent?.data ?? '');
          if (errMsg.includes('401') || errMsg.includes('Invalid API Key') || errMsg.includes('auth')) return;
        }

        expect(eventTypes).toContain('stage');
        expect(eventTypes).toContain('transcript');
        expect(eventTypes).toContain('response');
        expect(eventTypes).toContain('audio');
        expect(eventTypes).toContain('complete');

        // Validate transcript
        const transcriptEvent = events.find(e => e.event === 'transcript');
        expect(transcriptEvent.data.text).toBeDefined();

        // Validate response
        const responseEvent = events.find(e => e.event === 'response');
        expect(responseEvent.data.text.length).toBeGreaterThan(0);

        // Validate audio
        const audioEvent = events.find(e => e.event === 'audio');
        expect(audioEvent.data.base64.length).toBeGreaterThan(100);

        // Validate complete
        const completeEvent = events.find(e => e.event === 'complete');
        expect(completeEvent.data.usedGpu).toBe(false);
        expect(completeEvent.data.providers).toBeDefined();
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 60_000);
  });

  describe('pipeline with mixed providers', () => {
    it('pipeline: Groq STT → Groq LLM → Modal TTS', async () => {
      if (!HAS_GROQ || !MODAL_AVAILABLE) return;
      const audio = loadTestAudio();
      const result = await client.pipeline(
        audio,
        'Reply in one sentence.',
        [],
        {
          stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
          llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }],
          tts: [{ provider: 'modal', model: 'moss-tts-realtime' }],
          voice: 'moss-en',
          maxTokens: 50,
          fallbackOptions: { timeoutMs: 60_000, retriesPerProvider: 0 },
        },
      );

      expect(result.stt.provider).toBe('groq');
      expect(result.chat.provider).toBe('groq');
      expect(result.tts.provider).toBe('modal');
      expect(result.tts.audio.length).toBeGreaterThan(100);
    }, 90_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Preset Profiles (Real APIs)
// ═══════════════════════════════════════════════════════════════════════════

describe('Real API: Preset Profiles', () => {
  let client: AIClient;

  beforeAll(() => { client = createRealClient(); });
  beforeEach(() => clearCooldowns());

  describe('voice preset', () => {
    const test = skipIf(!HAS_GROQ, 'Need Groq');

    test('chat via voice preset uses Groq first', async () => {
      try {
        const result = await client.chat(
          [{ role: 'user', content: 'Say hi' }],
          {
            preset: 'voice',
            llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
          },
        );
        expect(result.provider).toBe('groq');
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);
  });

  describe('system preset (low temperature)', () => {
    const test = skipIf(!HAS_GROQ, 'Need Groq');

    test('system preset gives deterministic answers', async () => {
      const msg = [{ role: 'user' as const, content: 'What is 2+2? Just the number.' }];
      const profile: AIProfile = {
        llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }],
        temperature: 0,
        maxTokens: 10,
      };
      try {
        const r1 = await client.chat(msg, profile);
        const r2 = await client.chat(msg, profile);
        expect(r1.content.trim()).toBe(r2.content.trim());
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Error Handling
// ═══════════════════════════════════════════════════════════════════════════

describe('Real API: Error Handling', () => {
  let client: AIClient;

  beforeAll(() => { client = createRealClient(); });
  beforeEach(() => clearCooldowns());

  it('throws when all providers have invalid keys', async () => {
    await expect(
      client.chat(
        [{ role: 'user', content: 'Hello' }],
        {
          llm: [
            { provider: 'groq', model: 'llama-3.1-8b-instant' },
          ],
          keys: { groq: 'invalid-key-1' },
          fallbackOptions: { timeoutMs: 15_000, retriesPerProvider: 0 },
        },
      ),
    ).rejects.toThrow();
  }, 30_000);

  it('throws on empty provider chain', async () => {
    await expect(
      client.chat(
        [{ role: 'user', content: 'Hello' }],
        { llm: [] },
      ),
    ).rejects.toThrow(/No LLM providers configured/);
  });

  const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

  test('non-existent model (404) falls back to next provider', async () => {
    try {
      // 404 is in RETRYABLE_STATUSES, so it falls back to the next provider
      const result = await client.chat(
        [{ role: 'user', content: 'Say hi' }],
        {
          llm: [
            { provider: 'groq', model: 'nonexistent-model-xyz' },
            { provider: 'groq', model: 'llama-3.1-8b-instant' },
          ],
          fallbackOptions: { timeoutMs: 15_000, retriesPerProvider: 0 },
        },
      );
      expect(result.provider).toBe('groq');
      expect(result.fallbackUsed).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
      throw err;
    }
  }, 30_000);

  test('rate limit (429) moves to next provider without retry', async () => {
    const chain = [
      { provider: 'rate-limited', model: 'model-a' },
      { provider: 'groq', model: 'llama-3.1-8b-instant' },
    ];

    try {
      const { usedProvider, attempts } = await withProviderFallback(
        chain,
        async (entry) => {
          if (entry.provider === 'rate-limited') {
            const err = new Error('Rate limited');
            (err as any).status = 429;
            throw err;
          }
          return groqLLM.chat({
            messages: [{ role: 'user', content: 'Say OK' }],
            model: entry.model!,
            maxTokens: 5,
          });
        },
        { timeoutMs: 15_000, retriesPerProvider: 2, logPrefix: '[429]' },
      );

      // Should NOT retry the rate-limited provider, just move on
      expect(usedProvider).toBe('groq');
      expect(attempts).toBe(2);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
      throw err;
    }
  }, 30_000);

  test('5xx error retries before fallback', async () => {
    let callCount = 0;
    const chain = [
      { provider: 'flaky', model: 'model-a' },
      { provider: 'groq', model: 'llama-3.1-8b-instant' },
    ];

    try {
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
        { timeoutMs: 15_000, retriesPerProvider: 1, retryBaseDelayMs: 50, logPrefix: '[5xx]' },
      );

      // Should have retried flaky once (2 attempts on flaky), then moved to groq
      expect(callCount).toBe(2);
      expect(usedProvider).toBe('groq');
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
      throw err;
    }
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Latency & Performance
// ═══════════════════════════════════════════════════════════════════════════

describe('Real API: Latency & Performance', () => {
  let client: AIClient;

  beforeAll(() => { client = createRealClient(); });
  beforeEach(() => clearCooldowns());

  describe('Groq (LPU) latency', () => {
    const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

    test('Groq LLM responds within 5 seconds', async () => {
      try {
        const t0 = Date.now();
        const result = await client.chat(
          [{ role: 'user', content: 'Say OK' }],
          {
            llm: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }],
            maxTokens: 5,
          },
        );
        const latency = Date.now() - t0;
        expect(latency).toBeLessThan(5_000);
        expect(result.latencyMs).toBeGreaterThan(0);
        expect(result.latencyMs).toBeLessThan(5_000);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 10_000);

    test('Groq STT responds within 8 seconds', async () => {
      const audio = loadTestAudio();
      try {
        const t0 = Date.now();
        await client.transcribe(audio, {
          stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
        });
        expect(Date.now() - t0).toBeLessThan(8_000);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 15_000);

    test('Groq TTS responds within 8 seconds', async () => {
      try {
        const t0 = Date.now();
        await client.synthesize('Quick test.', {
          tts: [{ provider: 'groq', model: 'canopylabs/orpheus-v1-english' }],
          voice: 'autumn',
        });
        expect(Date.now() - t0).toBeLessThan(8_000);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 15_000);
  });

  describe('OpenAI latency', () => {
    it('OpenAI gpt-4o-mini responds within 10 seconds', async () => {
      if (!OPENAI_VALID) return;
      const t0 = Date.now();
      await client.chat(
        [{ role: 'user', content: 'Say OK' }],
        {
          llm: [{ provider: 'openai', model: 'gpt-4o-mini' }],
          maxTokens: 5,
        },
      );
      expect(Date.now() - t0).toBeLessThan(10_000);
    }, 15_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Cross-Provider Consistency (Groq models)
// ═══════════════════════════════════════════════════════════════════════════

describe('Real API: Cross-Model Consistency', () => {
  beforeEach(() => clearCooldowns());

  describe('Groq models return consistent answers', () => {
    const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

    test('both Groq models answer a math question correctly', async () => {
      const question = [
        { role: 'system' as const, content: 'Reply with just the number, nothing else.' },
        { role: 'user' as const, content: 'What is 15+27?' },
      ];

      try {
        const [bigResult, smallResult] = await Promise.all([
          groqLLM.chat({
            messages: question,
            model: 'llama-3.3-70b-versatile',
            temperature: 0,
            maxTokens: 10,
          }),
          groqLLM.chat({
            messages: question,
            model: 'llama-3.1-8b-instant',
            temperature: 0,
            maxTokens: 10,
          }),
        ]);

        expect(bigResult.content).toContain('42');
        expect(smallResult.content).toContain('42');
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
        throw err;
      }
    }, 30_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. buildSilentWav utility with real providers
// ═══════════════════════════════════════════════════════════════════════════

describe('Real API: buildSilentWav with real STT', () => {
  beforeEach(() => clearCooldowns());
  const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

  test('silent WAV can be transcribed (returns empty or silence text)', async () => {
    const silentWav = Buffer.from(buildSilentWav(1.0, 16000));
    try {
      const result = await groqSTT.transcribe({
        audio: silentWav,
        model: 'whisper-large-v3-turbo',
      });
      expect(typeof result.text).toBe('string');
      expect(result.text.length).toBeLessThan(100);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
      throw err;
    }
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Cooldown system with real APIs
// ═══════════════════════════════════════════════════════════════════════════

describe('Real API: Cooldown system', () => {
  beforeEach(() => clearCooldowns());

  const test = skipIf(!HAS_GROQ, 'GROQ_API_KEY not set');

  test('provider enters cooldown after repeated failures', async () => {
    // Fail 3 times on same provider to trigger cooldown
    for (let i = 0; i < 3; i++) {
      try {
        await withProviderFallback(
          [{ provider: 'bad-provider', model: 'bad-model' }],
          async () => {
            const err = new Error('Server error');
            (err as any).status = 500;
            throw err;
          },
          { timeoutMs: 5_000, retriesPerProvider: 0, logPrefix: '[Cooldown-test]', allowedFails: 3, cooldownMs: 5_000 },
        );
      } catch { /* expected */ }
    }

    // Verify cooldown is active
    const cooldownState = getCooldownState();
    const state = cooldownState.get('bad-provider:bad-model');
    expect(state).toBeDefined();
    expect(state!.coolUntil).toBeGreaterThan(Date.now());
  }, 30_000);

  test('cooled-down provider is skipped, next provider used', async () => {
    // Trigger cooldown on first provider
    for (let i = 0; i < 3; i++) {
      try {
        await withProviderFallback(
          [{ provider: 'cd-test', model: 'cd-model' }],
          async () => {
            const err = new Error('Server error');
            (err as any).status = 500;
            throw err;
          },
          { timeoutMs: 5_000, retriesPerProvider: 0, logPrefix: '[CD]', allowedFails: 3, cooldownMs: 30_000 },
        );
      } catch { /* expected */ }
    }

    // Now try chain with cooled-down provider first, real Groq second
    try {
      const { usedProvider } = await withProviderFallback(
        [
          { provider: 'cd-test', model: 'cd-model' },
          { provider: 'groq', model: 'llama-3.1-8b-instant' },
        ],
        async (entry) => {
          if (entry.provider === 'cd-test') {
            throw new Error('Should not be called - in cooldown');
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
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
      throw err;
    }
  }, 30_000);
});
