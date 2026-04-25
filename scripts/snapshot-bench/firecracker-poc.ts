#!/usr/bin/env bun
// Firecracker PoC on Hyperstack L40: prove nested virtualization works in
// practice, measure microVM boot time. No GPU passthrough in this pass —
// that's a separate engineering effort (VFIO + nvidia inside microVM).

import 'dotenv/config';
import { execFileSync } from 'child_process';
import { HyperstackClient } from '/Users/marcos/projects/ai-gateway/src/gateway/providers/gpu/hyperstack-client';

const API_KEY = process.env.HYPERSTACK_API_KEY!;
const client = new HyperstackClient({ defaultRegion: 'CANADA-1' });
const creds = { apiKey: API_KEY };

function ssh(host: string, script: string, timeoutMs = 10 * 60_000): string {
  return execFileSync('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=30',
    `ubuntu@${host}`, 'bash', '-s',
  ], { input: script, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
}

async function main() {
  console.log('[1] deploy L40 host from custom image…');
  const created = await client.createInstance({
    gpuTypes: ['NVIDIA L40'], region: 'CANADA-1', numGpus: 1, storageGb: 40,
    dockerImage: 'marcosremar/babelcast-subtitle:latest',
    hfToken: '', imageName: 'ai-gateway-bench-2026-04-18',
    interruptible: false, deployEnv: {}, dockerStartCmd: '', onstart: '',
    containerDiskInGb: 40, volumeId: '', preferSsd: false,
  } as any, creds);
  const vmId = String((created as any).instanceId ?? (created as any).id);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 8_000));
    const st = await client.getInstanceStatus(vmId, creds).catch(() => null);
    if (st === 'running') break;
  }
  const endpoint = await client.resolveInstanceEndpoint(vmId, creds);
  const host = new URL(endpoint!).hostname;
  await new Promise(r => setTimeout(r, 15_000));
  console.log(`    vm=${vmId} host=${host}`);

  console.log('[2] install Firecracker + download kernel + rootfs…');
  ssh(host, `
set -euo pipefail

# Firecracker binary (stable release)
ARCH="x86_64"
FC_VER="v1.13.0"
mkdir -p /tmp/fc && cd /tmp/fc
if [ ! -x ./firecracker ]; then
  curl -fsSL -o fc.tgz "https://github.com/firecracker-microvm/firecracker/releases/download/\${FC_VER}/firecracker-\${FC_VER}-\${ARCH}.tgz"
  tar xf fc.tgz
  mv release-\${FC_VER}-\${ARCH}/firecracker-\${FC_VER}-\${ARCH} ./firecracker
  chmod +x ./firecracker
fi
./firecracker --version

# Reference kernel + rootfs published by Firecracker team.
if [ ! -f vmlinux ]; then
  curl -fsSL -o vmlinux https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/x86_64/vmlinux-6.1.102
fi
if [ ! -f rootfs.ext4 ]; then
  curl -fsSL -o rootfs.ext4 https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/x86_64/ubuntu-24.04.ext4
fi
ls -la vmlinux rootfs.ext4 firecracker
`, 15 * 60_000);

  console.log('[3] boot a microVM, measure time-to-login…');
  const out = ssh(host, `
set -euo pipefail
cd /tmp/fc
rm -f fc.sock fc.out fc.err
# Start Firecracker daemon in background.
sudo ./firecracker --api-sock /tmp/fc/fc.sock >/tmp/fc/fc.out 2>/tmp/fc/fc.err &
FC_PID=$!
echo FC_PID=$FC_PID
sleep 0.5

# Configure boot via API — use unix socket.
T0=$(date +%s.%N)
sudo curl -s -X PUT --unix-socket /tmp/fc/fc.sock \
  'http://localhost/boot-source' \
  -H 'Content-Type: application/json' \
  -d '{"kernel_image_path": "/tmp/fc/vmlinux", "boot_args": "console=ttyS0 reboot=k panic=1 pci=off"}'
sudo curl -s -X PUT --unix-socket /tmp/fc/fc.sock \
  'http://localhost/drives/rootfs' \
  -H 'Content-Type: application/json' \
  -d '{"drive_id":"rootfs","path_on_host":"/tmp/fc/rootfs.ext4","is_root_device":true,"is_read_only":false}'
sudo curl -s -X PUT --unix-socket /tmp/fc/fc.sock \
  'http://localhost/machine-config' \
  -H 'Content-Type: application/json' \
  -d '{"vcpu_count": 2, "mem_size_mib": 1024}'

# Boot instance
sudo curl -s -X PUT --unix-socket /tmp/fc/fc.sock \
  'http://localhost/actions' \
  -H 'Content-Type: application/json' \
  -d '{"action_type": "InstanceStart"}'
T1=$(date +%s.%N)
echo "API_ACCEPTED_S=$(echo "$T1 - $T0" | bc)"

# Wait for kernel boot msg on Firecracker's serial log.
for i in $(seq 1 100); do
  if grep -qE '(login:|Reached target|Ubuntu)' /tmp/fc/fc.out 2>/dev/null; then break; fi
  sleep 0.1
done
T2=$(date +%s.%N)
echo "BOOT_TO_LOGIN_S=$(echo "$T2 - $T0" | bc)"

echo "--- firecracker stderr (first 30 lines) ---"
head -n 30 /tmp/fc/fc.err || true
echo "--- serial out (last 40 lines) ---"
tail -n 40 /tmp/fc/fc.out || true

sudo kill -9 $FC_PID 2>/dev/null || true
rm -f /tmp/fc/fc.sock
`, 10 * 60_000);

  console.log(out);

  console.log('[4] cleanup');
  await client.deleteInstance(vmId, creds).catch(() => {});
}

main().catch(e => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
