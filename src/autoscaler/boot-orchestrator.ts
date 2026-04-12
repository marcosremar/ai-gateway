import type { GpuTierConfig, GpuTierState, BootingTierState, ReadyTierState, IdleTierState, ScaleTrigger } from '../types';
import { resolveStageTimeouts } from '../types';
import type { GpuProviderRegistry } from '../gpu-providers/registry';
import type { GatewayHooks, ErrorEvent } from '../hooks';
import type { GpuLifecycleLogger } from './lifecycle-logger';
import type { Logger } from '../deps';
import { emitHook } from '../hooks';
import { StageTimeoutError, withStageTimeout } from './stage-timeout';
import { shouldUseSnapshot, type PersistedSnapshot, type SnapshotPolicyDecision } from './snapgpu-policy';
import { SnapgpuMetrics, buildWorkloadKey } from './snapgpu-metrics';

const BOOT_COOLDOWN_BASE_MS = 2 * 60_000;  // 2 min base, exponential backoff
// Max cooldown capped at 15 min (was 30). Observed in production that
// RunPod cooldowns reaching 57 minutes effectively blocked capacity
// recovery — a transient 500 on one deploy locked the autoscaler out of
// the provider for nearly an hour, wasting capacity that returned in
// 10-15 minutes. See docs/improvement-plan.md P1-3 and
// docs/insights/2026-04-12-first-pass.md finding #5.
const BOOT_COOLDOWN_MAX_MS = 15 * 60_000;  // Max 15 min cooldown

/**
 * Failure category classifier and cooldown map (P2-3).
 *
 * Motivation: the old implementation used a single exponential backoff
 * for every failure class, which meant a billing error (24h to self-heal)
 * and a transient capacity error (10min to self-heal) got the same
 * 10-minute cooldown. Splitting by category lets the autoscaler recover
 * from capacity blips 10× faster while still backing off appropriately
 * from persistent issues like account quota blocks.
 *
 * Categories:
 *   - billing / quota: provider account blocked. Won't self-heal without
 *     operator intervention. Long cooldown (24h) keeps us out of the way.
 *   - no_capacity: provider has no GPUs matching our filter. Capacity
 *     returns on the order of minutes. Short cooldown (5 min).
 *   - ssh_tunnel / api_error: transient transport/network blip. Usually
 *     clears in seconds. Short cooldown (2 min) to retry fast.
 *   - docker_image: local config bug (e.g. missing modal CLI). Not
 *     fixable via retries — long cooldown (1h) signals "don't bother".
 *   - unknown: default bucket for the classifier's misses. 10 min gives
 *     a sane middle ground. Observed failures should migrate out of this
 *     bucket over time as categories get added.
 */
export type BootFailureCategory =
  | 'billing'
  | 'quota'
  | 'no_capacity'
  | 'ssh_tunnel'
  | 'api_error'
  | 'docker_image'
  | 'timeout'
  | 'unknown';

const COOLDOWN_BY_CATEGORY: Record<BootFailureCategory, number> = {
  billing:      24 * 60 * 60_000,  // 24h — won't self-heal
  quota:        24 * 60 * 60_000,  // 24h — same
  docker_image: 60 * 60_000,       // 1h — local config bug
  no_capacity:  5 * 60_000,        // 5m — capacity churn is fast
  ssh_tunnel:   2 * 60_000,        // 2m — transient transport
  api_error:    2 * 60_000,        // 2m — transient
  timeout:      5 * 60_000,        // 5m — likely slow host, retry elsewhere
  unknown:      10 * 60_000,       // 10m — sane default
};

/**
 * Classify a failure reason string into one of BootFailureCategory.
 * Pattern-based — intentionally simple. Unknown reasons land in 'unknown'
 * so they show up in metrics and can be promoted to real categories later.
 */
export function classifyBootFailure(reason: string | null | undefined): BootFailureCategory {
  if (!reason) return 'unknown';
  const r = reason.toLowerCase();
  if (r.includes('balance') || r.includes('credit') || r.includes('payment')) return 'billing';
  if (r.includes('quota') || r.includes('machinequota') || r.includes('abuse')) return 'quota';
  if (r.includes('no module named') || r.includes('docker') && r.includes('fail')) return 'docker_image';
  if (r.includes('no gpus') || r.includes('no instances') || r.includes('exhausted') || r.includes('out of capacity')) return 'no_capacity';
  if (r.includes('ssh_tunnel') || r.includes('ssh tunnel')) return 'ssh_tunnel';
  if (r.includes('timeout') || r.includes('timed out')) return 'timeout';
  if (r.includes('http ') || r.includes('api ') || r.includes('rate limit') || r.includes('429') || r.includes('500') || r.includes('502') || r.includes('503')) return 'api_error';
  return 'unknown';
}

/**
 * Compute cooldown duration for a given failure. The categorization wins
 * over exponential backoff for categories with explicit durations. For
 * unknown failures, the old exponential formula applies with the 15-min cap.
 */
export function computeCooldownMs(category: BootFailureCategory, failCount: number): number {
  // For categories where we have an explicit duration, use it directly.
  // Exponential is still applied on top for unknown/api_error/ssh_tunnel
  // so repeated failures of the same category escalate — but still capped.
  const base = COOLDOWN_BY_CATEGORY[category];
  if (category === 'billing' || category === 'quota' || category === 'docker_image') {
    // These don't benefit from exponential — the first failure already
    // says "don't retry for a long time". Return base directly.
    return base;
  }
  // For transient categories, use the smaller of base × 2^(failCount-1) and BOOT_COOLDOWN_MAX_MS.
  const expo = base * Math.pow(2, Math.max(0, failCount - 1));
  return Math.min(expo, BOOT_COOLDOWN_MAX_MS);
}

export interface BootOrchestratorCallbacks {
  getStates(userId: string): GpuTierState[] | undefined;
  setStates(userId: string, states: GpuTierState[]): void;
  persistStates(userId: string, states: GpuTierState[]): void;
  emitError(fields: Omit<ErrorEvent, 'source' | 'timestamp'>): void;
  recordProviderHealthEvent(provider: string, success: boolean): void;
}

export interface BootOrchestratorOptions {
  registry: GpuProviderRegistry;
  probeHealth: (endpoint: string) => Promise<boolean>;
  hooks?: GatewayHooks;
  lifecycleLogger: GpuLifecycleLogger;
  logger: Logger;
  onInstancePersist?: (userId: string, machineKey: string, data: Record<string, unknown>) => Promise<void>;
  /** Read back a value previously written via onInstancePersist. Used to
   *  retrieve the last SnapGPU snapshot ID for a tier across restarts. */
  getPersistedData?: (userId: string, key: string) => Promise<Record<string, unknown> | null>;
  /** Optional per-workload rolling tracker that compares cold-vs-restore
   *  deploy latency and auto-disables the snapshot path when it's losing.
   *  If omitted, a default instance is created — pass your own when you
   *  need to share state across multiple orchestrators or inject fake
   *  clocks in tests. */
  snapgpuMetrics?: SnapgpuMetrics;
  callbacks: BootOrchestratorCallbacks;
}

export type BootResult = {
  ok: boolean;
  instanceId?: string;
  endpoint?: string;
  activeGpuType?: string;
  reason?: string;
  sshHost?: string;
  sshPort?: number;
  monitorUrl?: string;
};

export class BootOrchestrator {
  /** Active boot health pollers — key: "userId:tierIndex:timestamp" (unique per boot attempt) */
  /**
   * Active boot pollers keyed by `${userId}:${tierIndex}:${ts}`.
   *
   * Stored as `{ timer, cancelled }` (not just `timer`) so cancellation works
   * even when a poll is mid-flight. Without the `cancelled` flag, an in-flight
   * poll's promise can call `setTimeout(poll, ...)` AFTER clearTimeout has been
   * called externally, resurrecting the poller under the same key. Each poll
   * iteration checks `cancelled` before re-scheduling.
   */
  private bootPollers = new Map<string, { timer: ReturnType<typeof setTimeout>; cancelled: boolean }>();

  /**
   * Tracks whether the most recent triggerGpuBoot() for a given `${userId}:${tierIndex}`
   * took the snapshot-restore path or the cold-boot path. Written in
   * triggerGpuBoot() and consumed in the health poller when recording the
   * boot duration into SnapgpuMetrics. Using a keyed map (not a flag on
   * tierConfig) avoids mutating the caller's tier config and handles the
   * case where the engine reuses the same tierConfig reference across
   * successive boots.
   */
  private bootPathByTier = new Map<string, 'cold' | 'restore'>();

  private readonly registry: GpuProviderRegistry;
  private readonly probeHealth: (endpoint: string) => Promise<boolean>;
  private readonly hooks?: GatewayHooks;
  private readonly lifecycleLogger: GpuLifecycleLogger;
  private readonly logger: Logger;
  private readonly onInstancePersist?: (userId: string, machineKey: string, data: Record<string, unknown>) => Promise<void>;
  private readonly getPersistedData?: (userId: string, key: string) => Promise<Record<string, unknown> | null>;
  private readonly snapgpuMetrics: SnapgpuMetrics;
  private readonly callbacks: BootOrchestratorCallbacks;

  constructor(opts: BootOrchestratorOptions) {
    this.registry = opts.registry;
    this.probeHealth = opts.probeHealth;
    this.hooks = opts.hooks;
    this.lifecycleLogger = opts.lifecycleLogger;
    this.logger = opts.logger;
    this.onInstancePersist = opts.onInstancePersist;
    this.getPersistedData = opts.getPersistedData;
    this.snapgpuMetrics = opts.snapgpuMetrics ?? new SnapgpuMetrics();
    this.callbacks = opts.callbacks;

    // Surface auto-disable events through the lifecycle logger so cost-monitor
    // dashboards can see why a workload stopped using CRIU restore.
    this.snapgpuMetrics.onDisable((e) => {
      void this.lifecycleLogger.log({
        userId: e.userId,
        tierIndex: -1,
        provider: 'snapgpu',
        eventType: 'snapshot_disabled',
        error: e.reason,
        metadata: {
          workloadKey: e.workloadKey,
          avgColdMs: e.avgColdMs,
          avgRestoreMs: e.avgRestoreMs,
          disabledUntilMs: e.disabledUntilMs,
        },
      });
    });
  }

  /** Expose the metrics tracker for HTTP handlers / observability endpoints. */
  getSnapgpuMetrics(): SnapgpuMetrics {
    return this.snapgpuMetrics;
  }

  async triggerGpuBoot(
    tierConfig: GpuTierConfig,
    tierIndex: number,
    userId: string,
    attempt = 0,
  ): Promise<BootResult> {
    if (attempt >= 2) return { ok: false, reason: 'Max retry attempts reached' };

    // Validate the tier config up front. Without this, missing/invalid fields
    // surface as cryptic errors deep inside the provider client (e.g. "TypeError:
    // Cannot read property 'length' of undefined" 3 minutes into a deploy).
    const validationError = this._validateTierConfig(tierConfig, tierIndex);
    if (validationError) {
      this.logger.warn(`[autoscaler] tier ${tierIndex} config invalid: ${validationError}`);
      this.callbacks.emitError({
        operation: 'triggerGpuBoot:validate', provider: tierConfig.provider || 'unknown',
        tierIndex, userId, message: validationError,
        errorCode: 'INVALID_CONFIG', retryable: false,
      });
      return { ok: false, reason: validationError };
    }

    const cfg = { ...tierConfig };
    let sshHost: string | undefined;
    let sshPort: number | undefined;
    let monitorUrl: string | undefined;

    // Track whether this boot used the restore path or the cold path so we
    // can feed the observation back into SnapgpuMetrics when the boot lands
    // (via handleBootResult + startBootHealthPoller).
    let usedSnapshotRestore = false;

    // ── SnapGPU: policy-gated snapshot restore ─────────────────────────────
    // The old logic restored from any snapshot in the KV store. The new
    // logic runs the snapshot through shouldUseSnapshot() first so we can
    // reject it when the backend can't do CRIU, the workload is unsuitable,
    // the image has drifted, or the metrics tracker has auto-disabled this
    // workload. Rejection reasons are logged to the lifecycle stream for
    // observability.
    if (cfg.provider === 'snapgpu') {
      const appName = cfg.snapgpuPreloadApp || 'default';
      const workloadKey = buildWorkloadKey(cfg.dockerImage, appName);
      let persistedSnapshot: PersistedSnapshot | null = null;

      if (!cfg.snapgpuRestoreFromSnapshot && this.getPersistedData) {
        const snapKey = `snapgpu_snapshot:${appName}`;
        try {
          const saved = await this.getPersistedData(userId, snapKey);
          if (saved?.snapshotId && typeof saved.snapshotId === 'string') {
            persistedSnapshot = {
              snapshotId: saved.snapshotId,
              appName,
              createdAt: typeof saved.createdAt === 'number' ? saved.createdAt : 0,
              imageRef: typeof saved.imageRef === 'string' ? saved.imageRef : undefined,
              backend: typeof saved.backend === 'string' ? saved.backend : undefined,
            };
          }
        } catch (err) {
          this.logger.warn(`[autoscaler] getPersistedData failed for ${snapKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (!this.getPersistedData && !cfg.snapgpuRestoreFromSnapshot) {
        this.logger.warn(`[autoscaler] Tier ${tierIndex} (snapgpu): getPersistedData not wired — snapshot restore disabled. Pass getPersistedData in BootOrchestratorOptions to enable automatic fast cold-starts.`);
      }

      const resolvedBackend = cfg.snapgpuBackend ?? 'vast';
      const decision: SnapshotPolicyDecision = shouldUseSnapshot({
        tierConfig: cfg,
        snapshot: persistedSnapshot,
        autoDisabled: this.snapgpuMetrics.isDisabled(userId, workloadKey),
        resolvedBackend,
      });

      if (decision.use) {
        cfg.snapgpuRestoreFromSnapshot = decision.snapshotId;
        usedSnapshotRestore = true;
        this.logger.log(`[autoscaler] Tier ${tierIndex} (snapgpu): will restore from snapshot ${decision.snapshotId} (backend=${resolvedBackend})`);
        void this.lifecycleLogger.log({
          userId, tierIndex, provider: 'snapgpu',
          eventType: 'snapshot_restore_attempted',
          metadata: { snapshotId: decision.snapshotId, workloadKey, backend: resolvedBackend },
        });
      } else if (persistedSnapshot) {
        // Only log a rejection when we actually had a snapshot to reject.
        // 'no_snapshot' is the normal first-boot case and doesn't warrant a
        // rejection event.
        this.logger.log(`[autoscaler] Tier ${tierIndex} (snapgpu): snapshot restore skipped (${decision.reason})`);
        void this.lifecycleLogger.log({
          userId, tierIndex, provider: 'snapgpu',
          eventType: 'snapshot_restore_rejected',
          metadata: { snapshotId: persistedSnapshot.snapshotId, workloadKey, reason: decision.reason, backend: resolvedBackend },
        });
      }
    }

    // Stash the path so the health poller can record it after boot succeeds.
    // Overwrites any stale entry from a previous failed boot on the same tier.
    this.bootPathByTier.set(`${userId}:${tierIndex}`, usedSnapshotRestore ? 'restore' : 'cold');

    const timeouts = resolveStageTimeouts(cfg.provider, cfg.stageTimeouts);

    try {
      let justCreated = false;
      if (!cfg.instanceId) {
        const client = this.registry.get(cfg.provider);
        if (client) {
          let discovered = await withStageTimeout(
            client.discoverInstance(
              { apiKey: cfg.apiKey!, authId: cfg.authId },
              cfg.gpuTypes ?? [],
            ),
            timeouts.discoverMs,
            'discover',
          ).catch((err) => {
            if (err instanceof StageTimeoutError) {
              this.logger.warn(`[autoscaler] Tier ${tierIndex} (${cfg.provider}) discover timed out (${Math.round(timeouts.discoverMs / 1000)}s) — proceeding to create`);
              this.callbacks.emitError({
                operation: 'discoverInstance', provider: cfg.provider,
                tierIndex, userId,
                message: err.message,
                errorCode: 'STAGE_TIMEOUT', retryable: true,
                metadata: { stage: 'discover', timeoutMs: timeouts.discoverMs },
              });
              return null;
            }
            throw err;
          });

          if (discovered) {
            const isUsable = discovered.status?.toLowerCase() === 'running' && !!discovered.endpoint;
            if (isUsable) {
              cfg.instanceId = discovered.instanceId;
              cfg.endpoint = discovered.endpoint;
              this.logger.log(`[autoscaler] Discovered ${cfg.provider}: ${discovered.instanceId} (running) → ${discovered.endpoint || '(no endpoint)'}`);
              if (this.onInstancePersist && userId) {
                const machineKey = cfg.provider === 'runpod' ? 'runpodPod'
                  : cfg.provider === 'vast' ? 'vastInstance'
                  : 'tensordockInstance';
                void this.onInstancePersist(userId, machineKey, {
                  ...(cfg.provider === 'runpod'
                    ? { podId: discovered.instanceId, endpoint: discovered.endpoint }
                    : { instanceId: discovered.instanceId, endpoint: discovered.endpoint }),
                  ipAddress: discovered.ipAddress,
                  provider: cfg.provider,
                }).catch((err) => {
                  this.logger.warn('[autoscaler] Failed to persist discovered instance:', err);
                  this.callbacks.emitError({
                    operation: 'persistDiscoveredInstance', provider: cfg.provider,
                    tierIndex, userId, message: err instanceof Error ? err.message : String(err),
                    errorCode: 'PERSIST_FAILED', retryable: true,
                  });
                });
              }
            } else {
              const terminalStatuses = new Set(['destroyed', 'error', 'failed', 'deleted', 'exited']);
              const isTerminal = terminalStatuses.has(discovered.status?.toLowerCase() ?? '');
              if (!isTerminal && discovered.instanceId) {
                this.logger.log(`[autoscaler] Discovered ${cfg.provider}: ${discovered.instanceId} (status=${discovered.status}) — restarting instead of creating new`);
                cfg.instanceId = discovered.instanceId;
              } else {
                this.logger.log(`[autoscaler] Discovered ${cfg.provider}: ${discovered.instanceId} terminal (status=${discovered.status}) — creating new`);
                discovered = null;
              }
            }
          }

          if (!discovered) {
            // Emit boot_started BEFORE the create call. If the deploy fails
            // after the pod is created (e.g., health never passes), cost-monitor
            // can correlate boot_started with boot_failed to compute wasted $.
            const bootStartedAt = Date.now();
            void this.lifecycleLogger.log({
              userId, tierIndex, provider: cfg.provider,
              eventType: 'boot_started', trigger: 'autoscaler',
              oldState: 'idle', newState: 'booting',
              metadata: {
                dockerImage: cfg.dockerImage,
                gpuTypes: cfg.gpuTypes,
                attempt,
              },
            });
            try {
              const created = await withStageTimeout(
                client.createInstance(
                  {
                    gpuTypes: cfg.gpuTypes ?? [],
                    dockerImage: cfg.dockerImage,
                    hfToken: cfg.hfToken,
                    env: cfg.env,
                    storageGb: cfg.storageGb,
                    snapgpuRestoreFromSnapshot: cfg.snapgpuRestoreFromSnapshot,
                    snapgpuPreloadApp: cfg.snapgpuPreloadApp,
                    snapgpuBackend: cfg.snapgpuBackend,
                  },
                  { apiKey: cfg.apiKey!, authId: cfg.authId, hfToken: cfg.hfToken },
                  userId,
                ),
                timeouts.createMs,
                'create',
              );
              cfg.instanceId = created.instanceId;
              if (created.endpoint) cfg.endpoint = created.endpoint;
              sshHost = created.sshHost;
              sshPort = created.sshPort;
              monitorUrl = created.monitorUrl;
              justCreated = true;
              this.logger.log(`[autoscaler] Auto-created ${cfg.provider} machine: ${created.instanceId}`);
            } catch (createErr) {
              const isTimeout = createErr instanceof StageTimeoutError;
              const msg = createErr instanceof Error ? createErr.message : 'auto-create failed';
              this.callbacks.emitError({
                operation: 'triggerGpuBoot:createInstance', provider: cfg.provider,
                tierIndex, userId, message: msg,
                errorCode: isTimeout ? 'STAGE_TIMEOUT' : 'CREATE_FAILED',
                retryable: isTimeout,
                metadata: isTimeout ? { stage: 'create', timeoutMs: timeouts.createMs } : undefined,
              });
              return { ok: false, reason: `${cfg.provider}: ${msg}` };
            }
          }
        }
      }

      if (!cfg.instanceId) {
        return { ok: false, reason: `${cfg.provider}: instanceId not available after discovery` };
      }

      if (justCreated) {
        this.logger.log(`[autoscaler] Boot tier ${tierIndex} (${cfg.provider}) for user ${userId}: OK (auto-provisioned, already starting)`);
        return { ok: true, instanceId: cfg.instanceId, endpoint: cfg.endpoint, sshHost, sshPort, monitorUrl };
      }

      const client = this.registry.get(cfg.provider);
      if (!client) {
        return { ok: false, reason: `Provider "${cfg.provider}" não suporta boot automático` };
      }

      try {
        await withStageTimeout(
          client.startInstance(cfg.instanceId, { apiKey: cfg.apiKey!, authId: cfg.authId }),
          timeouts.startMs,
          'start',
        );
      } catch (startErr) {
        if (startErr instanceof StageTimeoutError) {
          this.callbacks.emitError({
            operation: 'triggerGpuBoot:startInstance', provider: cfg.provider,
            tierIndex, userId, instanceId: cfg.instanceId,
            message: startErr.message,
            errorCode: 'STAGE_TIMEOUT', retryable: true,
            metadata: { stage: 'start', timeoutMs: timeouts.startMs },
          });
          return { ok: false, reason: `${cfg.provider}: ${startErr.message}` };
        }
        const startMsg = startErr instanceof Error ? startErr.message : '';
        const isGone = startMsg.includes('não encontrada') || startMsg.includes('not found');
        const isExpired = startMsg.includes('não pode ser iniciada') || startMsg.includes('slot');
        if (isGone || isExpired) {
          if (isExpired && cfg.instanceId) {
            this.logger.warn(`[autoscaler] Instance ${cfg.instanceId} start failed (slot expired) — deleting before retry`);
            // Gate the retry on delete success: if delete fails, the old pod is
            // still around accruing $$$, and recursing would create a SECOND pod
            // alongside it. Better to bail out than orphan resources.
            let deleteOk = false;
            try {
              await client.deleteInstance(cfg.instanceId, { apiKey: cfg.apiKey!, authId: cfg.authId });
              deleteOk = true;
            } catch (delErr) {
              this.logger.error(`[autoscaler] ⚠ Delete stale instance ${cfg.instanceId} FAILED — refusing recursive retry to avoid orphan: ${delErr instanceof Error ? delErr.message : String(delErr)}`);
              this.callbacks.emitError({
                operation: 'triggerGpuBoot:deleteStale', provider: cfg.provider,
                tierIndex, userId, instanceId: cfg.instanceId,
                message: `Failed to delete expired-slot instance: ${delErr instanceof Error ? delErr.message : String(delErr)}`,
                retryable: false,
                metadata: { reason: 'refused-retry-to-prevent-orphan' },
              });
            }
            if (!deleteOk) {
              return { ok: false, reason: `${cfg.provider}: stale instance ${cfg.instanceId} could not be deleted (orphan risk)` };
            }
          } else {
            this.logger.warn(`[autoscaler] Instance ${cfg.instanceId} gone — retrying with auto-discover`);
          }
          // Cap recursion depth — even with successful delete, prevent infinite loop
          const MAX_BOOT_RETRIES = parseInt(process.env.AUTOSCALER_BOOT_RETRY_MAX || '3', 10);
          if (attempt + 1 > MAX_BOOT_RETRIES) {
            this.logger.error(`[autoscaler] Boot retry depth exceeded (${MAX_BOOT_RETRIES}) for tier ${tierIndex}`);
            return { ok: false, reason: `${cfg.provider}: max boot retries (${MAX_BOOT_RETRIES}) exceeded` };
          }
          return this.triggerGpuBoot(
            { ...tierConfig, instanceId: undefined, endpoint: undefined },
            tierIndex, userId, attempt + 1,
          );
        }
        throw startErr;
      }

      this.logger.log(`[autoscaler] Boot tier ${tierIndex} (${cfg.provider}) for user ${userId}: OK`);
      return { ok: true, instanceId: cfg.instanceId, endpoint: cfg.endpoint };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'erro desconhecido';
      this.logger.warn(`[autoscaler] triggerGpuBoot tier ${tierIndex} (${cfg.provider}) failed:`, err);
      this.callbacks.emitError({
        operation: 'triggerGpuBoot', provider: cfg.provider,
        tierIndex, userId, instanceId: cfg.instanceId,
        message: msg, retryable: false,
      });
      return { ok: false, reason: msg };
    }
  }

  /**
   * Start background health polling for a booting tier.
   * Polls every POLL_INTERVAL_MS (with backoff) until healthy, then transitions to ready.
   */
  startBootHealthPoller(
    userId: string,
    tierIndex: number,
    provider: string,
    bootTimestamp: number,
    tierConfig?: GpuTierConfig,
  ): void {
    const POLL_INTERVAL_BASE_MS = parseInt(process.env.BOOT_POLL_BASE_MS || '15000', 10);
    const POLL_INTERVAL_MAX_MS = parseInt(process.env.BOOT_POLL_MAX_MS || '60000', 10);
    const key = `${userId}:${tierIndex}:${Date.now()}`;
    let pollCount = 0;

    this.cancelBootPollersByPrefix(`${userId}:${tierIndex}:`);

    // Capture poller state object so cancellation propagates into in-flight polls.
    // The poll function checks `pollerState.cancelled` before re-scheduling.
    const pollerState = { timer: null as unknown as ReturnType<typeof setTimeout>, cancelled: false };

    const reschedule = (intervalMs: number) => {
      // Honor cancellation — if cancelled while a probe was in flight, do NOT
      // re-register a new timer (which would resurrect the poller forever).
      if (pollerState.cancelled) {
        this.bootPollers.delete(key);
        return;
      }
      const t = setTimeout(poll, intervalMs);
      if (t.unref) t.unref();
      pollerState.timer = t;
      this.bootPollers.set(key, pollerState);
    };

    const poll = () => {
      // Check cancellation at the top of every iteration
      if (pollerState.cancelled) {
        this.bootPollers.delete(key);
        return;
      }
      const tierStates = this.callbacks.getStates(userId);
      const ts = tierStates?.[tierIndex];

      if (!ts || ts.state !== 'booting') {
        this.bootPollers.delete(key);
        return;
      }
      if ((ts as BootingTierState).bootTriggeredAt !== bootTimestamp) {
        this.bootPollers.delete(key);
        return;
      }

      const bootTimeSecs = this.registry.get(provider)?.bootTimeSecs ?? 120;
      // Vast.ai can take 20-30+ min for large images (50+ GB) on slow hosts.
      // Use 3× for vast (= 30 min max, aligned with POLL_TOTAL_MAX_MS=30 min in
      // vast-client) so the poller doesn't orphan a still-pulling instance.
      // All other providers keep 2× which is well within their boot windows.
      const maxBootMultiplier = provider === 'vast' ? 3 : 2;
      const maxBootMs = bootTimeSecs * maxBootMultiplier * 1000;
      const elapsed = Date.now() - bootTimestamp;
      if (elapsed > maxBootMs) {
        const bootTs = ts as BootingTierState;
        this.logger.warn(`[boot-poller] Tier ${tierIndex} (${provider}) polling stopped — timeout (${Math.round(elapsed / 1000)}s, instanceId=${bootTs.discoveredInstanceId || 'none'}, endpoint=${bootTs.endpoint || 'none'})`);
        this.bootPollers.delete(key);
        // Transition tier back to idle so it can be retried (prevents stuck 'booting' state)
        try {
          const states = this.callbacks.getStates(userId);
          if (states?.[tierIndex]?.state === 'booting') {
            states[tierIndex] = { state: 'idle', tierIndex };
            this.callbacks.setStates(userId, states);
            void this.callbacks.persistStates(userId, states);
            this.logger.warn(`[boot-poller] Tier ${tierIndex} reset to idle after boot timeout`);
          }
        } catch { /* best effort state cleanup */ }
        return;
      }

      const booting = ts as BootingTierState;

      const needsResolve = !booting.endpoint;
      const resolveEndpoint = (): Promise<string> => {
        if (!needsResolve || !booting.discoveredInstanceId || !tierConfig?.apiKey) {
          return Promise.resolve(booting.endpoint);
        }
        const client = this.registry.get(provider);
        if (!client) return Promise.resolve(booting.endpoint);
        return client.resolveInstanceEndpoint(
          booting.discoveredInstanceId,
          { apiKey: tierConfig.apiKey, authId: tierConfig.authId },
        ).then((resolved) => {
          if (!resolved && !booting.endpoint) {
            this.logger.log(`[boot-poller] Tier ${tierIndex} (${provider}) endpoint not yet assigned (instance ${booting.discoveredInstanceId})`);
          }
          if (resolved && resolved !== booting.endpoint) {
            this.logger.log(`[boot-poller] Resolved direct endpoint for tier ${tierIndex}: ${resolved}`);
            const states = this.callbacks.getStates(userId);
            if (states?.[tierIndex]?.state === 'booting') {
              (states[tierIndex] as BootingTierState).endpoint = resolved;
              this.callbacks.setStates(userId, states);
            }
            return resolved;
          }
          return booting.endpoint;
        }).catch((err) => {
          this.logger.warn(`[boot-poller] Endpoint resolution failed for tier ${tierIndex} (${provider}): ${err instanceof Error ? err.message : String(err)}`);
          this.callbacks.emitError({
            operation: 'resolveEndpoint', provider, tierIndex, userId,
            instanceId: booting.discoveredInstanceId,
            message: err instanceof Error ? err.message : String(err),
            retryable: true,
          });
          return booting.endpoint;
        });
      };

      let sshAlreadyProbed = false;
      void resolveEndpoint().then(async (endpoint): Promise<boolean | 'skip'> => {
        if (!endpoint) {
          if (booting.sshHost && booting.sshPort) {
            this.logger.log(`[boot-poller] Tier ${tierIndex} (${provider}) no HTTP endpoint — trying SSH health (${booting.sshHost}:${booting.sshPort}, ${Math.round(elapsed / 1000)}s elapsed)`);
            const { probeGpuHealthSsh } = await import('./health');
            sshAlreadyProbed = true;
            return probeGpuHealthSsh(booting.sshHost, booting.sshPort);
          }
          this.logger.log(`[boot-poller] Tier ${tierIndex} (${provider}) endpoint not yet available (${Math.round(elapsed / 1000)}s elapsed) — skipping probe`);
          pollCount++;
          const nextInterval = Math.min(POLL_INTERVAL_BASE_MS * Math.pow(1.5, pollCount - 1), POLL_INTERVAL_MAX_MS);
          reschedule(nextInterval);
          return 'skip';
        }
        return this.probeHealth(endpoint);
      }).then(async (healthy): Promise<boolean | 'skip'> => {
        if (healthy === 'skip') return 'skip';
        if (!healthy && !sshAlreadyProbed && booting.sshHost && booting.sshPort) {
          const { probeGpuHealthSsh } = await import('./health');
          return probeGpuHealthSsh(booting.sshHost, booting.sshPort);
        }
        return healthy;
      }).then(async (healthy) => {
        if (healthy === 'skip') return;

        const currentStates = this.callbacks.getStates(userId);
        const current = currentStates?.[tierIndex];
        if (!current || current.state !== 'booting') {
          this.bootPollers.delete(key);
          return;
        }
        if ((current as BootingTierState).bootTriggeredAt !== bootTimestamp) {
          this.bootPollers.delete(key);
          return;
        }

        if (healthy) {
          const bootDurationMs = Date.now() - bootTimestamp;
          const currentBooting = current as BootingTierState;
          const newReady: ReadyTierState = {
            state: 'ready',
            tierIndex,
            endpoint: currentBooting.endpoint,
            lastHealthyAt: Date.now(),
            trigger: currentBooting.trigger,
            bootedAt: bootTimestamp,
            sshHost: currentBooting.sshHost,
            sshPort: currentBooting.sshPort,
          };
          currentStates[tierIndex] = newReady;
          this.callbacks.setStates(userId, currentStates);
          this.callbacks.persistStates(userId, currentStates);

          emitHook(this.hooks, 'onHealthChange', {
            userId, tierIndex, provider,
            previousState: 'booting', newState: 'ready',
            endpoint: currentBooting.endpoint, timestamp: Date.now(),
          });
          // ── SnapGPU metrics: record this deploy's duration tagged with the
          // path taken. Fed back to the policy tracker so future deploys can
          // compare cold-vs-restore averages and auto-disable if restore
          // stops winning. The path was stashed by triggerGpuBoot() in
          // bootPathByTier under the key `${userId}:${tierIndex}` and is
          // consumed (and cleared) here.
          if (provider === 'snapgpu' && tierConfig) {
            const appName = tierConfig.snapgpuPreloadApp || 'default';
            const workloadKey = buildWorkloadKey(tierConfig.dockerImage, appName);
            const tierKey = `${userId}:${tierIndex}`;
            const path: 'cold' | 'restore' = this.bootPathByTier.get(tierKey) ?? 'cold';
            this.bootPathByTier.delete(tierKey);
            this.snapgpuMetrics.record(userId, workloadKey, path, bootDurationMs);
          }

          // ── Auto-snapshot: if this tier uses snapgpu and autoSnapshot is
          // enabled, fire a background snapshot after the first successful boot.
          // The snapshot captures the loaded model + warm CUDA state, so the
          // NEXT cold boot restores in ~2-5 s instead of re-loading for ~2 min.
          if (provider === 'snapgpu' && tierConfig?.autoSnapshot && currentBooting.endpoint) {
            void (async () => {
              try {
                const { SnapgpuClient } = await import('../gpu-providers/snapgpu-client');
                const client = this.registry.get('snapgpu');
                if (client && client instanceof SnapgpuClient) {
                  const appName = tierConfig?.snapgpuPreloadApp || 'default';
                  const pid = await client.getAppPid(currentBooting.endpoint, appName);
                  if (!pid) {
                    this.logger.warn(`[autoscaler] Auto-snapshot: could not find PID for ${appName} — skipping`);
                    return;
                  }
                  this.logger.log(`[autoscaler] Auto-snapshot: creating snapshot for ${appName} (pid ${pid}) on tier ${tierIndex}...`);
                  const snapId = await client.createSnapshot(currentBooting.endpoint, appName, { pid });
                  if (snapId) {
                    this.logger.log(`[autoscaler] Auto-snapshot: ${snapId} created for ${appName}`);
                    void this.lifecycleLogger.log({
                      userId, tierIndex, provider,
                      eventType: 'snapshot_created',
                      instanceId: currentBooting.discoveredInstanceId,
                      endpoint: currentBooting.endpoint,
                      metadata: { snapshotId: snapId, appName, bootDurationMs },
                    });
                    // Persist snapshot ID so next triggerGpuBoot can restore it.
                    // Include imageRef + backend so shouldUseSnapshot() can
                    // reject stale snapshots on image drift or cross-backend
                    // attempts. Key is stable: uses appName not tierIndex.
                    if (this.onInstancePersist) {
                      void this.onInstancePersist(userId, `snapgpu_snapshot:${appName}`, {
                        snapshotId: snapId,
                        appName,
                        createdAt: Date.now(),
                        imageRef: tierConfig.dockerImage,
                        backend: tierConfig.snapgpuBackend ?? 'vast',
                      }).catch((e) => {
                        this.logger.warn(`[autoscaler] Failed to persist snapshot ID: ${e instanceof Error ? e.message : String(e)}`);
                      });
                    }
                  }
                }
              } catch (snapErr) {
                this.logger.warn(`[autoscaler] Auto-snapshot failed (non-fatal): ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`);
              }
            })();
          }

          void this.lifecycleLogger.log({
            userId, tierIndex, provider,
            eventType: 'boot_ok', durationMs: bootDurationMs,
            instanceId: currentBooting.discoveredInstanceId,
            endpoint: currentBooting.endpoint, trigger: currentBooting.trigger,
            oldState: 'booting', newState: 'ready',
            metadata: { bootTriggeredAt: bootTimestamp, source: 'boot-poller' },
          });
          this.callbacks.recordProviderHealthEvent(provider, true);
          this.logger.log(`[boot-poller] Tier ${tierIndex} (${provider}) is healthy after ${Math.round(bootDurationMs / 1000)}s — ready!`);
          this.bootPollers.delete(key);
          return;
        }

        // Not healthy yet — schedule next poll with backoff
        pollCount++;
        const nextInterval = Math.min(POLL_INTERVAL_BASE_MS * Math.pow(1.5, pollCount - 1), POLL_INTERVAL_MAX_MS);
        this.logger.log(`[boot-poller] Tier ${tierIndex} (${provider}) not ready yet (${Math.round(elapsed / 1000)}s elapsed, next in ${Math.round(nextInterval / 1000)}s)`);
        reschedule(nextInterval);
      }).catch((err) => {
        this.logger.warn(`[boot-poller] Probe failed for tier ${tierIndex} (${provider}, instanceId=${booting.discoveredInstanceId || 'none'}): ${err instanceof Error ? err.message : String(err)}`);
        this.callbacks.emitError({
          operation: 'bootProbe', provider, tierIndex, userId,
          instanceId: booting.discoveredInstanceId,
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        });
        pollCount++;
        const nextInterval = Math.min(POLL_INTERVAL_BASE_MS * Math.pow(1.5, pollCount - 1), POLL_INTERVAL_MAX_MS);
        reschedule(nextInterval);
      });
    };

    const bootTimeSecs = this.registry.get(provider)?.bootTimeSecs ?? 120;
    const initialDelay = Math.min(Math.max(bootTimeSecs * 0.2 * 1000, 30_000), 180_000);
    reschedule(initialDelay);
    this.logger.log(`[boot-poller] Started polling tier ${tierIndex} (${provider}) with backoff (first in ${Math.round(initialDelay / 1000)}s, bootTimeSecs=${bootTimeSecs})`);
  }

  /**
   * Validate a tier config. Returns null if valid, or a human-readable error
   * message describing the first problem. Caller should treat as fail-fast —
   * deploys should not proceed when this returns non-null.
   */
  private _validateTierConfig(cfg: GpuTierConfig, tierIndex: number): string | null {
    if (!cfg) return `tier ${tierIndex}: config is null/undefined`;
    if (!cfg.provider || typeof cfg.provider !== 'string') {
      return `tier ${tierIndex}: provider is required (got ${typeof cfg.provider})`;
    }
    if (!cfg.apiKey) {
      return `tier ${tierIndex} (${cfg.provider}): apiKey is required`;
    }
    // Allow tiers that resume an existing instance (instanceId set, no dockerImage)
    if (!cfg.dockerImage && !cfg.instanceId) {
      return `tier ${tierIndex} (${cfg.provider}): either dockerImage or instanceId must be set`;
    }
    if (cfg.dockerImage && typeof cfg.dockerImage !== 'string') {
      return `tier ${tierIndex} (${cfg.provider}): dockerImage must be a string (got ${typeof cfg.dockerImage})`;
    }
    if (cfg.dockerImage && !/^[a-z0-9._/-]+(:[a-z0-9._-]+)?$/i.test(cfg.dockerImage)) {
      return `tier ${tierIndex} (${cfg.provider}): dockerImage "${cfg.dockerImage}" doesn't look like a valid Docker image reference`;
    }
    if (cfg.gpuTypes && !Array.isArray(cfg.gpuTypes)) {
      return `tier ${tierIndex} (${cfg.provider}): gpuTypes must be an array (got ${typeof cfg.gpuTypes})`;
    }
    return null;
  }

  /** Cancel all active boot health pollers matching a key prefix. */
  private cancelBootPollersByPrefix(prefix: string): void {
    for (const [key, entry] of this.bootPollers) {
      if (key.startsWith(prefix)) {
        clearTimeout(entry.timer);
        entry.cancelled = true;  // poison flag for in-flight polls
        this.bootPollers.delete(key);
      }
    }
  }

  /** Cancel an active boot health poller for a specific tier. */
  cancelBootPoller(userId: string, tierIndex: number): void {
    const prefix = `${userId}:${tierIndex}:`;
    let found = false;
    for (const [key, entry] of this.bootPollers) {
      if (key.startsWith(prefix)) {
        clearTimeout(entry.timer);
        entry.cancelled = true;
        this.bootPollers.delete(key);
        found = true;
      }
    }
    if (found) {
      this.logger.log(`[autoscaler] Cancelled boot poller for tier ${tierIndex}`);
    }
  }

  /** Cancel all boot pollers. Call on gateway shutdown. */
  destroyAllPollers(): void {
    for (const [, entry] of this.bootPollers) {
      clearTimeout(entry.timer);
      entry.cancelled = true;
    }
    this.bootPollers.clear();
  }

  /**
   * Wire up the fire-and-forget boot callback that updates stateMap on boot result.
   * Called from engine after `triggerGpuBoot` is initiated for a tier.
   */
  handleBootResult(
    userId: string,
    tierIndex: number,
    tierConfig: GpuTierConfig,
    bootTimestamp: number,
    trigger: ScaleTrigger,
    bootPromise: Promise<BootResult>,
  ): void {
    bootPromise
      .then(({ ok, instanceId, endpoint, reason, sshHost, sshPort, monitorUrl }) => {
        const currentStates = this.callbacks.getStates(userId);
        const current = currentStates?.[tierIndex];
        const stateStillBooting = current?.state === 'booting'
          && (current as BootingTierState).bootTriggeredAt === bootTimestamp;

        if (!stateStillBooting && ok && instanceId) {
          this.logger.warn(`[autoscaler] Boot tier ${tierIndex} succeeded (instanceId=${instanceId}) but state was already ${current?.state ?? 'cleared'} — persisting instanceId for tracking`);
          if (this.onInstancePersist) {
            // Structured key: `autoscaler_orphan:${provider}:${tierIndex}:${ts}`
            // (was `autoscaler_orphan_tier${i}` — flat and unfilterable). The new
            // format lets cost-monitor/cleanup queries filter by provider, age,
            // or tier without scanning all keys and parsing.
            const orphanKey = `autoscaler_orphan:${tierConfig.provider}:${tierIndex}:${bootTimestamp}`;
            void this.onInstancePersist(userId, orphanKey, {
              instanceId, endpoint, provider: tierConfig.provider,
              tierIndex, createdAt: bootTimestamp,
              orphanedBecause: 'state_reset_during_boot',
            }).catch((err) => {
              this.logger.warn(`[autoscaler] Failed to persist orphaned instance ${instanceId}: ${err instanceof Error ? err.message : String(err)}`);
              this.callbacks.emitError({
                operation: 'persistOrphanedInstance', provider: tierConfig.provider,
                tierIndex, userId, instanceId,
                message: err instanceof Error ? err.message : String(err),
                errorCode: 'PERSIST_FAILED', retryable: false,
              });
            });
          }
          void this.lifecycleLogger.log({
            userId, tierIndex, provider: tierConfig.provider,
            eventType: 'boot_ok', instanceId, endpoint,
            oldState: 'booting', newState: current?.state ?? 'cleared',
            trigger, error: 'State changed during boot — instanceId persisted for tracking',
            metadata: { orphaned: true, bootTimestamp },
          });
          this.callbacks.recordProviderHealthEvent(tierConfig.provider, true);
          return;
        }

        if (!currentStates || !stateStillBooting) return;

        if (!ok) {
          this.logger.warn(`[autoscaler] Boot tier ${tierIndex} (${tierConfig.provider}) failed: ${reason ?? 'unknown'}`);
          this.callbacks.emitError({
            operation: 'boot', provider: tierConfig.provider,
            tierIndex, userId, message: reason ?? 'unknown',
            errorCode: 'BOOT_FAILED', retryable: true,
          });
          this.callbacks.recordProviderHealthEvent(tierConfig.provider, false);
          const failCount = (current.prevBootFailCount ?? 0) + 1;
          const durationMs = Date.now() - (current as BootingTierState).bootTriggeredAt;
          // P2-3: classify the failure so cooldown length matches how fast
          // the underlying problem self-heals. Billing=24h, no_capacity=5m, etc.
          const category = classifyBootFailure(reason);
          const cooldownMs = computeCooldownMs(category, failCount);
          const newIdle: IdleTierState = {
            state: 'idle',
            tierIndex: tierIndex,
            bootFailCount: failCount,
            cooldownUntil: Date.now() + cooldownMs,
          };
          currentStates[tierIndex] = newIdle;
          this.callbacks.setStates(userId, currentStates);
          // Estimate wasted cost: durationMs of billing time × typical hourly rate.
          // This is approximate (actual rate depends on GPU type) but gives a
          // ballpark for cost-monitor dashboards and alerts.
          const TYPICAL_RATE_PER_HR = 0.40; // ~$0.40/hr for RTX 4090 spot
          const estimatedWasteCost = (durationMs / 3_600_000) * TYPICAL_RATE_PER_HR;
          void this.lifecycleLogger.log({
            userId, tierIndex, provider: tierConfig.provider,
            eventType: 'boot_failed', durationMs,
            instanceId: (current as BootingTierState).discoveredInstanceId,
            endpoint: (current as BootingTierState).endpoint, trigger: (current as BootingTierState).trigger,
            oldState: 'booting', newState: 'idle',
            error: reason ?? 'unknown',
            metadata: { failCount, estimatedWasteCost: +estimatedWasteCost.toFixed(4), failureCategory: category, cooldownMs },
          });
          return;
        }

        const booting = current as BootingTierState;
        const updates: Partial<BootingTierState> = {};
        if (endpoint && endpoint !== booting.endpoint) {
          this.logger.log(`[autoscaler] Tier ${tierIndex} endpoint updated: ${booting.endpoint || 'none'} → ${endpoint}`);
          updates.endpoint = endpoint;
        }
        if (instanceId) updates.discoveredInstanceId = instanceId;
        if (sshHost) updates.sshHost = sshHost;
        if (sshPort) updates.sshPort = sshPort;
        if (monitorUrl) updates.monitorUrl = monitorUrl;
        if (Object.keys(updates).length > 0) {
          currentStates[tierIndex] = { ...booting, ...updates };
        }
        this.callbacks.setStates(userId, currentStates);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[autoscaler] Boot tier ${tierIndex} (${tierConfig.provider}) unexpected error: ${msg}`);
        const currentStates = this.callbacks.getStates(userId);
        if (currentStates?.[tierIndex]?.state === 'booting'
          && (currentStates[tierIndex] as BootingTierState).bootTriggeredAt === bootTimestamp) {
          const failCount = ((currentStates[tierIndex] as BootingTierState).prevBootFailCount ?? 0) + 1;
          // P2-3: categorize even the unexpected-exception case so cooldown
          // duration matches the failure class. Most unexpected errors fall
          // into 'unknown' and get the 10m default.
          const category = classifyBootFailure(msg);
          currentStates[tierIndex] = {
            state: 'idle',
            tierIndex: tierIndex,
            bootFailCount: failCount,
            cooldownUntil: Date.now() + computeCooldownMs(category, failCount),
          } satisfies IdleTierState;
          this.callbacks.setStates(userId, currentStates);
        }
      });
  }
}
