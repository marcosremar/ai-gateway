import { randomBytes, timingSafeEqual } from 'crypto';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { accountPageCsp } from '../accounts/pages';
import { isCrossSite } from '../accounts/http';
import { AttemptLimiter } from '../accounts/rate-limit';
import { RateLimiter } from '../gateway/proxy/middleware/rate-limit';
import { redact } from '../telemetry/alert-email';
import { renderLogin, renderStatus, type AdminAlert, type AdminSnapshot } from './render';

export type { AdminAlert, AdminApp, AdminSnapshot } from './render';

export const ADMIN_ANCHORS = ['reservas', 'saldos', 'gpus', 'alertas', 'maquinas', 'chaves', 'apps'] as const;

const ADMIN_SESSION_MS = 12 * 3_600_000;
export const ADMIN_COOKIE = '__Host-aigw_admin';
const LOGIN_LIMIT = { limit: 10, windowMs: 15 * 60_000 };
const BODY_MAX = 4096;
const ALERTS_KEPT = 50;
const APP_FILTER = /^[A-Za-z0-9._-]{1,64}$/;
const NEXT = /^\/admin(\?app=[A-Za-z0-9._-]{1,64})?(#[a-z]{1,16})?$/;

export interface AdminPageOptions {
  actorOf: (key: string) => string | null;
  snapshot: () => AdminSnapshot;
  park: (deployment: string) => Promise<unknown>;
  probe: () => Promise<unknown>;
  secrets?: () => string[];
  audit?: (entry: { actor: string; action: string; names: string[]; ok: boolean; detail?: string }) => void;
  now?: () => number;
}

interface Session { actor: string; csrf: string; expiresAt: number }

export function createAlertLog() {
  const alerts: AdminAlert[] = [];
  return {
    record(event: string, data: Record<string, unknown>, at = new Date().toISOString()): void {
      const summary = Object.entries(data).filter(([k]) => k !== 'at').map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
      alerts.unshift({ event, at, summary: summary.slice(0, 300) });
      alerts.length = Math.min(alerts.length, ALERTS_KEPT);
    },
    list: (): AdminAlert[] => [...alerts],
  };
}

function cookieOf(req: IncomingMessage): string | null {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === ADMIN_COOKIE && value && /^[a-f0-9]{64}$/.test(value)) return value;
  }
  return null;
}

function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
    req.resume();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= BODY_MAX) chunks.push(c);
    });
    req.on('end', () => resolve(size > BODY_MAX ? null : new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', () => resolve(null));
  });
}

function sameToken(given: string | null | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAdminPage(opts: AdminPageOptions) {
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, Session>();
  const limiter = new AttemptLimiter(now);

  const cookie = (token: string, maxAgeS: number) => `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeS}`;

  function sessionOf(req: IncomingMessage): { token: string; session: Session } | null {
    const token = cookieOf(req);
    const session = token ? sessions.get(token) : undefined;
    if (!token || !session) return null;
    if (session.expiresAt <= now()) {
      sessions.delete(token);
      return null;
    }
    return { token, session };
  }

  function html(res: ServerResponse, status: number, render: (nonce: string) => string, headers: Record<string, string> = {}): void {
    const nonce = randomBytes(16).toString('base64');
    const body = redact(render(nonce), opts.secrets?.() ?? []);
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Content-Security-Policy': accountPageCsp(nonce),
      'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', ...headers,
    });
    res.end(body);
  }

  const redirect = (res: ServerResponse, to: string, headers: Record<string, string> = {}) => {
    res.writeHead(303, { Location: to, 'Cache-Control': 'no-store', ...headers });
    res.end();
  };

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (isCrossSite(req)) {
      req.resume();
      html(res, 403, n => renderLogin(n, 'Pedido de outra origem recusado.'));
      return;
    }
    if (limiter.hit(`admin-login:${RateLimiter.clientIp(req)}`, LOGIN_LIMIT)) {
      req.resume();
      html(res, 429, n => renderLogin(n, 'Muitas tentativas. Aguarde 15 minutos.'));
      return;
    }
    const form = await readForm(req);
    const key = form?.get('key')?.trim() ?? '';
    const next = form?.get('next') ?? '';
    const actor = key ? opts.actorOf(key) : null;
    if (!actor) {
      html(res, 401, n => renderLogin(n, 'Chave recusada: só uma chave admin entra.', NEXT.test(next) ? next.replace(/#.*/, '') : '/admin'));
      return;
    }
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { actor, csrf: randomBytes(32).toString('hex'), expiresAt: now() + ADMIN_SESSION_MS });
    opts.audit?.({ actor, action: 'admin-page.login', names: [], ok: true });
    redirect(res, NEXT.test(next) ? next : '/admin', { 'Set-Cookie': cookie(token, ADMIN_SESSION_MS / 1000) });
  }

  type Signed = { token: string; actor: string; form: URLSearchParams };

  function guarded(run: (res: ServerResponse, signed: Signed) => void | Promise<void>) {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const found = sessionOf(req);
      const form = await readForm(req);
      if (!found || !form || isCrossSite(req) || !sameToken(form.get('csrf'), found.session.csrf)) {
        html(res, 403, n => renderLogin(n, 'Sessão expirada ou pedido sem o token desta página. Entre de novo.'));
        return;
      }
      await run(res, { token: found.token, actor: found.session.actor, form });
    };
  }

  const logout = guarded((res, { token }) => {
    sessions.delete(token);
    redirect(res, '/admin', { 'Set-Cookie': cookie('', 0) });
  });

  const probe = guarded((res, { actor }) => {
    opts.audit?.({ actor, action: 'admin-page.probe', names: [], ok: true });
    void opts.probe().catch(() => {});
    redirect(res, `/admin?msg=${encodeURIComponent('Teste das reservas iniciado; recarregue em 30 s.')}#reservas`);
  });

  const park = guarded(async (res, { actor, form }) => {
    const name = form.get('name') ?? '';
    const parked = await opts.park(name).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
    opts.audit?.({ actor, action: 'admin-page.park', names: [name], ok: !parked, ...(parked ? { detail: parked } : {}) });
    redirect(res, `/admin?msg=${encodeURIComponent(parked ? `Falhou ao estacionar ${name}: ${parked}` : `${name} estacionada.`)}#gpus`);
  });

  function status(req: IncomingMessage, res: ServerResponse): void {
    const query = new URL(req.url ?? '/', 'http://x').searchParams;
    const app = query.get('app');
    const appFilter = app && APP_FILTER.test(app) ? app : null;
    const found = sessionOf(req);
    if (!found) {
      html(res, 200, n => renderLogin(n, null, appFilter ? `/admin?app=${appFilter}` : '/admin'));
      return;
    }
    const message = query.get('msg');
    const snapshot = opts.snapshot();
    html(res, 200, n => renderStatus(n, snapshot, { now: now(), csrf: found.session.csrf, actor: found.session.actor, message, app: appFilter }));
  }

  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>([
    ['GET /admin', status], ['POST /admin/login', login],
    ['POST /admin/logout', logout], ['POST /admin/park', park], ['POST /admin/probe', probe],
  ]);

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const path = (req.url ?? '/').split('?')[0].replace(/\/$/, '');
    if (path !== '/admin' && !path.startsWith('/admin/')) return false;
    const handler = routes.get(`${req.method} ${path}`);
    if (!handler) {
      req.resume();
      redirect(res, '/admin');
      return true;
    }
    void Promise.resolve(handler(req, res)).catch(() => { if (!res.headersSent) html(res, 500, n => renderLogin(n, 'Erro interno.')); });
    return true;
  }

  function mount(server: Server): void {
    const listeners = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
    server.removeAllListeners('request');
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      if (handle(req, res)) return;
      for (const l of listeners) l.call(server, req, res);
    });
  }

  return { handle, mount };
}
