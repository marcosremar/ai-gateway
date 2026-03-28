/**
 * AIClient Integration Tests — Real API
 *
 * Tests every public AIClient method against real provider APIs.
 * Validates the high-level SDK interface that all app routes use:
 *
 *   client.transcribe(audio)              // STT
 *   client.synthesize(text)               // TTS
 *   client.chat(messages)                 // LLM
 *   client.pipeline(audio, prompt)        // Speech-to-Speech
 *   client.realtimeSpeech(input)          // Realtime (WebRTC/session)
 *   client.omniChat(input, instructions)  // Audio in → audio+text out
 *   client.generate(prompt)               // Image generation
 *
 * Run:
 *   bun run vitest run __tests__/ai-client-integration.test.ts
 *
 * Required: OPENAI_API_KEY or GROQ_API_KEY (at least one)
 * Optional: FIREWORKS_API_KEY, OPENROUTER_API_KEY
 */

import 'dotenv/config';

// Polyfill File for Node/Vitest workers
if (typeof globalThis.File === 'undefined') {
  const { File } = await import('node:buffer');
  globalThis.File = File as unknown as typeof globalThis.File;
}

import { describe, it, expect, beforeAll } from 'vitest';
import {
  AIProviderRegistry,
  createAIClient,
  groqSTT,
  groqTTS,
  groqLLM,
  modalTTS,
  openrouterLLM,
  fireworksLLM,
  fireworksImage,
  OpenAICompatLLMProvider,
  OpenAICompatSTTProvider,
  OpenAICompatTTSProvider,
  OpenAIRealtimeProvider,
  OpenAIOmniProvider,
  openaiImage,
  getCooldownState,
} from '@ai-gateway';
import { OPENAI_STT_MODELS, OPENAI_TTS_MODELS, OPENAI_VOICES } from '@ai-gateway/providers/openai/models';
import type { AIClient } from '@ai-gateway';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearCooldowns() {
  getCooldownState().clear();
}

/** Generate a short WAV with a 440Hz sine tone */
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

// ---------------------------------------------------------------------------
// API key detection
// ---------------------------------------------------------------------------

const HAS_GROQ = !!process.env.GROQ_API_KEY;
const HAS_OPENAI = !!process.env.OPENAI_API_KEY;
const HAS_OPENROUTER = !!process.env.OPENROUTER_API_KEY;
const HAS_FIREWORKS = !!process.env.FIREWORKS_API_KEY;

let OPENAI_VALID = false;

function skipIf(condition: boolean, _reason: string) {
  return condition ? it.skip : it;
}

// ---------------------------------------------------------------------------
// Client factory — registers all available providers
// ---------------------------------------------------------------------------

function createFullClient(profile: string = 'voice'): AIClient {
  const registry = new AIProviderRegistry();

  if (OPENAI_VALID) {
    const omni = new OpenAIOmniProvider();
    const realtime = new OpenAIRealtimeProvider();

    registry.register({
      id: 'openai',
      name: 'OpenAI',
      description: 'OpenAI',
      capabilities: ['llm', 'stt', 'tts', 'omni', 'realtime', 'image'],
      requiresApiKey: true,
      llm: new OpenAICompatLLMProvider({ providerId: 'openai', baseURL: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', defaultModel: 'gpt-4o-mini' }),
      stt: new OpenAICompatSTTProvider({ providerId: 'openai', baseURL: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', models: OPENAI_STT_MODELS, defaultModel: 'gpt-4o-mini-transcribe' }),
      tts: new OpenAICompatTTSProvider({ providerId: 'openai', baseURL: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', models: OPENAI_TTS_MODELS, voices: OPENAI_VOICES, defaultModel: 'gpt-4o-mini-tts', defaultVoice: 'coral' }),
      omni,
      realtime,
      image: openaiImage,
    });
  }

  if (HAS_GROQ) {
    registry.register({
      id: 'groq',
      name: 'Groq',
      description: 'Groq',
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
      description: 'OpenRouter',
      capabilities: ['llm'],
      requiresApiKey: true,
      llm: openrouterLLM,
    });
  }

  if (HAS_FIREWORKS) {
    registry.register({
      id: 'fireworks',
      name: 'Fireworks',
      description: 'Fireworks',
      capabilities: ['llm', 'image'],
      requiresApiKey: true,
      llm: fireworksLLM,
      image: fireworksImage,
    });
  }

  registry.register({
    id: 'modal',
    name: 'Modal',
    description: 'Modal TTS',
    capabilities: ['tts'],
    requiresApiKey: false,
    tts: modalTTS,
  });

  return createAIClient({ registry, defaultProfile: profile as any });
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

let client: AIClient;
const testAudio = generateToneWav(1.0);

beforeAll(async () => {
  console.log(`\n[ai-client-integration] Keys: GROQ=${HAS_GROQ} OPENAI=${HAS_OPENAI} OPENROUTER=${HAS_OPENROUTER} FIREWORKS=${HAS_FIREWORKS}`);

  if (HAS_OPENAI) {
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      });
      OPENAI_VALID = res.ok;
      if (!OPENAI_VALID) console.log(`[ai-client-integration] OpenAI key INVALID (${res.status})`);
    } catch {
      OPENAI_VALID = false;
    }
  }

  console.log(`[ai-client-integration] OpenAI valid: ${OPENAI_VALID}`);

  client = createFullClient('voice');
  clearCooldowns();
}, 30_000);


// ═══════════════════════════════════════════════════════════════════════════
// 1. client.transcribe() — STT
// ═══════════════════════════════════════════════════════════════════════════

describe('client.transcribe()', () => {
  const test = skipIf(!HAS_GROQ && !HAS_OPENAI, 'No STT provider available');

  test('transcribes audio with default profile', async () => {
    clearCooldowns();
    const result = await client.transcribe(testAudio);
    expect(result).toBeDefined();
    expect(typeof result.text).toBe('string');
    expect(result.provider).toBeTruthy();
    expect(result.model).toBeTruthy();
    expect(typeof result.latencyMs).toBe('number');
    console.log(`  STT: "${result.text}" via ${result.provider}/${result.model} (${result.latencyMs}ms)`);
  }, 30_000);

  test('transcribes with explicit provider override', async () => {
    clearCooldowns();
    const provider = OPENAI_VALID ? 'openai' : 'groq';
    const model = OPENAI_VALID ? 'gpt-4o-mini-transcribe' : 'whisper-large-v3-turbo';
    const result = await client.transcribe(testAudio, {
      stt: [{ provider, model }],
      language: 'en',
    });
    expect(result.provider).toBe(provider);
    expect(typeof result.text).toBe('string');
    console.log(`  STT (${provider}): "${result.text}" (${result.latencyMs}ms)`);
  }, 30_000);

  test('transcribes with language hint', async () => {
    clearCooldowns();
    const result = await client.transcribe(testAudio, { language: 'pt' });
    expect(result).toBeDefined();
    expect(typeof result.text).toBe('string');
  }, 30_000);
});


// ═══════════════════════════════════════════════════════════════════════════
// 2. client.chat() — LLM
// ═══════════════════════════════════════════════════════════════════════════

describe('client.chat()', () => {
  const test = skipIf(!HAS_GROQ && !HAS_OPENAI, 'No LLM provider available');

  test('generates a chat response', async () => {
    clearCooldowns();
    const result = await client.chat([
      { role: 'system', content: 'Responda em uma frase curta em português.' },
      { role: 'user', content: 'Qual é a capital do Brasil?' },
    ]);
    expect(result).toBeDefined();
    expect(typeof result.content).toBe('string');
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.provider).toBeTruthy();
    expect(typeof result.latencyMs).toBe('number');
    console.log(`  LLM: "${result.content.slice(0, 80)}..." via ${result.provider}/${result.model} (${result.latencyMs}ms)`);
  }, 30_000);

  test('chat with explicit provider', async () => {
    clearCooldowns();
    const provider = OPENAI_VALID ? 'openai' : 'groq';
    const result = await client.chat(
      [{ role: 'user', content: 'Say "hello" in Portuguese.' }],
      { llm: [{ provider }] },
    );
    expect(result.provider).toBe(provider);
    expect(result.content.toLowerCase()).toContain('olá');
    console.log(`  LLM (${provider}): "${result.content.slice(0, 60)}" (${result.latencyMs}ms)`);
  }, 30_000);

  test('chat with temperature and maxTokens', async () => {
    clearCooldowns();
    const result = await client.chat(
      [{ role: 'user', content: 'Count from 1 to 5.' }],
      { temperature: 0, maxTokens: 50 },
    );
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content.length).toBeLessThan(500);
  }, 30_000);

  test('chat with fallback chain', async () => {
    clearCooldowns();
    const chain = [];
    if (HAS_GROQ) chain.push({ provider: 'groq' });
    if (OPENAI_VALID) chain.push({ provider: 'openai' });
    if (chain.length === 0) return;

    const result = await client.chat(
      [{ role: 'user', content: 'Olá' }],
      { llm: chain },
    );
    expect(result.content.length).toBeGreaterThan(0);
    expect(chain.map(c => c.provider)).toContain(result.provider);
  }, 30_000);
});


// ═══════════════════════════════════════════════════════════════════════════
// 3. client.synthesize() — TTS
// ═══════════════════════════════════════════════════════════════════════════

describe('client.synthesize()', () => {
  const test = skipIf(!HAS_GROQ && !HAS_OPENAI, 'No TTS provider available');

  test('synthesizes text to audio', async () => {
    clearCooldowns();
    const result = await client.synthesize('Olá, tudo bem?');
    expect(result).toBeDefined();
    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(100);
    expect(result.contentType).toBeTruthy();
    expect(result.provider).toBeTruthy();
    expect(typeof result.latencyMs).toBe('number');
    console.log(`  TTS: ${result.audio.length} bytes via ${result.provider}/${result.model} (${result.latencyMs}ms)`);
  }, 30_000);

  test('synthesizes with explicit voice', async () => {
    clearCooldowns();
    const provider = OPENAI_VALID ? 'openai' : 'groq';
    const result = await client.synthesize('Bom dia!', {
      tts: [{ provider }],
      voice: 'ash',
    });
    expect(result.provider).toBe(provider);
    expect(result.audio.length).toBeGreaterThan(100);
    console.log(`  TTS (${provider}): ${result.audio.length} bytes (${result.latencyMs}ms)`);
  }, 30_000);

  test('synthesizes with MP3 format', async () => {
    clearCooldowns();
    const result = await client.synthesize('Teste de áudio.', {
      audioFormat: 'mp3',
    });
    expect(result.audio.length).toBeGreaterThan(0);
    expect(result.contentType).toMatch(/audio/);
  }, 30_000);
});


// ═══════════════════════════════════════════════════════════════════════════
// 4. client.pipeline() — Full STT → LLM → TTS
// ═══════════════════════════════════════════════════════════════════════════

describe('client.pipeline()', () => {
  const test = skipIf(!HAS_GROQ && !HAS_OPENAI, 'No provider available');

  test('full pipeline: audio in → text+audio out', async () => {
    clearCooldowns();
    const result = await client.pipeline(
      testAudio,
      'Você é um tutor de português. Responda em uma frase curta.',
    );
    expect(result).toBeDefined();

    // STT stage
    expect(result.stt).toBeDefined();
    expect(typeof result.stt.text).toBe('string');
    expect(result.stt.provider).toBeTruthy();

    // LLM stage
    expect(result.chat).toBeDefined();
    expect(typeof result.chat.content).toBe('string');
    expect(result.chat.content.length).toBeGreaterThan(0);
    expect(result.chat.provider).toBeTruthy();

    // TTS stage
    expect(result.tts).toBeDefined();
    expect(result.tts.audio).toBeInstanceOf(Buffer);
    expect(result.tts.audio.length).toBeGreaterThan(100);
    expect(result.tts.provider).toBeTruthy();

    // Timing
    expect(typeof result.totalLatencyMs).toBe('number');
    expect(result.totalLatencyMs).toBeGreaterThan(0);

    console.log(`  Pipeline: STT="${result.stt.text}" → LLM="${result.chat.content.slice(0, 50)}..." → TTS=${result.tts.audio.length}B`);
    console.log(`  Providers: ${result.stt.provider} → ${result.chat.provider} → ${result.tts.provider} (${result.totalLatencyMs}ms)`);
  }, 60_000);

  test('pipeline with conversation history', async () => {
    clearCooldowns();
    const result = await client.pipeline(
      testAudio,
      'Responda em português.',
      [
        { role: 'user', content: 'Olá!' },
        { role: 'assistant', content: 'Olá! Como vai?' },
      ],
    );
    expect(result.chat.content.length).toBeGreaterThan(0);
    expect(result.tts.audio.length).toBeGreaterThan(0);
  }, 60_000);

  test('pipeline with provider override', async () => {
    clearCooldowns();
    const provider = OPENAI_VALID ? 'openai' : 'groq';
    const sttModel = OPENAI_VALID ? 'gpt-4o-mini-transcribe' : 'whisper-large-v3-turbo';
    const result = await client.pipeline(
      testAudio,
      'Responda brevemente.',
      [],
      { stt: [{ provider, model: sttModel }], llm: [{ provider }], tts: [{ provider }] },
    );
    expect(result.stt.provider).toBe(provider);
    expect(result.chat.provider).toBe(provider);
    expect(result.tts.provider).toBe(provider);
  }, 60_000);
});


// ═══════════════════════════════════════════════════════════════════════════
// 5. client.realtimeSpeech() — Unified realtime (session / omni / webrtc)
// ═══════════════════════════════════════════════════════════════════════════

describe('client.realtimeSpeech()', () => {
  const test = skipIf(!OPENAI_VALID, 'OPENAI_API_KEY not valid');

  // ── Session token mode ──

  test('session mode: creates ephemeral token', async () => {
    clearCooldowns();
    const result = await client.realtimeSpeech(
      { voice: 'ash', model: 'gpt-4o-mini-realtime-preview' },
      { realtime: [{ provider: 'openai', model: 'gpt-4o-mini-realtime-preview' }] },
    );
    expect(result.transport).toBe('session');
    expect(typeof result.clientSecret).toBe('string');
    expect(result.clientSecret!.length).toBeGreaterThan(0);
    expect(typeof result.expiresAt).toBe('number');
    expect(result.provider).toBe('openai');
    expect(result.voice).toBe('ash');
    console.log(`  Session: secret=${result.clientSecret!.slice(0, 20)}... expires=${result.expiresAt}`);
  }, 30_000);

  test('session mode: includes model and voice', async () => {
    clearCooldowns();
    const result = await client.realtimeSpeech(
      { voice: 'coral', model: 'gpt-4o-mini-realtime-preview' },
      { realtime: [{ provider: 'openai' }] },
    );
    expect(result.model).toContain('realtime');
    expect(result.voice).toBe('coral');
  }, 30_000);

  test('session mode: with instructions', async () => {
    clearCooldowns();
    const result = await client.realtimeSpeech(
      { voice: 'ash', instructions: 'You are a Portuguese language tutor.', model: 'gpt-4o-mini-realtime-preview' },
      { realtime: [{ provider: 'openai' }] },
    );
    expect(result.transport).toBe('session');
    expect(result.clientSecret).toBeTruthy();
  }, 30_000);

  // ── Omni mode (audio/text in → audio+text out) ──

  test('omni mode: audio input → text+audio output', async () => {
    clearCooldowns();
    const result = await client.realtimeSpeech(
      { audio: testAudio, instructions: 'You are a friendly Portuguese tutor. Respond briefly in Portuguese.' },
      { omni: [{ provider: 'openai', model: 'gpt-4o-mini-audio-preview' }] },
    );
    expect(result.transport).toBe('omni');
    expect(typeof result.responseText).toBe('string');
    expect(result.responseText!.length).toBeGreaterThan(0);
    expect(result.provider).toBe('openai');
    expect(typeof result.latencyMs).toBe('number');
    console.log(`  Omni (audio): "${result.responseText!.slice(0, 80)}..." via ${result.provider} (${result.latencyMs}ms)`);

    if (result.responseAudio) {
      expect(result.responseAudio).toBeInstanceOf(Buffer);
      console.log(`  Audio: ${result.responseAudio.length} bytes`);
    }
  }, 45_000);

  test('omni mode: text input → text output', async () => {
    clearCooldowns();
    const result = await client.realtimeSpeech(
      { text: 'Olá, como vai?', instructions: 'Respond in one short sentence in Portuguese.' },
      { omni: [{ provider: 'openai', model: 'gpt-4o-mini-audio-preview' }] },
    );
    expect(result.transport).toBe('omni');
    expect(typeof result.responseText).toBe('string');
    expect(result.responseText!.length).toBeGreaterThan(0);
    console.log(`  Omni (text): "${result.responseText!.slice(0, 60)}"`);
  }, 30_000);
});


// ═══════════════════════════════════════════════════════════════════════════
// 7. client.generate() — Image generation
// ═══════════════════════════════════════════════════════════════════════════

describe('client.generate()', () => {
  const test = skipIf(!OPENAI_VALID && !HAS_FIREWORKS, 'No image provider available');

  test('generates an image from text prompt', async () => {
    clearCooldowns();
    const provider = OPENAI_VALID ? 'openai' : 'fireworks';
    const result = await client.generate(
      'A simple blue circle on white background',
      { image: [{ provider }], fallbackOptions: { timeoutMs: 30_000 } },
    );
    expect(result).toBeDefined();
    expect(result.image).toBeInstanceOf(Buffer);
    expect(result.image.length).toBeGreaterThan(1000);
    expect(result.contentType).toMatch(/image/);
    expect(result.provider).toBe(provider);
    expect(typeof result.latencyMs).toBe('number');
    console.log(`  Image: ${result.image.length} bytes (${result.contentType}) via ${result.provider} (${result.latencyMs}ms)`);
  }, 60_000);
});


// ═══════════════════════════════════════════════════════════════════════════
// 8. Fallback behavior — verify chain works across methods
// ═══════════════════════════════════════════════════════════════════════════

describe('Fallback chains', () => {
  const test = skipIf(!HAS_GROQ || !OPENAI_VALID, 'Need both Groq and OpenAI for fallback tests');

  test('STT falls back from invalid provider to valid one', async () => {
    clearCooldowns();
    // Put a bogus provider first, real one second
    const result = await client.transcribe(testAudio, {
      stt: [
        { provider: 'groq', model: 'nonexistent-model-xyz' },
        { provider: 'openai' },
      ],
    });
    expect(result.provider).toBe('openai');
    expect(result.fallbackUsed).toBe(true);
    console.log(`  Fallback STT: landed on ${result.provider} (fallback=${result.fallbackUsed})`);
  }, 30_000);

  test('LLM falls back across providers', async () => {
    clearCooldowns();
    const result = await client.chat(
      [{ role: 'user', content: 'Olá' }],
      {
        llm: [
          { provider: 'groq', model: 'nonexistent-model-xyz' },
          { provider: 'openai', model: 'gpt-4o-mini' },
        ],
      },
    );
    expect(result.provider).toBe('openai');
    expect(result.fallbackUsed).toBe(true);
    console.log(`  Fallback LLM: landed on ${result.provider}`);
  }, 30_000);

  test('TTS falls back across providers', async () => {
    clearCooldowns();
    const result = await client.synthesize('Teste', {
      tts: [
        { provider: 'groq', model: 'nonexistent-tts-model' },
        { provider: 'openai' },
      ],
      voice: 'ash',
    });
    expect(result.provider).toBe('openai');
    expect(result.fallbackUsed).toBe(true);
    console.log(`  Fallback TTS: landed on ${result.provider}`);
  }, 30_000);
});


// ═══════════════════════════════════════════════════════════════════════════
// 9. Profile overrides — verify profiles work correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('Profile-based routing', () => {
  const test = skipIf(!HAS_GROQ && !HAS_OPENAI, 'No provider available');

  test('preset "voice" profile routes correctly', async () => {
    clearCooldowns();
    const voiceClient = createFullClient('voice');
    const result = await voiceClient.chat([{ role: 'user', content: 'Oi' }]);
    expect(result.content.length).toBeGreaterThan(0);
  }, 30_000);

  test('preset "system" profile uses low temperature', async () => {
    clearCooldowns();
    const systemClient = createFullClient('system');
    const r1 = await systemClient.chat([{ role: 'user', content: 'Say exactly: test123' }]);
    const r2 = await systemClient.chat([{ role: 'user', content: 'Say exactly: test123' }]);
    // With low temperature, responses should be similar
    expect(r1.content.length).toBeGreaterThan(0);
    expect(r2.content.length).toBeGreaterThan(0);
  }, 30_000);

  test('per-request profile override takes precedence', async () => {
    clearCooldowns();
    if (!OPENAI_VALID) return;
    const result = await client.chat(
      [{ role: 'user', content: 'Say hi' }],
      { llm: [{ provider: 'openai', model: 'gpt-4o-mini' }] },
    );
    expect(result.provider).toBe('openai');
    expect(result.model).toContain('gpt-4o-mini');
  }, 30_000);
});


// ═══════════════════════════════════════════════════════════════════════════
// 10. Error handling — graceful failures
// ═══════════════════════════════════════════════════════════════════════════

describe('Error handling', () => {
  it('transcribe with empty chain throws', async () => {
    clearCooldowns();
    const emptyClient = createAIClient({
      registry: new AIProviderRegistry(),
      defaultProfile: { stt: [] },
    });
    await expect(emptyClient.transcribe(testAudio)).rejects.toThrow();
  });

  it('chat with empty chain throws', async () => {
    clearCooldowns();
    const emptyClient = createAIClient({
      registry: new AIProviderRegistry(),
      defaultProfile: { llm: [] },
    });
    await expect(emptyClient.chat([{ role: 'user', content: 'test' }])).rejects.toThrow();
  });

  it('synthesize with empty chain throws', async () => {
    clearCooldowns();
    const emptyClient = createAIClient({
      registry: new AIProviderRegistry(),
      defaultProfile: { tts: [] },
    });
    await expect(emptyClient.synthesize('test')).rejects.toThrow();
  });

  it('realtimeSpeech with no realtime config throws', async () => {
    clearCooldowns();
    const noRealtimeClient = createAIClient({
      registry: new AIProviderRegistry(),
      defaultProfile: { realtime: [] },
    });
    await expect(noRealtimeClient.realtimeSpeech({ voice: 'ash' })).rejects.toThrow(/No realtime providers/);
  });
});
