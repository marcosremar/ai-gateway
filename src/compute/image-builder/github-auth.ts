/**
 * GitHub OAuth Device Flow
 *
 * Allows the CLI (or any non-browser environment) to authenticate with GitHub
 * without a redirect URI.
 *
 * Flow:
 *   1. POST /login/device/code  → { device_code, user_code, verification_uri }
 *   2. User visits verification_uri and enters user_code
 *   3. Poll POST /login/oauth/access_token with device_code until granted
 *   4. Store token in ~/.babelcast/github_token.json
 *
 * Required GitHub OAuth App scopes: repo, workflow, write:packages
 *
 * Set GITHUB_CLIENT_ID env var (or AI_GATEWAY_GITHUB_CLIENT_ID) to your GitHub
 * OAuth App's Client ID. Register one at:
 * https://github.com/settings/applications/new
 * (Authorization callback URL can be anything — device flow doesn't use it)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { GitHubTokenData, GitHubDeviceFlowStart } from './types';

const BABELCAST_DIR = join(homedir(), '.babelcast');
const TOKEN_FILE = join(BABELCAST_DIR, 'github_token.json');

// Required scopes: create repos, create/trigger workflows, push to GHCR
const SCOPES = 'repo,workflow,write:packages,read:user';

export function getGitHubClientId(): string | null {
  return (
    process.env.AI_GATEWAY_GITHUB_CLIENT_ID ||
    process.env.GITHUB_CLIENT_ID ||
    null
  );
}

// ── Token persistence ─────────────────────────────────────────────────────────

export function loadGitHubToken(): GitHubTokenData | null {
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    const raw = readFileSync(TOKEN_FILE, 'utf-8');
    const data = JSON.parse(raw) as GitHubTokenData;
    if (!data.accessToken) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveGitHubToken(data: GitHubTokenData): void {
  mkdirSync(BABELCAST_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
}

export function clearGitHubToken(): void {
  try {
    if (existsSync(TOKEN_FILE)) {
      writeFileSync(TOKEN_FILE, JSON.stringify({}));
    }
  } catch {}
}

// ── Device flow ───────────────────────────────────────────────────────────────

export async function startDeviceFlow(clientId: string): Promise<GitHubDeviceFlowStart> {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: SCOPES }),
  });

  if (!res.ok) {
    throw new Error(`GitHub device flow failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
    error?: string;
  };

  if (data.error) throw new Error(`GitHub: ${data.error}`);

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval,
  };
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'complete'; accessToken: string; tokenType: string; scope: string }
  | { status: 'expired' }
  | { status: 'error'; error: string };

export async function pollDeviceFlow(clientId: string, deviceCode: string): Promise<PollResult> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });

  if (!res.ok) {
    return { status: 'error', error: `HTTP ${res.status}` };
  }

  const data = await res.json() as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (data.access_token) {
    return {
      status: 'complete',
      accessToken: data.access_token,
      tokenType: data.token_type ?? 'bearer',
      scope: data.scope ?? SCOPES,
    };
  }

  if (data.error === 'authorization_pending' || data.error === 'slow_down') {
    return { status: 'pending' };
  }
  if (data.error === 'expired_token') {
    return { status: 'expired' };
  }

  return { status: 'error', error: data.error_description ?? data.error ?? 'unknown' };
}

/** Fetch the GitHub username for the given token */
export async function getGitHubUsername(accessToken: string): Promise<string> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub /user failed: ${res.status}`);
  const data = await res.json() as { login: string };
  return data.login;
}

/**
 * Run the full device flow polling loop until granted, expired, or aborted.
 * Returns the token data (caller should save with saveGitHubToken).
 */
export async function runDeviceFlowLoop(
  clientId: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresIn: number,
  onPoll?: () => void,
): Promise<GitHubTokenData> {
  const deadline = Date.now() + expiresIn * 1000;
  const waitMs = Math.max(intervalSeconds, 5) * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, waitMs));
    onPoll?.();

    const result = await pollDeviceFlow(clientId, deviceCode);

    if (result.status === 'complete') {
      const username = await getGitHubUsername(result.accessToken);
      return {
        accessToken: result.accessToken,
        tokenType: result.tokenType,
        scope: result.scope,
        username,
        savedAt: Date.now(),
      };
    }
    if (result.status === 'expired') {
      throw new Error('GitHub device code expired — run auth again');
    }
    if (result.status === 'error') {
      throw new Error(`GitHub auth error: ${result.error}`);
    }
    // status === 'pending' → keep polling
  }

  throw new Error('GitHub device code expired (timeout)');
}
