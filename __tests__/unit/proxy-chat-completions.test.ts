import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleChatCompletions } from '../../src/proxy/routes/chat-completions';
import type { ProxyRequest, ChatFallbackEntry, ChatDynamicRoute } from '../../src/proxy/types';
import type { GuardrailEngine } from '../../src/gateway/guardrails';

function makeReq(body: Record<string, unknown>): ProxyRequest {
  return { method: 'POST', url: '/v1/chat/completions', headers: {}, body, rawBody: Buffer.alloc(0) };
}

const validMessages = [{ role: 'user', content: 'hi' }];

const mockProvider = {
  providerId: 'test',
  chat: vi.fn().mockResolvedValue({
    content: 'hello',
    model: 'test-model',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }),
  isConfigured: () => true,
};

const providers = { 'test-model': mockProvider };

describe('handleChatCompletions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when model is missing', async () => {
    const res = await handleChatCompletions(makeReq({ messages: [{ role: 'user', content: 'hi' }] }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when messages array is empty', async () => {
    const res = await handleChatCompletions(makeReq({ model: 'test-model', messages: [] }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when messages is not an array', async () => {
    const res = await handleChatCompletions(makeReq({ model: 'test-model', messages: 'hi' }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when temperature is negative', async () => {
    const res = await handleChatCompletions(makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], temperature: -1 }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when temperature > 2', async () => {
    const res = await handleChatCompletions(makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], temperature: 2.5 }), providers);
    expect(res.status).toBe(400);
  });

  it('ignores non-numeric temperature (treated as undefined)', async () => {
    const res = await handleChatCompletions(makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], temperature: 'hot' }), providers);
    // Non-number temperature is silently ignored (coerced to undefined), so the request succeeds
    expect(res.status).toBe(200);
  });

  it('returns 400 when max_tokens is 0', async () => {
    const res = await handleChatCompletions(makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 0 }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when max_tokens > 128000', async () => {
    const res = await handleChatCompletions(makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 200000 }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 404 when model not found', async () => {
    const res = await handleChatCompletions(makeReq({ model: 'nonexistent', messages: [{ role: 'user', content: 'hi' }] }), providers);
    expect(res.status).toBe(404);
  });

  it('returns 200 with content on valid request', async () => {
    const res = await handleChatCompletions(makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }), providers);
    expect(res.status).toBe(200);
    const body = res.body as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('hello');
    expect(mockProvider.chat).toHaveBeenCalledOnce();
  });

  it('passes temperature and max_tokens to provider', async () => {
    await handleChatCompletions(makeReq({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      max_tokens: 100,
    }), providers);

    expect(mockProvider.chat).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.7, maxTokens: 100 }),
    );
  });

  it('passes response_format to provider', async () => {
    await handleChatCompletions(makeReq({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    }), providers);

    expect(mockProvider.chat).toHaveBeenCalledWith(
      expect.objectContaining({ responseFormat: { type: 'json_object' } }),
    );
  });

  it('returns usage in response', async () => {
    const res = await handleChatCompletions(makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }), providers);
    const body = res.body as { usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
    expect(body.usage.prompt_tokens).toBe(10);
    expect(body.usage.completion_tokens).toBe(5);
    expect(body.usage.total_tokens).toBe(15);
  });

  it('emits onRequestStart hook', async () => {
    const onRequestStart = vi.fn();
    await handleChatCompletions(
      makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }),
      providers,
      undefined,
      { onRequestStart },
    );
    expect(onRequestStart).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'test', model: 'test-model', stage: 'llm' }),
    );
  });

  it('emits onRequestEnd hook on success', async () => {
    const onRequestEnd = vi.fn();
    await handleChatCompletions(
      makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }),
      providers,
      undefined,
      { onRequestEnd },
    );
    expect(onRequestEnd).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, stage: 'llm' }),
    );
  });

  it('emits onRequestEnd hook on failure', async () => {
    mockProvider.chat.mockRejectedValueOnce(new Error('upstream fail'));
    const onRequestEnd = vi.fn();
    const res = await handleChatCompletions(
      makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }),
      providers,
      undefined,
      { onRequestEnd },
    );
    expect(res.status).toBe(500);
    expect(onRequestEnd).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it('returns 500 when provider throws', async () => {
    mockProvider.chat.mockRejectedValueOnce(new Error('upstream fail'));
    const res = await handleChatCompletions(makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }), providers);
    expect(res.status).toBe(500);
  });

  it('response has chat.completion structure', async () => {
    const res = await handleChatCompletions(makeReq({ model: 'test-model', messages: validMessages }), providers);
    const body = res.body as { id: string; object: string; model: string; choices: unknown[] };
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('test-model');
    expect(body.choices).toHaveLength(1);
  });

  // ── Message validation ────────────────────────────────────────────────────

  it('returns 400 when a message has no role', async () => {
    const res = await handleChatCompletions(
      makeReq({ model: 'test-model', messages: [{ content: 'hi' }] }),
      providers,
    );
    expect(res.status).toBe(400);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toMatch(/messages\[0\] must have a string role/);
  });

  it('returns 400 when message content is a number (invalid)', async () => {
    const res = await handleChatCompletions(
      makeReq({ model: 'test-model', messages: [{ role: 'user', content: 42 }] }),
      providers,
    );
    expect(res.status).toBe(400);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toMatch(/content must be a string or an array/);
  });

  it('accepts multimodal messages with image_url parts', async () => {
    const res = await handleChatCompletions(
      makeReq({
        model: 'test-model',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
          ],
        }],
      }),
      providers,
    );
    expect(res.status).toBe(200);
  });

  it('returns 400 when content array contains part without type', async () => {
    const res = await handleChatCompletions(
      makeReq({
        model: 'test-model',
        messages: [{ role: 'user', content: [{ url: 'https://example.com/img.png' }] }],
      }),
      providers,
    );
    expect(res.status).toBe(400);
  });

  // ── Guardrails ────────────────────────────────────────────────────────────

  it('returns 400 when beforeRequest guardrail blocks', async () => {
    const guardrails = {
      action: 'block',
      runBeforeRequest: vi.fn().mockResolvedValue({ pass: false, reason: 'Blocked by policy', failedRule: 'test-rule' }),
      runAfterResponse: vi.fn().mockResolvedValue({ pass: true }),
    } as unknown as GuardrailEngine;

    const res = await handleChatCompletions(
      makeReq({ model: 'test-model', messages: validMessages }),
      providers,
      undefined,
      undefined,
      undefined,
      guardrails,
    );
    expect(res.status).toBe(400);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toBe('Blocked by policy');
    expect(mockProvider.chat).not.toHaveBeenCalled();
  });

  it('continues when beforeRequest guardrail fails in audit mode', async () => {
    const guardrails = {
      action: 'audit',
      runBeforeRequest: vi.fn().mockResolvedValue({ pass: false, reason: 'Audit only', failedRule: 'audit-rule' }),
      runAfterResponse: vi.fn().mockResolvedValue({ pass: true }),
    } as unknown as GuardrailEngine;

    const res = await handleChatCompletions(
      makeReq({ model: 'test-model', messages: validMessages }),
      providers,
      undefined,
      undefined,
      undefined,
      guardrails,
    );
    expect(res.status).toBe(200);
    expect(mockProvider.chat).toHaveBeenCalledOnce();
  });

  it('returns 400 when afterResponse guardrail blocks', async () => {
    const guardrails = {
      action: 'block',
      runBeforeRequest: vi.fn().mockResolvedValue({ pass: true }),
      runAfterResponse: vi.fn().mockResolvedValue({ pass: false, reason: 'Response blocked', failedRule: 'response-rule' }),
    } as unknown as GuardrailEngine;

    const res = await handleChatCompletions(
      makeReq({ model: 'test-model', messages: validMessages }),
      providers,
      undefined,
      undefined,
      undefined,
      guardrails,
    );
    expect(res.status).toBe(400);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toBe('Response blocked');
  });

  it('returns 200 when afterResponse guardrail fails in audit mode', async () => {
    const guardrails = {
      action: 'audit',
      runBeforeRequest: vi.fn().mockResolvedValue({ pass: true }),
      runAfterResponse: vi.fn().mockResolvedValue({ pass: false, reason: 'Audit response', failedRule: 'audit-response' }),
    } as unknown as GuardrailEngine;

    const res = await handleChatCompletions(
      makeReq({ model: 'test-model', messages: validMessages }),
      providers,
      undefined,
      undefined,
      undefined,
      guardrails,
    );
    expect(res.status).toBe(200);
  });

  // ── Dynamic routes ────────────────────────────────────────────────────────

  it('routes to dynamic provider when model not in static providers', async () => {
    const dynamicProvider = {
      providerId: 'openrouter',
      chat: vi.fn().mockResolvedValue({
        content: 'dynamic result',
        model: 'gpt-4o',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      }),
      isConfigured: () => true,
    };

    const dynamicRoutes: ChatDynamicRoute[] = [{
      providerId: 'openrouter',
      provider: dynamicProvider as any,
      acceptsModel: (m) => m.startsWith('gpt-'),
      upstreamModel: (m) => m,
    }];

    const res = await handleChatCompletions(
      makeReq({ model: 'gpt-4o', messages: validMessages }),
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      dynamicRoutes,
    );
    expect(res.status).toBe(200);
    const body = res.body as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('dynamic result');
    expect(dynamicProvider.chat).toHaveBeenCalledOnce();
  });

  it('returns 404 when no dynamic route accepts the model', async () => {
    const dynamicRoutes: ChatDynamicRoute[] = [{
      providerId: 'openrouter',
      provider: {} as any,
      acceptsModel: (_m) => false,
    }];

    const res = await handleChatCompletions(
      makeReq({ model: 'unknown-model', messages: validMessages }),
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      dynamicRoutes,
    );
    expect(res.status).toBe(404);
  });

  // ── Fallback chain ────────────────────────────────────────────────────────

  it('uses fallback provider when primary fails', async () => {
    const fallbackProvider = {
      providerId: 'fallback',
      chat: vi.fn().mockResolvedValue({
        content: 'fallback result',
        model: 'test-model',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      }),
      isConfigured: () => true,
    };

    mockProvider.chat.mockRejectedValueOnce(Object.assign(new Error('rate limit'), { status: 429 }));

    const fallbackChain: ChatFallbackEntry[] = [{
      providerId: 'fallback',
      model: 'test-model',
      provider: fallbackProvider as any,
    }];

    const res = await handleChatCompletions(
      makeReq({ model: 'test-model', messages: validMessages }),
      providers,
      undefined,
      undefined,
      fallbackChain,
    );
    // The fallback executes and returns success
    expect(res.status).toBe(200);
    expect(fallbackProvider.chat).toHaveBeenCalledOnce();
  });

  it('does not append fallback entries when primary model is not found', async () => {
    const fallbackProvider = {
      providerId: 'fallback',
      chat: vi.fn().mockResolvedValue({ content: 'should not be called', model: 'x', usage: {} }),
      isConfigured: () => true,
    };

    const fallbackChain: ChatFallbackEntry[] = [{
      providerId: 'fallback',
      model: 'fallback-model',
      provider: fallbackProvider as any,
    }];

    // 'no-such-model' is not in providers, so chain is empty → 404
    const res = await handleChatCompletions(
      makeReq({ model: 'no-such-model', messages: validMessages }),
      providers,
      undefined,
      undefined,
      fallbackChain,
    );
    expect(res.status).toBe(404);
    expect(fallbackProvider.chat).not.toHaveBeenCalled();
  });
});
