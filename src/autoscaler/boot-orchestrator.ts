import type { GpuTierConfig, GpuTierState, BootingTierState, ReadyTierState, IdleTierState, ScaleTrigger } from '../types';
import { resolveStageTimeouts } from '../types';
import type { GpuProviderRegistry } from '../gpu-providers/registry';
import type { GatewayHooks, ErrorEvent } from '../hooks';
import type { GpuLifecycleLogger } from './lifecycle-logger';
import type { Logger } from '../deps';
import { emitHook } from '../hooks';
import { StageTimeoutError, withStageTimeout } from './stage-timeout';

const BOOT_COOLDOWN_BASE_MS = 2 * 60_000;  // 2 min base, exponential backoff
const BOOT_COOLDOWN_MAX_MS = 30 * 60_000;  // Max 30 min cooldown

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

  private readonly registry: GpuProviderRegistry;
  private readonly probeHealth: (endpoint: string) => Promise<boolean>;
  private readonly hooks?: GatewayHooks;
  private readonly lifecycleLogger: GpuLifecycleLogger;
  private readonly logger: Logger;
  private readonly onInstancePersist?: (userId: string, machineKey: string, data: Record<string, unknown>) => Promise<void>;
  private readonly callbacks: BootOrchestratorCallbacks;

  constructor(opts: BootOrchestratorOptions) {
    this.registry = opts.registry;
    this.probeHealth = opts.probeHealth;
    this.hooks = opts.hooks;
    this.lifecycleLogger = opts.lifecycleLogger;
    this.logger = opts.logger;
    this.onInstancePersist = opts.onInstancePersist;
    this.callbacks = opts.callbacks;
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
      const maxBootMs = bootTimeSecs * 2 * 1000;
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
          const newIdle: IdleTierState = {
            state: 'idle',
            tierIndex: tierIndex,
            bootFailCount: failCount,
            cooldownUntil: Date.now() + Math.min(BOOT_COOLDOWN_BASE_MS * Math.pow(2, failCount - 1), BOOT_COOLDOWN_MAX_MS),
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
            metadata: { failCount, estimatedWasteCost: +estimatedWasteCost.toFixed(4) },
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
          currentStates[tierIndex] = {
            state: 'idle',
            tierIndex: tierIndex,
            bootFailCount: failCount,
            cooldownUntil: Date.now() + Math.min(BOOT_COOLDOWN_BASE_MS * Math.pow(2, failCount - 1), BOOT_COOLDOWN_MAX_MS),
          } satisfies IdleTierState;
          this.callbacks.setStates(userId, currentStates);
        }
      });
  }
}
