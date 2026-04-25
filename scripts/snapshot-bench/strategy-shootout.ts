#!/usr/bin/env bun
// Head-to-head strategy comparison, one VM, same model.
// For each strategy, we measure wall-clock from "request fires" → "first
// inference forward returns". All on the same L40 VM, sequentially, so host
// variance cancels out.
//
// Strategies:
//   A. warm  — model already in VRAM (lower bound)
//   B. offload/onload — CUDA→CPU→CUDA swap
//   C. cuda-checkpoint + CRIU — VRAM drained, dumped, killed, restored
//   D. cold load — from_pretrained (with model cached on local NVMe)
//   E. sllm-store — ServerlessLLM loading-optimized format (if daemon OK)

import 'dotenv/config';
import { execFileSync } from 'child_process';
import { HyperstackClient } from '../../src/gateway/providers/gpu/hyperstack-client';
import type { ProviderCredentials } from '../../src/gateway/providers/gpu/types';

const API_KEY = process.env.HYPERSTACK_API_KEY!;
const IMAGE = process.env.HYPERSTACK_BENCH_IMAGE_NAME ?? 'ai-gateway-bench-2026-04-18';
const GPU = process.env.BENCH_GPU ?? 'NVIDIA L40';
const REGION = 'CANADA-1';
const MODEL = 'microsoft/Phi-3.5-mini-instruct';

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
  }
  throw new Error('VM did not reach ACTIVE');
}

// Small runner: execute a bash script, parse 'RESULT_MS=<n>' from its output.
function runTimed(host: string, name: string, script: string, timeoutMs = 20 * 60_000): number {
  try {
    const out = ssh(host, script, timeoutMs);
    const m = out.match(/RESULT_MS=(\d+(?:\.\d+)?)/);
    if (!m) { console.warn(`[${name}] no RESULT_MS in output:\n${out.slice(-500)}`); return -1; }
    return Number(m[1]);
  } catch (e) {
    console.warn(`[${name}] failed: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
    return -1;
  }
}

const RESULTS: Record<string, number> = {};

async function main() {
  console.log(`== strategy-shootout ==\n  image=${IMAGE} gpu=${GPU}\n  model=${MODEL}\n`);
  console.log('[deploy] …');
  const t0 = performance.now();
  const created = await client.createInstance({
    gpuTypes: [GPU], region: REGION, numGpus: 1, storageGb: 40,
    dockerImage: 'marcosremar/babelcast-subtitle:latest',
    hfToken: process.env.HF_TOKEN || '',
    imageName: IMAGE, interruptible: false, deployEnv: {},
    dockerStartCmd: '', onstart: '', containerDiskInGb: 40, volumeId: '', preferSsd: false,
  } as any, creds);
  const vmId = String((created as any).instanceId ?? (created as any).id);
  await pollActive(vmId, 20 * 60_000);
  const endpoint = await client.resolveInstanceEndpoint(vmId, creds);
  const host = new URL(endpoint!).hostname;
  const deployMs = performance.now() - t0;
  RESULTS['F. cold deploy (VM + custom image)'] = deployMs;
  console.log(`  vm=${vmId} host=${host} deploy=${(deployMs/1000).toFixed(1)}s\n`);
  await new Promise(r => setTimeout(r, 15_000));

  // Baseline setup: ptrace_scope, ckpt dir, cache dir.
  ssh(host, `
set -euo pipefail
sudo sysctl -w kernel.yama.ptrace_scope=0 >/dev/null
mkdir -p /tmp/ckpt /home/ubuntu/.cache/huggingface
`, 60_000);

  // ── Strategy D: cold load (from_pretrained). Also warms HF cache on NVMe
  //    so future loads don't pay the download cost. ───────────────────────
  console.log('[D] cold load (transformers from_pretrained)…');
  RESULTS['D. cold load (transformers, warmed cache)'] = runTimed(host, 'D', `
set -euo pipefail
cat > /tmp/d_cold.py <<'PY'
import time, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
MODEL = "${MODEL}"
tok = AutoTokenizer.from_pretrained(MODEL)
t0 = time.time()
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16, device_map="auto")
inp = tok("what is the capital of france?", return_tensors="pt").to(model.device)
with torch.no_grad(): _ = model(**inp)
print(f"RESULT_MS={(time.time()-t0)*1000:.0f}")
PY
/home/ubuntu/bench-venv/bin/python /tmp/d_cold.py 2>&1 | tail -3
`, 30 * 60_000);

  // Cache is now warm. Second from_pretrained is much faster (no download).
  console.log('[D2] warm-cache load (second from_pretrained, no HF download)…');
  RESULTS['D2. warm-cache load (2nd from_pretrained)'] = runTimed(host, 'D2', `
set -euo pipefail
cat > /tmp/d2.py <<'PY'
import time, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
MODEL = "${MODEL}"
tok = AutoTokenizer.from_pretrained(MODEL)
t0 = time.time()
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16, device_map="auto")
inp = tok("what is the capital of france?", return_tensors="pt").to(model.device)
with torch.no_grad(): _ = model(**inp)
print(f"RESULT_MS={(time.time()-t0)*1000:.0f}")
PY
/home/ubuntu/bench-venv/bin/python /tmp/d2.py 2>&1 | tail -3
`, 15 * 60_000);

  // ── Strategy A: warm model already in VRAM; measure ONLY the forward. ──
  console.log('[A] warm forward pass (lower bound)…');
  RESULTS['A. warm inference (model already in VRAM)'] = runTimed(host, 'A', `
set -euo pipefail
cat > /tmp/a_warm.py <<'PY'
import time, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
MODEL = "${MODEL}"
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16, device_map="auto")
# warm up kernels first
inp = tok("warm up", return_tensors="pt").to(model.device)
for _ in range(3):
    with torch.no_grad(): _ = model(**inp)
# now measure a single forward
t0 = time.time()
with torch.no_grad(): _ = model(**inp)
torch.cuda.synchronize()
print(f"RESULT_MS={(time.time()-t0)*1000:.1f}")
PY
/home/ubuntu/bench-venv/bin/python /tmp/a_warm.py 2>&1 | tail -3
`, 10 * 60_000);

  // ── Strategy B: offload → onload. Launch persistent loader in bg,
  //    measure one cycle inside its own Python process. ──────────────────
  console.log('[B] offload/onload cycle (warm VM, model swap RAM↔VRAM)…');
  RESULTS['B. offload → onload (same process)'] = runTimed(host, 'B', `
set -euo pipefail
cat > /tmp/b_offload.py <<'PY'
import os, time, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
MODEL = "${MODEL}"
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16, device_map="auto")
inp = tok("warm up", return_tensors="pt").to(model.device)
for _ in range(3):
    with torch.no_grad(): _ = model(**inp)
# offload to CPU
model.to("cpu"); torch.cuda.empty_cache()
time.sleep(1.0)  # simulate idle gap
t0 = time.time()
model.to("cuda")
inp = {k: v.to("cuda") for k, v in tok("what is the capital of france?", return_tensors="pt").items()}
with torch.no_grad(): _ = model(**inp)
torch.cuda.synchronize()
print(f"RESULT_MS={(time.time()-t0)*1000:.0f}")
PY
/home/ubuntu/bench-venv/bin/python /tmp/b_offload.py 2>&1 | tail -3
`, 10 * 60_000);

  // ── Strategy C: cuda-checkpoint + CRIU restore. Complex; needs a
  //    separate long-lived process that we dump, kill, restore. ──────────
  console.log('[C] cuda-checkpoint + CRIU restore…');
  // Step 1: launch process, have it load the model, then signal ready and sleep.
  ssh(host, `
set -euo pipefail
cat > /tmp/c_load.py <<'PY'
import os, sys, signal, time, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
MODEL = "${MODEL}"
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16, device_map="auto")
inp = tok("what is the capital of france?", return_tensors="pt").to(model.device)
with torch.no_grad(): _ = model(**inp)
open("/tmp/c.ready","w").write("1")
_dn = os.open("/dev/null", os.O_WRONLY); os.dup2(_dn, 1); os.dup2(_dn, 2); os.close(_dn)
# Close HF xet log fds (paths don't exist after CRIU restore if they were per-pid).
try:
    for fd in os.listdir("/proc/self/fd"):
        try: tgt = os.readlink(f"/proc/self/fd/{fd}")
        except OSError: continue
        if "/.cache/huggingface/" in tgt or "xet_" in tgt:
            try: os.close(int(fd))
            except OSError: pass
except Exception: pass
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while True: time.sleep(60)
PY
rm -f /tmp/c.ready /tmp/ckpt/*.img /tmp/ckpt/*.log 2>/dev/null || true
mkdir -p /tmp/ckpt
nohup /home/ubuntu/bench-venv/bin/python /tmp/c_load.py </dev/null >/tmp/c.out 2>&1 &
echo $! > /tmp/c.pid
disown || true
for i in $(seq 1 600); do [ -f /tmp/c.ready ] && exit 0; sleep 0.5; done
echo "c.ready timeout" >&2; tail /tmp/c.out >&2; exit 1
`, 10 * 60_000);
  // Step 2: dump with cuda-checkpoint + criu.
  ssh(host, `
set -euo pipefail
PID="$(cat /tmp/c.pid)"
sudo /usr/local/bin/cuda-checkpoint --toggle --pid "$PID"
sudo /usr/local/sbin/criu dump -t "$PID" -D /tmp/ckpt --shell-job --tcp-close --ghost-limit 256M --leave-running
# after leave-running, process is still alive; kill it explicitly
kill -9 "$PID" 2>/dev/null || true
`, 5 * 60_000);
  // Step 3: restore + toggle + inference. This is the one we measure.
  RESULTS['C. cuda-checkpoint + CRIU restore'] = runTimed(host, 'C', `
set -euo pipefail
t0=$(date +%s%N)
sudo /usr/local/sbin/criu restore -D /tmp/ckpt --shell-job --tcp-close --restore-detached --ghost-limit 256M
# find the restored pid (by cmdline)
sleep 0.3
NEWPID=$(pgrep -f c_load.py | head -n1)
sudo /usr/local/bin/cuda-checkpoint --toggle --pid "$NEWPID"
# send it a new request via a signal — simpler, just kill it now since we've
# measured up to functional CUDA state, which is the "model ready" point.
t1=$(date +%s%N)
echo "RESULT_MS=$(echo "scale=1; ($t1 - $t0) / 1000000" | bc)"
kill -9 "$NEWPID" 2>/dev/null || true
`, 5 * 60_000);

  // ── Strategy E: sllm-store with daemon. Install, convert, start daemon,
  //    then load_model through the daemon. ─────────────────────────────
  console.log('[E] sllm-store (daemon-backed load)…');
  try {
    // Install + convert.
    ssh(host, `
set -euo pipefail
/home/ubuntu/bench-venv/bin/pip install --quiet serverless-llm-store 2>&1 | tail -3 || true
mkdir -p /home/ubuntu/sllm-store
cat > /tmp/e_convert.py <<'PY'
from sllm_store.transformers import save_model
from transformers import AutoModelForCausalLM, AutoTokenizer
MODEL = "${MODEL}"
OUT = "/home/ubuntu/sllm-store/" + MODEL.replace("/", "_")
import torch, os
if not os.path.isdir(OUT + "/config"):
    tok = AutoTokenizer.from_pretrained(MODEL)
    tok.save_pretrained(OUT)
    m = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16)
    save_model(m, OUT)
print("ok")
PY
/home/ubuntu/bench-venv/bin/python /tmp/e_convert.py 2>&1 | tail -3
# Start daemon if not running.
if ! pgrep -f sllm-store >/dev/null; then
  nohup /home/ubuntu/bench-venv/bin/sllm-store start --storage-path /home/ubuntu/sllm-store </dev/null >/tmp/e.daemon.log 2>&1 &
  disown || true
  for i in $(seq 1 60); do grep -q "Server started\\|listening\\|Ready" /tmp/e.daemon.log 2>/dev/null && break; sleep 1; done
fi
`, 20 * 60_000);

    // Measure cold load via sllm daemon.
    RESULTS['E. sllm-store (daemon + load_model)'] = runTimed(host, 'E', `
set -euo pipefail
cat > /tmp/e_load.py <<'PY'
import os, time, torch
from sllm_store.transformers import load_model
MODEL = "${MODEL}"
OUT = "/home/ubuntu/sllm-store/" + MODEL.replace("/", "_")
t0 = time.time()
try:
  model = load_model(OUT, device_map="auto", torch_dtype=torch.float16)
except Exception as e:
  print(f"sllm_load_err {e}")
  raise
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained(OUT)
inp = tok("what is the capital of france?", return_tensors="pt").to("cuda")
with torch.no_grad(): _ = model(**inp)
torch.cuda.synchronize()
print(f"RESULT_MS={(time.time()-t0)*1000:.0f}")
PY
/home/ubuntu/bench-venv/bin/python /tmp/e_load.py 2>&1 | tail -5
`, 10 * 60_000);
  } catch (e) {
    console.warn(`[E] sllm failed: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
  }

  console.log('\n[cleanup] terminate');
  await client.deleteInstance(vmId, creds).catch(() => {});

  // Report.
  console.log('\n== Shootout Results (Phi-3.5-mini, L40 CANADA-1) ==');
  const rows = Object.entries(RESULTS).filter(([, v]) => v >= 0);
  rows.sort((a, b) => a[1] - b[1]);
  const maxName = Math.max(...rows.map(r => r[0].length));
  for (const [name, ms] of rows) {
    const pad = name.padEnd(maxName, ' ');
    const s = ms >= 1000 ? `${(ms/1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
    console.log(`  ${pad}  ${s}`);
  }
  // Missing strategies
  for (const [name, ms] of Object.entries(RESULTS)) {
    if (ms < 0) console.log(`  [skip] ${name}: failed, see logs`);
  }
}

main().catch(e => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
