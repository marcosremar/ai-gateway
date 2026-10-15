/**
 * GPU status of an app with a profile (`AppProfile`, apps.ts) — `GET /v1/apps/:app/status`.
 *
 * Who served each request of a `requiresGpu` app is recorded from the proxy's origin headers (`X-Gateway-Provider`):
 * a cloud answer still answers (hard rule 4) but gets `X-Gateway-Status: degraded`, and the start of every cloud run of a
 * stage is logged and emitted (`app.degraded`). The profile's deployments are probed by `GpuProbe` (gpu-probe.ts).
 *
 *   mode "gpu"      every profile deployment has a ready replica whose last probe passed, and no stage is served by the cloud
 *   mode "degraded" anything else that still answers (a stage on the cloud fallback, or a GPU not ready / failing)
 *   mode "down"     the GPU is not serving and the cloud reserve does not answer either (a request of the app failed with
 *                   nothing served, or every probed cloud link of one of its stages failed: telemetry/fallback-probe.ts)
 */

import type { ModelRoutesSpec } from '../config/serve-providers';
import type { AppRegistry } from './apps';
import type { DeploymentController } from './controller';
import { GpuProbe, servedStages, type GpuStage, type ProbeRound, type StageTarget } from './gpu-probe';
import type { DeploymentView } from './types';

/** A stage counts as "served by the cloud" while its latest request (cloud) is younger than this: class turns come every 10–60 s. */
export const FALLBACK_ACTIVE_MS = 5 * 60_000;
export const DEGRADED_HEADER = 'X-Gateway-Status';

export type AppMode = 'gpu' | 'degraded' | 'down';
export type DeploymentState = 'ready' | 'booting' | 'stopped' | 'failing';
type Outcome = 'gpu' | 'cloud' | 'failed';
type CloudLink = { stage: 'chat' | 'stt' | 'tts'; aliases: string[]; ok: boolean };

export interface AppStatus {
  app: string;
  requiresGpu: boolean;
  mode: AppMode;
  checkedAt: string;
  deployments: Array<{
    name: string;
    stages: GpuStage[];
    state: DeploymentState;
    replicas: { ready: number; total: number };
    lastProbe: { at: string; ok: boolean; ms: number; error: string | null } | null;
  }>;
  fallback: { active: boolean; since: string | null; last: { at: string; stage: GpuStage; served: string } | null };
}

const STAGE_OF_KIND: Record<string, GpuStage | undefined> = { stt: 'stt', chat: 'llm', tts: 'tts' };
const ROUTE_STAGE: Record<GpuStage, 'stt' | 'chat' | 'tts'> = { stt: 'stt', llm: 'chat', tts: 'tts' };

export function appMode(s: { gpuReady: boolean; cloudServing: boolean; reserveDown: boolean }): AppMode {
  if (s.gpuReady && !s.cloudServing) return 'gpu';
  return !s.gpuReady && s.reserveDown ? 'down' : 'degraded';
}

function deploymentState(view: DeploymentView | null, failing: (replicaId: string) => boolean): DeploymentState {
  const replicas = view?.replicas ?? [];
  const ready = replicas.filter(r => r.phase === 'ready');
  if (ready.some(r => !failing(r.id))) return 'ready';
  if (ready.length || replicas.some(r => r.phase === 'unhealthy')) return 'failing';
  return replicas.some(r => r.phase === 'booting') || view?.status === 'warming' ? 'booting' : 'stopped';
}

const iso = (ms: number) => new Date(ms).toISOString();
const probeView = (r: ProbeRound | null) => (r ? { at: iso(r.at), ok: r.ok, ms: r.ms, error: r.error } : null);

export interface AppGpuHealthOptions {
  controller: Pick<DeploymentController, 'get' | 'tokenOf' | 'holdStageOut'>;
  apps: Pick<AppRegistry, 'get' | 'list'>;
  /** The cloud links' last probe (fallback-probe.ts snapshot), for "down" while no request comes. */
  cloudLinks?: () => CloudLink[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  onDegraded?: (event: { app: string; stage: GpuStage; served: string; from: string | null }) => void;
}

export class AppGpuHealth {
  readonly probe: GpuProbe;
  private readonly stages = new Map<string, Map<GpuStage, { outcome: Outcome; at: number; cloudSince: number | null }>>();
  private readonly lastCloud = new Map<string, { at: number; stage: GpuStage; served: string }>();
  private readonly now: () => number;

  constructor(private readonly opts: AppGpuHealthOptions) {
    this.now = opts.now ?? Date.now;
    this.probe = new GpuProbe({
      controller: opts.controller, targets: () => this.targets(), now: this.now,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), ...(opts.log ? { log: opts.log } : {}),
    });
  }

  private stagesOf(routes: ModelRoutesSpec | undefined, deployment: string) {
    return servedStages(routes, deployment, name => Boolean(this.opts.controller.get(name)));
  }

  /** Every deployment of every profile, once, with the stages its apps' routes send it. */
  targets(): Array<{ deployment: string; stages: StageTarget[] }> {
    const byDeployment = new Map<string, Map<GpuStage, StageTarget>>();
    for (const { id } of this.opts.apps.list()) {
      const account = this.opts.apps.get(id);
      for (const name of account?.profile?.gpuDeployments ?? []) {
        const stages = byDeployment.get(name) ?? new Map();
        for (const t of this.stagesOf(account?.routes, name)) if (!stages.has(t.stage)) stages.set(t.stage, t);
        byDeployment.set(name, stages);
      }
    }
    return [...byDeployment].map(([deployment, stages]) => ({ deployment, stages: [...stages.values()] }));
  }

  /** The proxy answered an inference request of `app`: returns the headers to add (a cloud answer to a GPU app is degraded). */
  served(app: string, kind: string, status: number, headers: Record<string, string> | undefined): Record<string, string> | undefined {
    const stage = STAGE_OF_KIND[kind];
    if (!stage || !this.opts.apps.get(app)?.profile?.requiresGpu) return undefined;
    const provider = headers?.['X-Gateway-Provider'];
    const outcome: Outcome | null = provider && provider !== 'cache' ? (provider.startsWith('deployment:') ? 'gpu' : 'cloud')
      : !provider && status >= 500 ? 'failed' : null;
    if (!outcome) return undefined;
    const now = this.now();
    const byStage = this.stages.get(app) ?? new Map();
    this.stages.set(app, byStage);
    const prev = byStage.get(stage);
    const cloudSince = outcome !== 'cloud' ? null : prev?.outcome === 'cloud' && now - prev.at < FALLBACK_ACTIVE_MS ? prev.cloudSince : now;
    byStage.set(stage, { outcome, at: now, cloudSince });
    if (outcome !== 'cloud') return undefined;
    this.lastCloud.set(app, { at: now, stage, served: provider! });
    if (cloudSince === now) {
      const from = headers?.['X-Gateway-Fallback-From'] ?? null;
      this.opts.log?.('app on the cloud fallback although it requires its GPU', { app, stage, served: provider, from, reason: headers?.['X-Gateway-Fallback'] ?? null });
      this.opts.onDegraded?.({ app, stage, served: provider!, from });
    }
    return { [DEGRADED_HEADER]: 'degraded' };
  }

  private recent(app: string, outcome: Outcome): Array<{ stage: GpuStage; at: number; cloudSince: number | null }> {
    const now = this.now();
    return [...(this.stages.get(app) ?? [])]
      .filter(([, s]) => s.outcome === outcome && now - s.at < FALLBACK_ACTIVE_MS)
      .map(([stage, s]) => ({ stage, at: s.at, cloudSince: s.cloudSince }));
  }

  private reserveDown(app: string, routes: ModelRoutesSpec | undefined, stages: GpuStage[]): boolean {
    if (this.recent(app, 'failed').length) return true;
    const links = this.opts.cloudLinks?.() ?? [];
    return stages.some((stage) => {
      const aliases = new Set(Object.keys(routes?.[ROUTE_STAGE[stage]] ?? {}));
      const mine = links.filter(l => l.stage === ROUTE_STAGE[stage] && l.aliases.some(a => aliases.has(a)));
      return mine.length > 0 && mine.every(l => !l.ok);
    });
  }

  /** Null when the app has no profile. */
  status(app: string): AppStatus | null {
    const account = this.opts.apps.get(app);
    if (!account?.profile) return null;
    const { profile, routes } = account;
    const deployments = profile.gpuDeployments.map((name) => {
      const view = this.opts.controller.get(name);
      const replicas = (view?.replicas ?? []).filter(r => r.phase !== 'halted');
      const ready = replicas.filter(r => r.phase === 'ready' && !this.probe.failing(r.id));
      const latest = (view?.replicas ?? []).map(r => this.probe.round(r.id)).filter((r): r is ProbeRound => r !== null);
      const lastProbe = latest.filter(r => !r.ok).sort((a, b) => b.at - a.at)[0] ?? this.probe.lastRound(name);
      return {
        name, stages: this.stagesOf(routes, name).map(t => t.stage), state: deploymentState(view, id => this.probe.failing(id)),
        replicas: { ready: ready.length, total: replicas.length }, lastProbe: probeView(lastProbe),
      };
    });
    const gpuReady = deployments.every(d => d.state === 'ready' && d.lastProbe?.ok === true);
    const cloud = profile.requiresGpu ? this.recent(app, 'cloud') : [];
    const since = cloud.length ? Math.min(...cloud.map(c => c.cloudSince ?? c.at)) : null;
    const last = this.lastCloud.get(app);
    return {
      app, requiresGpu: profile.requiresGpu,
      mode: appMode({ gpuReady, cloudServing: cloud.length > 0, reserveDown: this.reserveDown(app, routes, deployments.flatMap(d => d.stages)) }),
      checkedAt: iso(this.now()),
      deployments,
      fallback: { active: cloud.length > 0, since: since === null ? null : iso(since), last: last ? { at: iso(last.at), stage: last.stage, served: last.served } : null },
    };
  }
}
