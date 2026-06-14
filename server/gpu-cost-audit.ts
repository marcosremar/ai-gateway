// ── GPU Cost Audit ──────────────────────────────────────────────────────────
// Non-instance money leaks: network volumes, stopped pods, snapshot storage.
// Complementary to sweepOrphanInstances (which only handles running VMs).

import { createLogger } from '../src/logger';
import { deployApiKey, deployState, standbyDeployState } from './state';
import { runpod, vast, tensordock, hyperstack } from './providers';

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
  /** #536 — audit now covers more than vast/runpod. */
  provider: 'vast' | 'runpod' | 'tensordock' | 'hyperstack';
  instanceId: string;
  status: string;
  gpuType?: string;
  ageHours?: number;
  /** #537 — storage cost a stopped pod keeps accruing per month, so operators
   *  can prioritize cleanup by dollars rather than a bare count. */
  estMonthlyUsd: number;
}

/**
 * #110 — resolve the RunPod API key for the audit.
 *
 * `deployApiKey` is only populated while a deploy is active, so on an idle
 * gateway the audit silently skipped RunPod even though `RUNPOD_API_KEY` was
 * set. Worse, a *stale* `deployApiKey` from a prior session could be preferred
 * over the env. This prefers the live deploy key only when one is actually set,
 * otherwise falls back to the env var. Pure + exported for unit testing.
 */
export function resolveAuditApiKey(
  deployKey: string | undefined,
  envKey: string | undefined,
): string {
  const dk = (deployKey || '').trim();
  if (dk) return dk;
  return (envKey || '').trim();
}

/**
 * #535 — decide whether a RunPod network volume is tracked (in use) by the
 * gateway, preferring provider attachment metadata over a brittle name match.
 *
 * The old logic flagged a volume as "tracked" only when its *name* contained
 * the active/standby podId — so volumes named after the image (the common case)
 * were mis-flagged as orphans and could be auto-deleted under
 * `RUNPOD_VOLUME_SWEEP_DESTROY=1`. This first trusts an explicit attachment
 * signal (a non-empty list of attached pod IDs, or an `inUse`/`attached` flag),
 * and only falls back to the name-substring heuristic when no attachment info
 * is available. Pure + exported for unit testing.
 */
export function isVolumeTracked(opts: {
  name?: string;
  /** Pod IDs the provider reports as attached to this volume, if known. */
  attachedPodIds?: string[];
  /** Provider attachment flag, if the API exposes one. */
  inUse?: boolean;
  activePodId?: string;
  standbyPodId?: string;
}): boolean {
  // 1) Trust explicit provider attachment metadata when present.
  if (Array.isArray(opts.attachedPodIds) && opts.attachedPodIds.some(Boolean)) return true;
  if (opts.inUse === true) return true;

  // 2) Fall back to the (conservative) name-substring heuristic. Guard against
  //    empty-string match — ''.includes('') is true.
  const name = opts.name || '';
  if (!name) return false;
  const active = (opts.activePodId || '').trim();
  const standby = (opts.standbyPodId || '').trim();
  return (
    (active.length > 0 && name.includes(active)) ||
    (standby.length > 0 && name.includes(standby))
  );
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

/** #534 — RunPod network-volume rate (USD/GB/month). Was a hardcoded literal
 *  that drifts as RunPod changes pricing; surface it as config so operators can
 *  re-validate against the current rate without a code change. Falls back to the
 *  documented ~$0.10/GB/mo default when unset/invalid. */
const RUNPOD_VOLUME_USD_PER_GB_MONTH = (() => {
  const n = Number(process.env.RUNPOD_VOLUME_USD_PER_GB_MONTH);
  return Number.isFinite(n) && n > 0 ? n : 0.10;
})();

/** #534 — estimate a RunPod network volume's monthly cost from its size (GB). */
export function estRunpodVolumeMonthlyUsd(sizeGb: number): number {
  const gb = Number.isFinite(sizeGb) && sizeGb > 0 ? sizeGb : 0;
  return Math.round(gb * RUNPOD_VOLUME_USD_PER_GB_MONTH * 100) / 100;
}
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

/** #536 — statuses across providers that mean "stopped but still billing storage". */
const STOPPED_POD_STATUSES = new Set(['exited', 'stopped', 'shutoff', 'hibernated', 'paused', 'suspended']);

/**
 * #536 — is this instance status a stopped/hibernated state that still accrues
 * storage (or reserved-IP) cost? Normalizes case. Pure + exported for testing.
 */
export function isStoppedPodStatus(status: string | undefined): boolean {
  return STOPPED_POD_STATUSES.has((status ?? '').toLowerCase());
}

/**
 * #536 — pull a disk size (GB) off a provider instance regardless of whether
 * the provider returns it as a top-level field or nested under providerMeta.
 * Returns undefined when unknown so {@link estStoppedPodMonthlyUsd} applies its
 * default. Pure + exported for testing.
 */
export function instanceDiskGb(inst: Record<string, unknown>): number | undefined {
  const top = inst.diskGb;
  if (typeof top === 'number' && top > 0) return top;
  const meta = inst.providerMeta as Record<string, unknown> | undefined;
  const nested = meta?.diskGb;
  if (typeof nested === 'number' && nested > 0) return nested;
  return undefined;
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
  // #110: prefer the live deploy key only when set, else always fall back to
  // the env var so an idle gateway still audits RunPod.
  const rpKey = resolveAuditApiKey(deployApiKey, process.env.RUNPOD_API_KEY);
  if (rpKey) {
    try {
      const volumes = await runpod.listNetworkVolumes({ apiKey: rpKey });
      for (const v of volumes) {
        const est = estRunpodVolumeMonthlyUsd(v.size);
        // #535: prefer provider attachment metadata (when the API exposes it)
        // over the brittle name-substring heuristic so image-named volumes
        // aren't mis-flagged as orphans (and possibly auto-deleted).
        const vv = v as Record<string, unknown>;
        const tracked = isVolumeTracked({
          name: v.name,
          attachedPodIds: Array.isArray(vv.attachedPodIds) ? vv.attachedPodIds as string[] : undefined,
          inUse: typeof vv.inUse === 'boolean' ? vv.inUse : (typeof vv.attached === 'boolean' ? vv.attached : undefined),
          activePodId: deployState.podId || '',
          standbyPodId: standbyDeployState.podId || '',
        });
        const audit: VolumeAudit = {
          id: v.id,
          name: v.name,
          sizeGb: v.size,
          dataCenterId: v.dataCenterId,
          tracked,
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
  const vastKey = resolveAuditApiKey(undefined, process.env.VAST_API_KEY);
  if (vastKey) {
    try {
      const vastInstances = await vast.listInstances({ apiKey: vastKey });
      for (const inst of vastInstances) {
        const st = (inst.status ?? '').toLowerCase();
        if (isStoppedPodStatus(st) && !tracked.has(inst.instanceId)) {
          const est = estStoppedPodMonthlyUsd(instanceDiskGb(inst as unknown as Record<string, unknown>));
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

  // ── #109/#536: TensorDock stopped instances also keep paying for storage ──
  const tdKey = resolveAuditApiKey(undefined, process.env.TENSORDOCK_API_KEY);
  const tdAuth = process.env.TENSORDOCK_AUTH_ID || '';
  if (tdKey) {
    try {
      const tdInstances = await tensordock.listInstances({ apiKey: tdKey, authId: tdAuth });
      for (const inst of tdInstances) {
        const st = (inst.status ?? '').toLowerCase();
        if (isStoppedPodStatus(st) && !tracked.has(inst.instanceId)) {
          const est = estStoppedPodMonthlyUsd(instanceDiskGb(inst as unknown as Record<string, unknown>));
          report.stoppedPods.push({
            provider: 'tensordock',
            instanceId: inst.instanceId,
            status: st,
            gpuType: inst.gpuType,
            estMonthlyUsd: est,
          });
          report.stoppedPodsMonthlyUsd += est;
        }
      }
    } catch (err) {
      report.warnings.push(`tensordock stopped-pod list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── #109/#536: Hyperstack hibernated/shutoff VMs keep billing IP+disk ──
  const hsKey = resolveAuditApiKey(undefined, process.env.HYPERSTACK_API_KEY);
  if (hsKey) {
    try {
      const hsInstances = await hyperstack.listInstances({ apiKey: hsKey });
      for (const inst of hsInstances) {
        const st = (inst.status ?? '').toLowerCase();
        if (isStoppedPodStatus(st) && !tracked.has(inst.instanceId)) {
          const est = estStoppedPodMonthlyUsd(instanceDiskGb(inst as unknown as Record<string, unknown>));
          report.stoppedPods.push({
            provider: 'hyperstack',
            instanceId: inst.instanceId,
            status: st,
            gpuType: inst.gpuType,
            estMonthlyUsd: est,
          });
          report.stoppedPodsMonthlyUsd += est;
        }
      }
    } catch (err) {
      report.warnings.push(`hyperstack stopped-pod list failed: ${err instanceof Error ? err.message : err}`);
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
