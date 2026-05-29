#!/usr/bin/env bun
/**
 * Vast.ai Parallel Deploy Benchmark
 *
 * Deploys N cheap machines in parallel, boots ollama + model via SSH tunnel,
 * verifies inference, and reports timing per machine + aggregate stats.
 *
 * Phases measured from t0 = deploy POST sent:
 *   T1  actual_status='running'            (container up)
 *   T2  ollama /api/tags lists model       (ollama ready + model loaded, via SSH tunnel)
 *   T3  First POST /api/generate OK        (real inference round-trip)
 *
 * Usage:
 *   bun scripts/vast-parallel-bench.ts
 *   bun scripts/vast-parallel-bench.ts --parallel 5 --model qwen2.5:0.5b
 *   bun scripts/vast-parallel-bench.ts --keep --json
 *
 * Options:
 *   --parallel <n>         Machines to deploy in parallel (default 3)
 *   --model <tag>          Ollama model to pull and test (default qwen2.5:0.5b)
 *   --max-wait <sec>       Boot timeout per machine (default 900)
 *   --min-inet-down <mbps> Min download bandwidth (default 500)
 *   --min-reliability <n>  Min host reliability2 score (default 0.97)
 *   --max-price <usd/hr>   Max hourly price (default 0.50)
 *   --gpu-types <list>     Comma-separated GPU names (default any)
 *   --keep                 Don't terminate instances after bench
 *   --quiet                Less verbose output
 *   --json                 Print JSON summary to stdout
 *
 * Env: VAST_API_KEY (from .env)
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const VAST_API_BASE = 'https://console.vast.ai/api/v0';

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function bool(name: string): boolean { return args.includes(`--${name}`); }

const PARALLEL    = parseInt(flag('parallel') ?? '3', 10);
const MODEL       = flag('model') ?? 'qwen2.5:0.5b';
const MAX_WAIT_S  = parseInt(flag('max-wait') ?? '900', 10);
const MIN_INET    = parseInt(flag('min-inet-down') ?? '500', 10);
const MIN_REL     = parseFloat(flag('min-reliability') ?? '0.97');
const MAX_PRICE   = parseFloat(flag('max-price') ?? '0.50');
const GPU_TYPES   = flag('gpu-types')?.split(',').map(s => s.trim()).filter(Boolean);
const KEEP        = bool('keep');
const QUIET       = bool('quiet');
const JSON_OUT    = bool('json');
const OLLAMA_PORT = 11434;

const VAST_KEY = process.env.VAST_API_KEY;
if (!VAST_KEY) { console.error('ERROR: VAST_API_KEY not set'); process.exit(1); }

const headers = { Authorization: `Bearer ${VAST_KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const now = () => Date.now();
const fmtS = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// ── SSH key setup ─────────────────────────────────────────────────────────────
// Use ~/.ssh/id_ed25519 — already registered on the Vast.ai account.
// Don't inject ssh_key into deploy body: that would override account authorized_keys.

import { homedir } from 'node:os';

const sshPrivKeyPath = join(homedir(), '.ssh', 'id_ed25519');

async function setupSshKey(): Promise<void> {
  try {
    await Bun.file(sshPrivKeyPath).text();
    console.error(`[ssh] using registered key: ${sshPrivKeyPath}`);
  } catch {
    console.error(`[ssh] WARNING: ${sshPrivKeyPath} not found — SSH tunnel will likely fail`);
  }
}

async function cleanupSshKey(): Promise<void> { /* no temp key to clean up */ }

// ── Cleanup registry ──────────────────────────────────────────────────────────

const instances: number[] = [];
const tunnels: ReturnType<typeof spawn>[] = [];
let cleanupDone = false;

async function terminateAll() {
  if (cleanupDone) return;
  cleanupDone = true;
  // Kill SSH tunnels
  for (const t of tunnels) { try { t.kill(); } catch {} }
  if (instances.length === 0) return;
  console.error(`\n[cleanup] terminating ${instances.length} instance(s)...`);
  await Promise.allSettled(instances.map(async id => {
    try {
      const r = await fetch(`${VAST_API_BASE}/instances/${id}/`, { method: 'DELETE', headers });
      console.error(`[cleanup] instance ${id} → HTTP ${r.status}`);
    } catch (e) { console.error(`[cleanup] instance ${id} error:`, e); }
  }));
  await cleanupSshKey();
}

process.on('SIGINT', async () => { await terminateAll(); process.exit(130); });
process.on('SIGTERM', async () => { await terminateAll(); process.exit(143); });

// ── Offer search ──────────────────────────────────────────────────────────────

interface Offer {
  id: number;
  gpu: string;
  pricePerHr: number;
  geo: string;
  inetDown: number;
  inetUp: number;
  reliability: number;
  diskGb: number;
}

async function searchOffers(needed: number): Promise<Offer[]> {
  const searchBody: Record<string, unknown> = {
    rentable: { eq: true },
    rented: { eq: false },
    num_gpus: { eq: 1 },
    disk_space: { gte: 20 },
    direct_port_count: { gte: 1 },
    reliability2: { gte: MIN_REL },
    inet_down: { gte: MIN_INET },
    inet_up: { gte: 100 },
    cuda_vers: { gte: 12.0 },
    dph_total: { lte: MAX_PRICE },
    type: 'on-demand',
    order: [['dph_total', 'asc']],
    limit: needed * 4,
  };
  if (GPU_TYPES?.length) searchBody.gpu_name = { in: GPU_TYPES };

  if (!QUIET) console.error(`[search] querying Vast.ai (parallel=${needed}, min_inet=${MIN_INET}Mbps, min_rel=${MIN_REL}, max_price=$${MAX_PRICE}/hr)...`);
  const res = await fetch(`${VAST_API_BASE}/bundles/`, { method: 'POST', headers, body: JSON.stringify(searchBody) });
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { offers?: Array<Record<string, unknown>> };
  const raw = data.offers ?? [];

  const filtered = raw.filter(o => {
    const down = Number(o.inet_down ?? 0);
    const up = Number(o.inet_up ?? 0);
    const rel = Number(o.reliability2 ?? 0);
    return down >= MIN_INET && up >= 100 && rel >= MIN_REL;
  });

  if (filtered.length < needed) {
    console.error(`[search] WARNING: only ${filtered.length} offers pass filters (need ${needed})`);
  }

  return filtered.slice(0, needed * 2).map(o => ({
    id: Number(o.id),
    gpu: String(o.gpu_name ?? '?'),
    pricePerHr: Number(o.dph_total ?? 0),
    geo: String(o.geolocation ?? '?'),
    inetDown: Number(o.inet_down ?? 0),
    inetUp: Number(o.inet_up ?? 0),
    reliability: Number(o.reliability2 ?? 0),
    diskGb: Number(o.disk_space ?? 0),
  }));
}

// ── Deploy ────────────────────────────────────────────────────────────────────

async function deployOffer(offer: Offer): Promise<number> {
  // ssh_direct: Vast writes our onstart field to /root/onstart.sh and runs it
  // via `bash /root/onstart.sh`. Must be valid bash script, NOT one-liner with
  // `& &&` (that's a syntax error). Use newlines between commands.
  const onstart = [
    '#!/bin/bash',
    'ollama serve > /var/log/ollama.log 2>&1 &',
    'sleep 5',
    `ollama pull ${MODEL} >> /var/log/ollama.log 2>&1`,
  ].join('\n');

  const body: Record<string, unknown> = {
    client_id: 'me',
    image: 'ollama/ollama:latest',
    disk: 25,
    runtype: 'ssh_direct',
    onstart,
    env: {
      TZ: 'UTC',
      OLLAMA_HOST: `0.0.0.0:${OLLAMA_PORT}`,
      OLLAMA_MODELS: '/root/.ollama/models',
      [`-p ${OLLAMA_PORT}:${OLLAMA_PORT}`]: '1',
    },
    label: `vast-bench-${Date.now().toString(36)}`,
    // No ssh_key field — instance inherits all account registered keys
  };

  const res = await fetch(`${VAST_API_BASE}/asks/${offer.id}/`, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Deploy offer ${offer.id} failed: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { success?: boolean; new_contract?: number };
  if (!data.success || !data.new_contract) throw new Error(`Deploy: ${JSON.stringify(data)}`);
  return data.new_contract;
}

// ── Instance polling ──────────────────────────────────────────────────────────

interface InstState {
  status: string;
  ip: string;
  directPort: number;
  sshHost: string;
  sshPort: number;
}

async function getInstance(id: number): Promise<InstState | null> {
  try {
    const res = await fetch(`${VAST_API_BASE}/instances/${id}/`, { headers });
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, unknown>;
    // Vast single-instance endpoint returns { instances: {...} } (object, not array)
    const rawInst = (raw as any).instances;
    const inst = (Array.isArray(rawInst) ? rawInst[0] : rawInst) as Record<string, unknown>;
    if (!inst) return null;

    const status = String(inst.actual_status ?? inst.cur_state ?? '?');
    const ip = String(inst.public_ipaddr ?? '');
    const dpStart = Number(inst.direct_port_start ?? -1);
    const sshHost = String(inst.ssh_host ?? ip);
    const sshPort = Number(inst.ssh_port ?? 0);

    return { status, ip, directPort: dpStart, sshHost, sshPort };
  } catch { return null; }
}

// ── SSH tunnel ────────────────────────────────────────────────────────────────

interface Tunnel {
  localPort: number;
  proc: ReturnType<typeof spawn>;
  endpoint: string;
}

async function openSshTunnel(sshHost: string, sshPort: number, localPort: number, tag: string): Promise<Tunnel | null> {
  if (!sshPrivKeyPath || !sshHost || !sshPort) return null;
  return new Promise(resolve => {
    const proc = spawn('ssh', [
      '-N',                            // no remote command, just forward
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-i', sshPrivKeyPath,
      '-L', `${localPort}:localhost:${OLLAMA_PORT}`,
      '-p', String(sshPort),
      `root@${sshHost}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    tunnels.push(proc);

    let resolved = false;
    const endpoint = `http://localhost:${localPort}`;

    // Strategy: if SSH proc is still alive after 5s, authentication succeeded
    // and the local port forward is listening. Channel failures ("open failed:
    // connect failed") just mean ollama isn't serving yet — that's fine, we'll
    // poll ollama in Phase 2.
    const authTimeout = setTimeout(async () => {
      // Check if proc is still running (not killed due to auth failure)
      if (proc.exitCode !== null) {
        // Process already exited → auth failed or connection refused
        if (!resolved) { resolved = true; resolve(null); }
        return;
      }
      // Process still alive → SSH tunnel is up, port forward listening
      if (!resolved) {
        resolved = true;
        console.error(`${tag} SSH tunnel established → ${endpoint}`);
        resolve({ localPort, proc, endpoint });
      }
    }, 5_000);

    proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      // Log only non-spam lines
      if (!msg.includes('channel') && !msg.includes('setsockopt') && msg.length > 0) {
        console.error(`${tag} ssh: ${msg}`);
      }
    });

    proc.on('error', () => {
      if (!resolved) { resolved = true; clearTimeout(authTimeout); resolve(null); }
    });

    proc.on('exit', (code) => {
      if (!resolved) { resolved = true; clearTimeout(authTimeout); resolve(null); }
    });
  });
}

// ── Health + inference probes ─────────────────────────────────────────────────

async function probeOllamaReady(endpoint: string): Promise<{ ok: boolean; err?: string }> {
  try {
    const res = await fetch(`${endpoint}/`, { signal: AbortSignal.timeout(5_000) });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 100) };
  }
}

async function probeModelLoaded(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const modelBase = MODEL.split(':')[0];
    return (data.models ?? []).some(m => (m.name ?? '').startsWith(modelBase));
  } catch { return false; }
}

async function runInference(endpoint: string): Promise<{ ok: boolean; latencyMs: number; response?: string }> {
  const t = now();
  try {
    const res = await fetch(`${endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: 'Say "ok" in one word.', stream: false }),
      signal: AbortSignal.timeout(60_000),
    });
    const latencyMs = now() - t;
    if (!res.ok) return { ok: false, latencyMs };
    const data = (await res.json()) as { response?: string };
    return { ok: true, latencyMs, response: (data.response ?? '').trim().slice(0, 80) };
  } catch (e) {
    return { ok: false, latencyMs: now() - t };
  }
}

// ── Per-machine bench ─────────────────────────────────────────────────────────

interface BenchResult {
  offerId: number;
  instanceId?: number;
  gpu: string;
  pricePerHr: number;
  geo: string;
  inetDown: number;
  t0: number;
  t1Ms?: number;
  t2Ms?: number;
  t3Ms?: number;
  inferenceLatencyMs?: number;
  inferenceResponse?: string;
  sshHost?: string;
  sshPort?: number;
  error?: string;
  phase: 'search' | 'deploy' | 'running' | 'tunnel' | 'ready' | 'inference' | 'done' | 'failed';
}

// Global port counter for SSH tunnels (one per machine, avoid collisions)
let nextLocalPort = 21000;
function allocPort(): number { return nextLocalPort++; }

async function benchMachine(offer: Offer, idx: number): Promise<BenchResult> {
  const tag = `[m${idx + 1}]`;
  const result: BenchResult = {
    offerId: offer.id,
    gpu: offer.gpu,
    pricePerHr: offer.pricePerHr,
    geo: offer.geo,
    inetDown: offer.inetDown,
    t0: now(),
    phase: 'deploy',
  };

  // Deploy (retry up to 3x on stale-offer 400)
  let instanceId = 0;
  let usedOffer = offer;
  const triedIds = new Set<number>();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      triedIds.add(usedOffer.id);
      try {
        instanceId = await deployOffer(usedOffer);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('400') || msg.includes('no_such_ask') || msg.includes('not available')) {
          console.error(`${tag} offer ${usedOffer.id} stale, re-searching... (attempt ${attempt + 1})`);
          const fresh = (await searchOffers(PARALLEL + 4)).filter(o => !triedIds.has(o.id));
          if (fresh.length === 0) throw new Error('No fresh offers after retry');
          usedOffer = fresh[0];
        } else {
          throw e;
        }
      }
    }
    if (!instanceId) throw new Error('deploy failed after 3 attempts');
    result.offerId = usedOffer.id;
    result.gpu = usedOffer.gpu;
    result.pricePerHr = usedOffer.pricePerHr;
    result.geo = usedOffer.geo;
    result.instanceId = instanceId;
    instances.push(instanceId);
    console.error(`${tag} deployed instance ${instanceId} (${usedOffer.gpu} @ $${usedOffer.pricePerHr.toFixed(3)}/hr, ${usedOffer.geo})`);
  } catch (e) {
    result.error = `deploy: ${e instanceof Error ? e.message : e}`;
    result.phase = 'failed';
    return result;
  }

  const deadline = result.t0 + MAX_WAIT_S * 1000;
  const TERMINAL = new Set(['exited', 'failed', 'destroyed', 'error', 'deleted', 'stopped']);

  // Phase 1: wait for actual_status='running' + SSH host info
  result.phase = 'running';
  let lastStatus = '';
  let sshHost = '';
  let sshPort = 0;

  while (now() < deadline) {
    await sleep(8_000);
    const inst = await getInstance(instanceId);
    if (!inst) continue;

    if (inst.status !== lastStatus) {
      console.error(`${tag} status: ${lastStatus || '?'} → ${inst.status} (${fmtS(now() - result.t0)})`);
      lastStatus = inst.status;
    }
    if (TERMINAL.has(inst.status)) {
      result.error = `instance exited: ${inst.status}`;
      result.phase = 'failed';
      return result;
    }
    if (inst.sshHost) { sshHost = inst.sshHost; result.sshHost = inst.sshHost; }
    if (inst.sshPort > 0) { sshPort = inst.sshPort; result.sshPort = inst.sshPort; }

    if (inst.status === 'running') {
      result.t1Ms = now() - result.t0;
      console.error(`${tag} T1 running: ${fmtS(result.t1Ms)} | ssh=${sshHost}:${sshPort || '?'}`);
      break;
    }
  }

  if (!result.t1Ms) {
    result.error = `timeout waiting for running (${MAX_WAIT_S}s)`;
    result.phase = 'failed';
    return result;
  }

  // Phase 2: open SSH tunnel then wait for ollama + model
  result.phase = 'tunnel';
  if (!sshHost || !sshPort) {
    // Poll a bit more for SSH info
    for (let i = 0; i < 5 && (!sshHost || !sshPort); i++) {
      await sleep(5_000);
      const inst = await getInstance(instanceId);
      if (inst?.sshHost) { sshHost = inst.sshHost; result.sshHost = inst.sshHost; }
      if (inst?.sshPort && inst.sshPort > 0) { sshPort = inst.sshPort; result.sshPort = inst.sshPort; }
    }
  }

  if (!sshHost || !sshPort) {
    result.error = 'no SSH host/port after T1 — cannot tunnel';
    result.phase = 'failed';
    return result;
  }

  const localPort = allocPort();
  console.error(`${tag} opening SSH tunnel :${localPort} → ${sshHost}:${sshPort} → localhost:${OLLAMA_PORT}`);
  // SSH proxy may take 30-60s to register after container running — retry
  let tunnel: Awaited<ReturnType<typeof openSshTunnel>> = null;
  let prevProc: ReturnType<typeof spawn> | null = null;
  for (let attempt = 0; attempt < 6 && now() < deadline; attempt++) {
    if (attempt > 0) {
      // Kill previous SSH proc before retry to free the local port
      try { prevProc?.kill(); } catch {}
      await sleep(2_000);  // give OS time to release port
      console.error(`${tag} SSH tunnel attempt ${attempt + 1}/6, waiting 12s...`);
      await sleep(12_000);
    }
    const result_tunnel = await openSshTunnel(sshHost, sshPort, localPort, tag);
    if (result_tunnel) { tunnel = result_tunnel; break; }
    // openSshTunnel returns null — save proc reference so we can kill it
    prevProc = tunnels[tunnels.length - 1] ?? null;
  }
  if (!tunnel) {
    result.error = `SSH tunnel failed after 6 attempts to ${sshHost}:${sshPort}`;
    result.phase = 'failed';
    return result;
  }
  const endpoint = tunnel.endpoint;
  console.error(`${tag} SSH tunnel up → ${endpoint}`);

  // Phase 2b: wait for ollama + model via tunnel
  result.phase = 'ready';
  while (now() < deadline) {
    await sleep(8_000);
    const probe = await probeOllamaReady(endpoint);
    if (!probe.ok) {
      if (!QUIET) console.error(`${tag} ollama not ready: ${probe.err ?? 'http error'} (${fmtS(now() - result.t0)})`);
      continue;
    }
    const modelReady = await probeModelLoaded(endpoint);
    if (modelReady) {
      result.t2Ms = now() - result.t0;
      console.error(`${tag} T2 model ready: ${fmtS(result.t2Ms)}`);
      break;
    }
    console.error(`${tag} ollama up, pulling ${MODEL}... (${fmtS(now() - result.t0)})`);
  }

  if (!result.t2Ms) {
    result.error = `timeout waiting for model ${MODEL} (${MAX_WAIT_S}s)`;
    result.phase = 'failed';
    tunnel.proc.kill();
    return result;
  }

  // Phase 3: first inference
  result.phase = 'inference';
  const inf = await runInference(endpoint);
  result.t3Ms = now() - result.t0;
  result.inferenceLatencyMs = inf.latencyMs;
  result.inferenceResponse = inf.response;
  tunnel.proc.kill();

  if (!inf.ok) {
    result.error = `inference failed (${fmtS(inf.latencyMs)})`;
    result.phase = 'failed';
    return result;
  }

  console.error(`${tag} T3 inference OK: ${fmtS(result.t3Ms)} | latency=${fmtS(inf.latencyMs)} | response="${inf.response}"`);
  result.phase = 'done';
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function pct(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
}

async function main() {
  console.error(`\n=== Vast.ai Parallel Deploy Bench ===`);
  console.error(`  machines: ${PARALLEL} | model: ${MODEL} | max_wait: ${MAX_WAIT_S}s`);
  console.error(`  filters: reliability>=${MIN_REL} | inet_down>=${MIN_INET}Mbps | price<=$${MAX_PRICE}/hr\n`);

  await setupSshKey();

  const offers = await searchOffers(PARALLEL);
  if (offers.length === 0) {
    console.error('ERROR: no offers found matching filters');
    await terminateAll();
    process.exit(1);
  }
  const chosen = offers.slice(0, PARALLEL);
  console.error(`[search] found ${offers.length} candidates, using cheapest ${chosen.length}:`);
  for (const [i, o] of chosen.entries()) {
    console.error(`  [m${i + 1}] ${o.gpu.padEnd(28)} $${o.pricePerHr.toFixed(3)}/hr  ${o.inetDown.toFixed(0).padStart(5)}Mbps↓  rel=${o.reliability.toFixed(3)}  ${o.geo}`);
  }
  console.error('');

  console.error(`[bench] deploying ${chosen.length} machines in parallel...`);
  const t0Global = now();
  const results = await Promise.all(chosen.map((offer, idx) => benchMachine(offer, idx)));

  if (!KEEP) await terminateAll();
  else await cleanupSshKey();

  // ── Report ───────────────────────────────────────────────────────────────────

  const ok = results.filter(r => r.phase === 'done');
  const failed = results.filter(r => r.phase === 'failed');

  console.error('\n╔══════════════════════════════════════════════════════════════════╗');
  console.error(`║  RESULTS: ${ok.length}/${results.length} machines successful                                  ║`);
  console.error('╚══════════════════════════════════════════════════════════════════╝');
  console.error('');
  console.error('Machine breakdown:');
  console.error(`${'#'.padEnd(3)} ${'GPU'.padEnd(26)} ${'Price'.padEnd(10)} ${'T1-run'.padEnd(8)} ${'T2-ready'.padEnd(10)} ${'T3-infer'.padEnd(10)} ${'Inf.lat'.padEnd(8)} Status`);
  console.error('─'.repeat(90));

  for (const [i, r] of results.entries()) {
    const row = [
      String(i + 1).padEnd(3),
      r.gpu.slice(0, 26).padEnd(26),
      `$${r.pricePerHr.toFixed(3)}/hr`.padEnd(10),
      (r.t1Ms != null ? fmtS(r.t1Ms) : '-').padEnd(8),
      (r.t2Ms != null ? fmtS(r.t2Ms) : '-').padEnd(10),
      (r.t3Ms != null ? fmtS(r.t3Ms) : '-').padEnd(10),
      (r.inferenceLatencyMs != null ? fmtS(r.inferenceLatencyMs) : '-').padEnd(8),
      r.phase === 'done' ? '✓ ok' : `✗ ${r.error ?? r.phase}`,
    ].join(' ');
    console.error(row);
  }

  if (ok.length > 0) {
    console.error('');
    console.error('Aggregate (successful machines):');

    const t1s = ok.map(r => r.t1Ms!);
    const t2s = ok.filter(r => r.t2Ms != null).map(r => r.t2Ms!);
    const t3s = ok.filter(r => r.t3Ms != null).map(r => r.t3Ms!);
    const lats = ok.filter(r => r.inferenceLatencyMs != null).map(r => r.inferenceLatencyMs!);

    const fmt = (arr: number[], label: string) =>
      `  ${label.padEnd(14)} p50=${fmtS(pct(arr, 50))}  p95=${fmtS(pct(arr, 95))}  min=${fmtS(Math.min(...arr))}  max=${fmtS(Math.max(...arr))}`;

    console.error(fmt(t1s, 'T1 running'));
    if (t2s.length > 0) console.error(fmt(t2s, 'T2 model-ready'));
    if (t3s.length > 0) console.error(fmt(t3s, 'T3 inference'));
    if (lats.length > 0) console.error(fmt(lats, 'Inf latency'));
    console.error(`  total wall      ${fmtS(now() - t0Global)}`);
    console.error(`  success rate    ${ok.length}/${results.length} (${Math.round(ok.length / results.length * 100)}%)`);
    console.error(`  avg price       $${(ok.reduce((s, r) => s + r.pricePerHr, 0) / ok.length).toFixed(3)}/hr`);
  }

  if (failed.length > 0) {
    console.error('\nFailures:');
    for (const r of failed) {
      console.error(`  instance ${r.instanceId ?? r.offerId}: ${r.error}`);
    }
  }

  if (JSON_OUT) {
    const summary = {
      parallel: PARALLEL,
      model: MODEL,
      success: ok.length,
      total: results.length,
      results: results.map(r => ({
        gpu: r.gpu, pricePerHr: r.pricePerHr, geo: r.geo, inetDown: r.inetDown,
        t1Ms: r.t1Ms, t2Ms: r.t2Ms, t3Ms: r.t3Ms,
        inferenceLatencyMs: r.inferenceLatencyMs, inferenceResponse: r.inferenceResponse,
        sshHost: r.sshHost, sshPort: r.sshPort,
        phase: r.phase, error: r.error,
      })),
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  }

  process.exit(ok.length > 0 ? 0 : 1);
}

main().catch(e => {
  console.error('Fatal:', e);
  terminateAll().finally(() => process.exit(1));
});
