import { afterEach, describe, expect, it, vi } from 'vitest';
import { MINIMAX_LLM_MODELS, MinimaxLLMProvider } from '../../src/gateway/providers/cloud/minimax/llm';

const realFetch = globalThis.fetch;

function openAiCompatResponse(content = 'OK') {
  return {
    id: 'chatcmpl-test',
    model: 'MiniMax-M2.7-highspeed',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content },
    }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };
}

describe('MinimaxLLMProvider', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('uses the OpenAI-compatible chat completions endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(openAiCompatResponse()), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new MinimaxLLMProvider('https://api.minimax.io').withApiKey('test-key');
    const result = await provider.chat({
      model: 'MiniMax-M2.7-highspeed',
      messages: [{ role: 'user', content: 'Reply OK' }],
      maxTokens: 16,
      temperature: 0.2,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.minimax.io/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      model: 'MiniMax-M2.7-highspeed',
      max_tokens: 16,
      temperature: 0.2,
      stream: false,
      reasoning_split: true,
    });
    expect(result.content).toBe('OK');
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 1, totalTokens: 4 });
  });

  it('does not double-append /v1 for MiniMax M2 base URLs', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(openAiCompatResponse('ready')), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new MinimaxLLMProvider('https://minimax-m2.com/api/v1').withApiKey('test-key');
    await provider.chat({
      model: 'MiniMax-M2',
      messages: [{ role: 'user', content: 'ping' }],
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://minimax-m2.com/api/v1/chat/completions');
  });

  it('surfaces structured MiniMax rate-limit errors', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'usage limit exceeded',
        http_code: '429',
      },
      request_id: 'req-test',
    }), { status: 429 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new MinimaxLLMProvider('https://api.minimax.io').withApiKey('test-key');

    await expect(provider.chat({
      model: 'MiniMax-M2.7-highspeed',
      messages: [{ role: 'user', content: 'ping' }],
    })).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining('usage limit exceeded'),
    });
  });

  it('falls back from highspeed to standard model on Token Plan Max exhaustion', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.model === 'MiniMax-M2.7-highspeed') {
        return new Response(JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'usage limit exceeded, 5-hour usage limit reached for Token Plan Max (0/0 used)',
            http_code: '429',
          },
          request_id: 'req-highspeed',
        }), { status: 429 });
      }
      return new Response(JSON.stringify(openAiCompatResponse('OK fallback')), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new MinimaxLLMProvider('https://api.minimax.io').withApiKey('test-key');
    const result = await provider.chat({
      model: 'MiniMax-M2.7-highspeed',
      messages: [{ role: 'user', content: 'ping' }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).model).toBe('MiniMax-M2.7');
    expect(result.content).toBe('OK fallback');
  });

  it('exports the current MiniMax M-series model IDs for gateway routing', () => {
    expect(MINIMAX_LLM_MODELS).toEqual(expect.arrayContaining([
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.7',
      'MiniMax-M2',
    ]));
  });
});
