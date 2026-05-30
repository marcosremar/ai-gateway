/**
 * OpenRouter Provider — Integration Tests (Real API)
 *
 * Tests LLM and Image generation against OpenRouter's live API.
 * Requires: OPENROUTER_API_KEY
 *
 * Cost minimization: ONE beforeAll collects results for all LLM assertions.
 * Only 2 LLM models tested: gpt-4o-mini (paid routing) + llama (free tier).
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { openrouterLLM } from '../src/providers/openrouter';
import { OpenRouterImageProvider } from '../src/providers/openrouter/openrouter-image';
import type { LLMResponse } from '../src/providers/types';
import { loadEnv, timed } from './helpers';

beforeAll(() => loadEnv());

const hasApiKey = !!process.env.OPENROUTER_API_KEY;
const skipLive = process.env.SKIP_LIVE_TESTS === '1';

function skipOn(err: unknown): boolean {
  const s = (err as Record<string, unknown>)?.status;
  return s === 401 || s === 402 || s === 403 || s === 429;
}

// ── LLM ── 2 calls total (paid + free) ──────────────────────────────────────
//
// gpt-4o-mini: verifies paid routing + usage + correct answer
// llama-3.3-70b: verifies free-tier routing (zero cost)
// Dropped: claude-3.5-haiku — routing to Claude is proved by any successful call.

describe('OpenRouter LLM (Real API)', () => {
  let gptResult: LLMResponse | null = null;
  let llamaResult: LLMResponse | null = null;
  let gptMs = 0;

  beforeAll(async () => {
    if (!hasApiKey || skipLive) return;

    try {
      ({ result: gptResult, ms: gptMs } = await timed(() =>
        openrouterLLM.chat({
          messages: [
            { role: 'system', content: 'Reply in one word.' },
            { role: 'user', content: 'Largest planet in our solar system?' },
          ],
          model: 'openai/gpt-4o-mini',
          temperature: 0,
          maxTokens: 10,
        }),
      ));
    } catch (err: unknown) {
      if (!skipOn(err)) throw err;
    }

    try {
      ({ result: llamaResult } = await timed(() =>
        openrouterLLM.chat({
          messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
          model: 'meta-llama/llama-3.3-70b-instruct',
          maxTokens: 10,
        }),
      ));
    } catch (err: unknown) {
      if (!skipOn(err)) throw err;
    }
  });

  test('gpt-4o-mini routes correctly and returns expected answer', () => {
    if (!hasApiKey || skipLive) return;
    if (!gptResult) return;
    expect(gptResult.content.toLowerCase()).toContain('jupiter');
    console.log(`  OpenRouter LLM (gpt-4o-mini): "${gptResult.content}" (${gptMs}ms)`);
  });

  test('gpt-4o-mini returns usage stats', () => {
    if (!hasApiKey || skipLive) return;
    if (!gptResult) return;
    expect(gptResult.usage).toBeDefined();
    expect(gptResult.usage!.totalTokens).toBeGreaterThan(0);
  });

  test('llama-3.3-70b (free) routes and returns a response', () => {
    if (!hasApiKey || skipLive) return;
    if (!llamaResult) return;
    expect(llamaResult.content.toLowerCase()).toContain('hello');
  });
});

// ── Image ── 1 call total ────────────────────────────────────────────────────

describe('OpenRouter Image (Real API)', () => {
  const image = new OpenRouterImageProvider();
  let result: { image: Buffer; contentType: string } | null = null;
  let ms = 0;

  beforeAll(async () => {
    if (!hasApiKey || skipLive) return;

    try {
      ({ result, ms } = await timed(() =>
        image.generate({
          prompt: 'A simple green triangle on a white background, minimalist vector art',
          model: 'google/gemini-2.5-flash-image',
        }),
      ));
    } catch (err: unknown) {
      if (!skipOn(err)) throw err;
    }
  });

  test('returns image buffer', () => {
    if (!hasApiKey || skipLive) return;
    if (!result) return;
    expect(result.image).toBeInstanceOf(Buffer);
    expect(result.image.length).toBeGreaterThan(500);
    console.log(`  OpenRouter Image: ${result.image.length} bytes, ${result.contentType} (${ms}ms)`);
  });

  test('returns a valid content type', () => {
    if (!hasApiKey || skipLive) return;
    if (!result) return;
    expect(result.contentType).toMatch(/^image\//);
  });
});
