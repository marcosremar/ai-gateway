/**
 * Unit tests for server/video-handlers.ts
 *
 * Covers handleVideoGenerate:
 * - 400 when image_b64 missing
 * - 503 when GPU not ready (various deployState conditions)
 * - 503 when model_loaded === false in health check
 * - Continues when health check throws (treats as model_loaded = true)
 * - 200 proxying successful GPU response
 * - Proxies non-ok GPU status codes through
 * - 502 when GPU fetch throws
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

// ── State mock ───────────────────────────────────────────────────────────────

const mockDeployState: Record<string, unknown> = {
  status: 'idle',
  endpoint: null,
};

vi.mock('../../server/state', () => ({
  get deployState() { return mockDeployState; },
}));

// ── http-utils mock ──────────────────────────────────────────────────────────

const mockReadJsonBody = vi.fn<[], Promise<Record<string, unknown>>>();
const mockHandleBodyError = vi.fn<[ServerResponse, unknown], void>();

vi.mock('../../server/http-utils', () => ({
  readJsonBody: (...args: unknown[]) => mockReadJsonBody(...(args as [])),
  handleBodyError: (...args: unknown[]) => mockHandleBodyError(...(args as [ServerResponse, unknown])),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRes(): ServerResponse & {
  _status: number | null;
  _headers: Record<string, string>;
  _body: string;
} {
  const chunks: Buffer[] = [];
  const res = {
    _status: null as number | null,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead(status: number, headers?: Record<string, string>) {
      this._status = status;
      if (headers) this._headers = { ...this._headers, ...headers };
    },
    end(data?: string | Buffer) {
      if (data) this._body = data.toString();
    },
    setHeader(name: string, value: string) {
      this._headers[name] = value;
    },
  } as unknown as ServerResponse & { _status: number | null; _headers: Record<string, string>; _body: string };
  return res;
}

function makeReq(): IncomingMessage {
  return {} as IncomingMessage;
}

function mockFetchResponse(
  ok: boolean,
  status: number,
  body: unknown,
): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('handleVideoGenerate', () => {
  let handleVideoGenerate: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset deploy state
    mockDeployState.status = 'idle';
    mockDeployState.endpoint = null;

    // Install global fetch mock
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const mod = await import('../../server/video-handlers');
    handleVideoGenerate = mod.handleVideoGenerate;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Missing image_b64 ──────────────────────────────────────────────────────

  it('returns 400 when image_b64 is missing', async () => {
    mockReadJsonBody.mockResolvedValueOnce({ preset: 'default' });
    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/image_b64/);
  });

  it('calls handleBodyError when readJsonBody throws', async () => {
    const err = new Error('bad JSON');
    mockReadJsonBody.mockRejectedValueOnce(err);
    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    expect(mockHandleBodyError).toHaveBeenCalledWith(res, err);
  });

  // ── GPU not ready ──────────────────────────────────────────────────────────

  it('returns 503 when deployState.status is idle', async () => {
    mockDeployState.status = 'idle';
    mockDeployState.endpoint = 'http://gpu:8000';
    mockReadJsonBody.mockResolvedValueOnce({ image_b64: 'abc123' });
    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    expect(res._status).toBe(503);
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/GPU not ready/);
    expect(body.status).toBe('idle');
  });

  it('returns 503 when deployState.status is booting', async () => {
    mockDeployState.status = 'booting';
    mockDeployState.endpoint = 'http://gpu:8000';
    mockReadJsonBody.mockResolvedValueOnce({ image_b64: 'abc123' });
    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    expect(res._status).toBe(503);
    const body = JSON.parse(res._body);
    expect(body.status).toBe('booting');
  });

  it('returns 503 when deployState.status is ready but endpoint is null', async () => {
    mockDeployState.status = 'ready';
    mockDeployState.endpoint = null;
    mockReadJsonBody.mockResolvedValueOnce({ image_b64: 'abc123' });
    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    expect(res._status).toBe(503);
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/GPU not ready/);
  });

  it('returns 503 when deployState.status is ready but endpoint is empty string', async () => {
    mockDeployState.status = 'ready';
    mockDeployState.endpoint = '';
    mockReadJsonBody.mockResolvedValueOnce({ image_b64: 'abc123' });
    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    expect(res._status).toBe(503);
  });

  // ── Health check ───────────────────────────────────────────────────────────

  it('returns 503 when health check reports model_loaded = false', async () => {
    mockDeployState.status = 'ready';
    mockDeployState.endpoint = 'http://gpu:8000';
    mockReadJsonBody.mockResolvedValueOnce({ image_b64: 'abc123' });

    fetchSpy.mockResolvedValueOnce(mockFetchResponse(true, 200, { model_loaded: false }));

    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    expect(res._status).toBe(503);
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/Model not loaded/);
  });

  it('proceeds when health check throws (treats as loaded)', async () => {
    mockDeployState.status = 'ready';
    mockDeployState.endpoint = 'http://gpu:8000';
    mockReadJsonBody.mockResolvedValueOnce({ image_b64: 'abc123' });

    // Health check fails → then generate call succeeds
    fetchSpy
      .mockRejectedValueOnce(new Error('health check timeout'))
      .mockResolvedValueOnce(mockFetchResponse(true, 200, { video_b64: 'xyz', num_frames: 25 }));

    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.video_b64).toBe('xyz');
  });

  it('proceeds when health check returns non-ok status (treats as loaded)', async () => {
    mockDeployState.status = 'ready';
    mockDeployState.endpoint = 'http://gpu:8000';
    mockReadJsonBody.mockResolvedValueOnce({ image_b64: 'abc123' });

    // Health check returns 500 → json() would throw or return error → proceed
    const badHealthRes = {
      ok: false,
      status: 500,
      json: async () => { throw new Error('not json'); },
    } as unknown as Response;
    fetchSpy
      .mockResolvedValueOnce(badHealthRes)
      .mockResolvedValueOnce(mockFetchResponse(true, 200, { video_b64: 'result' }));

    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    // After health check failure, it should fall through and try generate
    // (model_loaded set to true in catch block)
    expect(res._status).toBe(200);
  });

  it('proceeds when health check returns model_loaded = true', async () => {
    mockDeployState.status = 'ready';
    mockDeployState.endpoint = 'http://gpu:8000';
    mockReadJsonBody.mockResolvedValueOnce({ image_b64: 'abc123' });

    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse(true, 200, { model_loaded: true, version: '1.0' }))
      .mockResolvedValueOnce(mockFetchResponse(true, 200, { video_b64: 'base64video', num_frames: 16, fps: 8 }));

    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.video_b64).toBe('base64video');
    expect(body.num_frames).toBe(16);
  });

  // ── Generate success ───────────────────────────────────────────────────────

  it('sends request body fields to GPU endpoint', async () => {
    mockDeployState.status = 'ready';
    mockDeployState.endpoint = 'http://gpu:8000';
    mockReadJsonBody.mockResolvedValueOnce({
      image_b64: 'abc',
      preset: 'fast',
      num_frames: 49,
      fps: 12,
      height: 480,
      width: 854,
      num_inference_steps: 20,
    });

    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse(true, 200, { model_loaded: true }))
      .mockResolvedValueOnce(mockFetchResponse(true, 200, { video_b64: 'v64', duration_seconds: 4.08 }));

    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);

    // Verify generate call was made with correct URL and method
    const generateCall = fetchSpy.mock.calls[1];
    expect(generateCall[0]).toBe('http://gpu:8000/generate');
    expect(generateCall[1].method).toBe('POST');
    const sentBody = JSON.parse(generateCall[1].body);
    expect(sentBody.image_b64).toBe('abc');
    expect(sentBody.preset).toBe('fast');
    expect(sentBody.num_frames).toBe(49);
    expect(res._status).toBe(200);
  });

  // ── GPU error responses ────────────────────────────────────────────────────

  it('proxies 422 from GPU through unchanged', async () => {
    mockDeployState.status = 'ready';
    mockDeployState.endpoint = 'http://gpu:8000';
    mockReadJsonBody.mockResolvedValueOnce({ image_b64: 'bad' });

    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse(true, 200, { model_loaded: true }))
      .mockResolvedValueOnce(mockFetchResponse(false, 422, { detail: 'Image too large' }));

    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    expect(res._status).toBe(422);
    const body = JSON.parse(res._body);
    expect(body.detail).toBe('Image too large');
  });

  it('proxies 500 from GPU through unchanged', async () => {
    mockDeployState.status = 'ready';
    mockDeployState.endpoint = 'http://gpu:8000';
    mockReadJsonBody.mockResolvedValueOnce({ image_b64: 'img' });

    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse(true, 200, { model_loaded: true }))
      .mockResolvedValueOnce(mockFetchResponse(false, 500, { error: 'OOM on GPU' }));

    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    expect(res._status).toBe(500);
    const body = JSON.parse(res._body);
    expect(body.error).toBe('OOM on GPU');
  });

  // ── Network failures ───────────────────────────────────────────────────────

  it('returns 502 when GPU generate fetch throws (timeout)', async () => {
    mockDeployState.status = 'ready';
    mockDeployState.endpoint = 'http://gpu:8000';
    mockReadJsonBody.mockResolvedValueOnce({ image_b64: 'img' });

    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse(true, 200, { model_loaded: true }))
      .mockRejectedValueOnce(new Error('TimeoutError: The operation timed out'));

    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    expect(res._status).toBe(502);
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/GPU request failed/);
    expect(body.error).toMatch(/TimeoutError/);
  });

  it('returns 502 when GPU generate fetch throws (connection refused)', async () => {
    mockDeployState.status = 'ready';
    mockDeployState.endpoint = 'http://gpu:8000';
    mockReadJsonBody.mockResolvedValueOnce({ image_b64: 'img' });

    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse(true, 200, { model_loaded: true }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    expect(res._status).toBe(502);
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/ECONNREFUSED/);
  });

  // ── Health check URL construction ──────────────────────────────────────────

  it('hits <endpoint>/health for the readiness probe', async () => {
    mockDeployState.status = 'ready';
    mockDeployState.endpoint = 'http://gpu-host:9000';
    mockReadJsonBody.mockResolvedValueOnce({ image_b64: 'img' });

    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse(true, 200, { model_loaded: true }))
      .mockResolvedValueOnce(mockFetchResponse(true, 200, { video_b64: 'ok' }));

    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://gpu-host:9000/health');
  });

  it('hits <endpoint>/generate for the video request', async () => {
    mockDeployState.status = 'ready';
    mockDeployState.endpoint = 'http://gpu-host:9000';
    mockReadJsonBody.mockResolvedValueOnce({ image_b64: 'img' });

    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse(true, 200, { model_loaded: true }))
      .mockResolvedValueOnce(mockFetchResponse(true, 200, { video_b64: 'ok' }));

    await handleVideoGenerate(makeReq(), makeRes());
    expect(fetchSpy.mock.calls[1][0]).toBe('http://gpu-host:9000/generate');
  });

  // ── Edge: non-Error throw ──────────────────────────────────────────────────

  it('returns 502 with string message when non-Error is thrown', async () => {
    mockDeployState.status = 'ready';
    mockDeployState.endpoint = 'http://gpu:8000';
    mockReadJsonBody.mockResolvedValueOnce({ image_b64: 'img' });

    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse(true, 200, { model_loaded: true }))
      .mockRejectedValueOnce('string-error');

    const res = makeRes();
    await handleVideoGenerate(makeReq(), res);
    expect(res._status).toBe(502);
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/string-error/);
  });
});
