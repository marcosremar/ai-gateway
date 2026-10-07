/**
 * Realtime end to end on one machine, no GPU (docs/realtime.md § End-to-end test plan): the real gateway (proxy +
 * deployment controller + realtime + telemetry, wired as serve.ts does), replicas from LocalEdgeCloud (real nginx front,
 * real aigw-edge sidecar, fake model), an app backend that holds the app key, and the browser SDK in Chromium.
 *
 *   EDGE_PYTHON=/path/to/venv/bin/python bun scripts/realtime-e2e/e2e.ts
 *
 * The edge's Python deps: `uv pip install -r docker/aigw-edge/requirements.txt`. Prints PASS/FAIL per check and a JSON
 * summary; exits non-zero on the first failure.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { chromium, type Browser } from 'playwright';
import { DeploymentController } from '../../src/deployments/controller';
import { HttpReplicaProbe } from '../../src/deployments/http';
import { MemoryDeploymentStore } from '../../src/deployments/store';
import { ApiKeyRegistry } from '../../src/gateway/proxy/middleware/api-keys';
import { startProxy } from '../../src/gateway/proxy/server';
import { createRealtime } from '../../src/realtime';
import { createS2SRoute } from '../../src/s2s/route';
import { realtimeSinkToTelemetry, sessionResolverFrom, setGatewayTelemetrySink, telemetryFromEnv } from '../../src/telemetry';
import { freePort, LocalEdgeCloud } from './local-cloud';

const ROOT = resolve(import.meta.dir, '../..');
const PYTHON = process.env.EDGE_PYTHON || 'python3';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const WORK = mkdtempSync(join(tmpdir(), 'aigw-rt-e2e-run-'));
const LOG = process.env.E2E_LOG || join(WORK, 'e2e.log');
const KEYS = ['key-parle:parle', 'key-other:other', 'key-admin:admin'];
const DEP = 'speech-e2e';
const MAX_SESSIONS = 3;

const log = (line: string) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
const results: { checks: Array<{ name: string; ok: boolean; detail?: unknown }>; latency: Record<string, unknown> } = { checks: [], latency: {} };
function check(name: string, ok: boolean, detail?: unknown): void {
  results.checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(200); }
  throw new Error(`timed out waiting for ${what}`);
}

// ── gateway, wired like serve.ts ─────────────────────────────────────────────────────────────────────────────────
const gwPort = await freePort();
const GW = `http://127.0.0.1:${gwPort}`;
const keyRegistry = new ApiKeyRegistry(KEYS.join(','));
const userOfReq = (req: IncomingMessage) => keyRegistry.resolve(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))?.userId ?? null;
const cloud = new LocalEdgeCloud({ python: PYTHON, gatewayUrl: () => GW, maxSessions: MAX_SESSIONS, log });
const controller = new DeploymentController({
  backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(2000), namespace: 'e2e', reconcileMs: 300,
  maxTotalReplicas: 3, log: (msg, data) => log(`controller ${msg} ${data ? JSON.stringify(data) : ''}`),
});
await controller.init();
controller.start();

let realtimeSessionOf: ((token: string) => { sid: string; app: string; dep: string; rep: string } | null) | null = null;
const telemetry = telemetryFromEnv({ TELEMETRY_DIR: join(WORK, 'telemetry') }, {
  auth: {
    resolveAppKey: (token) => keyRegistry.resolve(token)?.userId ?? null,
    isMasterKey: () => false,
    deployment: (name) => {
      const replicaToken = controller.tokenOf(name);
      const app = controller.get(name)?.app;
      return replicaToken ? { replicaToken, ...(app ? { app } : {}) } : null;
    },
    replica: (id) => controller.replicaAuth(id) ?? null,
    resolveSessionToken: (token) => realtimeSessionOf?.(token) ?? null,
  },
  isAdminToken: (t) => keyRegistry.resolve(t)?.userId === 'admin',
  log: (msg, data) => log(`telemetry ${msg} ${data ? JSON.stringify(data) : ''}`),
})!;
await telemetry.start();
setGatewayTelemetrySink((event) => telemetry.ingest.ingestOwn(event));

const s2sRoute = createS2SRoute({
  controller, deployment: DEP,
  stagesFor: () => { throw new Error('no composed fallback in the e2e'); },
  log: (msg, data) => log(`s2s ${msg} ${data ? JSON.stringify(data) : ''}`),
});
const realtime = createRealtime({
  controller, defaultDeployment: DEP, env: {},
  userOf: userOfReq,
  isAdmin: (u) => u === 'admin',
  telemetry: realtimeSinkToTelemetry(telemetry.ingest),
  pollMs: 0,
  log: (msg, data) => log(`realtime ${msg} ${data ? JSON.stringify(data) : ''}`),
});
realtimeSessionOf = sessionResolverFrom(realtime.service);
const gateway = await startProxy({
  port: gwPort, hostname: '127.0.0.1', apiKeys: KEYS, providers: {},
  customRoutes: [{ method: 'POST', path: '/v1/s2s', handler: s2sRoute }, realtime.route, ...telemetry.adminRoutes],
  publicRoutes: telemetry.publicRoutes,
});
realtime.mount(gateway);

// ── the app's backend: holds the app key, the browser only sees session tokens ───────────────────────────────────
const sdkBuild = await Bun.build({ entrypoints: [join(ROOT, 'sdk/browser/realtime/index.ts')], target: 'browser', format: 'esm' });
if (!sdkBuild.success) throw new Error(`SDK build failed: ${sdkBuild.logs.join('\n')}`);
const SDK_JS = await sdkBuild.outputs[0].text();
const PAGE = `<!doctype html><meta charset="utf-8"><title>rt e2e</title><body><script type="module" src="/page.js"></script>`;
const PAGE_JS = await Bun.file(join(import.meta.dir, 'page.js')).text();
async function readAll(req: IncomingMessage): Promise<Buffer> { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c); }
const LESSON_CONFIG = { system: 'Você é a padeira. Responda curto.', messages: [], voice: 'br-m-08' };
async function relay(req: IncomingMessage, res: ServerResponse, path: string, withConfig = false): Promise<void> {
  let body = await readAll(req);
  // The app's backend owns the session config (system prompt, history): the browser only asks for transports.
  if (withConfig) body = Buffer.from(JSON.stringify({ ...JSON.parse(body.toString() || '{}'), config: LESSON_CONFIG }));
  const headers: Record<string, string> = { Authorization: 'Bearer key-parle', 'Content-Type': String(req.headers['content-type'] ?? 'application/json') };
  if (req.headers.traceparent) headers.traceparent = String(req.headers.traceparent);
  const up = await fetch(`${GW}${path}`, { method: 'POST', headers, body });
  const out: Record<string, string> = {};
  up.headers.forEach((v, k) => { if (!['content-length', 'transfer-encoding', 'connection'].includes(k)) out[k] = v; });
  res.writeHead(up.status, out);
  if (up.body) for await (const chunk of up.body) res.write(chunk);
  res.end();
}
const appPort = await freePort();
const APP = `http://127.0.0.1:${appPort}`;
const app: Server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (req.method === 'GET' && path === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  if (req.method === 'GET' && path === '/sdk.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(SDK_JS); return; }
  if (req.method === 'GET' && path === '/page.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(PAGE_JS); return; }
  if (req.method === 'POST' && path === '/api/rt-session') { void relay(req, res, '/v1/realtime/sessions', true); return; }
  if (req.method === 'POST' && path === '/api/s2s') { void relay(req, res, '/v1/s2s'); return; }
  res.writeHead(404); res.end();
});
await new Promise<void>(r => app.listen(appPort, '127.0.0.1', r));

// The learner's microphone: Chromium plays this file as the fake capture device, in a loop.
const MIC_WAV = join(WORK, 'mic.wav');
const py = Bun.spawnSync([PYTHON, '-c', `
import math, struct, numpy as np
sr = 48000
def tone(s, f=210.0):
    t = np.arange(int(s * sr)) / sr
    return 0.25*np.sin(2*math.pi*f*t) + 0.1*np.sin(2*math.pi*2*f*t) + 0.05*np.sin(2*math.pi*3*f*t)
x = np.concatenate([np.zeros(int(0.8*sr)), tone(1.4), np.zeros(int(9.0*sr))])
pcm = (x * 32767).astype('<i2').tobytes()
open(${JSON.stringify(MIC_WAV)}, 'wb').write(b'RIFF' + struct.pack('<I', 36 + len(pcm)) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 1, sr, sr*2, 2, 16) + b'data' + struct.pack('<I', len(pcm)) + pcm)
`]);
if (py.exitCode !== 0) throw new Error(`mic wav: ${py.stderr.toString()}`);

const browsers: Browser[] = [];
async function openPage(extraArgs: string[] = []) {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${MIC_WAV}`,
      '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', ...extraArgs,
    ],
  });
  browsers.push(browser);
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => log(`[page ${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => log(`[page error] ${e.message}`));
  await page.goto(APP);
  await page.waitForFunction(() => (window as unknown as { e2eReady?: boolean }).e2eReady === true);
  return { browser, page };
}

type Run = {
  transport: string | null; events: Array<{ type: string; [k: string]: unknown }>; loudFrames: number; traceId: string;
  sessionId: string | null; metrics: { connectMs: number | null; attempts: unknown[]; failovers: number; lastTurn: unknown };
  history: Array<{ role: string; content: string }>; error?: string; ttfaBrowserMs?: number | null;
};
const typesOf = (r: Run) => r.events.map(e => (e.type === 'transport' ? `transport:${String(e.transport)}` : e.type));

let exitCode = 0;
let udpBlock: string[] | null = null;
try {
  // ── 1. deployment boots: controller → local replica → nginx ready → edge status ─────────────────────────────
  const put = await controller.put(DEP, { profile: 'speech-stack', minReplicas: 1, maxReplicas: 1, realtime: { maxSessions: MAX_SESSIONS } }, { app: 'parle' });
  check('deployment registered with realtime, owned by app parle', put.created && controller.get(DEP)?.app === 'parle');
  await until('a ready replica', () => (controller.get(DEP)?.replicas ?? []).some(r => r.phase === 'ready'), 60_000);
  const replicaId = controller.get(DEP)!.replicas.find(r => r.phase === 'ready')!.id;
  await cloud.edgeReady(replicaId);
  check('replica ready behind the token gate, edge up', true, { replicaId });

  // ── 2. admission ───────────────────────────────────────────────────────────────────────────────────────────
  const admit = (key: string | null, body: unknown = {}, extra: Record<string, string> = {}) => fetch(`${GW}/v1/realtime/sessions`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra },
  });
  check('no key → 401', (await admit(null)).status === 401);
  const other = await admit('key-other', { config: { deployment: DEP } });
  check("another app's key → 403", other.status === 403, other.status);
  const ok = await admit('key-parle', { config: { system: 'Você é a padeira.', messages: [] } });
  const desc = await ok.json() as { sessionId: string; token: string; transports: Array<{ type: string }>; limits: unknown };
  check('app key → 200 with webrtc + ws + s2s-stream + post', ok.status === 200
    && ['webrtc', 'ws', 's2s-stream', 'post'].every(t => desc.transports.some(x => x.type === t)), desc.transports.map(t => t.type));
  await fetch(`${GW}/v1/realtime/sessions/${desc.sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${desc.token}` } });

  // ── 3. WebRTC in Chromium: one spoken turn through gateway signaling, media straight to the edge ────────────
  const a = await openPage();
  const rtc = await a.page.evaluate(() => (window as unknown as { e2eRun: (o: unknown) => Promise<Run> }).e2eRun({}));
  log(`webrtc run ${JSON.stringify(rtc)}`);
  check('browser: ladder picks webrtc', rtc.transport === 'webrtc', { transport: rtc.transport, error: rtc.error, attempts: rtc.metrics.attempts });
  const t3 = typesOf(rtc);
  check('webrtc turn: transcript → reply → audio → done', ['transcript', 'reply', 'audio_start', 'done'].every(t => t3.includes(t)), t3);
  check('webrtc: NPC audio actually reached the page (remote track RMS)', rtc.loudFrames > 20, rtc.loudFrames);
  results.latency.webrtc = { connectMs: rtc.metrics.connectMs, edge: rtc.metrics.lastTurn, browserTtfaMs: rtc.ttfaBrowserMs };

  // ── 4. telemetry: one trace across browser, gateway and edge ────────────────────────────────────────────────
  await sleep(6_000); // browser batches flush every 5 s; the edge's too
  const tl = await (await fetch(`${GW}/v1/telemetry/timeline?traceId=${rtc.traceId}`, { headers: { Authorization: 'Bearer key-admin' } })).json() as { events?: Array<{ source: string; event: string }> };
  const bySource = (tl.events ?? []).reduce<Record<string, number>>((m, e) => ({ ...m, [e.source]: (m[e.source] ?? 0) + 1 }), {});
  log(`timeline ${JSON.stringify(tl.events?.map(e => `${e.source}:${e.event}`))}`);
  check('telemetry: the session trace has browser, gateway and edge events', ['browser', 'gateway', 'edge'].every(s => (bySource[s] ?? 0) > 0), bySource);

  // ── 5. UDP blocked in the browser → ws rung through the gateway's relay ─────────────────────────────────────
  // A network that drops UDP to the replica (the firewall case): iptables on the edge's media ports, this scenario only.
  const udp = cloud.replicas.get(replicaId)!.ports.udp;
  const rule = ['INPUT', '-p', 'udp', '--dport', `${udp[0]}:${udp[1]}`, '-j', 'DROP'];
  if (Bun.spawnSync(['iptables', '-I', ...rule]).exitCode !== 0) throw new Error('iptables refused the UDP block (needs root)');
  udpBlock = rule;
  const b = await openPage();
  const ws = await b.page.evaluate(() => (window as unknown as { e2eRun: (o: unknown) => Promise<Run> }).e2eRun({}));
  Bun.spawnSync(['iptables', '-D', ...rule]);
  udpBlock = null;
  log(`ws run ${JSON.stringify(ws)}`);
  check('UDP blocked: ladder falls to ws', ws.transport === 'ws', { transport: ws.transport, attempts: ws.metrics.attempts, error: ws.error });
  const t5 = typesOf(ws);
  check('ws turn: transcript → reply → audio → done', ['transcript', 'reply', 'audio_start', 'done'].every(t => t5.includes(t)), t5);
  results.latency.ws = { connectMs: ws.metrics.connectMs, edge: ws.metrics.lastTurn };

  // ── 6. edge dies mid-session → s2s-stream, conversation kept ────────────────────────────────────────────────
  const c = await openPage();
  await c.page.evaluate(() => (window as unknown as { e2eStart: (o: unknown) => Promise<Run> }).e2eStart({}));
  cloud.killEdge(replicaId);
  log('edge killed');
  const after = await c.page.evaluate(() => (window as unknown as { e2eAfterFailover: () => Promise<Run> }).e2eAfterFailover());
  log(`failover run ${JSON.stringify(after)}`);
  check('edge killed: session fails over to s2s-stream', after.transport === 's2s-stream', { transport: after.transport, error: after.error });
  check('s2s-stream: the clip turn is answered', typesOf(after).includes('reply') && typesOf(after).includes('done'), typesOf(after));
  check('history kept across the failover (first turn + second turn)', after.history.filter(m => m.role === 'assistant').length >= 2, after.history.map(m => m.role));
  cloud.startEdge(cloud.replicas.get(replicaId)!);
  await cloud.edgeReady(replicaId);

  // ── 7. capacity: RT_MAX_SESSIONS admitted, the next one refused at once with the fallback ───────────────────
  await sleep(2_500); // the gateway caches each replica's status for 2 s
  const held: Array<{ sessionId: string; token: string }> = [];
  for (let i = 0; i < MAX_SESSIONS; i++) {
    const r = await admit('key-parle', { config: LESSON_CONFIG });
    if (r.status === 200) held.push(await r.json() as { sessionId: string; token: string });
  }
  const full = await admit('key-parle', { config: LESSON_CONFIG });
  const fullBody = await full.json() as { error?: { code?: string } | string; code?: string; fallback?: { transport: string } };
  check(`capacity: ${MAX_SESSIONS} admitted, then 503 saturated + Retry-After + fallback`,
    held.length === MAX_SESSIONS && full.status === 503 && Boolean(full.headers.get('retry-after')) && fullBody.fallback?.transport === 's2s-stream',
    { admitted: held.length, status: full.status, body: fullBody });
  for (const h of held) await fetch(`${GW}/v1/realtime/sessions/${h.sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${h.token}` } });

  // ── 8. cold deployment: no-wake keeps it cold, a plain request wakes it ─────────────────────────────────────
  await controller.put('speech-cold', { profile: 'speech-stack', minReplicas: 0, maxReplicas: 1, realtime: { maxSessions: MAX_SESSIONS } }, { app: 'parle' });
  const nw = await admit('key-parle', { config: { deployment: 'speech-cold' } }, { 'X-Gateway-No-Wake': '1' });
  const nwBody = await nw.json() as Record<string, unknown>;
  await sleep(1_500);
  check('cold + X-Gateway-No-Wake: 503 cold, no machine created', nw.status === 503 && (controller.get('speech-cold')?.replicas.length ?? 0) === 0, { status: nw.status, body: nwBody });
  const wake = await admit('key-parle', { config: { deployment: 'speech-cold' } });
  check('cold without no-wake: 503 cold now…', wake.status === 503, wake.status);
  await until('the cold deployment woken', () => (controller.get('speech-cold')?.replicas ?? []).some(r => r.phase === 'ready'), 60_000);
  const coldRep = controller.get('speech-cold')!.replicas.find(r => r.phase === 'ready')!.id;
  await cloud.edgeReady(coldRep);
  await sleep(2_500);
  const warm = await admit('key-parle', { config: { deployment: 'speech-cold' } });
  check('…and admitted once the woken replica is ready', warm.status === 200, warm.status);
} catch (err) {
  exitCode = 1;
  console.log(`ERROR ${(err as Error).message}`);
  log(`ERROR ${(err as Error).stack}`);
} finally {
  if (udpBlock) Bun.spawnSync(['iptables', '-D', ...udpBlock]);
  for (const b of browsers) await b.close().catch(() => {});
  controller.stop();
  realtime.stop();
  await cloud.closeAll();
  gateway.closeAllConnections?.();
  gateway.close();
  app.close();
  await telemetry.stop?.();
  writeFileSync(join(WORK, 'summary.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: results.checks.filter(c => c.ok).length, failed: results.checks.filter(c => !c.ok).length, latency: results.latency, log: LOG }, null, 2));
  if (!process.env.E2E_KEEP) rmSync(join(WORK, 'telemetry'), { recursive: true, force: true });
  process.exit(exitCode);
}
