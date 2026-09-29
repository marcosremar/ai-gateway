/**
 * Qwen3-TTS latency / performance bench — run it on the CLIENT machine
 * (where the audio is played, e.g. Lyon), not on the gateway host.
 *
 *   bun scripts/qwen-tts-latency-bench.ts --at 45.76,4.84            # deploy near client, bench, terminate
 *   bun scripts/qwen-tts-latency-bench.ts --endpoint http://IP:PORT   # bench an already-running pod
 *
 * Flags:
 *   --at <lat,lon>     client location → deploy with region "near" (default: GPU_CLIENT_LOCATION)
 *   --endpoint <url>   skip deploy, bench this pod
 *   --gpu <type>       GPU type (default "RTX 4090")
 *   --max-cost <usd>   per-hour cost cap (default 0.8)
 *   -n <count>         timed requests per sentence set (default 10)
 *   --out <dir>        where generated WAVs go (default ./qwen-tts-bench-out)
 *   --keep             do not terminate the pod at the end
 *
 * The GPU is deployed and terminated through the gateway API (hard rule 2).
 * Measures, per request: TTFB, total time, audio duration, RTF (synthesis
 * time / audio seconds). Also HTTP round trip to /health — an application
 * level RTT, which transparent proxies cannot fake like a TCP connect.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const args = process.argv.slice(2);
const arg = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

const GATEWAY = process.env.AI_GATEWAY_URL || process.env.GATEWAY_URL || 'http://localhost:9012';
const API_KEY = process.env.AIGW_APP_KEY || process.env.AI_GATEWAY_KEY || process.env.GATEWAY_API_KEY || '';
const AT = arg('--at') || process.env.GPU_CLIENT_LOCATION || '';
const GPU = arg('--gpu') || 'RTX 4090';
const MAX_COST = Number(arg('--max-cost') || 0.8);
const N = Number(arg('-n') || 10);
const OUT = arg('--out') || 'qwen-tts-bench-out';
const KEEP = args.includes('--keep');
let endpoint = arg('--endpoint') || '';

const SENTENCES: Array<{ language: string; speaker: string; text: string }> = [
  { language: 'French',     speaker: 'Ryan', text: 'Bonjour à tous, bienvenue à cette réunion.' },
  { language: 'French',     speaker: 'Ryan', text: "La traduction simultanée doit rester fluide, même quand plusieurs personnes parlent en même temps dans la salle." },
  { language: 'English',    speaker: 'Ryan', text: 'Good morning everyone, thanks for joining.' },
  { language: 'Portuguese', speaker: 'Ryan', text: 'Olá a todos, obrigado por participarem desta reunião.' },
];

const headers = (): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
});

async function gw(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${GATEWAY}${path}`, { ...init, headers: headers() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

function pct(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN;
}

/** Duration in seconds of a PCM WAV buffer (null when not a RIFF/WAVE file). */
function wavSeconds(buf: Buffer): number | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12, byteRate = 0, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') { dataLen = Math.min(len, buf.length - off - 8); break; }
    off += 8 + len + (len % 2);
  }
  return byteRate > 0 ? dataLen / byteRate : null;
}

async function deploy(): Promise<string> {
  if (!AT) throw new Error('Pass --at <lat,lon> (Lyon: 45.76,4.84) or set GPU_CLIENT_LOCATION, or use --endpoint');
  const [lat, lon] = AT.split(',').map(Number);
  console.log(`Deploying Qwen3-TTS near ${lat},${lon} (${GPU}, cap $${MAX_COST}/h) via ${GATEWAY}...`);
  const r = await gw('/v1/gpu/deploy', {
    method: 'POST',
    body: JSON.stringify({
      label: 'qwen3-tts-latency-bench',
      dockerImage: 'marcosremar/babelcast-qwen3-tts:latest',
      gpuTypes: [GPU], provider: 'vast',
      region: 'near', clientLat: lat, clientLon: lon,
      maxCostUsd: MAX_COST,
    }),
  });
  console.log(`  ${r.deployId} — ${r.costEstimate ?? ''}`);
  const t0 = Date.now();
  for (;;) {
    await Bun.sleep(15_000);
    const s = await gw('/v1/gpu/status');
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`  ${elapsed}s ${s.status} ${s.step ?? ''} ${s.gpuType ?? ''} ${s.endpoint ?? ''}`);
    if (s.status === 'ready' && s.endpoint) {
      console.log(`  cold start: ${elapsed}s`);
      return s.endpoint;
    }
    if (s.status === 'error' || s.status === 'stopped') throw new Error(`deploy ended as ${s.status}: ${s.alert ?? ''}`);
    if (elapsed > 25 * 60) throw new Error('deploy not ready after 25 min');
  }
}

async function tts(text: string, language: string, speaker: string) {
  const t0 = performance.now();
  const res = await fetch(`${endpoint}/v1/tts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language, speaker }),
    signal: AbortSignal.timeout(60_000),
  });
  const ttfb = performance.now() - t0;
  const audio = Buffer.from(await res.arrayBuffer());
  const total = performance.now() - t0;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${audio.toString('utf8').slice(0, 200)}`);
  return { ttfb, total, audio, contentType: res.headers.get('content-type') || '' };
}

async function main() {
  let deployedHere = false;
  try {
    if (!endpoint) { endpoint = await deploy(); deployedHere = true; }
    endpoint = endpoint.replace(/\/$/, '');
    mkdirSync(OUT, { recursive: true });

    // Application-level RTT: /health round trips (first one pays TCP+TLS setup)
    const rtts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      const r = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (r) { await r.arrayBuffer(); if (i > 0) rtts.push(performance.now() - t0); }
    }
    console.log(`\n/health RTT from here: p50 ${pct(rtts, 50).toFixed(0)}ms  min ${Math.min(...rtts).toFixed(0)}ms  (${rtts.length} samples)`);

    console.log('Warm-up request...');
    const w = await tts(SENTENCES[0].text, SENTENCES[0].language, SENTENCES[0].speaker);
    console.log(`  warm-up: ${w.total.toFixed(0)}ms, ${w.audio.length} bytes, ${w.contentType}`);

    const rows: Array<{ lang: string; chars: number; ttfb: number; total: number; secs: number | null }> = [];
    let failures = 0;
    for (let i = 0; i < N; i++) {
      for (const [j, s] of SENTENCES.entries()) {
        try {
          const r = await tts(s.text, s.language, s.speaker);
          const secs = wavSeconds(r.audio);
          rows.push({ lang: s.language, chars: s.text.length, ttfb: r.ttfb, total: r.total, secs });
          if (i === 0) writeFileSync(join(OUT, `${j}-${s.language.toLowerCase()}.wav`), r.audio);
        } catch (err) {
          failures++;
          console.log(`  FAIL ${s.language}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    const totals = rows.map(r => r.total);
    const ttfbs = rows.map(r => r.ttfb);
    const rtfs = rows.filter(r => r.secs).map(r => (r.total / 1000) / r.secs!);
    console.log(`\n=== Qwen3-TTS @ ${endpoint} — ${rows.length} ok / ${failures} failed ===`);
    console.log(`  total  p50 ${pct(totals, 50).toFixed(0)}ms  p95 ${pct(totals, 95).toFixed(0)}ms  max ${Math.max(...totals).toFixed(0)}ms`);
    console.log(`  TTFB   p50 ${pct(ttfbs, 50).toFixed(0)}ms  p95 ${pct(ttfbs, 95).toFixed(0)}ms`);
    if (rtfs.length) console.log(`  RTF    p50 ${pct(rtfs, 50).toFixed(2)}  (synthesis time / audio length; < 1 = faster than real time)`);
    for (const lang of [...new Set(rows.map(r => r.lang))]) {
      const t = rows.filter(r => r.lang === lang).map(r => r.total);
      console.log(`  ${lang.padEnd(11)} p50 ${pct(t, 50).toFixed(0)}ms`);
    }
    console.log(`  WAVs: ${OUT}/ (listen to check quality)`);
    if (rows.some(r => r.secs === null)) console.log('  note: some responses were not WAV — RTF skipped for them');
  } finally {
    if (deployedHere && !KEEP) {
      console.log('\nTerminating pod via gateway...');
      for (let i = 0; i < 5; i++) {
        try { await gw('/v1/gpu/terminate', { method: 'POST', body: '{}' }); console.log('  terminated'); break; }
        catch (err) { console.log(`  retry: ${err instanceof Error ? err.message : err}`); await Bun.sleep(10_000); }
      }
    }
  }
}

main().catch(err => { console.error(`\nFAILED: ${err instanceof Error ? err.message : err}`); process.exit(1); });
