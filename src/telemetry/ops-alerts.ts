import type { ChainReport } from '../config/stage-chains';
import { activeWindow, classWindowOpen } from '../deployments/autoscale';
import type { DeploymentView } from '../deployments/types';
import { idleGpu } from '../deployments/idle';
import type { FallbackProbeResult } from './fallback-probe';
import type { LatencyReport } from './query';

export interface OpsAlert { event: string; data: Record<string, unknown> }

export const OPS_ALERT_DEDUP_MS = 30 * 60_000;
export const OPS_ALERT_BOOT_QUIET_MS = 10 * 60_000;
export const GPU_OUTSIDE_WINDOW_MS = 30 * 60_000;
/** Up this long outside its class window, with no class open anywhere and no explicit `warm`, a GPU is parked (12/10/2026). */
export const GPU_OUTSIDE_WINDOW_PARK_MS = 60 * 60_000;
export const TURN_P95_LIMIT_MS = 3_000;
export const TURN_P95_MIN_TURNS = 10;
const TURN_EVENTS = ['turn.first_audio', 's2s.first_audio'];

const RESERVE_DOWN = new Set(['no_key', 'missing', 'pending', 'disabled', 'blocked']);

export function createOpsAlerts(
  send: (alert: OpsAlert) => unknown, now: () => number = Date.now, dedupMs = OPS_ALERT_DEDUP_MS, bootQuietMs = OPS_ALERT_BOOT_QUIET_MS,
) {
  const bootedAt = now();
  const sentAt = new Map<string, number>();
  let chainsDown = new Set<string>();
  const outsideSince = new Map<string, number>();
  const fire = (event: string, key: string, data: Record<string, unknown>) => {
    const id = `${event}|${key}`;
    const t = now();
    if (t - (sentAt.get(id) ?? -Infinity) < dedupMs) return;
    sentAt.set(id, t);
    void Promise.resolve().then(() => send({ event, data: { ...data, at: new Date(t).toISOString() } })).catch(() => {});
  };

  return {
    fromDeploymentLog(msg: string, data: Record<string, unknown> = {}): void {
      const deployment = String(data.deployment ?? '');
      if (msg === 'deployments: provider credit exhausted') {
        fire('provider.credit_exhausted', String(data.provider ?? ''), data);
        return;
      }
      if (msg === 'deployments: create failed' || msg === 'deployments: boot failed on the provider') {
        const error = String(data.error ?? '');
        if (/insufficient_credit|insufficient credit|not enough credit/i.test(error)) fire('provider.credit_exhausted', 'vast', { provider: 'vast', deployment, error });
        else if (/out_of_stock|out of stock/i.test(error)) fire('deployment.out_of_stock', deployment, { deployment, error });
        else fire('deployment.create_failed', deployment, { deployment, error });
        return;
      }
      if ((msg === 'deployments: releasing replica' || msg === 'deployments: replica gone') && Number(data.busy) > 0) {
        fire('replica.lost_with_sessions', String(data.id ?? ''), { deployment, id: data.id, reason: data.reason ?? 'gone', busy: data.busy });
      }
    },
    /** Alerts on GPUs up outside their class window; returns the ones to park now (the caller parks and logs them). */
    fromDeployments(views: Array<Pick<DeploymentView, 'name' | 'replicas' | 'spec'> & Partial<Pick<DeploymentView, 'lastRequestAt' | 'warm' | 'hold'>>>): string[] {
      const t = now();
      const outside = new Set<string>();
      const toPark: string[] = [];
      const anyClass = classWindowOpen(views, t);
      for (const view of views) {
        const idle = idleGpu({ ...view, lastRequestAt: view.lastRequestAt ?? null }, t);
        if (idle) {
          fire('gpu.idle', view.name, {
            deployment: view.name, minutes: Math.round(idle.minutes), eurPerHour: idle.eurPerHour, wastedEur: Math.round(idle.wastedEur * 100) / 100,
          });
        }
        const up = view.replicas.filter(r => r.phase !== 'halted');
        if (!view.spec.warmSchedule?.length || !up.length || activeWindow(view.spec.warmSchedule, t)) continue;
        outside.add(view.name);
        const since = outsideSince.get(view.name) ?? t;
        outsideSince.set(view.name, since);
        if (t - since < GPU_OUTSIDE_WINDOW_MS) continue;
        fire('gpu.outside_window', view.name, {
          deployment: view.name, replicas: up.length, minutes: Math.round((t - since) / 60_000),
          eurPerHour: up.reduce((sum, r) => sum + (r.pricePerHour ?? 0), 0),
        });
        if (t - since < GPU_OUTSIDE_WINDOW_PARK_MS || anyClass || view.warm) continue;
        toPark.push(view.name);
        outsideSince.set(view.name, t);
      }
      for (const name of outsideSince.keys()) if (!outside.has(name)) outsideSince.delete(name);
      return toPark;
    },
    fromLatency(report: LatencyReport | null): void {
      for (const event of TURN_EVENTS) {
        const stat = report?.events[event];
        if (!stat || stat.count < TURN_P95_MIN_TURNS || stat.p95Ms === null || stat.p95Ms <= TURN_P95_LIMIT_MS) continue;
        fire('turn.slow', event, { stage: event, p95Ms: stat.p95Ms, p50Ms: stat.p50Ms, turns: stat.count, windowSeconds: report!.windowSeconds });
      }
    },
    /** Cloud fallbacks that failed their probe (`fallback-probe.ts`): one grouped alert; a 402 is also a credit alert. */
    fromFallbackProbes(results: FallbackProbeResult[]): void {
      const failing = results.filter(r => !r.ok);
      for (const r of failing) {
        if (r.code === 'credit') fire('provider.credit_exhausted', r.providerId, { provider: r.providerId, target: r.target, error: r.error });
      }
      if (!failing.length) return;
      fire('fallback.probe_failed', failing.map(r => `${r.stage}|${r.target}|${r.voice ?? ''}`).sort().join(','), {
        stage: [...new Set(failing.map(r => r.stage))].join(', '),
        count: failing.length,
        items: failing.map(r => `${r.stage} ${r.target}${r.voice ? ` (${r.voice})` : ''} [${r.aliases.join(', ')}]: (${r.code}) ${r.error ?? ''}`.trim()).join('; '),
      });
    },
    fromChains(stages: Record<string, Record<string, ChainReport>>): void {
      if (now() - bootedAt < bootQuietMs) return;
      const down = new Map<string, OpsAlert>();
      for (const [stage, byModel] of Object.entries(stages)) {
        for (const [model, report] of Object.entries(byModel)) {
          if (!report.serving) down.set(`stage.no_link|${stage}|${model}`, { event: 'stage.no_link', data: { stage, model, links: report.links } });
          for (const link of report.links.slice(1)) {
            if (!RESERVE_DOWN.has(link.state)) continue;
            down.set(`stage.reserve_down|${stage}|${model}|${link.target}`, {
              event: 'stage.reserve_down', data: { stage, model, target: link.target, state: link.state, reason: link.reason ?? null },
            });
          }
        }
      }
      const fresh = new Map<string, Array<[string, OpsAlert]>>();
      for (const [key, alert] of down) if (!chainsDown.has(key)) fresh.set(alert.event, [...(fresh.get(alert.event) ?? []), [key, alert]]);
      for (const [event, items] of fresh) {
        if (items.length === 1) fire(event, items[0][0], items[0][1].data);
        else fire(event, items.map(([key]) => key).sort().join(','), groupedData(items.map(([, alert]) => alert.data)));
      }
      chainsDown = new Set(down.keys());
    },
  };
}

function groupedData(items: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    stage: [...new Set(items.map(d => String(d.stage)))].join(', '),
    count: items.length,
    items: items.map(d => [d.stage, d.model, d.target, d.state].filter(Boolean).join(' ')).join('; '),
  };
}
