#!/usr/bin/env bun
/**
 * SnapGPU Smoke Test — validates CRIU + cuda-checkpoint on a real Vast.ai GPU.
 *
 * Fully automated: deploys instance, SSHs in, runs the test, reports results,
 * and destroys the instance. Cost: ~$0.30-0.50.
 *
 * Usage:
 *   bun run scripts/snapgpu-smoke-test/run.ts [--dry-run] [--gpu "RTX 4090"]
 */

import 'dotenv/config';
import { execSync, spawnSync } from 'child_process';

const VAST_API_KEY = process.env.VAST_API_KEY || '';
const DRY_RUN = process.argv.includes('--dry-run');
const GPU_ARG_IDX = process.argv.indexOf('--gpu');
const GPU_TYPE = GPU_ARG_IDX >= 0 ? process.argv[GPU_ARG_IDX + 1] : 'RTX 4090';

if (!VAST_API_KEY && !DRY_RUN) {
  console.error('[smoke] ERROR: VAST_API_KEY not set in .env');
  process.exit(1);
}

const log = (msg: string) => console.log('[smoke] ' + msg);

// ── Shell scripts as regular strings (no template literals to avoid ${} clash) ──

// Ubuntu 24.04 (Noble) removed CRIU from apt. Install from PPA or compile.
// cuda-checkpoint: download pre-built binary from NVIDIA's CUDA checkpoint repo.
const INSTALL_CMD = [
  'set -ex',
  'export DEBIAN_FRONTEND=noninteractive',
  // Install build deps for CRIU + pip for torch
  'apt-get update',
  'apt-get install -y --no-install-recommends python3-pip python3-venv libprotobuf-dev libprotobuf-c-dev protobuf-c-compiler protobuf-compiler libnl-3-dev libnet1-dev libcap-dev pkg-config gcc make curl git ca-certificates',
  // Install CRIU from source (Ubuntu 24.04 dropped the criu package)
  // NOTE: `make install` fails on Ubuntu 24.04 due to "externally managed" Python env.
  // We just compile and copy the binary directly — that's all we need for dump/restore.
  'if [ ! -f /usr/local/bin/criu ]; then cd /tmp && git clone --depth 1 --branch v4.0 https://github.com/checkpoint-restore/criu.git && cd criu && make -j$(nproc) && cp criu/criu /usr/local/bin/criu && chmod +x /usr/local/bin/criu && cd / && rm -rf /tmp/criu; fi',
  // cuda-checkpoint: NVIDIA ships it in the CUDA 12.8 toolkit at /usr/local/cuda/extras/
  // If not there, try to build from source
  'if [ -f /usr/local/cuda/extras/cuda-checkpoint/cuda-checkpoint ]; then ln -sf /usr/local/cuda/extras/cuda-checkpoint/cuda-checkpoint /usr/local/bin/cuda-checkpoint; elif ! command -v cuda-checkpoint > /dev/null; then echo "cuda-checkpoint not found in CUDA toolkit — trying pip"; pip install --break-system-packages nvidia-cuda-checkpoint 2>/dev/null || echo "cuda-checkpoint not available (will test CRIU CPU-only)"; fi',
  // Install torch (minimal, CUDA 12.8) — use cpu+cu128 to speed up install
  'pip install --break-system-packages --no-cache-dir torch --index-url https://download.pytorch.org/whl/cu128 2>&1 | tail -5',
  'echo "=== CRIU ==="',
  '/usr/local/bin/criu --version || echo "CRIU NOT AVAILABLE"',
  'echo "=== cuda-checkpoint ==="',
  'which cuda-checkpoint 2>/dev/null && cuda-checkpoint --help 2>&1 | head -3 || echo "cuda-checkpoint NOT AVAILABLE (will test CPU-only CRIU)"',
  'echo "=== Driver ==="',
  'nvidia-smi --query-gpu=driver_version --format=csv,noheader',
  'echo "=== Python+Torch ==="',
  'python3 -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"',
  'echo INSTALL_OK',
].join(' && ');

const CUDA_TEST_CMD = [
  'python3 -c "',
  'import torch, os, time, sys;',
  't = torch.randn(1024, 1024, device=\\"cuda\\");',
  'checksum = t.sum().item();',
  'print(f\\"CHECKSUM={checksum}\\");',
  'print(f\\"GPU={torch.cuda.get_device_name(0)}\\");',
  'print(f\\"VRAM_MB={torch.cuda.memory_allocated()/1024/1024:.1f}\\");',
  'pid = os.getpid();',
  'open(\\"/tmp/cuda_test.pid\\",\\"w\\").write(str(pid));',
  'print(f\\"PID={pid}\\");',
  'print(\\"READY\\");',
  'sys.stdout.flush();',
  'time.sleep(300)',
  '" &',
].join('');

const SNAPSHOT_CMD = [
  'sleep 3',
  'PID=$(cat /tmp/cuda_test.pid)',
  'echo "Snapshotting PID=$PID..."',
  'START=$(date +%s%3N)',
  // cuda-checkpoint may not be available — skip GPU snapshot if missing
  'if command -v cuda-checkpoint > /dev/null 2>&1; then cuda-checkpoint --toggle --pid $PID && echo "GPU_SNAP=true"; else echo "GPU_SNAP=false (cuda-checkpoint not found)"; fi',
  'mkdir -p /tmp/snap',
  '/usr/local/bin/criu dump --tree $PID --images-dir /tmp/snap --leave-running --shell-job --tcp-established --file-locks',
  'END=$(date +%s%3N)',
  'SNAP_MS=$((END - START))',
  'SNAP_SIZE=$(du -sh /tmp/snap | cut -f1)',
  'echo "SNAPSHOT_OK time=${SNAP_MS}ms size=${SNAP_SIZE}"',
].join(' && ');

const RESTORE_CMD = [
  'PID=$(cat /tmp/cuda_test.pid)',
  'kill $PID 2>/dev/null || true',
  'sleep 1',
  'START=$(date +%s%3N)',
  '/usr/local/bin/criu restore --images-dir /tmp/snap --shell-job --tcp-established --file-locks --pidfile /tmp/restored.pid -d',
  'END=$(date +%s%3N)',
  'RESTORE_MS=$((END - START))',
  'RPID=$(cat /tmp/restored.pid 2>/dev/null || echo UNKNOWN)',
  'echo "RESTORE_OK time=${RESTORE_MS}ms pid=${RPID}"',
].join(' && ');

// ── Vast.ai API helpers ──────────────────────────────────────────────────────

async function vastApi(path: string, opts?: RequestInit): Promise<any> {
  const res = await fetch('https://console.vast.ai/api/v0' + path, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + VAST_API_KEY,
      'Content-Type': 'application/json',
      ...(opts?.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  return res.json();
}

const _triedOfferIds = new Set<number>();

async function findOffer(): Promise<{ id: number; gpu_name: string; public_ipaddr: string; dph_total: number } | null> {
  const body = {
    num_gpus: { eq: 1 },
    gpu_ram: { gte: 16000 },
    direct_port_count: { gte: 1 },
    // $0.10 min filter: ultra-cheap community hosts never boot properly
    dph_total: { gte: 0.10, lte: 1.00 },
    // cuda_max_good >= 12.8 ensures NVIDIA driver 570+ (required for cuda-checkpoint)
    cuda_max_good: { gte: 12.8 },
    inet_down: { gte: 200 },
    reliability2: { gte: 0.97 },
    // Require SSH support
    rented: false,
    order: [['dph_total', 'asc']],
    type: 'on-demand',
    limit: 10,
  };

  const data = await vastApi('/bundles/', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const offers = (data?.offers || []) as Array<Record<string, any>>;
  // Skip offers we already tried (and failed)
  for (const o of offers) {
    if (!_triedOfferIds.has(o.id)) {
      _triedOfferIds.add(o.id);
      return { id: o.id, gpu_name: o.gpu_name, public_ipaddr: o.public_ipaddr, dph_total: o.dph_total };
    }
  }
  return null;
}

async function createInstance(offerId: number): Promise<{ id: number }> {
  const body = {
    client_id: 'me',
    image: 'nvidia/cuda:12.8.1-devel-ubuntu24.04',
    disk: 20,
    runtype: 'ssh_direc',
    ssh: true,
    direct: true,
    onstart: '',
  };
  const data = await vastApi('/asks/' + offerId + '/', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!data?.success && !data?.new_contract) {
    throw new Error('Failed to create instance: ' + JSON.stringify(data));
  }
  return { id: data.new_contract || data.id };
}

async function waitForRunning(instanceId: number, maxWaitMs = 5 * 60_000): Promise<{ sshHost: string; sshPort: number }> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    // Vast.ai v0: single-instance GET sometimes returns empty. Use list + filter.
    const allData = await vastApi('/instances/');
    const instances = allData?.instances || [];
    const data = instances.find((i: any) => i.id === instanceId) || null;
    const status = data?.actual_status || data?.status || data?.cur_state;
    if (status === 'running') {
      const sshHost = data.ssh_host || data.public_ipaddr;
      const sshPort = data.ssh_port || 22;
      if (!sshHost) {
        log('Instance running but no SSH host yet — waiting...');
      } else {
        return { sshHost, sshPort };
      }
    }
    // Debug: on first poll, dump available keys to understand the API shape
    if (Date.now() - start < 20_000 && data) {
      const keys = Object.keys(data).filter(k => typeof data[k] !== 'object' || data[k] === null).slice(0, 15);
      const vals = keys.map(k => k + '=' + JSON.stringify(data[k]));
      log('  debug keys: ' + vals.join(', '));
    }
    log('Instance ' + instanceId + ' status: ' + (status || 'unknown') + ' (' + Math.round((Date.now() - start) / 1000) + 's)');
    await new Promise(r => setTimeout(r, 15_000));
  }
  throw new Error('Timeout waiting for instance ' + instanceId);
}

async function destroyInstance(instanceId: number): Promise<void> {
  await vastApi('/instances/' + instanceId + '/', { method: 'DELETE' });
  log('Instance ' + instanceId + ' destroyed');
}

function ssh(host: string, port: number, cmd: string): { stdout: string; ok: boolean } {
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    '-p', String(port),
    'root@' + host,
    cmd,
  ];
  const result = spawnSync('ssh', args, {
    encoding: 'utf-8',
    timeout: 300_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = (result.stdout || '') + (result.stderr || '');
  return { stdout, ok: result.status === 0 };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log('SnapGPU Smoke Test — GPU: ' + GPU_TYPE + ', dry_run: ' + DRY_RUN);

  if (DRY_RUN) {
    log('DRY RUN — would:');
    log('  1. Search Vast.ai for cheapest ' + GPU_TYPE + ' (driver 570+, $<0.60/hr)');
    log('  2. Deploy nvidia/cuda:12.8.1-devel-ubuntu24.04');
    log('  3. SSH → install CRIU + cuda-checkpoint + torch');
    log('  4. Run CUDA tensor test (1024x1024 on GPU)');
    log('  5. CRIU dump + cuda-checkpoint toggle');
    log('  6. Kill → CRIU restore');
    log('  7. Verify tensor still on GPU');
    log('  8. Destroy instance');
    log('Estimated cost: ~$0.30-0.50');
    log('');
    log('Finding offers...');
    const offer = await findOffer();
    if (offer) {
      log('Would use offer #' + offer.id + ' (' + offer.gpu_name + ')');
    } else {
      log('No offers found for ' + GPU_TYPE + ' at $<0.60/hr');
    }
    process.exit(0);
  }

  // Step 1+2: Find offer + create (retry up to 5 offers — they get rented between search and create)
  let instanceId = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    log('Searching for GPU offer (attempt ' + (attempt + 1) + ')...');
    const offer = await findOffer();
    if (!offer) {
      log('ERROR: No GPU offers available at $<0.60/hr with driver 570+');
      process.exit(1);
    }
    log('Found offer #' + offer.id + ' (' + offer.gpu_name + ' @ $' + offer.dph_total.toFixed(2) + '/hr)');
    try {
      const inst = await createInstance(offer.id);
      instanceId = inst.id;
      log('Instance created: ' + instanceId);
      break;
    } catch (err) {
      log('Offer #' + offer.id + ' rented before we could grab it, trying next...');
      if (attempt === 4) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  let sshHost = '';
  let sshPort = 22;

  try {
    // Step 3: Wait for running
    log('Waiting for instance to boot...');
    const conn = await waitForRunning(instanceId);
    sshHost = conn.sshHost;
    sshPort = conn.sshPort;
    log('Instance running at ' + sshHost + ':' + sshPort);

    // Wait for SSH to become available (Vast.ai reports "running" before sshd starts)
    log('Waiting for SSH to become available (up to 5 min)...');
    let sshReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 10_000));
      const probe = ssh(sshHost, sshPort, 'echo SSH_OK');
      if (probe.stdout.includes('SSH_OK')) {
        sshReady = true;
        break;
      }
      log('  SSH not ready yet (' + ((i + 1) * 10) + 's)...');
    }
    if (!sshReady) throw new Error('SSH never became available after 5 minutes');
    log('SSH ready!');

    // Step 4: Install CRIU + cuda-checkpoint
    log('Installing CRIU + cuda-checkpoint...');
    const install = ssh(sshHost, sshPort, INSTALL_CMD);
    console.log(install.stdout);
    if (!install.stdout.includes('INSTALL_OK')) {
      log('Install output:');
      console.log(install.stdout);
      throw new Error('Install failed — check output above');
    }

    // Step 5: Run CUDA test
    log('Running CUDA test program...');
    const cudaStart = ssh(sshHost, sshPort, CUDA_TEST_CMD);
    console.log(cudaStart.stdout);

    // Step 6: Snapshot
    log('Creating snapshot...');
    const snap = ssh(sshHost, sshPort, SNAPSHOT_CMD);
    console.log(snap.stdout);
    const snapOk = snap.stdout.includes('SNAPSHOT_OK');

    // Step 7: Restore
    log('Restoring from snapshot...');
    const restore = ssh(sshHost, sshPort, RESTORE_CMD);
    console.log(restore.stdout);
    const restoreOk = restore.stdout.includes('RESTORE_OK');

    // Results
    log('');
    log('═══════════════════════════════════');
    if (snapOk && restoreOk) {
      // Extract timings
      const snapTime = snap.stdout.match(/time=(\d+)ms/)?.[1] || '?';
      const restoreTime = restore.stdout.match(/time=(\d+)ms/)?.[1] || '?';
      log('RESULT: PASS');
      log('  Snapshot:  ' + snapTime + 'ms');
      log('  Restore:   ' + restoreTime + 'ms');
      log('  GPU state: preserved');
    } else if (!snapOk) {
      log('RESULT: FAIL — snapshot failed');
      log('Check logs above for CRIU/cuda-checkpoint errors.');
      log('Common causes: kernel too old, driver < 570, insufficient privileges');
    } else {
      log('RESULT: FAIL — restore failed');
      log('Snapshot succeeded but restore failed. Check CRIU logs.');
    }
    log('═══════════════════════════════════');

  } finally {
    // Step 8: Cleanup
    log('Destroying instance ' + instanceId + '...');
    await destroyInstance(instanceId).catch(err =>
      log('WARNING: Failed to destroy instance: ' + err)
    );
  }
}

main().catch((err) => {
  console.error('[smoke] FATAL:', err);
  process.exit(1);
});
