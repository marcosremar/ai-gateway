import type { ChainReport } from '../config/stage-chains';

export interface OpsAlert { event: string; data: Record<string, unknown> }

export const OPS_ALERT_DEDUP_MS = 30 * 60_000;

const RESERVE_DOWN = new Set(['no_key', 'missing', 'pending', 'disabled', 'blocked']);

export function createOpsAlerts(send: (alert: OpsAlert) => unknown, now: () => number = Date.now, dedupMs = OPS_ALERT_DEDUP_MS) {
  const sentAt = new Map<string, number>();
  let chainsDown = new Set<string>();
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
      if (msg === 'deployments: create failed' || msg === 'deployments: boot failed on the provider') {
        const error = String(data.error ?? '');
        if (/insufficient_credit|insufficient credit|not enough credit/i.test(error)) fire('provider.insufficient_credit', 'vast', { deployment, error });
        else if (/out_of_stock|out of stock/i.test(error)) fire('deployment.out_of_stock', deployment, { deployment, error });
        else fire('deployment.create_failed', deployment, { deployment, error });
        return;
      }
      if ((msg === 'deployments: releasing replica' || msg === 'deployments: replica gone') && Number(data.busy) > 0) {
        fire('replica.lost_with_sessions', String(data.id ?? ''), { deployment, id: data.id, reason: data.reason ?? 'gone', busy: data.busy });
      }
    },
    fromChains(stages: Record<string, Record<string, ChainReport>>): void {
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
      for (const [key, alert] of down) if (!chainsDown.has(key)) fire(alert.event, key, alert.data);
      chainsDown = new Set(down.keys());
    },
  };
}
