/**
 * GPU Lifecycle Logger — persistent logging of GPU boot/shutdown/error events.
 *
 * The ai-gateway defines the interface; the host app provides the Prisma-backed
 * implementation so this package stays framework-agnostic.
 *
 * P3-1 (docs/improvement-plan.md): schema declaration — the free-form
 * `metadata` field used to be a bag where different events used different
 * keys. Insights report 2026-04-12 finding #7 showed this made aggregation
 * painful. Typed factories are declared below to move new call sites onto
 * a schema without a big-bang migration. Existing sites continue to use
 * the loose shape until they're touched for another reason, at which point
 * the migration is a one-line swap.
 */

/** All known lifecycle event type strings. Kept as a union so new events
 *  fail typecheck if they drift. Unlike before, `(string & {})` is NOT
 *  included here — new events should be added to this list deliberately. */
export type LifecycleEventType =
  | 'boot_started'
  | 'boot_ok'
  | 'boot_failed'
  | 'boot_timeout'
  | 'boot_rejected'
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
  | 'runaway_pause'
  | 'deploy_rejected'
  | 'provider_disabled';

/** Core fields every lifecycle event carries. */
export interface GpuLifecycleLogEntry {
  userId: string;
  tierIndex: number;
  provider: string;
  /** Accepts the typed union above plus arbitrary strings for legacy
   *  call sites. Over time the `(string & {})` branch should disappear
   *  as the schema migration completes. */
  eventType: LifecycleEventType | (string & {});
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

// ── Typed event factories ──────────────────────────────────────────────────
//
// Each factory constructs a well-formed event of a specific type with the
// fields that type is supposed to carry. New call sites should use these
// rather than calling `logger.log({ ... })` directly — TypeScript then
// catches missing or misnamed fields at compile time.
//
// The factories intentionally return GpuLifecycleLogEntry so they're drop-in
// replacements for the existing loose shape. No runtime wrapper, no extra
// layer to trip over.

export function bootStartedEvent(fields: {
  userId: string;
  tierIndex: number;
  provider: string;
  dockerImage?: string;
  gpuTypes?: string[];
  attempt?: number;
  trigger?: string;
}): GpuLifecycleLogEntry {
  return {
    userId: fields.userId,
    tierIndex: fields.tierIndex,
    provider: fields.provider,
    eventType: 'boot_started',
    oldState: 'idle',
    newState: 'booting',
    trigger: fields.trigger ?? 'autoscaler',
    metadata: {
      dockerImage: fields.dockerImage,
      gpuTypes: fields.gpuTypes,
      attempt: fields.attempt ?? 0,
    },
  };
}

export function bootOkEvent(fields: {
  userId: string;
  tierIndex: number;
  provider: string;
  durationMs: number;
  instanceId?: string;
  endpoint?: string;
  trigger?: string;
}): GpuLifecycleLogEntry {
  return {
    userId: fields.userId,
    tierIndex: fields.tierIndex,
    provider: fields.provider,
    eventType: 'boot_ok',
    durationMs: fields.durationMs,
    instanceId: fields.instanceId,
    endpoint: fields.endpoint,
    trigger: fields.trigger,
    oldState: 'booting',
    newState: 'ready',
  };
}

export function bootFailedEvent(fields: {
  userId: string;
  tierIndex: number;
  provider: string;
  durationMs: number;
  error: string;
  failureCategory: string;
  failCount: number;
  cooldownMs: number;
  estimatedWasteCost?: number;
  instanceId?: string;
}): GpuLifecycleLogEntry {
  return {
    userId: fields.userId,
    tierIndex: fields.tierIndex,
    provider: fields.provider,
    eventType: 'boot_failed',
    durationMs: fields.durationMs,
    error: fields.error,
    instanceId: fields.instanceId,
    oldState: 'booting',
    newState: 'idle',
    metadata: {
      failureCategory: fields.failureCategory,
      failCount: fields.failCount,
      cooldownMs: fields.cooldownMs,
      estimatedWasteCost: fields.estimatedWasteCost,
    },
  };
}

export function deployRejectedEvent(fields: {
  userId: string;
  tierIndex: number;
  provider: string;
  reason: 'budget_cap' | 'runaway_detector' | 'preflight' | string;
  currentSpend?: number;
  projected?: number;
  cap?: number;
}): GpuLifecycleLogEntry {
  return {
    userId: fields.userId,
    tierIndex: fields.tierIndex,
    provider: fields.provider,
    eventType: 'deploy_rejected',
    error: fields.reason,
    metadata: {
      reason: fields.reason,
      currentSpend: fields.currentSpend,
      projected: fields.projected,
      cap: fields.cap,
    },
  };
}

export function runawayPauseEvent(fields: {
  userId: string;
  tierIndex: number;
  provider: string;
  recentStarts: number;
  pausedUntilMs: number;
  reason?: string;
}): GpuLifecycleLogEntry {
  return {
    userId: fields.userId,
    tierIndex: fields.tierIndex,
    provider: fields.provider,
    eventType: 'runaway_pause',
    metadata: {
      recentStarts: fields.recentStarts,
      pausedUntilMs: fields.pausedUntilMs,
      reason: fields.reason,
    },
  };
}

/** No-op logger for when the host app doesn't provide one. */
export const noopLifecycleLogger: GpuLifecycleLogger = {
  log: () => {},
};
