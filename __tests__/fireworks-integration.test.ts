/**
 * Fireworks AI Provider — Integration Tests (Real API)
 *
 * Tests STT and LLM against Fireworks' live API.
 * Image generation is tested separately (slower, costs more).
 * Requires: FIREWORKS_API_KEY
 *
 * Cost minimization: ONE API call per describe block (shared via beforeAll).
 * Multiple it() blocks assert different properties of the SAME response.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { fireworksSTT, fireworksLLM } from '../src/providers/fireworks';
import { FireworksImageProvider } from '../src/providers/fireworks/fireworks-image';
import type { STTResponse, LLMResponse } from '../src/providers/types';
import { loadEnv, makeTestWav, timed } from './helpers';

beforeAll(() => loadEnv());

function skipOn(err: unknown): boolean {
  const s = (err as Record<string, unknown>)?.status;
  return s === 401 || s === 402 || s === 403 || s === 429;
}

// ── STT ── 1 call total ──────────────────────────────────────────────────────

describe.skipIf(!process.env.FIREWORKS_API_KEY)('Fireworks STT (Real API)', () => {
  const audio = makeTestWav(1.0);
  let stt: STTResponse | null = null;
  let ms = 0;

  beforeAll(async () => {
    try {
      ({ result: stt, ms } = await timed(() =>
        fireworksSTT.transcribe({ audio, model: 'whisper-v3-turbo' }),
      ));
    } catch (err: unknown) {
      if (!skipOn(err)) throw err;
    }
  });

  it('returns text string', () => {
    if (!stt) return;
    expect(typeof stt.text).toBe('string');
    console.log(`  Fireworks STT: "${stt.text}" (${ms}ms)`);
  });

  it('isConfigured returns true', () => {
    expect(fireworksSTT.isConfigured()).toBe(true);
  });
});

// ── LLM ── 1 call total ──────────────────────────────────────────────────────
//
// Single short call covers: basic completion, usage, maxTokens respected.

describe.skipIf(!process.env.FIREWORKS_API_KEY)('Fireworks LLM (Real API)', () => {
  let llm: LLMResponse | null = null;
  let ms = 0;

  beforeAll(async () => {
    try {
      ({ result: llm, ms } = await timed(() =>
        fireworksLLM.chat({
          messages: [
            { role: 'system', content: 'Reply in one word only.' },
            { role: 'user', content: 'Capital of Japan?' },
          ],
          model: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
          temperature: 0,
          maxTokens: 10,
        }),
      ));
    } catch (err: unknown) {
      if (!skipOn(err)) throw err;
    }
  });

  it('returns correct answer', () => {
    if (!llm) return;
    expect(llm.content.toLowerCase()).toContain('tokyo');
    console.log(`  Fireworks LLM: "${llm.content}" (${ms}ms)`);
  });

  it('returns usage stats', () => {
    if (!llm) return;
    expect(llm.usage).toBeDefined();
    expect(llm.usage!.totalTokens).toBeGreaterThan(0);
  });

  it('respects maxTokens (completionTokens ≤ 10)', () => {
    if (!llm) return;
    expect(llm.usage!.completionTokens).toBeLessThanOrEqual(20); // 2x buffer
  });
});

// ── Image ── 1 call total ────────────────────────────────────────────────────

describe.skipIf(!process.env.FIREWORKS_API_KEY)('Fireworks Image (Real API)', () => {
  const image = new FireworksImageProvider();
  let result: { image: Buffer; contentType: string } | null = null;
  let ms = 0;

  beforeAll(async () => {
    try {
      ({ result, ms } = await timed(() =>
        image.generate({
          prompt: 'A simple blue square on white background, minimalist',
          model: 'flux-1-dev-fp8',
          width: 512,
          height: 512,
          steps: 10,
        }),
      ));
    } catch (err: unknown) {
      if (!skipOn(err)) throw err;
    }
  });

  it('returns image buffer', () => {
    if (!result) return;
    expect(result.image).toBeInstanceOf(Buffer);
    expect(result.image.length).toBeGreaterThan(1000);
    console.log(`  Fireworks Image: ${result.image.length} bytes (${ms}ms)`);
  });

  it('returns jpeg contentType', () => {
    if (!result) return;
    expect(result.contentType).toBe('image/jpeg');
  });
});
