#!/usr/bin/env bun
// Live ServerlessLLM cold-load benchmark. Deploy one L40, install sllm-store
// on top of the bench image, load Phi-3.5-mini first with stock transformers
// (baseline) and then with sllm-store (loading-optimized format). Report the
// two cold-load times side by side. Terminate.
//
// Usage:  HYPERSTACK_KEY_NAME=codex-criu-test-ca bun scripts/snapshot-bench/sllm-bench.ts

import 'dotenv/config';
import { execFileSync } from 'child_process';
import { HyperstackClient } from '../../src/gateway/providers/gpu/hyperstack-client';
import type { ProviderCredentials } from '../../src/gateway/providers/gpu/types';

const API_KEY = process.env.HYPERSTACK_API_KEY!;
const IMAGE = process.env.HYPERSTACK_BENCH_IMAGE_NAME ?? 'ai-gateway-bench-2026-04-18';
const GPU = process.env.BENCH_GPU ?? 'NVIDIA L40';
const REGION = 'CANADA-1';
const MODEL = process.env.BENCH_MODEL ?? 'microsoft/Phi-3.5-mini-instruct';

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

async function main() {
  console.log(`== sllm cold-load bench ==\n  image=${IMAGE} gpu=${GPU} model=${MODEL}\n`);

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
  console.log(`[deploy] ${((performance.now()-t0)/1000).toFixed(1)}s vm=${vmId} host=${host}`);
  await new Promise(r => setTimeout(r, 15_000));

  // Baseline: stock transformers cold load.
  console.log('[baseline] stock transformers cold load…');
  const tfStart = performance.now();
  const tfOut = ssh(host, `
set -euo pipefail
rm -rf /home/ubuntu/.cache/huggingface/hub 2>/dev/null || true
cat > /tmp/tf_load.py <<'PY'
import os, time, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
MODEL = os.environ["MODEL"]
t0 = time.time()
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16, device_map="auto")
inp = tok("warmup", return_tensors="pt").to(model.device)
with torch.no_grad(): _ = model(**inp)
print(f"LOADED {time.time()-t0:.2f}")
PY
MODEL='${MODEL}' /home/ubuntu/bench-venv/bin/python /tmp/tf_load.py
`, 45 * 60_000);
  const tfLoadMs = performance.now() - tfStart;
  const tfMatch = tfOut.match(/LOADED ([\d.]+)/);
  const tfSec = tfMatch ? Number(tfMatch[1]) : -1;
  console.log(`  transformers: wall=${(tfLoadMs/1000).toFixed(1)}s, python-measured=${tfSec.toFixed(2)}s\n`);

  // Install sllm-store. Try both common package names; tolerate failure.
  console.log('[setup] install serverless-llm-store…');
  let sllmInstalled = false;
  try {
    const out = ssh(host, `
set -euo pipefail
/home/ubuntu/bench-venv/bin/pip install --quiet serverless-llm-store 2>&1 | tail -5
/home/ubuntu/bench-venv/bin/python -c "import sllm_store; print('sllm-store ok', sllm_store.__version__ if hasattr(sllm_store, '__version__') else '?')"
`, 10 * 60_000);
    console.log(`  ${out.trim().split('\n').slice(-1)[0]}`);
    sllmInstalled = true;
  } catch (e) {
    console.warn(`  sllm-store install failed: ${e instanceof Error ? e.message.slice(0,200) : e}`);
  }

  let sllmLoadMs = -1;
  let sllmConvertMs = -1;
  if (sllmInstalled) {
    // Step A: convert HF model to sllm-store format (one-time cost, would be
    // done at image-build time in production).
    console.log('[sllm] convert HF → sllm format…');
    try {
      const cStart = performance.now();
      ssh(host, `
set -euo pipefail
mkdir -p /home/ubuntu/sllm-store
cat > /tmp/sllm_convert.py <<'PY'
import os, time, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
try:
    from sllm_store.transformers import save_model
except ImportError as e:
    print(f"IMPORT_ERR {e}")
    raise
MODEL = os.environ["MODEL"]
OUT = "/home/ubuntu/sllm-store/" + MODEL.replace("/", "_")
t0 = time.time()
tok = AutoTokenizer.from_pretrained(MODEL)
tok.save_pretrained(OUT)
m = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16)
save_model(m, OUT)
print(f"CONVERTED {time.time()-t0:.2f}")
PY
MODEL='${MODEL}' /home/ubuntu/bench-venv/bin/python /tmp/sllm_convert.py
`, 20 * 60_000);
      sllmConvertMs = performance.now() - cStart;
      console.log(`  convert wall=${(sllmConvertMs/1000).toFixed(1)}s`);

      // Step B: cold load from the sllm-store format.
      console.log('[sllm] cold load from sllm format…');
      const sStart = performance.now();
      const sOut = ssh(host, `
set -euo pipefail
cat > /tmp/sllm_load.py <<'PY'
import os, time, torch
from sllm_store.transformers import load_model
MODEL = os.environ["MODEL"]
OUT = "/home/ubuntu/sllm-store/" + MODEL.replace("/", "_")
t0 = time.time()
model = load_model(OUT, device_map="auto", torch_dtype=torch.float16)
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained(OUT)
inp = tok("warmup", return_tensors="pt").to("cuda")
with torch.no_grad(): _ = model(**inp)
print(f"LOADED {time.time()-t0:.2f}")
PY
MODEL='${MODEL}' /home/ubuntu/bench-venv/bin/python /tmp/sllm_load.py
`, 20 * 60_000);
      sllmLoadMs = performance.now() - sStart;
      const sMatch = sOut.match(/LOADED ([\d.]+)/);
      const sSec = sMatch ? Number(sMatch[1]) : -1;
      console.log(`  sllm load: wall=${(sllmLoadMs/1000).toFixed(1)}s, python-measured=${sSec.toFixed(2)}s`);
    } catch (e) {
      console.warn(`  sllm convert/load failed: ${e instanceof Error ? e.message.slice(0,200) : e}`);
    }
  }

  console.log('[cleanup] terminate');
  await client.deleteInstance(vmId, creds).catch(() => {});

  console.log('\n== Results ==');
  console.log(`transformers cold load: ${(tfLoadMs/1000).toFixed(1)}s wall`);
  if (sllmLoadMs > 0) {
    console.log(`sllm cold load:         ${(sllmLoadMs/1000).toFixed(1)}s wall`);
    console.log(`speedup sllm vs tf:     ${(tfLoadMs/sllmLoadMs).toFixed(2)}×`);
    console.log(`one-time convert cost:  ${(sllmConvertMs/1000).toFixed(1)}s`);
  } else {
    console.log('sllm: not available (see warnings above)');
  }
}

main().catch(e => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
