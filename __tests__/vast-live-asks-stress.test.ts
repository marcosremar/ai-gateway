/**
 * Vast.ai live /asks stress test.
 *
 * This is intentionally opt-in and billable. It calls Vast.ai's real
 * reservation endpoint through VastClient._vastFetch so it exercises the exact
 * /asks/:offer queue/rate-limit path. Any created contracts are deleted in
 * finally/afterAll.
 *
 * Run:
 *   RUN_LIVE_VAST_ASKS_STRESS=1 bunx vitest run --config vitest.config.ts __tests__/vast-live-asks-stress.test.ts --reporter=verbose
 *
 * Useful overrides:
 *   LIVE_VAST_ASKS_COUNT=4
 *   LIVE_VAST_ASKS_QUEUE_MAX=2
 *   LIVE_VAST_ASKS_GPU_TYPES="RTX 4090,RTX 3090"
 *   LIVE_VAST_ASKS_IMAGE="nvidia/cuda:12.4.1-base-ubuntu22.04"
 */

import { afterAll, describe, expect, it } from 'vitest';
import {
  VastClient,
  getVastRateLimitPolicyForTests,
  getVastReservationQueueSnapshotForTests,
  resetVastRateLimitStateForTests,
} from '@ai-gateway/gpu-providers/vast-client';
import type { GpuOffer, ProviderCredentials } from '@ai-gateway/gpu-providers/types';
import { loadEnv } from './helpers';

await loadEnv();

const VAST_API_BASE = 'https://console.vast.ai/api/v0';
const runLive = process.env.RUN_LIVE_VAST_ASKS_STRESS === '1';
const liveCount = Math.max(2, Math.min(8, parseInt(process.env.LIVE_VAST_ASKS_COUNT || '4', 10) || 4));
const liveQueueMax = Math.max(1, Math.min(liveCount, parseInt(process.env.LIVE_VAST_ASKS_QUEUE_MAX || '2', 10) || 2));
const liveImage = process.env.LIVE_VAST_ASKS_IMAGE || 'nvidia/cuda:12.4.1-base-ubuntu22.04';
const liveGpuTypes = (process.env.LIVE_VAST_ASKS_GPU_TYPES || 'RTX 4090,RTX 3090')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

interface AskResult {
  index: number;
  offerId: string;
  gpuType: string;
  pricePerHr: number;
  ok: boolean;
  startedAtMs: number;
  endedAtMs: number;
  status?: number;
  contractId?: string;
  instanceId?: string;
  errorCode?: string;
  error?: string;
}

const client = new VastClient();
const createdInstanceIds: string[] = [];
let creds: ProviderCredentials | undefined;

function headers(apiKey: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

async function reserveOffer(args: {
  index: number;
  offer: GpuOffer;
  runId: string;
  apiKey: string;
}): Promise<AskResult> {
  const { index, offer, runId, apiKey } = args;
  const offerId = String(offer.offerId || '');
  const startedAtMs = Date.now();
  const body: Record<string, unknown> = {
    client_id: 'me',
    image: liveImage,
    label: `aigw-asks-stress-${runId}-${index}`,
    disk: 20,
    runtype: 'ssh_direct',
    cancel_unavail: true,
    onstart: 'nohup bash -lc "sleep infinity" >/tmp/aigw-live-asks-stress.log 2>&1 &',
    env: {
      TZ: 'UTC',
    },
  };

  const dockerUser = process.env.DOCKERHUB_USERNAME || process.env.DOCKER_HUB_USER;
  const dockerToken = process.env.DOCKERHUB_TOKEN || process.env.DOCKER_HUB_TOKEN;
  if (dockerUser && dockerToken) {
    body.image_login = `-u ${dockerUser} -p ${dockerToken} docker.io`;
  }

  try {
    const res = await (client as any)._vastFetch(`${VAST_API_BASE}/asks/${offerId}/`, {
      method: 'PUT',
      headers: headers(apiKey),
      body: JSON.stringify(body),
    }, 90_000);
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { raw: text };
    }

    const contractId = data.new_contract != null ? String(data.new_contract) : '';
    const instanceId = contractId ? `inst-${contractId}` : undefined;
    if (instanceId) createdInstanceIds.push(instanceId);

    return {
      index,
      offerId,
      gpuType: offer.gpuType || offer.gpuName || 'unknown',
      pricePerHr: offer.pricePerHr || 0,
      ok: res.ok && data.success === true && Boolean(contractId),
      startedAtMs,
      endedAtMs: Date.now(),
      status: res.status,
      contractId: contractId || undefined,
      instanceId,
      error: res.ok ? (data.success === true ? undefined : JSON.stringify(data).slice(0, 300)) : text.slice(0, 300),
    };
  } catch (err) {
    const e = err as Error & { code?: string; status?: number };
    return {
      index,
      offerId,
      gpuType: offer.gpuType || offer.gpuName || 'unknown',
      pricePerHr: offer.pricePerHr || 0,
      ok: false,
      startedAtMs,
      endedAtMs: Date.now(),
      status: e.status,
      errorCode: e.code,
      error: e.message,
    };
  }
}

async function cleanupCreated(): Promise<void> {
  if (!creds) return;
  const ids = [...new Set(createdInstanceIds)];
  for (const id of ids) {
    try {
      await client.deleteInstance(id, creds);
      console.log(`[live-asks] cleanup deleted ${id}`);
    } catch (err) {
      console.warn(`[live-asks] cleanup failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

afterAll(async () => {
  await cleanupCreated();
  resetVastRateLimitStateForTests();
  client.dispose?.();
  delete process.env.VAST_RESERVATION_QUEUE_MAX_SIZE;
  delete process.env.VAST_RESERVATION_QUEUE_TIMEOUT_MS;
});

describe.skipIf(!runLive)('Vast.ai live /asks reservation stress', () => {
  it('bounds real /asks reservations, spaces accepted starts, and cleans up created machines', async () => {
    const apiKey = process.env.VAST_API_KEY || '';
    if (!apiKey) throw new Error('VAST_API_KEY is required for RUN_LIVE_VAST_ASKS_STRESS=1');
    creds = { apiKey };

    process.env.VAST_RESERVATION_QUEUE_MAX_SIZE = String(liveQueueMax);
    process.env.VAST_RESERVATION_QUEUE_TIMEOUT_MS = process.env.LIVE_VAST_ASKS_QUEUE_TIMEOUT_MS || '600000';
    resetVastRateLimitStateForTests();

    const policy = getVastRateLimitPolicyForTests(`${VAST_API_BASE}/asks/0/`, {
      method: 'PUT',
      headers: headers(apiKey),
    });

    const asksStartedAtMs: number[] = [];
    const originalFetchRaw = (client as any).fetchRaw.bind(client);
    (client as any).fetchRaw = async (url: string, init?: RequestInit, timeout?: number) => {
      if (String(url).includes('/asks/')) asksStartedAtMs.push(Date.now());
      return await originalFetchRaw(url, init, timeout);
    };

    console.log(`[live-asks] config count=${liveCount} queueMax=${liveQueueMax} reserveIntervalMs=${policy.minIntervalMs} gpuTypes=${liveGpuTypes.join(',')} image=${liveImage}`);

    const offers = await client.listOffers({ gpuTypes: liveGpuTypes, limit: Math.max(liveCount * 3, 12) }, creds);
    expect(offers.length).toBeGreaterThanOrEqual(liveCount);
    const selected = offers.slice(0, liveCount);
    for (const offer of selected) {
      console.log(`[live-asks] offer ${offer.offerId} ${offer.gpuType} $${offer.pricePerHr.toFixed(3)}/h ${offer.region || ''}`);
    }

    const runId = Date.now().toString(36);
    const results = await Promise.all(selected.map((offer, index) => reserveOffer({
      index,
      offer,
      runId,
      apiKey,
    })));

    const created = results.filter(r => r.ok && r.instanceId);
    const queueFull = results.filter(r => r.errorCode === 'VAST_RESERVATION_QUEUE_FULL');
    const otherFailures = results.filter(r => !r.ok && r.errorCode !== 'VAST_RESERVATION_QUEUE_FULL');

    console.log('[live-asks] results:');
    for (const r of results) {
      console.log([
        `  #${r.index}`,
        `offer=${r.offerId}`,
        `gpu=${r.gpuType}`,
        `ok=${r.ok}`,
        r.instanceId ? `instance=${r.instanceId}` : '',
        r.errorCode ? `code=${r.errorCode}` : '',
        r.status ? `status=${r.status}` : '',
        `durationMs=${r.endedAtMs - r.startedAtMs}`,
        r.error ? `error=${r.error.slice(0, 160)}` : '',
      ].filter(Boolean).join(' '));
    }

    const askDeltas = asksStartedAtMs.slice(1).map((ts, idx) => ts - asksStartedAtMs[idx]);
    console.log(`[live-asks] actual PUT /asks starts=${asksStartedAtMs.length}, deltasMs=${askDeltas.join(',') || '(none)'}`);
    console.log(`[live-asks] queue snapshot after results=${JSON.stringify(getVastReservationQueueSnapshotForTests())}`);

    expect(asksStartedAtMs.length).toBeLessThanOrEqual(liveQueueMax);
    expect(queueFull.length).toBeGreaterThanOrEqual(Math.max(0, liveCount - liveQueueMax));
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(created.length).toBeLessThanOrEqual(liveQueueMax);
    for (const delta of askDeltas) {
      expect(delta).toBeGreaterThanOrEqual(policy.minIntervalMs);
    }

    // Marketplace churn is expected, but queue/rate-limit bugs should not
    // surface as generic failures.
    for (const failure of otherFailures) {
      expect(failure.error || '').not.toMatch(/rate limit|too frequent|429/i);
    }
  }, 240_000);
});
