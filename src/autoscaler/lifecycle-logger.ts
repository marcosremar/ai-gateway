/**
 * GPU Lifecycle Logger — persistent logging of GPU boot/shutdown/error events.
 *
 * The ai-gateway defines the interface; the host app provides the Prisma-backed
 * implementation so this package stays framework-agnostic.
 */

export interface GpuLifecycleLogEntry {
  userId: string;
  tierIndex: number;
  provider: string;
  eventType:
    | 'boot_started'
    | 'boot_ok'
    | 'boot_failed'
    | 'boot_timeout'
    | 'health_ok'
    | 'health_lost'
    | 'scale_down'
    | 'cleanup'
    | 'cost_alert'
    | 'zombie_deleted'
    | 'tier_stopped'
    | 'tier_started'
    | 'tier_deleted'
    | 'tier_restarted'
    | 'tier_deployed'
    | 'snapshot_created'
    | 'snapshot_restore_attempted'
    | 'snapshot_restore_rejected'
    | 'snapshot_disabled'
    | (string & {});
  instanceId?: string;
  endpoint?: string;
  durationMs?: number;
  trigger?: string;
  oldState?: string;
  newState?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface GpuLifecycleLogger {
  log(entry: GpuLifecycleLogEntry): void | Promise<void>;
}

/** No-op logger for when the host app doesn't provide one. */
export const noopLifecycleLogger: GpuLifecycleLogger = {
  log: () => {},
};
