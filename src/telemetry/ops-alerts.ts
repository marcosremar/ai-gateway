import type { ChainReport } from '../config/stage-chains';
import { activeWindow, classWindowOpen } from '../deployments/autoscale';
import { accountRefusal } from '../deployments/placements';
import type { DeploymentView } from '../deployments/types';
import { idleGpu } from '../deployments/idle';
import type { FallbackProbeResult } from './fallback-probe';
import type { LatencyReport } from './query';
import { alarming, turnStats, VOICE_TURN_ALERT, type VoiceTurn } from '../app-telemetry/voice-turn';

export interface OpsAlert { event: string; key?: string; data: Record<string, unknown> }

export interface IncidentTrack {
  seen(alert: OpsAlert, sent: boolean): unknown;
  clear(event: string, active: Set<string>): void;
}

export const OPS_ALERT_DEDUP_MS = 30 * 60_000;
export const OPS_ALERT_BOOT_QUIET_MS = 10 * 60_000;
export const GPU_OUTSIDE_WINDOW_MS = 30 * 60_000;
/** Up this long outside its class window, with no class open anywhere and no explicit `warm`, a GPU is parked (12/10/2026). */
export const GPU_OUTSIDE_WINDOW_PARK_MS = 60 * 60_000;
export const ACCOUNT_REFUSED_REPEAT_MS = 60 * 60_000;
export const CLASS_GPU_READY_MS = 20 * 60_000;
export const TURN_P95_LIMIT_MS = 3_000;
export const TURN_P95_MIN_TURNS = 10;
const TURN_EVENTS = ['turn.first_audio', 's2s.first_audio'];

const RESERVE_DOWN = new Set(['no_key', 'missing', 'pending', 'disabled', 'blocked']);

export function createOpsAlerts(
  send: (alert: OpsAlert) => unknown, now: () => number = Date.now, dedupMs = OPS_ALERT_DEDUP_MS, bootQuietMs = OPS_ALERT_BOOT_QUIET_MS,
  track?: IncidentTrack,
) {
  const bootedAt = now();
  const sentAt = new Map<string, number>();
  let chainsDown = new Set<string>();
  const outsideSince = new Map<string, number>();
  const fire = (event: string, key: string, data: Record<string, unknown>, repeatMs = dedupMs) => {
    const id = `${event}|${key}`;
    const t = now();
    const alert = { event, key, data: { ...data, at: new Date(t).toISOString() } };
    const due = t - (sentAt.get(id) ?? -Infinity) >= repeatMs;
    track?.seen(alert, due);
    if (!due) return;
    sentAt.set(id, t);
    void Promise.resolve().then(() => send(alert)).catch(() => {});
  };

  return {
    fromDeploymentLog(msg: string, data: Record<string, unknown> = {}): void {
      const deployment = String(data.deployment ?? '');
      if (msg === 'deployments: provider credit exhausted') {
        fire('provider.credit_exhausted', String(data.provider ?? ''), data);
        return;
      }
      if (msg === 'deployments: provider account refused') {
        const provider = String(data.provider ?? '');
        const next = typeof data.next === 'string' ? `usando a ${providerName(data.next)}` : `nenhum outro provedor para ${deployment}`;
        const headline = `a ${providerName(provider)} recusou criar servidor: ${String(data.reason)} — não se resolve sozinho: ${String(data.fix)}; ${next}`;
        const facts = { provider, deployment, headline, status: data.status ?? null, error: data.error };
        if (/crédito/.test(String(data.reason))) fire('provider.credit_exhausted', provider, facts);
        else fire('provider.account_refused', provider, facts, ACCOUNT_REFUSED_REPEAT_MS);
        return;
      }
      if (msg === 'janitor: sweep failed' || msg === 'janitor: delete failed') {
        const error = String(data.error ?? '');
        const refused = accountRefusal(new Error(error));
        if (!refused) return;
        const headline = `a Scaleway recusou a limpeza do gateway (janitor): ${refused.reason} — não se resolve sozinho: ${refused.fix}`;
        fire('provider.account_refused', 'scaleway', { provider: 'scaleway', job: 'janitor', headline, status: refused.status, error }, ACCOUNT_REFUSED_REPEAT_MS);
        return;
      }
      if (msg === 'deployments: create failed' || msg === 'deployments: boot failed on the provider') {
        const error = String(data.error ?? '');
        const refused = accountRefusal(new Error(error));
        if (/insufficient_credit|insufficient credit|not enough credit/i.test(error)) fire('provider.credit_exhausted', 'vast', { provider: 'vast', deployment, error });
        else if (refused) {
          const provider = /\b(scaleway|vast)\b/i.exec(error)?.[1].toLowerCase() ?? 'provedor';
          const headline = `a ${providerName(provider)} recusou criar servidor para ${deployment}: ${refused.reason} — não se resolve sozinho: ${refused.fix}`;
          fire('provider.account_refused', provider, { provider, deployment, headline, status: refused.status, error }, ACCOUNT_REFUSED_REPEAT_MS);
        } else if (/out_of_stock|out of stock/i.test(error)) fire('deployment.out_of_stock', deployment, { deployment, error });
        else fire('deployment.create_failed', deployment, { deployment, error });
        return;
      }
      if (msg === 'deployments: stuck boot retries exhausted') {
        fire('deployment.stuck_boot', deployment, { deployment, id: data.id, phase: data.phase, minutes: data.minutes, attempts: data.attempts });
        return;
      }
      if ((msg === 'deployments: releasing replica' || msg === 'deployments: replica gone') && Number(data.busy) > 0) {
        fire('replica.lost_with_sessions', String(data.id ?? ''), { deployment, id: data.id, reason: data.reason ?? 'gone', busy: data.busy });
      }
    },
    /** Alerts on GPUs up outside their class window; returns the ones to park now (the caller parks and logs them). */
    fromDeployments(views: Array<Pick<DeploymentView, 'name' | 'replicas' | 'spec'>
      & Partial<Pick<DeploymentView, 'lastRequestAt' | 'warm' | 'hold' | 'lastError' | 'lastPlacement'>>>): string[] {
      const t = now();
      const outside = new Set<string>();
      const idle = new Set<string>();
      const notReady = new Set<string>();
      const toPark: string[] = [];
      const anyClass = classWindowOpen(views, t);
      for (const view of views) {
        const classOpen = activeWindow(view.spec.warmSchedule, t) && activeWindow(view.spec.warmSchedule, t - CLASS_GPU_READY_MS);
        if (classOpen && !view.spec.paused && !view.replicas.some(r => r.phase === 'ready')) {
          notReady.add(view.name);
          const provider = view.replicas[0]?.provider ?? view.spec.provider ?? 'provedor';
          const error = view.lastError ?? 'nenhum erro registrado';
          fire('class.gpu_not_ready', view.name, {
            deployment: view.name, gpuProvider: provider, replicas: view.replicas.length, error, lastPlacement: view.lastPlacement ?? null,
            headline: `aula: ${view.name} sem GPU pronta 20 min depois de abrir a janela (${providerName(provider)}): ${error.slice(0, 160)}`,
          });
        }
        const idleNow = idleGpu({ ...view, lastRequestAt: view.lastRequestAt ?? null }, t);
        if (idleNow) {
          idle.add(view.name);
          fire('gpu.idle', view.name, {
            deployment: view.name, minutes: Math.round(idleNow.minutes), eurPerHour: idleNow.eurPerHour, wastedEur: Math.round(idleNow.wastedEur * 100) / 100,
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
      track?.clear('gpu.idle', idle);
      track?.clear('class.gpu_not_ready', notReady);
      track?.clear('gpu.outside_window', outside);
      return toPark;
    },
    fromLatency(report: LatencyReport | null): void {
      const slow = new Set<string>();
      for (const event of TURN_EVENTS) {
        const stat = report?.events[event];
        if (!stat || stat.count < TURN_P95_MIN_TURNS || stat.p95Ms === null || stat.p95Ms <= TURN_P95_LIMIT_MS) continue;
        slow.add(event);
        fire('turn.slow', event, { stage: event, p95Ms: stat.p95Ms, p50Ms: stat.p50Ms, turns: stat.count, windowSeconds: report!.windowSeconds });
      }
      track?.clear('turn.slow', slow);
    },
    fromVoiceTurns(turns: readonly VoiceTurn[]): void {
      const t = now();
      const byApp = new Map<string, VoiceTurn[]>();
      const failingApps = new Set<string>();
      const slowApps = new Set<string>();
      for (const turn of turns) {
        if (!turn.classWindow || turn.at <= t - VOICE_TURN_ALERT.windowMs || turn.at > t) continue;
        const list = byApp.get(turn.app) ?? [];
        list.push(turn);
        byApp.set(turn.app, list);
      }
      for (const [app, list] of byApp) {
        const stats = turnStats(list);
        const { failing, slow } = alarming(stats);
        if (!failing && !slow) continue;
        const data = {
          app, turns: stats.turns, failed: stats.failed, failedPct: Math.round((stats.failed / stats.turns) * 1000) / 10, p50Ms: stats.p50Ms, p95Ms: stats.p95Ms,
          failures: stats.failures.slice(0, 3).map(f => `${f.stage}/${f.reason} x${f.count}`).join(', '), windowMinutes: VOICE_TURN_ALERT.windowMs / 60_000,
        };
        if (failing) failingApps.add(app);
        if (slow) slowApps.add(app);
        if (failing) fire('voice.turn_failing', app, data);
        if (slow) fire('voice.turn_slow', app, data);
      }
      track?.clear('voice.turn_failing', failingApps);
      track?.clear('voice.turn_slow', slowApps);
    },
    /** Cloud fallbacks that failed their probe (`fallback-probe.ts`): one grouped alert; a 402 is also a credit alert. */
    fromFallbackProbes(results: FallbackProbeResult[]): void {
      const failing = results.filter(r => !r.ok);
      for (const r of failing) {
        if (r.code === 'credit') fire('provider.credit_exhausted', r.providerId, { provider: r.providerId, target: r.target, error: r.error });
      }
      track?.clear('fallback.probe_failed', new Set(failing.map(r => `${r.stage}|${r.target}|${r.voice ?? ''}`)));
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
      for (const event of ['stage.no_link', 'stage.reserve_down']) track?.clear(event, chainsDown);
    },
  };
}

const providerName = (provider: string) => provider.charAt(0).toUpperCase() + provider.slice(1);

function groupedData(items: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    stage: [...new Set(items.map(d => String(d.stage)))].join(', '),
    count: items.length,
    items: items.map(d => [d.stage, d.model, d.target, d.state].filter(Boolean).join(' ')).join('; '),
  };
}
