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
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Browser } from 'playwright';
import { openMicPage, startAppBackend } from './app-page';
import { concat, silence, tone, wav } from './clip';
import { startLocalStack } from './local-stack';

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

const stack = await startLocalStack({ python: PYTHON, work: WORK, keys: KEYS, deployment: DEP, maxSessions: MAX_SESSIONS, log });
const { gw: GW, cloud, controller, startCoturn, stopCoturn } = stack;

const LESSON_CONFIG = { system: 'Você é a padeira. Responda curto.', messages: [], voice: 'br-m-08' };
const app = await startAppBackend({
  gw: GW, key: 'key-parle', pageFile: 'page.js',
  config: (req) => ({ ...LESSON_CONFIG, ...(req.headers['x-e2e-deployment'] ? { deployment: String(req.headers['x-e2e-deployment']) } : {}) }),
});

const MIC_WAV = join(WORK, 'mic.wav');
writeFileSync(MIC_WAV, wav(concat(silence(0.8, 48000), tone(1.4, 48000), silence(9, 48000)), 48000));

const browsers: Browser[] = [];
const openPage = (extraArgs: string[] = []) => openMicPage({ chrome: CHROME, mic: MIC_WAV, url: app.url, readyFlag: 'e2eReady', log, extraArgs, browsers });

type Run = {
  transport: string | null; events: Array<{ type: string; [k: string]: unknown }>; loudFrames: number; traceId: string;
  sessionId: string | null; metrics: { connectMs: number | null; attempts: unknown[]; failovers: number; lastTurn: unknown };
  history: Array<{ role: string; content: string }>; error?: string; ttfaBrowserMs?: number | null;
};
const typesOf = (r: Run) => r.events.map(e => (e.type === 'transport' ? `transport:${String(e.transport)}` : e.type));

let exitCode = 0;
const blocks: string[][] = [];
/**
 * A firewall that drops ALL inbound UDP to a port range. Stateless on purpose: behind a stateful one (cloud security
 * groups) ICE often still connects host↔host by hole punching — the edge's own checks open the return path — which is
 * right (the faster pair wins) but would not prove the relay.
 */
function blockInboundUdp([lo, hi]: [number, number]): void {
  const rule = ['INPUT', '-p', 'udp', '--dport', `${lo}:${hi}`, '-j', 'DROP'];
  if (Bun.spawnSync(['iptables', '-I', ...rule]).exitCode !== 0) throw new Error('iptables refused the UDP block (needs root)');
  blocks.push(rule);
}
async function eventsNamed(event: string): Promise<Array<{ source: string; event: string; attrs?: Record<string, unknown> }>> {
  const r = await fetch(`${GW}/v1/telemetry/events?event=${event}&limit=50`, { headers: { Authorization: 'Bearer key-admin' } });
  return ((await r.json()) as { events?: Array<{ source: string; event: string; attrs?: Record<string, unknown> }> }).events ?? [];
}
async function bootDeployment(name: string): Promise<string> {
  await controller.put(name, { profile: 'speech-stack', minReplicas: 1, maxReplicas: 1, realtime: { maxSessions: MAX_SESSIONS } }, { app: 'parle' });
  await until(`${name} ready`, () => (controller.get(name)?.replicas ?? []).some(r => r.phase === 'ready'), 60_000);
  const id = controller.get(name)!.replicas.find(r => r.phase === 'ready')!.id;
  await cloud.edgeReady(id);
  return id;
}
async function waitPath(id: string, want: string): Promise<{ transports: string[]; net: { path: string; udpInbound: string; reasons: string[] } }> {
  let st = await cloud.edgeStatus(id);
  await until(`${id} path ${want}`, async () => { st = await cloud.edgeStatus(id); return st.net.path !== 'unknown'; }, 40_000);
  return st;
}
let udpBlock: string[] | null = null;
startCoturn();
try {
  // ── 1. deployment boots: controller → local replica → nginx ready → edge status ─────────────────────────────
  const put = await controller.put(DEP, { profile: 'speech-stack', minReplicas: 1, maxReplicas: 1, realtime: { maxSessions: MAX_SESSIONS } }, { app: 'parle' });
  check('deployment registered with realtime, owned by app parle', put.created && controller.get(DEP)?.app === 'parle');
  await until('a ready replica', () => (controller.get(DEP)?.replicas ?? []).some(r => r.phase === 'ready'), 60_000);
  const replicaId = controller.get(DEP)!.replicas.find(r => r.phase === 'ready')!.id;
  await cloud.edgeReady(replicaId);
  check('replica ready behind the token gate, edge up', true, { replicaId });
  const direct = await waitPath(replicaId, 'direct');
  check('net: the gateway probed the replica, inbound UDP ok → path direct', direct.net.path === 'direct' && direct.transports.includes('webrtc'), direct.net);

  // ── 2. admission ───────────────────────────────────────────────────────────────────────────────────────────
  const admit = (key: string | null, body: unknown = {}, extra: Record<string, string> = {}) => fetch(`${GW}/v1/realtime/sessions`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra },
  });
  check('no key → 401', (await admit(null)).status === 401);
  const other = await admit('key-other', { config: { ...LESSON_CONFIG, deployment: DEP } });
  check("another app's key → 403", other.status === 403, other.status);
  const noVoice = await admit('key-parle', { config: { system: 'x', deployment: DEP } });
  check('config without voice → 400 invalid_request', noVoice.status === 400, noVoice.status);
  const ok = await admit('key-parle', { config: LESSON_CONFIG });
  const desc = await ok.json() as { sessionId: string; token: string; transports: Array<{ type: string }>; limits: unknown };
  check('app key → 200 with webrtc + ws + s2s-stream + post', ok.status === 200
    && ['webrtc', 'ws', 's2s-stream', 'post'].every(t => desc.transports.some(x => x.type === t)), desc.transports.map(t => t.type));
  await fetch(`${GW}/v1/realtime/sessions/${desc.sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${desc.token}` } });

  // ── 3. WebRTC in Chromium: one spoken turn through gateway signaling, media straight to the edge ────────────
  const a = await openPage();
  const rtc = await a.page.evaluate(() => (window as unknown as { e2eRun: (o: unknown) => Promise<Run> }).e2eRun({ raceTransports: false }));
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

  const sel = (tl.events ?? []).filter(e => e.event === 'rt.ice.selected' || e.event === 'edge.ice.selected') as Array<{ source: string; event: string; attrs?: Record<string, unknown> }>;
  check('logs: the selected ICE pair is direct (host↔host) on browser and edge', sel.length >= 2 && sel.every(e => e.attrs?.local === 'host'), sel.map(e => `${e.source}:${String(e.attrs?.local)}/${String(e.attrs?.remote)}`));

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

  // ── 7b. the GPU's firewall drops inbound UDP: the edge relays through TURN itself (outbound), WebRTC still works ───
  blockInboundUdp(cloud.nextUdpRange());
  const relayRep = await bootDeployment('speech-relay');
  const relaySt = await waitPath(relayRep, 'relay');
  check('net: inbound UDP blocked → the edge allocates on TURN → path relay', relaySt.net.path === 'relay' && relaySt.transports.includes('webrtc'), relaySt.net);
  const d = await openPage();
  const viaRelay = await d.page.evaluate(() => (window as unknown as { e2eRun: (o: unknown) => Promise<Run> }).e2eRun({ raceTransports: false, sessionInit: { headers: { 'x-e2e-deployment': 'speech-relay' } } }));
  log(`relay run ${JSON.stringify(viaRelay)}`);
  check('relay: ladder still picks webrtc', viaRelay.transport === 'webrtc', { transport: viaRelay.transport, attempts: viaRelay.metrics.attempts });
  check('relay: full turn, NPC audio played', typesOf(viaRelay).includes('done') && viaRelay.loudFrames > 20, { loud: viaRelay.loudFrames });
  results.latency.relay = { connectMs: viaRelay.metrics.connectMs, edge: viaRelay.metrics.lastTurn, browserTtfaMs: viaRelay.ttfaBrowserMs };
  await sleep(6_000);
  const relayTl = await (await fetch(`${GW}/v1/telemetry/timeline?traceId=${viaRelay.traceId}`, { headers: { Authorization: 'Bearer key-admin' } })).json() as { events?: Array<{ source: string; event: string; attrs?: Record<string, unknown> }> };
  const edgeSel = (relayTl.events ?? []).find(e => e.event === 'edge.ice.selected');
  check('logs: the edge side of the pair is the TURN relay', edgeSel?.attrs?.local === 'relay', edgeSel?.attrs);

  // ── 7c. inbound UDP blocked AND TURN unreachable: no WebRTC offered, straight to ws (no 5 s lost) ──────────────
  stopCoturn();
  blockInboundUdp(cloud.nextUdpRange());
  const wsRep = await bootDeployment('speech-ws');
  const wsSt = await waitPath(wsRep, 'ws');
  check('net: no inbound UDP, no TURN → path ws, webrtc no longer listed', wsSt.net.path === 'ws' && !wsSt.transports.includes('webrtc'), wsSt.net);
  await controller.remove('speech-relay');
  const e = await openPage();
  const wsOnly = await e.page.evaluate(() => (window as unknown as { e2eRun: (o: unknown) => Promise<Run> }).e2eRun({ sessionInit: { headers: { 'x-e2e-deployment': 'speech-ws' } } }));
  log(`ws-only run ${JSON.stringify(wsOnly)}`);
  check('ws-only replica: first attempt is ws, connected fast', wsOnly.transport === 'ws' && (wsOnly.metrics.attempts[0] as { type: string }).type === 'ws' && (wsOnly.metrics.connectMs ?? 1e9) < 1500,
    { transport: wsOnly.transport, connectMs: wsOnly.metrics.connectMs, attempts: wsOnly.metrics.attempts });
  check('ws-only: full turn', typesOf(wsOnly).includes('done'), typesOf(wsOnly));
  results.latency.wsOnly = { connectMs: wsOnly.metrics.connectMs, edge: wsOnly.metrics.lastTurn };
  const probes = await eventsNamed('rt.net.probe');
  const paths = await eventsNamed('edge.net.path');
  check('logs: one rt.net.probe (gateway) and one edge.net.path (edge) per replica, with the reasons',
    ['direct', 'relay', 'ws'].every(p => probes.some(x => x.attrs?.path === p) && paths.some(x => x.attrs?.path === p)),
    { gateway: probes.map(x => `${String(x.attrs?.replica)}:${String(x.attrs?.udpInbound)}→${String(x.attrs?.path)}`), edge: paths.map(x => String(x.attrs?.reasons)) });
  await controller.remove('speech-ws');

  // ── 8. cold deployment: no-wake keeps it cold, a plain request wakes it ─────────────────────────────────────
  await controller.put('speech-cold', { profile: 'speech-stack', minReplicas: 0, maxReplicas: 1, realtime: { maxSessions: MAX_SESSIONS } }, { app: 'parle' });
  const nw = await admit('key-parle', { config: { ...LESSON_CONFIG, deployment: 'speech-cold' } }, { 'X-Gateway-No-Wake': '1' });
  const nwBody = await nw.json() as Record<string, unknown>;
  await sleep(1_500);
  check('cold + X-Gateway-No-Wake: 503 cold, no machine created', nw.status === 503 && (controller.get('speech-cold')?.replicas.length ?? 0) === 0, { status: nw.status, body: nwBody });
  const wake = await admit('key-parle', { config: { ...LESSON_CONFIG, deployment: 'speech-cold' } });
  check('cold without no-wake: 503 cold now…', wake.status === 503, wake.status);
  await until('the cold deployment woken', () => (controller.get('speech-cold')?.replicas ?? []).some(r => r.phase === 'ready'), 60_000);
  const coldRep = controller.get('speech-cold')!.replicas.find(r => r.phase === 'ready')!.id;
  await cloud.edgeReady(coldRep);
  await sleep(2_500);
  const warm = await admit('key-parle', { config: { ...LESSON_CONFIG, deployment: 'speech-cold' } });
  check('…and admitted once the woken replica is ready', warm.status === 200, warm.status);
} catch (err) {
  exitCode = 1;
  console.log(`ERROR ${(err as Error).message}`);
  log(`ERROR ${(err as Error).stack}`);
} finally {
  if (udpBlock) Bun.spawnSync(['iptables', '-D', ...udpBlock]);
  for (const rule of blocks) Bun.spawnSync(['iptables', '-D', ...rule]);
  for (const b of browsers) await b.close().catch(() => {});
  await stack.stop();
  app.close();
  writeFileSync(join(WORK, 'summary.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: results.checks.filter(c => c.ok).length, failed: results.checks.filter(c => !c.ok).length, latency: results.latency, log: LOG }, null, 2));
  if (!process.env.E2E_KEEP) rmSync(join(WORK, 'telemetry'), { recursive: true, force: true });
  process.exit(exitCode);
}
