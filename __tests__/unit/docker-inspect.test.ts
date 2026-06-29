/**
 * Unit tests for server/docker-inspect.ts
 *
 * Covers:
 * - inspectDockerImage: single-arch manifest, multi-arch manifest, label extraction,
 *   official images (no namespace), auth failure, manifest fetch failure, blob failure,
 *   access_token fallback, missing config digest, com.babelcast.* label parsing
 * - handleDockerInspect: GET ?image= param, POST body, missing image → 400, success → 200,
 *   error → 502, bad JSON body → 400
 *
 * All external fetch calls are mocked globally via vi.spyOn / global.fetch replacement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Logger mock (no-op) ───────────────────────────────────────────────────────

vi.mock('../../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
}));

// ── http-utils mock ───────────────────────────────────────────────────────────

const mockReadJsonBody = vi.fn<[], Promise<Record<string, unknown>>>();

vi.mock('../../server/http-utils', () => ({
  readJsonBody: (...args: unknown[]) => mockReadJsonBody(...(args as [])),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRes() {
  const res = {
    _status: null as number | null,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead(status: number, headers?: Record<string, string>) {
      this._status = status;
      if (headers) this._headers = { ...this._headers, ...headers };
    },
    end(data?: string | Buffer) {
      if (data) this._body = typeof data === 'string' ? data : data.toString();
    },
    setHeader(name: string, value: string) {
      this._headers[name] = value;
    },
  };
  return res as unknown as ServerResponse & { _status: number | null; _headers: Record<string, string>; _body: string };
}

function makeReq(method = 'GET', url = '/'): IncomingMessage {
  return { method, url } as unknown as IncomingMessage;
}

/** Build a minimal Response-like object for vi.fn() */
function mockResponse(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Standard three-call sequence: auth → manifest → blob */
function setupFetch(
  fetchMock: ReturnType<typeof vi.fn>,
  manifest: unknown,
  labels: Record<string, string> = {},
) {
  fetchMock
    .mockResolvedValueOnce(mockResponse(true, 200, { token: 'test-token' })) // auth
    .mockResolvedValueOnce(mockResponse(true, 200, manifest))                 // manifest
    .mockResolvedValueOnce(mockResponse(true, 200, { config: { Labels: labels } })); // blob
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('inspectDockerImage', () => {
  let inspectDockerImage: (url: string) => Promise<import('../../server/docker-inspect').BabelcastDockerManifest>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const mod = await import('../../server/docker-inspect');
    inspectDockerImage = mod.inspectDockerImage;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Single-arch manifest (config.digest present) ───────────────────────────

  it('resolves single-arch manifest with babelcast service labels', async () => {
    setupFetch(
      fetchMock,
      { config: { digest: 'sha256:deadbeef' } },
      {
        'com.babelcast.services': 'stt,llm,tts',
        'com.babelcast.stt.model': 'whisper-large-v3',
        'com.babelcast.llm.model': 'llama-3-70b',
        'com.babelcast.tts.model': 'kokoro',
        'com.babelcast.protocol': 'rest',
        'com.babelcast.version': '1.2.3',
      },
    );

    const result = await inspectDockerImage('myuser/myimage:latest');
    expect(result.services).toEqual(['stt', 'llm', 'tts']);
    expect(result.sttModel).toBe('whisper-large-v3');
    expect(result.llmModel).toBe('llama-3-70b');
    expect(result.ttsModel).toBe('kokoro');
    expect(result.protocol).toBe('rest');
    expect(result.version).toBe('1.2.3');
    expect(result.image).toBe('myuser/myimage:latest');
  });

  it('returns protocol "rest" when not set in labels', async () => {
    setupFetch(fetchMock, { config: { digest: 'sha256:abc' } }, {});
    const result = await inspectDockerImage('user/img:v1');
    expect(result.protocol).toBe('rest');
  });

  it('returns empty services array when services label is missing', async () => {
    setupFetch(fetchMock, { config: { digest: 'sha256:abc' } }, {});
    const result = await inspectDockerImage('user/img:v1');
    expect(result.services).toEqual([]);
  });

  it('filters empty strings from services label', async () => {
    setupFetch(
      fetchMock,
      { config: { digest: 'sha256:abc' } },
      { 'com.babelcast.services': 'stt,,tts' },
    );
    const result = await inspectDockerImage('user/img:v1');
    expect(result.services).toEqual(['stt', 'tts']);
  });

  it('exposes rawLabels containing only com.babelcast.* entries', async () => {
    setupFetch(
      fetchMock,
      { config: { digest: 'sha256:abc' } },
      {
        'com.babelcast.services': 'stt',
        'maintainer': 'alice',
        'org.opencontainers.image.source': 'https://github.com/foo',
      },
    );
    const result = await inspectDockerImage('user/img:latest');
    expect(result.rawLabels).toEqual({ 'com.babelcast.services': 'stt' });
  });

  // ── Image URL parsing ──────────────────────────────────────────────────────

  it('uses auth URL with correct namespace and name', async () => {
    setupFetch(fetchMock, { config: { digest: 'sha256:abc' } }, {});
    await inspectDockerImage('myorg/myapp:1.0');
    const authUrl = fetchMock.mock.calls[0][0] as string;
    expect(authUrl).toContain('myorg/myapp');
  });

  it('sends auth token in manifest Authorization header', async () => {
    setupFetch(fetchMock, { config: { digest: 'sha256:abc' } }, {});
    await inspectDockerImage('user/img:latest');
    const manifestHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(manifestHeaders['Authorization']).toBe('Bearer test-token');
  });

  it('uses "library" namespace for official images (no slash)', async () => {
    setupFetch(fetchMock, { config: { digest: 'sha256:abc' } }, {});
    await inspectDockerImage('nginx');
    const authUrl = fetchMock.mock.calls[0][0] as string;
    expect(authUrl).toContain('library/nginx');
  });

  it('uses "latest" tag when none specified', async () => {
    setupFetch(fetchMock, { config: { digest: 'sha256:abc' } }, {});
    await inspectDockerImage('user/img');
    const manifestUrl = fetchMock.mock.calls[1][0] as string;
    expect(manifestUrl).toContain('/latest');
  });

  it('uses explicit tag when provided', async () => {
    setupFetch(fetchMock, { config: { digest: 'sha256:abc' } }, {});
    await inspectDockerImage('user/img:v2.3');
    const manifestUrl = fetchMock.mock.calls[1][0] as string;
    expect(manifestUrl).toContain('/v2.3');
  });

  // ── access_token fallback ──────────────────────────────────────────────────

  it('falls back to access_token when token field is absent', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(true, 200, { access_token: 'alt-token' }))
      .mockResolvedValueOnce(mockResponse(true, 200, { config: { digest: 'sha256:abc' } }))
      .mockResolvedValueOnce(mockResponse(true, 200, { config: { Labels: {} } }));

    const result = await inspectDockerImage('user/img:latest');
    expect(result.image).toBe('user/img:latest');
    const manifestHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(manifestHeaders['Authorization']).toBe('Bearer alt-token');
  });

  // ── Multi-arch manifest list ───────────────────────────────────────────────

  it('picks amd64/linux from multi-arch manifest list', async () => {
    const multiArchManifest = {
      manifests: [
        { digest: 'sha256:arm64', platform: { os: 'linux', architecture: 'arm64' } },
        { digest: 'sha256:amd64', platform: { os: 'linux', architecture: 'amd64' } },
      ],
    };
    fetchMock
      .mockResolvedValueOnce(mockResponse(true, 200, { token: 'tok' }))
      .mockResolvedValueOnce(mockResponse(true, 200, multiArchManifest))
      .mockResolvedValueOnce(mockResponse(true, 200, { config: { digest: 'sha256:cfg' } }))
      .mockResolvedValueOnce(mockResponse(true, 200, { config: { Labels: { 'com.babelcast.services': 'llm' } } }));

    const result = await inspectDockerImage('user/img:latest');
    expect(result.services).toEqual(['llm']);
    // Verify the sub-manifest fetch used the amd64 digest
    const subManifestUrl = fetchMock.mock.calls[2][0] as string;
    expect(subManifestUrl).toContain('sha256:amd64');
  });

  it('falls back to first entry in multi-arch manifest when no amd64', async () => {
    const multiArchManifest = {
      manifests: [
        { digest: 'sha256:only-arm', platform: { os: 'linux', architecture: 'arm64' } },
      ],
    };
    fetchMock
      .mockResolvedValueOnce(mockResponse(true, 200, { token: 'tok' }))
      .mockResolvedValueOnce(mockResponse(true, 200, multiArchManifest))
      .mockResolvedValueOnce(mockResponse(true, 200, { config: { digest: 'sha256:cfg' } }))
      .mockResolvedValueOnce(mockResponse(true, 200, { config: { Labels: {} } }));

    const result = await inspectDockerImage('user/img:latest');
    expect(result.image).toBe('user/img:latest');
    // Should have used the first (only) manifest
    const subManifestUrl = fetchMock.mock.calls[2][0] as string;
    expect(subManifestUrl).toContain('sha256:only-arm');
  });

  // ── Error cases ────────────────────────────────────────────────────────────

  it('throws when auth returns non-ok status', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(false, 401, {}));
    await expect(inspectDockerImage('user/img:latest')).rejects.toThrow('Auth failed: 401');
  });

  it('throws when auth response contains no token', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(true, 200, {}));
    await expect(inspectDockerImage('user/img:latest')).rejects.toThrow('No token in auth response');
  });

  it('throws when manifest fetch returns non-ok status', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(true, 200, { token: 'tok' }))
      .mockResolvedValueOnce(mockResponse(false, 404, {}));
    await expect(inspectDockerImage('user/img:latest')).rejects.toThrow('Manifest fetch failed: 404');
  });

  it('throws when sub-manifest fetch fails for multi-arch image', async () => {
    const multiArchManifest = {
      manifests: [{ digest: 'sha256:amd64', platform: { os: 'linux', architecture: 'amd64' } }],
    };
    fetchMock
      .mockResolvedValueOnce(mockResponse(true, 200, { token: 'tok' }))
      .mockResolvedValueOnce(mockResponse(true, 200, multiArchManifest))
      .mockResolvedValueOnce(mockResponse(false, 500, {}));
    await expect(inspectDockerImage('user/img:latest')).rejects.toThrow('Sub-manifest fetch failed: 500');
  });

  it('throws when config blob fetch fails', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(true, 200, { token: 'tok' }))
      .mockResolvedValueOnce(mockResponse(true, 200, { config: { digest: 'sha256:abc' } }))
      .mockResolvedValueOnce(mockResponse(false, 503, {}));
    await expect(inspectDockerImage('user/img:latest')).rejects.toThrow('Config blob fetch failed: 503');
  });

  it('throws when manifest has neither config.digest nor manifests array', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(true, 200, { token: 'tok' }))
      .mockResolvedValueOnce(mockResponse(true, 200, {})); // no config, no manifests
    await expect(inspectDockerImage('user/img:latest')).rejects.toThrow('Could not locate config digest');
  });

  it('handles null Labels in config blob gracefully', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(true, 200, { token: 'tok' }))
      .mockResolvedValueOnce(mockResponse(true, 200, { config: { digest: 'sha256:abc' } }))
      .mockResolvedValueOnce(mockResponse(true, 200, { config: { Labels: null } }));
    const result = await inspectDockerImage('user/img:latest');
    expect(result.services).toEqual([]);
    expect(result.rawLabels).toEqual({});
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// handleDockerInspect
// ══════════════════════════════════════════════════════════════════════════════

describe('handleDockerInspect', () => {
  let handleDockerInspect: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const mod = await import('../../server/docker-inspect');
    handleDockerInspect = mod.handleDockerInspect;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── GET with ?image= query param ───────────────────────────────────────────

  it('returns 400 when GET has no image param', async () => {
    const res = makeRes();
    await handleDockerInspect(makeReq('GET', '/v1/docker/inspect'), res);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/missing image/);
  });

  it('returns 200 with manifest for valid GET ?image=', async () => {
    setupFetch(
      fetchMock,
      { config: { digest: 'sha256:abc' } },
      { 'com.babelcast.services': 'stt', 'com.babelcast.protocol': 'ws' },
    );
    const res = makeRes();
    await handleDockerInspect(makeReq('GET', '/v1/docker/inspect?image=user%2Fimg%3Alatest'), res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.services).toEqual(['stt']);
    expect(body.protocol).toBe('ws');
  });

  // ── POST with JSON body ────────────────────────────────────────────────────

  it('returns 400 when POST body has no image field', async () => {
    mockReadJsonBody.mockResolvedValueOnce({});
    const res = makeRes();
    await handleDockerInspect(makeReq('POST', '/v1/docker/inspect'), res);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/missing image/);
  });

  it('returns 400 when readJsonBody throws (bad JSON)', async () => {
    mockReadJsonBody.mockRejectedValueOnce(new SyntaxError('Unexpected end of JSON'));
    const res = makeRes();
    await handleDockerInspect(makeReq('POST', '/v1/docker/inspect'), res);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/invalid JSON/);
  });

  it('uses image from POST body when provided', async () => {
    mockReadJsonBody.mockResolvedValueOnce({ image: 'myorg/myapp:v3' });
    setupFetch(fetchMock, { config: { digest: 'sha256:abc' } }, {});
    const res = makeRes();
    await handleDockerInspect(makeReq('POST', '/v1/docker/inspect'), res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.image).toBe('myorg/myapp:v3');
  });

  // ── Error propagation ──────────────────────────────────────────────────────

  it('returns 502 when inspectDockerImage throws', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(false, 401, {}));
    const res = makeRes();
    await handleDockerInspect(makeReq('GET', '/v1/docker/inspect?image=bad%2Fimage'), res);
    expect(res._status).toBe(502);
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/Auth failed/);
  });

  it('returns 502 with string error message for non-Error throws', async () => {
    // Force a string rejection by making fetch throw a string
    fetchMock.mockRejectedValueOnce('connection refused');
    const res = makeRes();
    await handleDockerInspect(makeReq('GET', '/v1/docker/inspect?image=user%2Fimg'), res);
    expect(res._status).toBe(502);
    const body = JSON.parse(res._body);
    expect(typeof body.error).toBe('string');
  });

  // ── Response Content-Type ──────────────────────────────────────────────────

  it('sets Content-Type: application/json on success', async () => {
    setupFetch(fetchMock, { config: { digest: 'sha256:abc' } }, {});
    const res = makeRes();
    await handleDockerInspect(makeReq('GET', '/v1/docker/inspect?image=u%2Fi'), res);
    expect(res._headers['Content-Type']).toBe('application/json');
  });

  it('sets Content-Type: application/json on 400 error', async () => {
    const res = makeRes();
    await handleDockerInspect(makeReq('GET', '/v1/docker/inspect'), res);
    expect(res._headers['Content-Type']).toBe('application/json');
  });

  it('sets Content-Type: application/json on 502 error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    const res = makeRes();
    await handleDockerInspect(makeReq('GET', '/v1/docker/inspect?image=u%2Fi'), res);
    expect(res._headers['Content-Type']).toBe('application/json');
  });
});
