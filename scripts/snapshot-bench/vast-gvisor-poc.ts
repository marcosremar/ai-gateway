#!/usr/bin/env bun
// Vast.ai VM + gVisor + GPU PoC.
// Uses the existing VastVmClient (vms_enabled=true + runtype=vm) to deploy a
// KVM-backed Vast.ai VM, then installs runsc + nvidia-container-toolkit,
// runs nvidia-smi inside gVisor and a short Phi-3.5 cold-load test.
// Compares cold load bare-VM vs gVisor sandbox.

import 'dotenv/config';
import { execFileSync } from 'child_process';
import { VastVmClient } from '/Users/marcos/projects/ai-gateway/src/gateway/providers/gpu/vast-vm-client';
import type { ProviderCredentials } from '/Users/marcos/projects/ai-gateway/src/gateway/providers/gpu/types';

const VAST_KEY = process.env.VAST_API_KEY!;
if (!VAST_KEY) { console.error('VAST_API_KEY missing'); process.exit(2); }

const creds: ProviderCredentials = { apiKey: VAST_KEY };
const client = new VastVmClient({});

function ssh(host: string, port: number, script: string, timeoutMs = 20 * 60_000): string {
  return execFileSync('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=30',
    '-p', String(port),
    `root@${host}`, 'bash', '-s',
  ], { input: script, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
}

async function main() {
  console.log('== Vast.ai VM + gVisor + GPU PoC ==\n');

  console.log('[1] query Vast.ai API directly with verified+vms+driver≤550 filter…');
  // Direct API call — our VastClient doesn't expose verified/driver filters.
  const q = encodeURIComponent(JSON.stringify({
    verified: { eq: true },
    vms_enabled: { eq: true },
    gpu_name: 'RTX 4090',
    order: [['dph_total', 'asc']],
  }));
  const res = await fetch(`https://console.vast.ai/api/v0/bundles/?q=${q}`, {
    headers: { Authorization: `Bearer ${VAST_KEY}` },
  });
  const raw: any = await res.json();
  const rawOffers: any[] = raw.offers || [];
  console.log(`    ${rawOffers.length} verified VM-mode offers`);
  // Keep only driver ≤555 (gVisor nvproxy compat).
  const candidates = rawOffers
    .filter((o) => {
      const drv = String(o.driver_version || '');
      const major = parseInt(drv.split('.')[0], 10);
      return Number.isFinite(major) && major <= 555 && Number(o.reliability2 || 0) >= 0.99;
    })
    .slice(0, 5);
  if (candidates.length === 0) {
    console.error('no candidate offers with driver ≤555 and VMs enabled');
    process.exit(1);
  }
  for (const o of candidates) {
    console.log(`    id=${o.id} $/hr=${Number(o.dph_total).toFixed(3)} rel=${Number(o.reliability2).toFixed(3)} drv=${o.driver_version} cuda=${o.cuda_max_good} region=${o.geolocation}`);
  }
  const pick = candidates[0];
  if (!pick) { console.error('no candidates'); process.exit(1); }
  console.log(`\n[pick] id=${pick.id} @ $${Number(pick.dph_total).toFixed(3)}/hr drv=${pick.driver_version}\n`);

  console.log('[2] deploy VM via Vast API directly…');
  const t0 = performance.now();
  // Direct PUT to /asks/<id>/ using VM runtype + cached vastai/kvm image.
  const putRes = await fetch(`https://console.vast.ai/api/v0/asks/${pick.id}/`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${VAST_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: 'me',
      image: 'vastai/kvm/ubuntu-22.04:latest',
      disk: 40,
      runtype: 'vm',
      onstart: 'echo "bootstrap start" > /tmp/boot.log\n',
      env: {},
    }),
  });
  if (!putRes.ok) { console.error('PUT failed', await putRes.text()); process.exit(1); }
  const putBody: any = await putRes.json();
  const vmId: string = String(putBody.new_contract ?? putBody.id ?? '');
  console.log(`    created instance id=${vmId}`);

  // vmId already set from the direct PUT above.

  // Wait for running + SSH endpoint
  let sshHost = '', sshPort = 22;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 15_000));
    const st = await client.getInstanceStatus(vmId, creds).catch(() => null);
    console.log(`    status=${st}`);
    if (st === 'running') {
      const ep = await client.resolveInstanceEndpoint(vmId, creds).catch(() => null);
      if (ep) {
        const url = new URL(ep);
        sshHost = url.hostname;
        sshPort = 22;
        break;
      }
    }
    if (st === 'error' || st === 'deleted') throw new Error(`status=${st}`);
  }
  if (!sshHost) throw new Error('SSH endpoint not reachable');
  const bootMs = performance.now() - t0;
  console.log(`    vm=${vmId} ssh=${sshHost}:${sshPort} boot=${(bootMs/1000).toFixed(1)}s\n`);

  console.log('[3] install runsc + nvidia-container-toolkit…');
  ssh(sshHost, sshPort, `
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gpg lsb-release python3-pip python3-venv build-essential || true
# nvidia-container-toolkit
if ! dpkg -l | grep -q nvidia-container-toolkit; then
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update -y
  apt-get install -y nvidia-container-toolkit
fi
# runsc
if [ ! -x /usr/local/bin/runsc ]; then
  ARCH=$(uname -m)
  curl -fsSL -o /tmp/runsc https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}/runsc
  install -m 755 /tmp/runsc /usr/local/bin/runsc
fi
runsc --version | head -2
# Docker runtime config
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<EOF
{
  "runtimes": {
    "runsc": { "path": "/usr/local/bin/runsc", "runtimeArgs": ["--nvproxy", "--nvproxy-docker", "--host-uds=all"] },
    "nvidia": { "path": "/usr/bin/nvidia-container-runtime" }
  }
}
EOF
systemctl restart docker
sleep 3
echo "--- docker runtimes ---"
docker info 2>/dev/null | grep -E "Runtimes|Default Runtime" | head -5
echo "--- driver + capbnd ---"
nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1
cat /proc/self/status | grep CapBnd
`, 20 * 60_000);

  console.log('\n[4] nvidia-smi INSIDE runsc (vs baseline)…');
  const nvtest = ssh(sshHost, sshPort, `
set -euo pipefail
echo "=== RUNSC (gVisor nvproxy) ==="
if docker run --rm --runtime=runsc --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi 2>&1 | tee /tmp/runsc.out | tail -20; then
  if grep -q "GeForce\\|RTX\\|A6000\\|L40\\|A100\\|H100" /tmp/runsc.out; then
    echo "RUNSC_GPU_OK"
  else
    echo "RUNSC_GPU_PARTIAL"
  fi
else
  echo "RUNSC_GPU_FAILED"
fi
echo "=== BASELINE (native runtime) ==="
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi 2>&1 | tail -10 | head -7
`, 10 * 60_000);
  console.log(nvtest);

  if (nvtest.includes('RUNSC_GPU_OK')) {
    console.log('\n[5] Phi-3.5-mini cold load: bare VM vs runsc sandbox…');
    const out = ssh(sshHost, sshPort, `
set -euo pipefail
if [ ! -d /opt/bench-venv ]; then
  python3 -m venv /opt/bench-venv
  /opt/bench-venv/bin/pip install --quiet --upgrade pip wheel
  /opt/bench-venv/bin/pip install --quiet --index-url https://download.pytorch.org/whl/cu126 torch 2>&1 | tail -3
  /opt/bench-venv/bin/pip install --quiet transformers accelerate safetensors "huggingface-hub>=1.0.0" hf_xet 2>&1 | tail -3
fi
cat > /tmp/load.py <<'PY'
import os, time, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
MODEL = "microsoft/Phi-3.5-mini-instruct"
t0 = time.time()
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16, device_map="auto")
inp = tok("warmup", return_tensors="pt").to("cuda")
with torch.no_grad(): _ = model(**inp)
torch.cuda.synchronize()
print(f"LOADED_S={time.time()-t0:.2f}")
print(f"VRAM_MIB={torch.cuda.memory_allocated() / 1024 / 1024:.0f}")
PY
echo "--- BARE VM ---"
/opt/bench-venv/bin/python /tmp/load.py 2>&1 | tail -5
echo "--- RUNSC SANDBOX ---"
docker run --rm --runtime=runsc --gpus all \
  -v /opt/bench-venv:/venv:ro \
  -v /root/.cache/huggingface:/root/.cache/huggingface \
  -v /tmp/load.py:/tmp/load.py:ro \
  nvidia/cuda:12.4.0-base-ubuntu22.04 \
  bash -c "/venv/bin/python /tmp/load.py" 2>&1 | tail -10
`, 20 * 60_000);
    console.log(out);
  }

  console.log('\n[6] cleanup — terminate VM');
  await client.deleteInstance(vmId, creds).catch(() => {});
}

main().catch(e => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
