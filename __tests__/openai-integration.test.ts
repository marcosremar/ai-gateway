/**
 * OpenAI Provider — Integration Tests (Real API)
 *
 * Tests STT, TTS, LLM, Realtime session creation, and Image generation.
 * Requires: OPENAI_API_KEY
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { OpenAISTTProvider } from '../src/providers/openai/openai-stt';
import { OpenAITTSProvider } from '../src/providers/openai/openai-tts';
import { OpenAIRealtimeProvider } from '../src/providers/openai/openai-realtime';
import { OpenAIOmniProvider } from '../src/providers/openai/openai-omni';
import { OpenAIImageProvider } from '../src/providers/openai/openai-image';
import { OpenAICompatLLMProvider } from '../src/providers/openai-compat/openai-compat-llm';
import type { TTSResponse, LLMResponse } from '../src/providers/types';
import { loadEnv, checkOpenAIAvailable, makeTestWav, timed } from './helpers';

function skipOn(err: unknown): boolean {
  const s = (err as Record<string, unknown>)?.status;
  return s === 401 || s === 402 || s === 403 || s === 429;
}

// Top-level await: load env and verify OpenAI is actually usable (not rate-limited)
await loadEnv();
const OPENAI_AVAILABLE = process.env.OPENAI_API_KEY
  ? await checkOpenAIAvailable(process.env.OPENAI_API_KEY)
  : false;
if (!OPENAI_AVAILABLE && process.env.OPENAI_API_KEY) {
  console.log('[openai-integration] OpenAI unavailable (rate-limited or invalid key) — all tests will be skipped');
}

const openaiLLM = new OpenAICompatLLMProvider({
  providerId: 'openai',
  baseURL: 'https://api.openai.com/v1',
  envKey: 'OPENAI_API_KEY',
  defaultModel: 'gpt-4o-mini',
});

// ── STT ── shared audio, 2 calls (different models) ─────────────────────────

describe.skipIf(!OPENAI_AVAILABLE)('OpenAI STT (Real API)', () => {
  const stt = new OpenAISTTProvider();
  const audio = makeTestWav(0.5); // shared — 0.5s is the minimum viable audio

  it('whisper-1 returns text string', async () => {
    try {
      const { result, ms } = await timed(() =>
        stt.transcribe({ audio, model: 'whisper-1' }),
      );
      expect(typeof result.text).toBe('string');
      console.log(`  OpenAI STT (whisper-1): "${result.text}" (${ms}ms)`);
    } catch (err: unknown) { if (!skipOn(err)) throw err; }
  });

  it('gpt-4o-transcribe returns text string', async () => {
    try {
      const { result, ms } = await timed(() =>
        stt.transcribe({ audio, model: 'gpt-4o-transcribe' }),
      );
      expect(typeof result.text).toBe('string');
      console.log(`  OpenAI STT (gpt-4o-transcribe): "${result.text}" (${ms}ms)`);
    } catch (err: unknown) { if (!skipOn(err)) throw err; }
  });

  it('withApiKey returns a new isolated instance', () => {
    const custom = stt.withApiKey(process.env.OPENAI_API_KEY!);
    expect(custom).toBeInstanceOf(OpenAISTTProvider);
    expect(custom).not.toBe(stt);
  });
});

// ── TTS ── 1 synthesize call shared, 1 stream call ──────────────────────────

describe.skipIf(!OPENAI_AVAILABLE)('OpenAI TTS (Real API)', () => {
  const tts = new OpenAITTSProvider();
  let synth: TTSResponse | null = null;
  let ms = 0;

  // ONE synthesize call covers: buffer, contentType, instructions feature
  beforeAll(async () => {
    try {
      ({ result: synth, ms } = await timed(() =>
        tts.synthesize({
          input: 'Hi.',           // shortest valid input
          model: 'gpt-4o-mini-tts',
          voice: 'coral',
          responseFormat: 'mp3',
          instructions: 'Speak normally.',
        }),
      ));
    } catch (err: unknown) { if (!skipOn(err)) throw err; }
  });

  it('returns audio buffer', () => {
    if (!synth) return;
    expect(synth.audio).toBeInstanceOf(Buffer);
    expect(synth.audio.length).toBeGreaterThan(100);
    console.log(`  OpenAI TTS: ${synth.audio.length} bytes (${ms}ms)`);
  });

  it('returns correct contentType for mp3', () => {
    if (!synth) return;
    expect(synth.contentType).toBe('audio/mpeg');
  });

  it('synthesizeStream returns a ReadableStream with data', async () => {
    // Stream test is separate — different API path
    try {
      const stream = await tts.synthesizeStream({
        input: 'Hi.',
        model: 'gpt-4o-mini-tts',
        voice: 'coral',
      });
      expect(stream).toBeDefined();
      const reader = stream.getReader();
      const { value } = await reader.read();
      expect(value).toBeInstanceOf(Uint8Array);
      reader.releaseLock();
    } catch (err: unknown) { if (!skipOn(err)) throw err; }
  });

  it('getModels and getVoices return non-empty arrays', () => {
    // Static — no API call
    expect(tts.getModels().length).toBeGreaterThan(0);
    expect(tts.getVoices().length).toBeGreaterThan(0);
  });
});

// ── LLM ── 1 call covers: content, model, usage, JSON format ────────────────

describe.skipIf(!OPENAI_AVAILABLE)('OpenAI LLM (Real API)', () => {
  let llm: LLMResponse | null = null;
  let ms = 0;

  // Single JSON-mode call: verifies completion + usage + structured output
  beforeAll(async () => {
    try {
      ({ result: llm, ms } = await timed(() =>
        openaiLLM.chat({
          messages: [
            { role: 'system', content: 'Return valid JSON only.' },
            { role: 'user', content: 'Return {"status":"ok"}' },
          ],
          model: 'gpt-4o-mini',
          responseFormat: { type: 'json_object' },
          temperature: 0,
          maxTokens: 20,
        }),
      ));
    } catch (err: unknown) { if (!skipOn(err)) throw err; }
  });

  it('returns non-empty content', () => {
    if (!llm) return;
    expect(llm.content).toBeTruthy();
    console.log(`  OpenAI LLM: "${llm.content}" (${ms}ms)`);
  });

  it('returns usage stats', () => {
    if (!llm) return;
    expect(llm.usage).toBeDefined();
    expect(llm.usage!.totalTokens).toBeGreaterThan(0);
  });

  it('returns valid JSON when responseFormat is json_object', () => {
    if (!llm) return;
    const parsed = JSON.parse(llm.content);
    expect(parsed.status).toBe('ok');
  });
});

// ── Realtime ── 1 session call covers all config assertions ─────────────────

describe.skipIf(!OPENAI_AVAILABLE)('OpenAI Realtime (Real API)', () => {
  const realtime = new OpenAIRealtimeProvider();
  type Session = Awaited<ReturnType<typeof realtime.createSession>>;
  let session: Session | null = null;
  let ms = 0;

  // ONE session creation — noise reduction + model config both verified from it
  beforeAll(async () => {
    try {
      ({ result: session, ms } = await timed(() =>
        realtime.createSession({
          model: 'gpt-4o-mini-realtime-preview',
          voice: 'coral',
          noiseReduction: { type: 'near_field' },
        }),
      ));
    } catch (err: unknown) { if (!skipOn(err)) throw err; }
  });

  it('returns an ephemeral client secret', () => {
    if (!session) return;
    expect(session.clientSecret).toBeTruthy();
    expect(typeof session.clientSecret).toBe('string');
    console.log(`  OpenAI Realtime: secret=${session.clientSecret.slice(0, 20)}... (${ms}ms)`);
  });

  it('session expires in the future', () => {
    if (!session) return;
    expect(session.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('session config reflects requested model', () => {
    if (!session) return;
    expect(session.config.model).toBe('gpt-4o-mini-realtime-preview');
  });
});

describe.skipIf(!OPENAI_AVAILABLE)('OpenAI Omni (Real API)', () => {
  const omni = new OpenAIOmniProvider();

  it('generates text+audio from text input', async () => {


    const { result, ms } = await timed(() =>
      omni.omniChat({
        text: 'Say hello in Portuguese.',
        model: 'gpt-4o-mini-audio-preview',
        voice: 'coral',
        audioFormat: 'wav',
      }),
    );

    expect(result.text).toBeTruthy();
    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(100);
    expect(result.audioBase64).toBeTruthy();
    expect(result.contentType).toBe('audio/wav');
    console.log(`  OpenAI Omni: "${result.text.slice(0, 60)}..." audio=${result.audio.length} bytes (${ms}ms)`);
  });
});

describe.skipIf(!OPENAI_AVAILABLE)('OpenAI Image (Real API)', () => {
  const image = new OpenAIImageProvider();

  it('generates an image with dall-e-2', async () => {


    const { result, ms } = await timed(() =>
      image.generate({
        prompt: 'A simple red circle on a white background',
        model: 'dall-e-2',
        width: 256,
        height: 256,
      }),
    );

    expect(result.image).toBeInstanceOf(Buffer);
    expect(result.image.length).toBeGreaterThan(1000);
    expect(result.contentType).toBe('image/png');
    console.log(`  OpenAI Image (dall-e-2): ${result.image.length} bytes (${ms}ms)`);
  });
});
