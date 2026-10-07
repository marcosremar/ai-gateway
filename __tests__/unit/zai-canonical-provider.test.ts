/**
 * Z.AI lives in the canonical provider tree (src/gateway), not in the src/modules mirror: it must be built on the
 * canonical OpenAICompatLLMProvider, which reads the key per call (runtime key rotation) — the modules copy cached
 * the first key forever.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { zaiLLM, ZAI_LLM_MODELS } from '../../src/gateway/providers/cloud/zai';
import { OpenAICompatLLMProvider } from '../../src/gateway/providers/cloud/openai-compat/openai-compat-llm';

const saved = process.env.ZAI_API_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.ZAI_API_KEY;
  else process.env.ZAI_API_KEY = saved;
});

describe('zai provider (canonical tree)', () => {
  it('is the canonical OpenAI-compatible provider with its model list', () => {
    expect(zaiLLM).toBeInstanceOf(OpenAICompatLLMProvider);
    expect(ZAI_LLM_MODELS.length).toBeGreaterThan(0);
  });

  it('picks up a rotated ZAI_API_KEY on the next call', () => {
    const getClient = (zaiLLM as unknown as { getClient: () => { apiKey: string } }).getClient.bind(zaiLLM);
    process.env.ZAI_API_KEY = 'zai-key-one';
    expect(getClient().apiKey).toBe('zai-key-one');
    process.env.ZAI_API_KEY = 'zai-key-two';
    expect(getClient().apiKey).toBe('zai-key-two');
  });
});
