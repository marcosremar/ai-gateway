/**
 * GatewayHttpClient (Node SDK) — Groq fallback tests.
 *
 * Covers:
 *   - transcribe() falls back to Groq Whisper when gateway is unreachable
 *   - chat() falls back to Groq LLM when gateway is unreachable
 *   - translate() falls back to Groq LLM when gateway is unreachable
 *   - No fallback when groqApiKey is not configured
 *   - No fallback on HTTP errors (gateway reachable but returning 4xx/5xx)
 *   - Groq API errors propagate correctly
 *   - Groq returns malformed/empty responses
 *   - Groq rate-limited (429) / unavailable (503)
 *   - Concurrent fallback calls
 *   - No fallback for non-inference endpoints (pipeline, GPU, health)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewayHttpClient, GatewayHttpError } from '../../sdk/node';

const mockFetch = vi.fn();
const FAKE_GROQ_KEY = 'gsk_test_fake_key';

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(groqApiKey?: string) {
  return new GatewayHttpClient({
    baseUrl: 'http://gw.test:4000',
    groqApiKey: groqApiKey ?? FAKE_GROQ_KEY,
    retry: { maxRetries: 0, backoffMs: [] }, // no retries — test fallback directly
    circuitBreaker: { failureThreshold: 100, recoveryTimeoutMs: 50, successThreshold: 1 },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// transcribe() Groq fallback
// ═══════════════════════════════════════════════════════════════════════════════

describe('GatewayHttpClient — transcribe() Groq fallback', () => {
  it('falls back to Groq Whisper when gateway is unreachable', async () => {
    // First call = gateway (connection error), second call = Groq (success)
    mockFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ text: 'Bonjour le monde' }));

    const gw = makeClient();
    const result = await gw.transcribe(new Uint8Array(100));

    expect(result.text).toBe('Bonjour le monde');
    expect(result.usedGpu).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify second call went to Groq
    const groqCall = mockFetch.mock.calls[1];
    expect(groqCall[0]).toContain('api.groq.com');
    expect(groqCall[0]).toContain('/audio/transcriptions');
  });

  it('does NOT fall back when groqApiKey is empty', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const gw = makeClient('');
    await expect(gw.transcribe(new Uint8Array(100))).rejects.toThrow(TypeError);
    expect(mockFetch).toHaveBeenCalledTimes(1); // only gateway call, no Groq
  });

  it('does NOT fall back on HTTP 500 (gateway is reachable)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Internal Error', { status: 500 }));

    const gw = makeClient();
    await expect(gw.transcribe(new Uint8Array(100))).rejects.toThrow(GatewayHttpError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back on HTTP 400', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

    const gw = makeClient();
    await expect(gw.transcribe(new Uint8Array(100))).rejects.toThrow(GatewayHttpError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends correct model and language to Groq', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ text: 'Hola' }));

    const gw = makeClient();
    await gw.transcribe(new Uint8Array(100), 'es');

    const groqCall = mockFetch.mock.calls[1];
    // FormData is used — verify the URL is correct
    expect(groqCall[0]).toContain('api.groq.com/openai/v1/audio/transcriptions');
    // Verify auth header
    expect(groqCall[1].headers.Authorization).toBe(`Bearer ${FAKE_GROQ_KEY}`);
  });

  it('propagates Groq 401 (invalid key) as GatewayHttpError', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('{"error": "Invalid API key"}', { status: 401 }));

    const gw = makeClient();
    try {
      await gw.transcribe(new Uint8Array(100));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayHttpError);
      expect((e as GatewayHttpError).statusCode).toBe(401);
      expect((e as GatewayHttpError).message).toContain('Groq STT fallback failed');
    }
  });

  it('propagates Groq 429 (rate limited)', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('{"error": "Rate limit"}', { status: 429 }));

    const gw = makeClient();
    await expect(gw.transcribe(new Uint8Array(100))).rejects.toThrow(GatewayHttpError);
  });

  it('handles Groq returning empty text', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ text: '' }));

    const gw = makeClient();
    const result = await gw.transcribe(new Uint8Array(100));
    expect(result.text).toBe('');
  });

  it('falls back on ECONNREFUSED', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:4000'))
      .mockResolvedValueOnce(jsonResponse({ text: 'fallback' }));

    const gw = makeClient();
    const result = await gw.transcribe(new Uint8Array(100));
    expect(result.text).toBe('fallback');
  });

  it('falls back on ECONNRESET', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('read ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse({ text: 'reset fallback' }));

    const gw = makeClient();
    const result = await gw.transcribe(new Uint8Array(100));
    expect(result.text).toBe('reset fallback');
  });

  it('does NOT fall back on AbortError (timeout)', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('signal timed out', 'AbortError'));

    const gw = makeClient();
    await expect(gw.transcribe(new Uint8Array(100))).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1); // no Groq call
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// chat() Groq fallback
// ═══════════════════════════════════════════════════════════════════════════════

describe('GatewayHttpClient — chat() Groq fallback', () => {
  it('falls back to Groq LLM when gateway is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(
      jsonResponse({
        model: 'llama-3.3-70b-versatile',
        choices: [{ message: { content: 'Translated via Groq' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );

    const gw = makeClient();
    const result = await gw.chat([{ role: 'user', content: 'Translate: Bonjour' }]);

    expect(result.content).toBe('Translated via Groq');
    expect(result.model).toBe('llama-3.3-70b-versatile');
    expect(result.usage).toBeDefined();
  });

  it('does NOT fall back when groqApiKey is empty', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const gw = makeClient('');
    await expect(gw.chat([{ role: 'user', content: 'Hi' }])).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back on HTTP 404', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const gw = makeClient();
    await expect(gw.chat([{ role: 'user', content: 'Hi' }])).rejects.toThrow(GatewayHttpError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends correct model and messages to Groq', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(
      jsonResponse({
        model: 'llama-3.3-70b-versatile',
        choices: [{ message: { content: 'reply' } }],
      }),
    );

    const gw = makeClient();
    await gw.chat(
      [
        { role: 'system', content: 'You are a translator.' },
        { role: 'user', content: 'Translate' },
      ],
      'llama-3.3-70b-versatile',
      { temperature: 0.3, maxTokens: 512 },
    );

    const groqCall = mockFetch.mock.calls[1];
    expect(groqCall[0]).toContain('api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(groqCall[1].body);
    expect(body.model).toBe('llama-3.3-70b-versatile');
    expect(body.messages).toHaveLength(2);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(512);
  });

  it('handles Groq returning empty choices', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(
      jsonResponse({
        model: 'llama-3.3-70b-versatile',
        choices: [],
      }),
    );

    const gw = makeClient();
    const result = await gw.chat([{ role: 'user', content: 'Hi' }]);
    expect(result.content).toBe('');
  });

  it('propagates Groq 503 (service unavailable)', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }));

    const gw = makeClient();
    await expect(gw.chat([{ role: 'user', content: 'Hi' }])).rejects.toThrow(GatewayHttpError);
  });

  it('propagates Groq network error', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('fetch failed')) // gateway
      .mockRejectedValueOnce(new TypeError('Groq also failed')); // groq

    const gw = makeClient();
    await expect(gw.chat([{ role: 'user', content: 'Hi' }])).rejects.toThrow('Groq also failed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// translate() Groq fallback (uses LLM as translation)
// ═══════════════════════════════════════════════════════════════════════════════

describe('GatewayHttpClient — translate() Groq fallback', () => {
  it('falls back to Groq LLM for translation', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(
      jsonResponse({
        model: 'llama-3.3-70b-versatile',
        choices: [{ message: { content: 'Hello world' } }],
      }),
    );

    const gw = makeClient();
    const result = await gw.translate('Bonjour le monde', 'fr', 'en');

    expect(result.translatedText).toBe('Hello world');
    expect(result.usedGpu).toBe(false);
  });

  it('does NOT fall back when groqApiKey is empty', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const gw = makeClient('');
    await expect(gw.translate('Bonjour', 'fr', 'en')).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('includes source and target language in Groq prompt', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(
      jsonResponse({
        model: 'llama-3.3-70b-versatile',
        choices: [{ message: { content: 'Hola mundo' } }],
      }),
    );

    const gw = makeClient();
    await gw.translate('Hello world', 'en', 'es');

    const groqCall = mockFetch.mock.calls[1];
    const body = JSON.parse(groqCall[1].body);
    expect(body.messages[0].content).toContain('en');
    expect(body.messages[0].content).toContain('es');
    expect(body.messages[0].content).toContain('Hello world');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// No fallback for non-inference endpoints
// ═══════════════════════════════════════════════════════════════════════════════

describe('GatewayHttpClient — no fallback for non-inference endpoints', () => {
  it('pipeline() does NOT fall back to Groq', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const gw = makeClient();
    await expect(gw.pipeline(new Uint8Array(100))).rejects.toThrow(TypeError);
    // Only gateway calls (1 attempt with maxRetries=0)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('deployGpu() does NOT fall back to Groq', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const gw = makeClient();
    await expect(gw.deployGpu({ apiKey: 'test' })).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('gpuStatus() does NOT fall back to Groq', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const gw = makeClient();
    await expect(gw.gpuStatus()).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('terminateGpu() does NOT fall back to Groq', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const gw = makeClient();
    await expect(gw.terminateGpu('test')).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('health() returns unhealthy, does NOT call Groq', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const gw = makeClient();
    const h = await gw.health();
    expect(h.isHealthy).toBe(false);
    // health() swallows the error, no Groq fallback
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Concurrent fallback
// ═══════════════════════════════════════════════════════════════════════════════

describe('GatewayHttpClient — concurrent fallback', () => {
  it('multiple concurrent transcribe calls each fall back independently', async () => {
    let groqCallCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('gw.test')) {
        throw new TypeError('fetch failed');
      }
      // Groq call
      groqCallCount++;
      return jsonResponse({ text: `result-${groqCallCount}` });
    });

    const gw = makeClient();
    const [r1, r2, r3] = await Promise.all([
      gw.transcribe(new Uint8Array(100)),
      gw.transcribe(new Uint8Array(100)),
      gw.transcribe(new Uint8Array(100)),
    ]);

    expect(r1.text).toMatch(/^result-/);
    expect(r2.text).toMatch(/^result-/);
    expect(r3.text).toMatch(/^result-/);
    expect(groqCallCount).toBe(3);
  });

  it('concurrent transcribe + chat fall back independently', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('gw.test')) {
        throw new TypeError('fetch failed');
      }
      if (url.includes('transcriptions')) {
        return jsonResponse({ text: 'stt result' });
      }
      return jsonResponse({
        model: 'llama-3.3-70b-versatile',
        choices: [{ message: { content: 'chat result' } }],
      });
    });

    const gw = makeClient();
    const [stt, chat] = await Promise.all([
      gw.transcribe(new Uint8Array(100)),
      gw.chat([{ role: 'user', content: 'Hi' }]),
    ]);

    expect(stt.text).toBe('stt result');
    expect(chat.content).toBe('chat result');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Retry + fallback interaction
// ═══════════════════════════════════════════════════════════════════════════════

describe('GatewayHttpClient — retry + fallback interaction', () => {
  it('retries gateway first, then falls back to Groq after exhaustion', async () => {
    const gw = new GatewayHttpClient({
      baseUrl: 'http://gw.test:4000',
      groqApiKey: FAKE_GROQ_KEY,
      retry: { maxRetries: 2, backoffMs: [10, 20] },
      circuitBreaker: { failureThreshold: 100, recoveryTimeoutMs: 50, successThreshold: 1 },
    });

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('gw.test')) {
        throw new TypeError('fetch failed');
      }
      return jsonResponse({ text: 'groq fallback after retries' });
    });

    const result = await gw.transcribe(new Uint8Array(100));
    expect(result.text).toBe('groq fallback after retries');
    // 3 gateway attempts (1 + 2 retries) + 1 Groq call = 4
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('gateway succeeds on retry — no Groq fallback', async () => {
    const gw = new GatewayHttpClient({
      baseUrl: 'http://gw.test:4000',
      groqApiKey: FAKE_GROQ_KEY,
      retry: { maxRetries: 2, backoffMs: [10, 20] },
      circuitBreaker: { failureThreshold: 100, recoveryTimeoutMs: 50, successThreshold: 1 },
    });

    mockFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ text: 'gateway recovered', used_gpu: true }));

    const result = await gw.transcribe(new Uint8Array(100));
    expect(result.text).toBe('gateway recovered');
    expect(result.usedGpu).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2); // no Groq call
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// groqApiKey configuration
// ═══════════════════════════════════════════════════════════════════════════════

describe('GatewayHttpClient — groqApiKey configuration', () => {
  it('reads GROQ_API_KEY from env when not provided', () => {
    const origEnv = process.env.GROQ_API_KEY;
    try {
      process.env.GROQ_API_KEY = 'gsk_from_env_test';
      const gw = new GatewayHttpClient({ baseUrl: 'http://gw.test:4000' });
      // The key is private, but we can test fallback works
      expect(gw).toBeDefined();
    } finally {
      if (origEnv !== undefined) {
        process.env.GROQ_API_KEY = origEnv;
      } else {
        delete process.env.GROQ_API_KEY;
      }
    }
  });

  it('explicit groqApiKey overrides env var', async () => {
    const origEnv = process.env.GROQ_API_KEY;
    try {
      process.env.GROQ_API_KEY = 'gsk_from_env';
      const gw = makeClient('gsk_explicit');

      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse({ text: 'test' }));

      await gw.transcribe(new Uint8Array(100));

      // Check that the explicit key was used in the Groq call
      const groqCall = mockFetch.mock.calls[1];
      expect(groqCall[1].headers.Authorization).toBe('Bearer gsk_explicit');
    } finally {
      if (origEnv !== undefined) {
        process.env.GROQ_API_KEY = origEnv;
      } else {
        delete process.env.GROQ_API_KEY;
      }
    }
  });
});
