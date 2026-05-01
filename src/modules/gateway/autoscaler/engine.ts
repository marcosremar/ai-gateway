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
} from '../../types';
import type { GpuProviderRegistry } from '../providers/gpu/registry';
import type { ProviderCredentials } from '../providers/gpu/types';
import type { SessionTracker } from './session-tracker';
import type { LatencyTracker } from './latency-tracker';
import type { StatePersistence } from './state-persistence';
import type { GatewayHooks } from '../../hooks';
import type { GpuLifecycleLogger } from './lifecycle-logger';
import type { Logger } from '../../deps';
import { fileLifecycleLogger } from './file-lifecycle-logger';
import { LATENCY_BREACH_COUNT, countRecentBreaches } from './latency-tracker';
import { emitHook } from '../../hooks';
import { defaultLogger } from '../../logger';
import { handleBootTimeout } from './boot-timeout';
import { probeAllTiers, processHealthResults } from './health-checker';
import { buildDecision } from './decision-builder';
import { BootOrchestrator, type BootOrchestratorCallbacks } from './boot-orchestrator';
import { ProviderMonitor } from './provider-monitor';
import { TierSelector } from './tier-selector';

// Re-export for backward compatibility
export { StageTimeoutError } from './stage-timeout';

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
  /** Read back data previously saved via onInstancePersist. Required for SnapGPU auto-snapshot restore. */
  getPersistedData?: (userId: string, key: string) => Promise<Record<string, unknown> | null>;
  lifecycleLogger?: GpuLifecycleLogger;
  logger?: Logger;
  /** Resolve credentials for a provider (used for price monitoring). Falls back to env vars if not provided. */
  resolveCredentials?: (provider: string) => Promise<ProviderCredentials | null>;
}

export class AutoscalerEngine {
  /** stateMap[userId] = array of tier states indexed by tierIndex */
  private stateMap = new Map<string, GpuTierState[]>();
  /** Per-user mutex to prevent concurrent getAutoScaleDecision from racing on boot triggers */
  private decisionLocks = new Map<string, Promise<AutoScaleDecision>>();

  private readonly registry: GpuProviderRegistry;
  private readonly sessionTracker: SessionTracker;
  private readonly latencyTracker: LatencyTracker;
  private readonly persistence: StatePersistence;
  private readonly hooks?: GatewayHooks;
  private readonly lifecycleLogger: GpuLifecycleLogger;
  private readonly logger: Logger;
  private readonly probeHealth: (endpoint: string) => Promise<boolean>;
  private readonly cleanupInstance: (config: GpuTierConfig, registry: GpuProviderRegistry, reason: string) => Promise<void>;
  private readonly onInstancePersist?: (userId: string, machineKey: string, data: Record<string, unknown>) => Promise<void>;
  private readonly getPersistedData?: (userId: string, key: string) => Promise<Record<string, unknown> | null>;

  private readonly bootOrchestrator: BootOrchestrator;
  private readonly providerMonitor: ProviderMonitor;
  private readonly tierSelector: TierSelector;

  constructor(opts: AutoscalerEngineOptions) {
    this.registry = opts.registry;
    this.sessionTracker = opts.sessionTracker;
    this.latencyTracker = opts.latencyTracker;
    this.persistence = opts.persistence;
    this.probeHealth = opts.probeHealth;
    this.cleanupInstance = opts.cleanupInstance;
    this.hooks = opts.hooks;
    this.onInstancePersist = opts.onInstancePersist;
    this.getPersistedData = opts.getPersistedData;
    this.lifecycleLogger = opts.lifecycleLogger ?? fileLifecycleLogger;
    this.logger = opts.logger ?? defaultLogger;

    this.providerMonitor = new ProviderMonitor({
      registry: this.registry,
      logger: this.logger,
      resolveCredentials: opts.resolveCredentials,
    });
    this.tierSelector = new TierSelector({ registry: this.registry, logger: this.logger });

    const callbacks: BootOrchestratorCallbacks = {
      getStates: (userId) => this.stateMap.get(userId),
      setStates: (userId, s) => this.stateMap.set(userId, s),
      persistStates: (userId, s) => void this.persistence.persistTierStates(userId, s).catch((err) =>
        this.logger.warn('[autoscaler] Background persist failed:', err),
      ),
      emitError: (f) => this.emitError(f),
      recordProviderHealthEvent: (p, ok) => this.providerMonitor.recordHealthEvent(p, ok),
    };
    this.bootOrchestrator = new BootOrchestrator({
      registry: this.registry,
      probeHealth: this.probeHealth,
      hooks: this.hooks,
      lifecycleLogger: this.lifecycleLogger,
      logger: this.logger,
      onInstancePersist: this.onInstancePersist,
      getPersistedData: this.getPersistedData,
      callbacks,
    });
  }

  /** Emit an error event via hooks. Fire-and-forget. */
  private emitError(fields: Omit<import('../../hooks').ErrorEvent, 'source' | 'timestamp'>): void {
    emitHook(this.hooks, 'onError', {
      source: 'autoscaler',
      ...fields,
      timestamp: Date.now(),
    });
  }

  /** Expose stateMap for watchdog/external iteration */
  getStateMap(): Map<string, GpuTierState[]> {
    return this.stateMap;
  }

  /**
   * True if a getAutoScaleDecision call for this user is currently in flight.
   * Watchdog uses this to skip stopping tiers while the engine is mid-decision —
   * otherwise watchdog can race the engine and stop a tier the engine is about
   * to mark as needed.
   */
  isDecisionInFlight(userId: string): boolean {
    return this.decisionLocks.has(userId);
  }

  /**
   * Wait for any in-flight decision for this user to complete. Resolves
   * immediately if no decision is pending. Use this from watchdog before
   * mutating tier state to avoid racing with engine.
   */
  async waitForDecision(userId: string): Promise<void> {
    const lock = this.decisionLocks.get(userId);
    if (!lock) return;
    try { await lock; } catch { /* ignore — engine already logged */ }
  }

  /** Evict stateMap entries where all tiers are idle (prevents unbounded growth). */
  evictIdleUsers(): void {
    for (const [userId, tierStates] of this.stateMap) {
      if (tierStates.every(ts => ts.state === 'idle')) {
        this.stateMap.delete(userId);
      }
    }
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
      void this.persistence.persistTierStates(userId, states).catch((err) => {
        this.logger.warn('[autoscaler] Failed to persist restored states:', err);
        this.emitError({
          operation: 'persistTierStates', userId,
          message: err instanceof Error ? err.message : String(err),
          errorCode: 'PERSIST_FAILED', retryable: true,
        });
      });
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
        void this.persistence.persistTierStates(userId, states).catch((err) => {
          this.logger.warn('[autoscaler] Background persist failed:', err);
          this.emitError({
            operation: 'persistTierStates', userId,
            message: err instanceof Error ? err.message : String(err),
            errorCode: 'PERSIST_FAILED', retryable: true,
          });
        });
      }
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
    const chain = (prev
      ? prev.catch((e) => {
          // Surface previous decision failures via the hooks system, not just stderr.
          // Without this, host apps had no way to detect that a prior autoscaler
          // decision crashed (silent observability gap noted in the audit).
          const msg = e instanceof Error ? e.message : String(e);
          console.warn('[autoscaler] previous decision failed:', msg);
          this.emitError({
            userId,
            operation: 'getAutoScaleDecision:previousChain',
            message: `Previous decision in chain failed: ${msg}`,
            retryable: true,
          });
        })
      : Promise.resolve()
    ).then(() => this._getAutoScaleDecisionImpl(userId, config, options));
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
    const totalTiers = tiers.length;

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
        this.emitError({
          operation: 'bootTimeout', provider: tierProvider,
          tierIndex: i, userId, instanceId: ts.discoveredInstanceId,
          message: `Boot timed out after ${Math.round((now - ts.bootTriggeredAt) / 1000)}s (pre-probe)`,
          errorCode: 'BOOT_TIMEOUT', retryable: true,
        });
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
    const trigger: ScaleTrigger = sessionTriggered ? 'sessions' : latencyTriggered ? 'latency' : 'sessions';

    const hasActiveTier = tierStates.some(ts => ts.state === 'ready' || ts.state === 'booting');

    if (needsGpu && !hasActiveTier && !dryRun) {
      const bestTierIndex = await this.tierSelector.findBestTierForBoot(tiers, tierStates, userId, this.providerMonitor);

      if (bestTierIndex >= 0) {
        const i = bestTierIndex;
        const ts = tierStates[i];
        const tierConfig = tiers[i];

        const shouldConsiderSpot = tierConfig.storageGb === 0 &&
          (tierConfig.dockerImage?.includes('babelcast') || tierConfig.dockerImage?.includes('parle')) &&
          !tierConfig.env?.['REQUIRES_ON_DEMAND'];

        const priceInfo = this.providerMonitor.getPriceInfo(tierConfig.provider);
        const reliability = this.providerMonitor.getReliabilityScore(tierConfig.provider);

        this.logger.log(`[autoscaler] Boot tier ${i} (${tierConfig.provider}) for user ${userId} — trigger=${trigger} spotEligible=${shouldConsiderSpot} price=$${priceInfo?.price.toFixed(3) ?? 'N/A'}/hr reliability=${reliability?.toFixed(2) ?? 'N/A'}`);
        emitHook(this.hooks, 'onScaleUp', {
          userId, tierIndex: i, provider: tierConfig.provider,
          trigger, activeSessions, timestamp: Date.now(),
        });
        void this.lifecycleLogger.log({
          userId, tierIndex: i, provider: tierConfig.provider,
          eventType: 'boot_started', trigger,
          oldState: 'idle', newState: 'booting',
          endpoint: tierConfig.endpoint,
          metadata: { activeSessions, pricePerHr: priceInfo?.price, reliability },
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

        // Fire-and-forget boot via orchestrator
        const bootPromise = this.bootOrchestrator.triggerGpuBoot(tierConfig, i, userId);
        this.bootOrchestrator.handleBootResult(userId, i, tierConfig, newBooting.bootTriggeredAt, trigger, bootPromise);

        // Start background health poller
        this.bootOrchestrator.startBootHealthPoller(userId, i, tierConfig.provider, newBooting.bootTriggeredAt, tierConfig);
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

  /** Trigger a GPU boot for a tier directly (exposed for factory/predictive-warmup use). */
  triggerGpuBoot(
    tierConfig: GpuTierConfig,
    tierIndex: number,
    userId: string,
    attempt = 0,
  ): Promise<{ ok: boolean; instanceId?: string; endpoint?: string; activeGpuType?: string; reason?: string; sshHost?: string; sshPort?: number; monitorUrl?: string }> {
    return this.bootOrchestrator.triggerGpuBoot(tierConfig, tierIndex, userId, attempt);
  }

  /** Cancel an active boot health poller for a specific tier. */
  cancelBootPoller(userId: string, tierIndex: number): void {
    this.bootOrchestrator.cancelBootPoller(userId, tierIndex);
  }

  /** Cancel all boot pollers and clean up resources. Call on gateway shutdown. */
  destroy(): void {
    this.bootOrchestrator.destroyAllPollers();
    this.decisionLocks.clear();
    this.logger.log(`[autoscaler] Engine destroyed — ${this.stateMap.size} user states preserved`);
  }

  /** Record a health event for a provider to update reliability scores. */
  recordProviderHealthEvent(provider: string, success: boolean): void {
    this.providerMonitor.recordHealthEvent(provider, success);
  }

  /** Get current reliability score for a provider. */
  getProviderReliability(provider: string): number {
    return this.providerMonitor.getProviderReliability(provider);
  }

  /** Get current price for a provider. */
  getProviderPrice(provider: string): number | null {
    return this.providerMonitor.getProviderPrice(provider);
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
