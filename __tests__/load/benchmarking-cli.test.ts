import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCliBench, buildTtfaTable, type CliBenchResult } from '../src/benchmarking/cli-bench';
import type { ProtoResult, HealthResult } from '../src/benchmarking/bench';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    body: {
      getReader: () => ({
        read: async () => ({ done: true, value: undefined }),
      }),
    },
  } as unknown as Response;
}

describe('runCliBench()', () => {
  it('returns result with correct structure when endpoint is healthy', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ status: 'ok', services: {} }),
    );

    const result = await runCliBench('http://localhost:8000', ['sse']);

    expect(result).toBeDefined();
    expect(result.endpoint).toBe('http://localhost:8000');
    expect(result.timestamp).toBeDefined();
    expect(result.health).toBeDefined();
    expect(result.health.ok).toBe(true);
    expect(result.health.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.ttfa_summary).toBeDefined();
    expect(typeof result.ttfa_summary).toBe('string');
  });

  it('returns error result when endpoint is offline', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const result = await runCliBench('http://offline-host:8000', ['sse']);

    expect(result.health.ok).toBe(false);
    expect(result.health.error).toBeDefined();
    expect(result.sse).toBeNull();
    expect(result.ws).toBeNull();
    expect(result.webrtc).toBeNull();
  });

  it('returns correct structure fields', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ status: 'ok' }),
    );

    const result: CliBenchResult = await runCliBench('http://localhost:8000', []);

    expect(result).toHaveProperty('endpoint');
    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('health');
    expect(result).toHaveProperty('sse');
    expect(result).toHaveProperty('ws');
    expect(result).toHaveProperty('webrtc');
    expect(result).toHaveProperty('ttfa_summary');
  });

  it('skips protocols when health check fails', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ status: 'error' }, 503),
    );

    const result = await runCliBench('http://localhost:8000', ['sse', 'ws', 'webrtc']);

    expect(result.health.ok).toBe(false);
    expect(result.sse).toBeNull();
    expect(result.ws).toBeNull();
    expect(result.webrtc).toBeNull();
    expect(result.ttfa_summary).toBeDefined();
  });
});

describe('buildTtfaTable()', () => {
  it('builds table with all protocols', () => {
    const results = {
      sse: { ok: true, total_ms: 2000, ttfa_ms: 800 } as ProtoResult,
      ws: { ok: true, total_ms: 1500, ttfa_ms: 600 } as ProtoResult,
      webrtc: { ok: false, total_ms: 3000, error: 'Not available' } as ProtoResult,
    };

    const table = buildTtfaTable(results);
    expect(table).toContain('SSE');
    expect(table).toContain('WebSocket');
    expect(table).toContain('WebRTC');
    expect(table).toContain('800 ms');
    expect(table).toContain('600 ms');
  });

  it('handles null results', () => {
    const table = buildTtfaTable({ sse: null, ws: null, webrtc: null });
    expect(table).toContain('Protocol');
    expect(table).toContain('TTFA');
  });
});
