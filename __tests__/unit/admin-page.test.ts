import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { AccessKeys } from '../../src/config/access-keys';
import { ADMIN_ANCHORS, ADMIN_COOKIE, ANCHOR_PAGE, PAGES, createAdminPage, recommendations, scopeToApp } from '../../src/admin-page';
import { demoSnapshot } from '../__fixtures__/admin-snapshot';
import { renderStatus } from '../../src/admin-page/pages';
import { adminTraffic, answeredShare, gpuShare, sloLevel } from '../../src/admin-page/traffic';

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
  let digests = 0;
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
    sendDigest: async () => { digests++; return 'mail-1'; },
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
  const every = async (cookie: string, query = '') => (await Promise.all(PAGES.map(async p => (await call(p.path + query, { cookie })).text()))).join('');
  return { clock, access, call, post, login, signedIn, every, parked, pins, dismissed, audit, snapshot, probes: () => probes, digests: () => digests };
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
    const { cookie } = await gw.signedIn();
    const html = await gw.every(cookie);
    for (const title of ['Reservas', 'Saldos', 'GPUs', 'Alertas enviados', 'Máquinas avulsas', 'Chaves', 'Apps', 'Tráfego', 'Quem fez o quê']) expect(html).toContain(title);
    expect(html).toContain('fora da janela de aula');
    expect(gw.audit.some(e => e.action === 'admin-page.login' && e.actor === 'marcos')).toBe(true);
    expect(JSON.stringify(gw.audit)).not.toContain(ADMIN_KEY);
  });

  it('serves one page per area, each from the nav, and asks for the key on every one without a session', async () => {
    const gw = await gateway();
    const { cookie, html } = await gw.signedIn();
    for (const p of PAGES) {
      expect(html).toContain(`href="${p.path}"`);
      const res = await gw.call(p.path, { cookie });
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(new RegExp(`href="${p.path}" class="[a-z]+ cur" aria-current="page"`));
      const anonymous = await (await gw.call(p.path)).text();
      expect(anonymous).toContain('name="key"');
      expect(anonymous).toContain(`name="next" value="${p.path}"`);
    }
    expect((await gw.call('/admin/nada', { cookie })).headers.get('location')).toBe('/admin');
  });

  it('keeps every old anchor: each one lives on a page and /admin#<anchor> moves there', async () => {
    const gw = await gateway();
    const { cookie, html } = await gw.signedIn();
    expect(html).toContain(`location.replace(t+location.search+'#'+h)`);
    expect(html).toContain(JSON.stringify(ANCHOR_PAGE));
    for (const id of ADMIN_ANCHORS) {
      const path = ANCHOR_PAGE[id]!;
      expect(path, id).toBeTruthy();
      expect(await (await gw.call(path, { cookie })).text()).toContain(`<section id="${id}">`);
    }
    expect(ANCHOR_PAGE).toMatchObject({ reservas: '/admin/servicos', saldos: '/admin/gastos', gpus: '/admin/gpus', alertas: '/admin/atividade', maquinas: '/admin/gpus', chaves: '/admin/chaves', apps: '/admin/servicos' });
    expect(await (await gw.call('/admin/servicos', { cookie })).text()).toContain('id="garantia-parle"');
  });

  it('filters the apps section by ?app=', async () => {
    const gw = await gateway();
    const { cookie } = await gw.login();
    const html = await (await gw.call('/admin/servicos?app=parle', { cookie })).text();
    const apps = html.slice(html.indexOf('<section id="apps"'), html.indexOf('<section id="garantia"'));
    expect(apps).toContain('precisa de GPU (speech-stack)');
    expect(apps).not.toContain('babelcast');
    expect(html).toContain('href="/admin/gpus?app=parle"');
    expect(await (await gw.call('/admin/servicos', { cookie })).text()).toMatch(/<section id="apps"[^>]*>[\s\S]*babelcast/);
  });

  it('after login goes back to the URL and anchor it was opened with', async () => {
    const gw = await gateway();
    const form = await (await gw.call('/admin?app=parle')).text();
    expect(form).toContain('name="next" value="/admin?app=parle"');
    expect((await gw.login(ADMIN_KEY, '/admin?app=parle#apps')).res.headers.get('location')).toBe('/admin?app=parle#apps');
    expect((await gw.login(ADMIN_KEY, '/admin#gpus')).res.headers.get('location')).toBe('/admin#gpus');
    for (const next of ['/admin/gpus', '/admin/servicos?app=parle#garantia-parle', '/admin/gpus/babelcast-3090']) {
      expect((await gw.login(ADMIN_KEY, next)).res.headers.get('location')).toBe(next);
    }
    expect(await (await gw.call('/admin/gpus/babelcast-3090')).text()).toContain('name="next" value="/admin/gpus/babelcast-3090"');
    gw.clock.now += 16 * 60_000;
    for (const evil of ['https://evil.example/admin', '//evil.example', '/admin/../v1', '/admin?app=x"><script>', '/admin/outra', '/admin/gpus/../v1']) {
      expect((await gw.login(ADMIN_KEY, evil)).res.headers.get('location')).toBe('/admin');
    }
  });

  it('expires the session after 12 h', async () => {
    const gw = await gateway();
    const { cookie } = await gw.login();
    gw.clock.now += 12 * 3_600_000 + 1;
    expect(await (await gw.call('/admin', { cookie })).text()).toContain('name="key"');
  });

  it('never shows a secret, on any page', async () => {
    const gw = await gateway();
    const { cookie } = await gw.signedIn();
    const pages = [await gw.every(cookie), ...await Promise.all(gw.snapshot.gpus!.map(async d => (await gw.call(`/admin/gpus/${d.name}`, { cookie })).text()))];
    for (const html of pages) {
      for (const secret of [ADMIN_KEY, CLIENT_KEY, DEV_KEY, BABEL_KEY, SITE_KEY, PROVIDER_SECRET]) expect(html).not.toContain(secret);
      expect(html).not.toMatch(LEAK);
    }
  });

  it('lets an app key in and shows only that app', async () => {
    const gw = await gateway();
    const { res } = await gw.login(CLIENT_KEY);
    expect(res.status).toBe(303);
    const { cookie } = await gw.signedIn(CLIENT_KEY);
    const html = await gw.every(cookie);
    expect(html).toContain('Visão do app <b>Parle</b>');
    expect(html).toContain('ai-gateway <small>Parle</small>');
    expect(html).toContain('parle (producao)');
    expect(html).toContain('speech-stack');
    for (const other of ['babelcast', 'Babelcast', 'babel-live', 'babel-tts', 'gpt-4o-mini-tts', 'legendas-ao-vivo', 'parle-dev', 'agentes', 'marcos', 'palco', 'm-7c1e', 'scaleway']) {
      expect(html).not.toContain(other);
    }
    expect(html).toContain('id="trafego"');
    expect(html).not.toContain('Por app');
    for (const hidden of ['saldos', 'maquinas']) {
      expect(html).not.toContain(`id="${hidden}"`);
      expect(html).not.toContain(`href="#${hidden}"`);
    }
    expect(await gw.every(cookie, '?app=babelcast')).not.toContain('babelcast');
    expect(html).not.toContain('Saldos');
    expect(html).not.toContain('Máquinas avulsas');
    expect(html).not.toContain('/admin/probe');
    expect(html).not.toContain('/admin/park');
    for (const secret of [ADMIN_KEY, CLIENT_KEY, DEV_KEY, BABEL_KEY, PROVIDER_SECRET]) expect(html).not.toContain(secret);
    expect(html).not.toMatch(LEAK);
  });

  it('shows the possible saving and the digest state, and only the admin sends the digest', async () => {
    const gw = await gateway();
    const admin = await gw.signedIn();
    expect(admin.html).toContain('Economia possível este mês');
    expect(admin.html).toContain('Último resumo enviado em');
    expect(admin.html).toContain('action="/admin/digest"');
    expect((await gw.post('/admin/digest', {}, admin.cookie)).status).toBe(403);
    const res = await gw.post('/admin/digest', { csrf: admin.csrf }, admin.cookie);
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('Resumo das sugestões enviado');
    expect(gw.digests()).toBe(1);
    expect(gw.audit.at(-1)).toMatchObject({ actor: 'marcos', action: 'admin-page.digest', ok: true });
    const app = await gw.signedIn(CLIENT_KEY);
    expect(app.html).not.toContain('/admin/digest');
    expect(app.html).not.toContain('Último resumo');
    expect((await gw.post('/admin/digest', { csrf: app.csrf }, app.cookie)).status).toBe(403);
    expect(gw.digests()).toBe(1);
    expect(gw.audit.at(-1)).toMatchObject({ actor: 'parle', action: 'admin-page.digest', ok: false });
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
    expect(await (await gw.call('/admin/gpus', { cookie })).text()).toContain('action="/admin/park"');
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
    expect(res.headers.get('location')).toMatch(/^\/admin\/gpus\?msg=.*#gpus$/);
    expect(gw.parked).toEqual(['speech-stack']);
    expect((await gw.post('/admin/park', { name: 'speech-stack', csrf, back: '/admin' }, cookie)).headers.get('location')).toMatch(/^\/admin\?msg=[^#]*$/);
    expect((await gw.post('/admin/park', { name: 'speech-stack', csrf, back: 'https://evil.example' }, cookie)).headers.get('location')).toMatch(/^\/admin\/gpus\?msg=/);
    const probe = await gw.post('/admin/probe', { csrf }, cookie);
    expect(probe.status).toBe(303);
    expect(probe.headers.get('location')).toMatch(/^\/admin\/servicos\?msg=.*#reservas$/);
    gw.parked.length = 0;
    expect(gw.probes()).toBe(1);
    expect(gw.audit.map(e => e.action)).toEqual(['admin-page.login', 'admin-page.park', 'admin-page.park', 'admin-page.park', 'admin-page.probe']);
  });

  it('shows the pinned Vast GPU with its provider, price in US$, offer and park rule; the toggle is the admin\'s, signed and audited', async () => {
    const gw = await gateway();
    const { cookie, csrf } = await gw.signedIn();
    const html = await gw.every(cookie);
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

  it('a booting GPU reads «Iniciando» with its phase and expected time in the GPUs, the overview and the guarantee', async () => {
    const gw = await gateway();
    const { cookie } = await gw.signedIn();
    const html = await gw.every(cookie);
    const at = html.indexOf('<b class="mono">babelcast-3090');
    const row = html.slice(at, html.indexOf('</tr>', at));
    expect(row).toContain('Iniciando');
    expect(row).toContain('puxando a imagem há 3 min · esperado 10 min');
    expect(row).toContain('href="/admin/gpus/babelcast-3090"');
    expect(html).toMatch(/GPUs e máquinas[^]*?1 iniciando/);
    expect(html).toMatch(/<code>babelcast-3090<\/code>[^]*?Iniciando · puxando a imagem há 3 min/);
    const failed = html.slice(html.indexOf('<b class="mono">parle-bridge-shadow'));
    expect(failed.slice(0, failed.indexOf('</tr>'))).toContain('sem oferta disponível · nova tentativa às 12:07');
  });

  it('a stuck boot is a problem: «Travou em <fase> há N min»', () => {
    const now = Date.parse('2026-10-13T10:00:00Z');
    const opts = { now, csrf: 'c', actor: 'marcos', message: null, app: null };
    const html = renderStatus('n', demoSnapshot(now, 'bad'), { ...opts, page: 'gpus' });
    expect(html).toContain('Travou em carregando modelos');
    expect(html).toContain('carregando modelos há 14 min · esperado 6 min');
    expect(html).not.toContain('sem uso há 26 min');
    expect(html).toMatch(/<section id="gpus"><header class="sh"><h2>GPUs<\/h2><span class="pill bad">/);
    expect(renderStatus('n', demoSnapshot(now, 'bad'), opts)).toMatch(/<a class="card bad" href="\/admin\/gpus"[^]*speech-stack-test: Travou em carregando modelos há 14 min/);
  });

  it('the detail page shows the boot timeline, the offer, the past boots and the log extract, with secrets redacted', async () => {
    const gw = await gateway();
    gw.snapshot.gpuLogs!['babelcast-3090']!.push({ at: gw.clock.now, replicaId: '31544017', text: `create failed error=token ${PROVIDER_SECRET}` });
    const { cookie } = await gw.signedIn();
    const res = await gw.call('/admin/gpus/babelcast-3090', { cookie });
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const text of ['procurando oferta e alugando', 'máquina ligando no provedor', 'puxando a imagem', '(em curso)', '31544017', 'RTX 3090 · Lyon, FR',
      'ghcr.io/marcosremar/speech-stack', 'Últimos boots', 'falhou · boot-timeout', 'Downloading', 'phase pulling']) expect(html).toContain(text);
    expect(html).not.toContain(PROVIDER_SECRET);
    expect(html).not.toMatch(LEAK);
    expect(html).toContain('<a href="/admin/gpus">GPUs e máquinas</a>');
    expect(html).toContain('action="/admin/pin"');
    expect(html).toContain('name="back" value="/admin/gpus/babelcast-3090"');
    expect(html).toMatch(/href="\/admin\/gpus" class="[a-z]+ cur"/);
    expect((await gw.call('/admin/gpus/no-such-gpu', { cookie })).status).toBe(404);
    expect(await (await gw.call('/admin/gpus/babelcast-3090')).text()).toContain('name="key"');
  });

  it('an app session opens only its own GPUs and reads only their logs', async () => {
    const gw = await gateway();
    const { cookie } = await gw.signedIn(CLIENT_KEY);
    expect((await gw.call('/admin/gpus/babelcast-3090', { cookie })).status).toBe(404);
    expect((await gw.call('/admin/gpus/parle-bridge-shadow', { cookie })).status).toBe(200);
    const page = await (await gw.call('/admin/gpus/parle-bridge-shadow', { cookie })).text();
    expect(page).toContain('create failed');
    expect(page).not.toContain('31544017');
    const babel = await gw.signedIn(BABEL_KEY);
    const own = await (await gw.call('/admin/gpus/babelcast-3090', { cookie: babel.cookie })).text();
    expect(own).toContain('Pulling image');
    expect(own).not.toContain('parle-bridge-shadow');
  });

  it('an app session never sees nor uses the pin toggle', async () => {
    const gw = await gateway();
    await gw.access.setPolicy({ id: 'env-babelcast', canStartGpu: true });
    const { cookie, csrf } = await gw.signedIn(BABEL_KEY);
    const html = await gw.every(cookie);
    expect(html).toContain('babelcast-3090');
    expect(html).not.toContain('/admin/pin');
    expect(await (await gw.call('/admin/gpus/babelcast-3090', { cookie })).text()).not.toContain('/admin/pin');
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

  it('answers on the overview which areas are wrong, and names every state in text, not only in color', () => {
    const now = Date.parse('2026-10-13T10:00:00Z');
    const render = (state: 'ok' | 'warn' | 'bad', page = 'geral') => renderStatus('n', demoSnapshot(now, state), { now, csrf: 'c', actor: 'marcos', message: null, app: null, page });
    const cardLevels = (html: string) => [...html.matchAll(/<a class="card ([a-z]+)" href="([^"]+)"/g)].map(m => `${m[2]}:${m[1]}`);
    const bad = render('bad');
    expect(cardLevels(bad)).toEqual(['/admin/servicos:bad', '/admin/gpus:bad', '/admin/gastos:warn']);
    expect(bad).toContain('Algo está fora do ar');
    expect(bad).toMatch(/href="\/admin\/servicos" class="bad"/);
    expect(bad).toContain('<span class="sr">Problema:</span>');
    expect(bad).toContain('Texto → fala, Texto → fala sem resposta na nuvem');
    expect(render('bad', 'servicos')).toMatch(/<section id="reservas"><header class="sh"><h2>Reservas<\/h2><span class="pill bad">/);
    const ok = render('ok');
    expect(cardLevels(ok)).toEqual(['/admin/servicos:ok', '/admin/gpus:ok', '/admin/gastos:ok']);
    expect(ok).toContain('Tudo funcionando');
    for (const p of PAGES) expect(render('ok', p.id)).not.toMatch(/<h2>[^<]+<\/h2><span class="pill (bad|warn)">/);
  });

  it('knows when a class runs: says so during it, and outside it a parked GPU or a cloud-only service is no alarm', () => {
    const now = Date.parse('2026-10-13T10:00:00Z');
    const opts = { now, csrf: 'c', actor: 'marcos', message: null, app: null };
    const live = demoSnapshot(now, 'warn');
    live.gpus = live.gpus!.map(d => (d.name === 'speech-stack'
      ? { ...d, spec: { ...d.spec, warmSchedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', minReplicas: 1, timeZone: 'Europe/Paris' }] } }
      : d));
    expect(renderStatus('n', live, opts)).toMatch(/<h2>Aula em curso · até 23:59<\/h2>[^]*?<span class="meta">Parle · speech-stack pronta/);
    expect(renderStatus('n', { ...live, voiceTurns: null }, opts)).toMatch(/Aula em curso · até 23:59<\/b><span>Parle · speech-stack pronta/);
    const outside = demoSnapshot(now, 'ok');
    const html = renderStatus('n', outside, opts);
    expect(html).toContain('Sem aula agora</b><span>Próxima: amanhã às 08:30 · Parle.');
    expect(html).toMatch(/<h2>Última aula<\/h2><span class="meta">hoje · 08:30–10:5\d<\/span>/);
    expect(html).toContain('Tudo funcionando');
    const services = renderStatus('n', outside, { ...opts, page: 'servicos' });
    expect(services).toContain('Só nuvem · esperado fora da aula');
    expect(services).toContain('servindo na reserva de nuvem · fora da aula');
  });

  it('does not let sent alerts or the activity log turn the headline yellow', () => {
    const now = Date.parse('2026-10-13T10:00:00Z');
    const s = demoSnapshot(now, 'ok');
    s.alerts.unshift({ event: 'gpu.idle', at: new Date(now).toISOString(), summary: 'deployment: babel-live' });
    s.audit.unshift({ at: new Date(now).toISOString(), actor: 'marcos', action: 'admin-page.park', names: ['babel-live'], ok: false });
    const html = renderStatus('n', s, { now, csrf: 'c', actor: 'marcos', message: null, app: null });
    expect(html).toContain('Tudo funcionando');
    expect(html).toMatch(/href="\/admin\/atividade" class="warn"/);
  });

  it('shows the overview figures, traffic per stage and provider, who woke a GPU and the activity log', () => {
    const now = Date.parse('2026-10-13T10:00:00Z');
    const snapshot = demoSnapshot(now, 'warn');
    const html = PAGES.map(p => renderStatus('n', snapshot, { now, csrf: 'c', actor: 'marcos', message: null, app: null, page: p.id })).join('');
    for (const label of ['chamadas em 24 h', 'sem resposta', 'p95', '3 de 5 ligadas', 'de GPU hoje', 'menor saldo vast']) expect(html).toContain(label);
    const section = (id: string) => html.slice(html.indexOf(`<section id="${id}"`), html.indexOf('</section>', html.indexOf(`<section id="${id}"`)));
    const traffic = section('trafego');
    expect(traffic).toContain('<code>deployment:speech-stack</code>');
    expect(traffic).toContain('<code>openrouter</code>');
    expect(traffic).toMatch(/aria-label="Chamadas por hora/);
    const gpus = section('gpus');
    expect(gpus).toMatch(/parle \(producao\) até \d\d:\d\d/);
    const activity = section('atividade');
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
  it('splits the calls by the app of the key, with its answered share, fallbacks and GPU share', () => {
    const rows = [
      ...[300, 400].map((ms, i) => row(10 + i, 'route.served', { app: 'parle', durMs: ms, attrs: { stage: 'tts', provider: 'deployment:speech-stack' } })),
      row(9, 'route.served', { app: 'parle', durMs: 500, attrs: { stage: 'tts', provider: 'openrouter' } }),
      row(8, 'route.fallback', { app: 'parle', attrs: { stage: 'tts', provider: 'deployment:speech-stack' } }),
      row(7, 'route.unavailable', { app: 'babelcast', level: 'error', durMs: 30_000, attrs: { stage: 'chat' } }),
      row(6, 'route.served', { durMs: 100, attrs: { stage: 'stt', provider: 'openrouter' } }),
    ].sort((a: { rxTs: number }, b: { rxTs: number }) => a.rxTs - b.rxTs);
    const t = adminTraffic(rows, now);
    expect(t.total).toMatchObject({ served: 4, failed: 1, fallbacks: 1 });
    expect(t.apps).toEqual([
      expect.objectContaining({ key: 'parle', served: 3, failed: 0, fallbacks: 1 }),
      expect.objectContaining({ key: 'babelcast', served: 0, failed: 1 }),
    ]);
    expect(t.byApp!.parle!.links.find(l => l.key === 'tts|deployment:speech-stack')).toMatchObject({ served: 2, fallbacks: 1, p50Ms: 300 });
    expect(gpuShare(t.byApp!.parle!)).toBeCloseTo(2 / 3);
    expect(answeredShare(t.apps![1]!)).toBe(0);
    expect(sloLevel(t.apps![1]!)).toBe('warn');
    expect(sloLevel({ served: 190, failed: 10 })).toBe('bad');
    expect(sloLevel({ served: 1990, failed: 10 })).toBe('ok');
  });

  it('shows the calls per app to the admin, one app with ?app=, and the app key its own calls only', () => {
    const now = Date.parse('2026-10-13T10:00:00Z');
    const snapshot = demoSnapshot(now, 'bad');
    const opts = { now, csrf: 'c', actor: 'marcos', message: null, page: 'servicos' };
    const section = (html: string) => html.slice(html.indexOf('<section id="trafego"'), html.indexOf('</section>', html.indexOf('<section id="trafego"')));
    const all = section(renderStatus('n', snapshot, { ...opts, app: null }));
    expect(all).toContain('Por app');
    expect(all).toContain('/admin/servicos?app=babelcast#trafego');
    expect(all).toContain('Respondidas');
    expect(renderStatus('n', snapshot, { ...opts, app: null, page: 'geral' })).toMatch(/Parle respondeu \d/);
    const parle = section(renderStatus('n', snapshot, { ...opts, app: 'parle' }));
    expect(parle).toContain('Só o app <b>parle</b>');
    expect(parle).not.toContain('Por app');
    expect(parle).not.toContain('deployment:babel-live');
    const own = section(renderStatus('n', scopeToApp(snapshot, 'babelcast'), { ...opts, app: null, view: { id: 'babelcast', canPark: false } }));
    expect(own).toContain('deployment:babel-live');
    expect(own).not.toContain('speech-stack');
    expect(recommendations({ s: snapshot, now, csrf: 'c', app: null, view: null }).map(r => r.id)).toContain('app-slo:parle');
  });

  it('names each app and says what it is for', () => {
    const now = Date.parse('2026-10-13T10:00:00Z');
    const snapshot = demoSnapshot(now, 'ok');
    snapshot.apps.push({ id: 'ucast', profile: { requiresGpu: false, gpuDeployments: [], name: 'uCast', description: 'Podcasts <b>ao vivo</b>' }, status: null });
    const html = renderStatus('n', snapshot, { now, csrf: 'c', actor: 'marcos', message: null, app: null, page: 'servicos' });
    expect(html).toContain('>Parle</a>');
    expect(html).toContain('Tradução simultânea');
    expect(html).toContain('>uCast</a></b> <span class="mono">ucast</span>');
    expect(html).toContain('Podcasts &#60;b&#62;ao vivo&#60;/b&#62;');
  });
});
