/**
 * Cost Monitor — cron job that sweeps all provider accounts looking for
 * machines that are running but idle / not tracked by the autoscaler.
 *
 * Three classes of waste detected:
 *   1. **Orphaned** — running instance not tracked by any autoscaler state.
 *   2. **Stale**    — tracked instance whose /health endpoint is unreachable
 *                     (crashed process, stuck boot, etc.) beyond a grace period.
 *   3. **Zombie stopped** — stopped instance still accumulating storage charges
 *                     (TensorDock charges ~$0.005/hr for disk on stopped VMs).
 *
 * Designed to be called from an external cron (e.g. Next.js cron route,
 * Vercel Cron, or setInterval in a long-running process).
 */

import type { GpuProviderRegistry } from '../gpu-providers/registry';
import type { ProviderCredentials, GpuInstance } from '../gpu-providers/types';
import type { StatePersistence } from './state-persistence';
import type { GatewayHooks } from '../hooks';
import type { GpuLifecycleLogger } from './lifecycle-logger';
import type { Logger } from '../deps';
import { fileLifecycleLogger } from './file-lifecycle-logger';
import { emitHook } from '../hooks';
import { probeGpuHealth } from './health';
import { defaultLogger } from '../logger';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ProviderAccount {
  userId: string;
  provider: 'runpod' | 'tensordock' | string;
  credentials: ProviderCredentials;
  /** Instance IDs currently managed/tracked by the autoscaler for this user */
  trackedInstanceIds: string[];
}

export type WasteType = 'orphaned' | 'stale' | 'zombie_stopped';

export interface OrphanedInstance {
  userId: string;
  provider: string;
  instance: GpuInstance;
  /** True = autoscaler has no record of this instance */
  isOrphaned: boolean;
  /** True = tracked but /health unreachable beyond grace period */
  isStaleRunning: boolean;
  /** True = stopped instance still accumulating storage costs */
  isZombieStopped?: boolean;
  /** Action taken by the cost monitor */
  actionTaken?: 'stopped' | 'deleted' | 'none';
}

export interface CostMonitorReport {
  checkedAt: Date;
  accountsChecked: number;
  totalRunning: number;
  totalStopped: number;
  orphaned: OrphanedInstance[];
  stale: OrphanedInstance[];
  zombieStopped: OrphanedInstance[];
  errors: Array<{ userId: string; provider: string; error: string }>;
}

export interface CostMonitorDeps {
  registry: GpuProviderRegistry;
  persistence: StatePersistence;
  /**
   * Load all provider accounts to scan.
   * The host app implements this — typically reads from DB for all users.
   */
  loadAllAccounts: () => Promise<ProviderAccount[]>;
  /**
   * Optional: called for each orphaned/stale/zombie instance found.
   * Use this to send alerts (Slack, email, etc.) or log to DB.
   */
  onOrphanDetected?: (orphan: OrphanedInstance) => Promise<void>;
  /**
   * If true, automatically stop orphaned/stale instances.
   * Use with care — defaults to false (report-only mode).
   */
  autoStop?: boolean;
  /**
   * If true, automatically delete stopped instances to avoid storage charges.
   * More aggressive than autoStop — defaults to false.
   */
  autoDelete?: boolean;
  /**
   * If true, probe /health endpoints of tracked running instances
   * to detect stale machines. Defaults to true.
   */
  probeHealth?: boolean;
  /**
   * Grace period (minutes) before a tracked instance with no /health response
   * is considered stale. Accounts for boot time. Defaults to 20 minutes.
   */
  staleGraceMinutes?: number;
  /** Gateway hooks for cost alerts */
  hooks?: GatewayHooks;
  /** Persistent lifecycle logger */
  lifecycleLogger?: GpuLifecycleLogger;
  /**
   * Override for health probe function (for testing).
   * @internal
   */
  _probeHealth?: (endpoint: string) => Promise<boolean>;
  /**
   * Inject a StaleTracker instance for testability.
   * Default: module-level defaultStaleTracker.
   */
  staleTracker?: StaleTracker;
  /** Logger for structured output */
  logger?: Logger;
}

// ─── Statuses that mean "machine is costing money" ─────────────────────────

const RUNNING_STATUSES = new Set([
  // RunPod
  'RUNNING',
  // TensorDock
  'running',
  'online',
  'active',
]);

/** Stopped statuses — machine may still incur storage charges */
const STOPPED_STATUSES = new Set([
  // RunPod
  'EXITED',
  // TensorDock
  'stopped',
  'stoppeddisassociated',
  'StoppedDisassociated',
]);

function isRunning(status: string): boolean {
  return RUNNING_STATUSES.has(status) || status.toLowerCase().includes('run');
}

function isStopped(status: string): boolean {
  return STOPPED_STATUSES.has(status) || status.toLowerCase().includes('stop');
}

// ─── Stale tracking — remember when instances first appeared unhealthy ──────

/** Maximum entries before forced pruning (prevents unbounded growth) */
const STALE_MAP_MAX_SIZE = 500;
/** Maximum age for stale entries: 24 hours */
const STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Encapsulates stale-instance tracking state.
 * Testable: inject a fresh instance per test instead of relying on module-level state.
 */
export class StaleTracker {
  private map = new Map<string, number>();

  /**
   * Returns true if the instance has been unhealthy for longer than graceMs.
   */
  checkGrace(instanceId: string, healthy: boolean, graceMs: number): boolean {
    if (healthy) {
      this.map.delete(instanceId);
      return false;
    }
    const now = Date.now();
    if (!this.map.has(instanceId)) {
      this.map.set(instanceId, now);
    }

    // Prune entries to prevent unbounded memory growth
    if (this.map.size > STALE_MAP_MAX_SIZE) {
      // First pass: remove entries older than 24h
      for (const [id, ts] of this.map) {
        if (now - ts > STALE_MAX_AGE_MS) this.map.delete(id);
      }
      // If still over limit, evict oldest entries
      if (this.map.size > STALE_MAP_MAX_SIZE) {
        const sorted = [...this.map.entries()].sort((a, b) => a[1] - b[1]);
        const toRemove = sorted.slice(0, this.map.size - Math.floor(STALE_MAP_MAX_SIZE * 0.8));
        for (const [id] of toRemove) this.map.delete(id);
      }
    }

    return (now - this.map.get(instanceId)!) >= graceMs;
  }

  reset(): void {
    this.map.clear();
  }
}

/** Default module-level instance for backward compat */
const defaultStaleTracker = new StaleTracker();

// ─── Main cycle ─────────────────────────────────────────────────────────────

/**
 * Run one full cost-monitor sweep across all registered provider accounts.
 * Detects orphaned, stale, and zombie-stopped instances.
 */
export async function runCostMonitorCycle(deps: CostMonitorDeps): Promise<CostMonitorReport> {
  const {
    registry, loadAllAccounts, onOrphanDetected,
    autoStop, autoDelete,
    probeHealth: shouldProbe = true,
    staleGraceMinutes = 10,
  } = deps;

  const healthProbe = deps._probeHealth ?? probeGpuHealth;
  const staleTracker = deps.staleTracker ?? defaultStaleTracker;
  const log = deps.logger ?? defaultLogger;
  const staleGraceMs = staleGraceMinutes * 60_000;

  const report: CostMonitorReport = {
    checkedAt: new Date(),
    accountsChecked: 0,
    totalRunning: 0,
    totalStopped: 0,
    orphaned: [],
    stale: [],
    zombieStopped: [],
    errors: [],
  };

  let accounts: ProviderAccount[];
  try {
    accounts = await loadAllAccounts();
  } catch (err) {
    report.errors.push({ userId: 'system', provider: 'all', error: String(err) });
    return report;
  }

  // Merge accounts that share the same provider+apiKey so that ALL tracked
  // instance IDs across users are considered before orphan detection.
  // Without this, instances created by user A but scanned under user B's
  // account (same API key) would be flagged as orphans.
  const mergedMap = new Map<string, ProviderAccount>();
  for (const account of accounts) {
    const dedupeKey = `${account.provider}::${account.credentials.apiKey}`;
    const existing = mergedMap.get(dedupeKey);
    if (existing) {
      // Merge tracked IDs from this user into the existing entry
      for (const id of account.trackedInstanceIds) {
        if (!existing.trackedInstanceIds.includes(id)) {
          existing.trackedInstanceIds.push(id);
        }
      }
    } else {
      // First time seeing this provider+key — clone to avoid mutating original
      mergedMap.set(dedupeKey, {
        ...account,
        trackedInstanceIds: [...account.trackedInstanceIds],
      });
    }
  }

  for (const account of mergedMap.values()) {

    report.accountsChecked++;

    const client = registry.get(account.provider);
    if (!client) {
      report.errors.push({
        userId: account.userId,
        provider: account.provider,
        error: `No client registered for provider "${account.provider}"`,
      });
      continue;
    }

    let instances: GpuInstance[];
    try {
      instances = await Promise.race([
        client.listInstances(account.credentials),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('listInstances timed out after 30s')), 30_000)),
      ]);
    } catch (err) {
      report.errors.push({
        userId: account.userId,
        provider: account.provider,
        error: `listInstances failed: ${String(err)}`,
      });
      emitHook(deps.hooks, 'onError', {
        source: 'cost-monitor', userId: account.userId, provider: account.provider,
        operation: 'listInstances', message: String(err),
        retryable: true, timestamp: Date.now(),
      });
      continue;
    }

    const runningInstances = instances.filter((i) => isRunning(i.status));
    const stoppedInstances = instances.filter((i) => isStopped(i.status));
    report.totalRunning += runningInstances.length;
    report.totalStopped += stoppedInstances.length;

    // Log all instances for visibility
    log.log(
      `[cost-monitor] ${account.provider} account (user: ${account.userId}): ` +
      `${instances.length} total, ${runningInstances.length} running, ${stoppedInstances.length} stopped` +
      (instances.length > 0 ? ':' : ''),
    );
    for (const inst of instances) {
      const tracked = account.trackedInstanceIds.includes(inst.instanceId);
      log.log(
        `  - ${inst.instanceId}${inst.instanceName ? ` (${inst.instanceName})` : ''} ` +
        `status=${inst.status} tracked=${tracked} endpoint=${inst.endpoint || 'none'}`,
      );
    }

    const trackedIds = new Set(account.trackedInstanceIds);

    // ── Check running instances for orphans and stale ──────────────────────

    // Probe health in parallel for tracked running instances
    const healthResults = new Map<string, boolean>();
    if (shouldProbe) {
      const trackedRunning = runningInstances.filter((i) => trackedIds.has(i.instanceId) && i.endpoint);
      const probes = trackedRunning.map(async (inst) => {
        const healthy = await healthProbe(inst.endpoint);
        healthResults.set(inst.instanceId, healthy);
      });
      await Promise.all(probes);
    }

    for (const instance of runningInstances) {
      let isOrphaned = !trackedIds.has(instance.instanceId);

      // Safety: autoscaler-created instances (parle-autoscale-*) may not yet be
      // persisted to DB. The name contains a timestamp — skip if within boot window.
      if (isOrphaned && instance.instanceName?.startsWith('parle-autoscale-')) {
        const tsMatch = instance.instanceName.match(/parle-autoscale-(\d+)/);
        if (tsMatch) {
          const createdAt = Number(tsMatch[1]);
          const ageMs = Date.now() - createdAt;
          const bootGraceMs = 30 * 60_000; // 30 min — covers worst-case boot
          if (ageMs < bootGraceMs) {
            log.log(
              `[cost-monitor] Skipping ${instance.instanceId} (${instance.instanceName}) — ` +
              `created ${Math.round(ageMs / 60_000)}min ago, within boot grace`,
            );
            isOrphaned = false;
          }
        }
      }

      // Stale detection: tracked instance whose /health is unreachable beyond grace
      let isStaleRunning = false;
      if (!isOrphaned && shouldProbe && instance.endpoint) {
        const healthy = healthResults.get(instance.instanceId) ?? false;
        isStaleRunning = staleTracker.checkGrace(instance.instanceId, healthy, staleGraceMs);
      }

      if (!isOrphaned && !isStaleRunning) continue;

      const wasteType: WasteType = isOrphaned ? 'orphaned' : 'stale';
      const entry: OrphanedInstance = {
        userId: account.userId,
        provider: account.provider,
        instance,
        isOrphaned,
        isStaleRunning,
        actionTaken: 'none',
      };

      if (isOrphaned) {
        report.orphaned.push(entry);
      } else {
        report.stale.push(entry);
      }

      emitHook(deps.hooks, 'onCostAlert', {
        userId: account.userId,
        provider: account.provider,
        instanceId: instance.instanceId,
        instanceName: instance.instanceName,
        alertType: wasteType,
        message: `${wasteType === 'orphaned' ? 'Orphaned' : 'Stale'} instance ${instance.instanceId} running on ${account.provider}`,
        timestamp: Date.now(),
      });

      if (onOrphanDetected) {
        try {
          await onOrphanDetected(entry);
        } catch (err) {
          log.warn('[cost-monitor] onOrphanDetected callback failed:', err);
        }
      }

      if (autoStop) {
        try {
          await client.stopInstance(instance.instanceId, account.credentials);
          entry.actionTaken = 'stopped';
          log.log(
            `[cost-monitor] Auto-stopped ${wasteType} ${account.provider} instance ${instance.instanceId}` +
            (instance.instanceName ? ` (${instance.instanceName})` : ''),
          );
        } catch (err) {
          log.warn(`[cost-monitor] Auto-stop failed for ${instance.instanceId}:`, err);
          report.errors.push({
            userId: account.userId,
            provider: account.provider,
            error: `Auto-stop ${instance.instanceId} failed: ${String(err)}`,
          });
          emitHook(deps.hooks, 'onError', {
            source: 'cost-monitor', userId: account.userId, provider: account.provider,
            instanceId: instance.instanceId, operation: 'autoStop',
            message: String(err), retryable: true, timestamp: Date.now(),
          });
        }
      }
    }

    // ── Check stopped instances for zombie storage costs ────────────────────

    if (autoDelete) {
      for (const instance of stoppedInstances) {
        // Skip tracked instances — the autoscaler may be actively booting them.
        // TensorDock instances can briefly show StoppedDisassociated during boot.
        if (trackedIds.has(instance.instanceId)) {
          log.log(
            `[cost-monitor] Skipping tracked stopped ${account.provider} instance ${instance.instanceId}` +
            (instance.instanceName ? ` (${instance.instanceName})` : '') +
            ` — autoscaler may be managing it`,
          );
          continue;
        }

        // Also skip recently-created autoscale instances (name-based safety net)
        if (instance.instanceName?.startsWith('parle-autoscale-')) {
          const tsMatch = instance.instanceName.match(/parle-autoscale-(\d+)/);
          if (tsMatch) {
            const createdAt = parseInt(tsMatch[1], 10);
            const ageMs = Date.now() - createdAt;
            const bootWindowMs = (staleGraceMs > 0 ? staleGraceMs : 20 * 60_000) * 2;
            if (ageMs < bootWindowMs) {
              log.log(
                `[cost-monitor] Skipping recently-created stopped instance ${instance.instanceId}` +
                ` (${instance.instanceName}, age=${Math.round(ageMs / 1000)}s) — within boot window`,
              );
              continue;
            }
          }
        }

        const entry: OrphanedInstance = {
          userId: account.userId,
          provider: account.provider,
          instance,
          isOrphaned: !trackedIds.has(instance.instanceId),
          isStaleRunning: false,
          isZombieStopped: true,
          actionTaken: 'none',
        };

        report.zombieStopped.push(entry);

        emitHook(deps.hooks, 'onCostAlert', {
          userId: account.userId,
          provider: account.provider,
          instanceId: instance.instanceId,
          instanceName: instance.instanceName,
          alertType: 'orphaned',
          message: `Zombie stopped instance ${instance.instanceId} on ${account.provider} (still incurring storage costs)`,
          timestamp: Date.now(),
        });

        const costLogger = deps.lifecycleLogger ?? fileLifecycleLogger;
        try {
          await client.deleteInstance(instance.instanceId, account.credentials);
          entry.actionTaken = 'deleted';
          log.log(
            `[cost-monitor] Auto-deleted zombie stopped ${account.provider} instance ${instance.instanceId}` +
            (instance.instanceName ? ` (${instance.instanceName})` : ''),
          );
          void costLogger.log({
            userId: account.userId, tierIndex: -1, provider: account.provider,
            eventType: 'zombie_deleted',
            instanceId: instance.instanceId,
            endpoint: instance.endpoint,
            trigger: 'cost-monitor',
            metadata: { instanceName: instance.instanceName, status: instance.status },
          });
        } catch (err) {
          log.warn(`[cost-monitor] Auto-delete failed for ${instance.instanceId}:`, err);
          report.errors.push({
            userId: account.userId,
            provider: account.provider,
            error: `Auto-delete ${instance.instanceId} failed: ${String(err)}`,
          });
          emitHook(deps.hooks, 'onError', {
            source: 'cost-monitor', userId: account.userId, provider: account.provider,
            instanceId: instance.instanceId, operation: 'autoDelete',
            message: String(err), retryable: true, timestamp: Date.now(),
          });
        }
      }
    }
  }

  // ── Summary log ──────────────────────────────────────────────────────────

  const wasteCount = report.orphaned.length + report.stale.length + report.zombieStopped.length;
  if (wasteCount > 0) {
    log.warn(
      `[cost-monitor] Found ${wasteCount} wasteful instance(s) across ${report.accountsChecked} account(s): ` +
      `${report.orphaned.length} orphaned, ${report.stale.length} stale, ${report.zombieStopped.length} zombie stopped. ` +
      `autoStop=${autoStop ?? false}, autoDelete=${autoDelete ?? false}`,
    );
  } else {
    log.log(
      `[cost-monitor] Clean sweep: ${report.totalRunning} running, ${report.totalStopped} stopped. ` +
      `(${report.accountsChecked} accounts checked)`,
    );
  }

  return report;
}

/** Clear the in-memory stale tracking map (useful for testing). */
export function _resetStaleTracking(): void {
  defaultStaleTracker.reset();
}

/**
 * Start a background ticker that runs runCostMonitorCycle periodically.
 * Returns a cleanup function.
 *
 * @param intervalMs - defaults to 10 minutes
 */
export function startCostMonitorTicker(
  deps: CostMonitorDeps,
  intervalMs: number = 5 * 60 * 1000,
): () => void {
  const log = deps.logger ?? defaultLogger;
  let costMonitorRunning = false;

  const runGuarded = async () => {
    if (costMonitorRunning) {
      log.log('[cost] Previous cycle still running, skipping');
      return;
    }
    costMonitorRunning = true;
    try {
      await runCostMonitorCycle(deps);
    } catch (err) {
      log.warn('[cost-monitor] Cycle failed:', err);
    } finally {
      costMonitorRunning = false;
    }
  };

  // Run immediately on start
  void runGuarded();

  const interval = setInterval(() => {
    void runGuarded();
  }, intervalMs);

  if (interval.unref) interval.unref();
  return () => clearInterval(interval);
}
