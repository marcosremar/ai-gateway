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
import { AppLimits } from '../../../src/gateway/proxy/app-limits';
import { AccessKeys } from '../../../src/config/access-keys';
import { AdminGate } from '../../../src/config/admin-gate';
import { createAccessRoutes } from '../../../src/config/access-routes';
import { KeyAudit } from '../../../src/config/key-audit';
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

async function startGateway(config: Partial<AccountsConfig> = {}, opts: { adminApp?: boolean; dir?: string } = {}): Promise<Gw> {
  const clock = { now: Date.UTC(2026, 9, 10, 12) };
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'accounts-'));
  const mails: EmailMessage[] = [];
  const email: EmailSender = { configured: true, send: async (m) => { mails.push(m); } };
  const access = new AccessKeys({ GATEWAY_API_KEYS: `${ADMIN_KEY}:ops,${APP_KEY}:babelcast` }, { now: () => clock.now });
  access.setBaseAdmins(opts.adminApp ? ['ops', 'babelcast'] : ['ops']);
  const accounts = createAccounts({
    env: {},
    config: {
      statePath: join(dir, 'accounts.json'), usagePath: join(dir, 'account-usage.json'),
      siteHosts: [SITE], publicBaseUrl: 'https://ucast.me', cookieSecure: true, ...config,
    },
    email, isAdmin: (u) => access.admins.has(u), now: () => clock.now,
  });
  await accounts.init();
  const keyRegistry = {
    get size() { return access.size + accounts.activeKeyCount; },
    resolve: (t: string) => access.resolve(t) ?? accounts.resolveAppKey(t),
  };
  const gate = new AdminGate({ actorOf: (t) => { const u = keyRegistry.resolve(t)?.userId; return u && access.admins.has(u) ? u : null; } });
  const appLimits = new AppLimits({
    env: {}, now: () => clock.now, isAdmin: (u) => access.admins.has(u),
    aliasesOf: (u, stage) => (u === 'babelcast' ? new Set(stage === 'stt' ? ['whisper-large-v3'] : stage === 'chat' ? ['llm'] : ['tts']) : null),
  });
  const server = createProxyServer({
    keyRegistry,
    providers: { stt: { 'whisper-large-v3': fakeStt }, chat: { llm: fakeLlm } },
    appLimits,
    deepHealth: { authorize: (t) => access.admins.has(keyRegistry.resolve(t)?.userId ?? ''), report: async () => ({ status: 200, body: { deep: true } }) },
    customRoutes: [
      ...createAccessRoutes({ access, gate, audit: new KeyAudit() }),
      { method: 'POST', path: '/v1/rooms', handler: async (_req, res) => { res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{"code":"K7Q2XM"}'); } },
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

async function signup(gw: Gw, email = 'Ana@Example.com', password = 'senha-forte-123') {
  const r = await call(gw, 'POST', '/v1/account/signup', { body: { email, password } });
  expect(r.status).toBe(201);
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
    expect(gw.mails.filter(m => m.to === 'u1@example.com')).toHaveLength(3);
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
    const gw = await startGateway({ quota: { audioSeconds: 3, llmTokens: 0, ttsChars: 0, rooms: 0, requestsPerDay: 0 } });
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

  it('over the daily request cap → 429 with Retry-After', async () => {
    const gw = await startGateway({ quota: { audioSeconds: 0, llmTokens: 0, ttsChars: 0, rooms: 0, requestsPerDay: 2 } });
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
    expect(dash.text).toContain('Sua chave de ativação');
    expect(dash.text).not.toMatch(/ style="/);
  });
});

describe('helpers', () => {
  it('reads WAV durations', () => {
    expect(wavSeconds(wav(2.5))).toBeCloseTo(2.5, 3);
    expect(wavSeconds(Buffer.from('not a wav at all'))).toBeNull();
  });
});
