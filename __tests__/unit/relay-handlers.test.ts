/**
 * Unit tests for server/relay-handlers.ts.
 *
 * Covers:
 *   handleRelayStatus    — inactive state, active state, uptime calculation
 *   handleStreamStatus   — inactive, STREAM_HLS_URL env override, STREAM_DOMAIN env
 *   handleRelayStart     — already active (early return), successful start,
 *                          SCALEWAY_SECRET_KEY missing, scwAction HTTP error,
 *                          polling timeout (server never reaches 'running')
 *   handleRelayStop      — already stopped (early return), successful stop,
 *                          SCALEWAY_SECRET_KEY missing, scwAction HTTP error
 *
 * All external fetch calls are mocked.  Module-level relay state is reset per
 * test via vi.resetModules() so every test starts with relayState.active=false.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Logger mock (hoisted — applies to all module loads in this file) ─────────

vi.mock('../../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal ServerResponse stand-in that captures writeHead + end calls. */
function makeRes() {
  let statusCode = 0;
  let rawBody = '';
  const res = {
    writeHead: vi.fn((code: number) => { statusCode = code; }),
    end: vi.fn((data: string) => { rawBody = data; }),
    get statusCode() { return statusCode; },
    get body() { return rawBody; },
    get json() { return JSON.parse(rawBody); },
  } as unknown as ServerResponse & { statusCode: number; body: string; json: Record<string, unknown> };
  return res;
}

const fakReq = {} as IncomingMessage;

function mockJsonFetch(payload: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  });
}

function mockErrorFetch(status: number) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => 'Bad request',
    json: async () => ({}),
  });
}

// ── Per-test reset: fresh module + fresh fetch mock ───────────────────────────

let mod: typeof import('../../server/relay-handlers');
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  process.env.SCALEWAY_SECRET_KEY = 'scw-secret';
  process.env.SCALEWAY_INSTANCE_ID = 'inst-abc123';
  delete process.env.SCALEWAY_ZONE;
  delete process.env.STREAM_DOMAIN;
  delete process.env.STREAM_HLS_URL;

  vi.resetModules();
  // Default fetch: poweron OK, then server is 'running' with IP
  mockFetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' })   // poweron
    .mockResolvedValue({                                                          // get server
      ok: true, status: 200,
      text: async () => '{}',
      json: async () => ({ server: { state: 'running', public_ip: { address: '1.2.3.4' } } }),
    });
  vi.stubGlobal('fetch', mockFetch);

  mod = await import('../../server/relay-handlers');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.SCALEWAY_SECRET_KEY;
  delete process.env.SCALEWAY_INSTANCE_ID;
  delete process.env.SCALEWAY_ZONE;
  delete process.env.STREAM_DOMAIN;
  delete process.env.STREAM_HLS_URL;
});

// ── handleRelayStatus ─────────────────────────────────────────────────────────

describe('handleRelayStatus — inactive state', () => {
  it('returns 200 with active=false when relay has not started', async () => {
    const res = makeRes();
    await mod.handleRelayStatus(fakReq, res);
    expect(res.statusCode).toBe(200);
    expect(res.json.active).toBe(false);
    expect(res.json.ip).toBeNull();
    expect(res.json.hlsUrl).toBeNull();
    expect(res.json.uptimeSec).toBe(0);
  });
});

describe('handleRelayStatus — active state', () => {
  it('returns active=true, IP, hlsUrl, and non-zero uptimeSec after relay start', async () => {
    vi.useFakeTimers();

    // Start relay — handler polls with setTimeout(5000) before first server check
    const startPromise = mod.handleRelayStart(fakReq, makeRes());
    await vi.advanceTimersByTimeAsync(6_000);
    await startPromise;

    const res = makeRes();
    // Advance time a bit so uptimeSec > 0
    vi.advanceTimersByTime(1_000);
    await mod.handleRelayStatus(fakReq, res);

    expect(res.json.active).toBe(true);
    expect(res.json.ip).toBe('1.2.3.4');
    expect(typeof res.json.hlsUrl).toBe('string');
    expect(res.json.uptimeSec).toBeGreaterThan(0);
  });
});

// ── handleStreamStatus ────────────────────────────────────────────────────────

describe('handleStreamStatus', () => {
  it('returns active=false when relay is inactive and no env override', async () => {
    const res = makeRes();
    await mod.handleStreamStatus(fakReq, res);
    expect(res.statusCode).toBe(200);
    expect(res.json.active).toBe(false);
    expect(res.json.hlsUrl).toBeNull();
    expect(res.json.relayIp).toBeNull();
  });

  it('returns active=true and uses STREAM_HLS_URL env override when set', async () => {
    process.env.STREAM_HLS_URL = 'https://cdn.example.com/hls/live.m3u8';
    const res = makeRes();
    await mod.handleStreamStatus(fakReq, res);
    expect(res.json.active).toBe(true);
    expect(res.json.hlsUrl).toBe('https://cdn.example.com/hls/live.m3u8');
  });

  it('returns STREAM_HLS_URL regardless of relay IP when env is set', async () => {
    process.env.STREAM_HLS_URL = 'https://override.example.com/stream.m3u8';
    const res = makeRes();
    await mod.handleStreamStatus(fakReq, res);
    expect(res.json.hlsUrl).toBe('https://override.example.com/stream.m3u8');
    // relayIp is null since relay never started
    expect(res.json.relayIp).toBeNull();
  });
});

// ── handleRelayStart ──────────────────────────────────────────────────────────

describe('handleRelayStart — successful start', () => {
  it('returns 200 with active=true, ip, and hlsUrl after polling succeeds', async () => {
    vi.useFakeTimers();
    const res = makeRes();
    const startPromise = mod.handleRelayStart(fakReq, res);
    await vi.advanceTimersByTimeAsync(6_000); // advance past first poll timeout
    await startPromise;

    expect(res.statusCode).toBe(200);
    expect(res.json.active).toBe(true);
    expect(res.json.ip).toBe('1.2.3.4');
    expect(typeof res.json.hlsUrl).toBe('string');
  });

  it('calls poweron Scaleway action with correct auth header', async () => {
    vi.useFakeTimers();
    const res = makeRes();
    const startPromise = mod.handleRelayStart(fakReq, res);
    await vi.advanceTimersByTimeAsync(6_000);
    await startPromise;

    const poweronCall = mockFetch.mock.calls[0];
    expect(poweronCall[0]).toContain('/action');
    expect(poweronCall[1].headers?.['X-Auth-Token']).toBe('scw-secret');
    expect(poweronCall[1].method).toBe('POST');
    expect(JSON.parse(poweronCall[1].body).action).toBe('poweron');
  });

  it('uses SCALEWAY_ZONE env when set', async () => {
    process.env.SCALEWAY_ZONE = 'nl-ams-1';
    vi.resetModules();
    mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' })
      .mockResolvedValue({
        ok: true, status: 200, text: async () => '{}',
        json: async () => ({ server: { state: 'running', public_ip: { address: '2.3.4.5' } } }),
      });
    vi.stubGlobal('fetch', mockFetch);
    const freshMod = await import('../../server/relay-handlers');

    vi.useFakeTimers();
    const res = makeRes();
    const startPromise = freshMod.handleRelayStart(fakReq, res);
    await vi.advanceTimersByTimeAsync(6_000);
    await startPromise;

    expect(mockFetch.mock.calls[0][0]).toContain('nl-ams-1');
  });

  it('builds hlsUrl with STREAM_DOMAIN env when set', async () => {
    process.env.STREAM_DOMAIN = 'stream.example.com';
    vi.resetModules();
    mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' })
      .mockResolvedValue({
        ok: true, status: 200, text: async () => '{}',
        json: async () => ({ server: { state: 'running', public_ip: { address: '9.9.9.9' } } }),
      });
    vi.stubGlobal('fetch', mockFetch);
    const freshMod = await import('../../server/relay-handlers');

    vi.useFakeTimers();
    const res = makeRes();
    const startPromise = freshMod.handleRelayStart(fakReq, res);
    await vi.advanceTimersByTimeAsync(6_000);
    await startPromise;

    expect(res.json.hlsUrl).toContain('stream.example.com');
    expect(res.json.hlsUrl).toContain('https://');
  });

  it('builds hlsUrl from IP when STREAM_DOMAIN is not set', async () => {
    vi.useFakeTimers();
    const res = makeRes();
    const startPromise = mod.handleRelayStart(fakReq, res);
    await vi.advanceTimersByTimeAsync(6_000);
    await startPromise;

    expect(res.json.hlsUrl).toBe('http://1.2.3.4/hls/live.m3u8');
  });
});

describe('handleRelayStart — already active', () => {
  it('returns 200 immediately without calling fetch again', async () => {
    // First: activate relay
    vi.useFakeTimers();
    const startRes1 = makeRes();
    const startPromise = mod.handleRelayStart(fakReq, startRes1);
    await vi.advanceTimersByTimeAsync(6_000);
    await startPromise;
    const fetchCallsAfterStart = mockFetch.mock.calls.length;

    // Second call: relay already active, should return immediately
    const res2 = makeRes();
    await mod.handleRelayStart(fakReq, res2);

    expect(res2.statusCode).toBe(200);
    expect(res2.json.active).toBe(true);
    expect(res2.json.ip).toBe('1.2.3.4');
    // No additional fetch calls made
    expect(mockFetch.mock.calls.length).toBe(fetchCallsAfterStart);
  });
});

describe('handleRelayStart — SCALEWAY_SECRET_KEY missing', () => {
  it('returns 500 when secret key env var is not set', async () => {
    delete process.env.SCALEWAY_SECRET_KEY;
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn()); // should not be called
    const freshMod = await import('../../server/relay-handlers');

    const res = makeRes();
    await freshMod.handleRelayStart(fakReq, res);
    expect(res.statusCode).toBe(500);
    expect(res.json.error).toBeTruthy();
  });
});

describe('handleRelayStart — SCALEWAY_INSTANCE_ID missing', () => {
  it('returns 500 when instance ID env var is not set', async () => {
    delete process.env.SCALEWAY_INSTANCE_ID;
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
    const freshMod = await import('../../server/relay-handlers');

    const res = makeRes();
    await freshMod.handleRelayStart(fakReq, res);
    expect(res.statusCode).toBe(500);
    expect(res.json.error).toBeTruthy();
  });
});

describe('handleRelayStart — scwAction HTTP error', () => {
  it('returns 500 when Scaleway poweron returns non-2xx', async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', mockErrorFetch(403));
    const freshMod = await import('../../server/relay-handlers');

    const res = makeRes();
    await freshMod.handleRelayStart(fakReq, res);
    expect(res.statusCode).toBe(500);
    expect(typeof res.json.error).toBe('string');
  });
});

describe('handleRelayStart — polling timeout', () => {
  it('returns 504 when server never reaches running state in 24 polls', async () => {
    vi.useFakeTimers();

    // Mock: poweron OK, all 24 server checks return 'starting' state
    const neverReadyFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' }) // poweron
      .mockResolvedValue({
        ok: true, status: 200, text: async () => '{}',
        json: async () => ({ server: { state: 'starting', public_ip: null } }),
      });
    vi.resetModules();
    vi.stubGlobal('fetch', neverReadyFetch);
    const freshMod = await import('../../server/relay-handlers');

    const res = makeRes();
    // Each poll iteration: setTimeout(5000) + one fetch. Advance 24 * 5000ms
    const startPromise = freshMod.handleRelayStart(fakReq, res);
    await vi.advanceTimersByTimeAsync(24 * 5_001);
    await startPromise;

    expect(res.statusCode).toBe(504);
    expect(res.json.error).toMatch(/not start/i);
  });
});

// ── handleRelayStop ───────────────────────────────────────────────────────────

describe('handleRelayStop — already stopped', () => {
  it('returns 200 with message when relay is inactive', async () => {
    const res = makeRes();
    await mod.handleRelayStop(fakReq, res);
    expect(res.statusCode).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(typeof res.json.message).toBe('string');
    // fetch should NOT have been called (no API call when already stopped)
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('handleRelayStop — active relay', () => {
  it('powers off and returns ok=true', async () => {
    vi.useFakeTimers();

    // Activate first
    const startRes = makeRes();
    const startPromise = mod.handleRelayStart(fakReq, startRes);
    await vi.advanceTimersByTimeAsync(6_000);
    await startPromise;
    expect(startRes.json.active).toBe(true);

    // Now add a poweroff mock response
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' });

    vi.useRealTimers();
    const stopRes = makeRes();
    await mod.handleRelayStop(fakReq, stopRes);
    expect(stopRes.statusCode).toBe(200);
    expect(stopRes.json.ok).toBe(true);
  });

  it('relay becomes inactive after successful stop', async () => {
    vi.useFakeTimers();

    // Activate
    const startPromise = mod.handleRelayStart(fakReq, makeRes());
    await vi.advanceTimersByTimeAsync(6_000);
    await startPromise;

    // Add poweroff mock
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' });

    vi.useRealTimers();
    await mod.handleRelayStop(fakReq, makeRes());

    // Status should now show inactive
    const statusRes = makeRes();
    await mod.handleRelayStatus(fakReq, statusRes);
    expect(statusRes.json.active).toBe(false);
    expect(statusRes.json.ip).toBeNull();
  });
});

describe('handleRelayStop — SCALEWAY_SECRET_KEY missing', () => {
  it('returns 500 when trying to stop but secret key is not set', async () => {
    // Need to first activate relay, then remove key
    vi.useFakeTimers();
    const startPromise = mod.handleRelayStart(fakReq, makeRes());
    await vi.advanceTimersByTimeAsync(6_000);
    await startPromise;

    delete process.env.SCALEWAY_SECRET_KEY;
    vi.useRealTimers();

    const res = makeRes();
    await mod.handleRelayStop(fakReq, res);
    expect(res.statusCode).toBe(500);
    expect(res.json.error).toBeTruthy();
  });
});

describe('handleRelayStop — poweroff HTTP error', () => {
  it('returns 500 when Scaleway poweroff returns non-2xx', async () => {
    vi.useFakeTimers();

    // Activate
    const startPromise = mod.handleRelayStart(fakReq, makeRes());
    await vi.advanceTimersByTimeAsync(6_000);
    await startPromise;

    // Poweroff fails
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 503, text: async () => 'Service Unavailable',
    });

    vi.useRealTimers();
    const res = makeRes();
    await mod.handleRelayStop(fakReq, res);
    expect(res.statusCode).toBe(500);
    expect(typeof res.json.error).toBe('string');
  });
});
