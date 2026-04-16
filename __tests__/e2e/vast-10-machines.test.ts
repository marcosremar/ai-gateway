/**
 * Vast.ai 10-Machine Stress Test
 *
 * Launches 10 machines in parallel, collects timing/networking data,
 * tests stop/start/reboot lifecycle, and generates a report.
 *
 * Goal: gather real-world data to improve the ai-gateway Vast.ai client.
 *
 * Run: VAST_API_KEY=<key> SKIP_GPU_TESTS=1 bunx vitest run __tests__/vast-10-machines.test.ts --reporter=verbose
 * Set SKIP_GPU_TESTS=1 to skip (default when running full suite)
 */

import { describe, it, expect, afterAll } from 'vitest';
import { VastClient } from '@ai-gateway/gpu-providers/vast-client';
import type { ProviderCredentials, InstanceSpec, GpuInstance } from '@ai-gateway/gpu-providers/types';

// ── Config ────────────────────────────────────────────────────────────────────

const VAST_API_KEY = process.env.VAST_API_KEY;
const VAST_API_BASE = 'https://console.vast.ai/api/v0';
const NUM_MACHINES = 10;
const CLEANUP_ON_FINISH = true;

// Use ultralight image — smallest, fastest boot
const DOCKER_IMAGE = 'marcosremar/parle-s2s-ultralight:latest';

// GPU types to try (cheap ones first)
const GPU_PREFERENCES = ['RTX 4090', 'RTX 3090', 'RTX A5000', 'RTX A4000', 'RTX 4080', 'RTX 3080'];

// ── Types ────────────────────────────────────────────────────────────────────

interface MachineResult {
  index: number;
  instanceId?: string;
  gpuType?: string;
  pricePerHr?: number;
  createStartMs: number;
  createEndMs: number;
  createDurationMs: number;
  endpointAtCreate?: string;
  ipAtCreate?: string;
  status?: string;
  // Lifecycle tests
  stopDurationMs?: number;
  startDurationMs?: number;
  rebootDurationMs?: number;
  statusAfterStop?: string | null;
  statusAfterStart?: string | null;
  statusAfterReboot?: string | null;
  // Networking
  httpReachable?: boolean;
  httpLatencyMs?: number;
  httpError?: string;
  sshHost?: string;
  sshPort?: number;
  // Final
  destroyDurationMs?: number;
  error?: string;
}

const results: MachineResult[] = [];
const createdInstanceIds: string[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

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

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - start };
}

async function httpProbe(endpoint: string, timeoutMs = 10_000): Promise<{ ok: boolean; ms: number; error?: string }> {
  if (!endpoint) return { ok: false, ms: 0, error: 'no endpoint' };
  const start = Date.now();
  try {
    const res = await fetch(`${endpoint}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

function printReport(results: MachineResult[]): void {
  console.log('\n' + '='.repeat(100));
  console.log('  VAST.AI 10-MACHINE TEST REPORT');
  console.log('='.repeat(100));

  const successful = results.filter(r => !r.error);
  const failed = results.filter(r => r.error);

  console.log(`\nSummary: ${successful.length} created / ${failed.length} failed / ${results.length} total`);

  // Create timing stats
  if (successful.length > 0) {
    const createTimes = successful.map(r => r.createDurationMs);
    const avgCreate = createTimes.reduce((a, b) => a + b, 0) / createTimes.length;
    const minCreate = Math.min(...createTimes);
    const maxCreate = Math.max(...createTimes);

    console.log(`\nCreate Duration: avg=${Math.round(avgCreate / 1000)}s, min=${Math.round(minCreate / 1000)}s, max=${Math.round(maxCreate / 1000)}s`);

    // GPU types used
    const gpuCounts = new Map<string, number>();
    for (const r of successful) {
      const gpu = r.gpuType || 'unknown';
      gpuCounts.set(gpu, (gpuCounts.get(gpu) || 0) + 1);
    }
    console.log(`\nGPU Types: ${[...gpuCounts.entries()].map(([g, c]) => `${g}×${c}`).join(', ')}`);

    // Pricing
    const prices = successful.filter(r => r.pricePerHr).map(r => r.pricePerHr!);
    if (prices.length) {
      const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
      const totalPerHr = prices.reduce((a, b) => a + b, 0);
      console.log(`\nPricing: avg=$${avgPrice.toFixed(2)}/hr, total=$${totalPerHr.toFixed(2)}/hr for ${prices.length} machines`);
    }

    // Endpoint availability
    const withEndpoint = successful.filter(r => r.endpointAtCreate);
    const withIp = successful.filter(r => r.ipAtCreate);
    console.log(`\nEndpoints: ${withEndpoint.length}/${successful.length} got endpoint at create time`);
    console.log(`IPs: ${withIp.length}/${successful.length} got IP at create time`);

    // HTTP reachability
    const httpResults = successful.filter(r => r.httpReachable !== undefined);
    const httpOk = httpResults.filter(r => r.httpReachable);
    console.log(`\nHTTP Health: ${httpOk.length}/${httpResults.length} reachable`);
    if (httpOk.length > 0) {
      const latencies = httpOk.map(r => r.httpLatencyMs!);
      console.log(`  Latency: avg=${Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)}ms`);
    }
    const httpErrors = httpResults.filter(r => !r.httpReachable);
    if (httpErrors.length > 0) {
      const errorTypes = new Map<string, number>();
      for (const r of httpErrors) {
        const err = r.httpError || 'unknown';
        const key = err.substring(0, 60);
        errorTypes.set(key, (errorTypes.get(key) || 0) + 1);
      }
      console.log(`  Errors: ${[...errorTypes.entries()].map(([e, c]) => `"${e}"×${c}`).join(', ')}`);
    }

    // Lifecycle tests
    const stopResults = successful.filter(r => r.stopDurationMs !== undefined);
    if (stopResults.length) {
      const stopTimes = stopResults.map(r => r.stopDurationMs!);
      console.log(`\nStop (pause): avg=${Math.round(stopTimes.reduce((a, b) => a + b, 0) / stopTimes.length)}ms`);
      console.log(`  Status after stop: ${stopResults.map(r => r.statusAfterStop).join(', ')}`);
    }

    const startResults = successful.filter(r => r.startDurationMs !== undefined);
    if (startResults.length) {
      const startTimes = startResults.map(r => r.startDurationMs!);
      console.log(`\nStart (resume): avg=${Math.round(startTimes.reduce((a, b) => a + b, 0) / startTimes.length)}ms`);
      console.log(`  Status after start: ${startResults.map(r => r.statusAfterStart).join(', ')}`);
    }

    const rebootResults = successful.filter(r => r.rebootDurationMs !== undefined);
    if (rebootResults.length) {
      const rebootTimes = rebootResults.map(r => r.rebootDurationMs!);
      console.log(`\nReboot: avg=${Math.round(rebootTimes.reduce((a, b) => a + b, 0) / rebootTimes.length)}ms`);
      console.log(`  Status after reboot: ${rebootResults.map(r => r.statusAfterReboot).join(', ')}`);
    }

    // SSH info
    const withSsh = successful.filter(r => r.sshHost);
    console.log(`\nSSH: ${withSsh.length}/${successful.length} have SSH info`);
  }

  // Per-machine detail
  console.log('\n' + '-'.repeat(100));
  console.log('  Per-Machine Details');
  console.log('-'.repeat(100));
  for (const r of results) {
    const line = [
      `#${r.index}`,
      r.instanceId || 'FAILED',
      r.gpuType || '-',
      `create=${Math.round(r.createDurationMs / 1000)}s`,
      r.pricePerHr ? `$${r.pricePerHr.toFixed(2)}/hr` : '-',
      r.endpointAtCreate ? 'has-endpoint' : 'no-endpoint',
      r.httpReachable ? `http-ok(${r.httpLatencyMs}ms)` : (r.httpError ? `http-fail(${r.httpError.substring(0, 30)})` : 'no-test'),
      r.stopDurationMs !== undefined ? `stop=${r.stopDurationMs}ms→${r.statusAfterStop}` : '',
      r.startDurationMs !== undefined ? `start=${r.startDurationMs}ms→${r.statusAfterStart}` : '',
      r.rebootDurationMs !== undefined ? `reboot=${r.rebootDurationMs}ms→${r.statusAfterReboot}` : '',
      r.error ? `ERROR: ${r.error.substring(0, 50)}` : '',
    ].filter(Boolean).join(' | ');
    console.log(`  ${line}`);
  }

  console.log('\n' + '='.repeat(100));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.skipIf(!VAST_API_KEY || process.env.SKIP_GPU_TESTS === '1')('Vast.ai 10-Machine Stress Test', () => {
  const creds: ProviderCredentials = { apiKey: VAST_API_KEY || '' };
  const client = new VastClient();

  // Skip all if no API key
  if (!VAST_API_KEY) {
    it('SKIP: VAST_API_KEY not set', () => {
      console.warn('Set VAST_API_KEY to run this test');
      expect(true).toBe(true);
    });
    return;
  }

  it('Step 1: Launch 10 machines in parallel', async () => {
    console.log(`\nLaunching ${NUM_MACHINES} machines with image: ${DOCKER_IMAGE}`);
    console.log(`GPU preferences: ${GPU_PREFERENCES.join(', ')}`);

    const promises = Array.from({ length: NUM_MACHINES }, async (_, i) => {
      const result: MachineResult = {
        index: i,
        createStartMs: Date.now(),
        createEndMs: 0,
        createDurationMs: 0,
      };

      try {
        const spec: InstanceSpec = {
          gpuTypes: GPU_PREFERENCES,
          gpuCount: 1,
          storageGb: 10,
          dockerImage: DOCKER_IMAGE,
          cancelUnavail: true,
          env: { GROQ_API_KEY: process.env.GROQ_API_KEY || '' },
        };

        const instance = await client.createInstance(spec, creds);

        result.createEndMs = Date.now();
        result.createDurationMs = result.createEndMs - result.createStartMs;
        result.instanceId = instance.instanceId;
        result.gpuType = instance.gpuType;
        result.endpointAtCreate = instance.endpoint || undefined;
        result.ipAtCreate = instance.ipAddress || undefined;
        result.status = instance.status;
        result.sshHost = instance.sshHost;
        result.sshPort = instance.sshPort;

        createdInstanceIds.push(instance.instanceId);
        console.log(`  [${i}] Created ${instance.instanceId} (${instance.gpuType}) in ${Math.round(result.createDurationMs / 1000)}s → ${instance.endpoint || 'no endpoint'}`);
      } catch (err) {
        result.createEndMs = Date.now();
        result.createDurationMs = result.createEndMs - result.createStartMs;
        result.error = err instanceof Error ? err.message : String(err);
        console.error(`  [${i}] FAILED: ${result.error}`);
      }

      results.push(result);
      return result;
    });

    await Promise.all(promises);

    const created = results.filter(r => r.instanceId);
    console.log(`\nCreated ${created.length}/${NUM_MACHINES} machines`);
    expect(created.length).toBeGreaterThan(0);
  }, 300_000); // 5 min

  it('Step 2: Wait 60s for containers to boot, then check status', async () => {
    const created = results.filter(r => r.instanceId);
    if (created.length === 0) return;

    console.log('\nWaiting 60s for containers to initialize...');
    await sleep(60_000);

    // Check status and resolve endpoints
    for (const r of created) {
      try {
        const status = await client.getInstanceStatus(r.instanceId!, creds);
        r.status = status || r.status;
        console.log(`  [${r.index}] ${r.instanceId}: status=${status}`);

        // Try to resolve endpoint if we didn't get one
        if (!r.endpointAtCreate) {
          const ep = await client.resolveInstanceEndpoint(r.instanceId!, creds);
          if (ep) {
            r.endpointAtCreate = ep;
            console.log(`  [${r.index}] Resolved endpoint: ${ep}`);
          }
        }
      } catch (err) {
        console.warn(`  [${r.index}] Status check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, 120_000);

  it('Step 3: HTTP health probe on all machines', async () => {
    const withEndpoint = results.filter(r => r.endpointAtCreate);
    if (withEndpoint.length === 0) {
      console.log('No machines with endpoints to probe');
      return;
    }

    console.log(`\nProbing ${withEndpoint.length} endpoints...`);

    for (const r of withEndpoint) {
      const probe = await httpProbe(r.endpointAtCreate!, 15_000);
      r.httpReachable = probe.ok;
      r.httpLatencyMs = probe.ms;
      r.httpError = probe.error;
      console.log(`  [${r.index}] ${r.endpointAtCreate}: ${probe.ok ? `OK (${probe.ms}ms)` : `FAIL (${probe.error})`}`);
    }

    // Also try direct IP:8000 for machines without resolved endpoints
    const withIpNoEndpoint = results.filter(r => r.ipAtCreate && !r.endpointAtCreate);
    for (const r of withIpNoEndpoint) {
      const directUrl = `http://${r.ipAtCreate}:8000`;
      const probe = await httpProbe(directUrl, 15_000);
      r.httpReachable = probe.ok;
      r.httpLatencyMs = probe.ms;
      r.httpError = probe.error;
      r.endpointAtCreate = directUrl;
      console.log(`  [${r.index}] ${directUrl} (direct): ${probe.ok ? `OK (${probe.ms}ms)` : `FAIL (${probe.error})`}`);
    }
  }, 120_000);

  it('Step 4: Test STOP (pause) on first 3 machines', async () => {
    const created = results.filter(r => r.instanceId).slice(0, 3);
    if (created.length === 0) return;

    console.log(`\nTesting STOP on ${created.length} machines...`);

    for (const r of created) {
      try {
        const { ms } = await timed(() => client.stopInstance(r.instanceId!, creds));
        r.stopDurationMs = ms;
        console.log(`  [${r.index}] stop: ${ms}ms`);

        // Wait a bit then check status
        await sleep(3_000);
        r.statusAfterStop = await client.getInstanceStatus(r.instanceId!, creds);
        console.log(`  [${r.index}] status after stop: ${r.statusAfterStop}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        r.stopDurationMs = -1;
        r.statusAfterStop = `error: ${msg}`;
        console.error(`  [${r.index}] stop FAILED: ${msg}`);
      }
    }
  }, 120_000);

  it('Step 5: Test START (resume) on stopped machines', async () => {
    const stopped = results.filter(r => r.stopDurationMs !== undefined && r.stopDurationMs >= 0);
    if (stopped.length === 0) return;

    console.log(`\nTesting START on ${stopped.length} stopped machines...`);

    for (const r of stopped) {
      try {
        const { ms } = await timed(() => client.startInstance(r.instanceId!, creds));
        r.startDurationMs = ms;
        console.log(`  [${r.index}] start: ${ms}ms`);

        // Wait then check status
        await sleep(5_000);
        r.statusAfterStart = await client.getInstanceStatus(r.instanceId!, creds);
        console.log(`  [${r.index}] status after start: ${r.statusAfterStart}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        r.startDurationMs = -1;
        r.statusAfterStart = `error: ${msg}`;
        console.error(`  [${r.index}] start FAILED: ${msg}`);
      }
    }
  }, 120_000);

  it('Step 6: Test REBOOT on machines 4-6', async () => {
    const targets = results.filter(r => r.instanceId).slice(3, 6);
    if (targets.length === 0) return;

    console.log(`\nTesting REBOOT on ${targets.length} machines...`);

    for (const r of targets) {
      try {
        const { ms } = await timed(() => client.rebootInstance(r.instanceId!, creds));
        r.rebootDurationMs = ms;
        console.log(`  [${r.index}] reboot: ${ms}ms`);

        // Wait then check status
        await sleep(5_000);
        r.statusAfterReboot = await client.getInstanceStatus(r.instanceId!, creds);
        console.log(`  [${r.index}] status after reboot: ${r.statusAfterReboot}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        r.rebootDurationMs = -1;
        r.statusAfterReboot = `error: ${msg}`;
        console.error(`  [${r.index}] reboot FAILED: ${msg}`);
      }
    }
  }, 120_000);

  it('Step 7: List all instances — verify our machines appear', async () => {
    console.log('\nListing all account instances...');

    const all = await client.listInstances(creds);
    console.log(`  Total instances on account: ${all.length}`);

    const ours = all.filter(i => createdInstanceIds.includes(i.instanceId));
    console.log(`  Our test machines found: ${ours.length}/${createdInstanceIds.length}`);

    for (const inst of ours) {
      console.log(`  ${inst.instanceId}: status=${inst.status}, gpu=${inst.gpuType || '-'}, endpoint=${inst.endpoint || 'none'}`);
    }

    expect(ours.length).toBe(createdInstanceIds.length);
  }, 60_000);

  it('Step 8: HTTP probe round 2 — after lifecycle tests', async () => {
    const withEndpoint = results.filter(r => r.endpointAtCreate);
    if (withEndpoint.length === 0) return;

    console.log(`\nHTTP probe round 2 (after lifecycle)...`);

    for (const r of withEndpoint) {
      const probe = await httpProbe(r.endpointAtCreate!, 15_000);
      const label = probe.ok ? `OK (${probe.ms}ms)` : `FAIL (${probe.error})`;
      const changed = r.httpReachable !== probe.ok;
      console.log(`  [${r.index}] ${r.endpointAtCreate}: ${label}${changed ? ' (CHANGED!)' : ''}`);

      // Update to latest state
      if (probe.ok) {
        r.httpReachable = true;
        r.httpLatencyMs = probe.ms;
        r.httpError = undefined;
      }
    }
  }, 120_000);

  it('Step 9: Fetch detailed instance info via API', async () => {
    console.log('\nFetching raw instance details from API...');

    try {
      const res = await fetch(`${VAST_API_BASE}/instances/`, {
        headers: vastHeaders(),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        console.warn(`  API returned HTTP ${res.status}`);
        return;
      }

      const data = (await res.json()) as Record<string, unknown>;
      const instances = data.instances as Array<Record<string, unknown>> | null;
      if (!Array.isArray(instances)) {
        console.warn('  No instances array in response');
        return;
      }

      for (const inst of instances) {
        const id = `inst-${inst.id}`;
        if (!createdInstanceIds.includes(id)) continue;

        // Collect raw data for analysis
        console.log(`\n  === Instance ${id} ===`);
        console.log(`    actual_status: ${inst.actual_status}`);
        console.log(`    cur_state: ${inst.cur_state}`);
        console.log(`    status_msg: ${inst.status_msg}`);
        console.log(`    gpu_name: ${inst.gpu_name}`);
        console.log(`    public_ipaddr: ${inst.public_ipaddr}`);
        console.log(`    ssh_host: ${inst.ssh_host}`);
        console.log(`    ssh_port: ${inst.ssh_port}`);
        console.log(`    direct_port_count: ${inst.direct_port_count}`);
        console.log(`    direct_port_start: ${inst.direct_port_start}`);
        console.log(`    ports: ${JSON.stringify(inst.ports)}`);
        console.log(`    image_uuid: ${inst.image_uuid}`);
        console.log(`    docker_image: ${inst.image}`);
        console.log(`    machine_id: ${inst.machine_id}`);
        console.log(`    host_id: ${inst.host_id}`);
        console.log(`    geolocation: ${inst.geolocation}`);
        console.log(`    inet_up: ${inst.inet_up}Mbps, inet_down: ${inst.inet_down}Mbps`);
        console.log(`    dph_total: $${inst.dph_total}/hr`);
        console.log(`    disk_space: ${inst.disk_space}GB`);
        console.log(`    start_date: ${inst.start_date}`);
      }
    } catch (err) {
      console.warn(`  Failed to fetch details: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 60_000);

  // ── Cleanup ───────────────────────────────────────────────────────────────

  afterAll(async () => {
    // Print report before cleanup
    printReport(results);

    if (!CLEANUP_ON_FINISH || createdInstanceIds.length === 0) {
      console.log('\nSkipping cleanup (CLEANUP_ON_FINISH=false or no instances)');
      return;
    }

    console.log(`\nCleaning up ${createdInstanceIds.length} instances...`);

    for (const id of createdInstanceIds) {
      try {
        await client.deleteInstance(id, creds);
        console.log(`  Destroyed ${id}`);
      } catch (err) {
        console.error(`  Failed to destroy ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Verify cleanup
    await sleep(3_000);
    const remaining = await client.listInstances(creds);
    const ours = remaining.filter(i => createdInstanceIds.includes(i.instanceId));
    if (ours.length > 0) {
      console.warn(`  WARNING: ${ours.length} instances still exist after cleanup!`);
      for (const i of ours) {
        console.warn(`    ${i.instanceId}: ${i.status}`);
      }
    } else {
      console.log('  All instances cleaned up successfully');
    }
  }, 120_000);
});
