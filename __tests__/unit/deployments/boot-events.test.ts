import { spawn, spawnSync } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOOT_EVENT_LINE_CHARS, BOOT_EVENT_LINES, bootEventAuth, bootEventsRoute, bootReportFor, bootReportSetup, parseBootEvent, pullWithProgress,
} from '../../../src/deployments/boot-events';
import { BootTracker, bootStates, REPLICA_LINE, REPORT_FRESH_MS, REPORTED_LINES_KEPT, type BootEvent } from '../../../src/deployments/boot-track';
import { replicaCloudInit, vastReplicaInit } from '../../../src/deployments/cloud-init';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { buildSpec } from '../../../src/deployments/spec';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { FakeCloud, until } from './_fake-cloud';

const MIN = 60_000;
const T0 = Date.parse('2026-10-13T10:00:00Z');
const TOKEN = 'replica-token-abcdefghijklmnopqrstuvwxyz';
const SECRET = 'hf_supersecretvalue1234567890';
const REPORT = bootReportFor('https://gw.test/', 'k1', TOKEN);
const profiles = new Map();
const ev = (over: Partial<BootEvent>): BootEvent => ({ phase: 'pulling-image', bytes: null, layers: null, exit: null, lines: [], ...over });

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); s.close(); }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface Hit { url: string; auth: string | undefined; body: string }

async function endpoint(answer: 'ok' | 'hang' = 'ok'): Promise<{ base: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      if (req.url === '/health') { res.writeHead(503); res.end(); return; }
      hits.push({ url: req.url ?? '', auth: req.headers.authorization, body });
      if (answer === 'ok') { res.writeHead(204); res.end(); }
    });
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

function runSh(script: string): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', code => resolve({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

const phases = (hits: Hit[]) => hits.map(h => new URL(h.url, 'http://x').searchParams.get('phase')).sort();

describe('the generated boot script', () => {
  const spec = buildSpec('d', { image: 'me/app:1', port: 8000, env: { HF_TOKEN: SECRET } }, { profiles });

  it('reports from the Scaleway cloud-init with a 3 s timeout, `|| true`, in the background, and carries no secret in the calls', () => {
    const script = replicaCloudInit(spec, TOKEN, { bootReport: REPORT });
    expect(script).toContain(`AIGW_BOOT_URL='https://gw.test/v1/boot-events?r=k1'`);
    expect(script).toContain('aigw_report "phase=pulling-image&$(aigw_pulled)"');
    expect(script).toContain('aigw_report "phase=starting-container&$(aigw_pulled)"');
    expect(script).toMatch(/docker run .* \|\| aigw_report "phase=failed&exit=\$\?"/);
    expect(script).toContain('aigw_tick http://127.0.0.1:8000/health');
    expect(script).toContain(`trap 'c=$?; [ -f /srv/aigw/ready.json ] || aigw_report "phase=failed&exit=$c"' EXIT`);
    const curls = script.split('\n').filter(l => /curl .*AIGW_BOOT|curl .*http_code/.test(l));
    expect(curls).toHaveLength(2);
    for (const l of curls) expect(l).toMatch(/--max-time 3 .*\|\| true/);
    expect(script.match(/\) <\/dev\/null >\/dev\/null 2>&1 &$/gm)).toHaveLength(3);
    const reporting = script.split('\n').filter(l => /aigw_|AIGW_BOOT/.test(l)).join('\n');
    expect(reporting).not.toContain(SECRET);
    expect(reporting).not.toContain(TOKEN);
    expect(REPORT.auth).toBe(bootEventAuth(TOKEN));
    expect(REPORT.auth).not.toContain(TOKEN);
    expect(script.split('\n').slice(script.split('\n').indexOf('set +x'), script.split('\n').indexOf('set +x') + 4))
      .toEqual(['set +x', `AIGW_BOOT_URL='https://gw.test/v1/boot-events?r=k1'`, `AIGW_BOOT_AUTH='${REPORT.auth}'`, 'set -x']);
  });

  it('reports from the Vast init and the boot-script mode, with the app log of the script', () => {
    const vast = vastReplicaInit(buildSpec('v', { provider: 'vast', image: 'base:1', port: 8010, bootScript: 'echo hi' }, { profiles }), TOKEN, { bootReport: REPORT });
    expect(vast).toContain('aigw_report phase=starting-container');
    expect(vast).toContain('tail -n 20 /srv/aigw/user-boot.log');
    expect(vast).toContain('aigw_tick http://127.0.0.1:8010/health');
    expect(vast).not.toContain('docker logs');
    const scwScript = replicaCloudInit(buildSpec('s', { image: 'me/app:1', port: 8000, bootScript: 'echo hi' }, { profiles }), TOKEN, { bootReport: REPORT });
    expect(scwScript).toContain('aigw_report phase=starting-container\necho ');
    const docker = replicaCloudInit(buildSpec('r', { image: 'me/app:1', port: 8000, realtime: {} }, { profiles }), TOKEN, { bootReport: REPORT });
    for (const script of [vast, scwScript, docker]) expect(spawnSync('bash', ['-n'], { input: script }).status).toBe(0);
  });

  it('BOOT_REPORTING off: no bootReport → the scripts carry no reporting at all', () => {
    for (const s of [replicaCloudInit(spec, TOKEN), vastReplicaInit(buildSpec('v', { provider: 'vast', image: 'b:1', port: 8010, bootScript: 'x' }, { profiles }), TOKEN)]) {
      expect(s).not.toMatch(/aigw_report|aigw_tick|AIGW_BOOT|trap /);
    }
  });
});

describe('the reporting snippet under sh', () => {
  const tail = `aigw_tail() { printf 'pulled layer one\\nsecond line\\n'; }`;

  it('posts each phase with the per-replica token and the log tail, the EXIT trap reports the failure code, and the script ends normally', async () => {
    const gw = await endpoint();
    const closed = await closedPort();
    const report = { url: `${gw.base}/v1/boot-events?r=k1`, auth: bootEventAuth(TOKEN) };
    const run = await runSh(['set -x', bootReportSetup(report, 'script'), tail,
      'aigw_report phase=starting-container', `aigw_tick ${gw.base}/health`, `aigw_tick http://127.0.0.1:${closed}/health`, 'echo booted', 'exit 3'].join('\n'));
    expect(run).toMatchObject({ code: 3, stdout: 'booted\n' });
    expect(run.ms).toBeLessThan(2000);
    await until(() => gw.hits.length === 4, 5000);
    expect(phases(gw.hits)).toEqual(['failed', 'loading-models', 'starting-container', 'starting-container']);
    expect(gw.hits.find(h => h.url.includes('phase=failed'))!.url).toContain('exit=3');
    for (const h of gw.hits) {
      expect(h.auth).toBe(`Bearer ${report.auth}`);
      expect(h.url).toMatch(/^\/v1\/boot-events\?r=k1&phase=/);
      expect(h.body).toBe('pulled layer one\nsecond line\n');
    }
    expect(run.stderr).not.toContain(report.auth);
  });

  it('a pull that leaves no image reports the failure, the boot goes on, and a failing pull never stops the script', async () => {
    const gw = await endpoint();
    const report = { url: `${gw.base}/v1/boot-events?r=k1`, auth: 'a'.repeat(64) };
    const docker = `docker() { case "$1" in pull) echo 'abc: Pull complete'; return 1 ;; *) return 1 ;; esac; }`;
    const run = await runSh(['set -x', bootReportSetup(report, 'docker'), 'aigw_tail() { :; }', docker, pullWithProgress('docker pull img', 'img'), 'echo after-pull'].join('\n'));
    expect(run).toMatchObject({ code: 0, stdout: expect.stringContaining('after-pull') });
    await until(() => phases(gw.hits).includes('failed') && phases(gw.hits).includes('starting-container'), 5000);
    expect(gw.hits.find(h => h.url.includes('phase=failed'))!.url).toMatch(/exit=1$/);
    expect(gw.hits.find(h => h.url.includes('phase=starting-container'))!.url).toMatch(/bytes=\d+&layers=/);
  });

  it('the gateway down or hanging changes nothing: the script ends at once with its own exit code', async () => {
    const closed = await closedPort();
    const hanging = await endpoint('hang');
    for (const base of [`http://127.0.0.1:${closed}`, hanging.base, 'http://gateway.invalid']) {
      const report = { url: `${base}/v1/boot-events?r=k1`, auth: 'a'.repeat(64) };
      const run = await runSh([bootReportSetup(report, 'script'), tail, 'aigw_report phase=starting-container', `aigw_tick ${base}/health`, 'echo booted'].join('\n'));
      expect(run).toMatchObject({ code: 0, stdout: 'booted\n' });
      expect(run.ms).toBeLessThan(2000);
    }
  });

  it('the tail leaves out the set -x trace (the base64 env and nginx lines) and adds the app log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'boot-events-'));
    dirs.push(dir);
    await writeFile(join(dir, 'boot.log'), `+ echo 'SFZfVE9LRU49aGZfc2VjcmV0' | base64 -d > /srv/aigw/app.env\n+ shutdown -h +150\nlatest: Pulling from me/app\naigw: BOOT FAILED: x\n`);
    await writeFile(join(dir, 'user-boot.log'), 'model loading 3/7\n');
    const gw = await endpoint();
    const setup = bootReportSetup({ url: `${gw.base}/v1/boot-events?r=k1`, auth: 'a'.repeat(64) }, 'script').replaceAll('/srv/aigw/', `${dir}/`);
    const run = await runSh([setup, 'aigw_report phase=loading-models'].join('\n'));
    expect(run.code).toBe(0);
    await until(() => phases(gw.hits).includes('loading-models'), 5000);
    expect(gw.hits.find(h => h.url.includes('phase=loading-models'))!.body).toBe('latest: Pulling from me/app\naigw: BOOT FAILED: x\napp: model loading 3/7\n');
  });
});

describe('an event on the gateway: redaction and caps', () => {
  it('redacts the known secrets, Bearer values and long base64 blobs, keeps 40 lines of 300 chars', () => {
    const text = [`HF_TOKEN=${SECRET}`, 'Authorization: Bearer abc.def', `blob ${'QUJD'.repeat(40)}`, 'word '.repeat(200),
      ...Array.from({ length: 100 }, (_, i) => `line ${i}`)].join('\n');
    const all = parseBootEvent(new URLSearchParams('phase=failed&exit=125'), text.split('\n').slice(0, 4).join('\n'), [SECRET])!;
    expect(all).toMatchObject({ phase: 'failed', exit: 125, bytes: null, layers: null });
    expect(all.lines.join('\n')).not.toContain(SECRET);
    expect(all.lines.join('\n')).not.toContain('abc.def');
    expect(all.lines).toEqual(['HF_TOKEN=[segredo]', 'Authorization: Bearer [segredo]', 'blob […]', 'word '.repeat(BOOT_EVENT_LINE_CHARS / 5)]);
    const long = parseBootEvent(new URLSearchParams('phase=pulling-image&bytes=123&layers=3/9'), text, [SECRET])!;
    expect(long.lines).toHaveLength(BOOT_EVENT_LINES);
    expect(long.lines.at(-1)).toBe('line 99');
    expect(long).toMatchObject({ bytes: 123, layers: [3, 9] });
    expect(parseBootEvent(new URLSearchParams('phase=hacked'), '', [])).toBeNull();
    expect(parseBootEvent(new URLSearchParams('phase=failed&exit=-1&bytes=1e9&layers=a/b'), '', [])).toMatchObject({ exit: null, bytes: null, layers: null });
  });

  it('keeps each line once and at most 60 reported lines per replica, next to the gateway lines', () => {
    const t = new BootTracker();
    t.phase('d', 'r1', 'starting', T0, T0);
    t.phase('d', 'r2', 'starting', T0, T0);
    for (let e = 0; e < 3; e++) t.report('d', 'r1', ev({ phase: 'loading-models', lines: Array.from({ length: 40 }, (_, i) => `r1 line ${e * 20 + i}`) }), T0 + e);
    t.report('d', 'r2', ev({ phase: 'loading-models', lines: ['r2 line'] }), T0 + 5);
    const log = t.view('d').log;
    const r1 = log.filter(l => l.replicaId === 'r1' && l.text.startsWith(REPLICA_LINE));
    expect(r1).toHaveLength(REPORTED_LINES_KEPT);
    expect(new Set(r1.map(l => l.text)).size).toBe(r1.length);
    expect(r1.at(-1)!.text).toBe(`${REPLICA_LINE}r1 line 79`);
    expect(log.some(l => l.replicaId === 'r2' && l.text === `${REPLICA_LINE}r2 line`)).toBe(true);
    expect(log.some(l => l.text === 'phase starting')).toBe(true);
  });
});

describe('the tracker with reported phases', () => {
  it('a report moves the phase, a stale one stops counting, and the boot history keeps the pulled bytes', () => {
    const t = new BootTracker();
    t.phase('d', 'r1', 'provisioning', T0, T0);
    t.report('d', 'r1', ev({ phase: 'pulling-image', bytes: 0, layers: [0, 9] }), T0 + MIN);
    expect(t.view('d').active[0]!.phases.map(p => p.phase)).toEqual(['provisioning', 'pulling']);
    expect(t.reportedPhase('r1', T0 + MIN + REPORT_FRESH_MS)).toBe('pulling');
    expect(t.reportedPhase('r1', T0 + MIN + REPORT_FRESH_MS + 1)).toBeNull();
    t.report('d', 'r1', ev({ phase: 'starting-container', bytes: 21e9 }), T0 + 6 * MIN);
    t.report('d', 'r1', ev({ phase: 'loading-models' }), T0 + 7 * MIN);
    t.phase('d', 'r1', 'ready', T0 + 9 * MIN, T0);
    expect(t.view('d').past[0]).toMatchObject({ result: 'ready', pulledBytes: 21e9 });
    expect(t.view('d').past[0]!.phases.map(p => p.phase)).toEqual(['provisioning', 'pulling', 'starting', 'loading', 'ready']);
    expect(t.history().past.d![0]!.pulledBytes).toBe(21e9);
  });

  it('a pull still receiving bytes is not stuck by its phase time, a silent one is, and a reported failure is stuck at once', () => {
    const t = new BootTracker();
    t.phase('d', 'r1', 'provisioning', T0, T0);
    t.report('d', 'r1', ev({ bytes: 0, layers: [0, 9] }), T0);
    for (let m = 1; m <= 20; m++) t.report('d', 'r1', ev({ bytes: m * 600e6, layers: [Math.floor(m / 3), 9] }), T0 + m * MIN);
    const past = [{ replicaId: 'old', startedAt: 0, endedAt: 1, result: 'ready' as const, reason: null, phases: [], pulledBytes: 21e9 }];
    const at = (now: number) => bootStates(t.view('d').active, past, now, 60)[0]!;
    expect(at(T0 + 20 * MIN)).toMatchObject({ phase: 'pulling', stuck: false, reported: true, progress: { bytes: 12e9, totalBytes: 21e9, layers: [6, 9] } });
    expect(at(T0 + 20 * MIN + REPORT_FRESH_MS + 1)).toMatchObject({ stuck: true, reported: false });
    t.report('d', 'r1', ev({ phase: 'failed', exit: 1, lines: ['Error response from daemon: manifest unknown'] }), T0 + 21 * MIN);
    expect(at(T0 + 21 * MIN)).toMatchObject({ phase: 'pulling', stuck: true, failed: { exit: 1 } });
    expect(t.view('d').log.map(l => l.text)).toEqual(expect.arrayContaining([
      `${REPLICA_LINE}Error response from daemon: manifest unknown`, `${REPLICA_LINE}boot failed (exit 1)`,
    ]));
  });
});

describe('the controller and the route', () => {
  const controllers: DeploymentController[] = [];
  const clouds: FakeCloud[] = [];
  afterEach(async () => {
    for (const c of controllers.splice(0)) await c.stop();
    for (const c of clouds.splice(0)) await c.closeAll();
  });

  async function make(over: { bootReporting?: boolean; provider?: 'scaleway' | 'vast' } = {}) {
    const clock = { now: T0 };
    const cloud = new FakeCloud(() => clock.now, over.provider);
    cloud.bootMs = 60 * MIN;
    const c = new DeploymentController({
      backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20,
      publicUrl: 'https://gw.test', now: () => clock.now, ...(over.bootReporting === undefined ? {} : { bootReporting: over.bootReporting }),
    });
    await c.init();
    controllers.push(c);
    clouds.push(cloud);
    return { c, cloud, clock };
  }

  async function routeOn(c: DeploymentController) {
    const route = bootEventsRoute(c);
    const server = createServer((req, res) => { void route.handler(req, res); });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return (key: string, auth: string, query: string, body = 'a line') =>
      fetch(`${base}/v1/boot-events?r=${key}&${query}`, { method: 'POST', headers: { Authorization: `Bearer ${auth}` }, body }).then(r => r.status);
  }

  const booting = (c: DeploymentController, n: number) => until(() => c.get('g')!.boot.active.filter(b => b.replicaId).length === n);

  it('a replica posts only for itself, with its own token, while its boot runs; then the same token gets 401', async () => {
    const { c, cloud } = await make();
    await c.put('g', { image: 'me/app:1', port: 8000, minReplicas: 2, maxReplicas: 2 });
    c.start();
    await booting(c, 2);
    const [a, b] = cloud.created;
    const authA = bootEventAuth(a!.replicaToken), authB = bootEventAuth(b!.replicaToken);
    expect(a!.cloudInit).toContain(`AIGW_BOOT_URL='https://gw.test/v1/boot-events?r=${a!.tokenKey}'`);
    expect(a!.cloudInit).toContain(`AIGW_BOOT_AUTH='${authA}'`);
    const post = await routeOn(c);
    expect(await post(a!.tokenKey!, authA, 'phase=pulling-image&bytes=5&layers=1/4')).toBe(204);
    expect(await post(b!.tokenKey!, authA, 'phase=pulling-image')).toBe(401);
    expect(await post(a!.tokenKey!, authB, 'phase=pulling-image')).toBe(401);
    expect(await post(a!.tokenKey!, a!.replicaToken, 'phase=pulling-image')).toBe(401);
    expect(await post('unknown', authA, 'phase=pulling-image')).toBe(401);
    expect(await post(a!.tokenKey!, authA, 'phase=bogus')).toBe(401);
    expect(await post(a!.tokenKey!, authA, 'phase=loading-models', 'x'.repeat(9000))).toBe(413);
    const idA = cloud.machines.get([...cloud.machines.keys()][0]!)!.machine.id;
    expect(c.get('g')!.boot.active.find(x => x.replicaId === idA)).toMatchObject({ phase: 'pulling', progress: { bytes: 5, layers: [1, 4] } });
    expect(c.bootLog('g').some(l => l.replicaId === idA && l.text === `${REPLICA_LINE}a line`)).toBe(true);
    cloud.machines.get(idA)!.bootedAt = Date.now();
    await until(() => !c.get('g')!.boot.active.some(x => x.replicaId === idA));
    expect(await post(a!.tokenKey!, authA, 'phase=loading-models')).toBe(401);
  });

  it('the reported phase wins over the inferred one while fresh, then the inferred one is back', async () => {
    const { c, cloud, clock } = await make();
    await c.put('g', { image: 'me/app:1', port: 8000, minReplicas: 1 });
    c.start();
    await booting(c, 1);
    const [a] = cloud.created;
    expect(c.bootEvent(a!.tokenKey!, bootEventAuth(a!.replicaToken), new URLSearchParams('phase=loading-models'), '')).toBe(true);
    await new Promise(r => setTimeout(r, 120));
    expect(c.get('g')!.boot.active[0]!.phases.map(p => p.phase).slice(-2)).toEqual(['starting', 'loading']);
    expect(c.get('g')!.boot.active[0]!.reported).toBe(true);
    clock.now += REPORT_FRESH_MS + MIN;
    await until(() => c.get('g')!.boot.active[0]!.phase === 'starting');
    expect(c.get('g')!.boot.active[0]!.reported).toBe(false);
  });

  it('a reported failure releases the replica as boot-failed and rents again (stuck-retry rules)', async () => {
    const { c, cloud } = await make();
    await c.put('g', { image: 'me/app:1', port: 8000, minReplicas: 1 });
    c.start();
    await booting(c, 1);
    const [a] = cloud.created;
    expect(c.bootEvent(a!.tokenKey!, bootEventAuth(a!.replicaToken), new URLSearchParams('phase=failed&exit=125'), 'docker: Error response from daemon')).toBe(true);
    await until(() => cloud.releaseReasons.includes('boot-failed') && cloud.created.length === 2);
    expect(c.get('g')!.boot.past[0]).toMatchObject({ result: 'failed', reason: 'boot-failed' });
    expect(c.bootEvent(a!.tokenKey!, bootEventAuth(a!.replicaToken), new URLSearchParams('phase=failed'), '')).toBe(false);
  });

  it('Vast replicas get the report in the create input; BOOT_REPORTING=0 gives the old script and refuses events', async () => {
    const vast = await make({ provider: 'vast' });
    await vast.c.put('g', { provider: 'vast', image: 'base:1', port: 8010, bootScript: 'echo hi', minReplicas: 1 });
    vast.c.start();
    await booting(vast.c, 1);
    expect(vast.cloud.created[0]!.bootReport).toEqual(bootReportFor('https://gw.test', vast.cloud.created[0]!.tokenKey!, vast.cloud.created[0]!.replicaToken));
    const off = await make({ bootReporting: false });
    await off.c.put('g', { image: 'me/app:1', port: 8000, minReplicas: 1 });
    off.c.start();
    await booting(off.c, 1);
    const [a] = off.cloud.created;
    expect(a!.bootReport).toBeUndefined();
    expect(a!.cloudInit).not.toMatch(/aigw_report|AIGW_BOOT/);
    expect(off.c.bootEvent(a!.tokenKey!, bootEventAuth(a!.replicaToken), new URLSearchParams('phase=loading-models'), '')).toBe(false);
  });
});

describe('the GPU pages with reported phases', () => {
  it('show the real phase with the pull progress, who reported it, the replica lines and the Scaleway note', async () => {
    const { demoSnapshot } = await import('../../__fixtures__/admin-snapshot');
    const { renderGpuDetail, renderStatus } = await import('../../../src/admin-page/pages');
    const s = demoSnapshot(T0, 'warn');
    const opts = { now: T0, csrf: 'c', actor: 'marcos', message: null, app: null };
    const html = renderGpuDetail('n', s, 'speech-stack-test', opts, { reason: 'unsupported', pending: false, log: null })!;
    expect(html).toContain('Iniciando · puxando a imagem 12,3/21 GB · camadas 9/23 há 4 min');
    expect(html).toContain('fase informada pela máquina · puxando a imagem 12,3/21 GB · camadas 9/23');
    expect(html).toContain('[fr-par-2/d5f0] replica: 7a1f2c3d4e5f: Pull complete');
    expect(html).toContain('durante o boot, a própria máquina envia as fases e as últimas linhas');
    expect(renderStatus('n', s, opts)).toContain('speech-stack-test');
  });

  it('a reported failure reads «Falhou em … (código N)»', async () => {
    const { bootHeadline } = await import('../../../src/admin-page/boot');
    const t = new BootTracker();
    t.phase('d', 'r1', 'starting', T0, T0);
    t.report('d', 'r1', ev({ phase: 'failed', exit: 125 }), T0 + MIN);
    expect(bootHeadline(bootStates(t.view('d').active, [], T0 + MIN, 45)[0]! as never)).toBe('Falhou em iniciando o contêiner (código 125)');
  });
});
