/**
 * DeploymentController, part 5 of 6 — what callers see: deployment views (secrets stripped), the stored spec for
 * in-process callers, and the counts `/health` shows. See controller-state.ts.
 */

import { DEFAULT_MAX_EUR_PER_HOUR, DEFAULT_MAX_STOPPED, round3 } from './controller-state';
import { ReconcileLoop } from './controller-reconcile';
import { planReplicas, replicaPhase } from './planner';
import type { DeploymentSpec, DeploymentView } from './types';

export abstract class ControllerViews extends ReconcileLoop {
  list(): DeploymentView[] {
    return [...this.deployments.keys()].sort().map(n => this.view(n)!);
  }

  get(name: string): DeploymentView | null {
    return this.view(name);
  }

  /** The stored spec, secrets included — for in-process callers only (declared reconcile); never sent over HTTP. */
  specOf(name: string): DeploymentSpec | null {
    const rt = this.deployments.get(name);
    return rt ? structuredClone(rt.record.spec) : null;
  }

  tokenOf(name: string): string | null {
    return this.deployments.get(name)?.record.replicaToken ?? null;
  }

  /** Counts plus the bill: what runs now, the € ceiling and the stopped replicas against their own cap. */
  health(): {
    deployments: number; replicas: number; listError: string | null;
    running: number; maxReplicas: number; stopped: number; maxStopped: number; eurPerHour: number; maxEurPerHour: number;
  } {
    return {
      deployments: this.deployments.size, replicas: this.machines.length, listError: this.lastListError,
      running: this.runningMachines().length, maxReplicas: this.opts.maxTotalReplicas ?? 6,
      stopped: this.stoppedCount(), maxStopped: this.opts.maxStoppedReplicas ?? DEFAULT_MAX_STOPPED,
      eurPerHour: round3(this.burnEurPerHour()), maxEurPerHour: this.opts.maxEurPerHour ?? DEFAULT_MAX_EUR_PER_HOUR,
    };
  }

  protected view(name: string): DeploymentView | null {
    const rt = this.deployments.get(name);
    if (!rt) return null;
    const { env, envByMachineType, registryAuth, bootScript, files, ...publicSpec } = rt.record.spec;
    const now = this.now();
    const replicas = this.machines.filter(m => m.deployment === name).map(m => ({
      id: m.id,
      phase: replicaPhase(this.observed(m, 0)),
      ip: m.ip,
      providerState: m.state,
      zone: m.zone,
      machineType: m.machineType,
      pricePerHour: m.pricePerHour,
      ageSeconds: Math.round((now - m.createdAt) / 1000),
      inflight: rt.perReplica.get(m.id) ?? 0,
      rttMs: this.gates.get(m.id)?.rttMs ?? null,
      expiresInMinutes: m.expiresAt != null ? Math.round((m.expiresAt - now) / 60_000) : null,
    }));
    const ready = replicas.filter(r => r.phase === 'ready').length;
    const desired = planReplicas({
      spec: rt.record.spec, replicas: [], inflight: rt.inflight, waiting: rt.waiting,
      lastRequestAt: rt.record.lastRequestAt, aboveSince: null, now,
    }).desired;
    const status: DeploymentView['status'] = rt.record.spec.paused ? 'paused'
      : replicas.length === 0 && rt.creating === 0 ? 'scaled-to-zero'
        : ready === 0 ? 'warming'
          : ready < desired ? 'degraded' : 'ready';
    return {
      name,
      spec: {
        ...publicSpec, envKeys: Object.keys(env), privateRegistry: Boolean(registryAuth), bootScript: Boolean(bootScript),
        fileKeys: Object.keys(files ?? {}),
      },
      status,
      desiredReplicas: desired,
      replicas,
      inflight: rt.inflight,
      waiting: rt.waiting,
      lastRequestAt: rt.record.lastRequestAt ? new Date(rt.record.lastRequestAt).toISOString() : null,
      lastError: rt.lastError,
      invokeUrl: `/v1/deployments/${name}/invoke/`,
      app: rt.record.app ?? null,
      appImage: rt.record.appImage ?? null,
      publicIp: rt.record.network?.ip ?? null,
      lastPlacement: rt.lastPlacement,
    };
  }
}
