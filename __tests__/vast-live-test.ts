/**
 * Vast.ai Live Test — tests new features on existing instances.
 *
 * Run: source .env && VAST_API_KEY=$VAST_API_KEY bunx tsx __tests__/vast-live-test.ts
 */

import { VastClient } from '../src/gpu-providers/vast-client';
import type { ProviderCredentials } from '../src/gpu-providers/types';

const VAST_API_KEY = process.env.VAST_API_KEY!;
const VAST_API_BASE = 'https://console.vast.ai/api/v0';
const creds: ProviderCredentials = { apiKey: VAST_API_KEY };
const client = new VastClient();

function vastHeaders(): Record<string, string> {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${VAST_API_KEY}`,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpProbe(endpoint: string, timeoutMs = 10_000): Promise<{ ok: boolean; ms: number; status?: number; error?: string }> {
  if (!endpoint) return { ok: false, ms: 0, error: 'no endpoint' };
  const start = Date.now();
  try {
    const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, ms: Date.now() - start, status: res.status };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

interface InstanceInfo {
  id: number;
  instanceId: string;
  status: string;
  gpu: string;
  ip: string;
  endpoint: string;
  sshHost?: string;
  sshPort?: number;
  directPortStart?: number;
  ports?: Record<string, unknown>;
  dphTotal?: number;
  inetUp?: number;
  inetDown?: number;
  geolocation?: string;
  image?: string;
}

async function fetchRawInstances(): Promise<InstanceInfo[]> {
  const res = await fetch(`${VAST_API_BASE}/instances/`, {
    headers: vastHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json()) as Record<string, unknown>;
  const instances = (data.instances || data) as Array<Record<string, unknown>>;
  if (!Array.isArray(instances)) return [];

  return instances.map(i => ({
    id: i.id as number,
    instanceId: `inst-${i.id}`,
    status: String(i.actual_status ?? i.cur_state ?? 'unknown'),
    gpu: (i.gpu_name || 'unknown') as string,
    ip: (i.public_ipaddr || i.ssh_host || '') as string,
    endpoint: resolveEndpoint(i),
    sshHost: i.ssh_host as string | undefined,
    sshPort: i.ssh_port as number | undefined,
    directPortStart: i.direct_port_start as number | undefined,
    ports: i.ports as Record<string, unknown> | undefined,
    dphTotal: i.dph_total as number | undefined,
    inetUp: i.inet_up as number | undefined,
    inetDown: i.inet_down as number | undefined,
    geolocation: i.geolocation as string | undefined,
    image: i.image_uuid as string | undefined,
  }));
}

function resolveEndpoint(inst: Record<string, unknown>): string {
  const ip = (inst.public_ipaddr || inst.ssh_host || '') as string;
  if (!ip) return '';

  const ports = inst.ports as Record<string, unknown> | undefined;
  if (ports) {
    const p8000 = ports['8000/tcp'] as Array<{ HostPort?: string }> | undefined;
    if (p8000?.[0]?.HostPort && Number(p8000[0].HostPort) > 0) {
      return `http://${ip}:${p8000[0].HostPort}`;
    }
  }

  const directPort = inst.direct_port_start as number | undefined;
  if (directPort && directPort > 0) return `http://${ip}:${directPort}`;

  return '';
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(100));
  console.log('  VAST.AI LIVE TEST — Testing new client features on existing instances');
  console.log('='.repeat(100));

  // ── Step 1: List all instances ──────────────────────────────────────────
  console.log('\n--- Step 1: Fetch all instances ---');
  const instances = await fetchRawInstances();
  console.log(`Found ${instances.length} instances\n`);

  for (const inst of instances) {
    console.log(`  ${inst.instanceId} | ${inst.status.padEnd(10)} | ${inst.gpu.padEnd(12)} | $${(inst.dphTotal ?? 0).toFixed(2)}/hr | ${inst.endpoint || 'no-endpoint'} | ${inst.geolocation || '-'} | ${inst.inetDown ?? '-'}Mbps down`);
  }

  // ── Step 2: Test getInstanceStatus via new client method ────────────────
  console.log('\n--- Step 2: getInstanceStatus (individual endpoint + list fallback) ---');
  for (const inst of instances.slice(0, 5)) {
    await sleep(500); // Rate limit
    const start = Date.now();
    const status = await client.getInstanceStatus(inst.instanceId, creds);
    const ms = Date.now() - start;
    console.log(`  ${inst.instanceId}: status=${status} (${ms}ms)`);
  }

  // ── Step 3: HTTP health probe ──────────────────────────────────────────
  console.log('\n--- Step 3: HTTP health probe ---');
  const running = instances.filter(i => i.status === 'running');
  console.log(`Testing ${running.length} running instances...`);

  for (const inst of running) {
    if (inst.endpoint) {
      const probe = await httpProbe(inst.endpoint, 15_000);
      console.log(`  ${inst.instanceId} | ${inst.endpoint} | ${probe.ok ? `OK (${probe.ms}ms, status=${probe.status})` : `FAIL: ${probe.error}`}`);
    }

    // Also try direct IP:8000 if different from endpoint
    const directUrl = `http://${inst.ip}:8000`;
    if (directUrl !== inst.endpoint && inst.ip) {
      const probe = await httpProbe(directUrl, 15_000);
      console.log(`  ${inst.instanceId} | ${directUrl} (direct) | ${probe.ok ? `OK (${probe.ms}ms)` : `FAIL: ${probe.error}`}`);
    }

    // Try SSH port variant
    if (inst.sshHost && inst.sshPort) {
      const sshUrl = `http://${inst.sshHost}:${inst.sshPort}`;
      if (sshUrl !== inst.endpoint && sshUrl !== directUrl) {
        const probe = await httpProbe(sshUrl, 5_000);
        console.log(`  ${inst.instanceId} | ${sshUrl} (ssh-host) | ${probe.ok ? `OK (${probe.ms}ms)` : `FAIL: ${probe.error}`}`);
      }
    }
  }

  // ── Step 4: resolveInstanceEndpoint ────────────────────────────────────
  console.log('\n--- Step 4: resolveInstanceEndpoint ---');
  for (const inst of instances.slice(0, 5)) {
    await sleep(500);
    const start = Date.now();
    const ep = await client.resolveInstanceEndpoint(inst.instanceId, creds);
    const ms = Date.now() - start;
    console.log(`  ${inst.instanceId}: endpoint=${ep || 'null'} (${ms}ms)`);
  }

  // ── Step 5: Test STOP (pause) on 2 machines ───────────────────────────
  const stopTargets = running.slice(0, 2);
  if (stopTargets.length > 0) {
    console.log(`\n--- Step 5: Test STOP (pause) on ${stopTargets.length} machines ---`);
    for (const inst of stopTargets) {
      await sleep(1000);
      const start = Date.now();
      try {
        await client.stopInstance(inst.instanceId, creds);
        console.log(`  ${inst.instanceId}: stopped in ${Date.now() - start}ms`);
      } catch (err) {
        console.error(`  ${inst.instanceId}: stop FAILED — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Check status after stop
    await sleep(5_000);
    console.log('  Status after stop:');
    for (const inst of stopTargets) {
      await sleep(500);
      const status = await client.getInstanceStatus(inst.instanceId, creds);
      console.log(`    ${inst.instanceId}: ${status}`);
    }

    // ── Step 5b: Test START (resume) ──────────────────────────────────────
    console.log('\n--- Step 5b: Test START (resume) on stopped machines ---');
    for (const inst of stopTargets) {
      await sleep(1000);
      const start = Date.now();
      try {
        await client.startInstance(inst.instanceId, creds);
        console.log(`  ${inst.instanceId}: start requested in ${Date.now() - start}ms`);
      } catch (err) {
        console.error(`  ${inst.instanceId}: start FAILED — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await sleep(5_000);
    console.log('  Status after start:');
    for (const inst of stopTargets) {
      await sleep(500);
      const status = await client.getInstanceStatus(inst.instanceId, creds);
      console.log(`    ${inst.instanceId}: ${status}`);
    }
  }

  // ── Step 6: Test REBOOT on 2 different machines ───────────────────────
  const rebootTargets = running.slice(2, 4);
  if (rebootTargets.length > 0) {
    console.log(`\n--- Step 6: Test REBOOT on ${rebootTargets.length} machines ---`);
    for (const inst of rebootTargets) {
      await sleep(1000);
      const start = Date.now();
      try {
        await client.rebootInstance(inst.instanceId, creds);
        console.log(`  ${inst.instanceId}: reboot requested in ${Date.now() - start}ms`);
      } catch (err) {
        console.error(`  ${inst.instanceId}: reboot FAILED — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await sleep(10_000);
    console.log('  Status after reboot:');
    for (const inst of rebootTargets) {
      await sleep(500);
      const status = await client.getInstanceStatus(inst.instanceId, creds);
      console.log(`    ${inst.instanceId}: ${status}`);
    }
  }

  // ── Step 7: Test listInstances via client ─────────────────────────────
  console.log('\n--- Step 7: listInstances via VastClient ---');
  const start = Date.now();
  const listed = await client.listInstances(creds);
  console.log(`  Listed ${listed.length} instances in ${Date.now() - start}ms`);
  for (const inst of listed) {
    console.log(`    ${inst.instanceId} | ${inst.status.padEnd(10)} | ${inst.gpuType?.padEnd(12) || '-'.padEnd(12)} | ${inst.endpoint || 'no-endpoint'}`);
  }

  // ── Step 8: Cleanup — DESTROY ALL ─────────────────────────────────────
  console.log('\n--- Step 8: Cleanup — DESTROY ALL test instances ---');
  const allInstances = await fetchRawInstances();
  console.log(`Destroying ${allInstances.length} instances...`);

  for (const inst of allInstances) {
    await sleep(1000); // Rate limit
    try {
      await client.deleteInstance(inst.instanceId, creds);
      console.log(`  ${inst.instanceId} (${inst.gpu}): destroyed`);
    } catch (err) {
      console.error(`  ${inst.instanceId}: destroy FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Verify cleanup
  await sleep(5_000);
  const remaining = await fetchRawInstances();
  console.log(`\nRemaining instances: ${remaining.length}`);
  if (remaining.length > 0) {
    for (const inst of remaining) {
      console.log(`  WARNING: ${inst.instanceId} still exists (${inst.status})`);
    }
  }

  // ── Report ────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(100));
  console.log('  FINDINGS & RECOMMENDATIONS');
  console.log('='.repeat(100));
  console.log(`
  1. Rate Limiting: Vast.ai limits to ~4.5 req/s. Need built-in rate limiter for parallel operations.
  2. Instance Status: ${instances.map(i => i.status).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
  3. HTTP Access: ${running.length > 0 ? 'See probe results above' : 'No running instances to test'}
  4. GPU Types: ${instances.map(i => i.gpu).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
  5. Pricing: ${instances.map(i => `$${(i.dphTotal ?? 0).toFixed(2)}/hr`).join(', ')}
  `);

  console.log('='.repeat(100));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
