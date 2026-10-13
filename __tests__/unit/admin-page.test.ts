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
const BABEL_KEY = 'gw_babel_0123456789abcdef0123';
const SITE_KEY = 'gw_site_0123456789abcdef01234';
const PROVIDER_SECRET = 'scw-secret-value-9f8e7d6c5b4a';
const LEAK = /(sk-|gw_|key-)[A-Za-z0-9_-]{4,}/;

const open: Server[] = [];
afterEach(async () => { while (open.length) await new Promise(r => open.pop()!.close(r)); });

async function gateway() {
  const clock = { now: Date.parse('2026-10-13T10:00:00Z') };
  const access = new AccessKeys({ GATEWAY_API_KEYS: `${ADMIN_KEY}:marcos,${CLIENT_KEY}:parle,${DEV_KEY}:parle-dev:agentes,${BABEL_KEY}:babelcast,${SITE_KEY}:site` });
  access.setBaseAdmins(['marcos']);
  const parked: string[] = [];
  const pins: Array<[string, boolean]> = [];
  const dismissed: string[] = [];
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
    actorOf: (key) => {
      const found = access.resolve(key);
      if (!found) return null;
      if (access.admins.has(found.userId)) return { name: found.userId, app: null };
      if (!snapshot.apps.some(a => a.id === found.userId)) return null;
      return { name: found.userId, app: found.userId, keyId: found.keyId, mayPark: () => access.policyOf(found.keyId).canStartGpu };
    },
    snapshot: () => snapshot,
    park: async (name) => { parked.push(name); },
    pin: async (name, on) => { pins.push([name, on]); },
    probe: async () => { probes++; },
    dismiss: async (id) => { dismissed.push(id); snapshot.dismissed = { ...snapshot.dismissed, [id]: clock.now + 7 * 86_400_000 }; },
    secrets: () => [ADMIN_KEY, CLIENT_KEY, DEV_KEY, BABEL_KEY, SITE_KEY, PROVIDER_SECRET],
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
  async function signedIn(key = ADMIN_KEY) {
    const { cookie } = await login(key);
    const html = await (await call('/admin', { cookie })).text();
    return { cookie, html, csrf: /name="csrf" value="([a-f0-9]+)"/.exec(html)![1] };
  }
  return { clock, access, call, post, login, signedIn, parked, pins, dismissed, audit, probes: () => probes };
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

  it('refuses a dev key and a client key that is no registered app', async () => {
    const gw = await gateway();
    for (const key of [DEV_KEY, SITE_KEY, 'not-a-key']) {
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

  it('lets an app key in and shows only that app', async () => {
    const gw = await gateway();
    const { res } = await gw.login(CLIENT_KEY);
    expect(res.status).toBe(303);
    const { html } = await gw.signedIn(CLIENT_KEY);
    expect(html).toContain('Visão do app <b>Parle</b>');
    expect(html).toContain('ai-gateway <small>app</small>');
    expect(html).toContain('parle (producao)');
    expect(html).toContain('speech-stack');
    for (const other of ['babelcast', 'Babelcast', 'babel-live', 'babel-tts', 'gpt-4o-mini-tts', 'legendas-ao-vivo', 'parle-dev', 'agentes', 'marcos', 'palco', 'm-7c1e', 'scaleway']) {
      expect(html).not.toContain(other);
    }
    for (const hidden of ['saldos', 'maquinas', 'trafego']) {
      expect(html).not.toContain(`id="${hidden}"`);
      expect(html).not.toContain(`href="#${hidden}"`);
    }
    expect(html).not.toContain('Saldos');
    expect(html).not.toContain('Máquinas avulsas');
    expect(html).not.toContain('/admin/probe');
    expect(html).not.toContain('/admin/park');
    for (const secret of [ADMIN_KEY, CLIENT_KEY, DEV_KEY, BABEL_KEY, PROVIDER_SECRET]) expect(html).not.toContain(secret);
    expect(html).not.toMatch(LEAK);
  });

  it('ignores ?app= for an app session', async () => {
    const gw = await gateway();
    const { cookie } = await gw.login(CLIENT_KEY);
    const html = await (await gw.call('/admin?app=babelcast', { cookie })).text();
    expect(html).toContain('Visão do app <b>Parle</b>');
    expect(html).not.toContain('babelcast');
  });

  it('refuses admin-only actions to an app session and parks only its own GPU when its policy allows', async () => {
    const gw = await gateway();
    const { cookie, csrf } = await gw.signedIn(CLIENT_KEY);
    expect((await gw.post('/admin/probe', { csrf }, cookie)).status).toBe(403);
    expect((await gw.post('/admin/park', { name: 'speech-stack', csrf }, cookie)).status).toBe(403);
    await gw.access.setPolicy({ id: 'env-parle', canStartGpu: true });
    expect((await gw.post('/admin/park', { name: 'babel-live', csrf }, cookie)).status).toBe(403);
    expect((await gw.post('/admin/park', { name: 'speech-stack', csrf }, cookie)).status).toBe(303);
    expect(gw.parked).toEqual(['speech-stack']);
    expect(gw.probes()).toBe(0);
    expect(await (await gw.call('/admin', { cookie })).text()).toContain('action="/admin/park"');
    expect(gw.audit.filter(e => !e.ok).map(e => [e.action, e.names])).toEqual([['admin-page.probe', []], ['admin-page.park', ['speech-stack']], ['admin-page.park', ['babel-live']]]);
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

  it('shows the pinned Vast GPU with its provider, price in US$, offer and park rule; the toggle is the admin\'s, signed and audited', async () => {
    const gw = await gateway();
    const { cookie, csrf, html } = await gw.signedIn();
    const at = html.indexOf('<b class="mono">babelcast-3090');
    const row = html.slice(at, html.indexOf('</tr>', at));
    expect(row).toContain('Vast · laboratório, barata');
    expect(row).toContain('fixada');
    expect(row).toContain('estaciona após 1 h sem uso');
    expect(row).toContain('RTX 3090');
    expect(row).toContain('Lyon, FR');
    expect(row).toMatch(/US\$\s?0,19\/h/);
    expect(row).toContain('hoje ≈');
    expect(row).toContain('action="/admin/pin"');
    const scw = html.indexOf('<b class="mono">speech-stack');
    expect(html.slice(scw, html.indexOf('</tr>', scw))).toContain('Scaleway · produção');
    expect(html).toMatch(/<code>babelcast-3090<\/code>.*Vast · laboratório, barata.*fixada/);

    expect((await gw.post('/admin/pin', { name: 'babelcast-3090', on: '0' }, cookie)).status).toBe(403);
    expect((await gw.post('/admin/pin', { name: 'babelcast-3090', on: '0', csrf }, cookie, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    const res = await gw.post('/admin/pin', { name: 'babelcast-3090', on: '0', csrf }, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/#gpus$/);
    expect((await gw.post('/admin/pin', { name: 'babelcast-3090', on: '1', csrf }, cookie)).status).toBe(303);
    expect(gw.pins).toEqual([['babelcast-3090', false], ['babelcast-3090', true]]);
    expect(gw.audit.filter(e => String(e.action).includes('pin'))).toEqual([
      { actor: 'marcos', action: 'admin-page.unpin', names: ['babelcast-3090'], ok: true },
      { actor: 'marcos', action: 'admin-page.pin', names: ['babelcast-3090'], ok: true },
    ]);
  });

  it('an app session never sees nor uses the pin toggle', async () => {
    const gw = await gateway();
    await gw.access.setPolicy({ id: 'env-babelcast', canStartGpu: true });
    const { cookie, csrf, html } = await gw.signedIn(BABEL_KEY);
    expect(html).toContain('babelcast-3090');
    expect(html).not.toContain('/admin/pin');
    expect((await gw.post('/admin/pin', { name: 'babelcast-3090', on: '0', csrf }, cookie)).status).toBe(403);
    expect(gw.pins).toEqual([]);
    expect(gw.audit.at(-1)).toMatchObject({ action: 'admin-page.pin', names: ['babelcast-3090'], ok: false });
  });

  it('hides a recommendation for 7 days only for the admin, with the CSRF token', async () => {
    const gw = await gateway();
    const { cookie, csrf, html } = await gw.signedIn();
    const id = 'app-unnamed:babelcast';
    expect(html).toContain(`value="${id}"`);
    expect((await gw.post('/admin/dismiss', { id }, cookie)).status).toBe(403);
    expect((await gw.post('/admin/dismiss', { id, csrf }, cookie, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    const app = await gw.signedIn(CLIENT_KEY);
    expect(app.html).not.toContain('action="/admin/dismiss"');
    expect((await gw.post('/admin/dismiss', { id, csrf: app.csrf }, app.cookie)).status).toBe(403);
    expect(gw.dismissed).toEqual([]);
    const res = await gw.post('/admin/dismiss', { id, csrf }, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/#recomendacoes$/);
    expect(gw.dismissed).toEqual([id]);
    expect(await (await gw.call('/admin', { cookie })).text()).not.toContain(`value="${id}"`);
    gw.clock.now += 7 * 86_400_000 + 1;
    expect((await gw.signedIn()).html).toContain(`value="${id}"`);
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
    expect(attention(bad).slice(0, 4).sort()).toEqual(['apps', 'garantia', 'reservas', 'trafego']);
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
    expect(gpus).toMatch(/parle \(producao\) até \d\d:\d\d/);
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
