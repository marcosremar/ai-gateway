import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  logRequest,
  handleStatus,
  handleV1Status,
  _resetRequestLog,
} from '../src/proxy/routes/status';
import type { IncomingMessage, ServerResponse } from 'http';

// Minimal fake response that captures writeHead + end calls
function makeRes(): { res: ServerResponse; status: number; headers: Record<string, string>; body: string } {
  const capture = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res = {
    writeHead(code: number, hdrs: Record<string, string>) {
      capture.status = code;
      Object.assign(capture.headers, hdrs);
    },
    end(data: string) {
      capture.body = data;
    },
  } as unknown as ServerResponse;
  return { res, ...capture, get status() { return capture.status; }, get headers() { return capture.headers; }, get body() { return capture.body; } };
}

function makeReq(accept?: string): IncomingMessage {
  return { headers: { accept: accept ?? '' } } as unknown as IncomingMessage;
}

describe('logRequest / _resetRequestLog', () => {
  beforeEach(() => _resetRequestLog());

  it('adds entries to the log', () => {
    logRequest({ method: 'GET', path: '/v1/models', status: 200, latencyMs: 42 });
    const capture = makeRes();
    handleV1Status(makeReq(), capture.res);
    const body = JSON.parse(capture.body);
    expect(body.requests.total).toBe(1);
  });

  it('trims log at MAX_REQUEST_LOG (1000) using ring buffer', () => {
    for (let i = 0; i < 1002; i++) {
      logRequest({ method: 'GET', path: '/ping', status: 200, latencyMs: 1 });
    }
    const capture = makeRes();
    handleV1Status(makeReq(), capture.res);
    const body = JSON.parse(capture.body);
    expect(body.requests.total).toBe(1000);
  });

  it('reset clears all entries', () => {
    logRequest({ method: 'POST', path: '/v1/chat/completions', status: 200, latencyMs: 10 });
    _resetRequestLog();
    const capture = makeRes();
    handleV1Status(makeReq(), capture.res);
    const body = JSON.parse(capture.body);
    expect(body.requests.total).toBe(0);
  });
});

describe('handleStatus', () => {
  beforeEach(() => _resetRequestLog());
  afterEach(() => vi.useRealTimers());

  it('returns 200 HTML when no Accept: application/json header', () => {
    const capture = makeRes();
    handleStatus(makeReq(), capture.res);
    expect(capture.status).toBe(200);
    expect(capture.headers['Content-Type']).toContain('text/html');
    expect(capture.body).toContain('<!DOCTYPE html>');
  });

  it('returns 200 JSON when Accept: application/json', () => {
    const capture = makeRes();
    handleStatus(makeReq('application/json'), capture.res);
    expect(capture.status).toBe(200);
    expect(capture.headers['Content-Type']).toContain('application/json');
    const body = JSON.parse(capture.body);
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('healthy');
    expect(body).toHaveProperty('providers');
    expect(body).toHaveProperty('gpu');
    expect(body).toHaveProperty('requests');
  });

  it('reflects provider and gpu args in JSON response', () => {
    const capture = makeRes();
    const providers = [
      { id: 'groq', type: 'llm' as const, healthy: true, latencyMs: 100, lastChecked: '2026-01-01T00:00:00Z' },
    ];
    const gpu = { available: true, status: 'ready', gpuType: 'RTX 4090' };
    handleStatus(makeReq('application/json'), capture.res, providers, gpu);
    const body = JSON.parse(capture.body);
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].id).toBe('groq');
    expect(body.gpu.status).toBe('ready');
    expect(body.gpu.gpuType).toBe('RTX 4090');
  });

  it('counts requests in the last minute correctly', () => {
    const t0 = Date.now(); // capture real time before installing fake clock
    vi.useFakeTimers();
    // Log one entry "2 minutes ago"
    vi.setSystemTime(t0 - 120_000);
    logRequest({ method: 'GET', path: '/ping', status: 200, latencyMs: 5 });
    // Log two entries "now"
    vi.setSystemTime(t0);
    logRequest({ method: 'GET', path: '/ping', status: 200, latencyMs: 5 });
    logRequest({ method: 'GET', path: '/ping', status: 200, latencyMs: 5 });

    const capture = makeRes();
    handleStatus(makeReq('application/json'), capture.res);
    const body = JSON.parse(capture.body);
    expect(body.requests.total).toBe(3);
    expect(body.requests.lastMinute).toBe(2);
  });

  it('computes avgLatency from recent entries', () => {
    logRequest({ method: 'GET', path: '/v1/models', status: 200, latencyMs: 100 });
    logRequest({ method: 'GET', path: '/v1/models', status: 200, latencyMs: 200 });
    const capture = makeRes();
    handleStatus(makeReq('application/json'), capture.res);
    const body = JSON.parse(capture.body);
    expect(body.requests.avgLatencyMs).toBe(150);
  });

  it('computes errorRate from recent entries', () => {
    logRequest({ method: 'POST', path: '/v1/chat/completions', status: 200, latencyMs: 50 });
    logRequest({ method: 'POST', path: '/v1/chat/completions', status: 500, latencyMs: 10 });
    const capture = makeRes();
    handleStatus(makeReq('application/json'), capture.res);
    const body = JSON.parse(capture.body);
    // 1 error out of 2 = 0.5
    expect(body.requests.errorRate).toBeCloseTo(0.5);
  });

  it('reports healthy=false when no providers', () => {
    const capture = makeRes();
    handleStatus(makeReq('application/json'), capture.res, []);
    const body = JSON.parse(capture.body);
    expect(body.healthy).toBe(false);
  });

  it('reports healthy=true when at least one healthy provider', () => {
    const providers = [
      { id: 'groq', type: 'llm' as const, healthy: true, lastChecked: '2026-01-01T00:00:00Z' },
    ];
    const capture = makeRes();
    handleStatus(makeReq('application/json'), capture.res, providers);
    const body = JSON.parse(capture.body);
    expect(body.healthy).toBe(true);
  });
});

describe('handleV1Status', () => {
  beforeEach(() => _resetRequestLog());

  it('always returns JSON regardless of Accept header', () => {
    const capture = makeRes();
    handleV1Status(makeReq('text/html'), capture.res);
    expect(capture.status).toBe(200);
    expect(capture.headers['Content-Type']).toContain('application/json');
    const body = JSON.parse(capture.body);
    expect(body).toHaveProperty('requests');
  });

  it('does NOT include errorRate (v1 endpoint omits it)', () => {
    logRequest({ method: 'POST', path: '/v1/chat/completions', status: 500, latencyMs: 10 });
    const capture = makeRes();
    handleV1Status(makeReq(), capture.res);
    const body = JSON.parse(capture.body);
    // v1 status omits errorRate — requests object has no errorRate key
    expect(body.requests).not.toHaveProperty('errorRate');
  });

  it('avgLatencyMs is undefined (absent) when log is empty', () => {
    const capture = makeRes();
    handleV1Status(makeReq(), capture.res);
    const body = JSON.parse(capture.body);
    expect(body.requests.avgLatencyMs).toBeUndefined();
  });

  it('reflects providers and gpu in response', () => {
    const providers = [
      { id: 'openai', type: 'tts' as const, healthy: false, lastChecked: '2026-01-01T00:00:00Z' },
    ];
    const gpu = { available: false, status: 'stopped' };
    const capture = makeRes();
    handleV1Status(makeReq(), capture.res, providers, gpu);
    const body = JSON.parse(capture.body);
    expect(body.providers[0].id).toBe('openai');
    expect(body.gpu.status).toBe('stopped');
    expect(body.healthy).toBe(false);
  });
});
