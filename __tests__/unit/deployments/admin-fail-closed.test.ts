/**
 * Regression (security test 06/10/2026): with DEPLOYMENTS_ADMIN_USERS empty, EVERY GATEWAY_API_KEYS key was an admin
 * (deployments, `X-App` for any app's fallback plan, `PUT /v1/admin/keys`, `/health?deep=1`). Now an empty list grants
 * admin to NOBODY (the SANDBOX_TOKEN is not a key either, owner 06/10/2026), and the boot logs a warning.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { adminListWarning, adminUsersFromEnv, deploymentsFromEnv } from '../../../src/deployments';
import { createDeploymentRoutes } from '../../../src/deployments/http';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function call(handler: ReturnType<typeof createDeploymentRoutes>, user: string, method: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve) => {
    let status = 0;
    const res = {
      headersSent: false,
      writeHead: (s: number) => { status = s; return res; },
      end: (data?: string) => resolve({ status, body: data ?? '' }),
      on: () => res,
    } as unknown as ServerResponse;
    const req = Object.assign((async function* () { yield Buffer.from('{}'); })(), {
      headers: { authorization: `Bearer ${user}`, ...headers }, url: path, socket: {},
    }) as unknown as IncomingMessage;
    handler(req, res, path, method);
  });
}

function service(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'aigw-admin-'));
  dirs.push(dir);
  const logs: string[] = [];
  const built = deploymentsFromEnv({ SCW_SECRET_KEY: 's', DEPLOYMENTS_NAMESPACE: 'test', DEPLOYMENTS_STATE_DIR: dir, ...env }, {
    userOf: (req) => String(req.headers.authorization ?? '').replace(/^Bearer\s+/, '') || null,
    log: (m) => logs.push(m),
  })!;
  return { ...built, logs };
}

describe('admin keys fail closed', () => {
  it('an empty DEPLOYMENTS_ADMIN_USERS makes no ordinary key an admin, and says so at boot', async () => {
    const { handler, logs } = service({});
    expect(logs.join('\n')).toMatch(/WARNING: DEPLOYMENTS_ADMIN_USERS is empty/);
    expect((await call(handler, 'parle', 'PUT', '/v1/deployments/x')).status).toBe(403);
    expect((await call(handler, 'parle', 'POST', '/v1/deployments/x/wake')).status).toBe(403);
    expect((await call(handler, 'parle', 'PUT', '/v1/profiles/p')).status).toBe(403);
    // `X-App` (acting for another app, e.g. its fallback plan with provider keys) is admin-only.
    expect((await call(handler, 'parle', 'GET', '/v1/apps/other/fallback', { 'x-app': 'other' })).status).toBe(403);
    // Nobody is admin, the former SANDBOX_TOKEN user included.
    expect((await call(handler, 'sandbox', 'POST', '/v1/deployments/x/wake')).status).toBe(403);
    expect(logs.join('\n')).toMatch(/no GATEWAY_API_KEYS key is an admin — set/);
  });

  it('a listed user is an admin; the list is the only source of admins, never the dev token', async () => {
    const { handler, logs } = service({ DEPLOYMENTS_ADMIN_USERS: 'ops, ' });
    expect(logs.join('\n')).not.toMatch(/WARNING/);
    expect((await call(handler, 'ops', 'POST', '/v1/deployments/x/wake')).status).toBe(404);
    expect((await call(handler, 'parle', 'POST', '/v1/deployments/x/wake')).status).toBe(403);
    expect([...adminUsersFromEnv({ DEPLOYMENTS_ADMIN_USERS: 'ops, ' })]).toEqual(['ops']);
    expect([...adminUsersFromEnv({ DEPLOYMENTS_ADMIN_USERS: 'ops, sandbox', SANDBOX_TOKEN_ADMIN: '1' })]).toEqual(['ops']);
    expect(adminUsersFromEnv({}).size).toBe(0);
    expect(adminListWarning({ DEPLOYMENTS_ADMIN_USERS: ' , ' })).toMatch(/is empty/);
    const formerOptIn = service({ SANDBOX_TOKEN_ADMIN: '1', DEPLOYMENTS_ADMIN_USERS: 'sandbox' });
    expect((await call(formerOptIn.handler, 'sandbox', 'POST', '/v1/deployments/x/wake')).status).toBe(403);
  });

  it('createDeploymentRoutes without isAdmin lets nobody manage', async () => {
    const handler = createDeploymentRoutes({ controller: { get: () => null } as never });
    expect((await call(handler, 'anyone', 'POST', '/v1/deployments/x/wake')).status).toBe(403);
  });
});

describe('X-App naming the key\'s own app (API audit 2026-10-07)', () => {
  it('a non-admin key may send X-App equal to its own app (the SDK GatewayClient({ app }) does); never another app', async () => {
    const { handler } = service({ DEPLOYMENTS_ADMIN_USERS: 'ops' });
    // Was 403 ("only an admin key may act for another app") although the app is the key's own.
    expect((await call(handler, 'parle', 'GET', '/v1/deployments', { 'x-app': 'parle' })).status).toBe(200);
    expect((await call(handler, 'parle', 'GET', '/v1/apps', { 'x-app': 'parle' })).status).toBe(200);
    expect((await call(handler, 'parle', 'GET', '/v1/deployments', { 'x-app': 'other' })).status).toBe(403);
    expect((await call(handler, 'parle', 'GET', '/v1/apps/other', { 'x-app': 'other' })).status).toBe(403);
    // Still no admin power: a mutation with its own X-App stays admin-only.
    expect((await call(handler, 'parle', 'POST', '/v1/deployments/x/wake', { 'x-app': 'parle' })).status).toBe(403);
  });
});
