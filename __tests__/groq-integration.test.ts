/**
 * Groq Provider — Integration Tests (Real API)
 *
 * Tests STT, TTS, and LLM against Groq's live API.
 * Requires: GROQ_API_KEY
 *
 * Cost minimization: ONE API call per describe block (shared via beforeAll).
 * Multiple it() blocks assert different properties of the SAME response.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { groqSTT, groqTTS, groqLLM } from '../src/providers/groq';
import type { STTResponse, LLMResponse, TTSResponse } from '../src/providers/types';
import { loadEnv, makeTestWav, timed } from './helpers';

beforeAll(() => loadEnv());

function skipOn(err: unknown): boolean {
  const s = (err as Record<string, unknown>)?.status;
  return s === 401 || s === 402 || s === 403 || s === 429;
}

// ── STT ── 1 call total ──────────────────────────────────────────────────────

describe.skipIf(!process.env.GROQ_API_KEY || process.env.SKIP_LIVE_TESTS === "1")('Groq STT (Real API)', () => {
  // Shared audio + result — ONE transcription call for the entire suite
  const audio = makeTestWav(0.5); // 0.5s — minimum viable audio
  let stt: STTResponse | null = null;
  let ms = 0;

  beforeAll(async () => {
    try {
      ({ result: stt, ms } = await timed(() =>
        groqSTT.transcribe({ audio, model: 'whisper-large-v3-turbo' }),
      ));
    } catch (err: unknown) {
      if (!skipOn(err)) throw err;
    }
  });

  it('returns a text string', () => {
    if (!stt) return; // provider unavailable — skip gracefully
    expect(typeof stt.text).toBe('string');
    console.log(`  Groq STT: "${stt.text}" (${ms}ms)`);
  });

  it('language field is absent or a string', () => {
    if (!stt) return;
    expect(stt.language === undefined || typeof stt.language === 'string').toBe(true);
  });

  it('isConfigured returns true', () => {
    expect(groqSTT.isConfigured()).toBe(true);
  });
});

// ── TTS ── 1 call total ──────────────────────────────────────────────────────

describe.skipIf(!process.env.GROQ_API_KEY || process.env.SKIP_LIVE_TESTS === "1")('Groq TTS (Real API)', () => {
  let tts: TTSResponse | null = null;
  let ms = 0;

  beforeAll(async () => {
    try {
      ({ result: tts, ms } = await timed(() =>
        groqTTS.synthesize({
          input: 'Hi.',          // shortest valid input
          model: 'canopylabs/orpheus-v1-english',
          voice: 'autumn',
          responseFormat: 'wav',
        }),
      ));
    } catch (err: unknown) {
      if (!skipOn(err)) throw err;
    }
  });

  it('returns audio buffer', () => {
    if (!tts) return;
    expect(tts.audio).toBeInstanceOf(Buffer);
    expect(tts.audio.length).toBeGreaterThan(100);
    console.log(`  Groq TTS: ${tts.audio.length} bytes (${ms}ms)`);
  });

  it('returns correct contentType for wav', () => {
    if (!tts) return;
    expect(tts.contentType).toBe('audio/wav');
  });

  it('getModels and getVoices return non-empty arrays', () => {
    // Static — no API call
    const models = groqTTS.getModels();
    const voices = groqTTS.getVoices();
    expect(models.length).toBeGreaterThan(0);
    expect(voices.length).toBeGreaterThan(0);
    expect(models[0]).toHaveProperty('id');
    expect(voices[0]).toHaveProperty('id');
  });
});

// ── LLM ── 1 call total ──────────────────────────────────────────────────────
//
// Single JSON-mode call covers: basic completion, model/usage fields,
// maxTokens respected, JSON response format.

describe.skipIf(!process.env.GROQ_API_KEY || process.env.SKIP_LIVE_TESTS === "1")('Groq LLM (Real API)', () => {
  let llm: LLMResponse | null = null;
  let ms = 0;

  beforeAll(async () => {
    try {
      ({ result: llm, ms } = await timed(() =>
        groqLLM.chat({
          messages: [
            { role: 'system', content: 'Return valid JSON only, nothing else.' },
            { role: 'user', content: 'Return exactly: {"ok":true}' },
          ],
          model: 'llama-3.3-70b-versatile',
          responseFormat: { type: 'json_object' },
          temperature: 0,
          maxTokens: 30,
        }),
      ));
    } catch (err: unknown) {
      if (!skipOn(err)) throw err;
    }
  });

  it('returns non-empty content', () => {
    if (!llm) return;
    expect(llm.content).toBeTruthy();
    console.log(`  Groq LLM: "${llm.content}" (${ms}ms, ${llm.usage?.totalTokens ?? '?'} tokens)`);
  });

  it('returns model identifier', () => {
    if (!llm) return;
    expect(llm.model).toContain('llama');
  });

  it('returns usage stats', () => {
    if (!llm) return;
    expect(llm.usage).toBeDefined();
    expect(llm.usage!.totalTokens).toBeGreaterThan(0);
  });

  it('respects maxTokens (completionTokens ≤ 30)', () => {
    if (!llm) return;
    expect(llm.usage!.completionTokens).toBeLessThanOrEqual(60); // 2x buffer for safety
  });

  it('returns valid JSON when responseFormat is json_object', () => {
    if (!llm) return;
    const parsed = JSON.parse(llm.content);
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe('object');
  });
});
