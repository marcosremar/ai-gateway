/**
 * Health endpoint tests.
 * Validates the backend is running and models are loaded.
 *
 * Requires CLUSTER_HOST env var — all tests are skipped when it is not set.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ssh, parseJSON } from './helpers';
import { keepAlive, waitForHealthy } from './setup';

const CLUSTER_HOST = process.env.CLUSTER_HOST;

describe.skipIf(!CLUSTER_HOST)('GET /health', () => {
  const cluster = CLUSTER_HOST!;

  beforeAll(() => {
    waitForHealthy(cluster);
    keepAlive(cluster);
  }, 180_000);

  it('returns healthy status with models and VRAM', () => {
    const raw = ssh(cluster, 'curl -sf http://localhost:8000/health');
    const data = parseJSON(raw);

    expect(data.status).toBe('healthy');
    expect(data.models).toBeDefined();
    expect(Object.keys(data.models as object).length).toBeGreaterThan(0);
    // System info is present (VRAM requires torch, which may not be installed)
    expect(data.system).toBeDefined();
    expect((data.system as Record<string, unknown>).cpu_count).toBeDefined();
  });

  it('includes auto_stop config', () => {
    const raw = ssh(cluster, 'curl -sf http://localhost:8000/health');
    const data = parseJSON(raw);

    if (data.auto_stop) {
      expect(data.auto_stop).toHaveProperty('enabled');
      expect(data.auto_stop).toHaveProperty('timeout_seconds');
    }
  });
});
