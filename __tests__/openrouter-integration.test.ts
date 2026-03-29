/**
 * OpenRouter Provider — Integration Tests (Real API)
 *
 * Tests LLM and Image generation against OpenRouter's live API.
 * Requires: OPENROUTER_API_KEY
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { openrouterLLM } from '../src/providers/openrouter';
import { OpenRouterImageProvider } from '../src/providers/openrouter/openrouter-image';
import { loadEnv, timed } from './helpers';

beforeAll(() => loadEnv());

describe.skipIf(!process.env.OPENROUTER_API_KEY)('OpenRouter LLM (Real API)', () => {
  it('completes chat via gpt-4o-mini', async () => {
    try {
      const { result, ms } = await timed(() =>
        openrouterLLM.chat({
          messages: [
            { role: 'system', content: 'Reply in one word.' },
            { role: 'user', content: 'Largest planet in our solar system?' },
          ],
          model: 'openai/gpt-4o-mini',
          temperature: 0,
          maxTokens: 10,
        }),
      );

      expect(result.content.toLowerCase()).toContain('jupiter');
      expect(result.usage).toBeDefined();
      console.log(`  OpenRouter LLM (gpt-4o-mini): "${result.content}" (${ms}ms)`);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
      throw err;
    }
  });

  it('completes chat via claude-3.5-haiku', async () => {
    try {
      const { result, ms } = await timed(() =>
        openrouterLLM.chat({
          messages: [
            { role: 'system', content: 'Reply in one word.' },
            { role: 'user', content: 'What is 2 + 2?' },
          ],
          model: 'anthropic/claude-3.5-haiku',
          temperature: 0,
          maxTokens: 5,
        }),
      );

      expect(result.content).toMatch(/4|four/i);
      console.log(`  OpenRouter LLM (claude-3.5-haiku): "${result.content}" (${ms}ms)`);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
      throw err;
    }
  });

  it('completes chat via llama-3.3-70b (free)', async () => {
    try {
      const result = await openrouterLLM.chat({
        messages: [
          { role: 'user', content: 'Say "hello" and nothing else.' },
        ],
        model: 'meta-llama/llama-3.3-70b-instruct',
        maxTokens: 10,
      });

      expect(result.content.toLowerCase()).toContain('hello');
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
      throw err;
    }
  });
});

describe.skipIf(!process.env.OPENROUTER_API_KEY)('OpenRouter Image (Real API)', () => {
  const image = new OpenRouterImageProvider();

  it('generates an image via Gemini Flash', async () => {
    try {
      const { result, ms } = await timed(() =>
        image.generate({
          prompt: 'A simple green triangle on a white background, minimalist vector art',
          model: 'google/gemini-2.5-flash-image',
        }),
      );

      expect(result.image).toBeInstanceOf(Buffer);
      expect(result.image.length).toBeGreaterThan(500);
      console.log(`  OpenRouter Image: ${result.image.length} bytes, ${result.contentType} (${ms}ms)`);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
      throw err;
    }
  });
});
