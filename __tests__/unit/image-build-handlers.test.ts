/**
 * Image Build Handlers — Unit Test Suite
 *
 * Covers server/image-build-handlers.ts:
 *   handleDockerAuthStart  — GITHUB_CLIENT_ID missing, startDeviceFlow error, success
 *   handleDockerAuthPoll   — missing sessionId, unknown session, expired, pending,
 *                            complete, slow_down, error, pollDeviceFlow throws
 *   handleDockerAuthMe     — unauthenticated, authenticated
 *   handleDockerAuthLogout — clears token
 *   handleDockerBuildStart — missing dirPath, JSON error, not-authenticated, Dockerfile
 *                            not found, generic error, success
 *   handleDockerBuildList  — default limit, custom limit, limit capped at 100
 *   handleDockerBuildStatus — not found, found
 *   handleDockerImageList  — returns images
 *   getDockerRoutes        — static route map
 *   matchDockerDynamicRoute — GET /:id, POST /:id (no match), non-build path
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Hoisted mock functions (vi.mock factories are hoisted to top of file) ───

const {
  mockGetGitHubClientId,
  mockLoadGitHubToken,
  mockSaveGitHubToken,
  mockClearGitHubToken,
  mockStartDeviceFlow,
  mockPollDeviceFlow,
  mockGetGitHubUsername,
  mockStartBuild,
  mockGetBuildStatus,
  mockListBuildRecords,
  mockGetReadyImages,
} = vi.hoisted(() => ({
  mockGetGitHubClientId: vi.fn<() => string | undefined>(),
  mockLoadGitHubToken: vi.fn(),
  mockSaveGitHubToken: vi.fn(),
  mockClearGitHubToken: vi.fn(),
  mockStartDeviceFlow: vi.fn(),
  mockPollDeviceFlow: vi.fn(),
  mockGetGitHubUsername: vi.fn(),
  mockStartBuild: vi.fn(),
  mockGetBuildStatus: vi.fn(),
  mockListBuildRecords: vi.fn<(limit: number) => unknown[]>(),
  mockGetReadyImages: vi.fn<() => unknown[]>(),
}));

vi.mock('../../src/image-builder/github-auth', () => ({
  getGitHubClientId: mockGetGitHubClientId,
  loadGitHubToken: mockLoadGitHubToken,
  saveGitHubToken: mockSaveGitHubToken,
  clearGitHubToken: mockClearGitHubToken,
  startDeviceFlow: mockStartDeviceFlow,
  pollDeviceFlow: mockPollDeviceFlow,
  getGitHubUsername: mockGetGitHubUsername,
}));

vi.mock('../../src/image-builder/image-build-service', () => ({
  startBuild: mockStartBuild,
  getBuildStatus: mockGetBuildStatus,
}));

vi.mock('../../src/image-builder/image-catalog', () => ({
  listBuildRecords: mockListBuildRecords,
  getReadyImages: mockGetReadyImages,
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import {
  handleDockerAuthStart,
  handleDockerAuthPoll,
  handleDockerAuthMe,
  handleDockerAuthLogout,
  handleDockerBuildStart,
  handleDockerBuildList,
  handleDockerBuildStatus,
  handleDockerImageList,
  getDockerRoutes,
  matchDockerDynamicRoute,
} from '../../server/image-build-handlers';

// ── Test helpers ────────────────────────────────────────────────────────────

function makeFakeReq(
  method: string,
  url: string,
  body?: unknown,
): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage;
  stream.method = method;
  stream.url = url;
  stream.headers = { 'content-type': 'application/json' };
  if (body !== undefined) {
    const raw = JSON.stringify(body);
    (stream as unknown as PassThrough).end(Buffer.from(raw));
  } else {
    (stream as unknown as PassThrough).end();
  }
  return stream;
}

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  json<T = unknown>(): T;
}

function makeFakeRes(): [ServerResponse, () => CapturedResponse] {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];

  const res = {
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
    },
    setHeader(name: string, value: string) { headers[name] = value; },
    getHeader(name: string) { return headers[name]; },
    end(data?: string | Buffer) {
      if (data) chunks.push(typeof data === 'string' ? Buffer.from(data) : data);
    },
    write(data: string | Buffer) {
      chunks.push(typeof data === 'string' ? Buffer.from(data) : data);
    },
    headersSent: false,
  } as unknown as ServerResponse;

  const capture = (): CapturedResponse => {
    const body = Buffer.concat(chunks).toString();
    return {
      statusCode,
      headers,
      body,
      json<T>(): T { return JSON.parse(body) as T; },
    };
  };

  return [res, capture];
}

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── handleDockerAuthStart ───────────────────────────────────────────────────

describe('handleDockerAuthStart', () => {
  it('returns 400 when GITHUB_CLIENT_ID is not configured', async () => {
    mockGetGitHubClientId.mockReturnValue(undefined);
    const req = makeFakeReq('POST', '/v1/docker/auth');
    const [res, capture] = makeFakeRes();

    await handleDockerAuthStart(req, res);

    const r = capture();
    expect(r.statusCode).toBe(400);
    const body = r.json<{ error: { message: string } }>();
    expect(body.error.message).toMatch(/GITHUB_CLIENT_ID/i);
  });

  it('returns 500 when startDeviceFlow throws', async () => {
    mockGetGitHubClientId.mockReturnValue('gh-client-id');
    mockStartDeviceFlow.mockRejectedValue(new Error('GitHub API unavailable'));

    const req = makeFakeReq('POST', '/v1/docker/auth');
    const [res, capture] = makeFakeRes();

    await handleDockerAuthStart(req, res);

    const r = capture();
    expect(r.statusCode).toBe(500);
    const body = r.json<{ error: { message: string } }>();
    expect(body.error.message).toMatch(/GitHub API unavailable/);
  });

  it('returns 200 with session info on success', async () => {
    mockGetGitHubClientId.mockReturnValue('gh-client-id');
    mockStartDeviceFlow.mockResolvedValue({
      deviceCode: 'dev-code-abc',
      userCode: 'AABB-CCDD',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    });

    const req = makeFakeReq('POST', '/v1/docker/auth');
    const [res, capture] = makeFakeRes();

    await handleDockerAuthStart(req, res);

    const r = capture();
    expect(r.statusCode).toBe(200);
    const body = r.json<Record<string, unknown>>();
    expect(body.sessionId).toBeDefined();
    expect(body.userCode).toBe('AABB-CCDD');
    expect(body.verificationUri).toBe('https://github.com/login/device');
    expect(body.expiresIn).toBe(900);
    expect(body.interval).toBe(5);
    expect(String(body.instructions)).toContain('AABB-CCDD');
  });

  it('cleans up expired sessions when a new one is created', async () => {
    mockGetGitHubClientId.mockReturnValue('gh-client-id');
    mockStartDeviceFlow.mockResolvedValue({
      deviceCode: 'new-dev', userCode: 'XXXX-YYYY',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 0, // already expired
      interval: 5,
    });

    const req = makeFakeReq('POST', '/v1/docker/auth');
    const [res, capture] = makeFakeRes();

    await handleDockerAuthStart(req, res);
    const r = capture();
    // Should still succeed — expired ones are cleaned up but new session is returned
    expect(r.statusCode).toBe(200);
    expect(r.json<Record<string, unknown>>().userCode).toBe('XXXX-YYYY');
  });
});

// ── handleDockerAuthPoll ────────────────────────────────────────────────────

describe('handleDockerAuthPoll', () => {
  it('returns 400 when sessionId is missing', async () => {
    const req = makeFakeReq('GET', '/v1/docker/auth/status');
    const [res, capture] = makeFakeRes();

    await handleDockerAuthPoll(req, res);

    const r = capture();
    expect(r.statusCode).toBe(400);
    const body = r.json<{ error: { message: string } }>();
    expect(body.error.message).toMatch(/sessionId/i);
  });

  it('returns 400 for an unknown session', async () => {
    const req = makeFakeReq('GET', '/v1/docker/auth/status?sessionId=nonexistent');
    const [res, capture] = makeFakeRes();

    await handleDockerAuthPoll(req, res);

    const r = capture();
    expect(r.statusCode).toBe(400);
    const body = r.json<{ error: { message: string } }>();
    expect(body.error.message).toMatch(/not found|expired/i);
  });

  it('returns {status: pending} while waiting for user', async () => {
    // First create a session
    mockGetGitHubClientId.mockReturnValue('cid');
    mockStartDeviceFlow.mockResolvedValue({
      deviceCode: 'dc', userCode: 'AAAA-BBBB',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900, interval: 5,
    });
    const createReq = makeFakeReq('POST', '/v1/docker/auth');
    const [createRes, captureCreate] = makeFakeRes();
    await handleDockerAuthStart(createReq, createRes);
    const sessionId = captureCreate().json<{ sessionId: string }>().sessionId;

    // Now poll
    mockPollDeviceFlow.mockResolvedValue({ status: 'pending' });
    const req = makeFakeReq('GET', `/v1/docker/auth/status?sessionId=${sessionId}`);
    const [res, capture] = makeFakeRes();

    await handleDockerAuthPoll(req, res);

    const r = capture();
    expect(r.statusCode).toBe(200);
    expect(r.json<{ status: string }>().status).toBe('pending');
  });

  it('returns {status: complete, username} when token arrives', async () => {
    mockGetGitHubClientId.mockReturnValue('cid');
    mockStartDeviceFlow.mockResolvedValue({
      deviceCode: 'dc', userCode: 'CCCC-DDDD',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900, interval: 5,
    });
    const [createRes, captureCreate] = makeFakeRes();
    await handleDockerAuthStart(makeFakeReq('POST', '/v1/docker/auth'), createRes);
    const sessionId = captureCreate().json<{ sessionId: string }>().sessionId;

    mockPollDeviceFlow.mockResolvedValue({
      status: 'complete', accessToken: 'gho_tok', tokenType: 'bearer', scope: 'repo',
    });
    mockGetGitHubUsername.mockResolvedValue('testuser');

    const [res, capture] = makeFakeRes();
    await handleDockerAuthPoll(makeFakeReq('GET', `/v1/docker/auth/status?sessionId=${sessionId}`), res);

    const r = capture();
    expect(r.statusCode).toBe(200);
    const body = r.json<{ status: string; username: string }>();
    expect(body.status).toBe('complete');
    expect(body.username).toBe('testuser');
    expect(mockSaveGitHubToken).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'gho_tok', username: 'testuser' }),
    );
  });

  it('returns {status: expired} when poll returns expired', async () => {
    mockGetGitHubClientId.mockReturnValue('cid');
    mockStartDeviceFlow.mockResolvedValue({
      deviceCode: 'dc', userCode: 'EEEE-FFFF',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900, interval: 5,
    });
    const [createRes, captureCreate] = makeFakeRes();
    await handleDockerAuthStart(makeFakeReq('POST', '/v1/docker/auth'), createRes);
    const sessionId = captureCreate().json<{ sessionId: string }>().sessionId;

    mockPollDeviceFlow.mockResolvedValue({ status: 'expired' });
    const [res, capture] = makeFakeRes();
    await handleDockerAuthPoll(makeFakeReq('GET', `/v1/docker/auth/status?sessionId=${sessionId}`), res);

    expect(capture().json<{ status: string }>().status).toBe('expired');
  });

  it('returns {status: slow_down} when poll returns slow_down', async () => {
    mockGetGitHubClientId.mockReturnValue('cid');
    mockStartDeviceFlow.mockResolvedValue({
      deviceCode: 'dc', userCode: 'GGGG-HHHH',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900, interval: 5,
    });
    const [createRes, captureCreate] = makeFakeRes();
    await handleDockerAuthStart(makeFakeReq('POST', '/v1/docker/auth'), createRes);
    const sessionId = captureCreate().json<{ sessionId: string }>().sessionId;

    mockPollDeviceFlow.mockResolvedValue({ status: 'slow_down' });
    const [res, capture] = makeFakeRes();
    await handleDockerAuthPoll(makeFakeReq('GET', `/v1/docker/auth/status?sessionId=${sessionId}`), res);

    expect(capture().json<{ status: string }>().status).toBe('slow_down');
  });

  it('returns {status: error, error: msg} when poll returns error', async () => {
    mockGetGitHubClientId.mockReturnValue('cid');
    mockStartDeviceFlow.mockResolvedValue({
      deviceCode: 'dc', userCode: 'IIII-JJJJ',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900, interval: 5,
    });
    const [createRes, captureCreate] = makeFakeRes();
    await handleDockerAuthStart(makeFakeReq('POST', '/v1/docker/auth'), createRes);
    const sessionId = captureCreate().json<{ sessionId: string }>().sessionId;

    mockPollDeviceFlow.mockResolvedValue({ status: 'error', error: 'access_denied' });
    const [res, capture] = makeFakeRes();
    await handleDockerAuthPoll(makeFakeReq('GET', `/v1/docker/auth/status?sessionId=${sessionId}`), res);

    const body = capture().json<{ status: string; error: string }>();
    expect(body.status).toBe('error');
    expect(body.error).toBe('access_denied');
  });

  it('returns 500 when pollDeviceFlow throws', async () => {
    mockGetGitHubClientId.mockReturnValue('cid');
    mockStartDeviceFlow.mockResolvedValue({
      deviceCode: 'dc', userCode: 'KKKK-LLLL',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900, interval: 5,
    });
    const [createRes, captureCreate] = makeFakeRes();
    await handleDockerAuthStart(makeFakeReq('POST', '/v1/docker/auth'), createRes);
    const sessionId = captureCreate().json<{ sessionId: string }>().sessionId;

    mockPollDeviceFlow.mockRejectedValue(new Error('network error'));
    const [res, capture] = makeFakeRes();
    await handleDockerAuthPoll(makeFakeReq('GET', `/v1/docker/auth/status?sessionId=${sessionId}`), res);

    expect(capture().statusCode).toBe(500);
  });
});

// ── handleDockerAuthMe ──────────────────────────────────────────────────────

describe('handleDockerAuthMe', () => {
  it('returns {authenticated: false} when no token is stored', async () => {
    mockLoadGitHubToken.mockReturnValue(null);

    const [res, capture] = makeFakeRes();
    await handleDockerAuthMe(makeFakeReq('GET', '/v1/docker/auth/me'), res);

    const r = capture();
    expect(r.statusCode).toBe(200);
    expect(r.json<{ authenticated: boolean }>().authenticated).toBe(false);
  });

  it('returns {authenticated: true, username, scope, savedAt} when token exists', async () => {
    const savedAt = Date.now() - 1000;
    mockLoadGitHubToken.mockReturnValue({
      accessToken: 'gho_abc',
      tokenType: 'bearer',
      scope: 'repo,read:user',
      username: 'myuser',
      savedAt,
    });

    const [res, capture] = makeFakeRes();
    await handleDockerAuthMe(makeFakeReq('GET', '/v1/docker/auth/me'), res);

    const r = capture();
    expect(r.statusCode).toBe(200);
    const body = r.json<Record<string, unknown>>();
    expect(body.authenticated).toBe(true);
    expect(body.username).toBe('myuser');
    expect(body.scope).toBe('repo,read:user');
    expect(body.savedAt).toBe(savedAt);
    // accessToken should NOT be exposed
    expect(body.accessToken).toBeUndefined();
  });
});

// ── handleDockerAuthLogout ──────────────────────────────────────────────────

describe('handleDockerAuthLogout', () => {
  it('calls clearGitHubToken and returns ok', async () => {
    const [res, capture] = makeFakeRes();
    await handleDockerAuthLogout(makeFakeReq('DELETE', '/v1/docker/auth'), res);

    const r = capture();
    expect(r.statusCode).toBe(200);
    expect(r.json<{ ok: boolean }>().ok).toBe(true);
    expect(mockClearGitHubToken).toHaveBeenCalledOnce();
  });
});

// ── handleDockerBuildStart ──────────────────────────────────────────────────

describe('handleDockerBuildStart', () => {
  it('returns 400 when dirPath is missing', async () => {
    const req = makeFakeReq('POST', '/v1/docker/build', { name: 'myapp' });
    const [res, capture] = makeFakeRes();

    await handleDockerBuildStart(req, res);

    const r = capture();
    expect(r.statusCode).toBe(400);
    const body = r.json<{ error: { message: string } }>();
    expect(body.error.message).toMatch(/dirPath/i);
  });

  it('returns 401 when not authenticated (Not authenticated error)', async () => {
    const req = makeFakeReq('POST', '/v1/docker/build', {
      dirPath: '/tmp/myapp', name: 'myapp',
    });
    mockStartBuild.mockRejectedValue(new Error('Not authenticated — run `ai-gateway docker auth` first'));

    const [res, capture] = makeFakeRes();
    await handleDockerBuildStart(req, res);

    const r = capture();
    expect(r.statusCode).toBe(401);
    expect(r.json<{ error: string }>().error).toMatch(/Not authenticated/);
  });

  it('returns 400 when Dockerfile not found', async () => {
    const req = makeFakeReq('POST', '/v1/docker/build', {
      dirPath: '/tmp/myapp', name: 'myapp',
    });
    mockStartBuild.mockRejectedValue(new Error('Dockerfile not found in /tmp/myapp'));

    const [res, capture] = makeFakeRes();
    await handleDockerBuildStart(req, res);

    const r = capture();
    expect(r.statusCode).toBe(400);
    const body = r.json<{ error: { message: string } }>();
    expect(body.error.message).toMatch(/Dockerfile/);
  });

  it('returns 400 for "not found" path errors', async () => {
    const req = makeFakeReq('POST', '/v1/docker/build', {
      dirPath: '/tmp/nonexistent', name: 'myapp',
    });
    mockStartBuild.mockRejectedValue(new Error('Path /tmp/nonexistent not found'));

    const [res, capture] = makeFakeRes();
    await handleDockerBuildStart(req, res);

    expect(capture().statusCode).toBe(400);
  });

  it('returns 500 for unexpected errors', async () => {
    const req = makeFakeReq('POST', '/v1/docker/build', {
      dirPath: '/tmp/myapp', name: 'myapp',
    });
    mockStartBuild.mockRejectedValue(new Error('GitHub Actions API timeout'));

    const [res, capture] = makeFakeRes();
    await handleDockerBuildStart(req, res);

    const r = capture();
    expect(r.statusCode).toBe(500);
    const body = r.json<{ error: { message: string } }>();
    expect(body.error.message).toMatch(/GitHub Actions API timeout/);
  });

  it('returns 202 with build result on success', async () => {
    const buildResult = {
      buildId: 'bld-abc123',
      status: 'queued',
      imageName: 'ghcr.io/user/ai-gateway-img-myapp:latest',
      startedAt: Date.now(),
    };
    mockStartBuild.mockResolvedValue(buildResult);

    const req = makeFakeReq('POST', '/v1/docker/build', {
      dirPath: '/tmp/myapp', name: 'myapp', tag: 'v1.0',
    });
    const [res, capture] = makeFakeRes();

    await handleDockerBuildStart(req, res);

    const r = capture();
    expect(r.statusCode).toBe(202);
    expect(r.json<{ buildId: string }>().buildId).toBe('bld-abc123');
    expect(mockStartBuild).toHaveBeenCalledWith(
      expect.objectContaining({ dirPath: '/tmp/myapp', name: 'myapp', tag: 'v1.0' }),
    );
  });

  it('passes optional fields (repoName, isPublic, platforms) to startBuild', async () => {
    mockStartBuild.mockResolvedValue({ buildId: 'bld-xyz', status: 'queued' });

    const req = makeFakeReq('POST', '/v1/docker/build', {
      dirPath: '/tmp/app', name: 'app',
      repoName: 'my-org/my-repo',
      isPublic: true,
      platforms: 'linux/amd64,linux/arm64',
    });
    const [res] = makeFakeRes();

    await handleDockerBuildStart(req, res);

    expect(mockStartBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        repoName: 'my-org/my-repo',
        isPublic: true,
        platforms: 'linux/amd64,linux/arm64',
      }),
    );
  });
});

// ── handleDockerBuildList ───────────────────────────────────────────────────

describe('handleDockerBuildList', () => {
  it('lists builds with default limit of 50', async () => {
    const records = [{ buildId: '1' }, { buildId: '2' }];
    mockListBuildRecords.mockReturnValue(records);

    const req = makeFakeReq('GET', '/v1/docker/builds');
    const [res, capture] = makeFakeRes();
    await handleDockerBuildList(req, res);

    const r = capture();
    expect(r.statusCode).toBe(200);
    expect(r.json<{ builds: unknown[] }>().builds).toEqual(records);
    expect(mockListBuildRecords).toHaveBeenCalledWith(50);
  });

  it('passes custom limit from query param', async () => {
    mockListBuildRecords.mockReturnValue([]);

    const req = makeFakeReq('GET', '/v1/docker/builds?limit=10');
    const [res] = makeFakeRes();
    await handleDockerBuildList(req, res);

    expect(mockListBuildRecords).toHaveBeenCalledWith(10);
  });

  it('caps limit at 100', async () => {
    mockListBuildRecords.mockReturnValue([]);

    const req = makeFakeReq('GET', '/v1/docker/builds?limit=9999');
    const [res] = makeFakeRes();
    await handleDockerBuildList(req, res);

    expect(mockListBuildRecords).toHaveBeenCalledWith(100);
  });

  it('returns empty array when no builds exist', async () => {
    mockListBuildRecords.mockReturnValue([]);

    const req = makeFakeReq('GET', '/v1/docker/builds');
    const [res, capture] = makeFakeRes();
    await handleDockerBuildList(req, res);

    expect(capture().json<{ builds: unknown[] }>().builds).toHaveLength(0);
  });
});

// ── handleDockerBuildStatus ─────────────────────────────────────────────────

describe('handleDockerBuildStatus', () => {
  it('returns 404 when build does not exist', async () => {
    mockGetBuildStatus.mockReturnValue(null);

    const req = makeFakeReq('GET', '/v1/docker/builds/bld-unknown');
    const [res, capture] = makeFakeRes();
    await handleDockerBuildStatus(req, res, 'bld-unknown');

    const r = capture();
    expect(r.statusCode).toBe(404);
    const body = r.json<{ error: { message: string } }>();
    expect(body.error.message).toMatch(/not found/i);
  });

  it('returns 200 with build when found', async () => {
    const build = {
      buildId: 'bld-abc',
      status: 'success',
      imageName: 'ghcr.io/user/ai-gateway-img-app:latest',
      startedAt: 1700000000000,
      finishedAt: 1700000060000,
    };
    mockGetBuildStatus.mockReturnValue(build);

    const req = makeFakeReq('GET', '/v1/docker/builds/bld-abc');
    const [res, capture] = makeFakeRes();
    await handleDockerBuildStatus(req, res, 'bld-abc');

    const r = capture();
    expect(r.statusCode).toBe(200);
    expect(r.json<{ build: typeof build }>().build).toEqual(build);
    expect(mockGetBuildStatus).toHaveBeenCalledWith('bld-abc');
  });
});

// ── handleDockerImageList ───────────────────────────────────────────────────

describe('handleDockerImageList', () => {
  it('returns 200 with available images', async () => {
    const images = [
      { imageName: 'ghcr.io/user/ai-gateway-img-app:latest', builtAt: 1700000000000 },
      { imageName: 'ghcr.io/user/ai-gateway-img-other:latest', builtAt: 1700001000000 },
    ];
    mockGetReadyImages.mockReturnValue(images);

    const req = makeFakeReq('GET', '/v1/docker/images');
    const [res, capture] = makeFakeRes();
    await handleDockerImageList(req, res);

    const r = capture();
    expect(r.statusCode).toBe(200);
    expect(r.json<{ images: typeof images }>().images).toEqual(images);
  });

  it('returns empty images array when none are ready', async () => {
    mockGetReadyImages.mockReturnValue([]);

    const req = makeFakeReq('GET', '/v1/docker/images');
    const [res, capture] = makeFakeRes();
    await handleDockerImageList(req, res);

    expect(capture().json<{ images: unknown[] }>().images).toHaveLength(0);
  });
});

// ── getDockerRoutes ─────────────────────────────────────────────────────────

describe('getDockerRoutes', () => {
  it('returns the correct static route map', () => {
    const routes = getDockerRoutes();

    expect(routes['POST /v1/docker/auth']).toBe(handleDockerAuthStart);
    expect(routes['GET /v1/docker/auth/status']).toBe(handleDockerAuthPoll);
    expect(routes['GET /v1/docker/auth/me']).toBe(handleDockerAuthMe);
    expect(routes['DELETE /v1/docker/auth']).toBe(handleDockerAuthLogout);
    expect(routes['POST /v1/docker/build']).toBe(handleDockerBuildStart);
    expect(routes['GET /v1/docker/builds']).toBe(handleDockerBuildList);
    expect(routes['GET /v1/docker/images']).toBe(handleDockerImageList);
  });

  it('has exactly 7 routes', () => {
    expect(Object.keys(getDockerRoutes())).toHaveLength(7);
  });
});

// ── matchDockerDynamicRoute ─────────────────────────────────────────────────

describe('matchDockerDynamicRoute', () => {
  it('matches GET /v1/docker/builds/:id and returns handler + id', () => {
    const match = matchDockerDynamicRoute('GET', '/v1/docker/builds/bld-123');
    expect(match).not.toBeNull();
    const [handler, params] = match!;
    expect(handler).toBe(handleDockerBuildStatus);
    expect(params).toEqual(['bld-123']);
  });

  it('matches alphanumeric + hyphen build IDs', () => {
    const match = matchDockerDynamicRoute('GET', '/v1/docker/builds/bld-abc-xyz-001');
    expect(match).not.toBeNull();
    expect(match![1]).toEqual(['bld-abc-xyz-001']);
  });

  it('returns null for POST /v1/docker/builds/:id (wrong method)', () => {
    expect(matchDockerDynamicRoute('POST', '/v1/docker/builds/bld-123')).toBeNull();
  });

  it('returns null for DELETE /v1/docker/builds/:id (wrong method)', () => {
    expect(matchDockerDynamicRoute('DELETE', '/v1/docker/builds/bld-123')).toBeNull();
  });

  it('returns null for a non-build path', () => {
    expect(matchDockerDynamicRoute('GET', '/v1/docker/images')).toBeNull();
    expect(matchDockerDynamicRoute('GET', '/v1/gpu/status')).toBeNull();
    expect(matchDockerDynamicRoute('GET', '/v1/docker/builds')).toBeNull();
  });

  it('returns null for path with trailing slash', () => {
    expect(matchDockerDynamicRoute('GET', '/v1/docker/builds/bld-123/')).toBeNull();
  });
});
