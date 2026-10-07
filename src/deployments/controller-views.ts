/**
 * DeploymentController, part 6 of 7 — what callers see: deployment views (secrets stripped), the stored spec for
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

  /**
   * The replica `id` as the controller lists it: its deployment, that deployment's replica token and owning app — for
   * in-process verification of what a replica signs (edge telemetry, src/telemetry/auth.ts). Never sent over HTTP.
   */
  replicaAuth(id: string): { deployment: string; replicaToken: string; app?: string } | null {
    const machine = this.machines.find(m => m.id === id);
    const rt = machine ? this.deployments.get(machine.deployment) : undefined;
    if (!machine || !rt) return null;
    return { deployment: machine.deployment, replicaToken: rt.record.replicaToken, ...(rt.record.app ? { app: rt.record.app } : {}) };
  }

  pendingNetworkReleases(): Array<{ deployment: string; ip: string; zone: string; since: string; attempts: number; lastError: string | null }> {
    return [...this.networkReleases.values()].map(p => ({
      deployment: p.deployment, ip: p.network.ip, zone: p.network.zone, since: new Date(p.since).toISOString(),
      attempts: p.attempts, lastError: p.lastError,
    }));
  }

  /**
   * Counts plus the bill: what runs now, the € ceiling and the stopped replicas against their own cap. With `app`, only
   * that app's deployments are counted and the provider list error is withheld: an app key must not read the other
   * apps' replicas or the namespace's € burn (live QA 2026-10-07: `GET /v1/deployments` with an app key showed the whole
   * namespace in `health`). The caps are the gateway's limits, the same for everyone, and stay.
   */
  health(app?: string): {
    deployments: number; replicas: number; listError: string | null;
    running: number; maxReplicas: number; stopped: number; maxStopped: number; eurPerHour: number; maxEurPerHour: number;
  } {
    const limits = {
      maxReplicas: this.opts.maxTotalReplicas ?? 6, maxStopped: this.opts.maxStoppedReplicas ?? DEFAULT_MAX_STOPPED,
      maxEurPerHour: this.opts.maxEurPerHour ?? DEFAULT_MAX_EUR_PER_HOUR,
    };
    if (app === undefined) {
      return {
        deployments: this.deployments.size, replicas: this.machines.length, listError: this.lastListError,
        running: this.runningMachines().length, stopped: this.stoppedCount(), eurPerHour: round3(this.burnEurPerHour()), ...limits,
      };
    }
    const own = new Set([...this.deployments].filter(([, rt]) => rt.record.app === app).map(([name]) => name));
    const mine = (m: { deployment: string }) => own.has(m.deployment);
    const running = this.runningMachines().filter(mine);
    return {
      deployments: own.size, replicas: this.machines.filter(mine).length, listError: null,
      running: running.length,
      stopped: this.machines.filter(m => mine(m) && ((this.parkedNow(m) && !this.isStarting(m)) || this.stoppingNow(m))).length,
      eurPerHour: round3(running.reduce((sum, m) => sum + (m.pricePerHour ?? 0), 0)), ...limits,
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
      busy: this.probes.get(m.id)?.busy === true,
      draining: this.draining.has(m.id),
      stagesOut: this.stagesOut(m.id),
      rttMs: this.gates.get(m.id)?.rttMs ?? null,
      expiresInMinutes: m.expiresAt != null ? Math.round((m.expiresAt - now) / 60_000) : null,
    }));
    const ready = replicas.filter(r => r.phase === 'ready').length;
    // The last tick's decision when there is one (pressure and floors included), else the base rules.
    const desired = Math.max(rt.autoscale.desired, planReplicas({
      spec: rt.record.spec, replicas: [], inflight: rt.inflight, waiting: rt.waiting,
      lastRequestAt: rt.record.lastRequestAt, aboveSince: null, now,
    }).desired);
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
      autoscale: { ...rt.autoscale },
      warm: rt.record.warm && rt.record.warm.until > now
        ? { replicas: rt.record.warm.replicas, until: new Date(rt.record.warm.until).toISOString() } : null,
    };
  }
}
