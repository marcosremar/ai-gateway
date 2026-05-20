#!/usr/bin/env bun
/**
 * Modal vs Vast.ai Quick Execution Cost Benchmark
 *
 * Goal: compare Modal's cheapest GPU tier against live Vast.ai marketplace offers
 * for short model executions and print break-even conditions where Vast.ai is
 * cheaper than Modal.
 *
 * Default mode is a cost model: it does not deploy or spend money. Pass
 * `--live-gateway` to call the real ai-gateway HTTP API. In live mode, pass
 * `--deploy` to deploy via /v1/gpu/deploy, wait for /v1/gpu/status=ready,
 * then issue real /v1/chat/completions requests through the gateway.
 *
 * Usage:
 *   bun scripts/modal-vs-vast-quick-cost-bench.ts
 *   bun scripts/modal-vs-vast-quick-cost-bench.ts --runs 1,5,10,25,50 --exec-ms 500,1000,2000
 *   bun scripts/modal-vs-vast-quick-cost-bench.ts --vast-price 0.18 --modal-price 0.59
 *   bun scripts/modal-vs-vast-quick-cost-bench.ts --min-vast-bill-sec 60 --vast-boot-sec 35
 *
 *   # Real gateway benchmark (spends money if --deploy is passed):
 *   bun scripts/modal-vs-vast-quick-cost-bench.ts --live-gateway --provider vast --deploy --rounds 10
 *   bun scripts/modal-vs-vast-quick-cost-bench.ts --live-gateway --provider modal --deploy --rounds 10
 *
 * Env:
 *   VAST_API_KEY optional, for live Vast.ai offer search / gateway deploy.
 *   AI_GATEWAY_URL or GATEWAY_URL optional, default http://localhost:4000.
 *   AI_GATEWAY_API_KEY or GATEWAY_API_KEY optional bearer token.
 */

import 'dotenv/config';
import { VastClient } from '../src/gpu-providers/vast-client';
import { ModalClient } from '../src/gateway/providers/gpu/modal-client';

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function numFlag(name: string, fallback: number): number {
  const v = flag(name);
  return v === undefined ? fallback : Number(v);
}
function listFlag(name: string, fallback: number[]): number[] {
  const v = flag(name);
  if (!v) return fallback;
  return v.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n >= 0);
}

const RUNS = listFlag('runs', [1, 2, 5, 10, 25, 50, 100]);
const EXEC_MS = listFlag('exec-ms', [250, 500, 1000, 2000, 5000]);
const VAST_BOOT_SEC = numFlag('vast-boot-sec', 35);
const MODAL_COLD_SEC = numFlag('modal-cold-sec', 10);
const VAST_MIN_BILL_SEC = numFlag('min-vast-bill-sec', 60);
const MODAL_MIN_BILL_SEC = numFlag('min-modal-bill-sec', 1);
const MODAL_PRICE_OVERRIDE = flag('modal-price');
const VAST_PRICE_OVERRIDE = flag('vast-price');
const REGION = flag('region') ?? 'US,CA';
const VAST_GPU_TYPES = (flag('vast-gpus') ?? 'NVIDIA RTX 4090,NVIDIA T4,NVIDIA L4').split(',').map(s => s.trim()).filter(Boolean);
const MODAL_GPU_TYPES = (flag('modal-gpus') ?? 'NVIDIA T4,NVIDIA L4').split(',').map(s => s.trim()).filter(Boolean);
const VAST_FALLBACK_PRICE = 0.20;
const LIVE_GATEWAY = args.includes('--live-gateway');
const LIVE_DEPLOY = args.includes('--deploy');
const LIVE_COMPARE = args.includes('--compare');
const LIVE_PROVIDER = flag('provider') ?? 'vast';
const LIVE_ROUNDS = Math.max(1, Math.floor(numFlag('rounds', 5)));
const LIVE_GATEWAY_URL = (flag('gateway-url') ?? process.env.AI_GATEWAY_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const LIVE_GATEWAY_KEY = flag('gateway-key') ?? process.env.AI_GATEWAY_API_KEY ?? process.env.GATEWAY_API_KEY ?? '';
const LIVE_IMAGE = flag('image') ?? 'marcosremar/babelcast-subtitle:latest';
const LIVE_LABEL = flag('label') ?? `modal-vs-vast-bench-${Date.now()}`;
const LIVE_MAX_WAIT_SEC = Math.max(30, Math.floor(numFlag('max-wait-sec', 900)));
const LIVE_MAX_COST_USD = numFlag('max-cost-usd', LIVE_PROVIDER === 'vast' ? 0.25 : 1.0);
const LIVE_TERMINATE = !args.includes('--keep');

type Offer = {
  provider: 'modal' | 'vast' | 'override';
  gpu: string;
  pricePerHr: number;
  region?: string;
  offerId?: string;
  reliability?: number;
  inetDown?: number;
};

type CostRow = {
  runs: number;
  execMs: number;
  modalCostUsd: number;
  vastCostUsd: number;
  deltaUsd: number;
  cheaper: 'vast' | 'modal' | 'tie';
  vastEffectiveSec: number;
  modalEffectiveSec: number;
};

type LiveRound = { ok: boolean; status: number; ms: number; bodyPreview: string };
type LiveReport = {
  provider: string;
  gatewayUrl: string;
  image: string;
  deployed: boolean;
  deployMs: number | null;
  status: Record<string, unknown> | null;
  rounds: LiveRound[];
};

function dollars(v: number): string { return `$${v.toFixed(6)}`; }
function sec(v: number): string { return `${v.toFixed(1)}s`; }
function cost(pricePerHr: number, billableSec: number): number { return pricePerHr * billableSec / 3600; }
function billableSec(rawSec: number, minSec: number): number { return Math.max(rawSec, minSec); }

function gatewayHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    ...(LIVE_GATEWAY_KEY ? { Authorization: `Bearer ${LIVE_GATEWAY_KEY}` } : {}),
    ...(extra ?? {}),
  };
}

async function gatewayJson(path: string, init: RequestInit = {}): Promise<{ status: number; data: any }> {
  const res = await fetch(`${LIVE_GATEWAY_URL}${path}`, {
    ...init,
    headers: gatewayHeaders({ 'Content-Type': 'application/json', ...((init.headers as Record<string, string> | undefined) ?? {}) }),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

async function ensureGatewayHealthy(): Promise<void> {
  const res = await fetch(`${LIVE_GATEWAY_URL}/health`, { headers: gatewayHeaders(), signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`ai-gateway /health failed: HTTP ${res.status} ${await res.text()}`);
}

function deployBodyForProvider(provider: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    dockerImage: LIVE_IMAGE,
    label: LIVE_LABEL,
    maxCostUsd: LIVE_MAX_COST_USD,
    storageGb: 0,
    containerDiskInGb: 30,
    strictFastBoot: false,
    env: {
      BENCH_MODEL: flag('model') ?? 'llama-3.1-8b-instant',
      BENCH_PROMPT: flag('prompt') ?? 'Reply with exactly: ok',
      BENCH_PROVIDER: provider,
    },
  };
  if (provider === 'vast') {
    body.provider = 'vast';
    body.vastApiKey = process.env.VAST_API_KEY;
    body.gpuTypes = VAST_GPU_TYPES;
    body.noTierCascade = true;
    body.region = REGION;
  } else if (provider === 'modal') {
    body.provider = 'modal';
    body.modalTokenId = process.env.MODAL_TOKEN_ID;
    body.modalTokenSecret = process.env.MODAL_TOKEN_SECRET;
    body.gpuTypes = MODAL_GPU_TYPES;
    body.noTierCascade = true;
  } else {
    throw new Error(`Unsupported live provider: ${provider}. Use --provider vast or --provider modal.`);
  }
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== ''));
}

async function deployViaGateway(provider: string): Promise<{ deployMs: number; status: Record<string, unknown> }> {
  const started = Date.now();
  const body = deployBodyForProvider(provider);
  const deploy = await gatewayJson('/v1/gpu/deploy', { method: 'POST', body: JSON.stringify(body) });
  if (deploy.status >= 400) throw new Error(`/v1/gpu/deploy failed: HTTP ${deploy.status} ${JSON.stringify(deploy.data).slice(0, 500)}`);

  let lastStatus: Record<string, unknown> = deploy.data ?? {};
  const deadline = Date.now() + LIVE_MAX_WAIT_SEC * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3_000));
    const status = await gatewayJson('/v1/gpu/status');
    lastStatus = status.data ?? {};
    const state = String(lastStatus.status ?? '');
    const step = String(lastStatus.step ?? '');
    console.error(`[live:${provider}] status=${state || '?'} step=${step || '?'} gpu=${lastStatus.gpuType ?? ''}`);
    if (state === 'ready') return { deployMs: Date.now() - started, status: lastStatus };
    if (state === 'error') throw new Error(`deploy entered error: ${JSON.stringify(lastStatus).slice(0, 500)}`);
  }
  throw new Error(`Timed out after ${LIVE_MAX_WAIT_SEC}s waiting for ${provider} deployment; last=${JSON.stringify(lastStatus).slice(0, 500)}`);
}

async function terminateViaGateway(status?: Record<string, unknown> | null): Promise<void> {
  if (!LIVE_TERMINATE) return;
  const body: Record<string, unknown> = { force: true };
  if (status?.deployId) body.deployId = status.deployId;
  if (status?.podId) body.instanceId = status.podId;
  if (status?.provider) body.provider = status.provider;
  try {
    const res = await gatewayJson('/v1/gpu/terminate', { method: 'POST', body: JSON.stringify(body) });
    console.error(`[live] terminate status=${res.status} ${JSON.stringify(res.data).slice(0, 240)}`);
  } catch (err) {
    console.error(`[live] terminate failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function runGatewayInferenceRound(): Promise<LiveRound> {
  const started = Date.now();
  try {
    const res = await fetch(`${LIVE_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: gatewayHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model: flag('model') ?? 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: flag('prompt') ?? 'Reply with exactly: ok' }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, ms: Date.now() - started, bodyPreview: text.slice(0, 160) };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, bodyPreview: err instanceof Error ? err.message : String(err) };
  }
}

async function benchmarkProvider(provider: string, shouldDeploy: boolean): Promise<LiveReport & { latencyMs: { p50: number | null; p95: number | null } }> {
  await ensureGatewayHealthy();
  let deployMs: number | null = null;
  let status: Record<string, unknown> | null = null;
  if (shouldDeploy) {
    const deploy = await deployViaGateway(provider);
    deployMs = deploy.deployMs;
    status = deploy.status;
  } else {
    const current = await gatewayJson('/v1/gpu/status');
    status = current.data ?? null;
  }

  const rounds: LiveRound[] = [];
  for (let i = 0; i < LIVE_ROUNDS; i++) {
    const round = await runGatewayInferenceRound();
    rounds.push(round);
    console.error(`[live:${provider}] round=${i + 1}/${LIVE_ROUNDS} ok=${round.ok} status=${round.status} ms=${round.ms}`);
  }
  const okTimes = rounds.filter(r => r.ok).map(r => r.ms).sort((a, b) => a - b);
  const p50 = okTimes[Math.floor(okTimes.length * 0.5)] ?? null;
  const p95 = okTimes[Math.ceil(okTimes.length * 0.95) - 1] ?? null;
  return {
    provider,
    gatewayUrl: LIVE_GATEWAY_URL,
    image: LIVE_IMAGE,
    deployed: shouldDeploy,
    deployMs,
    status,
    rounds,
    latencyMs: { p50, p95 },
  };
}

function estimateLiveCost(report: LiveReport, fallbackPricePerHr: number, minBillSec: number): number {
  const pricePerHr = Number(report.status?.costPerHr ?? fallbackPricePerHr);
  const deploySec = (report.deployMs ?? 0) / 1000;
  const inferenceSec = report.rounds.reduce((sum, r) => sum + r.ms / 1000, 0);
  return cost(pricePerHr, Math.max(minBillSec, deploySec + inferenceSec));
}

async function runLiveGatewayBenchmark(): Promise<void> {
  if (LIVE_COMPARE) {
    const modal = await benchmarkProvider('modal', true);
    await terminateViaGateway(modal.status);
    const vast = await benchmarkProvider('vast', true);
    await terminateViaGateway(vast.status);
    const modalCost = estimateLiveCost(modal, Number(MODAL_PRICE_OVERRIDE ?? 0.59), MODAL_MIN_BILL_SEC);
    const vastCost = estimateLiveCost(vast, Number(VAST_PRICE_OVERRIDE ?? 0.20), VAST_MIN_BILL_SEC);
    console.log('JSON_RESULT:');
    console.log(JSON.stringify({
      mode: 'compare',
      image: LIVE_IMAGE,
      rounds: LIVE_ROUNDS,
      modal,
      vast,
      estimatedCostUsd: { modal: modalCost, vast: vastCost, deltaModalMinusVast: modalCost - vastCost },
      winner: vastCost < modalCost ? 'vast' : modalCost < vastCost ? 'modal' : 'tie',
    }, null, 2));
    return;
  }

  const report = await benchmarkProvider(LIVE_PROVIDER, LIVE_DEPLOY);
  console.log('JSON_RESULT:');
  console.log(JSON.stringify(report, null, 2));
}

async function getModalOffer(): Promise<Offer> {
  if (MODAL_PRICE_OVERRIDE) {
    return { provider: 'override', gpu: 'modal-override', pricePerHr: Number(MODAL_PRICE_OVERRIDE) };
  }
  const modal = new ModalClient();
  const offers = await modal.listOffers({ gpuTypes: MODAL_GPU_TYPES, limit: 100 }, { apiKey: 'unused' });
  const sorted = offers
    .map(o => ({ provider: 'modal' as const, gpu: o.gpuName ?? o.gpuType ?? 'unknown', pricePerHr: o.pricePerHr, region: o.region }))
    .sort((a, b) => a.pricePerHr - b.pricePerHr);
  const cheapest = sorted[0];
  if (!cheapest) throw new Error(`No Modal offers matched modal-gpus=${MODAL_GPU_TYPES.join(',')}`);
  return cheapest;
}

async function getVastOffer(): Promise<Offer> {
  if (VAST_PRICE_OVERRIDE) {
    return { provider: 'override', gpu: 'vast-override', pricePerHr: Number(VAST_PRICE_OVERRIDE) };
  }
  const apiKey = process.env.VAST_API_KEY;
  if (!apiKey) {
    return { provider: 'override', gpu: 'vast-fallback-no-api-key', pricePerHr: VAST_FALLBACK_PRICE, region: 'fallback' };
  }
  const vast = new VastClient();
  const offers = await vast.listOffers({ gpuTypes: VAST_GPU_TYPES, region: REGION, limit: 100 }, { apiKey });
  const filtered = offers
    .filter(o => o.pricePerHr > 0)
    .sort((a, b) => a.pricePerHr - b.pricePerHr);
  const cheapest = filtered[0];
  if (!cheapest) {
    return { provider: 'override', gpu: 'vast-fallback-no-offers', pricePerHr: VAST_FALLBACK_PRICE, region: 'fallback' };
  }
  return {
    provider: 'vast',
    gpu: cheapest.gpuName ?? cheapest.gpuType ?? 'unknown',
    pricePerHr: cheapest.pricePerHr,
    region: cheapest.region,
    offerId: cheapest.offerId,
    reliability: cheapest.reliability,
    inetDown: cheapest.inetDown,
  };
}

function compare(modal: Offer, vast: Offer): CostRow[] {
  const rows: CostRow[] = [];
  for (const execMs of EXEC_MS) {
    for (const runs of RUNS) {
      const workSec = runs * execMs / 1000;
      const modalEffectiveSec = billableSec(MODAL_COLD_SEC + workSec, MODAL_MIN_BILL_SEC);
      const vastEffectiveSec = billableSec(VAST_BOOT_SEC + workSec, VAST_MIN_BILL_SEC);
      const modalCostUsd = cost(modal.pricePerHr, modalEffectiveSec);
      const vastCostUsd = cost(vast.pricePerHr, vastEffectiveSec);
      const deltaUsd = modalCostUsd - vastCostUsd;
      rows.push({
        runs,
        execMs,
        modalCostUsd,
        vastCostUsd,
        deltaUsd,
        cheaper: Math.abs(deltaUsd) < 1e-9 ? 'tie' : deltaUsd > 0 ? 'vast' : 'modal',
        vastEffectiveSec,
        modalEffectiveSec,
      });
    }
  }
  return rows;
}

function breakEvenRuns(modal: Offer, vast: Offer, execMs: number): number | null {
  for (let runs = 1; runs <= 10_000; runs++) {
    const workSec = runs * execMs / 1000;
    const modalCostUsd = cost(modal.pricePerHr, billableSec(MODAL_COLD_SEC + workSec, MODAL_MIN_BILL_SEC));
    const vastCostUsd = cost(vast.pricePerHr, billableSec(VAST_BOOT_SEC + workSec, VAST_MIN_BILL_SEC));
    if (vastCostUsd < modalCostUsd) return runs;
  }
  return null;
}

function maxVastBootForCheaper(modal: Offer, vast: Offer, runs: number, execMs: number): number {
  const modalBill = billableSec(MODAL_COLD_SEC + (runs * execMs / 1000), MODAL_MIN_BILL_SEC);
  const modalBudgetSecAtVastRate = modalBill * modal.pricePerHr / vast.pricePerHr;
  const allowedBoot = modalBudgetSecAtVastRate - (runs * execMs / 1000);
  return Math.max(0, allowedBoot);
}

function printReport(modal: Offer, vast: Offer, rows: CostRow[]) {
  console.log(`\n${'═'.repeat(78)}`);
  console.log('  Modal vs Vast.ai quick execution cost benchmark');
  console.log(`${'═'.repeat(78)}`);
  console.log(`  Modal cheapest : ${modal.gpu} @ $${modal.pricePerHr.toFixed(3)}/hr (${modal.provider})`);
  console.log(`  Vast cheapest  : ${vast.gpu} @ $${vast.pricePerHr.toFixed(3)}/hr (${vast.provider}${vast.offerId ? ` offer=${vast.offerId}` : ''}${vast.region ? ` ${vast.region}` : ''})`);
  console.log(`  Assumptions    : Modal cold=${sec(MODAL_COLD_SEC)}, Modal min bill=${sec(MODAL_MIN_BILL_SEC)}, Vast boot=${sec(VAST_BOOT_SEC)}, Vast min bill=${sec(VAST_MIN_BILL_SEC)}`);
  console.log(`  Vast search    : gpus=[${VAST_GPU_TYPES.join(', ')}], region=${REGION}`);
  console.log(`${'─'.repeat(78)}`);
  console.log('  exec   runs   modal_cost   vast_cost    winner   vast_bill modal_bill max_vast_boot');
  for (const row of rows) {
    const maxBoot = maxVastBootForCheaper(modal, vast, row.runs, row.execMs);
    console.log(
      `  ${String(row.execMs).padStart(4)}ms ${String(row.runs).padStart(5)} ` +
      `${dollars(row.modalCostUsd).padStart(12)} ${dollars(row.vastCostUsd).padStart(11)} ` +
      `${row.cheaper.padStart(7)} ${sec(row.vastEffectiveSec).padStart(10)} ${sec(row.modalEffectiveSec).padStart(10)} ${sec(maxBoot).padStart(13)}`,
    );
  }
  console.log(`${'─'.repeat(78)}`);
  for (const execMs of EXEC_MS) {
    const be = breakEvenRuns(modal, vast, execMs);
    if (be === null) console.log(`  Break-even @ ${execMs}ms/run: Vast never beats Modal under 10k runs with these assumptions.`);
    else console.log(`  Break-even @ ${execMs}ms/run: Vast cheaper starting at ${be} run(s).`);
  }
  console.log(`${'═'.repeat(78)}\n`);
}

async function main() {
  if (LIVE_GATEWAY) {
    await runLiveGatewayBenchmark();
    return;
  }

  const [modal, vast] = await Promise.all([getModalOffer(), getVastOffer()]);
  const rows = compare(modal, vast);
  printReport(modal, vast, rows);
  console.log('JSON_RESULT:');
  console.log(JSON.stringify({
    assumptions: {
      runs: RUNS,
      execMs: EXEC_MS,
      modalColdSec: MODAL_COLD_SEC,
      modalMinBillSec: MODAL_MIN_BILL_SEC,
      vastBootSec: VAST_BOOT_SEC,
      vastMinBillSec: VAST_MIN_BILL_SEC,
      vastGpuTypes: VAST_GPU_TYPES,
      modalGpuTypes: MODAL_GPU_TYPES,
      region: REGION,
    },
    modal,
    vast,
    rows,
    breakEven: Object.fromEntries(EXEC_MS.map(ms => [String(ms), breakEvenRuns(modal, vast, ms)])),
  }, null, 2));
}

main().catch(err => {
  console.error('[fatal]', err instanceof Error ? err.message : err);
  process.exit(1);
});
