import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleChatCompletions } from '../src/proxy/routes/chat-completions';
import type { ProxyRequest } from '../src/proxy/types';

/** Drain a ReadableStream into a string */
async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(merged);
}

/** Parse SSE text into data payloads (skips [DONE]) */
function parseSSE(raw: string): unknown[] {
  return raw
    .split('\n\n')
    .map(block => block.trim())
    .filter(block => block.startsWith('data: ') && !block.includes('[DONE]'))
    .map(block => JSON.parse(block.slice('data: '.length)));
}

function makeReq(body: Record<string, unknown>): ProxyRequest {
  return { method: 'POST', url: '/v1/chat/completions', headers: {}, body, rawBody: Buffer.alloc(0) };
}

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

  it('accepts multimodal content (array of parts) for vision calls', async () => {
    const res = await handleChatCompletions(
      makeReq({
        model: 'test-model',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe this frame' },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
            ],
          },
        ],
      }),
      providers,
    );
    expect(res.status).toBe(200);
    expect(mockProvider.chat).toHaveBeenCalledOnce();
    const callArgs = mockProvider.chat.mock.calls[0][0];
    expect(Array.isArray(callArgs.messages[0].content)).toBe(true);
  });

  it('rejects content array where a part has no type', async () => {
    const res = await handleChatCompletions(
      makeReq({
        model: 'test-model',
        messages: [
          { role: 'user', content: [{ notAType: 'x' }] },
        ],
      }),
      providers,
    );
    expect(res.status).toBe(400);
  });

  it('rejects content that is neither string nor array', async () => {
    const res = await handleChatCompletions(
      makeReq({
        model: 'test-model',
        messages: [{ role: 'user', content: 42 }],
      }),
      providers,
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when model not found', async () => {
    const res = await handleChatCompletions(makeReq({ model: 'nonexistent', messages: [{ role: 'user', content: 'hi' }] }), providers);
    expect(res.status).toBe(404);
  });

  it('routes unknown slash model ids through a dynamic provider', async () => {
    const dynamicProvider = {
      providerId: 'openrouter',
      chat: vi.fn().mockResolvedValue({
        content: 'vision ok',
        model: 'qwen/qwen3-vl-32b-instruct',
        usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23 },
      }),
      isConfigured: () => true,
    };
    const res = await handleChatCompletions(
      makeReq({
        model: 'qwen/qwen3-vl-32b-instruct',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'compare' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      }),
      providers,
      undefined,
      undefined,
      undefined,
      undefined,
      [{
        providerId: 'openrouter',
        provider: dynamicProvider as any,
        acceptsModel: (model) => model.includes('/'),
      }],
    );
    expect(res.status).toBe(200);
    expect(dynamicProvider.chat).toHaveBeenCalledWith(expect.objectContaining({
      model: 'qwen/qwen3-vl-32b-instruct',
    }));
  });

  it('can map a dynamic gateway alias to an upstream model id', async () => {
    const dynamicProvider = {
      providerId: 'openrouter',
      chat: vi.fn().mockResolvedValue({
        content: 'alias ok',
        model: 'qwen/qwen3-vl-32b-instruct',
      }),
      isConfigured: () => true,
    };
    const res = await handleChatCompletions(
      makeReq({
        model: 'openrouter/qwen/qwen3-vl-32b-instruct',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      providers,
      undefined,
      undefined,
      undefined,
      undefined,
      [{
        providerId: 'openrouter',
        provider: dynamicProvider as any,
        acceptsModel: (model) => model.startsWith('openrouter/'),
        upstreamModel: (model) => model.slice('openrouter/'.length),
      }],
    );
    expect(res.status).toBe(200);
    expect(dynamicProvider.chat).toHaveBeenCalledWith(expect.objectContaining({
      model: 'qwen/qwen3-vl-32b-instruct',
    }));
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
    expect(res.status).toBe(503);
    expect(onRequestEnd).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it('returns 503 provider_unavailable when the only provider throws', async () => {
    mockProvider.chat.mockRejectedValueOnce(new Error('upstream fail'));
    const res = await handleChatCompletions(makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }), providers);
    expect(res.status).toBe(503);
    expect((res.body as { error: { type: string } }).error.type).toBe('provider_unavailable');
  });

  it('response has chat.completion structure', async () => {
    const res = await handleChatCompletions(makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }), providers);
    const body = res.body as { id: string; object: string; model: string; choices: unknown[] };
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('test-model');
    expect(body.choices).toHaveLength(1);
  });
});

// ── Streaming (SSE) path ──────────────────────────────────────────────────────

describe('handleChatCompletions — streaming', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns text/event-stream content-type when stream: true', async () => {
    const streamingProvider = {
      providerId: 'test',
      chat: vi.fn(),
      chatStream: async function* () { yield 'hello'; },
      isConfigured: () => true,
    };
    const res = await handleChatCompletions(
      makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      { 'test-model': streamingProvider },
    );
    expect(res.status).toBe(200);
    expect(res.headers?.['Content-Type']).toBe('text/event-stream');
    expect(res.stream).toBeDefined();
    // Drain so we don't leave an open stream
    if (res.stream) await drainStream(res.stream);
  });

  it('streams content chunks via chatStream()', async () => {
    const words = ['Hello', ' ', 'world'];
    const streamingProvider = {
      providerId: 'test',
      chat: vi.fn(),
      chatStream: async function* () { for (const w of words) yield w; },
      isConfigured: () => true,
    };
    const res = await handleChatCompletions(
      makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      { 'test-model': streamingProvider },
    );
    expect(res.stream).toBeDefined();
    const raw = await drainStream(res.stream!);
    const chunks = parseSSE(raw);
    // First chunk has role delta; subsequent ones have content deltas; last has finish_reason
    const roleChunk = chunks[0] as { choices: Array<{ delta: { role?: string; content?: string } }> };
    expect(roleChunk.choices[0].delta.role).toBe('assistant');
    const contentChunks = chunks.slice(1, -1);
    const assembled = contentChunks.map(c => (c as { choices: Array<{ delta: { content?: string } }> }).choices[0].delta.content).join('');
    expect(assembled).toBe('Hello world');
    const finalChunk = chunks[chunks.length - 1] as { choices: Array<{ finish_reason: string }> };
    expect(finalChunk.choices[0].finish_reason).toBe('stop');
    expect(raw).toContain('data: [DONE]');
  });

  it('falls back to single-chunk emission when provider lacks chatStream', async () => {
    const nonStreamingProvider = {
      providerId: 'test',
      chat: vi.fn().mockResolvedValue({ content: 'fallback response', model: 'test-model' }),
      isConfigured: () => true,
    };
    const res = await handleChatCompletions(
      makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      { 'test-model': nonStreamingProvider },
    );
    expect(res.stream).toBeDefined();
    const raw = await drainStream(res.stream!);
    const chunks = parseSSE(raw);
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0] as { choices: Array<{ delta: { content?: string }; finish_reason?: string }> };
    expect(chunk.choices[0].delta.content).toBe('fallback response');
    expect(chunk.choices[0].finish_reason).toBe('stop');
    expect(raw).toContain('data: [DONE]');
  });

  it('emits usage chunk when stream_options.include_usage is true (chatStream path)', async () => {
    const streamingProvider = {
      providerId: 'test',
      chat: vi.fn(),
      chatStream: async function* () {
        yield 'hi';
        yield '__usage__:{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}';
      },
      isConfigured: () => true,
    };
    const res = await handleChatCompletions(
      makeReq({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
      { 'test-model': streamingProvider },
    );
    const raw = await drainStream(res.stream!);
    const chunks = parseSSE(raw);
    const usageChunk = chunks.find(c => (c as { usage?: unknown }).usage !== undefined) as { usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } | undefined;
    expect(usageChunk).toBeDefined();
    expect(usageChunk!.usage.prompt_tokens).toBe(5);
    expect(usageChunk!.usage.completion_tokens).toBe(2);
    expect(usageChunk!.usage.total_tokens).toBe(7);
  });

  it('emits usage chunk when stream_options.include_usage is true (non-streaming fallback)', async () => {
    const nonStreamingProvider = {
      providerId: 'test',
      chat: vi.fn().mockResolvedValue({
        content: 'ok',
        model: 'test-model',
        usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
      }),
      isConfigured: () => true,
    };
    const res = await handleChatCompletions(
      makeReq({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
      { 'test-model': nonStreamingProvider },
    );
    const raw = await drainStream(res.stream!);
    const chunks = parseSSE(raw);
    const usageChunk = chunks.find(c => (c as { usage?: unknown }).usage !== undefined) as { usage: { prompt_tokens: number } } | undefined;
    expect(usageChunk).toBeDefined();
    expect(usageChunk!.usage.prompt_tokens).toBe(3);
  });

  it('emits onRequestEnd hook after stream is consumed', async () => {
    const streamingProvider = {
      providerId: 'test',
      chat: vi.fn(),
      chatStream: async function* () { yield 'done'; },
      isConfigured: () => true,
    };
    const onRequestEnd = vi.fn();
    const res = await handleChatCompletions(
      makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      { 'test-model': streamingProvider },
      undefined,
      { onRequestEnd },
    );
    await drainStream(res.stream!);
    expect(onRequestEnd).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, stage: 'llm' }),
    );
  });

  it('emits onRequestEnd with success:false and calls cancel when stream is cancelled', async () => {
    let returnCalled = false;
    const streamingProvider = {
      providerId: 'test',
      chat: vi.fn(),
      chatStream: async function* () {
        try {
          yield 'chunk1';
          await new Promise(() => {}); // hang forever
        } finally {
          returnCalled = true;
        }
      },
      isConfigured: () => true,
    };
    const onRequestEnd = vi.fn();
    const res = await handleChatCompletions(
      makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      { 'test-model': streamingProvider },
      undefined,
      { onRequestEnd },
    );
    const reader = res.stream!.getReader();
    // Read the first chunk (role delta), then cancel
    await reader.read();
    await reader.cancel();
    // Give microtasks a chance to propagate
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(onRequestEnd).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it('emits an SSE error chunk when chatStream throws', async () => {
    const brokenProvider = {
      providerId: 'test',
      chat: vi.fn(),
      chatStream: async function* () {
        yield 'partial';
        throw new Error('upstream exploded');
      },
      isConfigured: () => true,
    };
    const res = await handleChatCompletions(
      makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      { 'test-model': brokenProvider },
    );
    const raw = await drainStream(res.stream!);
    expect(raw).toContain('upstream exploded');
    expect(raw).toContain('"error"');
  });
});
