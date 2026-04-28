/**
 * Word Timestamps — Direct Provider Integration Tests (Real API)
 *
 * Tests word-level timestamps from each STT provider directly (no gateway).
 * Skips providers whose API keys are not set.
 * Uses real speech audio generated at test time via macOS `say`.
 *
 * Cost per run: < $0.001 total
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loadEnv, checkOpenAIAvailable, timed } from './helpers';
import { groqSTT } from '../src/providers/groq';
import { openaiSTT } from '../src/providers/openai';
import { OpenAISTTProvider } from '../src/providers/openai/openai-stt';
import { deepgramSTT } from '../src/providers/deepgram';
import { fireworksSTT } from '../src/providers/fireworks';
import type { STTResponse } from '../src/providers/types';
import { execSync } from 'child_process';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { makeTestWav } from './helpers';

await loadEnv();
const OPENAI_AVAILABLE = process.env.OPENAI_API_KEY
  ? await checkOpenAIAvailable(process.env.OPENAI_API_KEY)
  : false;

/** Generate real speech WAV via macOS say + ffmpeg for reliable STT testing. */
function makeSpeechWav(): Buffer {
  const aiff = '/tmp/word_ts_test.aiff';
  const wav = '/tmp/word_ts_test.wav';
  try {
    execSync(`say -o ${aiff} "Hello world, this is a test of speech recognition"`, { timeout: 10_000 });
    execSync(`ffmpeg -y -i ${aiff} -ar 16000 -ac 1 -sample_fmt s16 ${wav} 2>/dev/null`, { timeout: 10_000 });
    return Buffer.from(readFileSync(wav));
  } catch {
    // Fallback: sine wave (may not produce words on all providers)
    console.warn('  [warn] say/ffmpeg not available, falling back to sine wave');
    return makeTestWav(1.5);
  } finally {
    try { if (existsSync(aiff)) unlinkSync(aiff); } catch {}
    try { if (existsSync(wav)) unlinkSync(wav); } catch {}
  }
}

const audio = makeSpeechWav();

function assertWordTimestamps(response: STTResponse): void {
  expect(response.words).toBeDefined();
  expect(Array.isArray(response.words)).toBe(true);
  expect(response.words!.length).toBeGreaterThan(0);

  for (const w of response.words!) {
    expect(typeof w.word).toBe('string');
    expect(w.word.trim().length).toBeGreaterThan(0);
    expect(w.start).toBeGreaterThanOrEqual(0);
    expect(w.end).toBeGreaterThanOrEqual(w.start);
  }

  // Monotonic: each word starts at or after the previous
  for (let i = 1; i < response.words!.length; i++) {
    expect(response.words![i].start).toBeGreaterThanOrEqual(response.words![i - 1].start);
  }
}

// ── Groq ──────────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.GROQ_API_KEY || process.env.SKIP_LIVE_TESTS === "1")('Groq word timestamps (Real API)', () => {
  it('returns word timestamps with whisper-large-v3-turbo', async () => {
    try {
      const { result, ms } = await timed(() =>
        groqSTT.transcribe({ audio, model: 'whisper-large-v3-turbo', wordTimestamps: true }),
      );

      assertWordTimestamps(result);
      console.log(`  Groq: ${result.words!.length} words, ${ms}ms`);
      console.log(`  Words: ${result.words!.map(w => `${w.word}[${w.start.toFixed(2)}-${w.end.toFixed(2)}]`).join(' ')}`);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
      throw err;
    }
  });
});

// ── OpenAI ────────────────────────────────────────────────────────────────────

describe.skipIf(!OPENAI_AVAILABLE)('OpenAI word timestamps (Real API)', () => {
  // Use native OpenAISTTProvider which handles whisper-1 vs gpt-4o format differences
  const nativeOpenai = new OpenAISTTProvider();

  it('whisper-1 returns word timestamps', async () => {
    const { result, ms } = await timed(() =>
      nativeOpenai.transcribe({ audio, model: 'whisper-1', wordTimestamps: true }),
    );

    assertWordTimestamps(result);
    console.log(`  OpenAI whisper-1: ${result.words!.length} words, ${ms}ms`);
    console.log(`  Words: ${result.words!.map(w => `${w.word}[${w.start.toFixed(2)}-${w.end.toFixed(2)}]`).join(' ')}`);
  });

  it('gpt-4o-transcribe does NOT return word timestamps', async () => {
    const { result } = await timed(() =>
      nativeOpenai.transcribe({ audio, model: 'gpt-4o-transcribe' }),
    );

    // gpt-4o-transcribe only supports json format — no word-level timestamps possible
    expect(!result.words || result.words.length === 0).toBe(true);
  });
});

// ── Deepgram ──────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.DEEPGRAM_API_KEY || process.env.SKIP_LIVE_TESTS === "1")('Deepgram word timestamps (Real API)', () => {
  it('always returns words (no flag needed)', async () => {
    const { result, ms } = await timed(() =>
      deepgramSTT.transcribe({ audio, model: 'nova-3' }),
    );

    assertWordTimestamps(result);
    console.log(`  Deepgram: ${result.words!.length} words, ${ms}ms`);
    console.log(`  Words: ${result.words!.map(w => `${w.word}[${w.start.toFixed(2)}-${w.end.toFixed(2)}]`).join(' ')}`);
  });
});

// ── Fireworks ─────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.FIREWORKS_API_KEY || process.env.SKIP_LIVE_TESTS === "1")('Fireworks word timestamps (Real API)', () => {
  it('returns word timestamps with whisper-v3', async () => {
    const { result, ms } = await timed(() =>
      fireworksSTT.transcribe({ audio, model: 'whisper-v3', wordTimestamps: true }),
    );

    assertWordTimestamps(result);
    console.log(`  Fireworks: ${result.words!.length} words, ${ms}ms`);
    console.log(`  Words: ${result.words!.map(w => `${w.word}[${w.start.toFixed(2)}-${w.end.toFixed(2)}]`).join(' ')}`);
  }, 30_000);
});
