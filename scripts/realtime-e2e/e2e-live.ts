/**
 * Live realtime e2e against a real gateway + Scaleway replica (docs/realtime.md § e2e plan).
 * Local pieces only: the app backend (holds the key), the SDK bundle, the page, Chromium.
 *
 *   GW=http://localhost:4100 KEY=$SANDBOX_TOKEN MIC=/tmp/aigw-rt-e2e/mic.wav bun scripts/realtime-e2e/e2e-live.ts <cmd>
 *
 *   admit                     POST /v1/realtime/sessions → status + descriptor summary
 *   turn [transport]          one spoken turn in Chrome (default ladder; webrtc | ws | s2s-stream forces that rung)
 *   barge                     connect, wait for NPC audio_start, interrupt(), measure 'interrupted' latency
 *   hold N [extra]            N admitted sessions held on ws; then one more admit ('extra' any value → also admit one)
 */
import type { Browser } from 'playwright';
import { openMicPage, startAppBackend } from './app-page';
import { clip16k, wav } from './clip';

const GW = process.env.GW ?? 'http://localhost:4100';
const KEY = process.env.KEY ?? process.env.SANDBOX_TOKEN ?? '';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIC = process.env.MIC ?? '/tmp/aigw-rt-e2e/mic.wav';
const DEP = process.env.DEP ?? 'parle-speech';
const CONFIG = JSON.parse(process.env.RT_CONFIG ?? '{"system":"Você é a padeira da esquina. Responda curto, uma frase.","messages":[],"voice":"default","fallback_voice":"default"}');

const results: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const app = await startAppBackend({
  gw: GW, key: KEY, pageFile: 'page-live.js', config: () => ({ ...CONFIG, deployment: DEP }),
  files: {
    '/config.json': { type: 'application/json', body: JSON.stringify({ ...CONFIG, deployment: DEP }) },
    '/clip.wav': { type: 'audio/wav', body: wav(clip16k(MIC), 16000) },
  },
});

async function admit(opts: { config?: unknown; transports?: string[] } = {}) {
  const r = await fetch(`${GW}/v1/realtime/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ config: { ...CONFIG, deployment: DEP, ...(opts.config as object ?? {}) }, ...(opts.transports ? { transports: opts.transports } : {}) }),
  });
  const body = await r.json().catch(() => ({})) as Record<string, unknown>;
  return { status: r.status, retryAfter: r.headers.get('retry-after'), body };
}

const browsers: Browser[] = [];
const openPage = () => openMicPage({
  chrome: CHROME, mic: MIC, url: app.url, readyFlag: 'liveReady', log: (line) => console.log(line.slice(0, 220)), browsers,
});

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
