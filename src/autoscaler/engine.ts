import type {
  AutoScalerConfig,
  GpuTierConfig,
  GpuTierState,
  GpuBootState,
  IdleTierState,
  BootingTierState,
  ReadyTierState,
  AutoScaleDecision,
  ScaleTrigger,
} from '../types';
import type { GpuProviderRegistry } from '../gpu-providers/registry';
import type { SessionTracker } from './session-tracker';
import type { LatencyTracker } from './latency-tracker';
import type { StatePersistence } from './state-persistence';
import type { GatewayHooks } from '../hooks';
import type { GpuLifecycleLogger } from './lifecycle-logger';
import type { Logger } from '../deps';
import { noopLifecycleLogger } from './lifecycle-logger';
import { LATENCY_BREACH_COUNT, countRecentBreaches } from './latency-tracker';
import { emitHook } from '../hooks';
import { defaultLogger } from '../logger';
import { handleBootTimeout } from './boot-timeout';
import { probeAllTiers, processHealthResults } from './health-checker';
import { buildDecision } from './decision-builder';

export const MAX_BOOT_FAILURES = 3;
export const BOOT_COOLDOWN_BASE_MS = 2 * 60_000;  // 2 min base, exponential backoff
export const BOOT_COOLDOWN_MAX_MS = 30 * 60_000;  // Max 30 min cooldown

export interface AutoscalerEngineOptions {
  registry: GpuProviderRegistry;
  sessionTracker: SessionTracker;
  latencyTracker: LatencyTracker;
  persistence: StatePersistence;
  probeHealth: (endpoint: string) => Promise<boolean>;
  cleanupInstance: (config: GpuTierConfig, registry: GpuProviderRegistry, reason: string) => Promise<void>;
  hooks?: GatewayHooks;
  onInstancePersist?: (userId: string, machineKey: string, data: Record<string, unknown>) => Promise<void>;
  lifecycleLogger?: GpuLifecycleLogger;
  logger?: Logger;
}

export class AutoscalerEngine {
  /** stateMap[userId] = array of tier states indexed by tierIndex */
  private stateMap = new Map<string, GpuTierState[]>();
  /** Per-user mutex to prevent concurrent getAutoScaleDecision from racing on boot triggers */
  private decisionLocks = new Map<string, Promise<AutoScaleDecision>>();
  /** Active boot health pollers — key: "userId:tierIndex" */
  private bootPollers = new Map<string, ReturnType<typeof setTimeout>>();
  private registry: GpuProviderRegistry;
  private sessionTracker: SessionTracker;
  private latencyTracker: LatencyTracker;
  private persistence: StatePersistence;
  private hooks?: GatewayHooks;
  private lifecycleLogger: GpuLifecycleLogger;
  private logger: Logger;
  private probeHealth: (endpoint: string) => Promise<boolean>;
  private cleanupInstance: (config: GpuTierConfig, registry: GpuProviderRegistry, reason: string) => Promise<void>;
  private onInstancePersist?: (userId: string, machineKey: string, data: Record<string, unknown>) => Promise<void>;

  constructor(opts: AutoscalerEngineOptions) {
    this.registry = opts.registry;
    this.sessionTracker = opts.sessionTracker;
    this.latencyTracker = opts.latencyTracker;
    this.persistence = opts.persistence;
    this.probeHealth = opts.probeHealth;
    this.cleanupInstance = opts.cleanupInstance;
    this.hooks = opts.hooks;
    this.onInstancePersist = opts.onInstancePersist;
    this.lifecycleLogger = opts.lifecycleLogger ?? noopLifecycleLogger;
    this.logger = opts.logger ?? defaultLogger;
  }

  /**
   * Start background health polling for a booting tier.
   * Polls every POLL_INTERVAL_MS until healthy, then transitions to ready and logs boot_ok.
   * Stops on timeout (bootTimeSecs × 2) or if tier state changed externally.
   */
  private startBootHealthPoller(
    userId: string,
    tierIndex: number,
    provider: string,
    bootTimestamp: number,
    tierConfig?: GpuTierConfig,
  ): void {
    const POLL_INTERVAL_BASE_MS = 15_000; // 15 seconds base
    const POLL_INTERVAL_MAX_MS = 60_000;  // max 60 seconds between polls
    const key = `${userId}:${tierIndex}`;
    let pollCount = 0;

    // Cancel any existing poller for this tier
    const existing = this.bootPollers.get(key);
    if (existing) clearTimeout(existing);

    const poll = () => {
      const tierStates = this.stateMap.get(userId);
      const ts = tierStates?.[tierIndex];

      // Stop polling if tier is no longer booting or boot was replaced
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
        // Timeout — will be handled by engine pre-probe or watchdog
        const bootTs = ts as BootingTierState;
        this.logger.warn(`[boot-poller] Tier ${tierIndex} (${provider}) polling stopped — timeout (${Math.round(elapsed / 1000)}s, instanceId=${bootTs.discoveredInstanceId || 'none'}, endpoint=${bootTs.endpoint || 'none'})`);
        this.bootPollers.delete(key);
        return;
      }

      const booting = ts as BootingTierState;

      // Re-resolve endpoint from the provider API when endpoint is empty
      // (e.g. Vast.ai: IP not assigned at creation time).
      // Note: RunPod proxy URLs (*.proxy.runpod.net) are the reliable way to access
      // pods — do NOT resolve them to direct IPs which may be unreachable.
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
            // Update the booting state with the direct endpoint
            const states = this.stateMap.get(userId);
            if (states?.[tierIndex]?.state === 'booting') {
              (states[tierIndex] as BootingTierState).endpoint = resolved;
              this.stateMap.set(userId, states);
            }
            return resolved;
          }
          return booting.endpoint;
        }).catch((err) => {
          this.logger.warn(`[boot-poller] Endpoint resolution failed for tier ${tierIndex} (${provider}): ${err instanceof Error ? err.message : String(err)}`);
          return booting.endpoint;
        });
      };

      void resolveEndpoint().then((endpoint) => this.probeHealth(endpoint)).then(async (httpHealthy) => {
        // If HTTP failed and we have SSH info, try SSH fallback (Vast.ai without direct ports)
        if (!httpHealthy && booting.sshHost && booting.sshPort) {
          const { probeGpuHealthSsh } = await import('./health');
          return probeGpuHealthSsh(booting.sshHost, booting.sshPort);
        }
        return httpHealthy;
      }).then(async (healthy) => {
        // Re-check state — might have changed during the probe
        const currentStates = this.stateMap.get(userId);
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
          this.stateMap.set(userId, currentStates);
          void this.persistence.persistTierStates(userId, currentStates).catch((err) =>
            this.logger.warn('[boot-poller] Background persist failed:', err),
          );

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
          this.logger.log(`[boot-poller] Tier ${tierIndex} (${provider}) is healthy after ${Math.round(bootDurationMs / 1000)}s — ready!`);
          this.bootPollers.delete(key);
          return;
        }

        // Not healthy yet — schedule next poll with backoff
        pollCount++;
        const nextInterval = Math.min(POLL_INTERVAL_BASE_MS * Math.pow(1.5, pollCount - 1), POLL_INTERVAL_MAX_MS);
        this.logger.log(`[boot-poller] Tier ${tierIndex} (${provider}) not ready yet (${Math.round(elapsed / 1000)}s elapsed, next in ${Math.round(nextInterval / 1000)}s)`);
        const timer = setTimeout(poll, nextInterval);
        if (timer.unref) timer.unref();
        this.bootPollers.set(key, timer);
      }).catch((err) => {
        this.logger.warn(`[boot-poller] Probe failed for tier ${tierIndex} (${provider}, instanceId=${booting.discoveredInstanceId || 'none'}): ${err instanceof Error ? err.message : String(err)}`);
        pollCount++;
        const nextInterval = Math.min(POLL_INTERVAL_BASE_MS * Math.pow(1.5, pollCount - 1), POLL_INTERVAL_MAX_MS);
        const timer = setTimeout(poll, nextInterval);
        if (timer.unref) timer.unref();
        this.bootPollers.set(key, timer);
      });
    };

    // Start first poll after a short delay (instance needs time to boot)
    const initialDelay = 30_000; // 30s — skip initial boot period
    const timer = setTimeout(poll, initialDelay);
    if (timer.unref) timer.unref();
    this.bootPollers.set(key, timer);
    this.logger.log(`[boot-poller] Started polling tier ${tierIndex} (${provider}) with backoff (first in ${initialDelay / 1000}s)`);
  }

  /** Expose stateMap for watchdog/external iteration */
  getStateMap(): Map<string, GpuTierState[]> {
    return this.stateMap;
  }

  private getTierStates(userId: string, tiers: GpuTierConfig[]): GpuTierState[] {
    const existing = this.stateMap.get(userId);
    // config.endpoint is just a stored address — not an indicator the instance is running.
    // Only DB-persisted state (booting/ready) should restore a non-idle tier.
    return tiers.map((_tier, i): GpuTierState =>
      existing?.[i] ?? ({ state: 'idle', tierIndex: i } satisfies IdleTierState),
    );
  }

  async initTierStatesFromDb(userId: string, tiers: GpuTierConfig[]): Promise<GpuTierState[]> {
    if (this.stateMap.has(userId)) return this.getTierStates(userId, tiers);

    const persisted = await this.persistence.loadPersistedTierStates(userId);
    if (persisted && persisted.length > 0) {
      const now = Date.now();
      const states = tiers.map((tier, i): GpuTierState => {
        const p = persisted[i];
        if (!p) return { state: 'idle', tierIndex: i } satisfies IdleTierState;

        // ── Restore booting state ──
        if (p.state === 'booting') {
          const tierProvider = tier.provider ?? '';
          const bootTimeSecs = this.registry.get(tierProvider)?.bootTimeSecs ?? 120;
          const maxBootMs = bootTimeSecs * 2 * 1000;
          const elapsed = now - p.bootTriggeredAt;

          if (elapsed > maxBootMs) {
            // Boot was running when server died and has exceeded max time → stale
            this.logger.warn(`[autoscaler] Stale booting tier ${i} (${tierProvider}) found on load — ${Math.round(elapsed / 1000)}s old, max=${Math.round(maxBootMs / 1000)}s — reverting to idle`);
            const failCount = p.prevBootFailCount + 1;
            if (tier) {
              const effectiveConfig = p.discoveredInstanceId
                ? { ...tier, instanceId: p.discoveredInstanceId }
                : tier;
              void this.cleanupInstance(effectiveConfig, this.registry, `stale boot on load tier ${i}`);
            }
            return {
              state: 'idle',
              tierIndex: i,
              bootFailCount: failCount,
              // After restart, reset unhealthy flag — give the tier another chance.
              // Provider availability changes over time; marking unhealthy forever
              // after a crash prevents recovery.
            } satisfies IdleTierState;
          }

          // Boot was recent — the cloud instance may still be starting up.
          // But the .then() callback that would process the boot result is gone
          // (process restarted). Revert to idle so the next decision cycle can
          // re-trigger the boot with a fresh callback.
          this.logger.log(`[autoscaler] Tier ${i} (${tierProvider}) was booting when server restarted (${Math.round(elapsed / 1000)}s ago) — reverting to idle for re-evaluation`);
          return {
            state: 'idle',
            tierIndex: i,
            // Don't increment failCount — this wasn't a real failure, just a restart
          } satisfies IdleTierState;
        }

        // ── Restore ready state ──
        if (p.state === 'ready') {
          // ready is safe to restore — next health check will verify if still alive
          if (tier.endpoint) {
            return { ...p, endpoint: tier.endpoint };
          }
          return p;
        }

        // ── Restore idle state ──
        // After server restart, clear unhealthy and cooldown flags.
        // Provider availability changes over time; the restart is a natural
        // opportunity to retry from scratch.
        if (p.state === 'idle' && ((p as IdleTierState).unhealthy || (p as IdleTierState).cooldownUntil)) {
          this.logger.log(`[autoscaler] Tier ${i} was idle(${(p as IdleTierState).unhealthy ? 'unhealthy' : 'cooldown'}) — resetting on restart`);
          return { state: 'idle', tierIndex: i } satisfies IdleTierState;
        }

        return p;
      });
      this.stateMap.set(userId, states);
      const activeCount = states.filter(s => s.state !== 'idle').length;
      if (activeCount > 0) {
        this.logger.log(`[autoscaler] Restored ${activeCount} active tier(s) from DB for user ${userId}`);
      }
      // Persist cleaned-up states
      void this.persistence.persistTierStates(userId, states).catch((err) =>
        this.logger.warn('[autoscaler] Failed to persist restored states:', err),
      );
      return states;
    }

    return this.getTierStates(userId, tiers);
  }

  private snapshotStates(states: GpuTierState[]): GpuBootState[] {
    return states.map((s) => s.state);
  }

  private saveTierStates(userId: string, states: GpuTierState[], prevSnapshot?: GpuBootState[]): void {
    this.stateMap.set(userId, states);
    if (prevSnapshot) {
      const changed = states.some((s, i) => s.state !== prevSnapshot[i]);
      if (changed) {
        void this.persistence.persistTierStates(userId, states).catch((err) =>
          this.logger.warn('[autoscaler] Background persist failed:', err),
        );
      }
    }
  }

  async triggerGpuBoot(
    tierConfig: GpuTierConfig,
    tierIndex: number,
    userId: string,
    attempt = 0,
  ): Promise<{ ok: boolean; instanceId?: string; endpoint?: string; activeGpuType?: string; reason?: string; sshHost?: string; sshPort?: number; monitorUrl?: string }> {
    if (attempt >= 2) return { ok: false, reason: 'Max retry attempts reached' };
    if (!tierConfig.apiKey) return { ok: false, reason: 'API key não configurada' };

    // Work on a local copy — never mutate the caller's tierConfig
    const cfg = { ...tierConfig };
    let sshHost: string | undefined;
    let sshPort: number | undefined;
    let monitorUrl: string | undefined;

    try {
      let justCreated = false;
      if (!cfg.instanceId) {
        const client = this.registry.get(cfg.provider);
        if (client) {
          let discovered = await client.discoverInstance(
            { apiKey: cfg.apiKey!, authId: cfg.authId },
            cfg.gpuTypes ?? [],
          );
          if (discovered) {
            const isUsable = discovered.status?.toLowerCase() === 'running' && !!discovered.endpoint;
            if (isUsable) {
              cfg.instanceId = discovered.instanceId;
              cfg.endpoint = discovered.endpoint;
              this.logger.log(`[autoscaler] Discovered ${cfg.provider}: ${discovered.instanceId} (running) → ${discovered.endpoint || '(no endpoint)'}`);
              // Persist discovered instance so cost-monitor knows it's tracked
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
                }).catch((err) => this.logger.warn('[autoscaler] Failed to persist discovered instance:', err));
              }
            } else {
              this.logger.log(`[autoscaler] Discovered ${cfg.provider}: ${discovered.instanceId} unusable (status=${discovered.status}, endpoint=${discovered.endpoint || 'none'}) — creating new`);
              discovered = null;
            }
          }
          if (!discovered) {
            try {
              const created = await client.createInstance(
                {
                  gpuTypes: cfg.gpuTypes ?? [],
                  dockerImage: cfg.dockerImage,
                  hfToken: cfg.hfToken,
                  env: cfg.env,
                  storageGb: cfg.storageGb,
                },
                { apiKey: cfg.apiKey!, authId: cfg.authId, hfToken: cfg.hfToken },
                userId,
              );
              cfg.instanceId = created.instanceId;
              if (created.endpoint) cfg.endpoint = created.endpoint;
              // Store SSH info for fallback health checks (Vast.ai)
              sshHost = created.sshHost;
              sshPort = created.sshPort;
              monitorUrl = created.monitorUrl;
              justCreated = true;
              this.logger.log(`[autoscaler] Auto-created ${cfg.provider} machine: ${created.instanceId}`);
            } catch (createErr) {
              const msg = createErr instanceof Error ? createErr.message : 'auto-create failed';
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
        return {
          ok: true, instanceId: cfg.instanceId, endpoint: cfg.endpoint,
          sshHost,
          sshPort,
          monitorUrl,
        };
      }

      const client = this.registry.get(cfg.provider);
      if (!client) {
        return { ok: false, reason: `Provider "${cfg.provider}" não suporta boot automático` };
      }

      try {
        await client.startInstance(cfg.instanceId, {
          apiKey: cfg.apiKey!,
          authId: cfg.authId,
        });
      } catch (startErr) {
        const startMsg = startErr instanceof Error ? startErr.message : '';
        const isGone = startMsg.includes('não encontrada') || startMsg.includes('not found');
        const isExpired = startMsg.includes('não pode ser iniciada') || startMsg.includes('slot');
        if (isGone || isExpired) {
          if (isExpired && cfg.instanceId) {
            this.logger.warn(`[autoscaler] Instance ${cfg.instanceId} start failed (slot expired) — deleting and re-creating`);
            try {
              await client.deleteInstance(cfg.instanceId, {
                apiKey: cfg.apiKey!,
                authId: cfg.authId,
              });
            } catch (delErr) {
              this.logger.warn(`[autoscaler] Delete stale instance failed (non-fatal):`, delErr);
            }
          } else {
            this.logger.warn(`[autoscaler] Instance ${cfg.instanceId} gone — retrying with auto-discover`);
          }
          // Retry with cleared instanceId — no recursion beyond attempt + 1
          return this.triggerGpuBoot(
            { ...tierConfig, instanceId: undefined, endpoint: undefined },
            tierIndex,
            userId,
            attempt + 1,
          );
        }
        throw startErr;
      }

      this.logger.log(`[autoscaler] Boot tier ${tierIndex} (${cfg.provider}) for user ${userId}: OK`);
      return { ok: true, instanceId: cfg.instanceId, endpoint: cfg.endpoint };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'erro desconhecido';
      this.logger.warn(`[autoscaler] triggerGpuBoot tier ${tierIndex} (${cfg.provider}) failed:`, err);
      return { ok: false, reason: msg };
    }
  }

  async getAutoScaleDecision(
    userId: string,
    config: AutoScalerConfig,
    options?: { dryRun?: boolean },
  ): Promise<AutoScaleDecision> {
    // Chain per-user decisions into a serial queue to prevent concurrent boot triggers.
    // Each call runs only after the previous one completes (FIFO).
    const prev = this.decisionLocks.get(userId);
    const chain = (prev ? prev.catch(() => {}) : Promise.resolve())
      .then(() => this._getAutoScaleDecisionImpl(userId, config, options));
    this.decisionLocks.set(userId, chain);
    chain.finally(() => {
      if (this.decisionLocks.get(userId) === chain) this.decisionLocks.delete(userId);
    });
    return chain;
  }

  private async _getAutoScaleDecisionImpl(
    userId: string,
    config: AutoScalerConfig,
    options?: { dryRun?: boolean },
  ): Promise<AutoScaleDecision> {
    const dryRun = options?.dryRun ?? false;
    const maxLatencyMs = config.maxLatencyMs ?? 1500;
    const tiers = [...(config.tiers ?? [])];
    let totalTiers = tiers.length;

    if (!config.enabled) {
      return {
        route: 'llm',
        reason: 'Autoscaling desabilitado',
        activeSessions: 0,
        threshold: config.threshold,
        maxLatencyMs,
        p95LatencyMs: null,
        gpuState: 'idle',
        enabled: false,
        activeTiers: 0,
        bootingTiers: 0,
        totalTiers,
      };
    }

    const activeSessions = await this.sessionTracker.countActiveSessions(userId, config.windowMinutes);
    const latencyStats = await this.latencyTracker.getLatencyStats(userId);
    const p95 = latencyStats.p95;
    const latencyBreaches =
      p95 !== null
        ? countRecentBreaches(latencyStats.samples, maxLatencyMs)
        : 0;
    const latencyTriggered = latencyBreaches >= LATENCY_BREACH_COUNT;
    const sessionTriggered = activeSessions >= config.threshold;

    // We need at most 1 active GPU tier at a time.  The tiers array is an
    // ordered fallback chain (e.g. [tensordock, runpod]) — we try tier 0 first
    // and only fall back to tier 1+ when tier 0 fails / is unhealthy.
    const needsGpu = sessionTriggered || latencyTriggered;

    const tierStates = this.stateMap.has(userId)
      ? this.getTierStates(userId, tiers)
      : await this.initTierStatesFromDb(userId, tiers);
    const prevSnapshot = this.snapshotStates(tierStates);

    // ── Step 0: Pre-probe boot timeout check ──
    const now = Date.now();
    for (let i = 0; i < tierStates.length; i++) {
      const ts = tierStates[i];
      if (!ts || ts.state !== 'booting') continue;
      const tierProvider = tiers[i]?.provider ?? '';
      const bootTimeSecs = this.registry.get(tierProvider)?.bootTimeSecs ?? 120;
      const maxBootMs = bootTimeSecs * 2 * 1000;
      if (now - ts.bootTriggeredAt > maxBootMs) {
        this.logger.warn(`[autoscaler] Tier ${i} (${tierProvider}) boot timed out (pre-probe) — reverting to idle`);
        const { newState, logEntry, cleanupConfig } = handleBootTimeout(i, ts, tiers[i], maxBootMs, now, 'pre-probe');
        tierStates[i] = newState;
        void this.lifecycleLogger.log({ userId, ...logEntry });
        if (cleanupConfig) void this.cleanupInstance(cleanupConfig, this.registry, `boot timeout (pre-probe) tier ${i}`);
      }
    }

    // ── Step 1: Probe health of all non-idle tiers ──
    const healthResults = await probeAllTiers(tierStates, this.probeHealth, tiers, this.registry);
    processHealthResults(userId, tierStates, tiers, healthResults, this.registry, {
      cleanupInstance: this.cleanupInstance,
      lifecycleLogger: this.lifecycleLogger,
      hooks: this.hooks,
      logger: this.logger,
    });

    // ── Step 2+3: Fallback boot — try one tier at a time ──
    // Tiers are an ordered fallback chain (e.g. [tensordock, runpod]).
    // We boot tier 0; if tier 0 is unhealthy/failed/cooldown, we try tier 1, etc.
    // Only ONE tier should be booting or ready at any given time.
    const trigger: ScaleTrigger = sessionTriggered ? 'sessions' : latencyTriggered ? 'latency' : 'sessions';

    // Check if any tier is already active (ready or booting)
    const hasActiveTier = tierStates.some(ts => ts.state === 'ready' || ts.state === 'booting');

    if (needsGpu && !hasActiveTier && !dryRun) {
      // Find the first eligible tier in fallback order
      for (let i = 0; i < totalTiers; i++) {
        const ts = tierStates[i];
        const tierConfig = tiers[i];
        if (!ts || !tierConfig) continue;
        // Skip unhealthy (too many boot failures) or in cooldown
        if ((ts as IdleTierState).unhealthy) continue;
        if ((ts as IdleTierState).cooldownUntil && Date.now() < (ts as IdleTierState).cooldownUntil!) continue;

        this.logger.log(`[autoscaler] Boot tier ${i} (${tierConfig.provider}) for user ${userId} — trigger=${trigger}`);
        emitHook(this.hooks, 'onScaleUp', {
          userId, tierIndex: i, provider: tierConfig.provider,
          trigger, activeSessions, timestamp: Date.now(),
        });
        void this.lifecycleLogger.log({
          userId, tierIndex: i, provider: tierConfig.provider,
          eventType: 'boot_started', trigger,
          oldState: 'idle', newState: 'booting',
          endpoint: tierConfig.endpoint,
          metadata: { activeSessions },
        });

        // Transition: idle → booting
        const newBooting: BootingTierState = {
          state: 'booting',
          tierIndex: i,
          endpoint: tierConfig.endpoint ?? '',
          bootTriggeredAt: Date.now(),
          trigger,
          prevBootFailCount: (ts as IdleTierState).bootFailCount ?? 0,
        };
        tierStates[i] = newBooting;

        // Fire-and-forget boot; update state with discovered endpoint/instanceId.
        const bootTimestamp = newBooting.bootTriggeredAt;
        this.triggerGpuBoot(tierConfig, i, userId)
          .then(({ ok, instanceId, endpoint, reason, sshHost, sshPort, monitorUrl }) => {
            const currentStates = this.stateMap.get(userId);
            const current = currentStates?.[i];
            const stateStillBooting = current?.state === 'booting'
              && (current as BootingTierState).bootTriggeredAt === bootTimestamp;

            // If state was reset/changed while boot was in progress but we got
            // a real instanceId back, persist it so cost-monitor can track it.
            if (!stateStillBooting && ok && instanceId) {
              this.logger.warn(`[autoscaler] Boot tier ${i} succeeded (instanceId=${instanceId}) but state was already ${current?.state ?? 'cleared'} — persisting instanceId for tracking`);
              if (this.onInstancePersist) {
                void this.onInstancePersist(userId, `autoscaler_orphan_tier${i}`, {
                  instanceId, endpoint, provider: tierConfig.provider,
                  createdAt: bootTimestamp, orphanedBecause: 'state_reset_during_boot',
                }).catch((err) => {
                  this.logger.warn(`[autoscaler] Failed to persist orphaned instance ${instanceId}: ${err instanceof Error ? err.message : String(err)}`);
                });
              }
              void this.lifecycleLogger.log({
                userId, tierIndex: i, provider: tierConfig.provider,
                eventType: 'boot_ok', instanceId, endpoint,
                oldState: 'booting', newState: current?.state ?? 'cleared',
                trigger, error: 'State changed during boot — instanceId persisted for tracking',
                metadata: { orphaned: true, bootTimestamp },
              });
              return;
            }

            if (!currentStates || !stateStillBooting) return;

            if (!ok) {
              this.logger.warn(`[autoscaler] Boot tier ${i} (${tierConfig.provider}) failed: ${reason ?? 'unknown'}`);
              const failCount = (current.prevBootFailCount ?? 0) + 1;
              const durationMs = Date.now() - (current as BootingTierState).bootTriggeredAt;
              const newIdle: IdleTierState = {
                state: 'idle',
                tierIndex: i,
                bootFailCount: failCount,
                cooldownUntil: Date.now() + Math.min(BOOT_COOLDOWN_BASE_MS * Math.pow(2, failCount - 1), BOOT_COOLDOWN_MAX_MS),
              };
              currentStates[i] = newIdle;
              this.saveTierStates(userId, currentStates);
              void this.lifecycleLogger.log({
                userId, tierIndex: i, provider: tierConfig.provider,
                eventType: 'boot_failed', durationMs,
                instanceId: (current as BootingTierState).discoveredInstanceId,
                endpoint: (current as BootingTierState).endpoint, trigger: (current as BootingTierState).trigger,
                oldState: 'booting', newState: 'idle',
                error: reason ?? 'unknown',
                metadata: { failCount },
              });
              return;
            }

            const booting = current as BootingTierState;
            const updates: Partial<BootingTierState> = {};
            if (endpoint && endpoint !== booting.endpoint) {
              this.logger.log(`[autoscaler] Tier ${i} endpoint updated: ${booting.endpoint || 'none'} → ${endpoint}`);
              updates.endpoint = endpoint;
            }
            if (instanceId) updates.discoveredInstanceId = instanceId;
            if (sshHost) updates.sshHost = sshHost;
            if (sshPort) updates.sshPort = sshPort;
            if (monitorUrl) updates.monitorUrl = monitorUrl;
            if (Object.keys(updates).length > 0) {
              currentStates[i] = { ...booting, ...updates };
            }
            this.saveTierStates(userId, currentStates);
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(`[autoscaler] Boot tier ${i} (${tierConfig.provider}) unexpected error: ${msg}`);
          });

        // Start background health poller to detect when GPU becomes ready
        this.startBootHealthPoller(userId, i, tierConfig.provider, newBooting.bootTriggeredAt, tierConfig);

        break; // Only boot ONE tier — the first eligible in fallback order
      }
    }

    this.saveTierStates(userId, tierStates, prevSnapshot);

    // ── Steps 4+5: Build route decision ──
    return buildDecision(tierStates, tiers, activeSessions, config, p95, latencyTriggered, this.registry, userId);
  }

  resetGpuState(userId: string): void {
    this.stateMap.delete(userId);
    void this.persistence.persistTierStates(userId, []).catch((err) =>
      this.logger.warn('[autoscaler] Failed to persist reset state:', err),
    );
  }

  forceGpuReady(userId: string, endpoint: string): void {
    this.forceTierReady(userId, 0, endpoint);
  }

  forceTierReady(userId: string, tierIndex: number, endpoint: string): void {
    const existing = this.stateMap.get(userId) ?? [];
    while (existing.length <= tierIndex) {
      existing.push({ state: 'idle', tierIndex: existing.length } satisfies IdleTierState);
    }
    const prev = existing[tierIndex];
    const ready: ReadyTierState = {
      state: 'ready',
      tierIndex,
      endpoint,
      lastHealthyAt: Date.now(),
    };
    existing[tierIndex] = ready;
    this.stateMap.set(userId, existing);
    void this.persistence.persistTierStates(userId, existing).catch((err) =>
      this.logger.warn('[autoscaler] Failed to persist force-ready state:', err),
    );
    void this.lifecycleLogger.log({
      userId, tierIndex, provider: 'manual',
      eventType: 'boot_ok', endpoint,
      oldState: prev?.state ?? 'idle', newState: 'ready',
      trigger: 'force-ready',
      metadata: { source: 'force-ready' },
    });
  }

  getReadyEndpoints(userId: string): string[] {
    const tiers = this.stateMap.get(userId) ?? [];
    return tiers
      .filter((ts): ts is ReadyTierState => ts.state === 'ready')
      .map((ts) => ts.endpoint);
  }

  getPoolStatus(userId: string): GpuTierState[] {
    return this.stateMap.get(userId) ?? [];
  }

  /** Cancel an active boot health poller for a specific tier. */
  cancelBootPoller(userId: string, tierIndex: number): void {
    const key = `${userId}:${tierIndex}`;
    const existing = this.bootPollers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.bootPollers.delete(key);
      this.logger.log(`[autoscaler] Cancelled boot poller for tier ${tierIndex}`);
    }
  }

  /** Directly set a tier's state (used by tier-lifecycle for explicit control). */
  setTierState(userId: string, tierIndex: number, state: GpuTierState): void {
    const existing = this.stateMap.get(userId) ?? [];
    while (existing.length <= tierIndex) {
      existing.push({ state: 'idle', tierIndex: existing.length } satisfies IdleTierState);
    }
    existing[tierIndex] = state;
    this.stateMap.set(userId, existing);
    void this.persistence.persistTierStates(userId, existing).catch((err) =>
      this.logger.warn('[autoscaler] Failed to persist tier state:', err),
    );
  }

  /** Expose the registry for external use (tier-lifecycle). */
  getRegistry(): GpuProviderRegistry {
    return this.registry;
  }

  /** Expose the lifecycle logger for external use (tier-lifecycle). */
  getLifecycleLogger(): GpuLifecycleLogger {
    return this.lifecycleLogger;
  }
}
