/**
 * Orphan guard: deletes a namespace's replicas when the gateway that owns them is gone.
 *
 * The gateway reaps its own machines (idle scale-to-zero, halted replicas, orphans on restart), but only while it runs.
 * A replica's self-shutdown does not bound the bill: a Scaleway instance powered off from inside stays "stopped in place"
 * and keeps billing until it is deleted. So this runs OUTSIDE the gateway process (a Railway cron service, every
 * 15 min, `scripts/reap-orphans.ts`) and deletes machines only when the gateway answered no health check in a row of
 * probes spread over ~2 min — a redeploy or a short blip never costs a live class its machine.
 */

import type { DeploymentBackend, ReplicaMachine } from './types';

type ReapBackend = Pick<DeploymentBackend, 'listReplicas' | 'releaseReplica'> & { provider?: string };

export interface ReaperOptions {
  /** Single backend (kept for callers from before `backends`). */
  backend?: ReapBackend;
  /** Every configured backend (Scaleway, Vast): each is listed and reaped on its own. */
  backends?: ReapBackend[];
  namespace: string;
  /** Resolves true when the gateway's `/health` answered 2xx. */
  gatewayUp: () => Promise<boolean>;
  probes?: number;
  probeIntervalMs?: number;
  /** Machines younger than this are left alone (they may belong to a gateway that is just restarting). */
  minAgeMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface ReapResult {
  gatewayUp: boolean;
  seen: number;
  released: string[];
  failed: string[];
}

export async function reapIfGatewayDown(opts: ReaperOptions): Promise<ReapResult> {
  const probes = opts.probes ?? 4;
  const interval = opts.probeIntervalMs ?? 40_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});
  for (let i = 0; i < probes; i++) {
    if (await opts.gatewayUp().catch(() => false)) return { gatewayUp: true, seen: 0, released: [], failed: [] };
    if (i < probes - 1) await sleep(interval);
  }
  const now = (opts.now ?? Date.now)();
  const minAge = opts.minAgeMs ?? 30 * 60_000;
  const backends = opts.backends ?? (opts.backend ? [opts.backend] : []);
  const released: string[] = [];
  const failed: string[] = [];
  let seen = 0;
  for (const backend of backends) {
    let machines: ReplicaMachine[];
    try {
      machines = await backend.listReplicas(opts.namespace);
    } catch (err) {
      // One provider failing to list must not spare the other provider's machines; the next run retries this one.
      failed.push(`list:${backend.provider ?? 'backend'}`);
      log('reaper: list failed', { provider: backend.provider, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    seen += machines.length;
    const old = machines.filter((m: ReplicaMachine) => now - m.createdAt >= minAge);
    log('reaper: gateway down, releasing replicas', { namespace: opts.namespace, provider: backend.provider, seen: machines.length, releasing: old.length });
    for (const machine of old) {
      try {
        await backend.releaseReplica(machine, 'reaper');
        released.push(machine.id);
      } catch (err) {
        failed.push(machine.id);
        log('reaper: release failed', { id: machine.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { gatewayUp: false, seen, released, failed };
}
