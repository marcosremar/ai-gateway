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
import { loadEnv, requireEnv, makeTestWav, timed } from './helpers';

beforeAll(() => loadEnv());

const openaiLLM = new OpenAICompatLLMProvider({
  providerId: 'openai',
  baseURL: 'https://api.openai.com/v1',
  envKey: 'OPENAI_API_KEY',
  defaultModel: 'gpt-4o-mini',
});

describe('OpenAI STT (Real API)', () => {
  const stt = new OpenAISTTProvider();

  it('transcribes with whisper-1', async () => {
    requireEnv('OPENAI_API_KEY');
    const audio = makeTestWav(1.0);

    const { result, ms } = await timed(() =>
      stt.transcribe({ audio, model: 'whisper-1' }),
    );

    expect(result).toBeDefined();
    expect(typeof result.text).toBe('string');
    console.log(`  OpenAI STT (whisper-1): "${result.text}" (${ms}ms)`);
  });

  it('transcribes with gpt-4o-transcribe', async () => {
    requireEnv('OPENAI_API_KEY');
    const audio = makeTestWav(1.0);

    const { result, ms } = await timed(() =>
      stt.transcribe({ audio, model: 'gpt-4o-transcribe' }),
    );

    expect(typeof result.text).toBe('string');
    console.log(`  OpenAI STT (gpt-4o-transcribe): "${result.text}" (${ms}ms)`);
  });

  it('withApiKey creates a new isolated instance', () => {
    requireEnv('OPENAI_API_KEY');
    const custom = stt.withApiKey(process.env.OPENAI_API_KEY!);
    expect(custom).toBeInstanceOf(OpenAISTTProvider);
    expect(custom).not.toBe(stt);
  });
});

describe('OpenAI TTS (Real API)', () => {
  const tts = new OpenAITTSProvider();

  it('synthesizes speech with gpt-4o-mini-tts', async () => {
    requireEnv('OPENAI_API_KEY');

    const { result, ms } = await timed(() =>
      tts.synthesize({
        input: 'Hello from the AI gateway integration test.',
        model: 'gpt-4o-mini-tts',
        voice: 'coral',
        responseFormat: 'mp3',
      }),
    );

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(1000);
    expect(result.contentType).toBe('audio/mpeg');
    console.log(`  OpenAI TTS: ${result.audio.length} bytes (${ms}ms)`);
  });

  it('synthesizes with instructions', async () => {
    requireEnv('OPENAI_API_KEY');

    const result = await tts.synthesize({
      input: 'Good morning!',
      model: 'gpt-4o-mini-tts',
      voice: 'sage',
      instructions: 'Speak slowly and calmly.',
    });

    expect(result.audio.length).toBeGreaterThan(500);
  });

  it('synthesizeStream returns a ReadableStream', async () => {
    requireEnv('OPENAI_API_KEY');

    const stream = await tts.synthesizeStream({
      input: 'Test stream.',
      model: 'gpt-4o-mini-tts',
      voice: 'coral',
    });

    expect(stream).toBeDefined();
    // Read first chunk
    const reader = stream.getReader();
    const { value, done } = await reader.read();
    expect(value).toBeInstanceOf(Uint8Array);
    reader.releaseLock();
  });

  it('lists models and voices', () => {
    const models = tts.getModels();
    const voices = tts.getVoices();
    expect(models.length).toBeGreaterThan(0);
    expect(voices.length).toBeGreaterThan(0);
  });
});

describe('OpenAI LLM (Real API)', () => {
  it('completes chat with gpt-4o-mini', async () => {
    requireEnv('OPENAI_API_KEY');

    const { result, ms } = await timed(() =>
      openaiLLM.chat({
        messages: [
          { role: 'system', content: 'Reply in one word only.' },
          { role: 'user', content: 'Capital of France?' },
        ],
        model: 'gpt-4o-mini',
        temperature: 0,
        maxTokens: 5,
      }),
    );

    expect(result.content.toLowerCase()).toContain('paris');
    expect(result.usage).toBeDefined();
    console.log(`  OpenAI LLM: "${result.content}" (${ms}ms)`);
  });

  it('returns JSON format', async () => {
    requireEnv('OPENAI_API_KEY');

    const result = await openaiLLM.chat({
      messages: [
        { role: 'system', content: 'Return valid JSON.' },
        { role: 'user', content: 'Return {"status": "ok"}' },
      ],
      model: 'gpt-4o-mini',
      responseFormat: { type: 'json_object' },
      maxTokens: 20,
    });

    const parsed = JSON.parse(result.content);
    expect(parsed.status).toBe('ok');
  });
});

describe('OpenAI Realtime (Real API)', () => {
  const realtime = new OpenAIRealtimeProvider();

  it('creates an ephemeral session', async () => {
    requireEnv('OPENAI_API_KEY');

    const { result: session, ms } = await timed(() =>
      realtime.createSession({
        model: 'gpt-4o-mini-realtime-preview',
        voice: 'coral',
      }),
    );

    expect(session.clientSecret).toBeTruthy();
    expect(typeof session.clientSecret).toBe('string');
    expect(session.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(session.config.model).toBe('gpt-4o-mini-realtime-preview');
    console.log(`  OpenAI Realtime session: secret=${session.clientSecret.slice(0, 20)}... (${ms}ms)`);
  });

  it('supports noise reduction config', async () => {
    requireEnv('OPENAI_API_KEY');

    const session = await realtime.createSession({
      model: 'gpt-4o-mini-realtime-preview',
      voice: 'sage',
      inputAudioFormat: 'pcm16',
      outputAudioFormat: 'pcm16',
      noiseReduction: { type: 'near_field' },
    });

    expect(session.clientSecret).toBeTruthy();
  });
});

describe('OpenAI Omni (Real API)', () => {
  const omni = new OpenAIOmniProvider();

  it('generates text+audio from text input', async () => {
    requireEnv('OPENAI_API_KEY');

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

describe('OpenAI Image (Real API)', () => {
  const image = new OpenAIImageProvider();

  it('generates an image with dall-e-2', async () => {
    requireEnv('OPENAI_API_KEY');

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
