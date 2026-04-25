#!/usr/bin/env bun
import 'dotenv/config';
import { execFileSync } from 'child_process';
import { HyperstackClient } from '/Users/marcos/projects/ai-gateway/src/gateway/providers/gpu/hyperstack-client';

const API_KEY = process.env.HYPERSTACK_API_KEY!;
const client = new HyperstackClient({ defaultRegion: 'CANADA-1' });
const creds = { apiKey: API_KEY };

async function main() {
  console.log('deploy tiny A4000 to probe /dev/kvm and nested virt…');
  const created = await client.createInstance({
    gpuTypes: ['NVIDIA L40'], region: 'CANADA-1', numGpus: 1, storageGb: 40,
    dockerImage: 'marcosremar/babelcast-subtitle:latest',
    hfToken: '', imageName: 'ai-gateway-bench-2026-04-18',
    interruptible: false, deployEnv: {}, dockerStartCmd: '', onstart: '',
    containerDiskInGb: 40, volumeId: '', preferSsd: false,
  } as any, creds);
  const vmId = String((created as any).instanceId ?? (created as any).id);
  console.log(`vm=${vmId}`);

  // Wait ACTIVE
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10_000));
    const st = await client.getInstanceStatus(vmId, creds).catch(() => null);
    if (st === 'running') break;
  }
  const endpoint = await client.resolveInstanceEndpoint(vmId, creds);
  const host = new URL(endpoint!).hostname;
  await new Promise(r => setTimeout(r, 15_000));
  console.log(`host=${host}`);

  const probe = execFileSync('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    `ubuntu@${host}`, 'bash', '-s',
  ], { input: `
echo "=== /dev/kvm ==="
ls -la /dev/kvm 2>&1 || echo "NO /dev/kvm"
echo "=== cpuinfo flags (vmx/svm) ==="
grep -oE '(vmx|svm)' /proc/cpuinfo | head -1 || echo "NO vmx/svm"
echo "=== kvm module ==="
lsmod | grep -i kvm || echo "no kvm module"
echo "=== virt-host-validate ==="
sudo apt-get install -y libvirt-clients 2>&1 | tail -2
sudo virt-host-validate qemu 2>&1 | head -15 || echo "virt-host-validate not runnable"
`, encoding: 'utf8', timeout: 300_000 });
  console.log(probe);

  console.log('cleanup');
  await client.deleteInstance(vmId, creds).catch(() => {});
}
main().catch(e => { console.error(e); process.exit(1); });
