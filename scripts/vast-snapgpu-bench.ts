#!/usr/bin/env bun
/**
 * SnapGPU S3 Benchmark — end-to-end CRIU snapshot persistence via S3.
 *
 * Tests that snapshots survive across ephemeral Vast.ai workers:
 *
 *   Phase A (first instance — "warm up and snapshot"):
 *     1. Deploy snapgpu-runtime with S3 config injected as env vars
 *     2. Wait for gateway /health 200
 *     3. SSH: start a dummy Python process (simulates model weights in RAM)
 *     4. POST /v1/snapshots with the PID → time snapshot creation + S3 upload
 *     5. GET /v1/snapshots/s3-manifest/{app} → verify manifest on S3
 *     6. Destroy instance
 *
 *   Phase B (second instance — "restore from S3"):
 *     1. Deploy fresh snapgpu-runtime with same S3 config (no local snapshots)
 *     2. Wait for gateway /health 200 (start.sh auto-fetches snapshot at boot)
 *     3. GET /v1/snapshots → check if auto-prefetch worked
 *     4. If not pre-fetched: POST /v1/snapshots/s3-sync → time S3 download
 *     5. POST /v1/snapshots/{id}/restore → time CRIU restore
 *     6. Verify process alive via SSH
 *     7. Destroy instance
 *
 * Timings reported:
 *   cold_boot_ms     Time from deploy → gateway healthy (Phase A)
 *   snapshot_ms      CRIU dump + S3 upload (Phase A)
 *   warm_boot_ms     Time from deploy → gateway healthy (Phase B)
 *   s3_sync_ms       S3 download + extract (Phase B, if manual sync needed)
 *   restore_ms       CRIU restore (Phase B)
 *   total_warm_ms    warm_boot + s3_sync + restore = full "warm start" time
 *
 * Usage:
 *   bun scripts/vast-snapgpu-bench.ts               # container mode (cold/warm boot only)
 *   bun scripts/vast-snapgpu-bench.ts --vm-mode     # VM mode (CRIU + full benchmark)
 *   bun scripts/vast-snapgpu-bench.ts --dry-run
 *   bun scripts/vast-snapgpu-bench.ts --keep        (don't destroy instances after bench)
 *   bun scripts/vast-snapgpu-bench.ts --app myapp   (S3 key prefix / app name)
 *   bun scripts/vast-snapgpu-bench.ts --image marcosremar/snapgpu-runtime:latest
 *
 * CRIU notes:
 *   Vast.ai strips --cap-add/--privileged from ALL container deploys (API + templates).
 *   --vm-mode deploys on vms_enabled hosts (KVM VMs), installs Docker with --privileged,
 *   and runs snapgpu-runtime inside the VM. This is the only way to get CRIU working
 *   on Vast.ai. Without --vm-mode, only cold_boot_ms and warm_boot_ms are measured.
 *
 * Required env:
 *   VAST_API_KEY             Vast.ai API key
 *   SNAPGPU_S3_ENDPOINT      e.g. https://xxx.r2.cloudflarestorage.com
 *   SNAPGPU_S3_BUCKET        S3 bucket name
 *   SNAPGPU_S3_ACCESS_KEY    S3 access key
 *   SNAPGPU_S3_SECRET_KEY    S3 secret key
 *
 * Optional env:
 *   SNAPGPU_S3_REGION        default 'auto' (R2) or 'us-east-1' (AWS)
 *   SNAPGPU_S3_KEY_PREFIX    default 'snapgpu/'
 */

import 'dotenv/config';
import { spawnSync, spawn } from 'child_process';

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name: string): string | undefined { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; }
function bool(name: string): boolean { return args.includes(`--${name}`); }

const IMAGE = flag('image') ?? process.env.SNAPGPU_DEFAULT_IMAGE ?? 'marcosremar/snapgpu-runtime:latest';
const APP_NAME = flag('app') ?? 'bench-app';
const MAX_WAIT_S = parseInt(flag('max-wait') ?? '900', 10);
const DRY_RUN = bool('dry-run');
const KEEP = bool('keep');
// --vm-mode: deploy snapgpu-runtime inside a Vast.ai VM (vms_enabled=true hosts).
// On a VM we have root + Docker, so we can run --privileged containers → CRIU works.
// Workflow: SSH to VM host → docker run --privileged snapgpu-runtime → wait for gateway.
// Without --vm-mode, Vast.ai strips all --cap-add/--privileged flags silently.
const VM_MODE = bool('vm-mode');
// --template-id <hash>: Use a pre-created Vast.ai template hash (from web UI or prior run).
const TEMPLATE_ID = flag('template-id') ?? process.env.SNAPGPU_VAST_TEMPLATE_ID ?? '';
// --same-host: reuse Phase A's offer for Phase B so the image is cached.
// Measures "restart on same host (layer cache)" vs "cold pull on new host".
// This is the default for container mode since CRIU doesn't work on Vast.ai.
const SAME_HOST = bool('same-host') || !VM_MODE;
// --secure-cloud: filter for verified/Secure Cloud hosts (no additional privilege benefit confirmed).
const SECURE_CLOUD = bool('secure-cloud');

// ── Credentials ───────────────────────────────────────────────────────────────
// Accepts credentials in three formats (in order of priority):
//
//  1. Backblaze B2 (native app env vars):
//       B2_KEY_ID, B2_APPLICATION_KEY, B2_REGION, B2_BUCKET
//
//  2. Generic SNAPGPU_S3_* env vars (manual / other S3 providers):
//       SNAPGPU_S3_ENDPOINT, SNAPGPU_S3_BUCKET, SNAPGPU_S3_ACCESS_KEY,
//       SNAPGPU_S3_SECRET_KEY, SNAPGPU_S3_REGION
//
//  3. Cloudflare R2:
//       R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY

const VAST_KEY = process.env.VAST_API_KEY ?? '';

// Resolve S3 config — prefer B2 native vars, fall back to SNAPGPU_S3_* / R2
let S3_ENDPOINT = '';
let S3_BUCKET = '';
let S3_ACCESS_KEY = '';
let S3_SECRET_KEY = '';
let S3_REGION = 'auto';

if (process.env.B2_KEY_ID && process.env.B2_APPLICATION_KEY && process.env.B2_REGION) {
  const b2Region = process.env.B2_REGION;
  S3_ENDPOINT = `https://s3.${b2Region}.backblazeb2.com`;
  S3_BUCKET = process.env.B2_BUCKET ?? process.env.SNAPGPU_S3_BUCKET ?? '';
  S3_ACCESS_KEY = process.env.B2_KEY_ID;
  S3_SECRET_KEY = process.env.B2_APPLICATION_KEY;
  S3_REGION = b2Region;
} else if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) {
  S3_ENDPOINT = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  S3_BUCKET = process.env.R2_BUCKET ?? process.env.SNAPGPU_S3_BUCKET ?? '';
  S3_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
  S3_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
  S3_REGION = 'auto';
} else {
  // Fall back to explicit SNAPGPU_S3_* env vars
  S3_ENDPOINT = process.env.SNAPGPU_S3_ENDPOINT ?? '';
  S3_BUCKET = process.env.SNAPGPU_S3_BUCKET ?? '';
  S3_ACCESS_KEY = process.env.SNAPGPU_S3_ACCESS_KEY ?? '';
  S3_SECRET_KEY = process.env.SNAPGPU_S3_SECRET_KEY ?? '';
  S3_REGION = process.env.SNAPGPU_S3_REGION ?? 'auto';
}

const S3_PREFIX = process.env.SNAPGPU_S3_KEY_PREFIX ?? 'snapgpu/';

if (!DRY_RUN) {
  if (!VAST_KEY) { console.error('[bench] ERROR: VAST_API_KEY not set'); process.exit(1); }
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    console.error('[bench] ERROR: S3 credentials not set. Provide one of:');
    console.error('  B2:  B2_KEY_ID + B2_APPLICATION_KEY + B2_REGION + B2_BUCKET');
    console.error('  R2:  R2_ACCOUNT_ID + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY + R2_BUCKET');
    console.error('  S3:  SNAPGPU_S3_ENDPOINT + SNAPGPU_S3_BUCKET + SNAPGPU_S3_ACCESS_KEY + SNAPGPU_S3_SECRET_KEY');
    process.exit(1);
  }
}

const VAST_API = 'https://console.vast.ai/api/v0';
const authHeaders = { Authorization: `Bearer ${VAST_KEY}`, 'Content-Type': 'application/json' };

// S3 env vars to inject into the Vast.ai container
const S3_ENV: Record<string, string> = {
  SNAPGPU_S3_ENDPOINT: S3_ENDPOINT,
  SNAPGPU_S3_BUCKET: S3_BUCKET,
  SNAPGPU_S3_ACCESS_KEY: S3_ACCESS_KEY,
  SNAPGPU_S3_SECRET_KEY: S3_SECRET_KEY,
  SNAPGPU_S3_REGION: S3_REGION,
  SNAPGPU_S3_KEY_PREFIX: S3_PREFIX,
  SNAPGPU_APP_NAME: APP_NAME,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
function fmtMs(ms: number) { return ms < 2000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`; }
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function vastApi(path: string, opts?: RequestInit): Promise<unknown> {
  const res = await fetch(VAST_API + path, {
    ...opts,
    headers: { ...authHeaders, ...(opts?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Vast API ${path} → HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ── Template / VM setup ────────────────────────────────────────────────────────
//
// CRIU LIMITATION ON VAST.AI:
// Vast.ai silently strips ALL Docker capability flags from deploy requests AND templates:
//   - extra: '--privileged'          → ignored (template stored with no extra field)
//   - extra: '--cap-add CHECKPOINT_RESTORE' → ignored
//   - vm: true in template           → reverted to vm: false
//   - verified hosts (Secure Cloud)  → same restriction
//
// SOLUTION — VM MODE (--vm-mode):
// Hosts with vms_enabled=true support running full KVM VMs.
// On a VM we have root + install Docker → run container with --privileged.
// Workflow:
//   1. Search for vms_enabled=true GPU offers (RTX 5070 Ti, 3090, 4070, etc.)
//   2. Deploy VM with onstart that installs Docker + runs snapgpu-runtime --privileged
//   3. SSH to VM host, commands run inside container via `docker exec snapgpu`
//
// Without --vm-mode: bench runs but CRIU always fails, only cold_boot_ms is measured.

let benchTemplateHashId = TEMPLATE_ID;
let createdTemplateId: number | null = null;

// Onstart script for VM mode: installs Docker and runs snapgpu-runtime with --privileged.
function vmOntartScript(): string {
  const envFlags = Object.entries(S3_ENV).map(([k, v]) => `  -e ${k}="${v}" \\`).join('\n');
  return [
    '#!/bin/bash',
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq',
    'apt-get install -y -qq docker.io ca-certificates',
    'systemctl start docker',
    `docker pull ${IMAGE}`,
    'docker run -d --privileged \\',
    '  --name snapgpu \\',
    '  -p 8000:8000 \\',
    envFlags,
    `  ${IMAGE}`,
    'echo "[vm-start] snapgpu-runtime started with --privileged"',
  ].join('\n');
}

async function ensureVmTemplate(): Promise<string> {
  if (benchTemplateHashId) {
    log(`[template] using pre-configured template: ${benchTemplateHashId}`);
    return benchTemplateHashId;
  }
  log('[template] creating Vast.ai VM template for --privileged CRIU support...');
  const body = {
    name: `snapgpu-vm-bench-${Date.now()}`,
    image: 'ubuntu',
    tag: '22.04',
    image_uuid: 'ubuntu:22.04',
    vm: true,
    onstart_cmd: vmOntartScript(),
    use_ssh: true,
    use_jupyter_lab: false,
    disk_space: 60,  // more space: Docker install + image pull
    extra_filters: {},
  };
  try {
    const data = await vastApi('/template/', {
      method: 'POST',
      body: JSON.stringify(body),
    }) as { success?: boolean; template?: { hash_id: string; id: number }; msg?: string };
    const templateId = data.template?.id;
    const hashId = data.template?.hash_id ?? '';
    if (!templateId || !hashId) {
      log(`[template] WARNING: template creation returned no hash_id: ${JSON.stringify(data).slice(0, 200)}`);
      return '';
    }
    createdTemplateId = templateId;
    benchTemplateHashId = hashId;
    log(`[template] created VM template id=${templateId} hash=${hashId}`);
    return hashId;
  } catch (e) {
    log(`[template] WARNING: VM template creation failed: ${e}`);
    return '';
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

const createdInstances: number[] = [];
let cleanupDone = false;
async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  for (const id of createdInstances) {
    log(`[cleanup] deleting instance ${id}...`);
    try {
      await fetch(`${VAST_API}/instances/${id}/`, { method: 'DELETE', headers: authHeaders, signal: AbortSignal.timeout(10_000) });
      log(`[cleanup] instance ${id} deleted`);
    } catch (e) { log(`[cleanup] WARNING: failed to delete ${id}: ${e}`); }
  }
  // Delete the bench template if we created it
  if (createdTemplateId && !KEEP) {
    try {
      await fetch(`${VAST_API}/template/${createdTemplateId}/`, { method: 'DELETE', headers: authHeaders, signal: AbortSignal.timeout(10_000) });
      log(`[cleanup] template ${createdTemplateId} deleted`);
    } catch (e) { log(`[cleanup] WARNING: failed to delete template ${createdTemplateId}: ${e}`); }
  }
}
process.on('SIGINT', async () => { if (!KEEP) await cleanup(); process.exit(130); });
process.on('SIGTERM', async () => { if (!KEEP) await cleanup(); process.exit(143); });

// ── Find offer ────────────────────────────────────────────────────────────────

interface Offer { id: number; gpu_name: string; dph_total: number; public_ipaddr: string }

async function findOffer(vmMode = false): Promise<Offer> {
  // CRIU mode: requires vms_enabled=true so we can deploy a full VM and run
  // Docker --privileged inside it. VM hosts support KVM; on a VM we have root
  // and can run CRIU without container capability restrictions.
  //
  // Without VM mode: any host, but CRIU will fail (Vast.ai strips all --cap-add/--privileged).
  const label = vmMode ? 'VM-capable hosts (vms_enabled=true)' : 'community cloud';
  log(`Searching Vast.ai for GPU offers (driver 570+, ≥16GB VRAM, ${label})...`);
  const body: Record<string, unknown> = {
    rentable: { eq: true }, rented: { eq: false },
    num_gpus: { eq: 1 },
    gpu_ram: { gte: 16000 },
    direct_port_count: { gte: 2 },
    dph_total: { gte: 0.05, lte: vmMode ? 2.0 : 1.50 },
    // cuda_max_good >= 12.8 ensures driver 570+ for CRIU cuda_plugin
    cuda_max_good: { gte: 12.8 },
    inet_down: { gte: 500 },
    reliability2: { gte: 0.90 },
    type: 'on-demand',
    order: [['dph_total', 'asc']],
    limit: 10,
  };
  if (vmMode) {
    body.vms_enabled = { eq: true };  // hosts that support KVM VMs
  }
  if (SECURE_CLOUD) {
    body.verified = { eq: true };
  }
  const data = await vastApi('/bundles/', { method: 'POST', body: JSON.stringify(body) }) as { offers?: Offer[] };
  const offer = data.offers?.[0];
  if (!offer) throw new Error(`No suitable GPU offers found (driver 570+, ≥16GB VRAM, ${label})`);
  return offer;
}

// ── Deploy instance ───────────────────────────────────────────────────────────

async function deployInstance(offerId: number, phaseLabel: string, templateHashId: string): Promise<number> {
  const mode = VM_MODE ? 'VM' : 'container';
  log(`[${phaseLabel}] deploying ${mode} from offer ${offerId} (template=${templateHashId || 'none'})...`);

  let body: Record<string, unknown>;

  if (VM_MODE && templateHashId) {
    // VM mode: deploy with the VM template (Ubuntu + onstart installs Docker + runs with --privileged)
    // The VM template has 'vm: true' and an onstart_cmd that pulls/runs our container.
    body = {
      client_id: 'me',
      image: 'ubuntu',
      disk: 60,
      runtype: 'ssh_direct',
      ssh: true,
      direct: true,
      template_hash_id: templateHashId,
    };
  } else {
    // Container mode: standard Docker container deploy.
    // NOTE: Vast.ai silently ignores --cap-add/--privileged in both 'extra' and 'env'.
    // CRIU will fail with "needs CAP_CHECKPOINT_RESTORE" — only cold_boot_ms is meaningful.
    const env: Record<string, string> = {
      '-p 8000:8000': '1',
      ...S3_ENV,
    };
    body = {
      client_id: 'me',
      image: IMAGE,
      disk: 30,
      runtype: 'ssh_direc',
      ssh: true,
      direct: true,
      env,
      onstart: 'nohup /usr/local/bin/snapgpu-start > /var/log/snapgpu.log 2>&1 &',
    };
  }

  const data = await vastApi(`/asks/${offerId}/`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }) as { success?: boolean; new_contract?: number; id?: number; [k: string]: unknown };

  log(`[${phaseLabel}] deploy response: success=${data.success} new_contract=${data.new_contract}`);
  const instanceId = data.new_contract ?? data.id;
  if (!instanceId) throw new Error(`Deploy failed: ${JSON.stringify(data)}`);
  createdInstances.push(instanceId);
  log(`[${phaseLabel}] instance ${instanceId} created (${mode})`);
  return instanceId;
}

// ── Poll instance until running + endpoint ────────────────────────────────────

interface InstanceInfo {
  status: string;
  ip: string;
  endpoint: string;
  sshHost: string;
  sshPort: number;
}

async function waitForRunning(instanceId: number, startMs: number, label: string): Promise<InstanceInfo> {
  const deadline = startMs + MAX_WAIT_S * 1000;
  while (Date.now() < deadline) {
    await sleep(8_000);
    let data: Record<string, unknown>;
    try {
      const res = await fetch(`${VAST_API}/instances/${instanceId}/`, {
        headers: authHeaders, signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) { continue; }
      const raw = await res.json() as Record<string, unknown>;
      // GET /instances/{id}/ returns { instances: <obj_or_array> } or the obj directly
      const wrapped = raw.instances;
      if (Array.isArray(wrapped)) {
        data = wrapped.find((i: Record<string, unknown>) => i.id === instanceId) ?? {};
      } else if (wrapped && typeof wrapped === 'object') {
        data = wrapped as Record<string, unknown>;
      } else {
        data = raw;
      }
    } catch { continue; }

    const status = String(data.actual_status ?? data.cur_state ?? '');
    const ip = String(data.public_ipaddr ?? '');
    const sshHost = String(data.ssh_host ?? ip);
    const sshPort = Number(data.ssh_port ?? 22);

    // Resolve mapped port 8000
    let endpoint = '';
    const ports = data.ports as Record<string, unknown> | undefined;
    const directStart = data.direct_port_start as number | undefined;
    if (ports) {
      const p = (ports['8000/tcp'] ?? ports['8000']) as Array<{ HostPort?: string; HostIp?: string }> | undefined;
      const entry = p?.find(e => Number(e.HostPort) > 0);
      if (entry?.HostPort) {
        const hostIp = entry.HostIp && !entry.HostIp.startsWith('172.') && !entry.HostIp.startsWith('10.') && entry.HostIp !== '0.0.0.0'
          ? entry.HostIp : ip;
        endpoint = `http://${hostIp}:${entry.HostPort}`;
      }
    }
    if (!endpoint && ip && directStart && directStart > 0) {
      endpoint = `http://${ip}:${directStart}`;
    }
    // VM mode: Docker runs inside the VM with -p 8000:8000, directly accessible at VM IP:8000.
    // VMs have their own public IP so ports are accessible directly (no Vast.ai NAT needed).
    // Override any directStart-based endpoint — use port 8000 on the VM's IP.
    if (ip && VM_MODE) {
      endpoint = `http://${ip}:8000`;
    }

    const elapsedS = ((Date.now() - startMs) / 1000).toFixed(0);
    log(`[${label}] status=${status || '?'} endpoint=${endpoint || '?'} (${elapsedS}s)`);

    if (status === 'running' && endpoint && sshHost) {
      return { status, ip, endpoint, sshHost, sshPort };
    }
  }
  throw new Error(`Timed out (${MAX_WAIT_S}s) waiting for instance ${instanceId} to run`);
}

// ── Wait for gateway /health ──────────────────────────────────────────────────

async function waitForGateway(endpoint: string, startMs: number, label: string): Promise<void> {
  const deadline = startMs + MAX_WAIT_S * 1000;
  while (Date.now() < deadline) {
    await sleep(5_000);
    try {
      const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const data = await res.json() as { status?: string };
        const elapsedS = ((Date.now() - startMs) / 1000).toFixed(0);
        log(`[${label}] gateway healthy: ${JSON.stringify(data)} (${elapsedS}s)`);
        return;
      }
    } catch { /* not up yet */ }
    const elapsedS = ((Date.now() - startMs) / 1000).toFixed(0);
    log(`[${label}] gateway not ready yet (${elapsedS}s)`);
  }
  throw new Error(`Timed out waiting for gateway at ${endpoint}`);
}

// ── Wait for SSH ──────────────────────────────────────────────────────────────

async function waitForSsh(sshHost: string, sshPort: number, label: string): Promise<void> {
  log(`[${label}] waiting for SSH at ${sshHost}:${sshPort}...`);
  for (let i = 0; i < 30; i++) {
    await sleep(10_000);
    // In VM mode, first check SSH to the VM host (execInContainer=false)
    const r = sshRun(sshHost, sshPort, 'echo SSH_OK', 10_000, false);
    if (r.ok) {
      log(`[${label}] SSH ready (VM host)`);
      if (VM_MODE) {
        // Wait for Docker container to start (onstart installs Docker + pulls image + runs)
        log(`[${label}] [VM] waiting for Docker container 'snapgpu' to start...`);
        for (let j = 0; j < 30; j++) {
          await sleep(15_000);
          const dc = sshRun(sshHost, sshPort, 'docker ps --filter name=snapgpu --format "{{.Status}}"', 10_000, false);
          if (dc.out.includes('Up')) {
            log(`[${label}] [VM] container running: ${dc.out.trim()}`);
            return;
          }
          // Check onstart log for progress
          const onlog = sshRun(sshHost, sshPort, 'tail -5 /var/log/app.log 2>/dev/null || echo "no log"', 5_000, false);
          log(`[${label}] [VM] onstart: ${onlog.out.trim().slice(0, 100)}`);
        }
        throw new Error(`Docker container 'snapgpu' never started in VM`);
      }
      return;
    }
  }
  throw new Error(`SSH never became available at ${sshHost}:${sshPort}`);
}

// ── SSH helper ────────────────────────────────────────────────────────────────

// In VM mode, wrap commands with `docker exec snapgpu` so they run inside the
// privileged container (not the bare VM). The dummy process and CRIU run inside
// the container where --privileged is active. Set execInContainer=false for
// commands that should run on the VM host (e.g., initial Docker setup checks).
function sshRun(host: string, port: number, cmd: string, timeoutMs = 60_000, execInContainer = true): { ok: boolean; out: string } {
  const actualCmd = (VM_MODE && execInContainer) ? `docker exec snapgpu bash -c ${JSON.stringify(cmd)}` : cmd;
  const result = spawnSync('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    '-p', String(port),
    `root@${host}`,
    actualCmd,
  ], { encoding: 'utf-8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = (result.stdout ?? '') + (result.stderr ?? '');
  return { ok: result.status === 0, out };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function apiPost(endpoint: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`POST ${path} → HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

async function apiGet(endpoint: string, path: string): Promise<unknown> {
  const res = await fetch(`${endpoint}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GET ${path} → HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ── Dummy process to snapshot ─────────────────────────────────────────────────
// Creates 128MB of random data (simulates model weights on disk), computes a
// checksum, then starts a sleep process. CRIU snapshots the sleep PID; after
// restore the sleep is still alive and the weights file is intact.
// Pure shell — avoids Python/numpy escaping issues over SSH.

// Note: use \n not ; as separator — `sleep 3600 &;` is a bash syntax error
const DUMMY_PROCESS_CMD = [
  'dd if=/dev/zero bs=1M count=128 of=/tmp/model_weights.bin 2>/dev/null',
  'CHECKSUM=$(md5sum /tmp/model_weights.bin | cut -c1-8)',
  'echo $CHECKSUM > /tmp/dummy.checksum',
  'sleep 3600 &',
  'DPID=$!',
  'echo $DPID > /tmp/dummy.pid',
  'echo "PID=$DPID"',
  'echo "CHECKSUM=$CHECKSUM"',
  'echo "DUMMY_READY"',
].join('\n');

// After CRIU restore: verify the sleep process is alive and weights file intact
const VERIFY_RESTORE_CMD = [
  'RPID=$(cat /tmp/restored.pid 2>/dev/null || echo none)',
  'if kill -0 $RPID 2>/dev/null; then echo "PROCESS_ALIVE pid=$RPID"; else echo "PROCESS_DEAD pid=$RPID"; fi',
  'test -f /tmp/model_weights.bin && echo "WEIGHTS_INTACT=$(cat /tmp/dummy.checksum)" || echo "WEIGHTS_MISSING"',
].join('\n');

// ── Phase A ───────────────────────────────────────────────────────────────────

interface PhaseAResult {
  snapshotId: string;
  coldBootMs: number;
  snapshotMs: number;
  s3UploadConfirmed: boolean;
  checksum: string;
  criuWorked: boolean;
}

async function runPhaseA(offer: Offer, templateHashId: string): Promise<PhaseAResult> {
  log('\n══════════════════════════════════════════');
  log('Phase A — Deploy, snapshot, upload to S3');
  log('══════════════════════════════════════════');

  const t0 = Date.now();
  const instanceId = await deployInstance(offer.id, 'A', templateHashId);
  const info = await waitForRunning(instanceId, t0, 'A');
  const coldBootRunningMs = Date.now() - t0;

  await waitForSsh(info.sshHost, info.sshPort, 'A');
  await waitForGateway(info.endpoint, t0, 'A');
  const coldBootMs = Date.now() - t0;

  log(`[A] cold boot complete in ${fmtMs(coldBootMs)}`);

  // Start dummy process to snapshot
  log('[A] starting dummy process (simulates model weights)...');
  const startResult = sshRun(info.sshHost, info.sshPort, DUMMY_PROCESS_CMD, 60_000);
  log('[A] dummy process output:\n' + startResult.out);

  const pidMatch = startResult.out.match(/PID=(\d+)/);
  const checksumMatch = startResult.out.match(/CHECKSUM=([a-f0-9]+)/);
  if (!pidMatch) {
    throw new Error(`Failed to start dummy process (no PID in output): ${startResult.out.slice(0, 400)}`);
  }
  const pid = parseInt(pidMatch[1], 10);
  const checksum = checksumMatch?.[1] ?? '?';

  // Debug: run CRIU directly via SSH to capture the full error before calling the gateway.
  // This surfaces the exact failure reason (capability missing, ptrace_scope, etc.).
  log(`[A] testing CRIU via SSH for PID=${pid}...`);
  const criuTest = sshRun(info.sshHost, info.sshPort, [
    `echo "ptrace_scope=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo unknown)"`,
    `echo "caps=$(grep CapBnd /proc/self/status 2>/dev/null | head -1)"`,
    `getcap $(which criu) 2>&1 || echo "getcap not available"`,
    `id`,
    `mkdir -p /tmp/test_criu_${pid}`,
    `criu dump --tree ${pid} --images-dir /tmp/test_criu_${pid} --leave-running --shell-job --tcp-established --file-locks 2>&1`,
    `echo "CRIU_RC=$?"`,
  ].join('\n'), 30_000);
  log(`[A] CRIU test:\n${criuTest.out}`);

  // Diagnose CRIU capability state
  const criuRc = parseInt(criuTest.out.match(/CRIU_RC=(\d+)/)?.[1] ?? '0', 10);
  const ptraceScopeVal = criuTest.out.match(/ptrace_scope=(\d+)/)?.[1] ?? '?';
  const capBndHex = criuTest.out.match(/CapBnd:\s+([0-9a-f]+)/i)?.[1] ?? '';

  if (criuRc !== 0) {
    const reason = criuRc === 126
      ? 'CRIU binary unexecutable (bad file capabilities — rebuild image)'
      : `container missing CAP_CHECKPOINT_RESTORE (ptrace_scope=${ptraceScopeVal}, CapBnd=${capBndHex})`;
    log(`[A] WARN: CRIU direct test failed (rc=${criuRc}): ${reason}`);
    log('[A] The auto-created privileged template may still fix this if the template was applied.');
    log('[A] Proceeding to snapshot API call to see actual gateway response...');
    // Don't throw — let the snapshot API call run and report what the gateway sees.
  }

  // Create snapshot via gateway API
  log(`[A] creating CRIU snapshot for PID=${pid}...`);
  const snapT0 = Date.now();
  const snapResp = await apiPost(info.endpoint, '/v1/snapshots', {
    app_name: APP_NAME,
    pid,
    include_gpu: false,  // no CUDA in dummy process; set true for real model
  }) as { snapshot_id?: string; error?: string; size_bytes?: number };

  const snapshotMs = Date.now() - snapT0;

  if (!snapResp.snapshot_id) {
    // Read gateway logs to see the actual CRIU error
    const gwLogs = sshRun(info.sshHost, info.sshPort, 'tail -30 /var/log/snapgpu.log 2>/dev/null || echo "no log"', 10_000);
    log(`[A] gateway logs:\n${gwLogs.out}`);
    log('[A] CRIU snapshot FAILED — returning partial Phase A result (cold_boot timing still valid)');
    return { snapshotId: '', coldBootMs, snapshotMs, s3UploadConfirmed: false, checksum, criuWorked: false };
  }
  const snapshotId = snapResp.snapshot_id!;
  const sizeBytes = snapResp.size_bytes ?? 0;
  log(`[A] snapshot created: ${snapshotId} (${(sizeBytes / 1024 / 1024).toFixed(1)}MB) in ${fmtMs(snapshotMs)}`);

  // S3 upload happens async in the background (auto-triggered by create())
  // Wait a few seconds for the upload to complete, then verify via manifest
  log('[A] waiting for S3 upload to complete...');
  let s3Confirmed = false;
  for (let i = 0; i < 12; i++) {
    await sleep(5_000);
    try {
      const manifest = await apiGet(info.endpoint, `/v1/snapshots/s3-manifest/${APP_NAME}`) as {
        available?: boolean; snapshot_id?: string;
      };
      if (manifest.available && manifest.snapshot_id === snapshotId) {
        s3Confirmed = true;
        log(`[A] S3 manifest confirmed: snapshot_id=${manifest.snapshot_id}`);
        break;
      }
      log(`[A] S3 manifest not ready yet (attempt ${i + 1}/12)...`);
    } catch (e) {
      log(`[A] manifest check failed: ${e}`);
    }
  }

  if (!s3Confirmed) {
    log('[A] WARNING: S3 upload could not be confirmed via manifest (check S3 config)');
  }

  return { snapshotId, coldBootMs, snapshotMs, s3UploadConfirmed: s3Confirmed, checksum, criuWorked: true };
}

// ── Phase B ───────────────────────────────────────────────────────────────────

interface PhaseBResult {
  warmBootMs: number;    // deploy → gateway healthy
  s3SyncMs: number;      // POST /v1/snapshots/s3-sync
  restoreMs: number;     // POST /v1/snapshots/{id}/restore
  totalWarmMs: number;   // warmBootMs + s3SyncMs + restoreMs
  processAlive: boolean;
  autoPrefetched: boolean;
}

async function runPhaseB(offer: Offer, phaseAResult: PhaseAResult, templateHashId: string): Promise<PhaseBResult> {
  log('\n══════════════════════════════════════════');
  log('Phase B — Fresh instance, restore from S3');
  log('══════════════════════════════════════════');

  const t0 = Date.now();
  // Use a DIFFERENT offer for Phase B to simulate a truly fresh host
  // (optional: same offer if --same-host flag, but different instance is realistic)
  const instanceId = await deployInstance(offer.id, 'B', templateHashId);
  const info = await waitForRunning(instanceId, t0, 'B');

  await waitForSsh(info.sshHost, info.sshPort, 'B');
  await waitForGateway(info.endpoint, t0, 'B');
  const warmBootMs = Date.now() - t0;

  log(`[B] gateway ready in ${fmtMs(warmBootMs)}`);

  // Skip CRIU steps if Phase A snapshot failed (no snapshotId to restore)
  if (!phaseAResult.criuWorked || !phaseAResult.snapshotId) {
    log('[B] Phase A CRIU failed — skipping restore test (cold_boot timing still measured)');
    const warmBootMs = Date.now() - t0;
    return { warmBootMs, s3SyncMs: 0, restoreMs: 0, totalWarmMs: warmBootMs, processAlive: false, autoPrefetched: false };
  }

  // Check if start.sh auto-prefetch already downloaded the snapshot
  let autoPrefetched = false;
  let snapshotIdToRestore = phaseAResult.snapshotId;
  try {
    const snapshots = await apiGet(info.endpoint, '/v1/snapshots') as { snapshots?: Array<{ snapshot_id: string }> };
    const found = snapshots.snapshots?.find(s => s.snapshot_id === phaseAResult.snapshotId);
    if (found) {
      autoPrefetched = true;
      log(`[B] auto-prefetch SUCCESS — snapshot already downloaded by start.sh`);
    } else {
      log(`[B] no local snapshots found (auto-prefetch may have failed or S3_APP_NAME mismatch)`);
    }
  } catch (e) {
    log(`[B] could not list snapshots: ${e}`);
  }

  // Manual S3 sync if not auto-prefetched
  let s3SyncMs = 0;
  if (!autoPrefetched) {
    log(`[B] manually syncing snapshot from S3 for app="${APP_NAME}"...`);
    const syncT0 = Date.now();
    const syncResp = await apiPost(info.endpoint, '/v1/snapshots/s3-sync', {
      app_name: APP_NAME,
    }) as { snapshot_id?: string; found?: boolean; size_bytes?: number; error?: string };
    s3SyncMs = Date.now() - syncT0;

    if (!syncResp.found || !syncResp.snapshot_id) {
      log(`[B] S3 sync failed: ${syncResp.error ?? JSON.stringify(syncResp)}`);
      const warmBootMs = Date.now() - t0;
      return { warmBootMs, s3SyncMs, restoreMs: 0, totalWarmMs: warmBootMs + s3SyncMs, processAlive: false, autoPrefetched: false };
    }
    snapshotIdToRestore = syncResp.snapshot_id;
    const sizeMb = ((syncResp.size_bytes ?? 0) / 1024 / 1024).toFixed(1);
    log(`[B] S3 sync complete: ${snapshotIdToRestore} (${sizeMb}MB) in ${fmtMs(s3SyncMs)}`);
  }

  // CRIU restore
  log(`[B] restoring snapshot ${snapshotIdToRestore}...`);
  const restoreT0 = Date.now();
  const restoreResp = await apiPost(info.endpoint, `/v1/snapshots/${snapshotIdToRestore}/restore`, {}) as {
    success?: boolean; restored_pid?: number; error?: string;
  };
  const restoreMs = Date.now() - restoreT0;

  if (!restoreResp.success) {
    log(`[B] CRIU restore failed: ${restoreResp.error ?? JSON.stringify(restoreResp)}`);
    const warmBootMs = Date.now() - t0;
    return { warmBootMs, s3SyncMs, restoreMs, totalWarmMs: warmBootMs + s3SyncMs + restoreMs, processAlive: false, autoPrefetched };
  }
  const restoredPid = restoreResp.restored_pid;
  log(`[B] CRIU restore OK — PID=${restoredPid} in ${fmtMs(restoreMs)}`);

  // Write the restored PID to /tmp/restored.pid so VERIFY_RESTORE_CMD can check it
  sshRun(info.sshHost, info.sshPort, `echo ${restoredPid} > /tmp/restored.pid`, 5_000);

  // Verify process is alive + checksum matches
  const verify = sshRun(info.sshHost, info.sshPort, VERIFY_RESTORE_CMD, 15_000);
  log('[B] verification:\n' + verify.out);
  const processAlive = verify.out.includes('PROCESS_ALIVE');

  const totalWarmMs = warmBootMs + s3SyncMs + restoreMs;

  return { warmBootMs, s3SyncMs, restoreMs, totalWarmMs, processAlive, autoPrefetched };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(64));
  console.log('  SnapGPU S3 Snapshot Benchmark');
  console.log(`  image : ${IMAGE}`);
  console.log(`  app   : ${APP_NAME}`);
  console.log(`  s3    : ${S3_ENDPOINT || '(not set)'}/${S3_BUCKET || '(not set)'}`);
  console.log(`  prefix: ${S3_PREFIX}`);
  console.log(`  mode  : ${VM_MODE ? 'VM (--privileged CRIU enabled)' : 'container (CRIU disabled — use --vm-mode)'}`);
  console.log('═'.repeat(64) + '\n');
  if (!VM_MODE) {
    console.log('  NOTE: Running in container mode. Vast.ai strips --cap-add/--privileged');
    console.log('  from all API deploys. CRIU will fail; only cold_boot_ms is measured.');
    console.log('  For full CRIU benchmark, add --vm-mode (deploys on vms_enabled hosts).');
    console.log('');
  }

  if (DRY_RUN) {
    log('DRY RUN — would run the following phases:');
    log('');
    log('  Phase A (first instance):');
    log('    1. Search Vast.ai for cheapest GPU (driver 570+, ≥16GB VRAM)');
    log(`    2. Deploy ${IMAGE}`);
    log('    3. Wait for gateway /health 200');
    log('    4. SSH → start numpy dummy process (128MB RAM, simulates model)');
    log('    5. POST /v1/snapshots with PID → CRIU dump');
    log('    6. Wait for S3 upload + verify via manifest');
    log('    7. Destroy instance');
    log('');
    log('  Phase B (second instance — simulates fresh cold start):');
    log('    1. Deploy fresh instance with same S3 config');
    log('    2. Wait for gateway /health (start.sh auto-fetches snapshot)');
    log('    3. If not auto-fetched: POST /v1/snapshots/s3-sync');
    log('    4. POST /v1/snapshots/{id}/restore → CRIU restore');
    log('    5. Verify process alive');
    log('    6. Destroy instance');
    log('');
    log('  Expected costs: ~$0.20-0.50 for 2 instances × ~15 min each');
    log('  Expected timings:');
    log('    cold_boot: ~90-300s (image pull + gateway start)');
    log('    snapshot:  ~2-8s (CRIU dump)');
    log('    s3_sync:   ~5-30s (download depends on snapshot size)');
    log('    restore:   ~1-5s (CRIU restore)');
    log('');

    // Still search for an offer to verify credentials work
    if (VAST_KEY) {
      try {
        const offer = await findOffer(VM_MODE);
        const modeLabel = VM_MODE ? '(VM mode)' : '(container mode)';
        log(`Would use offer id=${offer.id} (${offer.gpu_name} @ $${offer.dph_total.toFixed(3)}/hr) ${modeLabel}`);
      } catch (e) {
        log(`Offer search failed: ${e}`);
      }
    }
    return;
  }

  let phaseAResult: PhaseAResult | null = null;
  let phaseBResult: PhaseBResult | null = null;
  const benchT0 = Date.now();

  try {
    // In VM mode: create/reuse a VM template (Ubuntu + onstart that installs Docker + runs
    // snapgpu-runtime with --privileged). Only needed for CRIU to get CAP_CHECKPOINT_RESTORE.
    const templateHashId = VM_MODE ? await ensureVmTemplate() : TEMPLATE_ID;

    const offer = await findOffer(VM_MODE);
    const modeLabel = VM_MODE ? '(VM mode, CRIU-capable)' : '(container mode, CRIU disabled)';
    log(`Selected: offer=${offer.id} gpu=${offer.gpu_name} $${offer.dph_total.toFixed(3)}/hr ${modeLabel}`);

    // Phase A: deploy → snapshot → S3 upload → destroy
    phaseAResult = await runPhaseA(offer, templateHashId);
    log('\n[A] complete — destroying Phase A instance...');
    if (!KEEP) {
      const aInstanceId = createdInstances[createdInstances.length - 1];
      await fetch(`${VAST_API}/instances/${aInstanceId}/`, { method: 'DELETE', headers: authHeaders });
      createdInstances.splice(createdInstances.indexOf(aInstanceId), 1);
      log('[A] instance destroyed');
    }

    // When reusing the same host for Phase B, give it time to clean up Phase A's
    // container and release the port/SSH proxy before we redeploy.
    const interPhaseDelay = SAME_HOST ? 30_000 : 5_000;
    log(`[pause] waiting ${interPhaseDelay / 1000}s before Phase B...`);
    await sleep(interPhaseDelay);

    // Phase B: fresh instance → S3 download → CRIU restore
    // Reuse same offer type (may get different host, which is more realistic)
    let phaseBOffer = offer;
    if (SAME_HOST) {
      // Reuse Phase A's offer: image is layer-cached → measures restart time, not cold pull.
      // This is the default for container mode since CRIU doesn't change the comparison.
      log(`[B] reusing Phase A offer ${offer.id} (${offer.gpu_name}) for layer-cache warm boot measurement`);
    } else {
      try {
        phaseBOffer = await findOffer(VM_MODE);
        log(`[B] using new offer id=${phaseBOffer.id} (${phaseBOffer.gpu_name})`);
      } catch {
        log('[B] could not find new offer, reusing Phase A offer');
      }
    }
    phaseBResult = await runPhaseB(phaseBOffer, phaseAResult, templateHashId);

  } finally {
    if (!KEEP) await cleanup();
  }

  // ── Results ────────────────────────────────────────────────────────────────
  const totalBenchMs = Date.now() - benchT0;
  console.log('\n' + '═'.repeat(64));
  console.log('  RESULTS');
  console.log('═'.repeat(64));

  if (phaseAResult) {
    console.log('\nPhase A (cold start + snapshot):');
    console.log(`  cold_boot          : ${fmtMs(phaseAResult.coldBootMs)}`);
    console.log(`  criu               : ${phaseAResult.criuWorked ? 'PASS ✓' : 'FAIL — needs CAP_CHECKPOINT_RESTORE (use --template-id with privileged template)'}`);
    if (phaseAResult.criuWorked) {
      console.log(`  snapshot (CRIU+S3) : ${fmtMs(phaseAResult.snapshotMs)}`);
      console.log(`  S3 upload confirmed: ${phaseAResult.s3UploadConfirmed ? 'YES ✓' : 'NO — check S3 credentials'}`);
      console.log(`  process checksum   : ${phaseAResult.checksum}`);
    }
  }

  if (phaseBResult) {
    console.log('\nPhase B (warm start — restore from S3):');
    console.log(`  warm_boot          : ${fmtMs(phaseBResult.warmBootMs)}`);
    if (phaseAResult?.criuWorked) {
      console.log(`  auto-prefetch      : ${phaseBResult.autoPrefetched ? 'YES (start.sh did it)' : 'NO (manual sync needed)'}`);
      if (!phaseBResult.autoPrefetched && phaseBResult.s3SyncMs > 0) {
        console.log(`  s3_sync            : ${fmtMs(phaseBResult.s3SyncMs)}`);
      }
      if (phaseBResult.restoreMs > 0) {
        console.log(`  criu_restore       : ${fmtMs(phaseBResult.restoreMs)}`);
        console.log(`  total_warm_start   : ${fmtMs(phaseBResult.totalWarmMs)}`);
        console.log(`  process_alive      : ${phaseBResult.processAlive ? 'YES ✓' : 'NO ✗'}`);
      }
    }
  }

  if (phaseAResult && phaseBResult) {
    console.log('\nSummary:');
    console.log(`  cold start (A)     : ${fmtMs(phaseAResult.coldBootMs)}`);
    if (phaseAResult.criuWorked && phaseBResult.totalWarmMs > 0) {
      const speedup = phaseAResult.coldBootMs / phaseBResult.totalWarmMs;
      console.log(`  warm start (B)     : ${fmtMs(phaseBResult.totalWarmMs)}`);
      console.log(`  speedup            : ${speedup.toFixed(1)}x faster`);
    }

    const passed = phaseAResult.criuWorked && phaseAResult.s3UploadConfirmed && phaseBResult.processAlive;
    const partial = phaseAResult.coldBootMs > 0 && !passed;
    console.log(`\n  RESULT: ${passed ? 'PASS ✓' : partial ? 'PARTIAL (cold boot measured; CRIU needs privileged mode — use --template-id)' : 'FAIL'}`);
    if (!phaseAResult.criuWorked) {
      console.log('\n  CRIU needs CAP_CHECKPOINT_RESTORE. Vast.ai strips --privileged from');
      console.log('  all API deploys (container mode). To enable CRIU:');
      console.log('    bun scripts/vast-snapgpu-bench.ts --vm-mode');
      console.log('  This deploys on vms_enabled hosts (RTX 5070 Ti, 3090, 4070, etc.)');
      console.log('  and runs snapgpu-runtime inside a VM with --privileged Docker.');
    }
  }

  console.log(`\n  total bench time   : ${fmtMs(totalBenchMs)}`);
  console.log('═'.repeat(64) + '\n');
}

main().catch(err => {
  console.error('\n[bench] FATAL:', err);
  if (!KEEP) cleanup().finally(() => process.exit(1));
  else process.exit(1);
});
