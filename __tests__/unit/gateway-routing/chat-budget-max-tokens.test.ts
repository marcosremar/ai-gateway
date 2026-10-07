/**
 * Live QA 2026-10-07: `parle-llm` with `max_tokens: 1024`, non-stream, while the GPU was cold → OpenRouter fallback
 * exceeded the flat 8 s chat stage budget → 503 for every long answer. The non-stream budget now grows with
 * `max_tokens` (base + per-token allowance above the free tokens, capped); streaming keeps the flat budget.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { CooldownTracker } from '../../../src/gateway/providers/cloud/fallback';
import type { LLMProvider } from '../../../src/gateway/providers/cloud/types';
import { chatBudgetMs } from '../../../src/gateway/proxy/provider-routing';
import { handleChatCompletions } from '../../../src/gateway/proxy/routes/chat-completions';

describe('chatBudgetMs', () => {
  it('a short or streamed answer keeps the flat stage budget', () => {
    expect(chatBudgetMs(undefined, false, {})).toBe(8_000);
    expect(chatBudgetMs(160, false, {})).toBe(8_000);
    expect(chatBudgetMs(256, false, {})).toBe(8_000);
    expect(chatBudgetMs(1024, true, {})).toBe(8_000);
  });

  it('a long non-stream answer gets 20 ms per token above 256, capped at 45 s', () => {
    expect(chatBudgetMs(1024, false, {})).toBe(8_000 + 768 * 20);
    expect(chatBudgetMs(100_000, false, {})).toBe(45_000);
  });

  it('every number moves by env', () => {
    const env = { GATEWAY_CHAT_BUDGET_MS: '5000', GATEWAY_CHAT_BUDGET_PER_TOKEN_MS: '10', GATEWAY_CHAT_BUDGET_FREE_TOKENS: '0', GATEWAY_CHAT_BUDGET_MAX_MS: '9000' };
    expect(chatBudgetMs(100, false, env)).toBe(6_000);
    expect(chatBudgetMs(1024, false, env)).toBe(9_000);
    expect(chatBudgetMs(1024, false, { GATEWAY_CHAT_BUDGET_PER_TOKEN_MS: '0' })).toBe(8_000); // 0 = flat
  });
});

describe('chat route: long non-stream answer with the GPU cold', () => {
  afterEach(() => {
    for (const k of ['GATEWAY_CHAT_BUDGET_MS', 'GATEWAY_CHAT_BUDGET_PER_TOKEN_MS']) delete process.env[k];
  });

  function ask(maxTokens: number, fallbackMs: number) {
    // The deployment is cold (fails at once, neutral); the cloud fallback takes `fallbackMs` for the whole answer.
    const cold: LLMProvider = {
      providerId: 'deployment:parle-speech', isConfigured: () => true,
      chat: vi.fn(async () => { throw Object.assign(new Error('cold'), { status: 503, gatewayCode: 'cold', skipRetry: true }); }),
    } as never;
    const or: LLMProvider = {
      providerId: 'openrouter', isConfigured: () => true,
      chat: vi.fn((r: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ content: 'uma resposta longa', model: 'm' }), fallbackMs);
        r.signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      })),
    } as never;
    return handleChatCompletions(
      { method: 'POST', url: '/v1/chat/completions', headers: {}, rawBody: Buffer.alloc(0),
        body: { model: 'parle-llm', max_tokens: maxTokens, messages: [{ role: 'user', content: 'conte uma história' }] } },
      {}, undefined, undefined, undefined, undefined, undefined,
      { chatRoutes: { 'parle-llm': [{ providerId: 'deployment:parle-speech', provider: cold, model: 'q' }, { providerId: 'openrouter', provider: or, model: 'm' }] },
        circuitBreakers: new CircuitBreakerRegistry(), cooldownTracker: new CooldownTracker() },
    );
  }

  it('max_tokens 1024 is answered by the fallback past the flat budget (before: 503 provider_unavailable)', async () => {
    process.env.GATEWAY_CHAT_BUDGET_MS = '150'; // scaled down: the 8 s of production, in ms here
    process.env.GATEWAY_CHAT_BUDGET_PER_TOKEN_MS = '1';
    const res = await ask(1024, 400); // 150 + 768 ms of budget > 400 ms
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Gateway-Provider']).toContain('openrouter');
  });

  it('a short answer still fails at the flat budget (real-time turns keep their bound)', async () => {
    process.env.GATEWAY_CHAT_BUDGET_MS = '150';
    process.env.GATEWAY_CHAT_BUDGET_PER_TOKEN_MS = '1';
    const res = await ask(120, 400);
    expect(res.status).toBe(503);
  });
});
