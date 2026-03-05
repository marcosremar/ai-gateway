/**
 * Cluster test setup — provides helpers for SSH-based integration tests.
 * Tests using this module require a live GPU cluster reachable via SSH.
 * Set CLUSTER_HOST env var to enable; tests are skipped otherwise.
 */

import { execSync } from 'child_process';

export interface ClusterInfo {
  cluster: string;
}

/**
 * Require a cluster host. Throws (skips suite) if CLUSTER_HOST is not set.
 */
export function requireCluster(): ClusterInfo {
  const cluster = process.env.CLUSTER_HOST;
  if (!cluster) {
    throw new Error('SKIP: CLUSTER_HOST not set — skipping cluster tests');
  }
  return { cluster };
}

/**
 * Poll until the health endpoint responds healthy, or throw after timeout.
 */
export function waitForHealthy(cluster: string, timeoutMs = 120_000): void {
  if (!cluster) return;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = execSync(`ssh ${cluster} 'curl -sf http://localhost:8000/health || echo NOT_READY'`, {
        encoding: 'utf-8', timeout: 15_000,
      });
      if (result && !result.includes('NOT_READY')) return;
    } catch {
      // Not ready yet
    }
    // Brief pause
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { /* spin */ }
  }
  throw new Error(`Cluster ${cluster} did not become healthy within ${timeoutMs}ms`);
}

/**
 * Keep the cluster alive during tests by sending periodic pings.
 * Returns a cleanup function.
 */
export function keepAlive(cluster: string, intervalMs = 30_000): () => void {
  if (!cluster) return () => {};
  const timer = setInterval(() => {
    try { execSync(`ssh ${cluster} 'echo keepalive'`, { timeout: 5000 }); } catch { /* ignore */ }
  }, intervalMs);
  return () => clearInterval(timer);
}
