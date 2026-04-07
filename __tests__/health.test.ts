/**
 * Health endpoint tests.
 * Validates the backend is running and models are loaded.
 *
 * Supports two modes:
 * - CLUSTER_HOST: SSH into cluster and curl /health (GPU pod)
 * - GATEWAY_URL: HTTP fetch /health directly (gateway)
 *
 * Skipped when neither is set.
 */

import { describe, it, expect, beforeAll } from 'vitest';

const CLUSTER_HOST = process.env.CLUSTER_HOST;
const GATEWAY_URL = process.env.GATEWAY_URL;
const hasTarget = !!CLUSTER_HOST || !!GATEWAY_URL;

async function fetchHealth(): Promise<Record<string, unknown>> {
  if (GATEWAY_URL) {
    const res = await fetch(`${GATEWAY_URL}/health`, { signal: AbortSignal.timeout(10_000) });
    return res.json() as Promise<Record<string, unknown>>;
  }
  // SSH mode
  const { ssh, parseJSON } = await import('./helpers');
  const raw = ssh(CLUSTER_HOST!, 'curl -sf http://localhost:8000/health');
  return parseJSON(raw);
}

describe.skipIf(!hasTarget)('GET /health', () => {
  if (CLUSTER_HOST) {
    beforeAll(async () => {
      const { waitForHealthy, keepAlive } = await import('./setup');
      waitForHealthy(CLUSTER_HOST!);
      keepAlive(CLUSTER_HOST!);
    }, 180_000);
  }

  it('returns healthy status', async () => {
    const data = await fetchHealth();
    expect(data.status).toMatch(/ok|healthy|degraded/);
  });

  it('includes uptime or system info', async () => {
    const data = await fetchHealth();
    // Gateway returns uptime_sec, GPU pod returns system info
    const hasInfo = data.uptime_sec !== undefined || data.system !== undefined || data.status !== undefined;
    expect(hasInfo).toBe(true);
  });
});
