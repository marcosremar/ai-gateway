import type { CustomRoute } from '../gateway/proxy/types';
import { readJsonBody, type AdminGate } from './admin-gate';
import type { AccessKeys } from './access-keys';
import type { KeyAudit } from './key-audit';

export interface ReplicaSecretRotator {
  list(): Array<{ name: string }>;
  rotateReplicaSecret(name: string): Promise<{ deployment: string; pinnedReplicas: number }>;
}

/**
 * Gateway access managed at runtime (docs/api/http.md § Access): client/admin keys, the admin list, the SANDBOX_TOKEN
 * and the per-deployment replica secrets. Every route goes through the admin gate (admin key, rate limit, audit).
 */
export function createAccessRoutes(opts: {
  access: AccessKeys; gate: AdminGate; audit: KeyAudit; deployments?: ReplicaSecretRotator | null;
}): CustomRoute[] {
  const { access, gate, audit, deployments } = opts;
  const route = (method: string, path: string, action: string, run: Parameters<AdminGate['run']>[3]): CustomRoute => ({
    method, path, handler: (req, res) => gate.run(req, res, action, run),
  });
  return [
    route('GET', '/v1/admin/access/keys', 'access.keys.list', async () => ({ status: 200, body: { keys: access.list() } })),
    {
      method: 'POST', path: '/v1/admin/access/keys',
      handler: (req, res) => gate.run(req, res, 'access.keys.issue', async (actor, note) => {
        const body = await readJsonBody(req);
        note.names = [typeof body.replaces === 'string' ? body.replaces : 'new key'];
        const { key, view, replaced } = await access.issue(body, actor);
        return { status: 201, body: { key, ...view, replaced }, names: [view.id, ...(replaced ? [replaced.id] : [])] };
      }),
    },
    {
      method: 'POST', path: '/v1/admin/access/keys/revoke',
      handler: (req, res) => gate.run(req, res, 'access.keys.revoke', async (_actor, note) => {
        const body = await readJsonBody(req);
        note.names = typeof body.id === 'string' ? [body.id] : [];
        return { status: 200, body: await access.revoke(body.id) };
      }),
    },
    {
      method: 'PUT', path: '/v1/admin/access/keys/policy',
      handler: (req, res) => gate.run(req, res, 'access.keys.policy', async (_actor, note) => {
        const body = await readJsonBody(req);
        note.names = typeof body.id === 'string' ? [body.id] : [];
        return { status: 200, body: await access.setPolicy(body) };
      }),
    },
    route('GET', '/v1/admin/access/admins', 'access.admins.list', async () => ({ status: 200, body: { users: [...access.admins] } })),
    {
      method: 'PUT', path: '/v1/admin/access/admins',
      handler: (req, res) => gate.run(req, res, 'access.admins.set', async (actor, note) => {
        note.names = ['DEPLOYMENTS_ADMIN_USERS'];
        return { status: 200, body: { users: await access.setAdmins((await readJsonBody(req)).users, actor) } };
      }),
    },
    {
      method: 'PUT', path: '/v1/admin/access/sandbox-token',
      handler: (req, res) => gate.run(req, res, 'access.sandbox-token.rotate', async (_actor, note) => {
        note.names = ['SANDBOX_TOKEN'];
        const body = await readJsonBody(req);
        return { status: 200, body: { rotated: true, ...await access.rotateSandboxToken(body.token, body.overlapMinutes) } };
      }),
    },
    {
      method: 'POST', path: '/v1/admin/access/replica-secrets/rotate',
      handler: (req, res) => gate.run(req, res, 'access.replica-secrets.rotate', async (_actor, note) => {
        if (!deployments) return { status: 404, body: { error: { message: 'deployments are disabled on this gateway', type: 'invalid_request_error' } } };
        const body = await readJsonBody(req);
        if (body.deployment !== undefined && typeof body.deployment !== 'string') {
          return { status: 400, body: { error: { message: 'deployment must be a string', type: 'invalid_request_error' } } };
        }
        const names = typeof body.deployment === 'string' ? [body.deployment] : deployments.list().map(d => d.name);
        note.names = names;
        const rotated = [];
        for (const name of names) rotated.push(await deployments.rotateReplicaSecret(name));
        return { status: 200, body: { rotated } };
      }),
    },
    {
      method: 'GET', path: '/v1/admin/access/audit',
      handler: (req, res) => gate.run(req, res, 'access.audit', async () => {
        const limit = Number(new URL(req.url ?? '', 'http://x').searchParams.get('limit') ?? 100);
        return { status: 200, body: { entries: audit.recent(Number.isFinite(limit) ? limit : 100) } };
      }),
    },
  ];
}
