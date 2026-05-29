#!/usr/bin/env bun
/**
 * Vast.ai Parallel Deploy Benchmark
 *
 * Deploys N cheap machines in parallel, boots ollama + qwen2.5:0.5b,
 * verifies inference works, and reports timing per machine + aggregate.
 *
 * Phases measured from t0 = deploy POST sent:
 *   T1  actual_status='running'   (image pulled, container up)
 *   T2  GET /health 200 + model listed in /api/tags  (ollama ready + model loaded)
 *   T3  First POST /api/generate OK  (real inference round-trip)
 *
 * Usage:
 *   bun scripts/vast-parallel-bench.ts
 *   bun scripts/vast-parallel-bench.ts --parallel 5 --model qwen2.5:0.5b
 *   bun scripts/vast-parallel-bench.ts --keep --quiet
 *
 * Options:
 *   --parallel <n>         Number of machines to deploy in parallel (default 3)
 *   --model <tag>          Ollama model to pull and test (default qwen2.5:0.5b)
 *   --max-wait <sec>       Boot timeout per machine (default 900)
 *   --min-inet-down <mbps> Min download bandwidth filter (default 500)
 *   --min-reliability <n>  Min host reliability2 score (default 0.97)
 *   --max-price <usd/hr>   Max hourly price per machine (default 0.50)
 *   --gpu-types <list>     Comma-separated GPU names (default any)
 *   --keep                 Don't terminate instances after bench
 *   --quiet                Less verbose output
 *   --json                 Print JSON summary at end
 *
 * Env: VAST_API_KEY (loaded from .env)
 */

import 'dotenv/config';

const VAST_API_BASE = 'https://console.vast.ai/api/v0';

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function bool(name: string): boolean { return args.includes(`--${name}`); }

const PARALLEL     = parseInt(flag('parallel') ?? '3', 10);
const MODEL        = flag('model') ?? 'qwen2.5:0.5b';
const MAX_WAIT_S   = parseInt(flag('max-wait') ?? '900', 10);
const MIN_INET     = parseInt(flag('min-inet-down') ?? '500', 10);
const MIN_REL      = parseFloat(flag('min-reliability') ?? '0.97');
const MAX_PRICE    = parseFloat(flag('max-price') ?? '0.50');
const GPU_TYPES    = flag('gpu-types')?.split(',').map(s => s.trim()).filter(Boolean);
const KEEP         = bool('keep');
const QUIET        = bool('quiet');
const JSON_OUT     = bool('json');
const OLLAMA_PORT  = 11434;

const VAST_KEY = process.env.VAST_API_KEY;
if (!VAST_KEY) { console.error('ERROR: VAST_API_KEY not set'); process.exit(1); }

const headers = { Authorization: `Bearer ${VAST_KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const now = () => Date.now();
const fmtS = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// ── Cleanup registry ──────────────────────────────────────────────────────────

const instances: number[] = [];
let cleanupDone = false;

async function terminateAll() {
  if (cleanupDone) return;
  cleanupDone = true;
  if (instances.length === 0) return;
  console.error(`\n[cleanup] terminating ${instances.length} instance(s)...`);
  await Promise.allSettled(instances.map(async id => {
    try {
      const r = await fetch(`${VAST_API_BASE}/instances/${id}/`, { method: 'DELETE', headers });
      console.error(`[cleanup] instance ${id} → HTTP ${r.status}`);
    } catch (e) { console.error(`[cleanup] instance ${id} error:`, e); }
  }));
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
  if (GPU_TYPES?.length) {
    searchBody.gpu_name = { in: GPU_TYPES };
  }

  if (!QUIET) console.error(`[search] querying Vast.ai (parallel=${needed}, min_inet=${MIN_INET}Mbps, min_rel=${MIN_REL}, max_price=$${MAX_PRICE}/hr)...`);
  const res = await fetch(`${VAST_API_BASE}/bundles/`, { method: 'POST', headers, body: JSON.stringify(searchBody) });
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { offers?: Array<Record<string, unknown>> };
  const raw = data.offers ?? [];

  // Client-side filter: remove offers with missing/low bandwidth
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
  // ssh_direct: Vast injects SSH server (overrides image entrypoint).
  // onstart runs after SSH up — start ollama serve then pull model.
  const onstart = [
    'nohup ollama serve > /var/log/ollama.log 2>&1 &',
    'sleep 5',
    `ollama pull ${MODEL} >> /var/log/ollama.log 2>&1`,
  ].join(' && ');

  const body = {
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
    label: `vast-parallel-bench-${Date.now().toString(36)}`,
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
  endpoint: string;
  directPort: number;
  sshHost: string;
  sshPort: number;
}

async function getInstance(id: number): Promise<InstState | null> {
  try {
    const res = await fetch(`${VAST_API_BASE}/instances/${id}/`, { headers });
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, unknown>;
    // Vast returns either { instances: [...] } or the object directly
    // Vast.ai single-instance endpoint returns { instances: {...} } (object) for
    // active instances, or { instances: [...] } (array) in some edge cases.
    const rawInst = (raw as any).instances;
    const inst = (Array.isArray(rawInst) ? rawInst[0] : rawInst) as Record<string, unknown>;
    if (!inst) return null;

    const status = String(inst.actual_status ?? inst.cur_state ?? '?');
    const ip = String(inst.public_ipaddr ?? '');
    let endpoint = '';
    let directPort = 0;

    const ports = inst.ports as Record<string, unknown> | undefined;
    const dpStart = Number(inst.direct_port_start ?? -1);

    if (ports && dpStart > 0) {
      const key = `${OLLAMA_PORT}/tcp`;
      const mapping = (ports[key] ?? ports[String(OLLAMA_PORT)]) as Array<{ HostPort?: string; HostIp?: string }> | undefined;
      const entry = mapping?.find(e => Number(e.HostPort) > 0);
      if (entry?.HostPort) {
        const hostIp = entry.HostIp && !['0.0.0.0', '172.', '10.'].some(p => (entry.HostIp ?? '').startsWith(p)) ? entry.HostIp : ip;
        endpoint = `http://${hostIp}:${entry.HostPort}`;
        directPort = Number(entry.HostPort);
      }
    }
    if (!endpoint && ip && dpStart > 0) {
      endpoint = `http://${ip}:${dpStart + OLLAMA_PORT - 11434}`;
      directPort = dpStart;
    }

    // Cloudflare tunnel fallback (SSH-only hosts or pre-port-assignment)
    if (!endpoint) {
      const webpage = String(inst.webpage ?? '').trim();
      if (webpage.startsWith('https://') && webpage.includes('.trycloudflare.com')) {
        endpoint = webpage;
      }
    }

    const sshHost = String(inst.ssh_host ?? ip);
    const sshPort = Number(inst.ssh_port ?? 0);

    return { status, ip, endpoint, directPort, sshHost, sshPort };
  } catch { return null; }
}

// ── Health + inference probes ─────────────────────────────────────────────────

async function probeOllamaReady(endpoint: string): Promise<{ ok: boolean; err?: string }> {
  try {
    const res = await fetch(`${endpoint}/`, { signal: AbortSignal.timeout(8_000) });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 80) };
  }
}

async function probeModelLoaded(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(4_000) });
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
      signal: AbortSignal.timeout(30_000),
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
  t1Ms?: number;  // running
  t2Ms?: number;  // ollama ready + model loaded
  t3Ms?: number;  // first inference OK
  inferenceLatencyMs?: number;
  inferenceResponse?: string;
  endpoint?: string;
  directPort?: number;
  sshHost?: string;
  sshPort?: number;
  error?: string;
  phase: 'search' | 'deploy' | 'running' | 'ready' | 'inference' | 'done' | 'failed';
}

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

  // Deploy (retry up to 3x with fresh offers on stale-offer 400)
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
          if (fresh.length === 0) throw new Error('No fresh offers available after retry');
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

  // Phase 1: wait for actual_status='running'
  result.phase = 'running';
  let lastStatus = '';
  let endpoint = '';

  while (now() < deadline) {
    await sleep(8_000);
    const inst = await getInstance(instanceId);
    if (!inst) continue;

    if (inst.status !== lastStatus) {
      console.error(`${tag} status: ${lastStatus || '?'} → ${inst.status} (${fmtS(now() - result.t0)})`);
      lastStatus = inst.status;
    }

    if (TERMINAL.has(inst.status)) {
      result.error = `instance exited with status=${inst.status}`;
      result.phase = 'failed';
      return result;
    }

    if (inst.endpoint) endpoint = inst.endpoint;
    if (inst.directPort > 0) result.directPort = inst.directPort;
    if (inst.sshHost) result.sshHost = inst.sshHost;
    if (inst.sshPort > 0) result.sshPort = inst.sshPort;

    if (inst.status === 'running') {
      result.t1Ms = now() - result.t0;
      console.error(`${tag} T1 running: ${fmtS(result.t1Ms)} | endpoint=${endpoint || 'none'} | ssh=${inst.sshHost}:${inst.sshPort || '?'}`);
      result.endpoint = endpoint;
      break;
    }
  }

  if (!result.t1Ms) {
    result.error = `timeout waiting for running (${MAX_WAIT_S}s)`;
    result.phase = 'failed';
    return result;
  }

  // Phase 2: wait for ollama ready + model loaded
  // SSH-only hosts (direct_port=-1, no Cloudflare tunnel) can't be probed from
  // outside without an SSH tunnel. Report T1 as partial success and skip T2/T3.
  const endpointDeadline = result.t0 + Math.min(MAX_WAIT_S, 90) * 1000;
  while (!endpoint && now() < endpointDeadline) {
    await sleep(8_000);
    const fresh = await getInstance(instanceId);
    if (fresh?.endpoint) {
      endpoint = fresh.endpoint;
      result.endpoint = endpoint;
      console.error(`${tag} endpoint resolved: ${endpoint}`);
    }
  }
  if (!endpoint) {
    console.error(`${tag} SSH-only host (no direct port / no Cloudflare tunnel) — T1 only`);
    result.phase = 'done';  // partial success: T1 measured
    return result;
  }

  result.phase = 'ready';
  let endpointFailCount = 0;
  while (now() < deadline) {
    await sleep(10_000);
    const probe = await probeOllamaReady(endpoint);
    if (!probe.ok) {
      endpointFailCount++;
      console.error(`${tag} ollama not ready: ${probe.err ?? 'HTTP error'} @ ${endpoint} (${fmtS(now() - result.t0)})`);
      // After 4 consecutive failures: endpoint not accessible from client (SSH-proxied port).
      // SSH-proxied ports require SSH tunnel — report T1-only and move on.
      if (endpointFailCount >= 4) {
        console.error(`${tag} endpoint ${endpoint} unreachable after ${endpointFailCount} tries — SSH-proxied port, T1 only`);
        result.phase = 'done';
        return result;
      }
      continue;
    }
    const modelReady = await probeModelLoaded(endpoint);
    if (modelReady) {
      result.t2Ms = now() - result.t0;
      if (!QUIET) console.error(`${tag} T2 model ready: ${fmtS(result.t2Ms)}`);
      break;
    }
    if (!QUIET) console.error(`${tag} ollama up, waiting for ${MODEL} pull... (${fmtS(now() - result.t0)})`);
  }

  if (!result.t2Ms) {
    result.error = !endpoint
      ? `no direct endpoint after ${MAX_WAIT_S}s (SSH-only host, no Cloudflare tunnel)`
      : `timeout waiting for model ${MODEL} (${MAX_WAIT_S}s)`;
    result.phase = 'failed';
    return result;
  }

  // Phase 3: first inference
  result.phase = 'inference';
  const inf = await runInference(endpoint);
  result.t3Ms = now() - result.t0;
  result.inferenceLatencyMs = inf.latencyMs;
  result.inferenceResponse = inf.response;

  if (!inf.ok) {
    result.error = `inference failed (${fmtS(inf.latencyMs)})`;
    result.phase = 'failed';
    return result;
  }

  if (!QUIET) console.error(`${tag} T3 inference OK: ${fmtS(result.t3Ms)} | latency=${fmtS(inf.latencyMs)} | response="${inf.response}"`);
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

  // Search
  const offers = await searchOffers(PARALLEL);
  if (offers.length === 0) {
    console.error('ERROR: no offers found matching filters');
    process.exit(1);
  }
  const chosen = offers.slice(0, PARALLEL);
  console.error(`[search] found ${offers.length} candidates, using cheapest ${chosen.length}:`);
  for (const [i, o] of chosen.entries()) {
    console.error(`  [m${i + 1}] ${o.gpu.padEnd(28)} $${o.pricePerHr.toFixed(3)}/hr  ${o.inetDown.toFixed(0).padStart(5)}Mbps↓  rel=${o.reliability.toFixed(3)}  ${o.geo}`);
  }
  console.error('');

  // Deploy all in parallel
  console.error(`[bench] deploying ${chosen.length} machines in parallel...`);
  const t0Global = now();
  const results = await Promise.all(chosen.map((offer, idx) => benchMachine(offer, idx)));

  // Terminate
  if (!KEEP) await terminateAll();

  // ── Report ──────────────────────────────────────────────────────────────────

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
      r.phase === 'done'
        ? (r.t2Ms != null ? '✓ full' : `✓ T1-only ssh=${r.sshHost ?? '?'}:${r.sshPort ?? '?'}`)
        : `✗ ${r.error ?? r.phase}`,
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
      `  ${label.padEnd(12)} p50=${fmtS(pct(arr, 50))}  p95=${fmtS(pct(arr, 95))}  min=${fmtS(Math.min(...arr))}  max=${fmtS(Math.max(...arr))}`;

    console.error(fmt(t1s, 'T1 running'));
    if (t2s.length > 0) console.error(fmt(t2s, 'T2 model-ready'));
    if (t3s.length > 0) console.error(fmt(t3s, 'T3 inference'));
    if (lats.length > 0) console.error(fmt(lats, 'Inf latency'));
    console.error(`  total wall    ${fmtS(now() - t0Global)}`);
    console.error(`  success rate  ${ok.length}/${results.length} (${Math.round(ok.length / results.length * 100)}%)`);
    console.error(`  avg price     $${(ok.reduce((s, r) => s + r.pricePerHr, 0) / ok.length).toFixed(3)}/hr`);
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
        directPort: r.directPort, endpoint: r.endpoint,
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
