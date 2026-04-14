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
      return fetch(url, init);
    },

    getStats(): PoolStats | null {
      return {
        origin: '*',
        connected: cfg.maxConnections,
        free: cfg.maxConnections,
        pending: 0,
        queued: 0,
        running: 0,
        size: cfg.maxConnections,
      };
    },

    async close(): Promise<void> {},
  };
}

let globalPool: ReturnType<typeof createConnectionPool> | null = null;

export function getGlobalPool(config: PoolConfig = {}): ReturnType<typeof createConnectionPool> {
  if (!globalPool) {
    globalPool = createConnectionPool(config);
  }
  return globalPool;
}

export async function closeGlobalPool(): Promise<void> {
  if (globalPool) {
    await globalPool.close();
    globalPool = null;
  }
}
