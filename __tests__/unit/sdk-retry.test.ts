/**
 * Advanced retry & reconnection tests for both SDK clients:
 * - GatewaySDK (src/sdk/client.ts) — the "thin" TS SDK
 * - GatewayHttpClient (sdk/node/index.ts) — the Node SDK with circuit breaker
 *
 * Covers: retry exhaustion, backoff timing, error classification,
 * gateway restart simulation, concurrent retries, per-method coverage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── TS SDK (src/sdk/client.ts) ──────────────────────────────────────────────
import { GatewaySDK } from '../../src/sdk/client';
import { GatewayError } from '../../src/sdk/types';

// ── Node SDK (sdk/node/index.ts) ────────────────────────────────────────────
import { GatewayHttpClient, GatewayHttpError, CircuitOpenError } from '../sdk/node';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  // Speed up tests: replace setTimeout-based delays with immediate resolution
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

// ═══════════════════════════════════════════════════════════════════════════════
// TS SDK — GatewaySDK retry tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('GatewaySDK (TS SDK) — Retry', () => {
  function makeSdk() {
    return new GatewaySDK({ baseUrl: 'http://gw.test:4000', groqApiKey: '' });
  }

  // ── Retry exhaustion ───────────────────────────────────────────────────

  describe('retry exhaustion', () => {
    it('retries 4 times on network error then throws', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));
      const sdk = makeSdk();
      await expect(sdk.transcribe(new Uint8Array(100))).rejects.toThrow(GatewayError);
      expect(mockFetch).toHaveBeenCalledTimes(5); // 1 initial + 4 retries
    });

    it('retries on translate then throws', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));
      const sdk = makeSdk();
      await expect(sdk.translate('Bonjour', 'fr', 'en')).rejects.toThrow(GatewayError);
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it('retries on pipeline then throws', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));
      const sdk = makeSdk();
      await expect(sdk.pipeline(new Uint8Array(100))).rejects.toThrow(GatewayError);
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it('retries on deployGpu then throws', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));
      const sdk = makeSdk();
      await expect(sdk.deployGpu({ apiKey: 'test' })).rejects.toThrow(GatewayError);
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it('retries on gpuStatus then throws', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));
      const sdk = makeSdk();
      await expect(sdk.gpuStatus()).rejects.toThrow(GatewayError);
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it('retries on generateAudio then throws', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));
      const sdk = makeSdk();
      await expect(sdk.generateAudio('hello')).rejects.toThrow(GatewayError);
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it('retries on listVoices then throws', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));
      const sdk = makeSdk();
      await expect(sdk.listVoices()).rejects.toThrow(GatewayError);
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });
  });

  // ── Successful retry on Nth attempt ────────────────────────────────────

  describe('successful retry', () => {
    it('succeeds on 2nd attempt after 1 failure', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse({ text: 'ok', used_gpu: false }));
      const sdk = makeSdk();
      const r = await sdk.transcribe(new Uint8Array(100));
      expect(r.text).toBe('ok');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('succeeds on 4th attempt after 3 failures', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse({ translated_text: 'Hello', used_gpu: false }));
      const sdk = makeSdk();
      const r = await sdk.translate('Bonjour', 'fr', 'en');
      expect(r.translatedText).toBe('Hello');
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('succeeds on 5th (last) attempt', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse({
          transcription: 'ok', response: 'ok',
          audio_base64: '', content_type: 'audio/wav',
          timing: { total_ms: 100, used_gpu: false },
        }));
      const sdk = makeSdk();
      const r = await sdk.pipeline(new Uint8Array(100));
      expect(r.transcription).toBe('ok');
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });
  });

  // ── Error classification ───────────────────────────────────────────────

  describe('error classification', () => {
    it('retries TypeError (ECONNREFUSED)', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse({ text: 'ok', used_gpu: false }));
      const sdk = makeSdk();
      const r = await sdk.transcribe(new Uint8Array(100));
      expect(r.text).toBe('ok');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries ECONNRESET error', async () => {
      const err = new Error('read ECONNRESET');
      mockFetch
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(jsonResponse({ text: 'ok', used_gpu: false }));
      const sdk = makeSdk();
      const r = await sdk.transcribe(new Uint8Array(100));
      expect(r.text).toBe('ok');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry HTTP 400', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Bad request', { status: 400 }));
      const sdk = makeSdk();
      await expect(sdk.transcribe(new Uint8Array(1))).rejects.toThrow(GatewayError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry HTTP 500', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Internal error', { status: 500 }));
      const sdk = makeSdk();
      await expect(sdk.translate('test', 'fr', 'en')).rejects.toThrow(GatewayError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry AbortError (timeout)', async () => {
      const err = new DOMException('signal timed out', 'AbortError');
      mockFetch.mockRejectedValueOnce(err);
      const sdk = makeSdk();
      await expect(sdk.transcribe(new Uint8Array(100))).rejects.toThrow(GatewayError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('timeout error includes path and timeout value', async () => {
      const err = new DOMException('signal timed out', 'AbortError');
      mockFetch.mockRejectedValueOnce(err);
      const sdk = makeSdk();
      try {
        await sdk.transcribe(new Uint8Array(100));
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(GatewayError);
        expect((e as GatewayError).message).toContain('timed out');
        expect((e as GatewayError).message).toContain('/v1/transcribe');
      }
    });
  });

  // ── Gateway restart simulation ─────────────────────────────────────────

  describe('gateway restart', () => {
    it('reconnects after gateway comes back', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))   // gateway down
        .mockRejectedValueOnce(new TypeError('fetch failed'))   // still down
        .mockResolvedValueOnce(jsonResponse({                   // back!
          status: 'ready', podId: 'abc', endpoint: 'http://pod:8000',
          gpuType: 'RTX 4090', gpuHealthy: true, activeTier: 'gpu',
        }));
      const sdk = makeSdk();
      const s = await sdk.gpuStatus();
      expect(s.status).toBe('ready');
      expect(s.gpuType).toBe('RTX 4090');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('reconnects mid-deploy', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse({ status: 'creating', message: 'Deploy started' }, 202));
      const sdk = makeSdk();
      const r = await sdk.deployGpu({ apiKey: 'rp_test' });
      expect(r.status).toBe('creating');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('empty translate returns early without request', async () => {
      const sdk = makeSdk();
      const r = await sdk.translate('', 'fr', 'en');
      expect(r.translatedText).toBe('');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('health() returns false after retry exhaustion (never throws)', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));
      const sdk = makeSdk();
      const ok = await sdk.health();
      expect(ok).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(5); // retried before giving up
    });

    it('mixed error types across attempts all get retried', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(jsonResponse({ text: 'survived', used_gpu: false }));
      const sdk = makeSdk();
      const r = await sdk.transcribe(new Uint8Array(100));
      expect(r.text).toBe('survived');
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('deploy 409 is not retried (allowed status)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(
        { status: 'creating', message: 'Deploy already in progress' },
        409,
      ));
      const sdk = makeSdk();
      const r = await sdk.deployGpu({ apiKey: 'test' });
      expect(r.status).toBe('creating');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Node SDK — GatewayHttpClient retry tests (with increased retry count)
// ═══════════════════════════════════════════════════════════════════════════════

describe('GatewayHttpClient (Node SDK) — Advanced Retry', () => {
  function makeNodeClient(overrides?: Partial<ConstructorParameters<typeof GatewayHttpClient>[0]>) {
    return new GatewayHttpClient({
      baseUrl: 'http://gw.test:4000',
      groqApiKey: '', // disable Groq fallback so only gateway retries are counted
      retry: { maxRetries: 4, backoffMs: [10, 20, 30, 40] },
      circuitBreaker: { failureThreshold: 10, recoveryTimeoutMs: 50, successThreshold: 2 },
      ...overrides,
    });
  }

  // ── Retry count = 4 ────────────────────────────────────────────────────

  describe('retry count = 4', () => {
    it('retries up to 4 times (5 total attempts)', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));
      const gw = makeNodeClient();
      await expect(gw.transcribe(new Uint8Array(100))).rejects.toThrow(TypeError);
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it('succeeds on 5th attempt', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse({ text: 'ok', used_gpu: false }));
      const gw = makeNodeClient();
      const r = await gw.transcribe(new Uint8Array(100));
      expect(r.text).toBe('ok');
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it('uses custom backoff delays', async () => {
      const delays: number[] = [];
      const origSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any, ms?: number) => {
        if (ms && ms > 0) delays.push(ms);
        return origSetTimeout(fn, 0); // run immediately
      });

      mockFetch.mockRejectedValue(new TypeError('fetch failed'));
      const gw = makeNodeClient({ retry: { maxRetries: 3, backoffMs: [100, 200, 300] } });
      await expect(gw.transcribe(new Uint8Array(1))).rejects.toThrow();

      // Should have scheduled 3 delays matching backoffMs
      expect(delays).toEqual(expect.arrayContaining([100, 200, 300]));
      vi.restoreAllMocks();
    });
  });

  // ── Error classification ───────────────────────────────────────────────

  describe('error classification', () => {
    it('retries TypeError', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse({ text: 'ok', used_gpu: false }));
      const gw = makeNodeClient();
      const r = await gw.transcribe(new Uint8Array(100));
      expect(r.text).toBe('ok');
    });

    it('retries ECONNREFUSED', async () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:4000');
      mockFetch
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(jsonResponse({ text: 'ok', used_gpu: false }));
      const gw = makeNodeClient();
      const r = await gw.transcribe(new Uint8Array(100));
      expect(r.text).toBe('ok');
    });

    it('retries ECONNRESET', async () => {
      const err = new Error('read ECONNRESET');
      mockFetch
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(jsonResponse({ translated_text: 'ok', used_gpu: false }));
      const gw = makeNodeClient();
      const r = await gw.translate('test');
      expect(r.translatedText).toBe('ok');
    });

    it('does NOT retry HTTP 400', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Bad', { status: 400 }));
      const gw = makeNodeClient();
      await expect(gw.transcribe(new Uint8Array(1))).rejects.toThrow(GatewayHttpError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry HTTP 500', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Error', { status: 500 }));
      const gw = makeNodeClient();
      await expect(gw.translate('test')).rejects.toThrow(GatewayHttpError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry AbortError (timeout)', async () => {
      const err = new DOMException('signal timed out', 'AbortError');
      mockFetch.mockRejectedValueOnce(err);
      const gw = makeNodeClient();
      await expect(gw.transcribe(new Uint8Array(1))).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // ── Gateway restart simulation ─────────────────────────────────────────

  describe('gateway restart', () => {
    it('survives gateway restart — reconnects after 3 failures', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse({
          status: 'ready', podId: 'abc', endpoint: 'http://pod:8000',
          gpuType: 'RTX A6000', gpuHealthy: true, activeTier: 'gpu',
        }));
      const gw = makeNodeClient();
      const s = await gw.gpuStatus();
      expect(s.status).toBe('ready');
      expect(s.gpuType).toBe('RTX A6000');
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('pipeline survives gateway restart', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse({
          transcription: 'Bonjour', response: 'Hello',
          audio_base64: 'AAA', content_type: 'audio/wav',
          timing: { total_ms: 500, stt_ms: 100, llm_ms: 200, tts_ms: 200, used_gpu: true },
        }));
      const gw = makeNodeClient();
      const r = await gw.pipeline(new Uint8Array(100), { source: 'fr', target: 'en' });
      expect(r.transcription).toBe('Bonjour');
      expect(r.timing.usedGpu).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ── Circuit breaker + retry interaction ────────────────────────────────

  describe('circuit breaker + retry interaction', () => {
    it('retry failures do NOT count as circuit breaker failures (only final failure does)', async () => {
      // 2 connection failures + success = circuit breaker should see 1 success, not 2 failures
      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse({ text: 'ok', used_gpu: false }));
      const gw = makeNodeClient();
      await gw.transcribe(new Uint8Array(100));
      // Circuit breaker should be closed (success was recorded)
      expect(gw.getCircuitBreaker().getState()).toBe('closed');
    });

    it('circuit breaker opens after retry-exhausted failures', async () => {
      const gw = makeNodeClient({
        retry: { maxRetries: 0, backoffMs: [] }, // disable retries to speed up
        circuitBreaker: { failureThreshold: 3, recoveryTimeoutMs: 50, successThreshold: 2 },
      });

      for (let i = 0; i < 3; i++) {
        mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
        try { await gw.transcribe(new Uint8Array(1)); } catch {}
      }
      expect(gw.getCircuitBreaker().getState()).toBe('open');
      await expect(gw.transcribe(new Uint8Array(1))).rejects.toThrow(CircuitOpenError);
    });

    it('health() returns unhealthy when circuit is open', async () => {
      const gw = makeNodeClient({
        retry: { maxRetries: 0, backoffMs: [] },
        circuitBreaker: { failureThreshold: 2, recoveryTimeoutMs: 100_000, successThreshold: 1 },
      });
      // Trip the circuit with HTTP 500s (not connection errors)
      for (let i = 0; i < 2; i++) {
        mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));
        try { await gw.transcribe(new Uint8Array(1)); } catch {}
      }
      expect(gw.getCircuitBreaker().getState()).toBe('open');
      // health() catches CircuitOpenError and returns unhealthy
      const h = await gw.health();
      expect(h.isHealthy).toBe(false);
    });
  });

  // ── Per-endpoint coverage ──────────────────────────────────────────────

  describe('all endpoints retry', () => {
    const endpoints = [
      { name: 'transcribe', call: (gw: GatewayHttpClient) => gw.transcribe(new Uint8Array(100)) },
      { name: 'translate', call: (gw: GatewayHttpClient) => gw.translate('test') },
      { name: 'pipeline', call: (gw: GatewayHttpClient) => gw.pipeline(new Uint8Array(100)) },
      { name: 'gpuStatus', call: (gw: GatewayHttpClient) => gw.gpuStatus() },
      { name: 'deployGpu', call: (gw: GatewayHttpClient) => gw.deployGpu({ apiKey: 'test' }) },
      { name: 'terminateGpu', call: (gw: GatewayHttpClient) => gw.terminateGpu('test') },
      { name: 'metrics', call: (gw: GatewayHttpClient) => gw.metrics() },
      { name: 'health', call: (gw: GatewayHttpClient) => gw.health() },
    ];

    for (const { name, call } of endpoints) {
      it(`${name}() retries on connection error`, async () => {
        mockFetch
          .mockRejectedValueOnce(new TypeError('fetch failed'))
          .mockResolvedValueOnce(jsonResponse(
            // Return a valid response shape for each endpoint
            name === 'health' ? { status: 'ok', uptime_sec: 0, components: {} } :
            name === 'transcribe' ? { text: 'ok', used_gpu: false } :
            name === 'translate' ? { translated_text: 'ok', used_gpu: false } :
            name === 'pipeline' ? { transcription: '', response: '', audio_base64: '', content_type: '', timing: {} } :
            name === 'gpuStatus' ? { status: 'idle' } :
            name === 'deployGpu' ? { status: 'creating' } :
            name === 'metrics' ? { requestsTotal: 0 } :
            { ok: true },
          ));
        const gw = makeNodeClient();
        await call(gw);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });
    }
  });

  // ── Concurrent retries ─────────────────────────────────────────────────

  describe('concurrent retries', () => {
    it('multiple requests retry independently', async () => {
      let transcribeCount = 0;
      let translateCount = 0;

      mockFetch.mockImplementation(async (url: string, opts: any) => {
        const path = new URL(url).pathname;
        if (path === '/v1/transcribe') {
          transcribeCount++;
          if (transcribeCount <= 2) throw new TypeError('fetch failed');
          return jsonResponse({ text: 'ok', used_gpu: false });
        }
        if (path === '/v1/translate') {
          translateCount++;
          if (translateCount <= 1) throw new TypeError('fetch failed');
          return jsonResponse({ translated_text: 'ok', used_gpu: false });
        }
        throw new Error(`unexpected: ${path}`);
      });

      const gw = makeNodeClient();
      const [t, tr] = await Promise.all([
        gw.transcribe(new Uint8Array(100)),
        gw.translate('test'),
      ]);
      expect(t.text).toBe('ok');
      expect(tr.translatedText).toBe('ok');
      expect(transcribeCount).toBe(3);  // 2 failures + 1 success
      expect(translateCount).toBe(2);   // 1 failure + 1 success
    });
  });

  // ── Close ──────────────────────────────────────────────────────────────

  describe('close + retry interaction', () => {
    it('closed client rejects immediately without retrying', async () => {
      const gw = makeNodeClient();
      await gw.close();
      await expect(gw.transcribe(new Uint8Array(1))).rejects.toThrow('Client is closed');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
