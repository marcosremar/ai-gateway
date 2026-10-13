import { randomBytes, timingSafeEqual } from 'crypto';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { accountPageCsp } from '../accounts/pages';
import { isCrossSite } from '../accounts/http';
import { AttemptLimiter } from '../accounts/rate-limit';
import { RateLimiter } from '../gateway/proxy/middleware/rate-limit';
import { redact } from '../telemetry/alert-email';
import type { ContainerLogView } from '../deployments/container-logs';
import type { AdminAlert, AdminSnapshot } from './render';
import { pageAt, renderGpuDetail, renderLogin, renderStatus } from './pages';
import { scopeToApp } from './scope';

export type { AdminAbout, AdminAlert, AdminApp, AdminSnapshot } from './render';
export { possibleSaving, recommendations, type Recommendation } from './recommendations';
export { createSuggestionDigest, digestMail, type DigestStatus } from './digest';
export { adminTraffic, type AdminTraffic } from './traffic';
export { scopeToApp } from './scope';
export { ANCHOR_PAGE, PAGES } from './pages';

export const ADMIN_ANCHORS = ['recomendacoes', 'garantia', 'gastos', 'cachevoz', 'reservas', 'saldos', 'gpus', 'alertas', 'maquinas', 'chaves', 'apps', 'trafego', 'atividade'] as const;

const ADMIN_SESSION_MS = 12 * 3_600_000;
export const ADMIN_COOKIE = '__Host-aigw_admin';
const LOGIN_LIMIT = { limit: 10, windowMs: 15 * 60_000 };
const BODY_MAX = 4096;
const ALERTS_KEPT = 50;
const APP_FILTER = /^[A-Za-z0-9._-]{1,64}$/;
const PAGE_PATH = /^\/admin(\/(servicos|gpus|gastos|chaves|atividade|gpus\/[a-z0-9][a-z0-9-]{0,39}))?$/;
const NEXT = /^\/admin(\/(servicos|gpus|gastos|chaves|atividade|gpus\/[a-z0-9][a-z0-9-]{0,39}))?(\?app=[A-Za-z0-9._-]{1,64})?(#[a-z][a-z0-9-]{0,40})?$/;
const GPU_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const RECO_ID = /^[a-z-]{1,32}(:[A-Za-z0-9._:/@ -]{1,200})?$/;

export interface AdminActor { name: string; app: string | null; keyId?: string; mayPark?: () => boolean }

export interface AdminPageOptions {
  actorOf: (key: string) => AdminActor | null;
  snapshot: () => AdminSnapshot;
  park: (deployment: string, actor: AdminActor) => Promise<unknown>;
  pin?: (deployment: string, on: boolean) => Promise<unknown>;
  probe: () => Promise<unknown>;
  dismiss?: (id: string) => Promise<unknown>;
  sendDigest?: () => Promise<string | null>;
  secrets?: () => string[];
  containerLog?: (deployment: string) => Promise<ContainerLogView | null>;
  audit?: (entry: { actor: string; action: string; names: string[]; ok: boolean; detail?: string }) => void;
  now?: () => number;
}

interface Session { actor: AdminActor; role: 'admin' | `app:${string}`; csrf: string; expiresAt: number }

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
      html(res, 401, n => renderLogin(n, 'Chave recusada: só a chave admin ou a chave de um app entra.', NEXT.test(next) ? next.replace(/#.*/, '') : '/admin'));
      return;
    }
    const token = randomBytes(32).toString('hex');
    const role = actor.app ? `app:${actor.app}` as const : 'admin';
    sessions.set(token, { actor, role, csrf: randomBytes(32).toString('hex'), expiresAt: now() + ADMIN_SESSION_MS });
    opts.audit?.({ actor: actor.name, action: 'admin-page.login', names: [], ok: true });
    redirect(res, NEXT.test(next) ? next : '/admin', { 'Set-Cookie': cookie(token, ADMIN_SESSION_MS / 1000) });
  }

  type Signed = { token: string; session: Session; form: URLSearchParams };

  function guarded(run: (res: ServerResponse, signed: Signed) => void | Promise<void>) {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const found = sessionOf(req);
      const form = await readForm(req);
      if (!found || !form || isCrossSite(req) || !sameToken(form.get('csrf'), found.session.csrf)) {
        html(res, 403, n => renderLogin(n, 'Sessão expirada ou pedido sem o token desta página. Entre de novo.'));
        return;
      }
      await run(res, { token: found.token, session: found.session, form });
    };
  }

  const backTo = (form: URLSearchParams, fallback: string, message: string, anchor = '') => {
    const back = form.get('back') ?? '';
    return `${PAGE_PATH.test(back) ? back : fallback}?msg=${encodeURIComponent(message)}${PAGE_PATH.test(back) ? '' : anchor}`;
  };

  const logout = guarded((res, { token }) => {
    sessions.delete(token);
    redirect(res, '/admin', { 'Set-Cookie': cookie('', 0) });
  });

  function refuse(res: ServerResponse, session: Session, action: string, names: string[]): void {
    opts.audit?.({ actor: session.actor.name, action, names, ok: false, detail: `recusado para ${session.role}` });
    html(res, 403, n => renderLogin(n, 'Esta ação não é permitida para esta chave.'));
  }

  function mayPark(session: Session, name: string): boolean {
    const app = session.actor.app;
    if (!app) return true;
    return Boolean(session.actor.mayPark?.()) && opts.snapshot().gpus?.find(d => d.name === name)?.app === app;
  }

  const probe = guarded((res, { session, form }) => {
    if (session.role !== 'admin') return refuse(res, session, 'admin-page.probe', []);
    opts.audit?.({ actor: session.actor.name, action: 'admin-page.probe', names: [], ok: true });
    void opts.probe().catch(() => {});
    redirect(res, backTo(form, '/admin/servicos', 'Teste das reservas iniciado; recarregue em 30 s.', '#reservas'));
  });

  const park = guarded(async (res, { session, form }) => {
    const name = form.get('name') ?? '';
    if (!mayPark(session, name)) return refuse(res, session, 'admin-page.park', [name]);
    const parked = await opts.park(name, session.actor).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
    opts.audit?.({ actor: session.actor.name, action: 'admin-page.park', names: [name], ok: !parked, ...(parked ? { detail: parked } : {}) });
    redirect(res, backTo(form, '/admin/gpus', parked ? `Falhou ao estacionar ${name}: ${parked}` : `${name} estacionada.`, '#gpus'));
  });

  const pin = guarded(async (res, { session, form }) => {
    const name = form.get('name') ?? '';
    const on = form.get('on') === '1';
    if (session.role !== 'admin' || !opts.pin) return refuse(res, session, 'admin-page.pin', [name]);
    const failed = await opts.pin(name, on).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
    opts.audit?.({ actor: session.actor.name, action: on ? 'admin-page.pin' : 'admin-page.unpin', names: [name], ok: !failed, ...(failed ? { detail: failed } : {}) });
    const done = on ? `${name} fixada: uma réplica fica ligada e estaciona após 1 h sem uso.` : `${name} solta: desliga quando ficar sem uso.`;
    redirect(res, backTo(form, '/admin/gpus', failed ? `Falhou ao ${on ? 'fixar' : 'soltar'} ${name}: ${failed}` : done, '#gpus'));
  });

  const dismiss = guarded(async (res, { session, form }) => {
    const id = form.get('id') ?? '';
    if (session.role !== 'admin' || !opts.dismiss) return refuse(res, session, 'admin-page.dismiss', [id]);
    if (!RECO_ID.test(id)) return redirect(res, '/admin#recomendacoes');
    await opts.dismiss(id);
    opts.audit?.({ actor: session.actor.name, action: 'admin-page.dismiss', names: [id], ok: true });
    redirect(res, backTo(form, '/admin', 'Recomendação oculta por 7 dias.', '#recomendacoes'));
  });

  const digest = guarded(async (res, { session, form }) => {
    if (session.role !== 'admin' || !opts.sendDigest) return refuse(res, session, 'admin-page.digest', []);
    const sent = await opts.sendDigest().then(id => (id ? null : 'o e-mail não saiu (veja o log do gateway)'), (err: unknown) => (err instanceof Error ? err.message : String(err)));
    opts.audit?.({ actor: session.actor.name, action: 'admin-page.digest', names: [], ok: !sent, ...(sent ? { detail: sent } : {}) });
    redirect(res, backTo(form, '/admin', sent ? `Resumo não enviado: ${sent}` : 'Resumo das sugestões enviado para o e-mail de alertas.', '#recomendacoes'));
  });

  function viewOf(req: IncomingMessage, found: { session: Session }) {
    const query = new URL(req.url ?? '/', 'http://x').searchParams;
    const app = query.get('app');
    const { actor, csrf } = found.session;
    return {
      snapshot: actor.app ? scopeToApp(opts.snapshot(), actor.app) : opts.snapshot(),
      render: { now: now(), csrf, actor: actor.name, message: query.get('msg'), app: app && APP_FILTER.test(app) ? app : null, view: actor.app ? { id: actor.app, canPark: Boolean(actor.mayPark?.()) } : null },
    };
  }

  function loginFor(req: IncomingMessage, res: ServerResponse): void {
    const [path, search = ''] = (req.url ?? '/admin').split('?');
    const app = new URLSearchParams(search).get('app');
    const next = `${path!.replace(/\/$/, '') || '/admin'}${app && APP_FILTER.test(app) ? `?app=${app}` : ''}`;
    html(res, 200, n => renderLogin(n, null, NEXT.test(next) ? next : '/admin'));
  }

  function status(req: IncomingMessage, res: ServerResponse): void {
    const found = sessionOf(req);
    if (!found) return loginFor(req, res);
    const page = pageAt((req.url ?? '/').split('?')[0]!.replace(/\/$/, '') || '/admin');
    const { snapshot, render } = viewOf(req, found);
    html(res, 200, n => renderStatus(n, snapshot, { ...render, page: page?.id ?? 'geral' }));
  }

  async function gpuDetail(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const found = sessionOf(req);
    if (!found) return loginFor(req, res);
    let name = '';
    try { name = decodeURIComponent((req.url ?? '').split('?')[0]!.slice('/admin/gpus/'.length).replace(/\/$/, '')); } catch { name = ''; }
    const { snapshot, render } = viewOf(req, found);
    if (!GPU_NAME.test(name) || !snapshot.gpus?.some(g => g.name === name)) return html(res, 404, n => renderLogin(n, 'GPU não encontrada para esta chave.'));
    const container = await opts.containerLog?.(name).catch(() => null) ?? null;
    html(res, 200, n => renderGpuDetail(n, snapshot, name, render, container)!);
  }

  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>([
    ['GET /admin', status], ['GET /admin/servicos', status], ['GET /admin/gpus', status], ['GET /admin/gastos', status], ['GET /admin/chaves', status],
    ['GET /admin/atividade', status], ['POST /admin/login', login],
    ['POST /admin/logout', logout], ['POST /admin/park', park], ['POST /admin/pin', pin], ['POST /admin/probe', probe], ['POST /admin/dismiss', dismiss], ['POST /admin/digest', digest],
  ]);

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const path = (req.url ?? '/').split('?')[0].replace(/\/$/, '');
    if (path !== '/admin' && !path.startsWith('/admin/')) return false;
    const handler = req.method === 'GET' && path.startsWith('/admin/gpus/') ? gpuDetail : routes.get(`${req.method} ${path}`);
    if (typeof handler !== 'function') {
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
