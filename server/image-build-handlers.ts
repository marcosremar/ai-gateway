/**
 * Image Build HTTP handlers — /v1/docker/*
 *
 * Routes:
 *   POST   /v1/docker/auth           — Start GitHub OAuth device flow
 *   GET    /v1/docker/auth/status    — Poll device flow status
 *   DELETE /v1/docker/auth           — Revoke / log out
 *   POST   /v1/docker/build          — Start a Docker image build
 *   GET    /v1/docker/builds         — List all builds
 *   GET    /v1/docker/builds/:id     — Get build status
 *   GET    /v1/docker/images         — List successfully built images
 *
 * GitHub OAuth requires a Client ID set via env var:
 *   AI_GATEWAY_GITHUB_CLIENT_ID or GITHUB_CLIENT_ID
 *
 * To register a GitHub OAuth App:
 *   https://github.com/settings/applications/new
 *   (Authorization callback URL: http://localhost — device flow doesn't use it)
 */

import { sendJsonError } from './http-utils';
import type { IncomingMessage, ServerResponse } from 'http';

// Local response helpers
function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function badRequest(res: ServerResponse, message: string): void {
  sendJsonError(res, 400, message, 'BAD_REQUEST');
}
function notFound(res: ServerResponse, message: string): void {
  sendJsonError(res, 404, message, 'NOT_FOUND');
}
function internalError(res: ServerResponse, message: string): void {
  sendJsonError(res, 500, message, 'INTERNAL_ERROR');
}
import {
  getGitHubClientId,
  loadGitHubToken,
  saveGitHubToken,
  clearGitHubToken,
  startDeviceFlow,
  pollDeviceFlow,
  getGitHubUsername,
} from '../src/image-builder/github-auth';
import { startBuild, getBuildStatus } from '../src/image-builder/image-build-service';
import { listBuildRecords, getReadyImages } from '../src/image-builder/image-catalog';

// ── In-memory device flow sessions (keyed by sessionId) ──────────────────────
// These are short-lived (~15min) and local — no persistence needed.

interface DeviceSession {
  clientId: string;
  deviceCode: string;
  interval: number;
  expiresAt: number;
}

const deviceSessions = new Map<string, DeviceSession>();

function newSessionId(): string {
  return `ghsess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/** POST /v1/docker/auth — Start GitHub OAuth device flow */
export async function handleDockerAuthStart(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const clientId = getGitHubClientId();
  if (!clientId) {
    return badRequest(
      res,
      'GITHUB_CLIENT_ID not configured. Set AI_GATEWAY_GITHUB_CLIENT_ID or GITHUB_CLIENT_ID env var. ' +
        'Register an OAuth App at https://github.com/settings/applications/new',
    );
  }

  try {
    const flow = await startDeviceFlow(clientId);
    const sessionId = newSessionId();

    deviceSessions.set(sessionId, {
      clientId,
      deviceCode: flow.deviceCode,
      interval: flow.interval,
      expiresAt: Date.now() + flow.expiresIn * 1000,
    });

    // Clean up old sessions
    for (const [id, s] of deviceSessions) {
      if (s.expiresAt < Date.now()) deviceSessions.delete(id);
    }

    return json(res, {
      sessionId,
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      expiresIn: flow.expiresIn,
      interval: flow.interval,
      instructions: `Visit ${flow.verificationUri} and enter code: ${flow.userCode}`,
    });
  } catch (e: unknown) {
    return internalError(res, e instanceof Error ? e.message : String(e));
  }
}

/** GET /v1/docker/auth/status?sessionId=... — Poll device flow */
export async function handleDockerAuthPoll(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url!, `http://localhost`);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) return badRequest(res, 'Missing sessionId query param');

  const session = deviceSessions.get(sessionId);
  if (!session) return badRequest(res, 'Session not found or expired');

  if (session.expiresAt < Date.now()) {
    deviceSessions.delete(sessionId);
    return json(res, { status: 'expired' });
  }

  try {
    const result = await pollDeviceFlow(session.clientId, session.deviceCode);

    if (result.status === 'complete') {
      deviceSessions.delete(sessionId);
      const username = await getGitHubUsername(result.accessToken);
      saveGitHubToken({
        accessToken: result.accessToken,
        tokenType: result.tokenType,
        scope: result.scope,
        username,
        savedAt: Date.now(),
      });
      return json(res, { status: 'complete', username });
    }

    if (result.status === 'expired') {
      deviceSessions.delete(sessionId);
      return json(res, { status: 'expired' });
    }

    if (result.status === 'error') {
      return json(res, { status: 'error', error: result.error });
    }

    return json(res, { status: 'pending' });
  } catch (e: unknown) {
    return internalError(res, e instanceof Error ? e.message : String(e));
  }
}

/** GET /v1/docker/auth/me — Return current GitHub user (if authenticated) */
export async function handleDockerAuthMe(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const token = loadGitHubToken();
  if (!token) return json(res, { authenticated: false });
  return json(res, {
    authenticated: true,
    username: token.username,
    scope: token.scope,
    savedAt: token.savedAt,
  });
}

/** DELETE /v1/docker/auth — Log out (clear stored token) */
export async function handleDockerAuthLogout(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  clearGitHubToken();
  return json(res, { ok: true, message: 'GitHub token cleared' });
}

/** POST /v1/docker/build — Start a build */
export async function handleDockerBuildStart(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length > 0) body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    return badRequest(res, 'Invalid JSON body');
  }

  const dirPath = body.dirPath as string | undefined;
  if (!dirPath) return badRequest(res, 'Missing required field: dirPath');

  try {
    const result = await startBuild({
      dirPath,
      name: body.name as string | undefined,
      tag: body.tag as string | undefined,
      repoName: body.repoName as string | undefined,
      isPublic: body.isPublic as boolean | undefined,
      platforms: body.platforms as string | undefined,
    });

    return json(res, result, 202);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Not authenticated')) return json(res, { error: msg }, 401);
    if (msg.includes('not found') || msg.includes('Dockerfile')) return badRequest(res, msg);
    return internalError(res, msg);
  }
}

/** GET /v1/docker/builds — List builds */
export async function handleDockerBuildList(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url!, `http://localhost`);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 100);
  const builds = listBuildRecords(limit);
  return json(res, { builds });
}

/** GET /v1/docker/builds/:id — Get build status */
export async function handleDockerBuildStatus(
  req: IncomingMessage,
  res: ServerResponse,
  buildId: string,
): Promise<void> {
  const build = getBuildStatus(buildId);
  if (!build) return notFound(res, `Build ${buildId} not found`);
  return json(res, { build });
}

/** GET /v1/docker/images — List successfully built images */
export async function handleDockerImageList(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const images = getReadyImages();
  return json(res, { images });
}

// ── Route map (to be spread into ws-server.ts handlers) ──────────────────────

export function getDockerRoutes(): Record<string, Function> {
  return {
    'POST /v1/docker/auth': handleDockerAuthStart,
    'GET /v1/docker/auth/status': handleDockerAuthPoll,
    'GET /v1/docker/auth/me': handleDockerAuthMe,
    'DELETE /v1/docker/auth': handleDockerAuthLogout,
    'POST /v1/docker/build': handleDockerBuildStart,
    'GET /v1/docker/builds': handleDockerBuildList,
    'GET /v1/docker/images': handleDockerImageList,
  };
}

/**
 * Match dynamic routes that need path params (e.g. /v1/docker/builds/:id).
 * Returns [handler, params] or null.
 */
export function matchDockerDynamicRoute(
  method: string,
  pathname: string,
): [(req: IncomingMessage, res: ServerResponse, ...args: string[]) => Promise<void>, string[]] | null {
  const buildMatch = pathname.match(/^\/v1\/docker\/builds\/([^/]+)$/);
  if (buildMatch && method === 'GET') {
    return [handleDockerBuildStatus, [buildMatch[1]]];
  }
  return null;
}
