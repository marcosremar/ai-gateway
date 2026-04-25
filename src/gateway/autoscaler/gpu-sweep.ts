/**
 * Universal GPU Sweep — discover ALL running instances across ALL providers
 * with credentials available in .env, regardless of whether the autoscaler
 * tracks them.
 *
 * Why: the WiLoR pod deployed via VastClient.createInstance() (outside the
 * autoscaler) exited without the gateway knowing. This sweep finds such
 * "untracked" instances, logs them, and optionally stops them.
 *
 * This is a superset of cost-monitor.ts which only scans accounts
 * registered via loadAllAccounts(). This sweep doesn't need any
 * registration — it reads API keys directly from process.env.
 *
 * Usage:
 *   import { sweepAllProviders } from '@parle/ai-gateway/autoscaler';
 *   const report = await sweepAllProviders();
 *   // report.instances: [{ provider, instanceId, status, gpuType, ... }]
 *   // report.totalRunning: number
 *   // report.totalCostPerHr: number
 *
 * The sweep is also wired into the server's /v1/gpu/sweep endpoint and
 * called periodically by the watchdog (if enabled).
 */

import type { GpuInstance } from '../providers/gpu/types';
import { logGpuEvent } from './file-lifecycle-logger';
import { defaultLogger as log } from '../../logger';

export interface SweepInstance extends GpuInstance {
  provider: string;
  costPerHr?: number;
  isTracked: boolean;
  age?: string;
}

export interface SweepReport {
  ts: string;
  providers: string[];
  instances: SweepInstance[];
  totalRunning: number;
  totalStopped: number;
  totalCostPerHr: number;
  untracked: SweepInstance[];
  errors: Array<{ provider: string; error: string }>;
}

interface ProviderSweepConfig {
  provider: string;
  envKey: string;        // e.g. 'VAST_API_KEY'
  envKeyAlt?: string;    // e.g. 'RUNPOD_API_KEY'
  authIdEnv?: string;    // e.g. 'TENSORDOCK_AUTH_ID'
  createClient: () => Promise<any>;
}

const PROVIDER_CONFIGS: ProviderSweepConfig[] = [
  {
    provider: 'vast',
    envKey: 'VAST_API_KEY',
    createClient: async () => {
      const { VastClient } = await import('../providers/gpu/vast-client');
      return new VastClient();
    },
  },
  {
    provider: 'runpod',
    envKey: 'RUNPOD_API_KEY',
    createClient: async () => {
      const { RunpodClient } = await import('../providers/gpu/runpod-client');
      return new RunpodClient();
    },
  },
  {
    provider: 'tensordock',
    envKey: 'TENSORDOCK_API_KEY',
    authIdEnv: 'TENSORDOCK_AUTH_ID',
    createClient: async () => {
      const { TensordockClient } = await import('../providers/gpu/tensordock-client');
      return new TensordockClient();
    },
  },
  {
    provider: 'hyperstack',
    envKey: 'HYPERSTACK_API_KEY',
    createClient: async () => {
      const { HyperstackClient } = await import('../providers/gpu/hyperstack-client');
      return new HyperstackClient();
    },
  },
];

const RUNNING_STATUSES = new Set([
  'running', 'active', 'loading', 'creating', 'booting',
  'RUNNING', 'ACTIVE', 'CREATING',
]);

/**
 * Sweep ALL providers for running instances. Returns a complete inventory
 * regardless of what the autoscaler tracks.
 *
 * @param trackedIds Set of instanceIds the autoscaler currently manages.
 *   Instances not in this set are flagged as `isTracked: false`.
 * @param options.autoLog If true (default), log every discovered instance
 *   and any untracked ones to the file lifecycle logger.
 */
export async function sweepAllProviders(
  trackedIds: Set<string> = new Set(),
  options?: { autoLog?: boolean },
): Promise<SweepReport> {
  const autoLog = options?.autoLog ?? true;
  const report: SweepReport = {
    ts: new Date().toISOString(),
    providers: [],
    instances: [],
    totalRunning: 0,
    totalStopped: 0,
    totalCostPerHr: 0,
    untracked: [],
    errors: [],
  };

  // Sweep each provider in parallel
  const promises = PROVIDER_CONFIGS.map(async (cfg) => {
    const apiKey = process.env[cfg.envKey];
    if (!apiKey) return; // No credentials — skip this provider

    const authId = cfg.authIdEnv ? process.env[cfg.authIdEnv] : undefined;
    if (cfg.authIdEnv && !authId) return; // Needs auth ID but missing

    report.providers.push(cfg.provider);

    try {
      const client = await cfg.createClient();
      const instances: GpuInstance[] = await client.listInstances({
        apiKey,
        authId,
      });

      for (const inst of instances) {
        const status = (inst.status || 'unknown').toLowerCase();
        const isRunning = RUNNING_STATUSES.has(status) || RUNNING_STATUSES.has(inst.status || '');
        const isTracked = trackedIds.has(inst.instanceId);
        let costPerHr: number | undefined;

        // Try to get cost for running instances
        if (isRunning && typeof client.getInstanceCost === 'function') {
          try {
            costPerHr = await client.getInstanceCost(inst.instanceId, { apiKey, authId }) ?? undefined;
          } catch { /* ignore */ }
        }

        const sweepInst: SweepInstance = {
          ...inst,
          provider: cfg.provider,
          costPerHr,
          isTracked,
        };

        report.instances.push(sweepInst);
        if (isRunning) {
          report.totalRunning++;
          if (costPerHr) report.totalCostPerHr += costPerHr;
        } else {
          report.totalStopped++;
        }

        if (!isTracked) {
          report.untracked.push(sweepInst);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push({ provider: cfg.provider, error: msg });
      log.warn(`[gpu-sweep] ${cfg.provider} sweep failed: ${msg}`);
    }
  });

  await Promise.allSettled(promises);

  // Log the sweep results
  if (autoLog) {
    logGpuEvent({
      userId: 'system',
      tierIndex: -1,
      provider: 'sweep',
      eventType: 'sweep_complete',
      metadata: {
        source: 'gpu-sweep',
        msg: `Swept ${report.providers.length} providers: ${report.totalRunning} running, ${report.totalStopped} stopped, ${report.untracked.length} untracked, $${report.totalCostPerHr.toFixed(2)}/hr`,
        providers: report.providers,
        totalRunning: report.totalRunning,
        totalStopped: report.totalStopped,
        totalCostPerHr: report.totalCostPerHr,
        untrackedCount: report.untracked.length,
      },
    });

    // Log each untracked instance individually (the whole point of this sweep)
    for (const u of report.untracked) {
      logGpuEvent({
        userId: 'system',
        tierIndex: -1,
        provider: u.provider,
        eventType: 'untracked_instance',
        instanceId: u.instanceId,
        endpoint: u.endpoint,
        metadata: {
          source: 'gpu-sweep',
          msg: `UNTRACKED ${u.provider} instance ${u.instanceId} (status=${u.status}, gpu=${u.gpuType || '?'}, cost=$${u.costPerHr?.toFixed(2) || '?'}/hr)`,
          gpuType: u.gpuType,
          pricePerHr: u.costPerHr,
          status: u.status,
        },
      });
    }
  }

  return report;
}

/**
 * Pretty-print a sweep report to console. Useful for CLI tooling or
 * the admin panel's "GPU Inventory" section.
 */
export function printSweepReport(report: SweepReport): void {
  log.log(`\n=== GPU Sweep @ ${report.ts} ===`);
  log.log(`Providers: ${report.providers.join(', ')}`);
  log.log(`Running: ${report.totalRunning} | Stopped: ${report.totalStopped} | Cost: $${report.totalCostPerHr.toFixed(2)}/hr`);

  if (report.instances.length === 0) {
    log.log('No instances found.');
  } else {
    log.log('\nInstances:');
    for (const inst of report.instances) {
      const icon = inst.isTracked ? '✅' : '⚠️';
      const cost = inst.costPerHr != null ? `$${inst.costPerHr.toFixed(2)}/hr` : '';
      log.log(
        `  ${icon} ${inst.provider.padEnd(10)} ${inst.instanceId.padEnd(25)} ${(inst.status || '?').padEnd(10)} ${(inst.gpuType || '?').padEnd(20)} ${cost} ${inst.isTracked ? '' : '← UNTRACKED'}`,
      );
    }
  }

  if (report.untracked.length > 0) {
    log.warn(`\n⚠️  ${report.untracked.length} UNTRACKED instance(s) found!`);
    log.warn('   These are running outside the autoscaler and will NOT be auto-stopped.');
  }

  if (report.errors.length > 0) {
    log.error(`\n❌ ${report.errors.length} provider error(s):`);
    for (const e of report.errors) log.error(`   ${e.provider}: ${e.error}`);
  }
  log.log('');
}
