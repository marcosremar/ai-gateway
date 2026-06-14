/**
 * Optimization suite 09 — CLI / SDK / DX — WAVE 5.
 *
 * Fifth (final-pool) batch of localized, low-risk fixes from
 * docs/optimizations/09-cli-sdk-dx.md NOT covered by waves 1-4. The safe pool is
 * nearly exhausted; this wave lands a small focused set, all backed by pure
 * helpers in `cli/cli-helpers.ts` and `src/sdk/client.ts` so they unit-test
 * without importing `bin/ai-gateway.ts` (which runs `main()` at module load).
 *
 *   SDK (src/sdk/client.ts + types.ts):
 *     - #839  gate direct-Groq fallback behind an explicit opt-in
 *             (shouldFallbackToGroq + GatewayConfig.fallbackToGroq)
 *
 *   CLI helpers (cli/cli-helpers.ts):
 *     - #812  surface the auto-start-server behaviour      (autoStartNote)
 *     - #853  dry-run / estimate-only `gpu deploy`         (parseDeployDryRun,
 *                                                           describeDeployDryRun)
 *     - #814  use the dedicated /v1/detect-language path   (buildDetectLanguageRequest,
 *                                                           parseDetectLanguageResponse)
 *
 * Unit-only — no network. `fetch` is mocked for the live SDK behaviour tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  autoStartNote,
  parseDeployDryRun,
  describeDeployDryRun,
  DEPLOY_DRY_RUN_FLAGS,
  buildDetectLanguageRequest,
  parseDetectLanguageResponse,
} from '../../cli/cli-helpers';
import {
  GatewaySDK,
  shouldFallbackToGroq,
} from '../../src/sdk/client';
import { GatewayError } from '../../src/sdk/types';

// ════════════════════════════════════════════════════════════════════════════
// CLI helpers (pure)
// ════════════════════════════════════════════════════════════════════════════

// ── #812: auto-start note ─────────────────────────────────────────────────────

describe('autoStartNote (#812)', () => {
  it('states the port, the trigger, and the escape hatch', () => {
    const note = autoStartNote(4000);
    expect(note).toContain('4000');
    expect(note.toLowerCase()).toContain('auto-start');
    expect(note).toContain('AI_GATEWAY_URL');       // how to use a remote gateway
    expect(note).toContain('ai-gateway server stop'); // how to stop it
  });
  it('accepts a string port', () => {
    expect(autoStartNote('8080')).toContain('8080');
  });
});

// ── #853: dry-run / estimate-only deploy ──────────────────────────────────────

describe('parseDeployDryRun (#853)', () => {
  it('matches each estimate-only flag', () => {
    for (const flag of DEPLOY_DRY_RUN_FLAGS) {
      const r = parseDeployDryRun(['deploy', flag]);
      expect(r.dryRun).toBe(true);
      expect(r.flag).toBe(flag);
    }
  });
  it('is false when no dry-run flag is present', () => {
    expect(parseDeployDryRun(['deploy', '--gpu', 'RTX 4090'])).toEqual({ dryRun: false });
  });
});

describe('describeDeployDryRun (#853)', () => {
  it('formats a full estimate without provisioning', () => {
    const s = describeDeployDryRun({ gpuType: 'RTX 4090', provider: 'runpod', pricePerHrUsd: 0.4 });
    expect(s).toContain('Dry run');
    expect(s).toContain('no GPU provisioned');
    expect(s).toContain('gpu=RTX 4090');
    expect(s).toContain('provider=runpod');
    expect(s).toContain('est=$0.40/hr');
  });
  it('falls back to est=unknown when price is missing/NaN', () => {
    expect(describeDeployDryRun({})).toContain('est=unknown');
    expect(describeDeployDryRun({ pricePerHrUsd: NaN })).toContain('est=unknown');
  });
});

// ── #814: dedicated detect-language endpoint ──────────────────────────────────

describe('buildDetectLanguageRequest (#814)', () => {
  it('targets the dedicated endpoint with a POST body', () => {
    const req = buildDetectLanguageRequest('bonjour');
    expect(req).toEqual({
      endpoint: '/v1/detect-language',
      method: 'POST',
      body: { text: 'bonjour' },
    });
  });
  it('coerces a missing text to an empty string', () => {
    expect(buildDetectLanguageRequest(undefined as unknown as string).body.text).toBe('');
  });
});

describe('parseDetectLanguageResponse (#814)', () => {
  it('reads the canonical {language,confidence} shape', () => {
    expect(parseDetectLanguageResponse({ language: 'fr', confidence: 0.98 })).toEqual({
      language: 'fr',
      confidence: 0.98,
    });
  });
  it('tolerates legacy chat-derived payloads', () => {
    expect(parseDetectLanguageResponse('  en  ')).toEqual({ language: 'en' });
    expect(parseDetectLanguageResponse({ detected_language: 'de' })).toEqual({ language: 'de' });
    expect(parseDetectLanguageResponse({ lang: 'es' })).toEqual({ language: 'es' });
  });
  it('returns unknown for garbage / missing language and drops bad confidence', () => {
    expect(parseDetectLanguageResponse(null)).toEqual({ language: 'unknown' });
    expect(parseDetectLanguageResponse({})).toEqual({ language: 'unknown' });
    expect(parseDetectLanguageResponse({ language: 'it', confidence: 'high' })).toEqual({ language: 'it' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SDK pure helper — #839 fallback gating
// ════════════════════════════════════════════════════════════════════════════

describe('shouldFallbackToGroq (#839)', () => {
  const netErr = new GatewayError('down', 0, '/v1/x', true);
  it('falls back only when opted-in AND a key is present AND it is a network error', () => {
    expect(shouldFallbackToGroq({ enabled: true, hasGroqKey: true, err: netErr })).toBe(true);
  });
  it('does NOT fall back when not opted in (default)', () => {
    expect(shouldFallbackToGroq({ enabled: false, hasGroqKey: true, err: netErr })).toBe(false);
  });
  it('does NOT fall back without a Groq key', () => {
    expect(shouldFallbackToGroq({ enabled: true, hasGroqKey: false, err: netErr })).toBe(false);
  });
  it('does NOT fall back for a real HTTP error (5xx is an answer, not an outage)', () => {
    const httpErr = new GatewayError('boom', 503, '/v1/x', false);
    expect(shouldFallbackToGroq({ enabled: true, hasGroqKey: true, err: httpErr })).toBe(false);
  });
  it('does NOT fall back for a non-GatewayError', () => {
    expect(shouldFallbackToGroq({ enabled: true, hasGroqKey: true, err: new Error('x') })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SDK live behaviour (mocked fetch) — #839
// ════════════════════════════════════════════════════════════════════════════

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GatewaySDK Groq-fallback gating (#839, mocked fetch)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws (no Groq call) when the gateway is unreachable and fallback is OFF', async () => {
    // Network failure → TypeError → SDK wraps as isNetworkError GatewayError.
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const gw = new GatewaySDK({
      baseUrl: 'http://localhost:4000',
      groqApiKey: 'gsk_test', // key present, but fallback NOT opted in
      maxRetries: 0,
    });
    await expect(gw.chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(GatewayError);
    // Only the gateway was hit; Groq was never called.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('localhost:4000');
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('groq.com'))).toBe(false);
  });

  it('calls Groq directly when the gateway is unreachable and fallback is opted IN', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('groq.com')) {
        return Promise.resolve(jsonResponse({ choices: [{ message: { content: 'groq reply' } }] }));
      }
      return Promise.reject(new TypeError('fetch failed')); // gateway down
    });
    const gw = new GatewaySDK({
      baseUrl: 'http://localhost:4000',
      groqApiKey: 'gsk_test',
      fallbackToGroq: true,
      maxRetries: 0,
    });
    const r = await gw.chat([{ role: 'user', content: 'hi' }]);
    expect(r.content).toBe('groq reply');
    // Gateway attempted first, then Groq fallback.
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('groq.com'))).toBe(true);
  });

  it('a real 5xx from the gateway is surfaced (never silently routed to Groq) even when opted in', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'boom' } }, 503));
    const gw = new GatewaySDK({
      baseUrl: 'http://localhost:4000',
      groqApiKey: 'gsk_test',
      fallbackToGroq: true,
      maxRetries: 0,
    });
    await expect(gw.chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(GatewayError);
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('groq.com'))).toBe(false);
  });
});
