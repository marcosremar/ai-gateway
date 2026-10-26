import { createHmac } from 'crypto';
/**
 * ucast.me accounts (src/accounts, docs/accounts.md) in front of the REAL proxy server (createProxyServer), wired as
 * serve.ts does: a key registry made of the access keys + the activation keys, the admin access routes, per-app limits,
 * a fake STT/LLM provider, the `onInference` hook and `createAccounts(...).mount` placed in front.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { request, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import { createEmailSender } from '../../../src/accounts/email';
import { AppLimits } from '../../../src/gateway/proxy/app-limits';
import { AccessKeys } from '../../../src/config/access-keys';
import { AdminGate } from '../../../src/config/admin-gate';
import { createAccessRoutes } from '../../../src/config/access-routes';
import { KeyAudit } from '../../../src/config/key-audit';
import { createCouponRoutes } from '../../../src/accounts/coupon-routes';
import { createAccounts, hashPassword, verifyPassword, wavSeconds, type AccountsConfig } from '../../../src/accounts';
import type { EmailMessage, EmailSender } from '../../../src/accounts/email';
import type { LLMProvider, STTProvider } from '../../../src/gateway/providers/cloud/types';

const ADMIN_KEY = 'admin-key-0123456789abcdef';
const APP_KEY = 'babelcast-app-key-0123456789';
const SITE = 'ucast.me';

interface Gw {
  port: number;
  server: Server;
  accounts: ReturnType<typeof createAccounts>;
  mails: EmailMessage[];
  clock: { now: number };
  dir: string;
  close(): Promise<void>;
}

const open: Gw[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });

/** 2 s of 16 kHz mono 16-bit PCM. */
function wav(seconds: number): Buffer {
  const data = Buffer.alloc(Math.round(seconds * 32_000));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16_000, 24); h.writeUInt32LE(32_000, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const fakeStt: STTProvider = {
  providerId: 'groq', getModels: () => [], isConfigured: () => true,
  transcribe: async () => ({ text: 'olá mundo' }),
} as unknown as STTProvider;
const fakeLlm: LLMProvider = {
  providerId: 'groq', isConfigured: () => true,
  chat: async (r) => ({ content: 'hello', model: r.model, usage: { promptTokens: 30, completionTokens: 12, totalTokens: 42 } }),
};

const WEBHOOK_SECRET = 'whsec_test';

function fakeStripe() {
  const calls: Array<{ method: string; path: string; body: string }> = [];
  const state = { subscriptions: [] as unknown[] };
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/v1', '');
    calls.push({ method, path: `${path}${url.search}`, body: String(init?.body ?? '') });
    if (path === '/prices') return json({ data: [{ id: 'price_pro', lookup_key: 'ucast_pro_monthly' }, { id: 'price_events', lookup_key: 'ucast_events_monthly' }] });
    if (path === '/customers' && method === 'POST') return json({ id: 'cus_1' });
    if (path === '/checkout/sessions') return json({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    if (path === '/billing_portal/sessions') return json({ url: 'https://billing.stripe.com/p/session/test_1' });
    if (path === '/subscriptions') return json({ data: state.subscriptions });
    if (path === '/customers/cus_1' && method === 'DELETE') return json({ id: 'cus_1', deleted: true });
    if (path === '/customers/cus_1' && method === 'POST') return json({ id: 'cus_1' });
    return new Response('{"error":{"message":"unexpected"}}', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, state };
}

function signedEvent(event: unknown, nowMs: number, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(event);
  const t = Math.floor(nowMs / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return { raw, header: `t=${t},v1=${v1}` };
}

const NO_QUOTA = { audioSeconds: 0, llmTokens: 0, ttsChars: 0, rooms: 0, requestsPerDay: 0, concurrentRequests: 0 };

interface GwOpts { adminApp?: boolean; dir?: string; appEnv?: Record<string, string>; sessionRequests?: number; hold?: Promise<void>; stripe?: typeof fetch }

async function startGateway(config: Partial<AccountsConfig> = {}, opts: GwOpts = {}): Promise<Gw> {
  const clock = { now: Date.UTC(2026, 9, 10, 12) };
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'accounts-'));
  const mails: EmailMessage[] = [];
  const email: EmailSender = { configured: true, send: async (m) => { mails.push(m); } };
  const access = new AccessKeys({ GATEWAY_API_KEYS: `${ADMIN_KEY}:ops,${APP_KEY}:babelcast` }, { now: () => clock.now });
  access.setBaseAdmins(opts.adminApp ? ['ops', 'babelcast'] : ['ops']);
  const accounts = createAccounts({
    env: opts.stripe ? { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET } : {},
    ...(opts.stripe ? { stripeFetch: opts.stripe } : {}),
    config: {
      statePath: join(dir, 'accounts.json'), usagePath: join(dir, 'account-usage.json'),
      siteHosts: [SITE], publicBaseUrl: 'https://ucast.me', cookieSecure: true, ...config,
    },
    email, isAdmin: (u) => access.admins.has(u), now: () => clock.now,
    ...(opts.sessionRequests ? { sessionRequests: () => opts.sessionRequests! } : {}),
  });
  await accounts.init();
  const keyRegistry = {
    get size() { return access.size + accounts.activeKeyCount; },
    resolve: (t: string) => access.resolve(t) ?? accounts.resolveAppKey(t),
  };
  const gate = new AdminGate({ actorOf: (t) => { const u = keyRegistry.resolve(t)?.userId; return u && access.admins.has(u) ? u : null; } });
  const appLimits = new AppLimits({
    env: opts.appEnv ?? {}, now: () => clock.now, isAdmin: (u) => access.admins.has(u),
    aliasesOf: (u, stage) => (u === 'babelcast' ? new Set(stage === 'stt' ? ['whisper-large-v3'] : stage === 'chat' ? ['llm'] : ['tts']) : null),
  });
  const server = createProxyServer({
    keyRegistry,
    providers: { stt: { 'whisper-large-v3': fakeStt }, chat: { llm: fakeLlm } },
    appLimits,
    deepHealth: { authorize: (t) => access.admins.has(keyRegistry.resolve(t)?.userId ?? ''), report: async () => ({ status: 200, body: { deep: true } }) },
    customRoutes: [
      ...createAccessRoutes({ access, gate, audit: new KeyAudit() }),
      ...createCouponRoutes({ service: accounts.service, gate }),
      { method: 'POST', path: '/v1/rooms', handler: async (_req, res) => { res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{"code":"K7Q2XM"}'); } },
      { method: 'POST', path: '/v1/realtime/sessions', handler: async (req, res) => {
        req.resume();
        await opts.hold;
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"sessionId":"rt_x"}');
      } },
    ],
    onInference: accounts.recordInference,
  });
  accounts.mount(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const gw: Gw = {
    port: (server.address() as AddressInfo).port, server, accounts, mails, clock, dir,
    close: async () => {
      await accounts.stop();
      server.closeAllConnections?.();
      await new Promise<void>(r => server.close(() => r()));
      if (!opts.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
  open.push(gw);
  return gw;
}

interface Res { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any }

function call(gw: Gw, method: string, path: string, o: { headers?: Record<string, string>; body?: unknown; raw?: Buffer; host?: string } = {}): Promise<Res> {
  const payload = o.raw ?? (o.body !== undefined ? Buffer.from(JSON.stringify(o.body)) : undefined);
  const headers: Record<string, string> = {
    Host: o.host ?? `127.0.0.1:${gw.port}`,
    ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(payload ? { 'Content-Length': String(payload.length) } : {}),
    ...o.headers,
  };
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: gw.port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const cookieOf = (r: Res) => String((r.headers['set-cookie'] as string[] | undefined)?.[0] ?? '').split(';')[0]!;

function takeVerification(gw: Gw, email: string): string | null {
  const i = gw.mails.findIndex(m => m.to === email.toLowerCase() && /confirm/i.test(m.subject));
  if (i < 0) return null;
  const [mail] = gw.mails.splice(i, 1);
  return /#token=([A-Za-z0-9_-]+)/.exec(mail!.text)![1]!;
}

async function signup(gw: Gw, email = 'Ana@Example.com', password = 'senha-forte-123', verify = true) {
  const r = await call(gw, 'POST', '/v1/account/signup', { body: { email, password } });
  expect(r.status).toBe(201);
  const token = takeVerification(gw, email);
  if (verify && token) expect((await call(gw, 'POST', '/v1/account/verify', { body: { token } })).status).toBe(200);
  return { cookie: cookieOf(r), csrf: r.json.csrfToken as string };
}

async function newKey(gw: Gw, s: { cookie: string; csrf: string }, deviceName = 'Notebook') {
  const r = await call(gw, 'POST', '/v1/account/keys', { headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf }, body: { deviceName } });
  expect(r.status).toBe(201);
  return r.json as { key: string; id: string; prefix: string };
}

function stt(gw: Gw, key: string, seconds = 2, model = 'whisper-large-v3') {
  const boundary = 'xYzBoundary';
  const parts = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    wav(seconds), Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return call(gw, 'POST', '/v1/audio/transcriptions', { raw: parts, headers: { Authorization: `Bearer ${key}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
}

describe('passwords', () => {
  it('hashes with a salt (argon2id on Bun) and verifies only the right password', async () => {
    const h1 = await hashPassword('correct horse battery');
    const h2 = await hashPassword('correct horse battery');
    expect(h1).not.toContain('correct horse');
    expect(h1).not.toBe(h2);
    if ((globalThis as { Bun?: unknown }).Bun) expect(h1.startsWith('$argon2id$')).toBe(true);
    else expect(h1.startsWith('$scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h1)).toBe(true);
    expect(await verifyPassword('wrong horse battery', h1)).toBe(false);
  });
});

describe('sign-up, login, session', () => {
  it('creates the account with a normalized e-mail and a hardened session cookie; /me works with it', async () => {
    const gw = await startGateway();
    const r = await call(gw, 'POST', '/v1/account/signup', { body: { email: '  Ana@Example.COM ', password: 'senha-forte-123' } });
    expect(r.status).toBe(201);
    expect(r.json.email).toBe('ana@example.com');
    const setCookie = String((r.headers['set-cookie'] as string[])[0]);
    expect(setCookie).toMatch(/^__Host-ucast_sid=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    const me = await call(gw, 'GET', '/v1/account/me', { headers: { Cookie: cookieOf(r) } });
    expect(me.status).toBe(200);
    expect(me.json.email).toBe('ana@example.com');
    expect(me.json.csrfToken).toBe(r.json.csrfToken);
    expect((await call(gw, 'GET', '/v1/account/me')).status).toBe(401);
    const state = readFileSync(join(gw.dir, 'accounts.json'), 'utf8');
    expect(state).not.toContain('senha-forte-123');
    expect(state).not.toContain(cookieOf(r).split('=')[1]);
  });

  it('refuses invalid e-mails and short passwords', async () => {
    const gw = await startGateway();
    expect((await call(gw, 'POST', '/v1/account/signup', { body: { email: 'nope', password: 'senha-forte-123' } })).json.error.code).toBe('invalid_email');
    expect((await call(gw, 'POST', '/v1/account/signup', { body: { email: 'a@b.co', password: 'short' } })).json.error.code).toBe('weak_password');
  });

  it('logs in and out; the session survives a restart (state on disk)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'accounts-'));
    const gw = await startGateway({}, { dir });
    await signup(gw);
    const login = await call(gw, 'POST', '/v1/account/login', { body: { email: 'ana@example.com', password: 'senha-forte-123' } });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login);
    await gw.close(); open.pop();
    const gw2 = await startGateway({}, { dir });
    expect((await call(gw2, 'GET', '/v1/account/me', { headers: { Cookie: cookie } })).status).toBe(200);
    const out = await call(gw2, 'POST', '/v1/account/logout', { headers: { Cookie: cookie } });
    expect(String((out.headers['set-cookie'] as string[])[0])).toContain('Max-Age=0');
    expect((await call(gw2, 'GET', '/v1/account/me', { headers: { Cookie: cookie } })).status).toBe(401);
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives the same answer for an unknown e-mail and a wrong password (no enumeration)', async () => {
    const gw = await startGateway();
    await signup(gw);
    const wrong = await call(gw, 'POST', '/v1/account/login', { body: { email: 'ana@example.com', password: 'errada-123456' } });
    const unknown = await call(gw, 'POST', '/v1/account/login', { body: { email: 'ninguem@example.com', password: 'errada-123456' } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json).toEqual(unknown.json);
    const f1 = await call(gw, 'POST', '/v1/account/password/forgot', { body: { email: 'ana@example.com' } });
    const f2 = await call(gw, 'POST', '/v1/account/password/forgot', { body: { email: 'ninguem@example.com' } });
    expect([f1.status, f2.status]).toEqual([200, 200]);
    expect(f1.json).toEqual(f2.json);
    expect(gw.mails.map(m => m.to)).toEqual(['ana@example.com']);
  });

  it('signing up again with a registered e-mail: generic refusal (owner warned), or a login with the right password', async () => {
    const gw = await startGateway();
    await signup(gw);
    const again = await call(gw, 'POST', '/v1/account/signup', { body: { email: 'ana@example.com', password: 'outra-senha-999' } });
    expect(again.status).toBe(400);
    expect(again.json.error.code).toBe('signup_refused');
    expect(again.json.error.message).not.toMatch(/já existe|already/i);
    await new Promise(r => setTimeout(r, 10));
    expect(gw.mails.some(m => m.subject.includes('Tentativa'))).toBe(true);
    expect((await call(gw, 'POST', '/v1/account/signup', { body: { email: 'ana@example.com', password: 'senha-forte-123' } })).status).toBe(201);
  });

  it('writes every account e-mail in the language the account signed up in', async () => {
    const gw = await startGateway();
    await call(gw, 'POST', '/v1/account/signup', { headers: { Cookie: 'ucast_lang=fr' }, body: { email: 'eve@example.com', password: 'senha-forte-123' } });
    const welcome = gw.mails.find(m => m.to === 'eve@example.com')!;
    expect(welcome.subject).toBe('Bienvenue sur ucast.me — confirmez votre e-mail');
    expect(welcome.html).toContain('<html lang="fr">');
    expect(welcome.text).toContain('Téléchargez l’app');
    await call(gw, 'POST', '/v1/account/password/forgot', { body: { email: 'eve@example.com' } });
    const reset = gw.mails.at(-1)!;
    expect(reset.subject).toBe('Réinitialiser votre mot de passe ucast.me');
    const token = /#token=([A-Za-z0-9_-]+)/.exec(reset.text)![1]!;
    expect(reset.html).toContain(`reset#token=${token}`);
    await call(gw, 'POST', '/v1/account/password/reset', { body: { token, password: 'nova-senha-456' } });
    const changed = gw.mails.at(-1)!;
    expect(changed.subject).toBe('Votre mot de passe ucast.me a été modifié');
    expect(changed.text).toContain('https://ucast.me/forgot');
  });

  it('writes the reset e-mail in the language of the page it was asked from, even for an account made in another language', async () => {
    const gw = await startGateway();
    await signup(gw, 'ana@example.com');
    await call(gw, 'POST', '/v1/account/password/forgot', { headers: { Cookie: 'ucast_lang=en' }, body: { email: 'ana@example.com' } });
    expect(gw.mails.at(-1)!.subject).toBe('Reset your ucast.me password');
    await call(gw, 'POST', '/v1/account/password/forgot', { headers: { Cookie: 'ucast_lang=fr' }, body: { email: 'ana@example.com' } });
    expect(gw.mails.at(-1)!.subject).toBe('Réinitialiser votre mot de passe ucast.me');
  });

  it('opens Stripe checkout and the portal in the page language and records it on the customer', async () => {
    const stripe = fakeStripe();
    const gw = await startGateway({}, { stripe: stripe.fetchImpl });
    const s = await signup(gw);
    const headers = { Cookie: `${s.cookie}; ucast_lang=fr`, 'X-CSRF-Token': s.csrf };
    await call(gw, 'POST', '/v1/account/billing/checkout', { headers, body: { plan: 'pro' } });
    const created = stripe.calls.find(c => c.method === 'POST' && c.path === '/customers')!;
    expect(created.body).toContain('preferred_locales%5B0%5D=fr');
    expect(stripe.calls.find(c => c.path === '/checkout/sessions')!.body).toContain('locale=fr');
    await call(gw, 'POST', '/v1/account/billing/checkout', { headers: { ...headers, Cookie: `${s.cookie}; ucast_lang=en` }, body: { plan: 'pro' } });
    expect(stripe.calls.find(c => c.path === '/customers/cus_1' && c.method === 'POST')!.body).toContain('preferred_locales%5B0%5D=en');
    await call(gw, 'POST', '/v1/account/billing/portal', { headers, body: {} });
    expect(stripe.calls.find(c => c.path === '/billing_portal/sessions')!.body).toContain('locale=fr');
  });

  it('resets the password with the e-mailed one-time token and ends the old sessions', async () => {
    const gw = await startGateway();
    const s = await signup(gw);
    await call(gw, 'POST', '/v1/account/password/forgot', { body: { email: 'ana@example.com' } });
    const token = /#token=([A-Za-z0-9_-]+)/.exec(gw.mails[0]!.text)![1]!;
    expect(gw.mails[0]!.text).toContain('https://ucast.me/reset#token=');
    expect(readFileSync(join(gw.dir, 'accounts.json'), 'utf8')).not.toContain(token);
    expect((await call(gw, 'POST', '/v1/account/password/reset', { body: { token, password: 'nova-senha-456' } })).status).toBe(200);
    expect((await call(gw, 'GET', '/v1/account/me', { headers: { Cookie: s.cookie } })).status).toBe(401);
    expect((await call(gw, 'POST', '/v1/account/password/reset', { body: { token, password: 'outra-senha-789' } })).json.error.code).toBe('invalid_reset_token');
    expect((await call(gw, 'POST', '/v1/account/login', { body: { email: 'ana@example.com', password: 'senha-forte-123' } })).status).toBe(401);
    expect((await call(gw, 'POST', '/v1/account/login', { body: { email: 'ana@example.com', password: 'nova-senha-456' } })).status).toBe(200);
  });

  it('rate-limits login attempts per e-mail (429 + Retry-After)', async () => {
    const gw = await startGateway();
    await signup(gw);
    let last: Res | null = null;
    for (let i = 0; i < 11; i++) last = await call(gw, 'POST', '/v1/account/login', { body: { email: 'ana@example.com', password: `errada-${i}-xxxx` } });
    expect(last!.status).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
    // Even the right password waits for the window.
    expect((await call(gw, 'POST', '/v1/account/login', { body: { email: 'ana@example.com', password: 'senha-forte-123' } })).status).toBe(429);
    gw.clock.now += 16 * 60_000;
    expect((await call(gw, 'POST', '/v1/account/login', { body: { email: 'ana@example.com', password: 'senha-forte-123' } })).status).toBe(200);
  });

  it('rate-limits sign-ups per IP and silently caps reset e-mails per address', async () => {
    const gw = await startGateway();
    for (let i = 0; i < 10; i++) await call(gw, 'POST', '/v1/account/signup', { body: { email: `u${i}@example.com`, password: 'senha-forte-123' } });
    expect((await call(gw, 'POST', '/v1/account/signup', { body: { email: 'u11@example.com', password: 'senha-forte-123' } })).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await call(gw, 'POST', '/v1/account/password/forgot', { body: { email: 'u1@example.com' } })).status).toBe(200);
    expect(gw.mails.filter(m => m.to === 'u1@example.com' && m.subject.includes('senha'))).toHaveLength(3);
  });

  it('without Stripe the plan routes are off and no plan limits apply', async () => {
    const gw = await startGateway();
    const s = await signup(gw);
    const headers = { Cookie: s.cookie, 'X-CSRF-Token': s.csrf };
    const me = await call(gw, 'GET', '/v1/account/me', { headers: { Cookie: s.cookie } });
    expect(me.json.billing).toBe(false);
    expect(me.json.quota.limits.audioSeconds).toBe(0);
    expect((await call(gw, 'POST', '/v1/account/billing/checkout', { headers, body: { plan: 'pro' } })).json.error.code).toBe('billing_off');
  });

  it('with Stripe: free limits, checkout, sync to the paid plan, portal, webhook back to free, customer removed with the account', async () => {
    const stripe = fakeStripe();
    const gw = await startGateway({}, { stripe: stripe.fetchImpl });
    const s = await signup(gw);
    const headers = { Cookie: s.cookie, 'X-CSRF-Token': s.csrf };
    const me = await call(gw, 'GET', '/v1/account/me', { headers: { Cookie: s.cookie } });
    expect(me.json.billing).toBe(true);
    expect(me.json.quota.limits.audioSeconds).toBe(2 * 3600);
    expect((await call(gw, 'POST', '/v1/account/billing/checkout', { headers, body: { plan: 'gold' } })).json.error.code).toBe('invalid_plan');
    const checkout = await call(gw, 'POST', '/v1/account/billing/checkout', { headers, body: { plan: 'pro' } });
    expect(checkout.json.url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    const session = stripe.calls.find(c => c.path === '/checkout/sessions')!;
    expect(session.body).toContain('mode=subscription');
    expect(session.body).toContain('customer=cus_1');
    expect(decodeURIComponent(session.body)).toContain('line_items[0][price]=price_pro');
    expect(decodeURIComponent(session.body)).toContain('success_url=https://ucast.me/account?billing=success');
    stripe.state.subscriptions = [{ status: 'active', customer: 'cus_1', current_period_end: 1_793_000_000, cancel_at_period_end: false, items: { data: [{ price: { lookup_key: 'ucast_pro_monthly' } }] } }];
    const synced = await call(gw, 'POST', '/v1/account/billing/sync', { headers, body: {} });
    expect(synced.json.plan).toBe('pro');
    expect(synced.json.quota.limits.audioSeconds).toBe(20 * 3600);
    expect(synced.json.quota.planRenewsAt).toBe(new Date(1_793_000_000_000).toISOString());
    expect((await call(gw, 'POST', '/v1/account/billing/portal', { headers, body: {} })).json.url).toContain('billing.stripe.com');
    stripe.state.subscriptions = [{ status: 'active', customer: 'cus_1', cancel_at: 1_795_000_000, cancel_at_period_end: false, items: { data: [{ price: { lookup_key: 'ucast_pro_monthly' }, current_period_end: 1_795_000_000 }] } }];
    const cancelling = await call(gw, 'POST', '/v1/account/billing/sync', { headers, body: {} });
    expect(cancelling.json.plan).toBe('pro');
    expect(cancelling.json.quota.planCancelsAtPeriodEnd).toBe(true);
    expect(cancelling.json.quota.planRenewsAt).toBe(new Date(1_795_000_000_000).toISOString());
    stripe.state.subscriptions = [];
    const bad = signedEvent({ type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1' } } }, gw.clock.now, 'whsec_other');
    expect((await call(gw, 'POST', '/v1/billing/stripe/webhook', { headers: { 'Stripe-Signature': bad.header, 'Content-Type': 'application/json' }, raw: Buffer.from(bad.raw) })).status).toBe(400);
    const ok = signedEvent({ type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1' } } }, gw.clock.now);
    expect((await call(gw, 'POST', '/v1/billing/stripe/webhook', { headers: { 'Stripe-Signature': ok.header, 'Content-Type': 'application/json' }, raw: Buffer.from(ok.raw) })).status).toBe(200);
    expect((await call(gw, 'GET', '/v1/account/me', { headers: { Cookie: s.cookie } })).json.plan).toBe('free');
    expect((await call(gw, 'DELETE', '/v1/account/me', { headers, body: { password: 'senha-forte-123' } })).status).toBe(200);
    expect(stripe.calls.some(c => c.method === 'DELETE' && c.path === '/customers/cus_1')).toBe(true);
  });

  it('an admin account has no plan limits', async () => {
    const gw = await startGateway({ adminEmails: ['dono@ucast.me'] }, { stripe: fakeStripe().fetchImpl });
    const owner = await signup(gw, 'dono@ucast.me');
    const user = await signup(gw, 'ana@example.com');
    expect((await call(gw, 'GET', '/v1/account/me', { headers: { Cookie: owner.cookie } })).json.quota.limits.audioSeconds).toBe(0);
    expect((await call(gw, 'GET', '/v1/account/me', { headers: { Cookie: user.cookie } })).json.quota.limits.audioSeconds).toBe(2 * 3600);
  });

  it('over the plan limit the account stops with a link to the next plan', async () => {
    const gw = await startGateway({}, { stripe: fakeStripe().fetchImpl });
    await signup(gw);
    const user = (gw.accounts.service as unknown as { state: { users: Array<{ id: string; email: string }> } }).state.users.find(u => u.email === 'ana@example.com')! as Parameters<typeof gw.accounts.service.checkQuota>[0];
    expect(gw.accounts.service.checkQuota(user, ['audioSeconds'])).toBeNull();
    gw.accounts.usage.record(user.id, 'akey_x', { audioSeconds: 2 * 3600 });
    const over = gw.accounts.service.checkQuota(user, ['audioSeconds'])!;
    expect(over.status).toBe(402);
    expect(over.extra.upgrade_url).toBe('https://ucast.me/account?plan=pro');
    expect(over.message).toContain('mude de plano');
  });

  it('a new account confirms its e-mail before creating keys; old links and other accounts are not affected', async () => {
    const gw = await startGateway();
    const s = await signup(gw, 'nova@example.com', 'senha-forte-123', false);
    const headers = { Cookie: s.cookie, 'X-CSRF-Token': s.csrf };
    expect((await call(gw, 'GET', '/v1/account/me', { headers: { Cookie: s.cookie } })).json.emailVerified).toBe(false);
    const refused = await call(gw, 'POST', '/v1/account/keys', { headers, body: { deviceName: 'Mac' } });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('email_not_verified');
    expect((await call(gw, 'POST', '/v1/account/verify/resend', { headers, body: {} })).status).toBe(200);
    const token = takeVerification(gw, 'nova@example.com')!;
    expect((await call(gw, 'POST', '/v1/account/verify', { body: { token: 'nope' } })).json.error.code).toBe('invalid_verify_token');
    expect((await call(gw, 'POST', '/v1/account/verify', { body: { token } })).status).toBe(200);
    expect((await call(gw, 'POST', '/v1/account/verify', { body: { token } })).status).toBe(400);
    expect((await call(gw, 'GET', '/v1/account/me', { headers: { Cookie: s.cookie } })).json.emailVerified).toBe(true);
    await newKey(gw, s);
  });

  it('deletes the account with its password: sessions, keys and usage go, the e-mail can sign up again', async () => {
    const gw = await startGateway();
    const s = await signup(gw);
    const k = await newKey(gw, s);
    const headers = { Cookie: s.cookie, 'X-CSRF-Token': s.csrf };
    expect((await call(gw, 'DELETE', '/v1/account/me', { headers: { Cookie: s.cookie }, body: { password: 'senha-forte-123' } })).status).toBe(403);
    expect((await call(gw, 'DELETE', '/v1/account/me', { headers, body: { password: 'errada-errada' } })).json.error.code).toBe('wrong_password');
    const gone = await call(gw, 'DELETE', '/v1/account/me', { headers, body: { password: 'senha-forte-123' } });
    expect(gone.status).toBe(200);
    expect(String(gone.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await call(gw, 'GET', '/v1/account/me', { headers: { Cookie: s.cookie } })).status).toBe(401);
    expect((await call(gw, 'GET', '/v1/account/me', { headers: { Authorization: `Bearer ${k.key}` } })).status).toBe(401);
    expect(gw.mails.some(m => m.to === 'ana@example.com' && m.subject.includes('excluída'))).toBe(true);
    await signup(gw);
  });

  it('cookie writes need the CSRF token and a same-origin request; JSON-less or cross-site forms are refused', async () => {
    const gw = await startGateway();
    const s = await signup(gw);
    const noToken = await call(gw, 'POST', '/v1/account/keys', { headers: { Cookie: s.cookie }, body: { deviceName: 'x' } });
    expect(noToken.status).toBe(403);
    expect(noToken.json.error.code).toBe('csrf_failed');
    const crossSite = await call(gw, 'POST', '/v1/account/keys', { headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, Origin: 'https://evil.example' }, body: {} });
    expect(crossSite.status).toBe(403);
    const fetchSite = await call(gw, 'POST', '/v1/account/login', { headers: { 'Sec-Fetch-Site': 'cross-site' }, body: { email: 'ana@example.com', password: 'senha-forte-123' } });
    expect(fetchSite.status).toBe(403);
    const form = await call(gw, 'POST', '/v1/account/login', { raw: Buffer.from('email=ana%40example.com&password=x'), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(form.status).toBe(415);
    const sameOrigin = await call(gw, 'POST', '/v1/account/keys', { headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, Origin: `http://127.0.0.1:${gw.port}` }, body: { deviceName: 'ok' } });
    expect(sameOrigin.status).toBe(201);
    // No CORS on account routes.
    expect(sameOrigin.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('pages on the public site host (ucast.me proxies /login and /v1/account/* to the gateway) may write', async () => {
    const gw = await startGateway();
    const site = { Origin: `https://${SITE}`, 'Sec-Fetch-Site': 'same-origin' };
    const login = await call(gw, 'POST', '/v1/account/signup', { headers: site, body: { email: 'site@example.com', password: 'senha-forte-123' } });
    expect(login.status).toBe(201);
    const s = await signup(gw, 'outra@example.com');
    const key = await call(gw, 'POST', '/v1/account/keys', { headers: { ...site, Cookie: s.cookie, 'X-CSRF-Token': s.csrf }, body: { deviceName: 'site' } });
    expect(key.status).toBe(201);
    const lookalike = await call(gw, 'POST', '/v1/account/keys', { headers: { Origin: `https://${SITE}.evil.example`, Cookie: s.cookie, 'X-CSRF-Token': s.csrf }, body: { deviceName: 'x' } });
    expect(lookalike.status).toBe(403);
  });
});

describe('activation keys', () => {
  it('shows the full key once; the state holds only its hash; list never returns it', async () => {
    const gw = await startGateway();
    const s = await signup(gw);
    const k = await newKey(gw, s, 'Notebook do escritório');
    expect(k.key).toMatch(/^ucast_live_[A-Za-z0-9_-]{43}$/);
    expect(k.prefix).toBe(k.key.slice(0, 15));
    const list = await call(gw, 'GET', '/v1/account/keys', { headers: { Cookie: s.cookie } });
    expect(list.json.keys).toHaveLength(1);
    expect(list.text).not.toContain(k.key);
    expect(list.json.keys[0].deviceName).toBe('Notebook do escritório');
    await gw.accounts.stop();
    const state = readFileSync(join(gw.dir, 'accounts.json'), 'utf8');
    expect(state).not.toContain(k.key);
    expect(state).not.toContain(k.key.slice(15));
  });

  it('activates (POST /v1/activate) and refuses a revoked key everywhere', async () => {
    const gw = await startGateway();
    const s = await signup(gw);
    const k = await newKey(gw, s);
    const act = await call(gw, 'POST', '/v1/activate', { body: { key: k.key, deviceName: 'PC da sala', appVersion: '2.0.0' } });
    expect(act.status).toBe(200);
    expect(act.json).toMatchObject({ ok: true, email: 'ana@example.com', plan: 'free' });
    expect(act.json.quota.limits).toBeDefined();
    expect((await stt(gw, k.key)).status).toBe(200);
    const revoke = await call(gw, 'DELETE', `/v1/account/keys/${k.id}`, { headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf } });
    expect(revoke.status).toBe(200);
    expect(revoke.json.active).toBe(false);
    expect((await stt(gw, k.key)).status).toBe(401);
    const again = await call(gw, 'POST', '/v1/activate', { body: { key: k.key } });
    expect(again.status).toBe(401);
    expect(again.json.error.code).toBe('invalid_key');
    expect((await call(gw, 'POST', '/v1/activate', { body: { key: 'ucast_live_nope' } })).status).toBe(401);
  });

  it("another user cannot revoke someone's key", async () => {
    const gw = await startGateway();
    const ana = await signup(gw);
    const k = await newKey(gw, ana);
    const bob = await signup(gw, 'bob@example.com');
    const r = await call(gw, 'DELETE', `/v1/account/keys/${k.id}`, { headers: { Cookie: bob.cookie, 'X-CSRF-Token': bob.csrf } });
    expect(r.status).toBe(404);
    expect((await stt(gw, k.key)).status).toBe(200);
  });

  it('an activation key is the app, never admin: admin routes and deep health are refused, foreign models too', async () => {
    const gw = await startGateway();
    const k = await newKey(gw, await signup(gw));
    const auth = { Authorization: `Bearer ${k.key}` };
    const issue = await call(gw, 'POST', '/v1/admin/access/keys', { headers: auth, body: { user: 'hacker', admin: true } });
    expect(issue.status).toBe(403);
    expect((await call(gw, 'GET', '/health?deep=1', { headers: auth })).status).toBe(403);
    expect((await stt(gw, k.key, 1, 'openai/whisper-1')).status).toBe(403);
    // The admin key still works (sanity of the stand-in).
    expect((await call(gw, 'GET', '/health?deep=1', { headers: { Authorization: `Bearer ${ADMIN_KEY}` } })).status).toBe(200);
    // Activation keys cannot manage keys either (cookie only).
    expect((await call(gw, 'POST', '/v1/account/keys', { headers: auth, body: {} })).status).toBe(401);
  });

  it('fails closed when the accounts app is an admin user', async () => {
    const gw = await startGateway({}, { adminApp: true });
    const k = await newKey(gw, await signup(gw));
    expect(gw.accounts.resolveAppKey(k.key)).toBeNull();
    expect((await stt(gw, k.key)).status).toBe(401);
  });
});

describe('metering and quota', () => {
  it('counts audio seconds, tokens, rooms and requests per user and per key, by day', async () => {
    const gw = await startGateway();
    const s = await signup(gw);
    const a = await newKey(gw, s, 'A');
    const b = await newKey(gw, s, 'B');
    expect((await stt(gw, a.key, 2)).status).toBe(200);
    expect((await stt(gw, b.key, 3)).status).toBe(200);
    const chat = await call(gw, 'POST', '/v1/chat/completions', { headers: { Authorization: `Bearer ${a.key}` }, body: { model: 'llm', messages: [{ role: 'user', content: 'oi' }] } });
    expect(chat.status).toBe(200);
    expect((await call(gw, 'POST', '/v1/rooms', { headers: { Authorization: `Bearer ${a.key}` }, body: { languages: ['en'] } })).status).toBe(201);
    // A refused request (foreign model) is not counted.
    expect((await stt(gw, a.key, 9, 'nope')).status).toBe(403);
    const u = await call(gw, 'GET', '/v1/account/usage?days=7', { headers: { Cookie: s.cookie } });
    expect(u.status).toBe(200);
    const today = u.json.days.at(-1);
    expect(today.day).toBe('2026-10-10');
    expect(today).toMatchObject({ requests: 4, sttRequests: 2, audioSeconds: 5, llmRequests: 1, llmTokens: 42, rooms: 1 });
    const byKey = Object.fromEntries(u.json.byKey.map((x: { deviceName: string }) => [x.deviceName, x]));
    expect(byKey.A).toMatchObject({ audioSeconds: 2, llmTokens: 42, rooms: 1, requests: 3 });
    expect(byKey.B).toMatchObject({ audioSeconds: 3, requests: 1 });
    expect(u.json.quota.month.audioSeconds).toBe(5);
    // The app can read its own usage with the key (read-only).
    expect((await call(gw, 'GET', '/v1/account/usage', { headers: { Authorization: `Bearer ${a.key}` } })).status).toBe(200);
    // Durable.
    await gw.accounts.stop();
    expect(JSON.parse(readFileSync(join(gw.dir, 'account-usage.json'), 'utf8')).days['2026-10-10']).toBeDefined();
  });

  it('over the monthly quota → 402 quota_exceeded in Portuguese; it renews next month', async () => {
    const gw = await startGateway({ quota: { ...NO_QUOTA, audioSeconds: 3 } });
    const k = await newKey(gw, await signup(gw));
    expect((await stt(gw, k.key, 4)).status).toBe(200);
    const over = await stt(gw, k.key, 1);
    expect(over.status).toBe(402);
    expect(over.json.error).toMatchObject({ code: 'quota_exceeded', type: 'quota_exceeded', metric: 'audioSeconds', limit: 3 });
    expect(over.json.error.message).toMatch(/cota mensal de transcrição acabou.*renova em 01\/11\/2026/);
    // Other metrics are still admitted.
    expect((await call(gw, 'POST', '/v1/chat/completions', { headers: { Authorization: `Bearer ${k.key}` }, body: { model: 'llm', messages: [{ role: 'user', content: 'oi' }] } })).status).toBe(200);
    gw.clock.now = Date.UTC(2026, 10, 1, 0, 1);
    expect((await stt(gw, k.key, 1)).status).toBe(200);
  });

  it('a transcription stream is admitted against the quota, metered as it streams and counted once at the end', async () => {
    const gw = await startGateway({ quota: { ...NO_QUOTA, audioSeconds: 40 } });
    const s = await signup(gw);
    const k = await newKey(gw, s, 'Stream');
    expect(gw.accounts.streamMeter(`Bearer ${APP_KEY}`), 'not an activation key').toBeNull();
    expect(gw.accounts.streamMeter('Bearer ucast_live_unknown'), 'unknown key: the proxy answers').toBeNull();
    const meter = gw.accounts.streamMeter(`Bearer ${k.key}`)!;
    expect(meter).not.toHaveProperty('denial');
    const m = meter as { add(s: number): unknown; end(): void };
    expect(m.add(15)).toBeNull();
    expect(m.add(30)).toMatchObject({ status: 402, code: 'quota_exceeded', type: 'quota_exceeded' });
    m.end();
    m.end();
    const u = await call(gw, 'GET', '/v1/account/usage?days=1', { headers: { Cookie: s.cookie } });
    expect(u.json.days.at(-1)).toMatchObject({ requests: 1, sttRequests: 1, audioSeconds: 45 });
    expect(gw.accounts.streamMeter(`Bearer ${k.key}`)).toMatchObject({ denial: { status: 402, code: 'quota_exceeded' } });
  });

  it('over the daily request cap → 429 with Retry-After', async () => {
    const gw = await startGateway({ quota: { ...NO_QUOTA, requestsPerDay: 2 } });
    const k = await newKey(gw, await signup(gw));
    expect((await stt(gw, k.key)).status).toBe(200);
    expect((await stt(gw, k.key)).status).toBe(200);
    const over = await stt(gw, k.key);
    expect(over.status).toBe(429);
    expect(over.json.error.code).toBe('daily_quota_exceeded');
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    // Ordinary app keys are not affected by account quotas.
    expect((await stt(gw, APP_KEY)).status).toBe(200);
  });
});

describe('per-account limits under one shared app', () => {
  const session = (gw: Gw, key: string) => call(gw, 'POST', '/v1/realtime/sessions', { headers: { Authorization: `Bearer ${key}` }, body: {} });

  it('defaults: no daily request cap and 20 in flight per account', async () => {
    const gw = await startGateway();
    const s = await signup(gw);
    const me = await call(gw, 'GET', '/v1/account/me', { headers: { Cookie: s.cookie } });
    expect(me.json.quota.limits).toMatchObject({ requestsPerDay: 0, concurrentRequests: 20 });
  });

  it('one account exhausting its daily budget does not stop another account of the same app', async () => {
    const gw = await startGateway({ quota: { ...NO_QUOTA, requestsPerDay: 2 } });
    const a = await newKey(gw, await signup(gw));
    const b = await newKey(gw, await signup(gw, 'bob@example.com'));
    expect((await stt(gw, a.key)).status).toBe(200);
    expect((await stt(gw, a.key)).status).toBe(200);
    const over = await stt(gw, a.key);
    expect(over.status).toBe(429);
    expect(over.json.error).toMatchObject({ code: 'daily_quota_exceeded', scope: 'account', limit: 2 });
    expect(over.json.error.message).toMatch(/Sua conta atingiu o limite de 2 pedidos por dia/);
    expect((await stt(gw, b.key)).status).toBe(200);
  });

  it('a realtime session costs its whole app charge against the account budget; /v1/s2s turns count too', async () => {
    const gw = await startGateway({ quota: { ...NO_QUOTA, requestsPerDay: 100 } }, { sessionRequests: 40 });
    const a = await newKey(gw, await signup(gw));
    const b = await newKey(gw, await signup(gw, 'bob@example.com'));
    expect((await session(gw, a.key)).status).toBe(200);
    expect((await session(gw, a.key)).status).toBe(200);
    expect((await session(gw, a.key)).status).toBe(429);
    for (let i = 0; i < 20; i++) expect((await stt(gw, a.key)).status).toBe(200);
    const turn = await call(gw, 'POST', '/v1/s2s', { headers: { Authorization: `Bearer ${a.key}` }, body: {} });
    expect(turn.status).toBe(429);
    expect(turn.json.error.code).toBe('daily_quota_exceeded');
    expect((await session(gw, b.key)).status).toBe(200);
  });

  it('one account at its in-flight limit gets 429; another account of the same app still passes', async () => {
    let release!: () => void;
    const hold = new Promise<void>(r => { release = r; });
    const gw = await startGateway({ quota: { ...NO_QUOTA, concurrentRequests: 1 } }, { hold });
    const a = await newKey(gw, await signup(gw));
    const b = await newKey(gw, await signup(gw, 'bob@example.com'));
    const first = session(gw, a.key);
    await new Promise(r => setTimeout(r, 50));
    const busy = await session(gw, a.key);
    expect(busy.status).toBe(429);
    expect(busy.json.error).toMatchObject({ code: 'account_concurrency_exceeded', scope: 'account', limit: 1 });
    expect(busy.headers['retry-after']).toBe('1');
    const other = session(gw, b.key);
    release();
    expect((await first).status).toBe(200);
    expect((await other).status).toBe(200);
    expect((await session(gw, a.key)).status).toBe(200);
  });

  it('the app-wide daily budget still caps the sum of the accounts', async () => {
    const gw = await startGateway({ quota: { ...NO_QUOTA, requestsPerDay: 10 } }, { appEnv: { APP_DAILY_REQUESTS: '3' } });
    const a = await newKey(gw, await signup(gw));
    const b = await newKey(gw, await signup(gw, 'bob@example.com'));
    expect((await stt(gw, a.key)).status).toBe(200);
    expect((await stt(gw, a.key)).status).toBe(200);
    expect((await stt(gw, b.key)).status).toBe(200);
    const over = await stt(gw, b.key);
    expect(over.status).toBe(429);
    expect(over.json.error.code).toBe('daily_budget_exhausted');
  });
});

describe('pages and host routing', () => {
  it('serves the pages on the site host and under /account everywhere, with a nonce CSP', async () => {
    const gw = await startGateway();
    for (const path of ['/', '/signup', '/login', '/forgot', '/reset', '/account']) {
      const r = await call(gw, 'GET', path, { host: SITE });
      expect(r.status, path).toBe(200);
      expect(String(r.headers['content-type'])).toContain('text/html');
      const csp = String(r.headers['content-security-policy']);
      expect(csp).toContain("frame-ancestors 'none'");
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
      if (r.text.includes('<script')) expect(r.text).toContain(`nonce="${nonce}"`);
      expect(r.text).toContain('lang="pt-BR"');
    }
    expect((await call(gw, 'GET', '/account/signup')).text).toContain('Criar sua conta');
    expect((await call(gw, 'GET', '/account/nao-existe')).status).toBe(404);
    // Not the site host: `/signup` and `/` are left to the proxy (which wants a key).
    expect((await call(gw, 'GET', '/signup')).status).toBe(401);
    const dash = await call(gw, 'GET', '/account', { host: SITE });
    expect(dash.text).toContain('Comece em três passos');
    expect(dash.text).toContain("if(ADMIN){loadUsers();loadCoupons()}");
    expect(dash.text).not.toMatch(/ style="/);
  });

  it('speaks the site language: the ucast_lang cookie, then Accept-Language, else Portuguese', async () => {
    const gw = await startGateway();
    const login = (headers: Record<string, string>) => call(gw, 'GET', '/login', { host: SITE, headers }).then(r => r.text);
    expect(await login({ Cookie: 'ucast_lang=fr' })).toContain('lang="fr"');
    expect(await login({ Cookie: 'ucast_lang=en', 'Accept-Language': 'fr' })).toContain('Sign in to see your activation key');
    expect(await login({ 'Accept-Language': 'fr-FR,fr;q=0.9' })).toContain('Mot de passe oublié');
    expect(await login({ 'Accept-Language': 'de-DE' })).toContain('lang="en"');
    expect(await login({})).toContain('lang="pt-BR"');
    const dash = (await call(gw, 'GET', '/account', { host: SITE, headers: { Cookie: 'ucast_lang=en' } })).text;
    expect(dash).toContain(String.raw`text.replace(/\{(\w+)\}/g,`);
    expect(dash).toContain('"signedInAs":"Signed in as {email}."');
  });
});

describe('admin: users and access keys', () => {
  const ADMIN = 'dono@ucast.me';

  it('lists users only for an admin e-mail', async () => {
    const gw = await startGateway({ adminEmails: [ADMIN] });
    const ana = await signup(gw, 'ana@example.com');
    const admin = await signup(gw, ADMIN);
    expect((await call(gw, 'GET', '/v1/account/me', { headers: { Cookie: ana.cookie } })).json.admin).toBe(false);
    expect((await call(gw, 'GET', '/v1/account/me', { headers: { Cookie: admin.cookie } })).json.admin).toBe(true);
    // A plain user gets 403 and no data.
    const denied = await call(gw, 'GET', '/v1/account/users', { headers: { Cookie: ana.cookie } });
    expect(denied.status).toBe(403);
    expect(denied.text).not.toContain('ana@example.com');
    // The admin sees everyone, newest first.
    const r = await call(gw, 'GET', '/v1/account/users', { headers: { Cookie: admin.cookie } });
    expect(r.status).toBe(200);
    const emails = (r.json.users as Array<{ email: string }>).map(u => u.email);
    expect([...emails].sort()).toEqual([ADMIN, 'ana@example.com'].sort());
    expect(r.json.users[0].createdAt).toBeTruthy();
    expect(r.json.users[0].lastSeenAt).toBeTruthy();
  });

  it('sends a new activation key by e-mail, never in the API answer', async () => {
    const gw = await startGateway({ adminEmails: [ADMIN] });
    const ana = await signup(gw, 'ana@example.com');
    const admin = await signup(gw, ADMIN);
    const users = (await call(gw, 'GET', '/v1/account/users', { headers: { Cookie: admin.cookie } })).json.users as Array<{ id: string; email: string }>;
    const anaId = users.find(u => u.email === 'ana@example.com')!.id;
    // Not an admin: refused. Without CSRF: refused. Unknown user: 404.
    expect((await call(gw, 'POST', `/v1/account/users/${anaId}/access-key`, { headers: { Cookie: ana.cookie, 'X-CSRF-Token': ana.csrf }, body: {} })).status).toBe(403);
    expect((await call(gw, 'POST', `/v1/account/users/${anaId}/access-key`, { headers: { Cookie: admin.cookie }, body: {} })).status).toBe(403);
    expect((await call(gw, 'POST', '/v1/account/users/usr_nope/access-key', { headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf }, body: {} })).status).toBe(404);
    // The happy path: the key goes to Ana's inbox and activates the app.
    const r = await call(gw, 'POST', `/v1/account/users/${anaId}/access-key`, { headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf }, body: { deviceName: 'Notebook da Ana' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, email: 'ana@example.com' });
    expect(r.text).not.toContain('ucast_live_');
    const mail = gw.mails.find(m => m.to === 'ana@example.com' && m.subject.includes('chave'));
    expect(mail).toBeTruthy();
    const key = /ucast_live_[A-Za-z0-9_-]{43}/.exec(mail!.text)?.[0];
    expect(key).toBeTruthy();
    const act = await call(gw, 'POST', '/v1/activate', { body: { key, deviceName: 'Notebook da Ana' } });
    expect(act.status).toBe(200);
    expect(act.json.email).toBe('ana@example.com');
  });
});

describe('helpers', () => {
  it('reads WAV durations', () => {
    expect(wavSeconds(wav(2.5))).toBeCloseTo(2.5, 3);
    expect(wavSeconds(Buffer.from('not a wav at all'))).toBeNull();
  });
});

describe('resend sender', () => {
  it('sends account mail with replies going to the support address', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response('{}'); }) as unknown as typeof fetch;
    const sender = createEmailSender({ resendApiKey: 're_test', from: 'ucast.me <no-reply@ucast.me>', replyTo: 'support@ucast.me', logLinks: false, fetchImpl });
    await sender.send({ to: 'ana@example.com', subject: 's', text: 't', html: 'h' });
    expect(bodies[0]).toMatchObject({ to: ['ana@example.com'], reply_to: 'support@ucast.me' });
  });
});

describe('coupons (a paid plan for a few months, no card)', () => {
  const adminHeaders = { Authorization: `Bearer ${ADMIN_KEY}` };
  const makeCoupons = async (gw: Gw, body: Record<string, unknown> = {}) => {
    const r = await call(gw, 'POST', '/v1/admin/coupons', { headers: adminHeaders, body });
    expect(r.status).toBe(201);
    return r.json.coupons as Array<{ code: string }>;
  };
  const redeem = (gw: Gw, s: { cookie: string; csrf: string }, code: string) =>
    call(gw, 'POST', '/v1/account/coupon/redeem', { headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf }, body: { code } });
  const me = async (gw: Gw, s: { cookie: string }) => (await call(gw, 'GET', '/v1/account/me', { headers: { Cookie: s.cookie } })).json;

  it('only the admin key creates and lists codes', async () => {
    const gw = await startGateway();
    expect((await call(gw, 'POST', '/v1/admin/coupons', { body: {} })).status).toBe(401);
    expect((await call(gw, 'POST', '/v1/admin/coupons', { headers: { Authorization: `Bearer ${APP_KEY}` }, body: {} })).status).toBe(403);
    const [coupon] = await makeCoupons(gw, { count: 2, note: 'turma A' });
    expect(coupon!.code).toMatch(/^UCAST-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const listed = await call(gw, 'GET', '/v1/admin/coupons', { headers: adminHeaders });
    expect(listed.json.coupons).toHaveLength(2);
    expect(listed.json.coupons[0]).toMatchObject({ plan: 'pro', months: 3, maxUses: 1, uses: 0, note: 'turma A' });
    expect((await call(gw, 'POST', '/v1/admin/coupons', { headers: adminHeaders, body: { months: 0 } })).status).toBe(400);
    expect((await call(gw, 'POST', '/v1/admin/coupons', { headers: adminHeaders, body: { plan: 'free' } })).status).toBe(400);
  });

  it('the admin key can create and e-mail invitations in one call, in the chosen language', async () => {
    const gw = await startGateway();
    await signup(gw, 'ana@example.com');
    gw.mails.length = 0;
    const r = await call(gw, 'POST', '/v1/admin/coupons', { headers: adminHeaders, body: { emails: ['ana@example.com', 'novo@example.com'], lang: 'fr', months: 3 } });
    expect(r.status).toBe(201);
    expect(r.json.skipped).toEqual(['ana@example.com']);
    expect(r.json.coupons).toHaveLength(1);
    expect(gw.mails.map(m => [m.to, m.subject])).toEqual([['novo@example.com', 'Votre code ucast.me']]);
  });

  it('gives Pro for 3 months with no card, applies the Pro limits and returns to Free afterwards', async () => {
    const gw = await startGateway({}, { stripe: fakeStripe().fetchImpl });
    const s = await signup(gw);
    expect((await me(gw, s)).quota).toMatchObject({ plan: 'free', viaCoupon: false });
    const [coupon] = await makeCoupons(gw);
    const done = await redeem(gw, s, coupon!.code.toLowerCase().replace(/-/g, ' '));
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ plan: 'pro', quota: { plan: 'pro', viaCoupon: true, grantEndsAt: '2027-01-10T12:00:00.000Z' } });
    expect(done.json.quota.limits.audioSeconds).toBe(20 * 3600);
    gw.clock.now = Date.UTC(2027, 0, 11);
    const again = await call(gw, 'POST', '/v1/account/login', { body: { email: 'ana@example.com', password: 'senha-forte-123' } });
    const after = await me(gw, { cookie: cookieOf(again) });
    expect(after.quota).toMatchObject({ plan: 'free', viaCoupon: false });
    expect(after.quota.limits.audioSeconds).toBe(2 * 3600);
  });

  it('wants the e-mail confirmed before a code is used, and the invitation footer does not claim an account exists', async () => {
    const gw = await startGateway({ adminEmails: ['dono@ucast.me'] });
    const [coupon] = await makeCoupons(gw);
    const ana = await signup(gw, 'ana@example.com', 'senha-forte-123', false);
    const early = await redeem(gw, ana, coupon!.code);
    expect(early.status).toBe(403);
    expect(early.json.error.code).toBe('email_not_verified');
    gw.mails.length = 0;
    await call(gw, 'POST', '/v1/admin/coupons', { headers: adminHeaders, body: { emails: ['novo@example.com'] } });
    expect(gw.mails[0]!.text).toContain('convidou este endereço');
    expect(gw.mails[0]!.text).not.toContain('há uma conta');
  });

  it('refuses unknown, used and second codes and codes past their date', async () => {
    const gw = await startGateway();
    const ana = await signup(gw);
    const bia = await signup(gw, 'bia@example.com');
    const [first, second] = await makeCoupons(gw, { count: 2 });
    const [dated] = await makeCoupons(gw, { expiresAt: new Date(gw.clock.now + 86_400_000).toISOString() });
    expect((await redeem(gw, ana, 'UCAST-NOPE-NOPE')).json.error.code).toBe('invalid_coupon');
    expect((await redeem(gw, ana, first!.code)).status).toBe(200);
    expect((await redeem(gw, bia, first!.code)).json.error.code).toBe('coupon_used');
    expect((await redeem(gw, ana, second!.code)).json.error.code).toBe('coupon_already_redeemed');
    gw.clock.now += 2 * 86_400_000;
    expect((await redeem(gw, bia, dated!.code)).json.error.code).toBe('coupon_expired');
  });

  it('a shared code serves as many accounts as its limit and survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'accounts-'));
    try {
      const gw = await startGateway({}, { dir });
      const ana = await signup(gw);
      const [coupon] = await makeCoupons(gw, { maxUses: 2, months: 6 });
      expect((await redeem(gw, ana, coupon!.code)).json.quota.grantEndsAt).toBe('2027-04-10T12:00:00.000Z');
      await gw.close();
      const restarted = await startGateway({}, { dir });
      const login = await call(restarted, 'POST', '/v1/account/login', { body: { email: 'ana@example.com', password: 'senha-forte-123' } });
      expect((await me(restarted, { cookie: cookieOf(login) })).quota).toMatchObject({ plan: 'pro', viaCoupon: true });
      const bia = await signup(restarted, 'bia@example.com');
      const cris = await signup(restarted, 'cris@example.com');
      expect((await redeem(restarted, bia, coupon!.code)).status).toBe(200);
      expect((await redeem(restarted, cris, coupon!.code)).json.error.code).toBe('coupon_used');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('coupons in the admin panel (session)', () => {
  const OWNER = 'dono@ucast.me';
  const withSession = (s: { cookie: string; csrf: string }) => ({ Cookie: s.cookie, 'X-CSRF-Token': s.csrf });

  it('only the admin account lists, creates and e-mails coupons', async () => {
    const gw = await startGateway({ adminEmails: [OWNER] });
    const owner = await signup(gw, OWNER);
    const ana = await signup(gw, 'ana@example.com');
    expect((await call(gw, 'GET', '/v1/account/coupons', { headers: withSession(ana) })).status).toBe(403);
    expect((await call(gw, 'POST', '/v1/account/coupons', { headers: withSession(ana), body: { count: 1 } })).status).toBe(403);
    expect((await call(gw, 'POST', '/v1/account/coupons/send', { headers: withSession(ana), body: { code: 'x', email: 'a@b.co' } })).status).toBe(403);
    const made = await call(gw, 'POST', '/v1/account/coupons', { headers: withSession(owner), body: { count: 2, months: 3, note: 'turma B' } });
    expect(made.status).toBe(201);
    expect(made.json.coupons).toHaveLength(2);
    const listed = await call(gw, 'GET', '/v1/account/coupons', { headers: withSession(owner) });
    expect(listed.json.coupons.map((c: { uses: number }) => c.uses)).toEqual([0, 0]);
  });

  it('creating with e-mails sends one single-use code to each address, in the admin language', async () => {
    const gw = await startGateway({ adminEmails: [OWNER] });
    const owner = await signup(gw, OWNER);
    gw.mails.length = 0;
    const r = await call(gw, 'POST', '/v1/account/coupons', { headers: { ...withSession(owner), 'Accept-Language': 'fr' }, body: { emails: ['Bia@Example.com', 'cris@example.com'], months: 3 } });
    expect(r.status).toBe(201);
    expect(r.json.coupons).toHaveLength(2);
    expect(gw.mails.map(m => m.to)).toEqual(['bia@example.com', 'cris@example.com']);
    expect(gw.mails[0]!.subject).toBe('Votre code ucast.me');
    expect(gw.mails[0]!.text).toContain(r.json.coupons[0].code);
    expect(gw.mails[1]!.text).toContain(r.json.coupons[1].code);
    expect(r.json.coupons.every((c: { maxUses: number }) => c.maxUses === 1)).toBe(true);
  });

  it('sends an existing code to one address and refuses a bad address or an unknown code', async () => {
    const gw = await startGateway({ adminEmails: [OWNER] });
    const owner = await signup(gw, OWNER);
    const made = await call(gw, 'POST', '/v1/account/coupons', { headers: withSession(owner), body: {} });
    const code = made.json.coupons[0].code as string;
    gw.mails.length = 0;
    const sent = await call(gw, 'POST', '/v1/account/coupons/send', { headers: withSession(owner), body: { code, email: 'Dani@Example.com' } });
    expect(sent.json).toEqual({ ok: true, email: 'dani@example.com' });
    expect(gw.mails).toHaveLength(1);
    expect(gw.mails[0]!.text).toContain(code);
    expect((await call(gw, 'POST', '/v1/account/coupons/send', { headers: withSession(owner), body: { code, email: 'not-an-email' } })).json.error.code).toBe('invalid_email');
    expect((await call(gw, 'POST', '/v1/account/coupons/send', { headers: withSession(owner), body: { code: 'UCAST-NOPE-NOPE', email: 'a@b.co' } })).json.error.code).toBe('invalid_coupon');
    expect((await call(gw, 'POST', '/v1/account/coupons', { headers: withSession(owner), body: { emails: ['ok@example.com', 'bad'] } })).json.error.code).toBe('invalid_email');
  });
});

describe('account page script', () => {
  it.each(['pt', 'en', 'fr'])('is valid JavaScript in %s and carries the coupon card and the admin panel', async (lang) => {
    const gw = await startGateway();
    const page = await call(gw, 'GET', '/account', { host: SITE, headers: { 'Accept-Language': lang } });
    expect(page.status).toBe(200);
    const scripts = [...page.text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]!).filter(Boolean);
    expect(scripts.length).toBeGreaterThan(0);
    for (const source of scripts) expect(() => new Function(source)).not.toThrow();
    for (const id of ['cf', 'cc', 'cb', 'cm', 'cpf', 'cpb', 'cam', 'coupons']) expect(page.text).toContain(`id="${id}"`);
  });
});

describe('coupon invitations', () => {
  const OWNER = 'dono@ucast.me';
  const withSession = (s: { cookie: string; csrf: string }) => ({ Cookie: s.cookie, 'X-CSRF-Token': s.csrf });

  it('writes the e-mail in the language the admin picks, whatever the page language', async () => {
    const gw = await startGateway({ adminEmails: [OWNER] });
    const owner = await signup(gw, OWNER);
    gw.mails.length = 0;
    const r = await call(gw, 'POST', '/v1/account/coupons', { headers: { ...withSession(owner), 'Accept-Language': 'fr' }, body: { emails: ['novo@example.com'], lang: 'en' } });
    expect(r.status).toBe(201);
    expect(gw.mails[0]!.subject).toBe('Your ucast.me code');
    const code = r.json.coupons[0].code as string;
    gw.mails.length = 0;
    expect((await call(gw, 'POST', '/v1/account/coupons/send', { headers: withSession(owner), body: { code, email: 'outro@example.com', lang: 'pt' } })).status).toBe(200);
    expect(gw.mails[0]!.subject).toBe('Seu código do ucast.me');
    gw.mails.length = 0;
    await call(gw, 'POST', '/v1/account/coupons/send', { headers: withSession(owner), body: { code, email: 'mais@example.com', lang: 'xx' } });
    expect(gw.mails[0]!.subject).toMatch(/code|código/i);
  });

  it('invites any address without an account, skips and reports the ones that already have one', async () => {
    const gw = await startGateway({ adminEmails: [OWNER] });
    const owner = await signup(gw, OWNER);
    await signup(gw, 'ana@example.com');
    gw.mails.length = 0;
    const r = await call(gw, 'POST', '/v1/account/coupons', { headers: withSession(owner), body: { emails: ['ANA@example.com', 'novo@example.com', 'novo@example.com', 'outro@qualquer-lugar.org'] } });
    expect(r.status).toBe(201);
    expect(r.json.skipped).toEqual(['ana@example.com']);
    expect(r.json.coupons).toHaveLength(2);
    expect(gw.mails.map(m => m.to)).toEqual(['novo@example.com', 'outro@qualquer-lugar.org']);
    const listed = await call(gw, 'GET', '/v1/account/coupons', { headers: withSession(owner) });
    expect(listed.json.coupons).toHaveLength(2);
  });

  it('refuses a batch where every address already has an account, and a single send to one of them', async () => {
    const gw = await startGateway({ adminEmails: [OWNER] });
    const owner = await signup(gw, OWNER);
    await signup(gw, 'ana@example.com');
    const all = await call(gw, 'POST', '/v1/account/coupons', { headers: withSession(owner), body: { emails: ['ana@example.com', OWNER] } });
    expect(all.status).toBe(409);
    expect(all.json.error.code).toBe('coupon_email_registered');
    expect((await call(gw, 'GET', '/v1/account/coupons', { headers: withSession(owner) })).json.coupons).toHaveLength(0);
    const made = await call(gw, 'POST', '/v1/account/coupons', { headers: withSession(owner), body: {} });
    const single = await call(gw, 'POST', '/v1/account/coupons/send', { headers: withSession(owner), body: { code: made.json.coupons[0].code, email: 'ana@example.com' } });
    expect(single.json.error.code).toBe('coupon_email_registered');
  });
});
