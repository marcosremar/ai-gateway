#!/usr/bin/env bun
/**
 * Vast.ai Parallel Deploy Benchmark — SLA-gated, 100%-success design.
 *
 * Deploys N successful machines in parallel. Each "slot" retries against fresh
 * offers until it lands ONE machine that boots, loads the model, and answers an
 * inference round-trip — all within per-stage SLAs. Slow/broken hosts are
 * terminated and replaced (their host_id is blocklisted) so the final reported
 * set is 100% successful with nothing slow.
 *
 * Connectivity: direct port HTTP. A running instance exposes its 11434 mapping
 * in `inst.ports['11434/tcp'][0].HostPort`; we hit http://public_ipaddr:HostPort
 * directly. No SSH proxy (that was the dominant failure mode at scale).
 *
 * Phases measured from t0 = deploy POST of the WINNING attempt:
 *   T1  actual_status='running' + port mapping live   (container up)
 *   T2  ollama /api/tags lists model                  (model loaded)
 *   T3  first POST /api/generate OK                    (real inference)
 *
 * Usage:
 *   bun scripts/vast-parallel-bench.ts --parallel 30
 *   bun scripts/vast-parallel-bench.ts --parallel 30 --max-price 0.30 --json
 *
 * Options:
 *   --parallel <n>         Target successful machines (default 3)
 *   --model <tag>          Ollama model (default qwen2.5:0.5b)
 *   --max-price <usd/hr>   Max hourly price (default 0.30)
 *   --min-inet-down <mbps> Min download bandwidth (default 300)
 *   --min-reliability <n>  Min host reliability2 (default 0.92)
 *   --gpu-types <list>     Comma-separated GPU names (default any)
 *   --boot-sla <sec>       Max time to 'running' (default 120)
 *   --ready-sla <sec>      Max time to model-ready/T2 (default 150)
 *   --infer-sla <sec>      Max inference round-trip (default 20)
 *   --slot-attempts <n>    Max offers tried per slot (default 8)
 *   --keep                 Don't terminate instances after bench
 *   --quiet                Less verbose output
 *   --json                 Print JSON summary to stdout
 *
 * Env: VAST_API_KEY (from .env)
 */

import 'dotenv/config';

const VAST_API_BASE = 'https://console.vast.ai/api/v0';
const LABEL_PREFIX = 'vast-bench-';
const RUN_LABEL = `${LABEL_PREFIX}${Date.now().toString(36)}`;

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function bool(name: string): boolean { return args.includes(`--${name}`); }

const PARALLEL   = parseInt(flag('parallel') ?? '3', 10);
const MODEL      = flag('model') ?? 'qwen2.5:0.5b';
// Docker image to deploy. Default pulls the model at runtime; a pre-baked image
// (e.g. ghcr.io/marcosremar/ollama-qwen05:latest) ships the model in a layer —
// pair with --skip-pull to drop the runtime `ollama pull` from onstart.
const IMAGE      = flag('image') ?? 'ollama/ollama:latest';
const SKIP_PULL  = bool('skip-pull');
const MAX_PRICE  = parseFloat(flag('max-price') ?? '0.30');
const MIN_INET   = parseInt(flag('min-inet-down') ?? '300', 10);
const MIN_REL    = parseFloat(flag('min-reliability') ?? '0.92');
const GPU_TYPES  = flag('gpu-types')?.split(',').map(s => s.trim()).filter(Boolean);
const BOOT_SLA   = parseInt(flag('boot-sla') ?? '120', 10) * 1000;
const READY_SLA  = parseInt(flag('ready-sla') ?? '150', 10) * 1000;
const INFER_SLA  = parseInt(flag('infer-sla') ?? '20', 10) * 1000;
const SLOT_TRIES = parseInt(flag('slot-attempts') ?? '40', 10);
// Per-slot wall-clock budget. A slot retries fresh offers until success OR this
// deadline — a streak of duds no longer ends a slot in failure. 0 = disabled (use
// SLOT_TRIES cap only). Pair with auto-relax refill so the pool never dries.
const SLOT_DEADLINE = parseInt(flag('slot-deadline') ?? '600', 10) * 1000;
// Hedge degree: each slot attempt fires this many offers in parallel and keeps
// the first that reaches T3 within SLA, terminating the rest. Helps at LOW
// parallelism (ample supply per slot) but HURTS at high N: 2x consumption drains
// the finite bootable-host pool and starves the tail slots. Default off; opt in
// only when supply per slot is generous. For high N use --overprovision instead.
const HEDGE = Math.max(1, parseInt(flag('hedge') ?? '1', 10));
// Over-provision: launch ceil(PARALLEL * OVERPROVISION) independent slots but
// stop as soon as PARALLEL of them succeed, cancelling the rest. Unlike hedge,
// each slot consumes 1x supply; the surplus slots are redundancy that absorbs
// unlucky dud streaks without doubling pool drain. The right lever for high N.
const OVERPROVISION = Math.max(1, parseFloat(flag('overprovision') ?? '1'));
// Absolute surplus floor: always launch at least this many slots beyond target,
// regardless of the multiplier. Matters at small targets where 1.3x rounds to
// only +1 — e.g. target 1 needs a real buffer of spare machines to guarantee a
// success. numSlots = max(ceil(target * OVERPROVISION), target + MIN_EXTRA).
const MIN_EXTRA = Math.max(0, parseInt(flag('min-extra') ?? '0', 10));

// Mutable search filters. refillPool() progressively relaxes these when the pool
// starves, so a slot can always find a fresh offer instead of giving up.
let curMaxPrice = MAX_PRICE;
let curMinInet  = MIN_INET;
let curMinRel   = MIN_REL;
const KEEP       = bool('keep');
const QUIET      = bool('quiet');
const JSON_OUT   = bool('json');
const OLLAMA_PORT = 11434;

const VAST_KEY = process.env.VAST_API_KEY;
if (!VAST_KEY) { console.error('ERROR: VAST_API_KEY not set'); process.exit(1); }

const headers = { Authorization: `Bearer ${VAST_KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const now = () => Date.now();
const fmtS = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// ── Cleanup registry ──────────────────────────────────────────────────────────

const liveInstances = new Set<number>();
let cleanupDone = false;

async function terminateInstance(id: number): Promise<void> {
  liveInstances.delete(id);
  try {
    await fetch(`${VAST_API_BASE}/instances/${id}/`, { method: 'DELETE', headers });
  } catch { /* ignore */ }
}

async function terminateAll() {
  if (cleanupDone) return;
  cleanupDone = true;
  const ids = [...liveInstances];
  if (ids.length === 0) return;
  console.error(`\n[cleanup] terminating ${ids.length} instance(s)...`);
  await Promise.allSettled(ids.map(async id => {
    try {
      const r = await fetch(`${VAST_API_BASE}/instances/${id}/`, { method: 'DELETE', headers });
      console.error(`[cleanup] instance ${id} → HTTP ${r.status}`);
    } catch (e) { console.error(`[cleanup] instance ${id} error:`, e); }
  }));
  // Backstop: catch instances created late that never entered liveInstances
  // (high-churn races). Match this run's exact label so concurrent runs survive.
  await sweepByLabel(RUN_LABEL);
}

process.on('SIGINT', async () => { await terminateAll(); process.exit(130); });
process.on('SIGTERM', async () => { await terminateAll(); process.exit(143); });

// Authoritative orphan sweep — queries Vast for any instance whose label starts
// with LABEL_PREFIX and terminates it. Survives kill -9 (no in-memory state needed).
async function sweepByLabel(exact?: string): Promise<number> {
  const res = await fetch(`${VAST_API_BASE}/instances/`, { headers });
  if (!res.ok) { console.error(`[sweep] list failed: HTTP ${res.status}`); return 0; }
  const data = (await res.json()) as { instances?: Array<{ id: number; label?: string; gpu_name?: string; dph_total?: number }> };
  const orphans = (data.instances ?? []).filter(i =>
    typeof i.label === 'string' && (exact ? i.label === exact : i.label.startsWith(LABEL_PREFIX)));
  if (orphans.length === 0) { console.error('[sweep] 0 orphans'); return 0; }
  const burn = orphans.reduce((s, i) => s + (i.dph_total ?? 0), 0);
  console.error(`[sweep] terminating ${orphans.length} orphan(s) ($${burn.toFixed(3)}/hr)...`);
  await Promise.allSettled(orphans.map(async i => {
    for (let t = 0; t < 3; t++) {
      const r = await fetch(`${VAST_API_BASE}/instances/${i.id}/`, { method: 'DELETE', headers });
      console.error(`[sweep] ${i.id} ${i.gpu_name ?? ''} → HTTP ${r.status}`);
      if (r.status === 200) break;
      await sleep(3000);
    }
  }));
  return orphans.length;
}

if (bool('sweep')) {
  sweepByLabel().then(n => { console.error(`[sweep] done (${n} terminated)`); process.exit(0); });
}

// ── Offer pool (shared, dedup by offer id + host id) ───────────────────────────

interface Offer {
  id: number;
  hostId: number;
  gpu: string;
  pricePerHr: number;
  geo: string;
  inetDown: number;
  reliability: number;
}

const offerPool: Offer[] = [];
const usedOfferIds = new Set<number>();
const badHostIds = new Set<number>();
let refilling: Promise<void> | null = null;

async function searchOffers(limit: number): Promise<Offer[]> {
  const searchBody: Record<string, unknown> = {
    rentable: { eq: true },
    rented: { eq: false },
    num_gpus: { eq: 1 },
    disk_space: { gte: 20 },
    direct_port_count: { gte: 1 },
    reliability2: { gte: curMinRel },
    inet_down: { gte: curMinInet },
    inet_up: { gte: 100 },
    cuda_vers: { gte: 12.0 },
    dph_total: { lte: curMaxPrice },
    type: 'on-demand',
    order: [['dph_total', 'asc']],
    limit,
  };
  if (GPU_TYPES?.length) searchBody.gpu_name = { in: GPU_TYPES };

  const res = await fetch(`${VAST_API_BASE}/bundles/`, { method: 'POST', headers, body: JSON.stringify(searchBody) });
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { offers?: Array<Record<string, unknown>> };
  return (data.offers ?? []).map(o => ({
    id: Number(o.id),
    hostId: Number(o.host_id ?? 0),
    gpu: String(o.gpu_name ?? '?'),
    pricePerHr: Number(o.dph_total ?? 0),
    geo: String(o.geolocation ?? '?'),
    inetDown: Number(o.inet_down ?? 0),
    reliability: Number(o.reliability2 ?? 0),
  }));
}

async function refillPool(): Promise<void> {
  // Single-flight: only one refill at a time.
  if (refilling) return refilling;
  refilling = (async () => {
    const fresh = await searchOffers(Math.max(200, PARALLEL * 8));
    let added = 0;
    for (const o of fresh) {
      if (usedOfferIds.has(o.id) || badHostIds.has(o.hostId)) continue;
      if (offerPool.some(p => p.id === o.id)) continue;
      offerPool.push(o);
      added++;
    }
    if (!QUIET) console.error(`[pool] refilled +${added} (pool=${offerPool.length}, used=${usedOfferIds.size}, badHosts=${badHostIds.size})`);
    // Pool starved (no fresh unused offers left at current filters). Widen the
    // search envelope so slots keep finding machines instead of giving up.
    if (added === 0 && offerPool.length === 0 && (curMaxPrice < 3.0 || curMinRel > 0.5 || curMinInet > 50)) {
      curMaxPrice = Math.min(3.0, curMaxPrice * 1.5);
      curMinRel   = Math.max(0.5, curMinRel - 0.05);
      curMinInet  = Math.max(50, curMinInet - 50);
      if (!QUIET) console.error(`[pool] starved → relax filters (price<=$${curMaxPrice.toFixed(2)} rel>=${curMinRel.toFixed(2)} inet>=${curMinInet})`);
    }
  })();
  try { await refilling; } finally { refilling = null; }
}

async function takeOffer(): Promise<Offer | null> {
  for (let round = 0; round < 3; round++) {
    while (offerPool.length > 0) {
      const o = offerPool.shift()!;
      if (usedOfferIds.has(o.id) || badHostIds.has(o.hostId)) continue;
      usedOfferIds.add(o.id);
      return o;
    }
    await refillPool();
    if (offerPool.length === 0) await sleep(3_000);
  }
  return null;
}

// ── Deploy ────────────────────────────────────────────────────────────────────

async function deployOffer(offer: Offer): Promise<number> {
  // ssh_direct: Vast writes our onstart field to /root/onstart.sh and runs it
  // via bash. Must be a valid script (newlines, not `& &&`).
  const onstart = [
    '#!/bin/bash',
    'ollama serve > /var/log/ollama.log 2>&1 &',
    // Pre-baked images already ship the model; skip the runtime pull.
    ...(SKIP_PULL ? [] : ['sleep 5', `ollama pull ${MODEL} >> /var/log/ollama.log 2>&1`]),
  ].join('\n');

  const body: Record<string, unknown> = {
    client_id: 'me',
    image: IMAGE,
    disk: 25,
    runtype: 'ssh_direct',
    onstart,
    env: {
      TZ: 'UTC',
      OLLAMA_HOST: `0.0.0.0:${OLLAMA_PORT}`,
      OLLAMA_MODELS: '/root/.ollama/models',
      [`-p ${OLLAMA_PORT}:${OLLAMA_PORT}`]: '1',
    },
    label: RUN_LABEL,
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
  httpPort: number;   // host-mapped external port for 11434, or 0
}

async function getInstance(id: number): Promise<InstState | null> {
  try {
    const res = await fetch(`${VAST_API_BASE}/instances/${id}/`, { headers });
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, unknown>;
    // Single-instance endpoint returns { instances: {...} } (object, not array).
    const rawInst = (raw as any).instances;
    const inst = (Array.isArray(rawInst) ? rawInst[0] : rawInst) as Record<string, unknown>;
    if (!inst) return null;

    const status = String(inst.actual_status ?? inst.cur_state ?? '?');
    const ip = String(inst.public_ipaddr ?? '');
    let httpPort = 0;
    const ports = inst.ports as Record<string, Array<{ HostPort?: string }>> | undefined;
    const mapping = ports?.[`${OLLAMA_PORT}/tcp`]?.[0];
    if (mapping?.HostPort) httpPort = Number(mapping.HostPort);

    return { status, ip, httpPort };
  } catch { return null; }
}

// ── Health + inference probes (direct HTTP) ────────────────────────────────────

async function probeModelLoaded(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const modelBase = MODEL.split(':')[0];
    return (data.models ?? []).some(m => (m.name ?? '').startsWith(modelBase));
  } catch { return false; }
}

async function runInference(endpoint: string, timeoutMs: number): Promise<{ ok: boolean; latencyMs: number; response?: string }> {
  const t = now();
  try {
    const res = await fetch(`${endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: 'Say "ok" in one word.', stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = now() - t;
    if (!res.ok) return { ok: false, latencyMs };
    const data = (await res.json()) as { response?: string };
    return { ok: true, latencyMs, response: (data.response ?? '').trim().slice(0, 80) };
  } catch {
    return { ok: false, latencyMs: now() - t };
  }
}

// ── Per-attempt: deploy one offer → run to T3, SLA-gated ────────────────────────

interface BenchResult {
  offerId: number;
  instanceId?: number;
  gpu: string;
  pricePerHr: number;
  geo: string;
  inetDown: number;
  attempts: number;
  t1Ms?: number;
  t2Ms?: number;
  t3Ms?: number;
  inferenceLatencyMs?: number;
  inferenceResponse?: string;
  error?: string;
  phase: 'deploy' | 'running' | 'ready' | 'inference' | 'done' | 'failed';
}

const TERMINAL = new Set(['exited', 'failed', 'destroyed', 'error', 'deleted', 'stopped']);

// Returns the result if it reached T3 within SLA, else null (caller retries).
interface Ctl { reached: boolean }

async function attemptOnce(offer: Offer, tag: string, onDeploy?: (id: number) => void, ctl?: Ctl): Promise<BenchResult | null> {
  const t0 = now();
  const result: BenchResult = {
    offerId: offer.id, gpu: offer.gpu, pricePerHr: offer.pricePerHr,
    geo: offer.geo, inetDown: offer.inetDown, attempts: 1, phase: 'deploy',
  };

  let instanceId = 0;
  try {
    instanceId = await deployOffer(offer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!QUIET) console.error(`${tag} deploy offer ${offer.id} failed (${msg.slice(0, 60)}) → next offer`);
    return null; // stale/unavailable: just try another offer, host not blamed
  }
  result.instanceId = instanceId;
  liveInstances.add(instanceId);
  onDeploy?.(instanceId);
  console.error(`${tag} deployed ${instanceId} (${offer.gpu} @ $${offer.pricePerHr.toFixed(3)}/hr, ${offer.geo})`);

  const fail = async (reason: string, blameHost: boolean): Promise<null> => {
    if (blameHost) badHostIds.add(offer.hostId);
    console.error(`${tag} ✗ ${reason} → terminate ${instanceId}, replace`);
    await terminateInstance(instanceId);
    return null;
  };
  // Cancel (target already reached elsewhere): drop this instance without
  // blaming the host — it may be perfectly good, we just don't need it.
  const cancel = async (): Promise<null> => { await terminateInstance(instanceId); return null; };

  // Phase 1: running + port mapping live, within BOOT_SLA
  result.phase = 'running';
  let endpoint = '';
  let lastStatus = '';
  const bootDeadline = t0 + BOOT_SLA;
  while (now() < bootDeadline) {
    if (ctl?.reached) return cancel();
    await sleep(4_000);
    const inst = await getInstance(instanceId);
    if (!inst) continue;
    if (inst.status !== lastStatus) {
      if (!QUIET) console.error(`${tag} status ${lastStatus || '?'}→${inst.status} (${fmtS(now() - t0)})`);
      lastStatus = inst.status;
    }
    if (TERMINAL.has(inst.status)) return fail(`instance ${inst.status}`, true);
    if (inst.status === 'running' && inst.ip && inst.httpPort > 0) {
      result.t1Ms = now() - t0;
      endpoint = `http://${inst.ip}:${inst.httpPort}`;
      console.error(`${tag} T1 running ${fmtS(result.t1Ms)} → ${endpoint}`);
      break;
    }
  }
  if (!result.t1Ms) return fail(`boot SLA ${BOOT_SLA / 1000}s exceeded`, true);

  // Phase 2: model loaded, within READY_SLA
  result.phase = 'ready';
  const readyDeadline = t0 + READY_SLA;
  while (now() < readyDeadline) {
    if (ctl?.reached) return cancel();
    if (await probeModelLoaded(endpoint)) {
      result.t2Ms = now() - t0;
      console.error(`${tag} T2 model-ready ${fmtS(result.t2Ms)}`);
      break;
    }
    await sleep(4_000);
  }
  if (!result.t2Ms) return fail(`ready SLA ${READY_SLA / 1000}s exceeded`, true);

  // Phase 3: inference within INFER_SLA
  result.phase = 'inference';
  const inf = await runInference(endpoint, INFER_SLA);
  result.inferenceLatencyMs = inf.latencyMs;
  result.inferenceResponse = inf.response;
  if (!inf.ok || inf.latencyMs > INFER_SLA) {
    return fail(`inference ${inf.ok ? 'too slow' : 'failed'} (${fmtS(inf.latencyMs)})`, true);
  }
  result.t3Ms = now() - t0;
  result.phase = 'done';
  console.error(`${tag} ✓ T3 ${fmtS(result.t3Ms)} | inf=${fmtS(inf.latencyMs)} | "${inf.response}"`);
  return result;
}

// ── Slot: retry fresh offers until one success within SLA ───────────────────────

// Fire up to HEDGE offers in parallel; resolve with the first that reaches T3
// within SLA and terminate every other instance (including late winners and
// late deploys). Returns { r, pulled } so the slot can tell "all duds" from
// "no offers in pool" (the latter warrants a wait, not another immediate try).
async function hedgedAttempt(tag: string, ctl?: Ctl): Promise<{ r: BenchResult | null; pulled: number }> {
  const offers: Offer[] = [];
  for (let i = 0; i < HEDGE; i++) { const o = await takeOffer(); if (o) offers.push(o); }
  if (offers.length === 0) return { r: null, pulled: 0 };

  const losers = new Set<number>();
  let settled = false;
  const register = (id: number) => { if (settled) void terminateInstance(id); else losers.add(id); };

  const r = await new Promise<BenchResult | null>(resolve => {
    let pending = offers.length;
    offers.forEach((o, i) => {
      attemptOnce(o, `${tag}h${i + 1}`, register, ctl).then(res => {
        pending--;
        if (res && !settled) {
          settled = true;
          losers.delete(res.instanceId ?? -1);
          resolve(res);
        } else if (res) {
          // Late winner after someone else already won — terminate it.
          if (res.instanceId) void terminateInstance(res.instanceId);
        } else if (!settled && pending === 0) {
          resolve(null); // all hedged offers were duds
        }
      });
    });
  });

  // Kill every instance that isn't the chosen winner.
  for (const id of losers) if (id !== r?.instanceId) void terminateInstance(id);
  return { r, pulled: offers.length };
}

async function runSlot(idx: number, ctl: Ctl, onWin: () => void): Promise<BenchResult> {
  const tag = `[s${idx + 1}]`;
  const deadline = SLOT_DEADLINE > 0 ? now() + SLOT_DEADLINE : Infinity;
  let lastErr = 'no offers available';
  let attempt = 0;
  while (attempt < SLOT_TRIES && now() < deadline) {
    if (ctl.reached) return { offerId: 0, gpu: '-', pricePerHr: 0, geo: '-', inetDown: 0, attempts: attempt, phase: 'failed', error: 'cancelled (target reached)' };
    const { r, pulled } = await hedgedAttempt(`${tag}.${attempt + 1}`, ctl);
    if (pulled === 0) {
      // Pool momentarily empty (contention / refill in flight). Wait — don't
      // give up; refillPool auto-relaxes filters so an offer will appear.
      lastErr = 'waiting for offers';
      await sleep(5_000);
      continue;
    }
    attempt++;
    if (r) { r.attempts = attempt; onWin(); return r; }
    lastErr = `dud after ${attempt} attempt(s)`;
  }
  return {
    offerId: 0, gpu: '-', pricePerHr: 0, geo: '-', inetDown: 0,
    attempts: attempt, phase: 'failed',
    error: now() >= deadline ? `deadline ${SLOT_DEADLINE / 1000}s exceeded (${attempt} tries)` : lastErr,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function pct(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
}

async function main() {
  console.error(`\n=== Vast.ai Parallel Deploy Bench (SLA-gated) ===`);
  const numSlots = Math.max(Math.ceil(PARALLEL * OVERPROVISION), PARALLEL + MIN_EXTRA);
  console.error(`  target: ${PARALLEL} successful | slots: ${numSlots} (overprovision ${OVERPROVISION}x, +${numSlots - PARALLEL} surplus) | model: ${MODEL}`);
  console.error(`  image: ${IMAGE}${SKIP_PULL ? ' (pre-baked, skip-pull)' : ' (runtime pull)'}`);
  console.error(`  SLA: boot<=${BOOT_SLA / 1000}s ready<=${READY_SLA / 1000}s infer<=${INFER_SLA / 1000}s | slot-tries: ${SLOT_TRIES} deadline: ${SLOT_DEADLINE / 1000}s hedge: ${HEDGE}`);
  console.error(`  filters: reliability>=${MIN_REL} inet_down>=${MIN_INET}Mbps price<=$${MAX_PRICE}/hr\n`);

  await refillPool();
  if (offerPool.length === 0) {
    console.error('ERROR: no offers found matching filters');
    process.exit(1);
  }
  console.error(`[pool] ${offerPool.length} offers available, launching ${numSlots} slots (target ${PARALLEL})\n`);

  const t0Global = now();
  const ctl: Ctl = { reached: false };
  let wins = 0;
  const onWin = () => {
    if (++wins >= PARALLEL && !ctl.reached) {
      ctl.reached = true;
      console.error(`\n[target] ${PARALLEL} successes reached → cancelling remaining slots\n`);
    }
  };
  const results = await Promise.all(Array.from({ length: numSlots }, (_, i) => runSlot(i, ctl, onWin)));

  if (!KEEP) await terminateAll();

  // ── Report ───────────────────────────────────────────────────────────────────

  const ok = results.filter(r => r.phase === 'done');
  const cancelled = results.filter(r => r.error === 'cancelled (target reached)');
  const failed = results.filter(r => r.phase === 'failed' && r.error !== 'cancelled (target reached)');

  console.error('\n╔══════════════════════════════════════════════════════════════════╗');
  console.error(`║  RESULTS: ${ok.length}/${PARALLEL} target reached | ${failed.length} failed, ${cancelled.length} cancelled (surplus)`);
  console.error('╚══════════════════════════════════════════════════════════════════╝\n');
  console.error('Machine breakdown:');
  console.error(`${'#'.padEnd(3)} ${'GPU'.padEnd(20)} ${'Price'.padEnd(10)} ${'Try'.padEnd(4)} ${'T1'.padEnd(8)} ${'T2'.padEnd(8)} ${'T3'.padEnd(8)} ${'Inf'.padEnd(8)} Status`);
  console.error('─'.repeat(92));
  for (const [i, r] of results.entries()) {
    console.error([
      String(i + 1).padEnd(3),
      r.gpu.slice(0, 20).padEnd(20),
      `$${r.pricePerHr.toFixed(3)}`.padEnd(10),
      String(r.attempts).padEnd(4),
      (r.t1Ms != null ? fmtS(r.t1Ms) : '-').padEnd(8),
      (r.t2Ms != null ? fmtS(r.t2Ms) : '-').padEnd(8),
      (r.t3Ms != null ? fmtS(r.t3Ms) : '-').padEnd(8),
      (r.inferenceLatencyMs != null ? fmtS(r.inferenceLatencyMs) : '-').padEnd(8),
      r.phase === 'done' ? '✓ ok' : `✗ ${r.error ?? r.phase}`,
    ].join(' '));
  }

  if (ok.length > 0) {
    console.error('\nAggregate (successful machines):');
    const t1s = ok.map(r => r.t1Ms!);
    const t2s = ok.map(r => r.t2Ms!);
    const t3s = ok.map(r => r.t3Ms!);
    const lats = ok.map(r => r.inferenceLatencyMs!);
    const fmt = (arr: number[], label: string) =>
      `  ${label.padEnd(14)} p50=${fmtS(pct(arr, 50))}  p95=${fmtS(pct(arr, 95))}  min=${fmtS(Math.min(...arr))}  max=${fmtS(Math.max(...arr))}`;
    console.error(fmt(t1s, 'T1 running'));
    console.error(fmt(t2s, 'T2 model-ready'));
    console.error(fmt(t3s, 'T3 inference'));
    console.error(fmt(lats, 'Inf latency'));
    console.error(`  total wall      ${fmtS(now() - t0Global)}`);
    console.error(`  success rate    ${ok.length}/${PARALLEL} target (${Math.round(ok.length / PARALLEL * 100)}%) | ${results.length} slots launched`);
    console.error(`  avg attempts    ${(ok.reduce((s, r) => s + r.attempts, 0) / ok.length).toFixed(1)}`);
    console.error(`  avg price       $${(ok.reduce((s, r) => s + r.pricePerHr, 0) / ok.length).toFixed(3)}/hr`);
    console.error(`  bad hosts       ${badHostIds.size} blocklisted`);
  }

  if (failed.length > 0) {
    console.error('\nFailures:');
    for (const r of failed) console.error(`  slot: ${r.error}`);
  }

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      parallel: PARALLEL, model: MODEL, success: ok.length, total: results.length,
      slaBootS: BOOT_SLA / 1000, slaReadyS: READY_SLA / 1000, slaInferS: INFER_SLA / 1000,
      badHosts: badHostIds.size,
      results: results.map(r => ({
        gpu: r.gpu, pricePerHr: r.pricePerHr, geo: r.geo, inetDown: r.inetDown,
        attempts: r.attempts, t1Ms: r.t1Ms, t2Ms: r.t2Ms, t3Ms: r.t3Ms,
        inferenceLatencyMs: r.inferenceLatencyMs, inferenceResponse: r.inferenceResponse,
        phase: r.phase, error: r.error,
      })),
    }, null, 2) + '\n');
  }

  process.exit(ok.length >= PARALLEL ? 0 : 1);
}

if (!bool('sweep')) {
  main().catch(e => {
    console.error('Fatal:', e);
    terminateAll().finally(() => process.exit(1));
  });
}
