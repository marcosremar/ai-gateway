/**
 * Live realtime e2e against a real gateway + Scaleway replica (docs/realtime.md § e2e plan).
 * Local pieces only: the app backend (holds the key), the SDK bundle, the page, Chromium.
 *
 *   GW=http://localhost:4100 KEY=$SANDBOX_TOKEN MIC=/tmp/aigw-rt-e2e/mic.wav bun scripts/realtime-e2e/e2e-live.ts <cmd>
 *
 *   admit                     POST /v1/realtime/sessions → status + descriptor summary
 *   turn [transport]          one spoken turn in Chrome (default ladder; 'ws' forces the ws rung)
 *   barge                     connect, wait for NPC audio_start, interrupt(), measure 'interrupted' latency
 *   hold N [extra]            N admitted sessions held on ws; then one more admit ('extra' any value → also admit one)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { join, resolve } from 'path';
import { chromium, type Browser } from 'playwright';
import { freePort } from './local-cloud';

const ROOT = resolve(import.meta.dir, '../..');
const GW = process.env.GW ?? 'http://localhost:4100';
const KEY = process.env.KEY ?? process.env.SANDBOX_TOKEN ?? '';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIC = process.env.MIC ?? '/tmp/aigw-rt-e2e/mic.wav';
const DEP = process.env.DEP ?? 'parle-speech';
const CONFIG = JSON.parse(process.env.RT_CONFIG ?? '{"system":"Você é a padeira da esquina. Responda curto, uma frase.","messages":[],"voice":"default","fallback_voice":"default"}');

const results: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const sdkBuild = await Bun.build({ entrypoints: [join(ROOT, 'sdk/browser/realtime/index.ts')], target: 'browser', format: 'esm' });
if (!sdkBuild.success) throw new Error(`SDK build failed: ${sdkBuild.logs.join('\n')}`);
const SDK_JS = await sdkBuild.outputs[0].text();
const PAGE = `<!doctype html><meta charset="utf-8"><title>rt live</title><body><script type="module" src="/page.js"></script>`;
const PAGE_JS = await Bun.file(join(import.meta.dir, 'page-live.js')).text();

async function readAll(req: IncomingMessage): Promise<Buffer> { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c); }
async function relay(req: IncomingMessage, res: ServerResponse, path: string, withConfig = false): Promise<void> {
  let body = await readAll(req);
  if (withConfig) body = Buffer.from(JSON.stringify({ ...JSON.parse(body.toString() || '{}'), config: { ...CONFIG, deployment: DEP } }));
  const headers: Record<string, string> = { Authorization: `Bearer ${KEY}`, 'Content-Type': String(req.headers['content-type'] ?? 'application/json') };
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
const app = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (req.method === 'GET' && path === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  if (req.method === 'GET' && path === '/sdk.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(SDK_JS); return; }
  if (req.method === 'GET' && path === '/page.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(PAGE_JS); return; }
  if (req.method === 'POST' && path === '/api/rt-session') { void relay(req, res, '/v1/realtime/sessions', true); return; }
  if (req.method === 'POST' && path === '/api/s2s') { void relay(req, res, '/v1/s2s'); return; }
  res.writeHead(404); res.end();
});
await new Promise<void>(r => app.listen(appPort, '127.0.0.1', r));

async function admit(opts: { config?: unknown; transports?: string[] } = {}) {
  const r = await fetch(`${GW}/v1/realtime/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ config: { ...CONFIG, deployment: DEP, ...(opts.config as object ?? {}) }, ...(opts.transports ? { transports: opts.transports } : {}) }),
  });
  const body = await r.json().catch(() => ({})) as Record<string, unknown>;
  return { status: r.status, retryAfter: r.headers.get('retry-after'), body };
}

const browsers: Browser[] = [];
async function openPage() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${MIC}`,
      '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
  browsers.push(browser);
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => console.log(`[page ${m.type()}] ${m.text().slice(0, 200)}`));
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  await page.goto(APP);
  await page.waitForFunction(() => (window as unknown as { liveReady?: boolean }).liveReady === true);
  return { browser, page };
}

const cmd = process.argv[2] ?? 'turn';
const arg = process.argv[3];
// Extra run options from env: LIVE_FORCE_RELAY=1 → browser ICE policy relay-only; LIVE_VOICE_B64/LIVE_VOICE_TEXT →
// config_update{voice:{audio:'data:audio/wav;base64,<b64>',text}} after connect (a clone TTS without a catalog).
const extraOpts: Record<string, unknown> = {};
if (process.env.LIVE_FORCE_RELAY === '1') extraOpts.forceRelay = true;
if (process.env.LIVE_VOICE_B64 && process.env.LIVE_VOICE_TEXT) {
  const b64 = (await Bun.file(process.env.LIVE_VOICE_B64).text()).trim();
  extraOpts.voiceAfter = { voice: { audio: `data:audio/wav;base64,${b64}`, text: process.env.LIVE_VOICE_TEXT } };
}

try {
  if (cmd === 'admit') {
    const r = await admit();
    results.admit = {
      status: r.status, retryAfter: r.retryAfter,
      sessionId: (r.body as { sessionId?: string }).sessionId ?? null,
      transports: ((r.body as { transports?: Array<{ type: string }> }).transports ?? []).map(t => t.type),
      iceServers: ((r.body as { iceServers?: Array<unknown> }).iceServers ?? []).length,
      limits: (r.body as { limits?: unknown }).limits ?? null,
      error: (r.body as { error?: unknown }).error ?? null,
    };
    console.log(JSON.stringify(results, null, 2));
  } else if (cmd === 'turn' || cmd === 'barge') {
    const p = await openPage();
    const run = await p.page.evaluate(
      ([transport, barge, extra]) => (window as unknown as { liveRun: (o: unknown) => Promise<unknown> }).liveRun({ transport, barge, ...(extra as object) }),
      [arg && arg !== 'true' ? arg : null, cmd === 'barge', extraOpts],
    );
    results.run = run;
    console.log(JSON.stringify(run, null, 2));
  } else if (cmd === 'hold') {
    const n = Number(arg ?? '8');
    const held: WebSocket[] = [];
    const admits: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const r = await admit({ transports: ['webrtc', 'ws'] });
      admits.push({ i, status: r.status, sid: (r.body as { sessionId?: string }).sessionId ?? null });
      if (r.status !== 200) break;
      const wsOffer = ((r.body as { transports?: Array<{ type: string; url?: string }> }).transports ?? []).find(t => t.type === 'ws');
      if (!wsOffer?.url) { admits.push({ i, error: 'no ws offer' }); break; }
      const ws = new WebSocket(wsOffer.url);
      const opened = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 10_000);
        let ready = false;
        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string' && (ev.data as string).includes('"ready"')) { ready = true; clearTimeout(t); resolve(true); }
        };
        ws.onerror = () => { clearTimeout(t); resolve(false); };
        ws.onclose = () => { if (!ready) { clearTimeout(t); resolve(false); } };
      });
      if (!opened) { admits.push({ i, error: 'ws did not reach ready' }); break; }
      held.push(ws);
    }
    results.held = held.length;
    results.admits = admits;
    const extra = await admit({ transports: ['webrtc', 'ws'] });
    results.extraAdmit = { status: extra.status, retryAfter: extra.retryAfter, error: (extra.body as { error?: { code?: string } }).error ?? null };
    console.log(JSON.stringify(results, null, 2));
    await sleep(Number(process.env.HOLD_MS ?? '90000'));
    for (const ws of held) ws.close();
  } else {
    console.log(`unknown cmd ${cmd}`);
  }
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  app.close();
}
