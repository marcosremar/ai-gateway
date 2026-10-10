import type { IncomingMessage, ServerResponse } from 'http';
import { APP_ID_RE } from '../deployments/apps';
import { requestIdOf } from '../gateway/proxy/http-conventions';
import { createLogger } from '../logger';
import type { MachineController } from './controller';
import { JOB_LOG_LIMIT, JOB_REPORT_PATH } from './job-script';
import { MachineError, parseJobInput, parseMachineInput } from './spec';

const log = createLogger('machines-http');
const MAX_BODY = 256 * 1024;
const ID_RE = /^[mj]-[0-9a-f]{12}$/;

export interface MachineRoutesOptions {
  controller: MachineController;
  userOf: (req: IncomingMessage) => string | null;
  isAdmin: (req: IncomingMessage) => boolean;
  allowedUsers: ReadonlySet<string>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new MachineError(413, `body larger than ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, MAX_BODY);
  if (!raw.length) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new MachineError(400, 'body must be JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MachineError(400, 'body must be a JSON object');
  return parsed as Record<string, unknown>;
}

export function createMachineRoutes(opts: MachineRoutesOptions) {
  const { controller } = opts;

  function caller(req: IncomingMessage): { owner: string; all: boolean } {
    const user = opts.userOf(req);
    const admin = opts.isAdmin(req);
    if (!user || (!admin && !opts.allowedUsers.has(user))) {
      throw new MachineError(403, 'this API key cannot rent machines (an admin key, or a user listed in MACHINES_USERS)');
    }
    const header = typeof req.headers['x-app'] === 'string' ? req.headers['x-app'].trim() : '';
    if (header) {
      if (!admin && header !== user) throw new MachineError(403, 'only an admin key may act for another app (X-App)');
      if (!APP_ID_RE.test(header)) throw new MachineError(400, `X-App must match ${APP_ID_RE}`);
      return { owner: header, all: false };
    }
    return { owner: user, all: admin };
  }

  function owned<T extends { owner: string }>(item: T | null, who: { owner: string; all: boolean }, what: string, id: string): T {
    if (!item || (!who.all && item.owner !== who.owner)) throw new MachineError(404, `${what} '${id}' not found`);
    return item;
  }

  async function machines(req: IncomingMessage, res: ServerResponse, parts: string[], method: string): Promise<void> {
    const who = caller(req);
    const [id, action] = parts;
    if (!id) {
      if (method === 'GET') {
        return send(res, 200, {
          namespace: controller.namespace, scope: who.all ? 'all' : 'owner', providers: controller.providers,
          machines: controller.list(who.all ? null : who.owner).map(m => controller.view(m)),
        });
      }
      if (method === 'POST') {
        const machine = await controller.create(who.owner, parseMachineInput(await readJson(req), controller.limits));
        return send(res, 201, controller.view(machine));
      }
      return send(res, 405, { error: 'method not allowed' });
    }
    if (id === 'costs' && method === 'GET') return send(res, 200, controller.costs(who.all ? null : who.owner));
    if (!ID_RE.test(id)) return send(res, 404, { error: 'not found' });
    const m = owned(controller.get(id), who, 'machine', id);
    if (!action && method === 'GET') return send(res, 200, controller.view(m));
    if (!action && method === 'DELETE') return send(res, 200, controller.view(await controller.release(id, 'deleted')));
    if (action === 'extend' && method === 'POST') {
      const body = await readJson(req);
      const hours = body.hours === undefined ? null : body.hours;
      if (hours !== null && (typeof hours !== 'number' || !(hours > 0) || hours > controller.limits.maxHours)) {
        throw new MachineError(400, `hours must be a number in (0, ${controller.limits.maxHours}]`);
      }
      return send(res, 200, controller.view(await controller.extend(id, hours)));
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  async function jobs(req: IncomingMessage, res: ServerResponse, parts: string[], method: string): Promise<void> {
    const who = caller(req);
    const [id, action] = parts;
    if (!id) {
      if (method === 'GET') return send(res, 200, { jobs: controller.jobs(who.all ? null : who.owner).map(j => controller.jobView(j)) });
      if (method === 'POST') {
        const body = await readJson(req);
        const job = parseJobInput(body);
        const input = parseMachineInput(body, controller.limits);
        return send(res, 201, controller.jobView(await controller.createJob(who.owner, input, job)));
      }
      return send(res, 405, { error: 'method not allowed' });
    }
    if (!ID_RE.test(id)) return send(res, 404, { error: 'not found' });
    const job = owned(controller.job(id), who, 'job', id);
    if (!action && method === 'GET') return send(res, 200, controller.jobView(job));
    if (!action && method === 'DELETE') return send(res, 200, controller.jobView(await controller.cancelJob(id)));
    if (action === 'logs' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(job.log);
      return;
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  return function handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): boolean {
    const [, v1, root, ...parts] = path.split('/');
    if (v1 !== 'v1' || (root !== 'machines' && root !== 'jobs')) return false;
    (root === 'machines' ? machines : jobs)(req, res, parts.filter(Boolean), method).catch((err: unknown) => {
      if (err instanceof MachineError) return send(res, err.status, { error: err.message });
      const requestId = requestIdOf(req.headers['x-request-id']);
      log.error({ requestId, path, error: err instanceof Error ? err.stack ?? err.message : String(err) }, 'machines route failed');
      send(res, 500, { error: 'internal error', requestId });
    });
    return true;
  };
}

const header = (req: IncomingMessage, name: string): string => {
  const v = req.headers[name];
  return typeof v === 'string' ? v.trim() : '';
};

const intOrNull = (raw: string): number | null => (/^\d{1,15}$/.test(raw) ? Number(raw) : null);

export function jobReportRoute(controller: MachineController) {
  return {
    method: 'POST', path: JOB_REPORT_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const status = header(req, 'x-job-status');
      const body = await readBody(req, JOB_LOG_LIMIT * 2).catch(() => null);
      const ok = body !== null && ['running', 'succeeded', 'failed'].includes(status) && await controller.report(header(req, 'x-job-id'), header(req, 'x-job-token'), {
        status, exitCode: intOrNull(header(req, 'x-job-exit')), log: body.toString('utf8'),
        bytes: intOrNull(header(req, 'x-job-result-bytes')), sha256: /^[0-9a-f]{64}$/.test(header(req, 'x-job-result-sha256')) ? header(req, 'x-job-result-sha256') : null,
      });
      send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
    },
  };
}
