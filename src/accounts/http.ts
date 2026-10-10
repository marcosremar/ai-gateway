// ── AI Gateway — ucast.me accounts: HTTP ─────────────────────────────────────
// Served in front of the proxy (index.ts `mount`), like the rooms: these routes authenticate themselves.
//   POST /v1/account/signup | /login | /logout | /password/forgot | /password/reset
//   GET  /v1/account/me | /usage        (session cookie, or an activation key as Bearer — read-only)
//   GET|POST /v1/account/keys, DELETE /v1/account/keys/:id (or POST …/:id/revoke)   (session cookie + CSRF)
//   POST /v1/activate {key, deviceName, appVersion}
//   Pages: on ACCOUNTS_SITE_HOSTS `/`, `/signup`, `/login`, `/forgot`, `/reset`, `/account`; on any host `/account[/…]`.
// And the quota gate: a metered request carrying an activation key is refused (402/429) when the account is over its
// quota, otherwise passed on to the proxy and counted when it succeeds.
//
// Cookie-authenticated writes need the session's CSRF token in `X-CSRF-Token` and a same-origin request (Origin /
// Sec-Fetch-Site); the unauthenticated JSON forms (signup, login, reset) need the same-origin check and a JSON body,
// which a cross-site HTML form cannot send. No CORS headers are ever sent on these routes.

import type { IncomingMessage, ServerResponse } from 'http';
import { RateLimiter } from '../gateway/proxy/middleware/rate-limit';
import { bearerToken } from '../gateway/proxy/middleware/api-keys';
import { isInternalSubrequest, SUBREQUEST_HEADER } from '../gateway/proxy/internal-subrequest';
import type { QuotaMetric } from './config';
import {
  accountPageCsp, dashboardPage, forgotPage, homePage, loginPage, notFoundAccountPage, resetPage, signupPage,
  type PageLinks, type RenderedPage,
} from './pages';
import { ATTEMPT_LIMITS, AttemptLimiter, type Window } from './rate-limit';
import { AccountError, KEY_PREFIX, normalizeEmail, type AccountService, type User } from './service';
import { audioSecondsOf, llmTokensOf, wavSeconds, type Counter, type Counters, type UsageMeter } from './usage';

const BODY_MAX = 16 * 1024;
const BODY_TIMEOUT_MS = 15_000;

const API_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

/** What each metered route counts and which monthly limits it is admitted against. */
const METERED: Record<string, { counter?: Counter; metrics: QuotaMetric[] }> = {
  '/v1/chat/completions': { counter: 'llmRequests', metrics: ['llmTokens'] },
  '/v1/audio/transcriptions': { counter: 'sttRequests', metrics: ['audioSeconds'] },
  '/v1/audio/speech': { counter: 'ttsRequests', metrics: ['ttsChars'] },
  '/v1/rooms': { metrics: ['rooms'] },
  '/v1/s2s': { metrics: ['audioSeconds', 'llmTokens', 'ttsChars'] },
  '/v1/realtime/sessions': { metrics: ['audioSeconds', 'llmTokens', 'ttsChars'] },
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | number | string[]> = {}): void {
  if (res.headersSent) { res.end(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, { ...API_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendError(res: ServerResponse, err: AccountError, headers: Record<string, string | number | string[]> = {}): void {
  const { retryAfterSeconds, ...extra } = err.extra as { retryAfterSeconds?: number };
  const type = err.status === 402 ? 'quota_exceeded' : err.status === 429 ? 'rate_limit_error' : err.status === 401 ? 'authentication_error'
    : err.status === 403 ? 'permission_error' : err.status >= 500 ? 'server_error' : 'invalid_request_error';
  send(res, err.status, { error: { message: err.message, type, code: err.code, ...extra } },
    { ...(retryAfterSeconds ? { 'Retry-After': retryAfterSeconds } : {}), ...headers });
}

function sendPage(res: ServerResponse, status: number, page: RenderedPage): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(page.html),
    'Content-Security-Policy': accountPageCsp(page.nonce), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  });
  res.end(page.html);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    req.resume();
    return Promise.reject(new AccountError(415, 'Envie o corpo como JSON.', 'unsupported_media_type'));
  }
  if (Number(req.headers['content-length'] ?? 0) > BODY_MAX) {
    req.resume();
    return Promise.reject(new AccountError(413, 'Pedido grande demais.', 'body_too_large'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (err: Error | null, value?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new AccountError(408, 'Tempo esgotado ao ler o pedido.', 'body_timeout')), BODY_TIMEOUT_MS);
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_MAX) { finish(new AccountError(413, 'Pedido grande demais.', 'body_too_large')); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        finish(null, v as Record<string, unknown>);
      } catch { finish(new AccountError(400, 'JSON inválido.', 'invalid_json')); }
    });
    req.on('error', (err) => finish(err));
  });
}

const hostOf = (req: IncomingMessage) => String(req.headers.host ?? '').trim().toLowerCase();
const hostName = (host: string) => host.replace(/:\d+$/, '');

/** A browser request from another site (or a page we did not serve) is refused. Non-browser clients send neither header. */
export function isCrossSite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return false;
  try { return new URL(origin).host.toLowerCase() !== hostOf(req); } catch { return true; }
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

export interface AccountsHttpOptions {
  service: AccountService;
  usage: UsageMeter;
  limiter?: AttemptLimiter;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export function createAccountsHttp(opts: AccountsHttpOptions) {
  const { service, usage } = opts;
  const cfg = service.config;
  const limiter = opts.limiter ?? new AttemptLimiter(service.now);
  const log = opts.log ?? (() => {});
  const cookieName = cfg.cookieSecure ? '__Host-ucast_sid' : 'ucast_sid';
  const siteHosts = new Set(cfg.siteHosts);

  const cookie = (token: string, maxAgeS: number) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${cfg.cookieSecure ? '; Secure' : ''}`;
  const sessionToken = (req: IncomingMessage) => {
    const v = parseCookies(req.headers.cookie).get(cookieName);
    return v && /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : null;
  };

  function limit(bucket: string, w: Window): void {
    const wait = limiter.hit(bucket, w);
    if (wait) throw new AccountError(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.', 'too_many_attempts', { retryAfterSeconds: wait });
  }

  /** The signed-in user: session cookie, or (read-only routes) an activation key. */
  function who(req: IncomingMessage, allowKey: boolean): { user: User; csrf: string | null; token: string | null } {
    const bearer = bearerToken(req.headers.authorization);
    if (allowKey && bearer.startsWith(KEY_PREFIX)) {
      const found = service.keyOf(bearer);
      if (found) return { user: found.user, csrf: null, token: null };
      throw new AccountError(401, 'Chave de ativação inválida ou revogada.', 'invalid_key');
    }
    const s = service.sessionOf(sessionToken(req));
    if (!s) throw new AccountError(401, 'Entre na sua conta para continuar.', 'not_signed_in');
    return { user: s.user, csrf: s.csrf, token: s.token };
  }

  /** A cookie-authenticated write: same-origin and the session's CSRF token. */
  function writer(req: IncomingMessage): { user: User; token: string } {
    const w = who(req, false);
    if (isCrossSite(req) || !service.checkCsrf({ csrf: w.csrf! }, req.headers['x-csrf-token'])) {
      throw new AccountError(403, 'Sessão expirada nesta página. Recarregue e tente de novo.', 'csrf_failed');
    }
    return { user: w.user, token: w.token! };
  }

  function sameSiteForm(req: IncomingMessage): void {
    if (isCrossSite(req)) throw new AccountError(403, 'Pedido de outra origem recusado.', 'cross_site');
  }

  const meView = (user: User) => ({ email: user.email, plan: user.plan, createdAt: new Date(user.createdAt).toISOString(), downloadUrl: cfg.downloadUrl });

  async function api(req: IncomingMessage, res: ServerResponse, method: string, path: string): Promise<void> {
    const ip = RateLimiter.clientIp(req);
    const route = `${method} ${path.replace(/^\/v1\/account\/keys\/[^/]+/, '/v1/account/keys/:id')}`;
    switch (route) {
      case 'POST /v1/account/signup': {
        sameSiteForm(req);
        limit(`signup:ip:${ip}`, ATTEMPT_LIMITS.signupPerIp);
        const body = await readJson(req);
        const { user, session } = await service.signup(body.email, body.password);
        send(res, 201, { ...meView(user), csrfToken: session.csrf }, { 'Set-Cookie': cookie(session.token, Math.floor(cfg.sessionTtlMs / 1000)) });
        return;
      }
      case 'POST /v1/account/login': {
        sameSiteForm(req);
        const body = await readJson(req);
        const email = normalizeEmail(body.email) ?? 'invalid';
        limit(`login:ip:${ip}`, ATTEMPT_LIMITS.loginPerIp);
        limit(`login:email:${email}`, ATTEMPT_LIMITS.loginPerEmail);
        const { user, session } = await service.login(body.email, body.password);
        limiter.clear(`login:email:${email}`);
        send(res, 200, { ...meView(user), csrfToken: session.csrf }, { 'Set-Cookie': cookie(session.token, Math.floor(cfg.sessionTtlMs / 1000)) });
        return;
      }
      case 'POST /v1/account/logout': {
        // Ending one's own session needs no CSRF token, but never from another site.
        sameSiteForm(req);
        req.resume();
        await service.logout(sessionToken(req));
        send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
        return;
      }
      case 'POST /v1/account/password/forgot': {
        sameSiteForm(req);
        const body = await readJson(req);
        limit(`reset:ip:${ip}`, ATTEMPT_LIMITS.resetPerIp);
        const email = normalizeEmail(body.email);
        // Over the per-e-mail limit: same answer, nothing sent (no enumeration, no mail bombing).
        if (email && !limiter.hit(`reset:email:${email}`, ATTEMPT_LIMITS.resetPerEmail)) await service.requestReset(email);
        send(res, 200, { ok: true });
        return;
      }
      case 'POST /v1/account/password/reset': {
        sameSiteForm(req);
        const body = await readJson(req);
        limit(`reset:ip:${ip}`, ATTEMPT_LIMITS.resetPerIp);
        await service.resetPassword(body.token, body.password);
        send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
        return;
      }
      case 'GET /v1/account/me': {
        const w = who(req, true);
        send(res, 200, { ...meView(w.user), ...(w.csrf ? { csrfToken: w.csrf } : {}), quota: service.quotaView(w.user) });
        return;
      }
      case 'GET /v1/account/usage': {
        const w = who(req, true);
        const days = Math.min(400, Math.max(1, Math.floor(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('days') ?? 30)) || 30));
        const report = usage.report(w.user.id, days);
        const keys = service.listKeys(w.user.id);
        send(res, 200, {
          quota: service.quotaView(w.user), days: report.days,
          byKey: keys.map(k => ({ id: k.id, prefix: k.prefix, deviceName: k.deviceName, active: k.active, ...(report.byKey[k.id] ?? {}) })),
        });
        return;
      }
      case 'GET /v1/account/keys': {
        const w = who(req, false);
        send(res, 200, { keys: service.listKeys(w.user.id) });
        return;
      }
      case 'POST /v1/account/keys': {
        const w = writer(req);
        const body = await readJson(req);
        const { key, view } = await service.createKey(w.user.id, body.deviceName);
        send(res, 201, { key, ...view });
        return;
      }
      case 'DELETE /v1/account/keys/:id':
      case 'POST /v1/account/keys/:id/revoke': {
        const m = /^\/v1\/account\/keys\/([A-Za-z0-9_]{1,64})(\/revoke)?$/.exec(path);
        if (!m || (method === 'POST') !== Boolean(m[2])) break;
        const w = writer(req);
        req.resume();
        send(res, 200, await service.revokeKey(w.user.id, m[1]!));
        return;
      }
      case 'POST /v1/activate': {
        limit(`activate:ip:${ip}`, ATTEMPT_LIMITS.activatePerIp);
        const body = await readJson(req);
        const { user } = await service.activate(body.key, body.deviceName, body.appVersion);
        const q = service.quotaView(user);
        send(res, 200, { ok: true, email: user.email, plan: user.plan, quota: { limits: q.limits, month: q.month, monthResetsAt: q.monthResetsAt } });
        return;
      }
      default: break;
    }
    req.resume();
    throw new AccountError(404, 'Rota não encontrada.', 'not_found');
  }

  function links(req: IncomingMessage): PageLinks {
    const site = siteHosts.has(hostName(hostOf(req)));
    const p = site ? '' : '/account';
    return { home: site ? '/' : '/account', signup: `${p}/signup`, login: `${p}/login`, forgot: `${p}/forgot`, reset: `${p}/reset`, account: '/account', download: cfg.downloadUrl };
  }

  const PAGES: Partial<Record<string, (l: PageLinks) => RenderedPage>> = {
    '/signup': signupPage, '/login': loginPage, '/forgot': forgotPage, '/reset': resetPage, '': dashboardPage,
  };

  function page(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    const site = siteHosts.has(hostName(hostOf(req)));
    const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
    if (site && clean === '/') { sendPage(res, 200, homePage(links(req))); return true; }
    let sub: string | null = null;
    if (clean === '/account' || clean.startsWith('/account/')) sub = clean.slice('/account'.length);
    else if (site && ['/signup', '/login', '/forgot', '/reset'].includes(clean)) sub = clean;
    if (sub === null) return false;
    const render = Object.hasOwn(PAGES, sub) ? PAGES[sub] : undefined;
    sendPage(res, render ? 200 : 404, (render ?? notFoundAccountPage)(links(req)));
    return true;
  }

  const fail = (res: ServerResponse, err: unknown) => {
    if (err instanceof AccountError) { sendError(res, err); return; }
    log('accounts: request failed', { error: err instanceof Error ? err.message : String(err) });
    sendError(res, new AccountError(500, 'Erro interno. Tente de novo em instantes.', 'internal_error'));
  };

  // ── Quota gate + request counting ─────────────────────────────────────────

  function gate(req: IncomingMessage, res: ServerResponse, method: string, path: string): boolean {
    if (method !== 'POST') return false;
    const metered = METERED[path];
    const bearer = bearerToken(req.headers.authorization);
    if (!metered || !bearer.startsWith(KEY_PREFIX)) return false;
    const found = service.keyOf(bearer);
    if (!found) return false; // the proxy answers 401
    const internal = isInternalSubrequest(req.headers[SUBREQUEST_HEADER], req.socket?.remoteAddress);
    if (!internal) {
      const denial = service.checkQuota(found.user, metered.metrics);
      if (denial) { req.resume(); sendError(res, denial); return true; }
    }
    res.on('finish', () => {
      if (internal || res.statusCode >= 400) return;
      const delta: Partial<Counters> = { requests: 1 };
      if (metered.counter) delta[metered.counter] = 1;
      if (path === '/v1/rooms' && res.statusCode === 201) delta.rooms = 1;
      usage.record(found.user.id, found.key.id, delta);
    });
    return false;
  }

  /** Serves the request when it is an accounts route or a refused metered one (true); false = the proxy gets it. */
  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = (req.url ?? '/').split('?')[0]!;
    if (path.startsWith('/v1/account/') || path === '/v1/activate') {
      if (method === 'OPTIONS') { req.resume(); res.writeHead(204, API_HEADERS); res.end(); return true; }
      api(req, res, method, path).catch((err: unknown) => fail(res, err));
      return true;
    }
    if ((method === 'GET' || method === 'HEAD') && page(req, res, path)) return true;
    return gate(req, res, method, path);
  }

  /**
   * The proxy's hook after an inference request was served (`onInference`): adds what was consumed — audio seconds,
   * LLM tokens, TTS characters and seconds — to the account of the activation key that made it.
   */
  function recordInference(e: { headers: Record<string, unknown>; kind: string; body: unknown; rawBody: Buffer; status: number; response: unknown }): void {
    if (e.status >= 400) return;
    const bearer = bearerToken(typeof e.headers.authorization === 'string' ? e.headers.authorization : undefined);
    if (!bearer.startsWith(KEY_PREFIX)) return;
    const found = service.keyOf(bearer);
    if (!found) return;
    const fields = e.body && typeof e.body === 'object' && !Array.isArray(e.body) ? e.body as Record<string, unknown> : {};
    const delta: Partial<Counters> = {};
    if (e.kind === 'stt') delta.audioSeconds = audioSecondsOf(e.rawBody, e.response);
    else if (e.kind === 'chat') delta.llmTokens = llmTokensOf(fields, e.response);
    else if (e.kind === 'tts') {
      delta.ttsChars = typeof fields.input === 'string' ? fields.input.length : 0;
      if (Buffer.isBuffer(e.response)) delta.ttsSeconds = wavSeconds(e.response) ?? 0;
    } else return;
    usage.record(found.user.id, found.key.id, delta);
  }

  return { handle, recordInference, cookieName };
}
