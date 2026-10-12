import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { AccessKeys } from '../../src/config/access-keys';
import { ADMIN_ANCHORS, ADMIN_COOKIE, createAdminPage } from '../../src/admin-page';
import { demoSnapshot } from '../__fixtures__/admin-snapshot';
import { renderStatus } from '../../src/admin-page/render';
import { adminTraffic } from '../../src/admin-page/traffic';

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
    for (const title of ['Reservas', 'Saldos', 'GPUs', 'Avisos e alertas', 'Máquinas avulsas', 'Chaves', 'Apps', 'Tráfego', 'Atividade']) expect(html).toContain(title);
    expect(html).toContain('fora da janela de aula');
    expect(gw.audit.some(e => e.action === 'admin-page.login' && e.actor === 'marcos')).toBe(true);
    expect(JSON.stringify(gw.audit)).not.toContain(ADMIN_KEY);
  });

  it('gives every section its stable anchor', async () => {
    const gw = await gateway();
    const { html } = await gw.signedIn();
    for (const id of ADMIN_ANCHORS) {
      expect(html).toContain(`<section id="${id}" data-spy>`);
      expect(html).toContain(`href="#${id}"`);
    }
  });

  it('filters the apps section by ?app=', async () => {
    const gw = await gateway();
    const { cookie } = await gw.login();
    const html = await (await gw.call('/admin?app=parle', { cookie })).text();
    const apps = html.slice(html.indexOf('<section id="apps"'), html.indexOf('<section id="gpus"'));
    expect(apps).toContain('precisa de GPU (speech-stack)');
    expect(apps).not.toContain('babelcast');
    expect(await (await gw.call('/admin', { cookie })).text()).toMatch(/<section id="apps"[^>]*>[\s\S]*babelcast/);
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

  it('lists the worst areas first in the attention list and names every state in text, not only in color', () => {
    const now = Date.parse('2026-10-13T10:00:00Z');
    const render = (state: 'ok' | 'warn' | 'bad') => renderStatus('n', demoSnapshot(now, state), { now, csrf: 'c', actor: 'marcos', message: null, app: null });
    const attention = (html: string) => [...(/<ul class="attn"[^]*?<\/ul>/.exec(html)?.[0] ?? '').matchAll(/<a href="#([a-z]+)">/g)].map(m => m[1]);
    const bad = render('bad');
    expect(attention(bad).slice(0, 3).sort()).toEqual(['apps', 'reservas', 'trafego']);
    expect(bad).toContain('Algo está fora do ar');
    expect(bad).toMatch(/<section id="reservas" data-spy><header class="sh"><h2>Reservas<\/h2><span class="pill bad">/);
    expect(bad).toContain('<span class="sr">Problema:</span>');
    expect(bad).toContain('Texto → fala sem resposta na nuvem');
    const ok = render('ok');
    expect(attention(ok)).toEqual([]);
    expect(ok).toContain('Tudo funcionando');
    expect(ok).not.toMatch(/<h2>[^<]+<\/h2><span class="pill (bad|warn)">/);
  });

  it('shows the overview figures, traffic per stage and provider, who woke a GPU and the activity log', () => {
    const now = Date.parse('2026-10-13T10:00:00Z');
    const snapshot = demoSnapshot(now, 'warn');
    const html = renderStatus('n', snapshot, { now, csrf: 'c', actor: 'marcos', message: null, app: null });
    for (const label of ['Chamadas 24 h', 'Sem resposta 24 h', 'Latência p95', 'GPUs ligadas', 'Gasto GPU hoje', 'Menor saldo']) expect(html).toContain(label);
    const traffic = html.slice(html.indexOf('<section id="trafego"'), html.indexOf('<section id="apps"'));
    expect(traffic).toContain('<code>deployment:speech-stack</code>');
    expect(traffic).toContain('<code>openrouter</code>');
    expect(traffic).toMatch(/aria-label="Chamadas por hora/);
    const gpus = html.slice(html.indexOf('<section id="gpus"'), html.indexOf('<section id="reservas"'));
    expect(gpus).toMatch(/parle até \d\d:\d\d/);
    const activity = html.slice(html.indexOf('<section id="atividade"'));
    expect(activity).toContain('estacionou a GPU');
    expect(activity).toContain('falha ao criar réplica');
    expect(activity).toContain('réplica ainda criando');
  });
});

describe('adminTraffic', () => {
  const now = Date.parse('2026-10-13T10:30:00Z');
  const row = (minutesAgo: number, event: string, extra: Record<string, unknown> = {}) =>
    ({ seq: 0, rxTs: now - minutesAgo * 60_000, ts: now - minutesAgo * 60_000, source: 'gateway', level: 'info', event, traceId: '1'.repeat(32), ...extra }) as never;

  it('counts the last 24 h by hour, stage and provider, with p50/p95, and keeps GPU lifecycle events', () => {
    const rows = [
      row(25 * 60, 'route.served', { durMs: 9_999, attrs: { stage: 'stt', provider: 'openrouter' } }),
      row(120, 'route.fallback', { attrs: { stage: 'tts', provider: 'deployment:speech-stack' } }),
      row(119, 'route.unavailable', { level: 'error', durMs: 30_000, attrs: { stage: 'tts' } }),
      ...[100, 200, 300, 400].map((ms, i) => row(10 + i, 'route.served', { durMs: ms, attrs: { stage: 'stt', provider: 'openrouter' } })),
      row(5, 'replica.ready', { deployment: 'speech-stack', replicaId: 'r1' }),
      row(4, 'edge.stt.done', { source: 'edge' }),
    ].sort((a: { rxTs: number }, b: { rxTs: number }) => a.rxTs - b.rxTs);
    const t = adminTraffic(rows, now);
    expect(t.hours).toHaveLength(24);
    expect(t.total).toMatchObject({ served: 4, failed: 1, fallbacks: 1, p50Ms: 200, p95Ms: 400 });
    expect(t.hours.at(-1)).toMatchObject({ served: 4, failed: 0 });
    expect(t.hours.reduce((n, h) => n + h.failed, 0)).toBe(1);
    expect(t.stages.find(s => s.key === 'tts')).toMatchObject({ served: 0, failed: 1, fallbacks: 1 });
    expect(t.providers.map(p => p.key)).toEqual(['openrouter', 'deployment:speech-stack']);
    expect(t.activity).toEqual([{ at: new Date(now - 5 * 60_000).toISOString(), event: 'replica.ready', level: 'info', deployment: 'speech-stack', replicaId: 'r1' }]);
  });
  it('names each app and says what it is for', () => {
    const now = Date.parse('2026-10-13T10:00:00Z');
    const snapshot = demoSnapshot(now, 'ok');
    snapshot.apps.push({ id: 'ucast', profile: { requiresGpu: false, gpuDeployments: [], name: 'uCast', description: 'Podcasts <b>ao vivo</b>' }, status: null });
    const html = renderStatus('n', snapshot, { now, csrf: 'c', actor: 'marcos', message: null, app: null });
    expect(html).toContain('>Parle</a>');
    expect(html).toContain('Tradução simultânea');
    expect(html).toContain('>uCast</a></b> <span class="mono">ucast</span>');
    expect(html).toContain('Podcasts &#60;b&#62;ao vivo&#60;/b&#62;');
  });
});
