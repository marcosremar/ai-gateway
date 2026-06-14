// ── GPU Cost Audit ──────────────────────────────────────────────────────────
// Non-instance money leaks: network volumes, stopped pods, snapshot storage.
// Complementary to sweepOrphanInstances (which only handles running VMs).

import { createLogger } from '../src/logger';
import { deployApiKey, deployState, standbyDeployState } from './state';
import { runpod, vast } from './providers';

const log = createLogger('gpu-deploy');

export interface VolumeAudit {
  id: string;
  name: string;
  sizeGb: number;
  dataCenterId: string;
  tracked: boolean;
  estMonthlyUsd: number;   // RunPod charges ~$0.10/GB/month for network volumes
}

export interface StoppedPodAudit {
  provider: 'vast' | 'runpod';
  instanceId: string;
  status: string;
  gpuType?: string;
  ageHours?: number;
  /** #537 — storage cost a stopped pod keeps accruing per month, so operators
   *  can prioritize cleanup by dollars rather than a bare count. */
  estMonthlyUsd: number;
}

export interface CostAuditReport {
  ts: string;
  volumes: {
    runpod: VolumeAudit[];
    totalMonthlyUsd: number;
    orphanCount: number;
  };
  stoppedPods: StoppedPodAudit[];
  /** #537 — combined estimated monthly storage cost across all stopped pods. */
  stoppedPodsMonthlyUsd: number;
  warnings: string[];
}

const RUNPOD_VOLUME_USD_PER_GB_MONTH = 0.10;
/** Stopped-pod storage rate (USD/GB/month) and assumed disk when size unknown.
 *  A stopped Vast pod still pays for its container disk; the API doesn't reliably
 *  expose the size here, so estimate from a configurable default. */
const STOPPED_POD_USD_PER_GB_MONTH = Number(process.env.STOPPED_POD_USD_PER_GB_MONTH) || 0.10;
const STOPPED_POD_DEFAULT_DISK_GB = Number(process.env.STOPPED_POD_DEFAULT_DISK_GB) || 30;

/** Estimate a stopped pod's monthly storage cost from its (or a default) disk size. */
export function estStoppedPodMonthlyUsd(diskGb?: number): number {
  const gb = diskGb && diskGb > 0 ? diskGb : STOPPED_POD_DEFAULT_DISK_GB;
  return Math.round(gb * STOPPED_POD_USD_PER_GB_MONTH * 100) / 100;
}

/**
 * Comprehensive cost audit — finds non-instance cost leaks.
 *
 * Read-only by default. Callers decide whether to destroy based on the
 * report. Set `destroyOrphans: true` to actually delete orphan volumes
 * (guarded by RUNPOD_VOLUME_SWEEP_DESTROY=1 env var as belt-and-braces).
 */
export async function auditGpuCosts(opts: { destroyOrphans?: boolean } = {}): Promise<CostAuditReport> {
  const report: CostAuditReport = {
    ts: new Date().toISOString(),
    volumes: { runpod: [], totalMonthlyUsd: 0, orphanCount: 0 },
    stoppedPods: [],
    stoppedPodsMonthlyUsd: 0,
    warnings: [],
  };

  const tracked = new Set<string>();
  if (deployState.podId) tracked.add(deployState.podId);
  if (standbyDeployState.podId) tracked.add(standbyDeployState.podId);

  // ── RunPod network volumes ────────────────────────────────────────────
  const rpKey = deployApiKey || process.env.RUNPOD_API_KEY || '';
  if (rpKey) {
    try {
      const volumes = await runpod.listNetworkVolumes({ apiKey: rpKey });
      for (const v of volumes) {
        const est = v.size * RUNPOD_VOLUME_USD_PER_GB_MONTH;
        // A volume is "tracked" if its name matches the gateway's current or
        // standby pod, OR if its id is referenced in any running tracked pod.
        // Without provider-side attachment info we default to conservative:
        // any volume the gateway didn't create this session = orphan candidate.
        // Guard against empty-string match — ''.includes('') is true, which
        // would mark every volume as tracked when no pod is active.
        const activePodId = deployState.podId || '';
        const standbyPodId = standbyDeployState.podId || '';
        const isTrackedByName = Boolean(
          v.name && (
            (activePodId.length > 0 && v.name.includes(activePodId)) ||
            (standbyPodId.length > 0 && v.name.includes(standbyPodId))
          ),
        );
        const audit: VolumeAudit = {
          id: v.id,
          name: v.name,
          sizeGb: v.size,
          dataCenterId: v.dataCenterId,
          tracked: isTrackedByName,
          estMonthlyUsd: est,
        };
        report.volumes.runpod.push(audit);
        report.volumes.totalMonthlyUsd += est;
        if (!audit.tracked) report.volumes.orphanCount++;
      }
      if (report.volumes.totalMonthlyUsd > 0) {
        log.log(`[cost-audit] RunPod volumes: ${volumes.length} volumes, ~$${report.volumes.totalMonthlyUsd.toFixed(2)}/month`);
      }

      // Optional destructive pass — gated by env flag AND opts.destroyOrphans
      if (opts.destroyOrphans && process.env.RUNPOD_VOLUME_SWEEP_DESTROY === '1') {
        for (const a of report.volumes.runpod.filter(v => !v.tracked)) {
          try {
            await runpod.deleteNetworkVolume(a.id, { apiKey: rpKey });
            log.log(`[cost-audit] deleted orphan RunPod volume ${a.id} (${a.name}, ${a.sizeGb}GB, ~$${a.estMonthlyUsd.toFixed(2)}/month)`);
          } catch (err) {
            report.warnings.push(`delete volume ${a.id} failed: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    } catch (err) {
      report.warnings.push(`runpod volume list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Stopped pods (Vast.ai exited/stopped consume storage) ─────────────
  const vastKey = process.env.VAST_API_KEY || '';
  if (vastKey) {
    try {
      const vastInstances = await vast.listInstances({ apiKey: vastKey });
      for (const inst of vastInstances) {
        const st = (inst.status ?? '').toLowerCase();
        if ((st === 'exited' || st === 'stopped') && !tracked.has(inst.instanceId)) {
          const est = estStoppedPodMonthlyUsd((inst as { diskGb?: number }).diskGb);
          report.stoppedPods.push({
            provider: 'vast',
            instanceId: inst.instanceId,
            status: st,
            gpuType: inst.gpuType,
            estMonthlyUsd: est,
          });
          report.stoppedPodsMonthlyUsd += est;
        }
      }
    } catch (err) {
      report.warnings.push(`vast stopped-pod list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (report.stoppedPods.length > 0) {
    log.warn(
      `[cost-audit] ${report.stoppedPods.length} stopped pod(s) accumulating storage cost ` +
        `(~$${report.stoppedPodsMonthlyUsd.toFixed(2)}/month)`,
    );
  }

  return report;
}
