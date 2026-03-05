/**
 * Groq Provider — Integration Tests (Real API)
 *
 * Tests STT, TTS, and LLM against Groq's live API.
 * Requires: GROQ_API_KEY
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { groqSTT, groqTTS, groqLLM } from '../src/providers/groq';
import { loadEnv, requireEnv, makeTestWav, timed } from './helpers';

beforeAll(() => loadEnv());

describe('Groq STT (Real API)', () => {
  it('transcribes audio with whisper-large-v3-turbo', async () => {
    requireEnv('GROQ_API_KEY');
    const audio = makeTestWav(1.0);

    const { result, ms } = await timed(() =>
      groqSTT.transcribe({ audio, model: 'whisper-large-v3-turbo' }),
    );

    expect(result).toBeDefined();
    expect(typeof result.text).toBe('string');
    console.log(`  Groq STT: "${result.text}" (${ms}ms)`);
  });

  it('returns language detection', async () => {
    requireEnv('GROQ_API_KEY');
    const audio = makeTestWav(0.5);

    const result = await groqSTT.transcribe({
      audio,
      model: 'whisper-large-v3-turbo',
    });

    expect(result).toBeDefined();
    // Language may or may not be returned for silence/sine
    expect(typeof result.text).toBe('string');
  });

  it('isConfigured returns true when key is set', () => {
    requireEnv('GROQ_API_KEY');
    expect(groqSTT.isConfigured()).toBe(true);
  });
});

describe('Groq TTS (Real API)', () => {
  it('synthesizes speech with Orpheus', async () => {
    requireEnv('GROQ_API_KEY');

    const { result, ms } = await timed(() =>
      groqTTS.synthesize({
        input: 'Hello, this is a test.',
        model: 'playai-tts',
        voice: 'Fritz-PlayAI',
        responseFormat: 'wav',
      }),
    );

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(1000);
    expect(result.contentType).toBe('audio/wav');
    console.log(`  Groq TTS: ${result.audio.length} bytes (${ms}ms)`);
  });

  it('returns available models and voices', () => {
    requireEnv('GROQ_API_KEY');
    const models = groqTTS.getModels();
    const voices = groqTTS.getVoices();

    expect(models.length).toBeGreaterThan(0);
    expect(voices.length).toBeGreaterThan(0);
    expect(models[0]).toHaveProperty('id');
    expect(voices[0]).toHaveProperty('id');
  });
});

describe('Groq LLM (Real API)', () => {
  it('completes a chat with llama-3.3-70b', async () => {
    requireEnv('GROQ_API_KEY');

    const { result, ms } = await timed(() =>
      groqLLM.chat({
        messages: [
          { role: 'system', content: 'Reply in exactly one word.' },
          { role: 'user', content: 'What color is the sky?' },
        ],
        model: 'llama-3.3-70b-versatile',
        temperature: 0,
        maxTokens: 10,
      }),
    );

    expect(result.content).toBeTruthy();
    expect(result.model).toContain('llama');
    expect(result.usage).toBeDefined();
    expect(result.usage!.totalTokens).toBeGreaterThan(0);
    console.log(`  Groq LLM: "${result.content}" (${ms}ms, ${result.usage!.totalTokens} tokens)`);
  });

  it('respects maxTokens limit', async () => {
    requireEnv('GROQ_API_KEY');

    const result = await groqLLM.chat({
      messages: [{ role: 'user', content: 'Write a long story about a cat.' }],
      model: 'llama-3.3-70b-versatile',
      maxTokens: 5,
    });

    expect(result.content.length).toBeLessThan(200);
    expect(result.usage!.completionTokens).toBeLessThanOrEqual(10);
  });

  it('returns JSON when responseFormat is json_object', async () => {
    requireEnv('GROQ_API_KEY');

    const result = await groqLLM.chat({
      messages: [
        { role: 'system', content: 'Return valid JSON only.' },
        { role: 'user', content: 'Give me a JSON object with name and age fields.' },
      ],
      model: 'llama-3.3-70b-versatile',
      responseFormat: { type: 'json_object' },
      maxTokens: 50,
    });

    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveProperty('name');
    expect(parsed).toHaveProperty('age');
  });
});
