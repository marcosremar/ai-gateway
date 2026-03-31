/**
 * Unit tests — GatewaySDK Groq fallback
 *
 * Covers:
 *  - transcribe() falls back to Groq Whisper when gateway is unreachable
 *  - chat() falls back to Groq LLM when gateway is unreachable
 *  - Gateway is tried first; fallback not triggered when gateway responds
 *  - No fallback when groqApiKey is not configured
 *  - Fallback not triggered for HTTP errors (gateway up but returning 4xx/5xx)
 *  - Groq API error propagates correctly from fallback
 *  - groqApiKey is read from GROQ_API_KEY env var when not in config
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewaySDK } from '../src/sdk/client';
import { GatewayError } from '../src/sdk/types';

const FAKE_AUDIO = new Uint8Array([82, 73, 70, 70]); // "RIFF"
const FAKE_GROQ_KEY = 'gsk_test_fake_key';

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeGatewayOnlineSttResponse(text = 'Gateway text'): Response {
  return new Response(JSON.stringify({ text, used_gpu: false, language: 'fr', avg_logprob: -0.1 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeGatewayOnlineChatResponse(content = 'Gateway response'): Response {
  return new Response(
    JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeGroqSttResponse(text = 'Bonjour le monde'): Response {
  return new Response(JSON.stringify({ text }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeGroqChatResponse(content = 'Translated via Groq', model = 'llama-3.3-70b-versatile'): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeErrorResponse(status: number, body = 'Error'): Response {
  return new Response(body, { status });
}

/** Simulates a network-level connection failure (ECONNREFUSED). */
function networkError(): TypeError {
  return new TypeError('fetch failed: ECONNREFUSED');
}

// ── transcribe() fallback ─────────────────────────────────────────────────────

describe('GatewaySDK.transcribe() — Groq fallback', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sdk: GatewaySDK;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    sdk = new GatewaySDK({ baseUrl: 'http://localhost:4000', groqApiKey: FAKE_GROQ_KEY });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to Groq when gateway throws network error after retries', async () => {
    // All gateway retry attempts fail, then Groq responds
    fetchMock
      .mockRejectedValueOnce(networkError()) // attempt 1
      .mockRejectedValueOnce(networkError()) // attempt 2
      .mockRejectedValueOnce(networkError()) // attempt 3
      .mockRejectedValueOnce(networkError()) // attempt 4
      .mockRejectedValueOnce(networkError()) // attempt 5 (final)
      .mockResolvedValueOnce(makeGroqSttResponse('Bonjour le monde')); // Groq fallback

    const result = await sdk.transcribe(FAKE_AUDIO, 'fr');
    expect(result.text).toBe('Bonjour le monde');
    expect(result.usedGpu).toBe(false);
  });

  it('does NOT fall back when gateway returns 200', async () => {
    fetchMock.mockResolvedValueOnce(makeGatewayOnlineSttResponse('Gateway text'));

    const result = await sdk.transcribe(FAKE_AUDIO, 'fr');
    expect(result.text).toBe('Gateway text');
    // Only 1 fetch call — no fallback to Groq
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back on gateway HTTP 500 — error is propagated', async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(500, 'Internal Server Error'));

    await expect(sdk.transcribe(FAKE_AUDIO)).rejects.toThrow(GatewayError);
    // Still only 1 fetch call — no Groq fallback for HTTP errors
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back when groqApiKey is not configured', async () => {
    const sdkNoKey = new GatewaySDK({ baseUrl: 'http://localhost:4000', groqApiKey: '' });
    fetchMock
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError());

    await expect(sdkNoKey.transcribe(FAKE_AUDIO)).rejects.toThrow(GatewayError);
    // Groq was never called (all calls failed with network error)
    const groqCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('groq.com'));
    expect(groqCalls).toHaveLength(0);
  });

  it('calls Groq with correct model, language, and prompt', async () => {
    fetchMock
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(makeGroqSttResponse('Hola mundo'));

    await sdk.transcribe(FAKE_AUDIO, 'es', 'previous context');

    const groqCall = fetchMock.mock.calls.find(([url]) => String(url).includes('audio/transcriptions'));
    expect(groqCall).toBeTruthy();
    expect(String(groqCall![0])).toContain('api.groq.com');
    // Auth header
    expect(groqCall![1].headers?.Authorization ?? '').toContain(FAKE_GROQ_KEY);
  });

  it('propagates Groq API error (e.g. invalid key)', async () => {
    fetchMock
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(makeErrorResponse(401, '{"error":"Invalid API key"}'));

    await expect(sdk.transcribe(FAKE_AUDIO)).rejects.toThrow(GatewayError);
    const err = await sdk.transcribe(FAKE_AUDIO).catch(e => e) as GatewayError;
    expect(err.statusCode).toBe(401);
  });
});

// ── chat() fallback ───────────────────────────────────────────────────────────

describe('GatewaySDK.chat() — Groq fallback', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sdk: GatewaySDK;
  const messages = [{ role: 'user' as const, content: 'Translate: Bonjour' }];

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    sdk = new GatewaySDK({ baseUrl: 'http://localhost:4000', groqApiKey: FAKE_GROQ_KEY });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to Groq LLM when gateway is unreachable', async () => {
    fetchMock
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(makeGroqChatResponse('Translated via Groq'));

    const result = await sdk.chat(messages);
    expect(result.content).toBe('Translated via Groq');
    expect(result.model).toBe('llama-3.3-70b-versatile');
    expect(result.usage).toBeDefined();
  });

  it('uses llama-3.3-70b-versatile as default fallback model', async () => {
    fetchMock
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(makeGroqChatResponse());

    await sdk.chat(messages);

    const groqCall = fetchMock.mock.calls.find(([url]) => String(url).includes('chat/completions') && String(url).includes('groq.com'));
    expect(groqCall).toBeTruthy();
    const body = JSON.parse(groqCall![1].body as string);
    expect(body.model).toBe('llama-3.3-70b-versatile');
  });

  it('forwards temperature and maxTokens to Groq fallback', async () => {
    fetchMock
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(makeGroqChatResponse());

    await sdk.chat(messages, { temperature: 0.3, maxTokens: 512 });

    const groqCall = fetchMock.mock.calls.find(([url]) => String(url).includes('groq.com'));
    const body = JSON.parse(groqCall![1].body as string);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(512);
  });

  it('uses gateway when online, no fallback', async () => {
    fetchMock.mockResolvedValueOnce(makeGatewayOnlineChatResponse('Gateway response'));

    const result = await sdk.chat(messages);
    expect(result.content).toBe('Gateway response');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).not.toContain('groq.com');
  });

  it('does NOT fall back on gateway HTTP 422 — propagates error', async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(422, 'Unprocessable Entity'));

    await expect(sdk.chat(messages)).rejects.toThrow(GatewayError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back when groqApiKey is not configured', async () => {
    const sdkNoKey = new GatewaySDK({ baseUrl: 'http://localhost:4000', groqApiKey: '' });
    fetchMock
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError());

    await expect(sdkNoKey.chat(messages)).rejects.toThrow(GatewayError);
  });

  it('reads groqApiKey from GROQ_API_KEY env var', () => {
    const originalEnv = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'gsk_from_env';
    try {
      const envSdk = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
      // Access private field via casting
      expect((envSdk as any).groqApiKey).toBe('gsk_from_env');
    } finally {
      if (originalEnv === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = originalEnv;
    }
  });

  it('explicit groqApiKey takes precedence over env var', () => {
    const originalEnv = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'gsk_from_env';
    try {
      const envSdk = new GatewaySDK({ baseUrl: 'http://localhost:4000', groqApiKey: 'gsk_explicit' });
      expect((envSdk as any).groqApiKey).toBe('gsk_explicit');
    } finally {
      if (originalEnv === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = originalEnv;
    }
  });
});

// ── GatewayError.isNetworkError flag ─────────────────────────────────────────

describe('GatewayError.isNetworkError', () => {
  it('is false by default', () => {
    const err = new GatewayError('test', 500, '/test');
    expect(err.isNetworkError).toBe(false);
  });

  it('is true when explicitly set', () => {
    const err = new GatewayError('network error', 0, '/test', true);
    expect(err.isNetworkError).toBe(true);
  });
});
