#!/usr/bin/env bun
// Live offload/onload benchmark. Deploys one Hyperstack L40 from the pre-baked
// bench image, loads a model, then cycles offload ↔ onload N times and
// measures each transition. Validates the vm-offload wiring end-to-end.
//
// Usage:  HYPERSTACK_KEY_NAME=codex-criu-test-ca bun scripts/snapshot-bench/offload-bench.ts

import 'dotenv/config';
import { execFileSync } from 'child_process';
import { HyperstackClient } from '../../src/gateway/providers/gpu/hyperstack-client';
import type { ProviderCredentials } from '../../src/gateway/providers/gpu/types';

const API_KEY = process.env.HYPERSTACK_API_KEY!;
const IMAGE = process.env.HYPERSTACK_BENCH_IMAGE_NAME ?? 'ai-gateway-bench-2026-04-18';
const GPU = process.env.BENCH_GPU ?? 'NVIDIA L40';
const REGION = 'CANADA-1';
const MODEL = process.env.BENCH_MODEL ?? 'microsoft/Phi-3.5-mini-instruct';
const CYCLES = Number(process.env.BENCH_CYCLES ?? 3);

const client = new HyperstackClient({ defaultRegion: REGION });
const creds: ProviderCredentials = { apiKey: API_KEY };

function ssh(host: string, script: string, timeoutMs = 60_000): string {
  return execFileSync('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=30',
    '-p', '22',
    `ubuntu@${host}`,
    'bash', '-s',
  ], { input: script, encoding: 'utf8', timeout: timeoutMs });
}

async function pollActive(vmId: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5_000));
    const st = await client.getInstanceStatus(vmId, creds).catch(() => null);
    if (st === 'running') return;
    if (st === 'deleted' || st === 'error') throw new Error(`VM ${vmId} status=${st}`);
  }
  throw new Error(`VM ${vmId} did not reach ACTIVE within ${timeoutMs/1000}s`);
}

async function main() {
  console.log(`== offload bench ==\n  image: ${IMAGE}\n  gpu:   ${GPU} @ ${REGION}\n  model: ${MODEL}\n  cycles: ${CYCLES}\n`);

  const t0 = performance.now();
  console.log('[1] deploy VM from bench image');
  const created = await client.createInstance({
    gpuTypes: [GPU], region: REGION, numGpus: 1, storageGb: 40,
    dockerImage: 'marcosremar/babelcast-subtitle:latest',
    hfToken: process.env.HF_TOKEN || '',
    imageName: IMAGE,
    interruptible: false,
    deployEnv: {}, dockerStartCmd: '', onstart: '',
    containerDiskInGb: 40, volumeId: '', preferSsd: false,
  } as any, creds);
  const vmId = String((created as any).instanceId ?? (created as any).id);
  await pollActive(vmId, 20 * 60_000);
  const endpoint = await client.resolveInstanceEndpoint(vmId, creds);
  const host = new URL(endpoint!).hostname;
  const bootMs = performance.now() - t0;
  console.log(`    vm=${vmId} ip=${host} boot=${(bootMs/1000).toFixed(1)}s\n`);

  // Small settle for SSH.
  await new Promise((r) => setTimeout(r, 15_000));

  console.log('[2] launch loader');
  const launchScript = `
set -euo pipefail
sudo sysctl -w kernel.yama.ptrace_scope=0 >/dev/null
mkdir -p /tmp/ckpt
rm -f /tmp/bench.ready /tmp/bench.offload /tmp/bench.onload /tmp/bench.offloaded /tmp/bench.transitions.log
cat > /tmp/bench_load.py <<'PY'
import os, sys, signal, time, torch
MODEL = os.environ["BENCH_MODEL"]
from transformers import AutoModelForCausalLM, AutoTokenizer
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16, device_map="auto")
inp = tok("warmup", return_tensors="pt").to(model.device)
with torch.no_grad(): _ = model(**inp)
open("/tmp/bench.ready","w").write("1")
# Redirect stdio to /dev/null so ssh returns.
_dn = os.open("/dev/null", os.O_WRONLY)
os.dup2(_dn, 1); os.dup2(_dn, 2); os.close(_dn)

def log(ev):
    with open("/tmp/bench.transitions.log","a") as f:
        f.write(f"{time.time():.3f} {ev}\\n")

# Poll for offload/onload control files at 250ms.
while True:
    if os.path.exists("/tmp/bench.offload"):
        t = time.time()
        os.remove("/tmp/bench.offload")
        if next(model.parameters()).is_cuda:
            model.to("cpu"); torch.cuda.empty_cache()
        open("/tmp/bench.offloaded","w").write("1")
        log(f"offloaded {(time.time()-t)*1000:.1f}ms")
    if os.path.exists("/tmp/bench.onload"):
        t = time.time()
        os.remove("/tmp/bench.onload")
        if not next(model.parameters()).is_cuda:
            model.to("cuda")
        # warmup forward to make sure VRAM is populated
        with torch.no_grad(): _ = model(**inp)
        try: os.remove("/tmp/bench.offloaded")
        except OSError: pass
        open("/tmp/bench.ready","w").write("1")
        log(f"onloaded {(time.time()-t)*1000:.1f}ms")
    time.sleep(0.25)
PY
BENCH_MODEL="${MODEL}" nohup /home/ubuntu/bench-venv/bin/python /tmp/bench_load.py </dev/null >/tmp/bench.out 2>&1 &
echo $! > /tmp/bench.pid
disown || true
for i in $(seq 1 2400); do [ -f /tmp/bench.ready ] && exit 0; sleep 1; done
echo "model load timeout" >&2
tail -n 30 /tmp/bench.out >&2 || true
exit 1
`;
  const loadStart = performance.now();
  ssh(host, `MODEL='${MODEL}' BENCH_MODEL='${MODEL}' ${launchScript}`, 45 * 60_000);
  const coldLoadMs = performance.now() - loadStart;
  console.log(`    cold model load = ${(coldLoadMs/1000).toFixed(1)}s\n`);

  const cycles: Array<{offloadMs: number; onloadMs: number}> = [];
  for (let i = 1; i <= CYCLES; i++) {
    console.log(`[3.${i}] offload → onload cycle`);
    // offload
    let t = performance.now();
    ssh(host,
      `touch /tmp/bench.offload && for j in $(seq 1 60); do [ -f /tmp/bench.offloaded ] && exit 0; sleep 0.25; done; echo offload_timeout >&2; exit 1`,
      60_000);
    const offloadMs = performance.now() - t;

    // onload
    t = performance.now();
    ssh(host,
      `touch /tmp/bench.onload && for j in $(seq 1 240); do [ -f /tmp/bench.ready ] && exit 0; sleep 0.25; done; echo onload_timeout >&2; exit 1`,
      90_000);
    const onloadMs = performance.now() - t;

    cycles.push({ offloadMs, onloadMs });
    console.log(`    offload=${offloadMs.toFixed(0)}ms, onload=${onloadMs.toFixed(0)}ms`);
  }

  console.log('[4] terminate');
  await client.deleteInstance(vmId, creds).catch(() => {});

  console.log('\n== Results ==');
  console.log(`cold deploy:  ${(bootMs/1000).toFixed(1)} s`);
  console.log(`cold load:    ${(coldLoadMs/1000).toFixed(1)} s`);
  const avgOff = cycles.reduce((s,c)=>s+c.offloadMs,0)/cycles.length;
  const avgOn = cycles.reduce((s,c)=>s+c.onloadMs,0)/cycles.length;
  console.log(`avg offload:  ${avgOff.toFixed(0)} ms`);
  console.log(`avg onload:   ${avgOn.toFixed(0)} ms`);
  console.log(`speedup vs cold load: ${(coldLoadMs/avgOn).toFixed(2)}×`);
  console.log(`cycles: ${JSON.stringify(cycles.map(c=>({off:Math.round(c.offloadMs),on:Math.round(c.onloadMs)})))}`);
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
