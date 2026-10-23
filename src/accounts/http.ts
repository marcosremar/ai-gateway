// ── AI Gateway — ucast.me accounts: HTTP ─────────────────────────────────────
// Served in front of the proxy (index.ts `mount`), like the rooms: these routes authenticate themselves.
//   POST /v1/account/signup | /login | /logout | /password/forgot | /password/reset | /verify {token}
//   POST /v1/account/verify/resend, DELETE /v1/account/me {password}   (session cookie + CSRF)
//   POST /v1/account/billing/checkout {plan} | /portal | /sync   (session cookie + CSRF; Stripe, when configured)
//   POST /v1/billing/stripe/webhook   (Stripe-Signature)
//   GET  /v1/account/me | /usage        (session cookie, or an activation key as Bearer — read-only)
//   GET|POST /v1/account/keys, DELETE /v1/account/keys/:id (or POST …/:id/revoke)   (session cookie + CSRF)
//   POST /v1/activate {key, deviceName, appVersion}
//   Pages: on ACCOUNTS_SITE_HOSTS `/`, `/signup`, `/login`, `/forgot`, `/reset`, `/verify`, `/account`; on any host `/account[/…]`.
// And the quota gate: a metered request carrying an activation key is refused (402/429) when the account is over its
// quota or already has its limit of requests in flight, otherwise passed on to the proxy and counted when it succeeds.
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
  accountPageCsp, dashboardPage, forgotPage, homePage, loginPage, notFoundAccountPage, resetPage, signupPage, verifyPage,
  type PageLinks, type RenderedPage,
} from './pages';
import { ATTEMPT_LIMITS, AttemptLimiter, type Window } from './rate-limit';
import { pageLang } from './page-strings';
import type { BillingService } from './billing';
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    req.resume();
    throw new AccountError(415, 'Envie o corpo como JSON.', 'unsupported_media_type');
  }
  const text = await readText(req);
  try {
    const v: unknown = JSON.parse(text || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch { throw new AccountError(400, 'JSON inválido.', 'invalid_json'); }
}

function readText(req: IncomingMessage): Promise<string> {
  if (Number(req.headers['content-length'] ?? 0) > BODY_MAX) {
    req.resume();
    return Promise.reject(new AccountError(413, 'Pedido grande demais.', 'body_too_large'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (err: Error | null, value?: string) => {
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
    req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => finish(err));
  });
}

const hostOf = (req: IncomingMessage) => String(req.headers.host ?? '').trim().toLowerCase();
const hostName = (host: string) => host.replace(/:\d+$/, '');

/**
 * A browser request from another site (or a page we did not serve) is refused. Non-browser clients send neither header.
 * `trustedHosts` are our own site hosts (ucast.me proxies /login and /v1/account/* here, so its pages post with
 * Origin https://ucast.me while the Host is the gateway's).
 */
export function isCrossSite(req: IncomingMessage, trustedHosts: ReadonlySet<string> = new Set()): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return false;
  try {
    const host = new URL(origin).host.toLowerCase();
    return host !== hostOf(req) && !trustedHosts.has(hostName(host));
  } catch { return true; }
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
  /** Requests a realtime session is worth (the app budget's charge, `RealtimeService.sessionRequests`); default 1. */
  sessionRequests?: () => number;
  /** Stripe billing; null while STRIPE_SECRET_KEY is unset (no plan routes, no plan limits). */
  billing?: BillingService | null;
}

export function createAccountsHttp(opts: AccountsHttpOptions) {
  const { service, usage } = opts;
  const billing = opts.billing ?? null;
  const billingOn = (): BillingService => {
    if (!billing) throw new AccountError(503, 'Os planos pagos ainda não estão disponíveis.', 'billing_off');
    return billing;
  };
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
    if (isCrossSite(req, siteHosts) || !service.checkCsrf({ csrf: w.csrf! }, req.headers['x-csrf-token'])) {
      throw new AccountError(403, 'Sessão expirada nesta página. Recarregue e tente de novo.', 'csrf_failed');
    }
    return { user: w.user, token: w.token! };
  }

  function sameSiteForm(req: IncomingMessage): void {
    if (isCrossSite(req, siteHosts)) throw new AccountError(403, 'Pedido de outra origem recusado.', 'cross_site');
  }

  const meView = (user: User) => ({ email: user.email, plan: user.plan, createdAt: new Date(user.createdAt).toISOString(), downloadUrl: cfg.downloadUrl, admin: service.isAdminUser(user), emailVerified: !user.emailUnverified, billing: Boolean(billing) });

  async function api(req: IncomingMessage, res: ServerResponse, method: string, path: string): Promise<void> {
    const ip = RateLimiter.clientIp(req);
    const route = `${method} ${path.replace(/^\/v1\/account\/keys\/[^/]+/, '/v1/account/keys/:id').replace(/^\/v1\/account\/users\/[^/]+\/access-key$/, '/v1/account/users/:id/access-key')}`;
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
      case 'POST /v1/account/verify': {
        sameSiteForm(req);
        limit(`verify:ip:${ip}`, ATTEMPT_LIMITS.verifyPerIp);
        const body = await readJson(req);
        await service.verifyEmail(body.token);
        send(res, 200, { ok: true });
        return;
      }
      case 'POST /v1/account/verify/resend': {
        const w = writer(req);
        req.resume();
        limit(`verify:user:${w.user.id}`, ATTEMPT_LIMITS.verifyResendPerUser);
        await service.sendVerification(w.user);
        send(res, 200, { ok: true });
        return;
      }
      case 'POST /v1/account/billing/checkout': {
        const w = writer(req);
        const body = await readJson(req);
        send(res, 200, { url: await billingOn().checkout(w.user, body.plan) });
        return;
      }
      case 'POST /v1/account/billing/portal': {
        const w = writer(req);
        req.resume();
        send(res, 200, { url: await billingOn().portal(w.user) });
        return;
      }
      case 'POST /v1/account/billing/sync': {
        const w = writer(req);
        req.resume();
        await billingOn().sync(w.user);
        send(res, 200, { ...meView(w.user), quota: service.quotaView(w.user) });
        return;
      }
      case 'POST /v1/billing/stripe/webhook': {
        await billingOn().webhook(await readText(req), req.headers['stripe-signature'] as string | undefined);
        send(res, 200, { received: true });
        return;
      }
      case 'DELETE /v1/account/me': {
        const w = writer(req);
        limit(`delete:user:${w.user.id}`, ATTEMPT_LIMITS.deletePerUser);
        const body = await readJson(req);
        await service.checkPassword(w.user, body.password);
        await billing?.forget(w.user);
        await service.deleteAccount(w.user, body.password);
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
      case 'GET /v1/account/users': {
        const w = who(req, false);
        if (!service.isAdminUser(w.user)) throw new AccountError(403, 'Esta área é só da administração.', 'not_admin');
        send(res, 200, { users: service.listUsers() });
        return;
      }
      case 'POST /v1/account/users/:id/access-key': {
        const m = /^\/v1\/account\/users\/([A-Za-z0-9_]{1,64})\/access-key$/.exec(path);
        if (!m) break;
        const w = writer(req);
        if (!service.isAdminUser(w.user)) throw new AccountError(403, 'Esta área é só da administração.', 'not_admin');
        limit(`admin:ip:${ip}`, ATTEMPT_LIMITS.resetPerIp);
        const body = await readJson(req);
        const { email } = await service.sendAccessKey(m[1]!, body.deviceName);
        send(res, 200, { ok: true, email });
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
    return { home: site ? '/' : '/account', signup: `${p}/signup`, login: `${p}/login`, forgot: `${p}/forgot`, reset: `${p}/reset`, verify: `${p}/verify`, account: '/account', download: cfg.downloadUrl,
      lang: pageLang(parseCookies(req.headers.cookie).get('ucast_lang'), req.headers['accept-language']) };
  }

  const PAGES: Partial<Record<string, (l: PageLinks) => RenderedPage>> = {
    '/signup': signupPage, '/login': loginPage, '/forgot': forgotPage, '/reset': resetPage, '/verify': verifyPage, '': dashboardPage,
  };

  function page(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    const site = siteHosts.has(hostName(hostOf(req)));
    const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
    if (site && clean === '/') { sendPage(res, 200, homePage(links(req))); return true; }
    let sub: string | null = null;
    if (clean === '/account' || clean.startsWith('/account/')) sub = clean.slice('/account'.length);
    else if (site && ['/signup', '/login', '/forgot', '/reset', '/verify'].includes(clean)) sub = clean;
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

  const inFlight = new Map<string, number>();

  function gate(req: IncomingMessage, res: ServerResponse, method: string, path: string): boolean {
    if (method !== 'POST') return false;
    const metered = METERED[path];
    const bearer = bearerToken(req.headers.authorization);
    if (!metered || !bearer.startsWith(KEY_PREFIX)) return false;
    const found = service.keyOf(bearer);
    if (!found) return false; // the proxy answers 401
    const internal = isInternalSubrequest(req.headers[SUBREQUEST_HEADER], req.socket?.remoteAddress);
    const requests = path === '/v1/realtime/sessions' ? Math.max(1, opts.sessionRequests?.() ?? 1) : 1;
    if (!internal) {
      const denial = service.checkQuota(found.user, metered.metrics, requests) ?? admitInFlight(found.user);
      if (denial) { req.resume(); sendError(res, denial); return true; }
      res.on('close', () => {
        const n = (inFlight.get(found.user.id) ?? 1) - 1;
        if (n > 0) inFlight.set(found.user.id, n); else inFlight.delete(found.user.id);
      });
    }
    res.on('finish', () => {
      if (internal || res.statusCode >= 400) return;
      const delta: Partial<Counters> = { requests };
      if (metered.counter) delta[metered.counter] = 1;
      if (path === '/v1/rooms' && res.statusCode === 201) delta.rooms = 1;
      usage.record(found.user.id, found.key.id, delta);
    });
    return false;
  }

  /** Takes one of the account's in-flight slots (released when the response closes), or refuses with 429. */
  function admitInFlight(user: User): AccountError | null {
    const limit = service.limitsOf(user).concurrentRequests;
    const n = inFlight.get(user.id) ?? 0;
    if (limit > 0 && n >= limit) {
      return new AccountError(429, `Sua conta já tem ${limit} pedidos em andamento. Aguarde um terminar e tente de novo.`,
        'account_concurrency_exceeded', { scope: 'account', limit, retryAfterSeconds: 1 });
    }
    inFlight.set(user.id, n + 1);
    return null;
  }

  /** Serves the request when it is an accounts route or a refused metered one (true); false = the proxy gets it. */
  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = (req.url ?? '/').split('?')[0]!;
    if (path.startsWith('/v1/account/') || path === '/v1/activate' || path === '/v1/billing/stripe/webhook') {
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

  /**
   * A streaming STT session (`GET /v1/audio/transcriptions/stream`) of an activation key: admitted like a metered request
   * (the `audioSeconds` monthly quota and the daily request cap), its audio added to the account as it streams (`add`
   * says when the monthly quota is now over: the stream ends), and counted as one request and one STT request when it
   * ends. `null` = not an activation key, or an unknown one (the proxy's own key check answers).
   */
  function streamMeter(authorization: string | undefined): { denial: StreamDenial } | {
    add(audioSeconds: number): StreamDenial | null; end(): void;
  } | null {
    const bearer = bearerToken(authorization);
    if (!bearer.startsWith(KEY_PREFIX)) return null;
    const found = service.keyOf(bearer);
    if (!found) return null;
    const refused = service.checkQuota(found.user, ['audioSeconds']);
    if (refused) return { denial: denialOf(refused) };
    let ended = false;
    return {
      add(audioSeconds: number): StreamDenial | null {
        if (audioSeconds > 0) usage.record(found.user.id, found.key.id, { audioSeconds });
        const over = service.checkQuota(found.user, ['audioSeconds'], 0);
        return over ? denialOf(over) : null;
      },
      end(): void {
        if (ended) return;
        ended = true;
        usage.record(found.user.id, found.key.id, { requests: 1, sttRequests: 1 });
      },
    };
  }

  return { handle, recordInference, cookieName, streamMeter };
}

/** A refusal of a streaming session, in the shape the stream route answers before its handshake. */
export interface StreamDenial { status: number; message: string; type: string; code: string; retryAfterSeconds?: number }

function denialOf(err: AccountError): StreamDenial {
  const { retryAfterSeconds } = err.extra as { retryAfterSeconds?: number };
  const type = err.status === 402 ? 'quota_exceeded' : err.status === 429 ? 'rate_limit_error' : err.status === 401 ? 'authentication_error'
    : err.status === 403 ? 'permission_error' : err.status >= 500 ? 'server_error' : 'invalid_request_error';
  return { status: err.status, message: err.message, type, code: err.code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
}
