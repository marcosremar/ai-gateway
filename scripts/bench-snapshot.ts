#!/usr/bin/env bun
/**
 * bench-snapshot.ts — Phase B end-to-end snapshot timing.
 *
 * Measures:
 *   1. Cold deploy (no snapshot) — baseline full pull+boot+model-load.
 *   2. Capture (criu dump + tar + R2 upload).
 *   3. Warm deploy (snapshot restore) — expected 3-8s per Modal's envelope.
 *
 * REQUIREMENTS
 * ─────────────────────────────────────────────────────────────────────────
 * Running this on Mac/laptop produces bogus numbers (Wi-Fi, CPU, disk are
 * systematically misleading — see memory/feedback_coldstart_bench_on_real_gpu.md).
 * ALWAYS run on a Vast.ai VM (RTX 4090 or better, NVMe, 2+ Gb/s NIC).
 *
 *   VAST_API_KEY                — needed for deploy
 *   R2_SNAPSHOTS_BUCKET          — bucket for the snapshot tarball
 *   R2_SNAPSHOTS_ACCESS_KEY      — R2 access key ID
 *   R2_SNAPSHOTS_SECRET_KEY      — R2 secret access key
 *   R2_SNAPSHOTS_ENDPOINT        — optional; defaults to the account's r2.cloudflarestorage.com
 *   BENCH_IMAGE                  — Docker image to test (default: marcosremar/babelcast-subtitle:latest)
 *   BENCH_GPU                    — GPU type (default: 'RTX 4090')
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────
 *   bun run scripts/bench-snapshot.ts cold      # cold deploy only
 *   bun run scripts/bench-snapshot.ts capture   # capture from an existing pod (needs POD_SSH + POD_PORT)
 *   bun run scripts/bench-snapshot.ts restore   # warm deploy (pops snapshot from catalog)
 *   bun run scripts/bench-snapshot.ts full      # cold → capture → warm (end-to-end)
 *
 * OUTPUT
 * ─────────────────────────────────────────────────────────────────────────
 * CSV row appended to `insights/bench-snapshot.csv`:
 *   ts_iso, mode, provider, gpu, cold_ms, capture_ms, snapshot_mb, warm_ms
 *
 * Commit the CSV — it's the input for ADR-012 (snapshot lifecycle).
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MODE = process.argv[2] ?? 'full';
const GPU = process.env.BENCH_GPU ?? 'RTX 4090';
const IMAGE = process.env.BENCH_IMAGE ?? 'marcosremar/babelcast-subtitle:latest';
const INSIGHTS_DIR = join(
  fileURLToPath(new URL('../', import.meta.url)),
  'insights',
);
const CSV_PATH = join(INSIGHTS_DIR, 'bench-snapshot.csv');

function need(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[bench-snapshot] missing env: ${key}`);
    process.exit(1);
  }
  return v;
}

async function appendCsv(row: Record<string, unknown>): Promise<void> {
  await mkdir(INSIGHTS_DIR, { recursive: true });
  const header = 'ts_iso,mode,provider,gpu,cold_ms,capture_ms,snapshot_mb,warm_ms,note\n';
  const exists = await Bun.file(CSV_PATH).exists();
  if (!exists) await appendFile(CSV_PATH, header);
  const csv = [
    new Date().toISOString(),
    row.mode,
    row.provider,
    row.gpu,
    row.cold_ms ?? '',
    row.capture_ms ?? '',
    row.snapshot_mb ?? '',
    row.warm_ms ?? '',
    row.note ?? '',
  ].map((v) => String(v).replace(/,/g, ';'));
  await appendFile(CSV_PATH, csv.join(',') + '\n');
  console.log(`[bench-snapshot] appended row to ${CSV_PATH}`);
}

async function coldDeploy(): Promise<{ podId: string; endpoint: string; coldMs: number; sshHost: string; sshPort: number }> {
  need('VAST_API_KEY');
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:4000';
  const started = Date.now();
  const res = await fetch(`${gatewayUrl}/v1/gpu/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'vast-vm', dockerImage: IMAGE, gpuTypes: [GPU] }),
  });
  if (!res.ok) {
    console.error(`[bench-snapshot] deploy failed: HTTP ${res.status}`);
    process.exit(1);
  }
  // Poll status until ready
  let podId = '';
  let endpoint = '';
  let sshHost = '';
  let sshPort = 0;
  while (true) {
    await new Promise((r) => setTimeout(r, 5_000));
    const s = await fetch(`${gatewayUrl}/v1/gpu/status`).then((r) => r.json());
    if (s.status === 'ready') {
      podId = s.podId;
      endpoint = s.endpoint;
      sshHost = s.sshHost;
      sshPort = s.sshPort;
      break;
    }
    if (s.status === 'error') {
      console.error(`[bench-snapshot] cold deploy errored: ${s.message}`);
      process.exit(1);
    }
  }
  const coldMs = Date.now() - started;
  return { podId, endpoint, coldMs, sshHost, sshPort };
}

async function capture(sshHost: string, sshPort: number): Promise<{ captureMs: number; sizeMb: number }> {
  const { captureSnapshot } = await import('../server/gpu-snapshot');
  const started = Date.now();
  const result = await captureSnapshot({
    deployId: `bench-${Date.now()}`,
    provider: 'vast-vm',
    ssh: { host: sshHost, port: sshPort },
    imageRef: IMAGE,
    models: [],
  });
  if (!result.captured) {
    console.error(`[bench-snapshot] capture failed: ${result.reason}`);
    return { captureMs: Date.now() - started, sizeMb: 0 };
  }
  return {
    captureMs: Date.now() - started,
    sizeMb: Math.round((result.entry?.sizeBytes ?? 0) / (1024 * 1024)),
  };
}

async function warmDeploy(): Promise<{ warmMs: number }> {
  // Re-run a fresh deploy — should hit snapshot restore path.
  const { coldMs } = await coldDeploy();
  return { warmMs: coldMs };
}

async function main() {
  console.log(`[bench-snapshot] mode=${MODE} gpu=${GPU} image=${IMAGE}`);
  switch (MODE) {
    case 'cold': {
      const { coldMs } = await coldDeploy();
      await appendCsv({ mode: 'cold', provider: 'vast-vm', gpu: GPU, cold_ms: coldMs });
      break;
    }
    case 'capture': {
      const host = need('POD_SSH');
      const port = parseInt(need('POD_PORT'), 10);
      const { captureMs, sizeMb } = await capture(host, port);
      await appendCsv({ mode: 'capture', provider: 'vast-vm', gpu: GPU, capture_ms: captureMs, snapshot_mb: sizeMb });
      break;
    }
    case 'restore': {
      const { warmMs } = await warmDeploy();
      await appendCsv({ mode: 'restore', provider: 'vast-vm', gpu: GPU, warm_ms: warmMs });
      break;
    }
    case 'full': {
      const { coldMs, sshHost, sshPort } = await coldDeploy();
      const { captureMs, sizeMb } = await capture(sshHost, sshPort);
      const { warmMs } = await warmDeploy();
      await appendCsv({
        mode: 'full',
        provider: 'vast-vm',
        gpu: GPU,
        cold_ms: coldMs,
        capture_ms: captureMs,
        snapshot_mb: sizeMb,
        warm_ms: warmMs,
      });
      break;
    }
    default:
      console.error(`[bench-snapshot] unknown mode '${MODE}'`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[bench-snapshot] failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
