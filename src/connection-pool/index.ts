/**
 * Connection pooling for provider HTTP requests.
 *
 * Uses undici Agent with custom pool sizing when available.
 * Falls back to global fetch otherwise.
 */

import { createLogger } from '../logger';

const log = createLogger('connection-pool');

export interface PoolConfig {
  maxConnections?: number;
  keepAlive?: boolean;
  keepAliveTimeoutMs?: number;
  timeoutMs?: number;
  pipelining?: number;
}

const DEFAULT_CONFIG: Required<PoolConfig> = {
  maxConnections: 10,
  keepAlive: true,
  keepAliveTimeoutMs: 30_000,
  timeoutMs: 60_000,
  pipelining: 1,
};

export interface PoolStats {
  origin: string;
  connected: number;
  free: number;
  pending: number;
  queued: number;
  running: number;
  size: number;
}

export function createConnectionPool(config: PoolConfig = {}) {
  const cfg: Required<PoolConfig> = { ...DEFAULT_CONFIG, ...config };

  return {
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      // Enforce the pool's timeout via AbortSignal — without this the
      // `timeoutMs` config was inert and the pool would hang forever on a
      // slow upstream.
      const signal = init?.signal ?? AbortSignal.timeout(cfg.timeoutMs);
      try {
        return await fetch(url, { ...init, signal });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          throw new Error(`fetch timeout after ${cfg.timeoutMs}ms: ${url}`);
        }
        throw err;
      }
    },

    getStats(): PoolStats | null {
      // #738: this wrapper delegates to global `fetch` and does not own an
      // undici dispatcher, so it cannot know real connection counts. Returning
      // fabricated `connected/free` numbers masked actual exhaustion on
      // dashboards. Return `null` ("unknown") until a real Agent is wired.
      return null;
    },

    /** Effective configuration (read-only) — handy for diagnostics/tests. */
    getConfig(): Required<PoolConfig> {
      return { ...cfg };
    },

    async close(): Promise<void> {},
  };
}

let globalPool: ReturnType<typeof createConnectionPool> | null = null;

/**
 * Get the process-wide shared pool.
 *
 * #742: this is a singleton — `config` is honored ONLY on the first call that
 * constructs the pool. Later callers passing a *different* config previously
 * got the original silently; we now log a warning so the mismatch is visible.
 * Use {@link resetGlobalPool} to deliberately rebuild with new config.
 */
export function getGlobalPool(config: PoolConfig = {}): ReturnType<typeof createConnectionPool> {
  if (!globalPool) {
    globalPool = createConnectionPool(config);
    return globalPool;
  }
  if (Object.keys(config).length > 0) {
    const current = globalPool.getConfig();
    const conflicts = (Object.keys(config) as (keyof PoolConfig)[]).some(
      (k) => config[k] !== undefined && config[k] !== current[k],
    );
    if (conflicts) {
      log.warn(
        { requested: config, effective: current },
        'getGlobalPool: ignoring new config — pool already initialized (call resetGlobalPool to rebuild)',
      );
    }
  }
  return globalPool;
}

/**
 * Tear down and forget the global pool so the next {@link getGlobalPool} rebuilds
 * it with fresh config. Returns the new pool for convenience. (#742)
 */
export async function resetGlobalPool(config: PoolConfig = {}): Promise<ReturnType<typeof createConnectionPool>> {
  await closeGlobalPool();
  globalPool = createConnectionPool(config);
  return globalPool;
}

export async function closeGlobalPool(): Promise<void> {
  if (globalPool) {
    await globalPool.close();
    globalPool = null;
  }
}
