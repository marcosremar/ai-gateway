/**
 * Fireworks AI Provider — Integration Tests (Real API)
 *
 * Tests STT and LLM against Fireworks' live API.
 * Image generation is tested separately (slower, costs more).
 * Requires: FIREWORKS_API_KEY
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { fireworksSTT, fireworksLLM } from '../src/providers/fireworks';
import { FireworksImageProvider } from '../src/providers/fireworks/fireworks-image';
import { loadEnv, makeTestWav, timed } from './helpers';

beforeAll(() => loadEnv());

describe.skipIf(!process.env.FIREWORKS_API_KEY)('Fireworks STT (Real API)', () => {
  it('transcribes audio with whisper-v3-turbo', async () => {
    const audio = makeTestWav(1.0);
    try {
      const { result, ms } = await timed(() =>
        fireworksSTT.transcribe({ audio, model: 'whisper-v3-turbo' }),
      );
      expect(result).toBeDefined();
      expect(typeof result.text).toBe('string');
      console.log(`  Fireworks STT: "${result.text}" (${ms}ms)`);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403 || status === 429) return; // key invalid/no credits/rate-limited
      throw err;
    }
  });

  it('isConfigured returns true', () => {
    expect(fireworksSTT.isConfigured()).toBe(true);
  });
});

describe.skipIf(!process.env.FIREWORKS_API_KEY)('Fireworks LLM (Real API)', () => {
  it('completes a chat with llama', async () => {
    try {
      const { result, ms } = await timed(() =>
        fireworksLLM.chat({
          messages: [
            { role: 'system', content: 'Reply in one word only.' },
            { role: 'user', content: 'Capital of Japan?' },
          ],
          model: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
          temperature: 0,
          maxTokens: 10,
        }),
      );
      expect(result.content.toLowerCase()).toContain('tokyo');
      expect(result.usage).toBeDefined();
      console.log(`  Fireworks LLM: "${result.content}" (${ms}ms)`);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403 || status === 429) return;
      throw err;
    }
  });

  it('respects maxTokens', async () => {
    try {
      const result = await fireworksLLM.chat({
        messages: [{ role: 'user', content: 'Write a long story.' }],
        model: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
        maxTokens: 5,
      });
      expect(result.usage!.completionTokens).toBeLessThanOrEqual(10);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403 || status === 429) return;
      throw err;
    }
  });
});

describe.skipIf(!process.env.FIREWORKS_API_KEY)('Fireworks Image (Real API)', () => {
  const image = new FireworksImageProvider();

  it('generates an image with Flux', async () => {
    try {
      const { result, ms } = await timed(() =>
        image.generate({
          prompt: 'A simple blue square on white background, minimalist',
          model: 'flux-1-dev-fp8',
          width: 512,
          height: 512,
          steps: 10,
        }),
      );
      expect(result.image).toBeInstanceOf(Buffer);
      expect(result.image.length).toBeGreaterThan(1000);
      expect(result.contentType).toBe('image/jpeg');
      console.log(`  Fireworks Image: ${result.image.length} bytes (${ms}ms)`);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403 || status === 429) return;
      throw err;
    }
  });
});
