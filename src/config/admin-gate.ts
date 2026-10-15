import { createHash } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { RateLimiter } from '../gateway/proxy/middleware/rate-limit';
import type { KeyAudit } from './key-audit';

export const ADMIN_KEY_ROUTES_RPM = 30;
const MAX_BODY = 64 * 1024;

export class AdminRouteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new AdminRouteError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new AdminRouteError(400, 'body must be JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AdminRouteError(400, 'body must be a JSON object');
  return parsed as Record<string, unknown>;
}

export interface AdminOutcome {
  status: number;
  body: unknown;
  names?: string[];
  ok?: boolean;
}

export class AdminGate {
  private readonly limiter: RateLimiter;

  constructor(private readonly opts: { actorOf: (bearer: string) => string | null; audit?: KeyAudit; rpm?: number }) {
    this.limiter = new RateLimiter(opts.rpm ?? ADMIN_KEY_ROUTES_RPM);
  }

  async run(
    req: IncomingMessage, res: ServerResponse, action: string,
    handler: (actor: string, note: { names: string[] }) => Promise<AdminOutcome>,
  ): Promise<void> {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const limit = this.limiter.check(`admin:${createHash('sha256').update(bearer).digest('hex')}`);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, limit.resetAt - Math.floor(Date.now() / 1000))));
      return sendJson(res, 429, { error: { message: 'too many key admin requests', type: 'rate_limit_error' } });
    }
    const actor = bearer ? this.opts.actorOf(bearer) : null;
    if (!actor) return sendJson(res, 403, { error: { message: 'this API key cannot manage gateway keys', type: 'permission_error' } });
    const note = { names: [] as string[] };
    let outcome: AdminOutcome;
    let detail: string | undefined;
    try {
      outcome = await handler(actor, note);
    } catch (err) {
      const typed = typeof (err as { status?: unknown }).status === 'number';
      const status = typed ? (err as { status: number }).status : 500;
      detail = typed ? (err as Error).message : 'key operation failed';
      outcome = { status, body: { error: { message: detail, type: status >= 500 ? 'server_error' : 'invalid_request_error' } }, ok: false };
    }
    if (req.method !== 'GET') {
      this.opts.audit?.record({ actor, action, names: outcome.names ?? note.names, ok: outcome.ok ?? outcome.status < 400, ...(detail ? { detail } : {}) });
    }
    sendJson(res, outcome.status, outcome.body);
  }
}
