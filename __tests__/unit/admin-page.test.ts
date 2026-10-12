import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { AccessKeys } from '../../src/config/access-keys';
import { ADMIN_ANCHORS, ADMIN_COOKIE, createAdminPage } from '../../src/admin-page';
import { demoSnapshot } from '../__fixtures__/admin-snapshot';

const ADMIN_KEY = 'gw_admin_0123456789abcdef0123';
const CLIENT_KEY = 'gw_client_0123456789abcdef012';
const DEV_KEY = 'gw_dev_0123456789abcdef012345';
const PROVIDER_SECRET = 'scw-secret-value-9f8e7d6c5b4a';
const LEAK = /(sk-|gw_|key-)[A-Za-z0-9_-]{4,}/;

const open: Server[] = [];
afterEach(async () => { while (open.length) await new Promise(r => open.pop()!.close(r)); });

async function gateway() {
  const clock = { now: Date.parse('2026-10-13T10:00:00Z') };
  const access = new AccessKeys({ GATEWAY_API_KEYS: `${ADMIN_KEY}:marcos,${CLIENT_KEY}:parle,${DEV_KEY}:parle-dev:agentes` });
  access.setBaseAdmins(['marcos']);
  const parked: string[] = [];
  const audit: Array<Record<string, unknown>> = [];
  let probes = 0;
  const server = createServer((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":"unauthorized"}');
  });
  const snapshot = demoSnapshot(clock.now);
  snapshot.gpus![0] = { ...snapshot.gpus![0], lastError: `boot failed: token ${PROVIDER_SECRET}` };
  snapshot.alerts.unshift({ event: 'fallback.probe_failed', at: new Date(clock.now).toISOString(), summary: 'error: Bearer sk-or-v1-0123456789abcdef0123 refused' });
  createAdminPage({
    actorOf: (key) => { const user = access.resolve(key)?.userId; return user && access.admins.has(user) ? user : null; },
    snapshot: () => snapshot,
    park: async (name) => { parked.push(name); },
    probe: async () => { probes++; },
    secrets: () => [ADMIN_KEY, CLIENT_KEY, DEV_KEY, PROVIDER_SECRET],
    audit: (entry) => audit.push(entry),
    now: () => clock.now,
  }).mount(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  open.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit & { cookie?: string } = {}) => fetch(base + path, {
    redirect: 'manual', ...init, headers: { ...(init.cookie ? { Cookie: init.cookie } : {}), ...(init.headers as Record<string, string> ?? {}) },
  });
  const post = (path: string, fields: Record<string, string>, cookie?: string, headers: Record<string, string> = {}) => call(path, {
    method: 'POST', body: new URLSearchParams(fields).toString(), cookie,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', ...headers },
  });
  async function login(key = ADMIN_KEY, next?: string) {
    const res = await post('/admin/login', { key, ...(next ? { next } : {}) });
    const setCookie = res.headers.get('set-cookie') ?? '';
    return { res, setCookie, cookie: setCookie.split(';')[0] };
  }
  async function signedIn() {
    const { cookie } = await login();
    const html = await (await call('/admin', { cookie })).text();
    return { cookie, html, csrf: /name="csrf" value="([a-f0-9]+)"/.exec(html)![1] };
  }
  return { clock, call, post, login, signedIn, parked, audit, probes: () => probes };
}

describe('admin page (/admin)', () => {
  it('without a session shows the login form, not the data', async () => {
    const gw = await gateway();
    const res = await gw.call('/admin');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(html).toContain('name="key"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain('Reservas');
    expect(html).not.toContain('speech-stack');
  });

  it('refuses a client key and a dev key', async () => {
    const gw = await gateway();
    for (const key of [CLIENT_KEY, DEV_KEY, 'not-a-key']) {
      const { res, setCookie } = await gw.login(key);
      expect(res.status).toBe(401);
      expect(setCookie).toBe('');
    }
  });

  it('lets the admin key in with a short HttpOnly Secure SameSite=Strict cookie', async () => {
    const gw = await gateway();
    const { res, setCookie } = await gw.login();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin');
    expect(setCookie).toMatch(new RegExp(`^${ADMIN_COOKIE}=[a-f0-9]{64}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$`));
    const { html } = await gw.signedIn();
    for (const title of ['Reservas', 'Saldos', 'GPUs', 'Avisos e alertas', 'Máquinas avulsas', 'Chaves', 'Apps']) expect(html).toContain(title);
    expect(html).toContain('fora da janela de aula');
    expect(gw.audit.some(e => e.action === 'admin-page.login' && e.actor === 'marcos')).toBe(true);
    expect(JSON.stringify(gw.audit)).not.toContain(ADMIN_KEY);
  });

  it('gives every section its stable anchor', async () => {
    const gw = await gateway();
    const { html } = await gw.signedIn();
    for (const id of ADMIN_ANCHORS) {
      expect(html).toContain(`<section id="${id}">`);
      expect(html).toContain(`href="#${id}"`);
    }
  });

  it('filters the apps section by ?app=', async () => {
    const gw = await gateway();
    const { cookie } = await gw.login();
    const html = await (await gw.call('/admin?app=parle', { cookie })).text();
    const apps = html.slice(html.indexOf('<section id="apps">'));
    expect(apps).toContain('precisa de GPU (speech-stack)');
    expect(apps).not.toContain('babelcast');
    expect(await (await gw.call('/admin', { cookie })).text()).toMatch(/<section id="apps">[\s\S]*babelcast/);
  });

  it('after login goes back to the URL and anchor it was opened with', async () => {
    const gw = await gateway();
    const form = await (await gw.call('/admin?app=parle')).text();
    expect(form).toContain('name="next" value="/admin?app=parle"');
    expect((await gw.login(ADMIN_KEY, '/admin?app=parle#apps')).res.headers.get('location')).toBe('/admin?app=parle#apps');
    expect((await gw.login(ADMIN_KEY, '/admin#gpus')).res.headers.get('location')).toBe('/admin#gpus');
    for (const evil of ['https://evil.example/admin', '//evil.example', '/admin/../v1', '/admin?app=x"><script>']) {
      expect((await gw.login(ADMIN_KEY, evil)).res.headers.get('location')).toBe('/admin');
    }
  });

  it('expires the session after 12 h', async () => {
    const gw = await gateway();
    const { cookie } = await gw.login();
    gw.clock.now += 12 * 3_600_000 + 1;
    expect(await (await gw.call('/admin', { cookie })).text()).toContain('name="key"');
  });

  it('never shows a secret', async () => {
    const gw = await gateway();
    const { html } = await gw.signedIn();
    for (const secret of [ADMIN_KEY, CLIENT_KEY, DEV_KEY, PROVIDER_SECRET]) expect(html).not.toContain(secret);
    expect(html).not.toMatch(LEAK);
  });

  it('blocks a POST without the CSRF token or from another site', async () => {
    const gw = await gateway();
    const { cookie, csrf } = await gw.signedIn();
    expect((await gw.post('/admin/park', { name: 'speech-stack' }, cookie)).status).toBe(403);
    expect((await gw.post('/admin/park', { name: 'speech-stack', csrf: '0'.repeat(64) }, cookie)).status).toBe(403);
    expect((await gw.post('/admin/park', { name: 'speech-stack', csrf }, cookie, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await gw.post('/admin/park', { name: 'speech-stack', csrf })).status).toBe(403);
    expect((await gw.post('/admin/probe', {}, cookie)).status).toBe(403);
    expect(gw.parked).toEqual([]);
    expect(gw.probes()).toBe(0);
  });

  it('parks a GPU and reruns the reserve test with the token', async () => {
    const gw = await gateway();
    const { cookie, csrf } = await gw.signedIn();
    const res = await gw.post('/admin/park', { name: 'speech-stack', csrf }, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/#gpus$/);
    expect(gw.parked).toEqual(['speech-stack']);
    expect((await gw.post('/admin/probe', { csrf }, cookie)).status).toBe(303);
    expect(gw.probes()).toBe(1);
    expect(gw.audit.map(e => e.action)).toEqual(['admin-page.login', 'admin-page.park', 'admin-page.probe']);
  });

  it('signs out', async () => {
    const gw = await gateway();
    const { cookie, csrf } = await gw.signedIn();
    const res = await gw.post('/admin/logout', { csrf }, cookie);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await (await gw.call('/admin', { cookie })).text()).toContain('name="key"');
  });

  it('leaves every other path to the API', async () => {
    const gw = await gateway();
    const res = await gw.call('/v1/admin/keys');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/json');
  });
});
