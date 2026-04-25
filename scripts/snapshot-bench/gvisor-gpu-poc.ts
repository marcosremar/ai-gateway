#!/usr/bin/env bun
// gVisor + GPU PoC on Hyperstack L40.
// Tests: can we run a CUDA workload inside a gVisor sandbox (runsc + nvproxy)?
// If yes, measure cold load latency of Phi-3.5-mini inside the sandbox,
// compare against same workload on the host (bare metal in the Hyperstack VM).

import 'dotenv/config';
import { execFileSync } from 'child_process';
import { HyperstackClient } from '/Users/marcos/projects/ai-gateway/src/gateway/providers/gpu/hyperstack-client';

const API_KEY = process.env.HYPERSTACK_API_KEY!;
const client = new HyperstackClient({ defaultRegion: 'CANADA-1' });
const creds = { apiKey: API_KEY };

function ssh(host: string, script: string, timeoutMs = 20 * 60_000): string {
  return execFileSync('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=30',
    `ubuntu@${host}`, 'bash', '-s',
  ], { input: script, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
}

async function pollActive(vmId: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 8_000));
    const st = await client.getInstanceStatus(vmId, creds).catch(() => null);
    if (st === 'running') return;
  }
  throw new Error('VM not ACTIVE');
}

async function main() {
  console.log('== gVisor + GPU PoC (Hyperstack L40) ==\n');

  console.log('[1] deploy L40 host from custom image…');
  const created = await client.createInstance({
    gpuTypes: ['NVIDIA L40'], region: 'CANADA-1', numGpus: 1, storageGb: 40,
    dockerImage: 'marcosremar/babelcast-subtitle:latest',
    hfToken: process.env.HF_TOKEN || '',
    imageName: 'ai-gateway-bench-2026-04-18',
    interruptible: false, deployEnv: {}, dockerStartCmd: '', onstart: '',
    containerDiskInGb: 40, volumeId: '', preferSsd: false,
  } as any, creds);
  const vmId = String((created as any).instanceId ?? (created as any).id);
  await pollActive(vmId);
  const endpoint = await client.resolveInstanceEndpoint(vmId, creds);
  const host = new URL(endpoint!).hostname;
  await new Promise(r => setTimeout(r, 15_000));
  console.log(`    vm=${vmId} host=${host}\n`);

  console.log('[2] install runsc + nvidia-container-toolkit + configure Docker…');
  ssh(host, `
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# nvidia-container-toolkit (needed for Docker+NVIDIA even before gVisor).
if ! dpkg -l | grep -q nvidia-container-toolkit; then
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
  sudo apt-get update -y
  sudo apt-get install -y nvidia-container-toolkit
fi

# gVisor (runsc).
if [ ! -x /usr/local/bin/runsc ]; then
  ARCH=\$(uname -m)
  URL="https://storage.googleapis.com/gvisor/releases/release/latest/\${ARCH}"
  curl -fsSL -o /tmp/runsc \$URL/runsc
  curl -fsSL -o /tmp/runsc.sha512 \$URL/runsc.sha512
  sha512sum -c /tmp/runsc.sha512 --ignore-missing || echo "checksum mismatch — continuing"
  sudo install -m 755 /tmp/runsc /usr/local/bin/runsc
fi
runsc --version

# Register runsc as a Docker runtime with --nvproxy + --nvproxy-docker to enable
# NVIDIA GPU access inside the sandbox.
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<EOF
{
  "runtimes": {
    "runsc": {
      "path": "/usr/local/bin/runsc",
      "runtimeArgs": ["--nvproxy", "--nvproxy-docker", "--host-uds=all"]
    },
    "nvidia": {
      "path": "/usr/bin/nvidia-container-runtime"
    }
  }
}
EOF
sudo systemctl restart docker
sleep 3
docker info 2>&1 | grep -E "Runtimes|Default Runtime" | head -5
`, 15 * 60_000);

  console.log('\n[3] sanity: nvidia-smi inside runsc…');
  const nvtest = ssh(host, `
set -euo pipefail
sudo docker run --rm --runtime=runsc --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi 2>&1 | head -20 || {
  echo "FAILED_RUNSC_NVIDIA_SMI"
  echo "--- trying without runsc (baseline) ---"
  sudo docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi 2>&1 | head -10 || echo "FAILED_BASELINE"
}
`, 10 * 60_000);
  console.log(nvtest);

  // If nvidia-smi worked in runsc, do a quick PyTorch load test.
  if (!nvtest.includes('FAILED_RUNSC_NVIDIA_SMI')) {
    console.log('\n[4] inside runsc: PyTorch + Phi-3.5-mini cold load…');
    const loadOut = ssh(host, `
set -euo pipefail
cat > /tmp/load_test.py <<'PY'
import os, time, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
MODEL = "microsoft/Phi-3.5-mini-instruct"
t0 = time.time()
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16, device_map="auto")
inp = tok("hello", return_tensors="pt").to("cuda")
with torch.no_grad(): _ = model(**inp)
torch.cuda.synchronize()
print(f"LOADED_S={time.time()-t0:.2f}")
print(f"VRAM_MIB={torch.cuda.memory_allocated() / 1024 / 1024:.0f}")
PY
# Baseline: bare metal (native on VM).
echo "--- baseline (bare VM) ---"
time /home/ubuntu/bench-venv/bin/python /tmp/load_test.py 2>&1 | tail -5
echo "--- gVisor sandbox (runsc) ---"
# Mount bench-venv + HF cache + script into container, run via runsc.
sudo docker run --rm --runtime=runsc --gpus all \
  -v /home/ubuntu/bench-venv:/venv:ro \
  -v /home/ubuntu/.cache/huggingface:/root/.cache/huggingface:ro \
  -v /tmp/load_test.py:/tmp/load_test.py:ro \
  nvidia/cuda:12.4.0-base-ubuntu22.04 \
  bash -c "/venv/bin/python /tmp/load_test.py" 2>&1 | tail -15
`, 20 * 60_000);
    console.log(loadOut);
  }

  console.log('\n[5] cleanup');
  await client.deleteInstance(vmId, creds).catch(() => {});
}

main().catch(e => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
