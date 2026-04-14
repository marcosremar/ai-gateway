/**
 * Tests for GatewayHttpClient — circuit breaker, retry, request ID, all endpoints.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GatewayHttpClient,
  GatewayHttpError,
  CircuitBreaker,
  CircuitOpenError,
} from '../../sdk/node';

// ── Mock fetch ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function makeClient(overrides?: Partial<ConstructorParameters<typeof GatewayHttpClient>[0]>) {
  return new GatewayHttpClient({
    baseUrl: 'http://gw.test:4000',
    groqApiKey: '', // disable Groq fallback so only gateway retries are counted
    retry: { maxRetries: 1, backoffMs: [10] },
    circuitBreaker: { failureThreshold: 3, recoveryTimeoutMs: 50, successThreshold: 2 },
    ...overrides,
  });
}

// ── Health ───────────────────────────────────────────────────────────────────

describe('health()', () => {
  it('returns healthy status with components', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      status: 'ok',
      uptime_sec: 123,
      components: {
        stt: { status: 'ok', provider: 'groq' },
        llm: { status: 'ok', provider: 'groq' },
      },
    }));
    const gw = makeClient();
    const h = await gw.health();
    expect(h.isHealthy).toBe(true);
    expect(h.status).toBe('ok');
    expect(h.uptimeSec).toBe(123);
    expect(h.components.stt.provider).toBe('groq');
  });

  it('returns unhealthy on fetch failure', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));
    const gw = makeClient();
    const h = await gw.health();
    expect(h.isHealthy).toBe(false);
    expect(h.status).toBe('error');
  });

  it('returns unhealthy on 500', async () => {
    mockFetch.mockResolvedValueOnce(new Response('err', { status: 500 }));
    const gw = makeClient();
    const h = await gw.health();
    expect(h.isHealthy).toBe(false);
  });
});

// ── Transcribe ──────────────────────────────────────────────────────────────

describe('transcribe()', () => {
  it('returns transcription result', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'Bonjour', used_gpu: true }));
    const gw = makeClient();
    const r = await gw.transcribe(new Uint8Array(100), 'fr');
    expect(r.text).toBe('Bonjour');
    expect(r.usedGpu).toBe(true);
  });

  it('throws GatewayHttpError on 400', async () => {
    mockFetch.mockResolvedValueOnce(new Response('No audio data', { status: 400 }));
    const gw = makeClient();
    await expect(gw.transcribe(new Uint8Array(0))).rejects.toThrow(GatewayHttpError);
  });

  it('throws on network error after retries', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));
    const gw = makeClient();
    await expect(gw.transcribe(new Uint8Array(100))).rejects.toThrow(TypeError);
    expect(mockFetch).toHaveBeenCalledTimes(2); // 1 + 1 retry
  });
});

// ── Translate ───────────────────────────────────────────────────────────────

describe('translate()', () => {
  it('returns translation result', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      translated_text: 'Hello', used_gpu: false,
    }));
    const gw = makeClient();
    const r = await gw.translate('Bonjour');
    expect(r.translatedText).toBe('Hello');
    expect(r.usedGpu).toBe(false);
  });

  it('throws GatewayHttpError on 500', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Internal error', { status: 500 }));
    const gw = makeClient();
    await expect(gw.translate('Bonjour')).rejects.toThrow(GatewayHttpError);
  });
});

// ── Pipeline ────────────────────────────────────────────────────────────────

describe('pipeline()', () => {
  it('returns full pipeline result with timing', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      transcription: 'Bonjour',
      response: 'Hello',
      audio_base64: 'AAAA',
      content_type: 'audio/wav',
      timing: { total_ms: 500, stt_ms: 100, llm_ms: 200, tts_ms: 200, used_gpu: true },
    }));
    const gw = makeClient();
    const r = await gw.pipeline(new Uint8Array(100), { source: 'fr', target: 'en' });
    expect(r.transcription).toBe('Bonjour');
    expect(r.response).toBe('Hello');
    expect(r.timing.totalMs).toBe(500);
    expect(r.timing.usedGpu).toBe(true);
  });
});

// ── GPU Management ──────────────────────────────────────────────────────────

describe('GPU management', () => {
  it('deployGpu sends correct body', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'creating' }));
    const gw = makeClient();
    const r = await gw.deployGpu({ apiKey: 'rp_test' });
    expect(r.status).toBe('creating');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.apiKey).toBe('rp_test');
  });

  it('gpuStatus returns GpuStatus', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      status: 'ready', podId: 'abc', endpoint: 'http://pod:8000',
      gpuType: 'RTX 4090', gpuHealthy: true, activeTier: 'gpu',
    }));
    const gw = makeClient();
    const s = await gw.gpuStatus();
    expect(s.status).toBe('ready');
    expect(s.gpuType).toBe('RTX 4090');
    expect(s.gpuHealthy).toBe(true);
  });

  it('terminateGpu', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const gw = makeClient();
    const r = await gw.terminateGpu('rp_test');
    expect(r.ok).toBe(true);
  });
});

// ── Metrics ─────────────────────────────────────────────────────────────────

describe('metrics()', () => {
  it('returns parsed metrics', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      requestsTotal: 100, requestsByStage: { stt: 50 },
      requestsByProvider: { groq: 80 }, errorsTotal: 5,
      latencyP50Ms: 200, latencyP95Ms: 800, latencyP99Ms: 1500,
      gpuStatus: 'ready', uptimeSec: 3600,
    }));
    const gw = makeClient();
    const m = await gw.metrics();
    expect(m.requestsTotal).toBe(100);
    expect(m.errorsTotal).toBe(5);
    expect(m.latencyP95Ms).toBe(800);
  });
});

// ── Circuit Breaker (unit) ──────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  it('opens after failureThreshold consecutive failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 1000, successThreshold: 2 });
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    expect(() => cb.allowRequest()).toThrow(CircuitOpenError);
  });

  it('transitions to half_open after recovery timeout', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 30, successThreshold: 2 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    await new Promise(r => setTimeout(r, 40));
    expect(cb.getState()).toBe('half_open');
    cb.allowRequest(); // should not throw
  });

  it('closes after successThreshold in half_open', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 30, successThreshold: 2 });
    cb.recordFailure();
    cb.recordFailure();
    await new Promise(r => setTimeout(r, 40));
    expect(cb.getState()).toBe('half_open');
    cb.recordSuccess();
    expect(cb.getState()).toBe('half_open'); // need 2
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('re-opens on failure in half_open', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 30, successThreshold: 2 });
    cb.recordFailure();
    cb.recordFailure();
    await new Promise(r => setTimeout(r, 40));
    expect(cb.getState()).toBe('half_open');
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  it('resets to closed', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 10000, successThreshold: 1 });
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    cb.reset();
    expect(cb.getState()).toBe('closed');
  });
});

// ── Circuit Breaker (integrated) ────────────────────────────────────────────

describe('Circuit breaker integration', () => {
  it('blocks requests after consecutive HTTP failures', async () => {
    const gw = makeClient();
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce(new Response('fail', { status: 500 }));
      await expect(gw.transcribe(new Uint8Array(1))).rejects.toThrow(GatewayHttpError);
    }
    expect(gw.getCircuitBreaker().getState()).toBe('open');
    await expect(gw.transcribe(new Uint8Array(1))).rejects.toThrow(CircuitOpenError);
  });
});

// ── Retry ────────────────────────────────────────────────────────────────────

describe('Retry', () => {
  it('retries on connection error then succeeds', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ text: 'ok', used_gpu: false }));
    const gw = makeClient();
    const r = await gw.transcribe(new Uint8Array(100));
    expect(r.text).toBe('ok');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on HTTP errors', async () => {
    mockFetch.mockResolvedValueOnce(new Response('bad', { status: 400 }));
    const gw = makeClient();
    await expect(gw.transcribe(new Uint8Array(1))).rejects.toThrow(GatewayHttpError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── Request ID ──────────────────────────────────────────────────────────────

describe('Request ID', () => {
  it('sends X-Request-ID header', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'ok', used_gpu: false }));
    const gw = makeClient();
    await gw.transcribe(new Uint8Array(100));
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['X-Request-ID']).toBeDefined();
    expect(headers['X-Request-ID'].length).toBeGreaterThan(0);
  });

  it('generates unique request IDs per call', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ text: 'a', used_gpu: false }))
      .mockResolvedValueOnce(jsonResponse({ text: 'b', used_gpu: false }));
    const gw = makeClient();
    await gw.transcribe(new Uint8Array(10));
    await gw.transcribe(new Uint8Array(10));
    const id1 = mockFetch.mock.calls[0][1].headers['X-Request-ID'];
    const id2 = mockFetch.mock.calls[1][1].headers['X-Request-ID'];
    expect(id1).not.toBe(id2);
  });
});

// ── Close ───────────────────────────────────────────────────────────────────

describe('close()', () => {
  it('rejects requests after close', async () => {
    const gw = makeClient();
    await gw.close();
    await expect(gw.transcribe(new Uint8Array(1))).rejects.toThrow('Client is closed');
  });
});
