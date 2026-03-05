/**
 * Vast.ai Port Test — TCP + UDP on 10 machines (with rate limiting)
 *
 * Tests port exposure via env dict: "-p 8000:8000": "1", "-p 8001:8001/udp": "1"
 * Uses VastClient with built-in rate limiter to avoid 429s.
 *
 * Run: cd packages/ai-gateway && source ../../.env && VAST_API_KEY=$VAST_API_KEY bunx tsx __tests__/vast-port-test.ts
 */

import { VastClient } from '../src/gpu-providers/vast-client';
import type { ProviderCredentials, InstanceSpec, GpuInstance } from '../src/gpu-providers/types';

const VAST_API_KEY = process.env.VAST_API_KEY!;
if (!VAST_API_KEY) { console.error('VAST_API_KEY not set'); process.exit(1); }

const VAST_API_BASE = 'https://console.vast.ai/api/v0';
const creds: ProviderCredentials = { apiKey: VAST_API_KEY };
const client = new VastClient();
const NUM_MACHINES = 10;
const BOOT_TIMEOUT_MS = 180_000;

function vastHeaders(): Record<string, string> {
  return { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${VAST_API_KEY}` };
}

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function httpProbe(url: string, timeoutMs = 15_000): Promise<{ ok: boolean; ms: number; status?: number; error?: string }> {
  if (!url) return { ok: false, ms: 0, error: 'no url' };
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, ms: Date.now() - start, status: res.status };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchRawInstance(id: string): Promise<Record<string, unknown> | null> {
  const rawId = id.replace('inst-', '');
  try {
    await sleep(350); // Rate limit
    const res = await fetch(`${VAST_API_BASE}/instances/${rawId}/`, { headers: vastHeaders(), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return (data.instances ?? data) as Record<string, unknown>;
  } catch { return null; }
}

function extractPort(ports: Record<string, unknown> | undefined, key: string): string {
  if (!ports) return '-';
  const entries = ports[key] as Array<{ HostPort?: string }> | undefined;
  const hp = entries?.[0]?.HostPort;
  return hp && Number(hp) > 0 ? hp : '-';
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(100));
  console.log('  VAST.AI PORT TEST — TCP + UDP on 10 machines (with rate limiter)');
  console.log('='.repeat(100));

  const created: GpuInstance[] = [];

  // ── Step 1: Create 10 machines ──────────────────────────────────────────
  console.log(`\n--- Step 1: Create ${NUM_MACHINES} machines ---`);

  const spec: InstanceSpec = {
    gpuTypes: ['RTX 4090', 'RTX 3090', 'RTX A5000', 'RTX A4000', 'RTX 4080', 'RTX 3080'],
    dockerImage: 'marcosremar/parle-s2s-ultralight:latest',
    storageGb: 10,
    cancelUnavail: false,
  };

  for (let i = 0; i < NUM_MACHINES; i++) {
    try {
      console.log(`  [${i + 1}/${NUM_MACHINES}] Creating...`);
      const inst = await client.createInstance(spec, creds);
      created.push(inst);
      console.log(`  [${i + 1}/${NUM_MACHINES}] ✓ ${inst.instanceId} | ${inst.gpuType} | ${inst.endpoint || '(pending)'}`);
    } catch (err) {
      console.error(`  [${i + 1}/${NUM_MACHINES}] ✗ FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    // No extra sleep needed — VastClient now rate-limits internally
  }

  console.log(`\n  Created ${created.length}/${NUM_MACHINES} machines`);
  if (created.length === 0) { console.error('No machines, aborting.'); process.exit(1); }

  // ── Step 2: Wait for boot ──────────────────────────────────────────────
  console.log(`\n--- Step 2: Wait for boot (max ${BOOT_TIMEOUT_MS / 1000}s) ---`);
  const startTime = Date.now();
  const ready = new Set<string>();

  while (Date.now() - startTime < BOOT_TIMEOUT_MS && ready.size < created.length) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    for (const inst of created) {
      if (ready.has(inst.instanceId)) continue;
      const status = await client.getInstanceStatus(inst.instanceId, creds);
      const ep = await client.resolveInstanceEndpoint(inst.instanceId, creds);
      if (status === 'running' && ep) {
        ready.add(inst.instanceId);
        console.log(`  [${elapsed}s] ${inst.instanceId}: READY → ${ep}`);
      }
    }

    if (ready.size < created.length) {
      const pending = created.filter(i => !ready.has(i.instanceId));
      // Check status of pending ones
      for (const inst of pending) {
        const status = await client.getInstanceStatus(inst.instanceId, creds);
        if (status && status !== 'running') {
          console.log(`  [${elapsed}s] ${inst.instanceId}: ${status}`);
        }
      }
      console.log(`  [${elapsed}s] ${ready.size}/${created.length} ready, waiting...`);
      await sleep(15_000);
    }
  }

  console.log(`\n  ${ready.size}/${created.length} machines booted`);

  // ── Step 3: Inspect port mappings (TCP + UDP) ──────────────────────────
  console.log('\n--- Step 3: Port mappings (TCP + UDP) ---');
  console.log('  ' + 'Instance'.padEnd(18) + ' | ' + 'Status'.padEnd(10) + ' | ' + 'IP'.padEnd(16) + ' | ' + 'MachineID'.padEnd(10) + ' | ' + '8000/tcp'.padEnd(10) + ' | ' + '8001/udp'.padEnd(10) + ' | ' + 'Alive?');
  console.log('  ' + '-'.repeat(105));

  let tcpMapped = 0;
  let udpMapped = 0;
  let alive = 0;
  const hostIps = new Set<string>();

  for (const inst of created) {
    const raw = await fetchRawInstance(inst.instanceId);
    if (!raw) {
      console.log(`  ${inst.instanceId.padEnd(18)} | DEAD (404)`);
      continue;
    }

    alive++;
    const ports = raw.ports as Record<string, unknown> | undefined;
    const tcpPort = extractPort(ports, '8000/tcp');
    const udpPort = extractPort(ports, '8001/udp');
    if (tcpPort !== '-') tcpMapped++;
    if (udpPort !== '-') udpMapped++;
    const status = String(raw.actual_status ?? '-');
    const ip = String(raw.public_ipaddr ?? '-');
    const machId = String(raw.machine_id ?? raw.host_id ?? '-');
    hostIps.add(ip);

    console.log(`  ${inst.instanceId.padEnd(18)} | ${status.padEnd(10)} | ${ip.padEnd(16)} | ${machId.padEnd(10)} | ${tcpPort.padEnd(10)} | ${udpPort.padEnd(10)} | ✓`);
  }
  console.log(`\n  Unique hosts: ${hostIps.size}/${alive}`);

  // ── Step 4: HTTP probes ────────────────────────────────────────────────
  console.log('\n--- Step 4: HTTP probes ---');
  let httpOk = 0;

  for (const inst of created) {
    const ep = await client.resolveInstanceEndpoint(inst.instanceId, creds);
    if (!ep) {
      console.log(`  ${inst.instanceId} | no endpoint | SKIP`);
      continue;
    }

    const probe = await httpProbe(`${ep}/health`);
    if (probe.ok) {
      httpOk++;
      console.log(`  ${inst.instanceId} | ${ep}/health | ✓ OK (${probe.ms}ms, ${probe.status})`);
    } else {
      console.log(`  ${inst.instanceId} | ${ep}/health | ✗ FAIL: ${probe.error} (${probe.ms}ms)`);
    }
  }

  // ── Step 5: Cleanup ─────────────────────────────────────────────────────
  console.log('\n--- Step 5: Cleanup — DESTROY ALL ---');
  for (const inst of created) {
    try {
      await client.deleteInstance(inst.instanceId, creds);
      console.log(`  ${inst.instanceId}: destroyed`);
    } catch (err) {
      console.error(`  ${inst.instanceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await sleep(3000);
  const remaining = await client.listInstances(creds);
  console.log(`\n  Remaining: ${remaining.length}`);

  // ── Report ─────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(100));
  console.log('  RESULTS');
  console.log('='.repeat(100));
  console.log(`  Machines created: ${created.length}/${NUM_MACHINES}`);
  console.log(`  Machines booted:  ${ready.size}/${created.length}`);
  console.log(`  Still alive:      ${alive}/${created.length}`);
  console.log(`  TCP mapped:       ${tcpMapped}/${alive}`);
  console.log(`  UDP mapped:       ${udpMapped}/${alive}`);
  console.log(`  HTTP OK:          ${httpOk}/${created.length}`);
  console.log('='.repeat(100));
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
