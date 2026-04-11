#!/usr/bin/env bun
/**
 * Vast.ai Full Benchmark — Cold Start + Inference Latency
 *
 * Phases:
 *   T1  Vast reports actual_status='running'     (image pulled, container up)
 *   T2  /health returns 200                       (uvicorn accepting)
 *   T3  STT warm  (Whisper loaded)
 *   T4  LLM ready (llama.cpp accepting requests)
 *   T5  First inference OK
 *
 * Inference latency (5 rounds each, reports p50/p95/min/max):
 *   - LLM: POST /v1/chat/completions (short prompt, max_tokens=32)
 *   - STT: POST /v1/transcribe (synthetic silence WAV ~1s)
 *   - Translate: POST /v1/translate/text
 *
 * Usage:
 *   bun scripts/vast-full-bench.ts --image marcosremar/babelcast-subtitle:latest
 *
 * Optional:
 *   --offer-id <id>   Use specific Vast.ai offer (skip search)
 *   --max-wait <sec>  Boot timeout (default 1200)
 *   --keep            Don't destroy instance after bench
 *   --rounds <n>      Inference rounds per stage (default 5)
 *
 * Env: VAST_API_KEY (loaded from .env automatically by Bun)
 */

const VAST_API_BASE = 'https://console.vast.ai/api/v0';

const args = process.argv.slice(2);
function flag(name: string) { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; }
function bool(name: string) { return args.includes(`--${name}`); }

const IMAGE = flag('image') ?? 'marcosremar/babelcast-subtitle:latest';
const OFFER_ID_OVERRIDE = flag('offer-id');
const MAX_WAIT_S = parseInt(flag('max-wait') ?? '1200', 10);
const KEEP = bool('keep');
const ROUNDS = parseInt(flag('rounds') ?? '5', 10);

const VAST_KEY = process.env.VAST_API_KEY;
if (!VAST_KEY) { console.error('VAST_API_KEY not set'); process.exit(1); }

const headers = { Authorization: `Bearer ${VAST_KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function fmtMs(ms: number) { return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`; }
function pct(arr: number[], p: number) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((p / 100) * s.length)] ?? s[s.length - 1];
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

let createdInstanceId: number | null = null;
let cleanupRan = false;
async function destroyInstance(id: number) {
  if (cleanupRan) return; cleanupRan = true;
  console.error(`\n[cleanup] deleting instance ${id}...`);
  try {
    const r = await fetch(`${VAST_API_BASE}/instances/${id}/`, { method: 'DELETE', headers });
    console.error(`[cleanup] DELETE → HTTP ${r.status}`);
  } catch (e) { console.error('[cleanup] error:', e); }
}
process.on('SIGINT', async () => { if (createdInstanceId) await destroyInstance(createdInstanceId); process.exit(130); });
process.on('SIGTERM', async () => { if (createdInstanceId) await destroyInstance(createdInstanceId); process.exit(143); });

// ── Offer Search ─────────────────────────────────────────────────────────────

async function searchOffer() {
  console.error('[offer] searching cheapest US/CA host with ≥2 Gbps + direct ports...');
  const body = {
    rentable: { eq: true }, rented: { eq: false },
    num_gpus: { eq: 1 }, disk_space: { gte: 30 },
    direct_port_count: { gte: 2 },
    reliability2: { gte: 0.95 }, inet_down: { gte: 2000 },
    type: 'on-demand', order: [['dph_total', 'asc']], limit: 20,
  };
  const res = await fetch(`${VAST_API_BASE}/bundles/`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Offer search failed: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { offers?: Array<Record<string, unknown>> };
  const offers = data.offers ?? [];
  const usCa = offers.filter(o => /,\s*(US|CA)$/.test(String(o.geolocation ?? '')));
  const pick = usCa[0] ?? offers[0];
  if (!pick) throw new Error('No offers found');
  return { id: Number(pick.id), gpu: String(pick.gpu_name), pricePerHr: Number(pick.dph_total), geo: String(pick.geolocation ?? '?'), inetDown: Number(pick.inet_down ?? 0) };
}

// ── Deploy ───────────────────────────────────────────────────────────────────

async function deploy(offerId: number): Promise<number> {
  console.error(`[deploy] PUT /asks/${offerId}/ image=${IMAGE}`);
  const body = {
    client_id: 'me', image: IMAGE, disk: 30,
    runtype: 'ssh_direct',
    onstart: 'nohup /app/start.sh > /var/log/babelcast.log 2>&1 &',
    env: { TZ: 'UTC', '-p 8000:8000': '1' },
  };
  const res = await fetch(`${VAST_API_BASE}/asks/${offerId}/`, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Deploy failed: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { success?: boolean; new_contract?: number };
  if (!data.success || !data.new_contract) throw new Error(`Deploy: ${JSON.stringify(data)}`);
  return data.new_contract;
}

// ── Poll Instance ─────────────────────────────────────────────────────────────

async function getInstance(id: number) {
  const res = await fetch(`${VAST_API_BASE}/instances/${id}/`, { headers });
  if (!res.ok) return null;
  const data = (await res.json()) as Record<string, unknown>;
  const inst = (data.instances ?? data) as Record<string, unknown>;
  if (!inst || !inst.actual_status) return null;
  const status = String(inst.actual_status ?? inst.cur_state ?? '?');
  const ip = String(inst.public_ipaddr ?? '');
  let endpoint = '';
  const ports = inst.ports as Record<string, unknown> | undefined;
  const directPort = inst.direct_port_start as number | undefined;
  if (ports && directPort && directPort > 0) {
    const p8000 = (ports['8000/tcp'] ?? ports['8000']) as Array<{ HostPort?: string; HostIp?: string }> | undefined;
    const entry = p8000?.find(e => Number(e.HostPort) > 0);
    if (entry?.HostPort) {
      const hostIp = entry.HostIp && !entry.HostIp.startsWith('172.') && !entry.HostIp.startsWith('10.') && entry.HostIp !== '0.0.0.0' ? entry.HostIp : ip;
      endpoint = `http://${hostIp}:${entry.HostPort}`;
    }
  }
  if (!endpoint && ip && directPort && directPort > 0) endpoint = `http://${ip}:${directPort}`;
  return { status, ip, endpoint };
}

// ── Health Probe ──────────────────────────────────────────────────────────────

interface Health { status?: string; services?: { whisper?: string; llm?: string }; model_warmth?: { stt?: { warm?: boolean }; llm?: { warm?: boolean } } }
async function probeHealth(ep: string): Promise<Health | null> {
  try {
    const r = await fetch(`${ep}/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return await r.json() as Health;
  } catch { return null; }
}

// ── Inference Helpers ─────────────────────────────────────────────────────────

async function timeFetch(url: string, init: RequestInit): Promise<{ ok: boolean; ms: number; status: number; body: string }> {
  const t = Date.now();
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) });
    const body = await r.text();
    return { ok: r.ok, ms: Date.now() - t, status: r.status, body };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, status: 0, body: String(e) };
  }
}

// Minimal valid WAV: 1s silence, 16kHz, 16-bit mono (44 bytes header + 32000 bytes data)
function makeSilenceWav(durationS = 1): Uint8Array {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const numSamples = sampleRate * durationS;
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const enc = new TextEncoder();
  const writeStr = (off: number, s: string) => enc.encode(s).forEach((b, i) => v.setUint8(off + i, b));
  writeStr(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, numChannels, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
  v.setUint16(32, numChannels * (bitsPerSample / 8), true); v.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data'); v.setUint32(40, dataSize, true);
  return new Uint8Array(buf); // data bytes are 0 = silence
}

function statsRow(label: string, times: number[]) {
  if (times.length === 0) return `  ${label.padEnd(28)} no data`;
  const p50 = pct(times, 50), p95 = pct(times, 95);
  const min = Math.min(...times), max = Math.max(...times);
  return `  ${label.padEnd(28)} p50=${fmtMs(p50)}  p95=${fmtMs(p95)}  min=${fmtMs(min)}  max=${fmtMs(max)}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const ms = (label: string) => { const v = Date.now() - t0; console.error(`[t+${(v/1000).toFixed(0)}s] ${label}`); return v; };

  console.error(`\n${'═'.repeat(64)}`);
  console.error(`  Vast.ai Full Benchmark`);
  console.error(`  image : ${IMAGE}`);
  console.error(`  rounds: ${ROUNDS} per inference stage`);
  console.error(`${'═'.repeat(64)}\n`);

  // ── 1. Find offer ──────────────────────────────────────────────────────────
  let offerId: number; let offerInfo: { gpu: string; pricePerHr: number; geo: string; inetDown: number };
  if (OFFER_ID_OVERRIDE) {
    offerId = parseInt(OFFER_ID_OVERRIDE, 10);
    offerInfo = { gpu: '?', pricePerHr: 0, geo: 'override', inetDown: 0 };
  } else {
    offerInfo = await searchOffer();
    offerId = offerInfo.id as unknown as number;
  }
  console.error(`[offer] id=${offerId}  gpu=${offerInfo.gpu}  $${offerInfo.pricePerHr.toFixed(3)}/hr  inet↓=${offerInfo.inetDown}Mbps  ${offerInfo.geo}`);

  // ── 2. Deploy ───────────────────────────────────────────────────────────────
  const instanceId = await deploy(offerId);
  createdInstanceId = instanceId;
  const tDeploy = ms(`instance ${instanceId} created`);
  _ = tDeploy; // suppress unused

  // ── 3. Wait for running + endpoint ─────────────────────────────────────────
  let endpoint = '';
  let tRunning: number | null = null;
  while ((Date.now() - t0) / 1000 < MAX_WAIT_S) {
    await sleep(5_000);
    const inst = await getInstance(instanceId);
    if (!inst) continue;
    console.error(`[t+${((Date.now()-t0)/1000).toFixed(0)}s] status=${inst.status} endpoint=${inst.endpoint || '?'}`);
    if (inst.status === 'running' && inst.endpoint) {
      tRunning = Date.now() - t0;
      endpoint = inst.endpoint;
      ms(`Vast running — endpoint=${endpoint}`);
      break;
    }
  }
  if (!endpoint) throw new Error('Timed out waiting for running + endpoint');

  // ── 4. Poll /health milestones ──────────────────────────────────────────────
  let tHealth: number | null = null, tStt: number | null = null, tLlm: number | null = null;
  while ((Date.now() - t0) / 1000 < MAX_WAIT_S) {
    const h = await probeHealth(endpoint);
    if (h) {
      if (!tHealth) { tHealth = Date.now() - t0; ms(`/health=200 — ${JSON.stringify(h.services ?? {})}`); }
      if (!tStt && h.model_warmth?.stt?.warm) { tStt = Date.now() - t0; ms('STT warm (Whisper loaded)'); }
      if (!tLlm && h.model_warmth?.llm?.warm) { tLlm = Date.now() - t0; ms('LLM ready (llama.cpp)'); }
      if (tStt && tLlm) break;
    }
    await sleep(3_000);
  }

  // ── 5. Inference benchmarks ─────────────────────────────────────────────────
  console.error(`\n[bench] Running ${ROUNDS} rounds per stage...`);

  const llmTimes: number[] = [];
  const sttTimes: number[] = [];
  const translateTimes: number[] = [];
  let tFirstInference: number | null = null;

  // LLM rounds
  for (let i = 0; i < ROUNDS; i++) {
    const r = await timeFetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'translategemma',
        messages: [{ role: 'user', content: 'Translate to English: Bonjour le monde' }],
        max_tokens: 32,
      }),
    });
    llmTimes.push(r.ms);
    if (!tFirstInference && r.ok) tFirstInference = Date.now() - t0;
    console.error(`  [llm #${i+1}] ${r.ok ? '✓' : '✗'} ${fmtMs(r.ms)}${r.ok ? '' : ` — ${r.body.slice(0, 80)}`}`);
    if (i < ROUNDS - 1) await sleep(500);
  }

  // STT rounds — multipart/form-data with `file` field (FastAPI/OpenAI-compatible)
  const silenceWav = makeSilenceWav(1);
  for (let i = 0; i < ROUNDS; i++) {
    const form = new FormData();
    form.append('file', new Blob([silenceWav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', 'whisper-1');
    const r = await timeFetch(`${endpoint}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
    });
    sttTimes.push(r.ms);
    console.error(`  [stt #${i+1}] ${r.ok ? '✓' : '✗'} ${fmtMs(r.ms)}${r.ok ? ` text="${JSON.parse(r.body || '{}').text ?? ''}"` : ` — ${r.body.slice(0, 120)}`}`);
    if (i < ROUNDS - 1) await sleep(500);
  }

  // Translate rounds — LLM-backed translate via /v1/chat/completions (same as LLM but longer output)
  for (let i = 0; i < ROUNDS; i++) {
    const r = await timeFetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'translategemma',
        messages: [
          { role: 'system', content: 'You are a translator. Translate the following French text to English. Reply with only the translation.' },
          { role: 'user', content: 'Bonjour le monde, comment allez-vous aujourd\'hui? Je suis très heureux de vous voir.' },
        ],
        max_tokens: 64,
      }),
    });
    translateTimes.push(r.ms);
    const translation = r.ok ? (() => { try { return JSON.parse(r.body)?.choices?.[0]?.message?.content ?? ''; } catch { return ''; } })() : '';
    console.error(`  [translate #${i+1}] ${r.ok ? '✓' : '✗'} ${fmtMs(r.ms)}${r.ok ? ` "${translation.slice(0, 60)}"` : ` — ${r.body.slice(0, 80)}`}`);
    if (i < ROUNDS - 1) await sleep(500);
  }

  // ── 6. Teardown ──────────────────────────────────────────────────────────────
  if (!KEEP) await destroyInstance(instanceId);
  else console.error(`[keep] instance ${instanceId} kept — destroy manually`);

  // ── 7. Report ─────────────────────────────────────────────────────────────────
  const totalCostUsd = ((Date.now() - t0) / 3_600_000) * offerInfo.pricePerHr;
  const report = {
    image: IMAGE,
    offer: { id: offerId, gpu: offerInfo.gpu, pricePerHr: offerInfo.pricePerHr, geo: offerInfo.geo, inetDownMbps: offerInfo.inetDown },
    instance_id: instanceId,
    cold_start: {
      vast_running_s: tRunning != null ? +(tRunning / 1000).toFixed(1) : null,
      health_200_s: tHealth != null ? +(tHealth / 1000).toFixed(1) : null,
      stt_warm_s: tStt != null ? +(tStt / 1000).toFixed(1) : null,
      llm_ready_s: tLlm != null ? +(tLlm / 1000).toFixed(1) : null,
      first_inference_s: tFirstInference != null ? +(tFirstInference / 1000).toFixed(1) : null,
    },
    inference_ms: {
      llm: { p50: pct(llmTimes, 50), p95: pct(llmTimes, 95), min: Math.min(...llmTimes), max: Math.max(...llmTimes), rounds: llmTimes },
      stt: { p50: pct(sttTimes, 50), p95: pct(sttTimes, 95), min: Math.min(...sttTimes), max: Math.max(...sttTimes), rounds: sttTimes },
      translate: { p50: pct(translateTimes, 50), p95: pct(translateTimes, 95), min: Math.min(...translateTimes), max: Math.max(...translateTimes), rounds: translateTimes },
    },
    total_elapsed_s: +((Date.now() - t0) / 1000).toFixed(1),
    estimated_cost_usd: +totalCostUsd.toFixed(4),
  };

  console.error(`\n${'═'.repeat(64)}`);
  console.error(`  COLD START`);
  console.error(`${'═'.repeat(64)}`);
  console.error(`  Vast running      ${tRunning != null ? fmtMs(tRunning) : 'timeout'}`);
  console.error(`  /health 200       ${tHealth != null ? fmtMs(tHealth) : 'timeout'}`);
  console.error(`  STT warm          ${tStt != null ? fmtMs(tStt) : 'timeout'}`);
  console.error(`  LLM ready         ${tLlm != null ? fmtMs(tLlm) : 'timeout'}`);
  console.error(`  First inference   ${tFirstInference != null ? fmtMs(tFirstInference) : 'n/a'}`);
  console.error(`\n${'═'.repeat(64)}`);
  console.error(`  INFERENCE LATENCY (${ROUNDS} rounds each)`);
  console.error(`${'═'.repeat(64)}`);
  console.error(statsRow('LLM /v1/chat/completions', llmTimes));
  console.error(statsRow('STT /v1/transcribe', sttTimes));
  console.error(statsRow('Translate (LLM, longer prompt)', translateTimes));
  console.error(`\n  GPU: ${offerInfo.gpu}  Price: $${offerInfo.pricePerHr.toFixed(3)}/hr`);
  console.error(`  Total elapsed: ${fmtMs(Date.now() - t0)}   Est. cost: $${totalCostUsd.toFixed(4)}`);
  console.error(`${'═'.repeat(64)}\n`);

  console.log('\nJSON_RESULT:');
  console.log(JSON.stringify(report, null, 2));
}

// Trick to suppress unused warning without lint ignore
let _ : unknown;

main().catch(async (e) => {
  console.error('[fatal]', e);
  if (createdInstanceId && !KEEP) await destroyInstance(createdInstanceId);
  process.exit(1);
});
