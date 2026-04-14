/**
 * CQRS for GPU State — separates read and write models for GPU state management.
 *
 * Query side: Optimized for reading GPU state (status, health, metrics).
 * Command side: Optimized for modifying GPU state (boot, stop, terminate).
 *
 * This separation allows independent scaling, caching, and optimization
 * of reads vs writes.
 *
 * @example
 * ```ts
 * import { createGpuStateStore } from './gpu-state';
 *
 * const store = createGpuStateStore();
 *
 * // Query (read-optimized, can be cached)
 * const status = await store.queries.getGpuStatus(userId);
 *
 * // Command (write-optimized, event-sourced)
 * await store.commands.bootGpu(userId, { gpuType: 'RTX 4090' });
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('gpu-state');

// ── Read Models (Queries) ────────────────────────────────────────────────────

export interface GpuStatusQuery {
  userId: string;
  status: 'running' | 'stopped' | 'booting' | 'error' | 'not_deployed';
  podId?: string;
  endpoint?: string;
  gpuType?: string;
  healthy?: boolean;
  idleSec?: number;
  lastChecked: string;
}

export interface GpuMetricsQuery {
  userId: string;
  bootCount: number;
  totalUptimeSec: number;
  avgBootTimeSec: number;
  totalCostUsd: number;
  lastBootAt?: string;
  lastStopAt?: string;
}

export interface GpuHistoryQuery {
  userId: string;
  events: GpuStateEvent[];
}

// ── Write Models (Commands) ─────────────────────────────────────────────────

export interface BootGpuCommand {
  userId: string;
  gpuType: string;
  dockerImage?: string;
  region?: string;
  apiKey?: string;
}

export interface StopGpuCommand {
  userId: string;
  podId?: string;
  destroyAfterHours?: number;
}

export interface TerminateGpuCommand {
  userId: string;
  podId?: string;
  force?: boolean;
}

// ── Events (Event Sourcing) ──────────────────────────────────────────────────

export type GpuStateEvent =
  | { type: 'GPU_BOOT_STARTED'; userId: string; gpuType: string; timestamp: string }
  | { type: 'GPU_BOOT_COMPLETED'; userId: string; podId: string; endpoint: string; timestamp: string }
  | { type: 'GPU_BOOT_FAILED'; userId: string; error: string; timestamp: string }
  | { type: 'GPU_STOPPED'; userId: string; podId: string; timestamp: string }
  | { type: 'GPU_TERMINATED'; userId: string; podId: string; timestamp: string }
  | { type: 'GPU_HEALTH_CHECK'; userId: string; healthy: boolean; timestamp: string }
  | { type: 'GPU_IDLE_TIMEOUT'; userId: string; idleSec: number; timestamp: string };

// ── Query Side ───────────────────────────────────────────────────────────────

class GpuQuerySide {
  private cache = new Map<string, { data: unknown; expiresAt: number }>();
  private readonly cacheTtlMs: number;

  constructor(cacheTtlMs = 5_000) {
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Get GPU status for a user (cached).
   */
  async getStatus(userId: string): Promise<GpuStatusQuery | null> {
    const cached = this.cache.get(`status:${userId}`);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data as GpuStatusQuery;
    }

    // In production, this would query a read-optimized store (Redis, DB)
    const status: GpuStatusQuery | null = null; // Placeholder

    if (status) {
      this.cache.set(`status:${userId}`, {
        data: status,
        expiresAt: Date.now() + this.cacheTtlMs,
      });
    }

    return status;
  }

  /**
   * Get GPU metrics for a user.
   */
  async getMetrics(userId: string): Promise<GpuMetricsQuery> {
    return {
      userId,
      bootCount: 0,
      totalUptimeSec: 0,
      avgBootTimeSec: 0,
      totalCostUsd: 0,
    };
  }

  /**
   * Get GPU event history for a user.
   */
  async getHistory(userId: string, limit = 50): Promise<GpuHistoryQuery> {
    return { userId, events: [] };
  }

  /**
   * Invalidate cache for a user.
   */
  invalidate(userId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`status:${userId}`)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear all caches.
   */
  clearCache(): void {
    this.cache.clear();
  }
}

// ── Command Side ─────────────────────────────────────────────────────────────

class GpuCommandSide {
  private readonly eventLog: GpuStateEvent[] = [];

  /**
   * Boot a GPU for a user.
   */
  async boot(cmd: BootGpuCommand): Promise<{ podId: string; endpoint: string }> {
    const event: GpuStateEvent = {
      type: 'GPU_BOOT_STARTED',
      userId: cmd.userId,
      gpuType: cmd.gpuType,
      timestamp: new Date().toISOString(),
    };
    this.eventLog.push(event);

    log.log({ userId: cmd.userId, gpuType: cmd.gpuType }, 'GPU boot started');

    // In production, this would call the GPU provider API
    return { podId: 'mock-pod', endpoint: 'https://mock:8000' };
  }

  /**
   * Stop a GPU.
   */
  async stop(cmd: StopGpuCommand): Promise<void> {
    const event: GpuStateEvent = {
      type: 'GPU_STOPPED',
      userId: cmd.userId,
      podId: cmd.podId ?? 'unknown',
      timestamp: new Date().toISOString(),
    };
    this.eventLog.push(event);

    log.log({ userId: cmd.userId, podId: cmd.podId }, 'GPU stopped');
  }

  /**
   * Terminate a GPU permanently.
   */
  async terminate(cmd: TerminateGpuCommand): Promise<void> {
    const event: GpuStateEvent = {
      type: 'GPU_TERMINATED',
      userId: cmd.userId,
      podId: cmd.podId ?? 'unknown',
      timestamp: new Date().toISOString(),
    };
    this.eventLog.push(event);

    log.log({ userId: cmd.userId, podId: cmd.podId, force: cmd.force }, 'GPU terminated');
  }

  /**
   * Get event log (for replay/debugging).
   */
  getEvents(): GpuStateEvent[] {
    return [...this.eventLog];
  }

  /**
   * Replay events to rebuild state.
   */
  async replay(events: GpuStateEvent[]): Promise<void> {
    for (const event of events) {
      this.eventLog.push(event);
    }
    log.log({ count: events.length }, 'Events replayed');
  }
}

// ── CQRS Store ───────────────────────────────────────────────────────────────

export interface GpuStateStore {
  queries: GpuQuerySide;
  commands: GpuCommandSide;
}

/**
 * Create a CQRS GPU state store.
 */
export function createGpuStateStore(cacheTtlMs = 5_000): GpuStateStore {
  return {
    queries: new GpuQuerySide(cacheTtlMs),
    commands: new GpuCommandSide(),
  };
}
