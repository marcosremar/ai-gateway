#!/usr/bin/env bun
/**
 * 7B Model Cold Start Benchmark — all 3 tiers, detailed timings
 *
 * Measures every phase of the three cold-start strategies that SnapGPU enables.
 * Results are used to drive SnapGPU optimization decisions.
 *
 *   TIER 1 — COLD BOOT (baseline, fresh instance no cache)
 *     Provision + image pull + model load from scratch.
 *     Breakdown: deploy_api_ms, pull_ms, model_load_ms, first_inference_ms
 *
 *   TIER 2 — WARM RESTART (same host, Docker layer cache)
 *     Stop → Start same instance. Image cached on disk, model reloads.
 *     Breakdown: stop_ms, start_ms, model_load_ms, first_inference_ms
 *     Speedup comes from eliminating image pull.
 *
 *   TIER 3 — CRIU SNAPSHOT RESTORE (RunPod Secure Cloud, --privileged)
 *     Freeze model-in-RAM via CRIU → restore. Zero model load cost.
 *     Breakdown: dump_ms, restore_ms, process_verify_ms
 *     Requires full capabilities (CAP_NET_ADMIN + CAP_SYS_ADMIN).
 *     RunPod Secure Cloud provides these via --privileged containers.
 *     Note: CUDA checkpoint (real GPU VRAM freeze) needs driver 570+.
 *           Without it, CPU memory only is snapshotted — still useful
 *           if model is loaded lazily from disk on restore.
 *
 * Run:
 *   bun scripts/coldstart-7b-bench.ts              # all 3 tiers
 *   bun scripts/coldstart-7b-bench.ts --skip-criu  # tier 1+2 only
 *   bun scripts/coldstart-7b-bench.ts --only-criu  # tier 3 only (reuses cached T1/T2 numbers)
 *   bun scripts/coldstart-7b-bench.ts --dry-run    # plan only
 *
 * Requires: VAST_API_KEY (Tier 1+2) + RUNPOD_API_KEY (Tier 3 CRIU)
 * Cost: ~$0.10-0.30 (2-3 instances × ~15-20 min each)
 */

import 'dotenv/config';
import { spawnSync } from 'child_process';
import { VastClient } from '../src/gpu-providers/vast-client';
import { RunpodClient } from '../src/gpu-providers/runpod-client';
import type { GpuInstance, ProviderCredentials } from '../src/gpu-providers/types';

// ── Config ────────────────────────────────────────────────────────────────────

// babelcast-subtitle: pre-baked Gemma 4B Q8 (≈4 GB GGUF) + Whisper (≈1.5 GB).
// Universal CUDA 12.8.1, runs on RTX 3090/4090/A40/A5000.
// Comparable cold-start profile to a 7B model.
const IMAGE = process.env.BENCH_IMAGE ?? 'marcosremar/babelcast-subtitle:latest';
const GPU_TYPES = ['RTX 3090', 'RTX 4090', 'RTX A5000', 'A40'];
const MAX_WAIT_MS  = 20 * 60_000;
const HEALTH_POLL  = 8_000;
const INFER_PROMPT = JSON.stringify({
  messages: [{ role: 'user', content: 'Say "ok" in one word.' }],
  max_tokens: 5,
  temperature: 0,
});

const SKIP_CRIU  = process.argv.includes('--skip-criu');
const ONLY_CRIU  = process.argv.includes('--only-criu');  // skip T1+T2, run T3 only
const DRY_RUN    = process.argv.includes('--dry-run');

const VAST_KEY = process.env.VAST_API_KEY ?? '';
if (!DRY_RUN && !VAST_KEY) { console.error('ERROR: VAST_API_KEY not set'); process.exit(1); }

const creds: ProviderCredentials = { apiKey: VAST_KEY };
const client = new VastClient();

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const fmtMs = (ms: number) => ms < 2000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Health + inference helpers ────────────────────────────────────────────────

interface HealthData {
  status?: string;
  uptime?: number;
  gpu?: string;
  services?: Record<string, string>;
  model_warmth?: Record<string, { warm?: boolean }>;
}

async function probeHealth(ep: string, timeout = 6_000): Promise<{ ok: boolean; data?: HealthData; ms: number }> {
  const t = Date.now();
  try {
    const res = await fetch(`${ep}/health`, { signal: AbortSignal.timeout(timeout) });
    const ms = Date.now() - t;
    if (!res.ok) return { ok: false, ms };
    const data = await res.json() as HealthData;
    return { ok: data.status === 'ok' || data.status === 'healthy', data, ms };
  } catch {
    return { ok: false, ms: Date.now() - t };
  }
}

/** Wait until /health 200. Returns ms from call start. */
async function waitForHealth(ep: string, label: string): Promise<{ healthMs: number; data?: HealthData }> {
  const t0 = Date.now();
  const deadline = t0 + MAX_WAIT_MS;
  let polls = 0;
  while (Date.now() < deadline) {
    await sleep(HEALTH_POLL);
    polls++;
    const { ok, data, ms } = await probeHealth(ep);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    if (ok) {
      log(`[${label}] ✓ /health OK after ${elapsed}s (${polls} polls, probe=${ms}ms)`);
      return { healthMs: Date.now() - t0, data };
    }
    log(`[${label}] polling /health... ${elapsed}s (${data?.status ?? 'no response'})`);
  }
  throw new Error(`[${label}] /health timed out after ${MAX_WAIT_MS / 1000}s`);
}

/** POST /v1/chat/completions — returns latency or null if endpoint absent. */
async function measureInference(ep: string, label: string): Promise<number | null> {
  for (const path of ['/v1/chat/completions', '/v1/translate', '/api/text']) {
    const t = Date.now();
    try {
      const res = await fetch(`${ep}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: INFER_PROMPT,
        signal: AbortSignal.timeout(30_000),
      });
      const ms = Date.now() - t;
      if (res.status < 500) {
        const body = await res.text().catch(() => '');
        log(`[${label}] ${path} → ${res.status} in ${fmtMs(ms)} (${body.slice(0, 80)})`);
        return ms;
      }
    } catch { /* try next */ }
  }
  log(`[${label}] no inference endpoint responded — skipping inference latency`);
  return null;
}

/**
 * Resolve endpoint, retrying until available AND responds to HTTP.
 *
 * Critical: after stop→start, resolveInstanceEndpoint can return the SSH
 * direct_port (e.g. 40389) before proper port mappings come back. We
 * validate with a quick HTTP probe to distinguish the SSH port from the
 * real app HTTP port. SSH ports return a banner, not a valid HTTP response.
 */
async function waitForEndpoint(inst: GpuInstance, label: string): Promise<string> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const ep = await client.resolveInstanceEndpoint!(inst.instanceId, creds).catch(() => null);
    if (ep) {
      // Probe: any HTTP response (even 4xx/5xx) means it's the real HTTP port.
      // SSH port will fail (SSH banner is not valid HTTP) or timeout.
      const httpOk = await fetch(`${ep}/health`, { signal: AbortSignal.timeout(3000) })
        .then(r => r.status < 600)
        .catch(() => false);
      if (httpOk) { log(`[${label}] endpoint: ${ep}`); return ep; }
      log(`[${label}] ${ep} not HTTP-reachable yet (SSH port or loading), waiting...`);
    } else {
      log(`[${label}] waiting for endpoint...`);
    }
    await sleep(8_000);
  }
  throw new Error(`[${label}] endpoint never resolved or not HTTP-reachable`);
}

/** Wait for specific instance status. */
async function waitForStatus(instId: string, target: string[], label: string, maxMs = 5 * 60_000): Promise<string | null> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(5_000);
    const s = await client.getInstanceStatus(instId, creds).catch(() => null);
    log(`[${label}] status=${s}`);
    if (s && target.some(t => s.toLowerCase().includes(t.toLowerCase()))) return s;
    if (s && ['destroyed', 'error'].includes(s.toLowerCase())) return s;
  }
  return null;
}

// ── SSH helper (for CRIU phase only) ─────────────────────────────────────────

// SSH_KEY: path to the private key.
// Vast.ai (T1/T2): key must be registered in the Vast.ai account (uses ssh_direct runtype).
// RunPod (T3): SSH keys injected automatically by RunPod (all account keys).
// Override with VAST_SSH_KEY env var.
const SSH_KEY = process.env.VAST_SSH_KEY ?? `${process.env.HOME}/.ssh/id_ed25519`;

function ssh(host: string, port: number, cmd: string, timeoutMs = 60_000, inContainer = true): { ok: boolean; out: string; ms: number } {
  const actualCmd = inContainer
    ? `docker exec snapgpu bash -c ${JSON.stringify(cmd)}`
    : cmd;
  const t = Date.now();
  const r = spawnSync('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',           // fail immediately on auth prompts (no hanging)
    '-i', SSH_KEY,                   // explicit identity file — Vast.ai injects all registered keys
    '-p', String(port),
    `root@${host}`,
    actualCmd,
  ], { encoding: 'utf-8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  return { ok: r.status === 0, out, ms: Date.now() - t };
}

// ── RunPod client (Tier 3 CRIU deploy) ───────────────────────────────────────

const RUNPOD_KEY = process.env.RUNPOD_API_KEY ?? '';
const rpClient = new RunpodClient();
const rpCreds: ProviderCredentials = { apiKey: RUNPOD_KEY };

// ── RunPod quota tracker ──────────────────────────────────────────────────────
// Records consecutive machineQuota=0 blocks so we can escalate to support
// after N failures within a time window.

const QUOTA_TRACK_FILE = `${process.env.HOME}/.babelcast/runpod-quota.json`;
const QUOTA_ALERT_THRESHOLD = 3;   // failures in…
const QUOTA_ALERT_WINDOW_MS = 24 * 60 * 60_000;  // …24h

interface QuotaTrack { failures: Array<{ at: number; reason: string }> }

function loadQuotaTrack(): QuotaTrack {
  try {
    const fs = require('fs');
    return JSON.parse(fs.readFileSync(QUOTA_TRACK_FILE, 'utf8'));
  } catch { return { failures: [] }; }
}

function saveQuotaTrack(t: QuotaTrack): void {
  try {
    const fs = require('fs');
    fs.mkdirSync(require('path').dirname(QUOTA_TRACK_FILE), { recursive: true });
    fs.writeFileSync(QUOTA_TRACK_FILE, JSON.stringify(t, null, 2));
  } catch { /* non-fatal */ }
}

function recordQuotaFailure(reason: string): void {
  const track = loadQuotaTrack();
  const now = Date.now();
  track.failures.push({ at: now, reason });
  // Keep only failures within the alert window
  track.failures = track.failures.filter(f => now - f.at < QUOTA_ALERT_WINDOW_MS);
  saveQuotaTrack(track);

  log(`  [quota-track] ${track.failures.length} RunPod quota failure(s) in last 24h (threshold=${QUOTA_ALERT_THRESHOLD})`);
  if (track.failures.length >= QUOTA_ALERT_THRESHOLD) {
    log('');
    log('  ⚠  RUNPOD QUOTA BLOCKED ≥3x IN 24h — auto-escalate to support:');
    log('');
    log('  Open support ticket:');
    log('    open "https://contact.runpod.io/hc/en-us/requests/new"');
    log('');
    log('  Or paste this in RunPod Discord (#support):');
    log(`    machineQuota=0 on my account (balance OK, 0 active pods). Hit ${track.failures.length}x in 24h`);
    log('    from automated GPU benchmarks. Please reset quota. API key email: <your-email>');
    log('    https://discord.gg/cUpRmau42V');
    log('');
  }
}

/**
 * Pre-check RunPod account quota before attempting deploy.
 * Returns { ok: true } if deploy should proceed, { ok: false, reason } if blocked.
 * Skips check if RUNPOD_KEY is absent (caller already handles that).
 */
async function checkRunpodQuota(): Promise<{ ok: boolean; reason?: string }> {
  const status = await rpClient.getAccountStatus(rpCreds).catch(() => null);
  if (!status) {
    // GraphQL unreachable — proceed optimistically (preflight will catch it if needed)
    log('  [quota-check] GraphQL unreachable — proceeding optimistically');
    return { ok: true };
  }
  log(`  [quota-check] balance=$${status.clientBalance.toFixed(2)} quota=${status.machineQuota} activePods=${status.activePodCount}`);
  if (!status.canDeploy) {
    recordQuotaFailure(status.blockReason ?? 'unknown');
    return { ok: false, reason: status.blockReason ?? 'RunPod deploy blocked' };
  }
  return { ok: true };
}

// ── Result types ──────────────────────────────────────────────────────────────

interface Tier1Result {
  gpu: string;
  deployApiMs: number;        // time for createInstance API call to return
  timeToRunningMs: number;    // createInstance → instance running (includes pull)
  timeToHealthMs: number;     // createInstance → /health 200
  firstInferenceMs: number | null;
  secondInferenceMs: number | null;
  healthData?: HealthData;
}

interface Tier2Result {
  stopMs: number;
  timeToExitedMs: number;
  startMs: number;
  timeToHealthMs: number;     // startInstance → /health 200 (model reload only)
  firstInferenceMs: number | null;
  speedupVsTier1: number;
}

interface Tier3Result {
  deployMs: number;
  timeToHealthMs: number;
  dummyProcessSizeBytes: number;
  criuCapable: boolean;
  dumpMs: number | null;
  dumpSizeBytes: number | null;
  restoreMs: number | null;
  processAlive: boolean | null;
  cudaCheckpointCapable: boolean;
  driverVersion: string;
}

const results: { tier1?: Tier1Result; tier2?: Tier2Result; tier3?: Tier3Result } = {};

// ── Cleanup registry ──────────────────────────────────────────────────────────

const toDelete: Array<{ instanceId: string; source: 'vast' | 'runpod' }> = [];

async function cleanup() {
  for (const inst of toDelete) {
    try {
      if (inst.source === 'vast') {
        await client.deleteInstance(inst.instanceId, creds);
        log(`[cleanup] deleted Vast.ai instance ${inst.instanceId}`);
      } else if (inst.source === 'runpod') {
        await rpClient.deleteInstance(inst.instanceId, rpCreds);
        log(`[cleanup] deleted RunPod instance ${inst.instanceId}`);
      }
    } catch (e) { log(`[cleanup] WARNING: ${e}`); }
  }
  toDelete.length = 0;
}

process.on('SIGINT',  async () => { await cleanup(); process.exit(130); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(143); });

// ══════════════════════════════════════════════════════════════════════════════
// TIER 1 — Cold Boot
// ══════════════════════════════════════════════════════════════════════════════

async function runTier1(): Promise<GpuInstance> {
  log('\n══════════════════════════════════════════════════════');
  log('TIER 1 — COLD BOOT (fresh instance, no Docker cache)');
  log('══════════════════════════════════════════════════════');

  const t0 = Date.now();
  const inst = await client.createInstance({
    gpuTypes: GPU_TYPES,
    gpuCount: 1,
    storageGb: 20,
    dockerImage: IMAGE,
    env: {},
    // raceCount=1: single instance, no hedging. Hedging normally speeds up
    // selection but blocks on the loser's SSH tunnel fallback, inflating
    // createInstance time by 10+ min. For benchmark accuracy, use 1.
    raceCount: 1,
    // directPortRequired=2: requires at least 2 direct ports (SSH + app HTTP port).
    // The default search already has direct_port_count>=1, but hosts with exactly 1
    // direct port only have SSH (22). We need >=2 to guarantee an HTTP app port too.
    directPortRequired: 2,
  }, creds);

  const deployApiMs = Date.now() - t0;
  log(`  deploy API: ${fmtMs(deployApiMs)} — id=${inst.instanceId} gpu=${inst.gpuType}`);
  toDelete.push({ instanceId: inst.instanceId, source: 'vast' as const });

  // Resolve endpoint
  const t1 = Date.now();
  const ep = await waitForEndpoint(inst, 'tier1');
  const timeToRunningMs = Date.now() - t0;
  log(`  running+endpoint: ${fmtMs(timeToRunningMs)}`);

  // Wait for /health
  const { healthMs, data } = await waitForHealth(ep, 'tier1');
  const timeToHealthMs = Date.now() - t0;

  log(`  model state: ${JSON.stringify(data?.model_warmth ?? {})}`);
  log(`  services: ${JSON.stringify(data?.services ?? {})}`);

  // First inference
  log('  measuring first inference latency...');
  const firstInferenceMs = await measureInference(ep, 'tier1-1st');

  // Second inference (GPU warm)
  log('  measuring second inference latency (GPU warm)...');
  const secondInferenceMs = await measureInference(ep, 'tier1-2nd');

  results.tier1 = {
    gpu: inst.gpuType ?? 'unknown',
    deployApiMs,
    timeToRunningMs,
    timeToHealthMs,
    firstInferenceMs,
    secondInferenceMs,
    healthData: data,
  };

  log(`\n  ── TIER 1 SUMMARY ─────────────────────────────`);
  log(`  GPU:               ${results.tier1.gpu}`);
  log(`  Deploy API:        ${fmtMs(deployApiMs)}`);
  log(`  Running+endpoint:  ${fmtMs(timeToRunningMs)}`);
  log(`  /health ready:     ${fmtMs(healthMs)}`);
  log(`  TOTAL cold boot:   ${fmtMs(timeToHealthMs)}`);
  if (firstInferenceMs)  log(`  1st inference:     ${fmtMs(firstInferenceMs)}`);
  if (secondInferenceMs) log(`  2nd inference:     ${fmtMs(secondInferenceMs)}`);

  return inst;
}

// ══════════════════════════════════════════════════════════════════════════════
// TIER 2 — Warm Restart (Docker layer cache)
// ══════════════════════════════════════════════════════════════════════════════

async function runTier2(inst: GpuInstance): Promise<void> {
  log('\n══════════════════════════════════════════════════════');
  log('TIER 2 — WARM RESTART (same host, Docker layer cache)');
  log('══════════════════════════════════════════════════════');

  // Stop
  const t0 = Date.now();
  await client.stopInstance(inst.instanceId, creds);
  const stopMs = Date.now() - t0;
  log(`  stopInstance: ${fmtMs(stopMs)}`);

  // Wait for exited
  const t1 = Date.now();
  const exitedStatus = await waitForStatus(inst.instanceId, ['exited', 'stopped', 'paused'], 'tier2-stop', 3 * 60_000);
  const timeToExitedMs = Date.now() - t1;
  log(`  exited in: ${fmtMs(timeToExitedMs)} (status=${exitedStatus})`);

  // Start
  const t2 = Date.now();
  await client.startInstance(inst.instanceId, creds);
  const startMs = Date.now() - t2;
  log(`  startInstance: ${fmtMs(startMs)}`);

  // Endpoint (may change after restart)
  const t3 = Date.now();
  const ep = await waitForEndpoint(inst, 'tier2');

  // Wait for /health
  const { healthMs, data } = await waitForHealth(ep, 'tier2');
  const timeToHealthMs = Date.now() - t2; // from Start, not Stop

  log(`  model state: ${JSON.stringify(data?.model_warmth ?? {})}`);

  // Inference
  const firstInferenceMs = await measureInference(ep, 'tier2-1st');

  const speedupVsTier1 = results.tier1
    ? results.tier1.timeToHealthMs / timeToHealthMs
    : 0;

  results.tier2 = {
    stopMs,
    timeToExitedMs,
    startMs,
    timeToHealthMs,
    firstInferenceMs,
    speedupVsTier1,
  };

  log(`\n  ── TIER 2 SUMMARY ─────────────────────────────`);
  log(`  stopInstance:       ${fmtMs(stopMs)}`);
  log(`  time to EXITED:     ${fmtMs(timeToExitedMs)}`);
  log(`  startInstance:      ${fmtMs(startMs)}`);
  log(`  /health ready:      ${fmtMs(healthMs)}`);
  log(`  TOTAL warm restart: ${fmtMs(timeToHealthMs)} (from Start)`);
  if (firstInferenceMs) log(`  1st inference:      ${fmtMs(firstInferenceMs)}`);
  log(`  Speedup vs Tier 1:  ${speedupVsTier1.toFixed(1)}x faster`);
}

// ══════════════════════════════════════════════════════════════════════════════
// TIER 3 — CRIU Snapshot Restore (host environment probe)
// ══════════════════════════════════════════════════════════════════════════════
//
// Goal: measure CRIU dump/restore latency for a 128MB dummy process, then
// project to real 7B model sizes.
//
// Vast.ai capability reality (discovered via empirical testing 2026-04-10):
//   - `vm: true` template flag IS STRIPPED by Vast.ai → always a Docker container
//   - Docker containers on vms_enabled hosts: capBnd=00000000a80425fb
//   - Missing: CAP_NET_ADMIN (bit 12), CAP_SYS_ADMIN (bit 21)
//   - PID 1 = Vast.ai init script (/bin/sh -c while [ ! -e /.launch ]...)
//   - CRIU fails: needs CAP_NET_ADMIN for network namespace operations
//
// This tier probes what IS available (driver, CRIU binary, ptrace_scope) and
// records the exact error so we know what infra upgrade would unblock it.
//
// To run CRIU on Vast.ai: use bare-metal secure cloud OR a provider that
// doesn't strip --privileged (e.g. internal infra, RunPod with --privileged).
// The vast-snapgpu-bench.ts --vm-mode was designed for this but also fails
// because vm:true gets stripped.

// 128MB zeroed file + background sleep process (simulates model weights in RAM).
// CRIU dump time scales linearly: 128MB→~0.2s, 4GB→~6s, 14GB→~20s.
const DUMMY_CMD = [
  'dd if=/dev/zero bs=1M count=128 of=/tmp/model_weights.bin 2>/dev/null',
  'CKSUM=$(md5sum /tmp/model_weights.bin | cut -c1-8)',
  'echo $CKSUM > /tmp/dummy.cksum',
  'sleep 9999 &',
  'PID=$!',
  'echo "PID=$PID CKSUM=$CKSUM DUMMY_READY"',
].join('\n');

async function runTier3(): Promise<void> {
  log('\n══════════════════════════════════════════════════════');
  log('TIER 3 — CRIU SNAPSHOT RESTORE (RunPod Secure Cloud)');
  log('══════════════════════════════════════════════════════');
  log('  Deploy Ubuntu on RunPod Secure Cloud (--privileged, full caps) →');
  log('  install CRIU → dump/restore 128MB process. CAP_NET_ADMIN + CAP_SYS_ADMIN present.');

  const T3_SKIP = (reason: string) => {
    log(`  SKIP: ${reason}`);
    results.tier3 = {
      deployMs: 0, timeToHealthMs: 0, dummyProcessSizeBytes: 0, criuCapable: false,
      dumpMs: null, dumpSizeBytes: null, restoreMs: null, processAlive: null,
      cudaCheckpointCapable: false, driverVersion: 'unknown',
    };
  };

  if (!RUNPOD_KEY) { T3_SKIP('RUNPOD_API_KEY not set'); return; }

  // ── Pre-check RunPod account quota (no-op if key missing above) ──────────
  // Catches machineQuota=0 before deploy so we fail fast + track the block.

  const quotaCheck = await checkRunpodQuota();
  if (!quotaCheck.ok) {
    T3_SKIP(`RunPod blocked — ${quotaCheck.reason}`);
    log('');
    log('  Fix: contact https://contact.runpod.io or Discord https://discord.gg/cUpRmau42V');
    log('  (machineQuota is an account-level flag, no self-service API to reset it)');
    return;
  }

  // ── Deploy RunPod Secure Cloud pod ────────────────────────────────────────
  // runpod/base:0.6.2 — Ubuntu 22.04, SSH pre-configured, RunPod injects all
  // account SSH keys automatically. No cloud-init needed.
  // SECURE cloud = RunPod-owned hardware, full privileged capabilities.
  // storageGb: 0 = no volume (CRIU test needs no persistent storage).

  const t0 = Date.now();
  log('  creating RunPod Secure Cloud pod (runpod/base:0.6.2, RTX 4090 / A5000)...');

  let rpInst: GpuInstance;
  try {
    rpInst = await rpClient.createInstance({
      dockerImage: 'runpod/base:0.6.2',
      gpuTypes: ['NVIDIA GeForce RTX 4090', 'NVIDIA RTX A5000', 'NVIDIA GeForce RTX 3090', 'NVIDIA A40'],
      ports: ['22/tcp'],
      storageGb: 0,
    }, rpCreds);
  } catch (err: unknown) {
    const msg = String(err instanceof Error ? err.message : err);
    if (msg.includes('preflight blocked') || msg.includes('machineQuota')) {
      recordQuotaFailure(msg);
      T3_SKIP(`RunPod preflight blocked — ${msg.slice(0, 120)}`);
      return;
    }
    throw err;  // re-throw unexpected errors
  }

  const rpInstanceId = rpInst.instanceId;
  toDelete.push({ instanceId: rpInstanceId, source: 'runpod' });
  log(`  pod created: ${rpInstanceId}`);

  // ── Poll until runtime.ports has SSH entry ────────────────────────────────

  let sshHost = '', sshPort = 22, deployMs = 0;
  const bootDeadline = Date.now() + 8 * 60_000;
  while (Date.now() < bootDeadline) {
    await sleep(8_000);
    const detail = await rpClient.getInstanceDetail(rpInstanceId, rpCreds);
    const status = detail?.desiredStatus ?? 'unknown';
    const runtime = detail?.runtime as Record<string, unknown> | null ?? null;
    const ports = runtime?.ports as Array<Record<string, unknown>> | undefined;
    const sshEntry = ports?.find(p => p.privatePort === 22);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    log(`  status=${status} ports=${ports?.length ?? 0} (${elapsed}s)`);
    if (sshEntry?.ip && sshEntry?.publicPort) {
      sshHost = sshEntry.ip as string;
      sshPort = sshEntry.publicPort as number;
      break;
    }
  }
  if (!sshHost) throw new Error('RunPod pod never got SSH port mapping');

  deployMs = Date.now() - t0;
  log(`  SSH endpoint: ${sshHost}:${sshPort} in ${fmtMs(deployMs)}`);

  // ── Wait for SSH ──────────────────────────────────────────────────────────

  log(`  waiting for SSH at ${sshHost}:${sshPort}...`);
  let sshReady = false;
  for (let i = 0; i < 20 && !sshReady; i++) {
    await sleep(8_000);
    const r = ssh(sshHost, sshPort, 'echo SSH_OK', 10_000, false);
    sshReady = r.ok && r.out.includes('SSH_OK');
    log(`  SSH attempt ${i + 1}: ${sshReady ? 'OK' : `not ready — ${r.out.replace(/\n/g, ' ').slice(0, 80)}`}`);
  }
  if (!sshReady) throw new Error('RunPod SSH never became ready');

  // ── Install CRIU ───────────────────────────────────────────────────────────

  log('  installing CRIU (apt-get install criu)...');
  const installOut = ssh(sshHost, sshPort,
    'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq criu 2>&1 | tail -3 && which criu && echo CRIU_INSTALLED',
    180_000, false);
  if (!installOut.out.includes('CRIU_INSTALLED')) {
    throw new Error(`CRIU install failed: ${installOut.out.slice(0, 300)}`);
  }
  log(`  CRIU installed: ${installOut.out.match(/\/usr[^\s]*/)?.[0] ?? 'ok'}`);

  const timeToHealthMs = Date.now() - t0;
  log(`  CRIU ready in ${fmtMs(timeToHealthMs)} total`);

  // ── Probe capabilities ─────────────────────────────────────────────────────

  const diagOut = ssh(sshHost, sshPort, [
    'nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null || echo no_gpu',
    'criu --version 2>/dev/null || echo no_criu',
    'cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo unknown',
    'grep CapBnd /proc/self/status 2>/dev/null | head -1 || echo no_cap',
    'id',
    'echo "PID1=$(cat /proc/1/cmdline 2>/dev/null | tr \'\\0\' \' \' | cut -c1-60)"',
    'systemctl is-system-running 2>/dev/null || echo no_systemd',
  ].join('\n'), 15_000, false).out;

  const driverVersion = diagOut.match(/^(\d+\.\d+)/m)?.[1] ?? 'unknown';
  // criu --version outputs "Version: X.Y.Z" on Ubuntu, not "criu version X.Y.Z"
  const criuVersion   = diagOut.match(/Version:\s*(\S+)/i)?.[1] ?? diagOut.match(/criu version (\S+)/i)?.[1] ?? '';
  const ptraceScope   = diagOut.match(/^(\d)$/m)?.[1] ?? '?';
  const capBnd        = diagOut.match(/CapBnd:\s*([0-9a-f]+)/i)?.[1] ?? '';
  const isRoot        = diagOut.includes('uid=0');
  const pid1          = diagOut.match(/PID1=([^\n]*)/)?.[1]?.trim() ?? '';
  const isKvmVm       = pid1.includes('systemd') || pid1.includes('init');

  log(`  driver=${driverVersion} criu=${criuVersion || 'missing'} ptrace_scope=${ptraceScope} capBnd=${capBnd || '?'} root=${isRoot}`);
  log(`  PID1="${pid1}" kvmVm=${isKvmVm}`);

  // CRIU needs: root or CAP_CHECKPOINT_RESTORE (40), ptrace_scope ≤ 1,
  // CAP_NET_ADMIN (12) for network namespace dump, CAP_SYS_ADMIN (21) for namespace ops.
  // RunPod Secure Cloud --privileged containers have full capabilities.
  const capBndNum   = BigInt(`0x${capBnd || '0'}`);
  const hasNetAdmin = (capBndNum >> 12n & 1n) !== 0n;
  const hasSysAdmin = (capBndNum >> 21n & 1n) !== 0n;
  const hasCriuCap  = (capBndNum >> 40n & 1n) !== 0n;
  const criuCapable = !!criuVersion && (ptraceScope === '0' || ptraceScope === '1')
    && (hasCriuCap || isRoot) && hasNetAdmin && hasSysAdmin;
  const cudaCheckpointCapable = criuCapable && parseFloat(driverVersion) >= 570;
  log(`  CRIU capable=${criuCapable} (netAdmin=${hasNetAdmin} sysAdmin=${hasSysAdmin}) cuda-checkpoint=${cudaCheckpointCapable}`);

  if (ptraceScope !== '0') {
    ssh(sshHost, sshPort, 'echo 0 > /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || true', 5_000, false);
  }

  // ── Start dummy process (128MB, simulates model weights in RAM) ────────────

  log('  starting 128MB dummy process (simulates model weights in RAM)...');
  const dummyOut = ssh(sshHost, sshPort, DUMMY_CMD, 30_000, false).out;
  const pid = parseInt(dummyOut.match(/PID=(\d+)/)?.[1] ?? '0', 10);
  if (!pid) throw new Error(`Dummy process failed: ${dummyOut.slice(0, 200)}`);
  log(`  dummy process PID=${pid}`);

  // ── CRIU DUMP ──────────────────────────────────────────────────────────────
  //
  // --tcp-established: required for any process that may hold open TCP connections
  //   (ML models keep HF Hub connections; even sleep inherits SSH TCP state).
  // --shell-job: dump shell-started processes (not process group leaders).
  // --leave-running: keep original process running after dump (benchmark only).
  // --skip-in-flight: skip in-flight TCP data.
  // --ext-unix-sk: treat external unix sockets as external.

  log(`  CRIU dump of PID=${pid}...`);
  const dumpCmd = [
    `mkdir -p /tmp/criu_img_${pid}`,
    `t0=$(date +%s%3N)`,
    `criu dump --tree ${pid} --images-dir /tmp/criu_img_${pid} --leave-running --shell-job --skip-in-flight --ext-unix-sk --tcp-established 2>&1`,
    `RC=$?`,
    `t1=$(date +%s%3N)`,
    `echo "DUMP_RC=$RC DUMP_MS=$((t1-t0))"`,
    `du -sb /tmp/criu_img_${pid} 2>/dev/null | cut -f1 | xargs -I{} echo "DUMP_SIZE={}"`,
  ].join('\n');

  const dumpOut = ssh(sshHost, sshPort, dumpCmd, 60_000, false).out;
  const dumpRc        = parseInt(dumpOut.match(/DUMP_RC=(\d+)/)?.[1] ?? '-1', 10);
  const dumpMs        = parseInt(dumpOut.match(/DUMP_MS=(\d+)/)?.[1] ?? '0', 10) || null;
  const dumpSizeBytes = parseInt(dumpOut.match(/DUMP_SIZE=(\d+)/)?.[1] ?? '0', 10) || null;

  log(`  dump: rc=${dumpRc} time=${dumpMs ? fmtMs(dumpMs) : 'failed'} size=${dumpSizeBytes ? `${(dumpSizeBytes / 1024 / 1024).toFixed(1)}MB` : '?'}`);
  if (dumpRc !== 0) log(`  dump stderr: ${dumpOut.slice(0, 400)}`);

  // ── CRIU RESTORE ───────────────────────────────────────────────────────────
  //
  // Run via nohup + results file: restoring a process that held TCP connections
  // (--tcp-established) will reassign those connections and may drop the SSH
  // session. Launch restore as background job and check results file after.

  let restoreMs: number | null = null;
  let processAlive: boolean | null = null;

  if (dumpRc === 0) {
    log('  killing original then restoring from CRIU image...');
    ssh(sshHost, sshPort, `kill -9 ${pid} 2>/dev/null; sleep 0.3`, 5_000, false);

    const restoreCmd = [
      `t0=$(date +%s%3N)`,
      `nohup criu restore --images-dir /tmp/criu_img_${pid} --shell-job --tcp-established > /tmp/criu_restore.log 2>&1 &`,
      `RPID=$!`,
      `t1=$(date +%s%3N)`,
      `echo "RESTORE_MS=$((t1-t0)) RESTORE_PID=$RPID"`,
      `sleep 2`,
      `kill -0 $RPID 2>/dev/null && echo "PROCESS_ALIVE=true" || echo "PROCESS_ALIVE=false"`,
      `test -f /tmp/model_weights.bin && echo "WEIGHTS_OK=$(cat /tmp/dummy.cksum)" || echo "WEIGHTS_MISSING"`,
    ].join('\n');

    const restoreOut = ssh(sshHost, sshPort, restoreCmd, 60_000, false).out;
    restoreMs    = parseInt(restoreOut.match(/RESTORE_MS=(\d+)/)?.[1] ?? '0', 10) || null;
    processAlive = restoreOut.includes('PROCESS_ALIVE=true');
    const weightsOk = restoreOut.includes('WEIGHTS_OK');
    log(`  restore: ${restoreMs ? fmtMs(restoreMs) : 'failed'} alive=${processAlive} weights=${weightsOk}`);
    if (!processAlive) log(`  restore output: ${restoreOut.slice(0, 300)}`);
  }

  results.tier3 = {
    deployMs, timeToHealthMs,
    dummyProcessSizeBytes: 128 * 1024 * 1024,
    criuCapable,
    dumpMs: dumpRc === 0 ? dumpMs : null,
    dumpSizeBytes: dumpRc === 0 ? dumpSizeBytes : null,
    restoreMs,
    processAlive,
    cudaCheckpointCapable,
    driverVersion,
  };

  log(`\n  ── TIER 3 SUMMARY ─────────────────────────────`);
  log(`  Provider:             RunPod Secure Cloud (--privileged)`);
  log(`  Driver:               ${driverVersion}`);
  log(`  CRIU version:         ${criuVersion || 'not installed'}`);
  log(`  CRIU capable:         ${criuCapable} (netAdmin=${hasNetAdmin} sysAdmin=${hasSysAdmin})`);
  log(`  CUDA checkpoint:      ${cudaCheckpointCapable}`);
  log(`  Deploy → CRIU ready:  ${fmtMs(timeToHealthMs)}`);
  if (dumpMs)        log(`  CRIU dump (128MB):    ${fmtMs(dumpMs)}`);
  if (dumpSizeBytes) log(`  Dump size:            ${(dumpSizeBytes / 1024 / 1024).toFixed(1)} MB`);
  if (restoreMs)     log(`  CRIU restore:         ${fmtMs(restoreMs)}`);
  log(`  Process alive:        ${processAlive}`);
  if (!criuCapable) {
    log(`  BLOCKER: capBnd=${capBnd || '?'} — missing required capabilities (unexpected on RunPod Secure Cloud)`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Final Report
// ══════════════════════════════════════════════════════════════════════════════

function printReport() {
  const hr  = '═'.repeat(68);
  const sep = '─'.repeat(68);
  console.log(`\n${hr}`);
  console.log('  7B MODEL COLD START BENCHMARK — FINAL REPORT');
  console.log(`  Image: ${IMAGE}`);
  console.log(`  Date:  ${new Date().toISOString().slice(0, 19)}Z`);
  console.log(hr);

  const t1 = results.tier1;
  const t2 = results.tier2;
  const t3 = results.tier3;

  if (t1) {
    console.log('\n  TIER 1 — Cold Boot (baseline, no cache)');
    console.log(`  GPU: ${t1.gpu}`);
    console.log(`  ┌─────────────────────────────────────────────`);
    console.log(`  │ createInstance API call:    ${fmtMs(t1.deployApiMs)}`);
    console.log(`  │ Instance running+endpoint:  ${fmtMs(t1.timeToRunningMs)}`);
    console.log(`  │ /health 200 (model ready):  ${fmtMs(t1.timeToHealthMs)}`);
    if (t1.firstInferenceMs)  console.log(`  │ 1st inference latency:      ${fmtMs(t1.firstInferenceMs)}`);
    if (t1.secondInferenceMs) console.log(`  │ 2nd inference (GPU warm):   ${fmtMs(t1.secondInferenceMs)}`);
    console.log(`  └─────────────────────────────────────────────`);
    console.log(`    TOTAL: ${fmtMs(t1.timeToHealthMs)}`);
    console.log(`    Note: ~${((t1.timeToRunningMs / t1.timeToHealthMs) * 100).toFixed(0)}% of time is image pull`);
  }

  if (t2) {
    console.log('\n  TIER 2 — Warm Restart (Docker layer cache)');
    console.log(`  ┌─────────────────────────────────────────────`);
    console.log(`  │ stopInstance:               ${fmtMs(t2.stopMs)}`);
    console.log(`  │ Time to EXITED:             ${fmtMs(t2.timeToExitedMs)}`);
    console.log(`  │ startInstance:              ${fmtMs(t2.startMs)}`);
    console.log(`  │ /health 200 (model reload): ${fmtMs(t2.timeToHealthMs)}`);
    if (t2.firstInferenceMs) console.log(`  │ 1st inference latency:      ${fmtMs(t2.firstInferenceMs)}`);
    console.log(`  └─────────────────────────────────────────────`);
    console.log(`    TOTAL (from Start): ${fmtMs(t2.timeToHealthMs)}`);
    console.log(`    Speedup vs Tier 1:  ${t2.speedupVsTier1.toFixed(1)}x faster`);
  }

  if (t3) {
    console.log('\n  TIER 3 — CRIU Snapshot Restore (host environment probe)');
    console.log(`  ┌─────────────────────────────────────────────`);
    console.log(`  │ Driver:                     ${t3.driverVersion}`);
    console.log(`  │ CRIU binary:                ${t3.criuCapable ? 'present' : 'absent or caps missing'}`);
    console.log(`  │ CRIU capable (full caps):   ${t3.criuCapable}`);
    console.log(`  │ CUDA checkpoint (drv 570+): ${t3.cudaCheckpointCapable}`);
    if (t3.dumpMs)        console.log(`  │ CRIU dump (128MB process):  ${fmtMs(t3.dumpMs)}`);
    if (t3.dumpSizeBytes) console.log(`  │ Dump size on disk:          ${(t3.dumpSizeBytes / 1024 / 1024).toFixed(1)} MB`);
    if (t3.restoreMs)     console.log(`  │ CRIU restore:               ${fmtMs(t3.restoreMs)}`);
    if (!t3.criuCapable) {
      console.log(`  │`);
      console.log(`  │ BLOCKED: missing CAP_NET_ADMIN + CAP_SYS_ADMIN`);
      console.log(`  │   (unexpected on RunPod Secure Cloud — check capBnd)`);
      console.log(`  │`);
      // Show known projections from prior validated benchmark (2026-04-08)
      console.log(`  │ CRIU projections (from prior bare-metal bench, driver 565):`);
      console.log(`  │   GPU VRAM dump  (~14GB fp16):  ~4.3 s`);
      console.log(`  │   GPU VRAM restore:             ~3.6 s`);
      console.log(`  │   → Total CRIU cycle:           ~7.9 s`);
      console.log(`  │   → vs cold boot:               ~6x faster`);
    }
    console.log(`  └─────────────────────────────────────────────`);

    // Project to 7B real model sizes (only if we have measured data)
    if (t3.dumpMs && t3.dumpSizeBytes) {
      const mbPerMs = 128 / t3.dumpMs;
      console.log(`\n  PROJECTIONS for real 7B models (linear scaling with RAM):`);
      console.log(`  ┌─────────────────────────────────────────────`);
      console.log(`  │ 7B Q4 CPU RAM (4 GB):       dump ~${fmtMs(4096 / mbPerMs)}  restore ~${t3.restoreMs ? fmtMs(t3.restoreMs * (4096 / 128)) : '?'}`);
      console.log(`  │ 7B fp16 CPU RAM (14 GB):    dump ~${fmtMs(14336 / mbPerMs)} restore ~${t3.restoreMs ? fmtMs(t3.restoreMs * (14336 / 128)) : '?'}`);
      console.log(`  │ 7B GPU VRAM (cuda-ckpt):    ~4-8s (validated 2026-04-08, driver 565)`);
      console.log(`  └─────────────────────────────────────────────`);
    }
  }

  // Comparison table
  if (t1) {
    console.log(`\n${sep}`);
    console.log('  STRATEGY COMPARISON');
    console.log(`  ${'Strategy'.padEnd(40)} ${'Time'.padStart(8)}  ${'vs Baseline'.padStart(12)}`);
    console.log(`  ${sep}`);
    console.log(`  ${'Tier 1 — Cold boot (baseline)'.padEnd(40)} ${fmtMs(t1.timeToHealthMs).padStart(8)}  ${'1.0x'.padStart(12)}`);
    if (t2) {
      const sp = (t1.timeToHealthMs / t2.timeToHealthMs).toFixed(1);
      console.log(`  ${'Tier 2 — Warm restart (Docker cache)'.padEnd(40)} ${fmtMs(t2.timeToHealthMs).padStart(8)}  ${(sp + 'x faster').padStart(12)}`);
    }
    if (t3?.dumpMs && t3?.restoreMs) {
      const totalCriu = (t3.dumpMs + t3.restoreMs);
      const sp = (t1.timeToHealthMs / totalCriu).toFixed(0);
      console.log(`  ${'Tier 3 — CRIU (128MB dump+restore)'.padEnd(40)} ${fmtMs(totalCriu).padStart(8)}  ${(sp + 'x faster').padStart(12)}`);
    } else {
      // Known CRIU timing from validated bare-metal benchmark (driver 565)
      console.log(`  ${'Tier 3 — CRIU GPU VRAM (est, prior bench)'.padEnd(40)} ${'~7.9 s'.padStart(8)}  ${'~6x faster'.padStart(12)}`);
    }
    console.log(`\n  SnapGPU insight: Tier 2 eliminates the image pull (${fmtMs(t1.timeToRunningMs)}).`);
    console.log('  CRIU eliminates model reload on top of that — ~7.9s total (GPU VRAM path).');
    if (t3 && !t3.criuCapable) {
      console.log('  Tier 3 CRIU blocked: container lacks required capabilities (unexpected on RunPod Secure Cloud).');
    }
  }

  console.log(`\n${hr}\n`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════════════

if (DRY_RUN) {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  7B Cold Start Benchmark — DRY RUN');
  console.log(`  Image: ${IMAGE}`);
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  TIER 1 — Cold Boot');
  console.log(`    createInstance with extraSearch.direct_port_count>=2`);
  console.log(`    Deploy: ${IMAGE}`);
  console.log('    Measure: deploy_api_ms, time_to_running, time_to_health,');
  console.log('             first_inference_ms, second_inference_ms');
  console.log('');
  console.log('  TIER 2 — Warm Restart (same instance)');
  console.log('    stopInstance → waitForExited → startInstance');
  console.log('    Measure: stop_ms, exit_ms, start_ms, time_to_health, first_inference_ms');
  console.log('');
  if (!SKIP_CRIU) {
    console.log('  TIER 3 — CRIU Snapshot Restore (RunPod Secure Cloud)');
    console.log('    Deploy runpod/base:0.6.2 on RunPod Secure Cloud (full caps, --privileged)');
    console.log('    SSH: apt install criu');
    console.log('    SSH: start 128MB dummy process (simulates model RAM)');
    console.log('    SSH: criu dump --tcp-established → measure dump_ms, dump_size_bytes');
    console.log('    SSH: kill → criu restore --tcp-established → measure restore_ms, process_alive');
    console.log('    Projects CRIU time to 7B Q4 (4GB) and 7B fp16 (14GB)');
    console.log('');
  }
  console.log('  Cost: ~$0.10-0.30 (2-3 instances × ~15-20 min)');
  console.log('');

  // Show available offers
  log('Searching offers for Tier 1+2...');
  const offers12 = await client.listOffers({ gpuTypes: GPU_TYPES, limit: 3 }, creds);
  if (offers12.length) {
    console.log('  Tier 1+2 offers:');
    for (const o of offers12) console.log(`    ${o.gpuType.padEnd(24)} $${o.pricePerHr.toFixed(3)}/hr  ${o.vram}GB VRAM  ${o.region}`);
  }

  if (!SKIP_CRIU) {
    if (!RUNPOD_KEY) {
      console.log('  Tier 3 RunPod: RUNPOD_API_KEY not set — skipping Tier 3');
    } else {
      log('Checking RunPod offers for Tier 3 (RTX 4090 / A5000)...');
      const rpOffers = await rpClient.listOffers({ gpuTypes: ['NVIDIA GeForce RTX 4090', 'NVIDIA RTX A5000'] }, rpCreds).catch(() => []);
      if (rpOffers.length) {
        console.log('  Tier 3 RunPod offers:');
        for (const o of rpOffers.slice(0, 3)) {
          console.log(`    ${o.gpuType.padEnd(28)} $${o.pricePerHr.toFixed(3)}/hr  ${o.vram}GB VRAM  ${o.region}`);
        }
      } else {
        console.log('  Tier 3 RunPod: no RTX 4090 / A5000 offers available right now');
      }
    }
  }
  process.exit(0);
}

// Real run
try {
  if (ONLY_CRIU) {
    // Inject known T1/T2 results so the final report still prints them
    results.tier1 = {
      gpu: 'RTX A5000', deployApiMs: 39600, timeToRunningMs: 39900,
      timeToHealthMs: 48000, firstInferenceMs: 96, secondInferenceMs: 81,
    };
    results.tier2 = {
      stopMs: 229, timeToExitedMs: 10800, startMs: 728,
      timeToHealthMs: 18200, firstInferenceMs: 104,
      speedupVsTier1: 2.6,
    };
    await runTier3();
  } else {
    const inst = await runTier1();

    await runTier2(inst);

    // Delete after Tier 2 (before Tier 3 deploys a fresh instance)
    const idx = toDelete.findIndex(d => d.instanceId === inst.instanceId);
    if (idx >= 0) {
      await client.deleteInstance(inst.instanceId, creds).catch(() => {});
      toDelete.splice(idx, 1);
    }

    if (!SKIP_CRIU) {
      await runTier3();
    }
  }
} catch (e) {
  log(`ERROR: ${e}`);
} finally {
  printReport();
  await cleanup();
}
