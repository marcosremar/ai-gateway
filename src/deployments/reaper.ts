/**
 * Orphan guard: releases a namespace's machines that no deployment owns, from OUTSIDE the gateway process.
 *
 * The gateway reaps its own machines (idle scale-to-zero, halted replicas, orphans on restart), but only while it runs
 * and only as well as its own bookkeeping. A replica's self-shutdown does not bound the bill: a Scaleway instance powered
 * off from inside stays "stopped in place" and keeps billing until it is deleted, and an exited Vast instance keeps its
 * disk. So this runs as a Railway cron service (every 15 min, `scripts/reap-orphans.ts`), over every provider with a key
 * (Scaleway servers tagged `aigw-ns-<ns>`, Vast instances labelled `aigw:<ns>:<deployment>`), in one of two modes:
 *
 *  - **gateway down** (no `/health` answered in a row of probes spread over ~2 min — a redeploy or a short blip never
 *    costs a live class its machine): every machine of the namespace older than `minAgeMs` is released;
 *  - **gateway up, cross-check** (needs an admin key): the gateway's own `GET /v1/deployments` says which deployments
 *    exist; a machine whose deployment is not among them, older than `graceMs` (default 30 min), is released — a
 *    gateway that forgot a machine (a bug, a lost store, a create that outlived its deployment) no longer bills forever.
 *    Scaleway reserved IPs and security groups tagged for a deployment the gateway does not have, and used by no server,
 *    go too. The namespace's shared gateway-only firewall (no deployment tag, bills nothing) is never touched.
 *
 * Fail safe: a list that fails spares nothing else and releases nothing of its own provider; a deployments answer that
 * is not a full, admin, same-namespace list skips the cross-check (never "nothing exists, release everything").
 * `dryRun` reports what would go and releases nothing.
 */

import type { DeploymentBackend, ReplicaMachine } from './types';

type ReapBackend = Pick<DeploymentBackend, 'listReplicas' | 'releaseReplica' | 'listForeign'> & { provider?: string };
type Log = (msg: string, data?: Record<string, unknown>) => void;

/** A provider network resource tagged for the namespace (Scaleway: reserved IP or security group). */
export interface NetworkResource {
  kind: 'ip' | 'security-group';
  id: string;
  zone: string;
  /** From the `aigw-dep-<name>` tag; null = shared or unknown owner (never released). */
  deployment: string | null;
  /** Attached to a server (IP) or used by at least one server (security group). */
  inUse: boolean;
  /** ms; null when the provider does not say (reserved IPs). */
  createdAt: number | null;
  label: string;
}

export interface NetworkSweeper {
  provider?: string;
  /** Every tagged resource of the namespace; `errors` names the zones/lists that failed (those are skipped). */
  listNetwork(namespace: string): Promise<{ resources: NetworkResource[]; errors: string[] }>;
  releaseNetwork(resource: NetworkResource): Promise<void>;
}

/** What the gateway says it owns, or the reason the cross-check cannot trust its answer. */
export type OwnedDeployments = { names: ReadonlySet<string>; machineTypes?: ReadonlySet<string> } | { skip: string };

export interface ForeignLeftover {
  id: string;
  provider: string;
  namespace: string;
  deployment: string;
  machineType: string;
  zone: string;
  state: string;
  ageHours: number;
  holdsNeededQuota: boolean | null;
}

export interface ReaperOptions {
  /** Single backend (kept for callers from before `backends`). */
  backend?: ReapBackend;
  /** Every configured backend (Scaleway, Vast): each is listed and reaped on its own. */
  backends?: ReapBackend[];
  /** Network leftovers (Scaleway IPs and security groups), swept in the cross-check only. */
  networks?: NetworkSweeper[];
  namespace: string;
  /** Resolves true when the gateway's `/health` answered 2xx. */
  gatewayUp: () => Promise<boolean>;
  /** Gateway up: the deployments it owns (`ownedFromGateway`). Absent = no cross-check (the pre-2026-10-07 behaviour). */
  owned?: () => Promise<OwnedDeployments>;
  probes?: number;
  probeIntervalMs?: number;
  /** Gateway down: machines younger than this are left alone (they may belong to a gateway that is just restarting). */
  minAgeMs?: number;
  /** Gateway up: a machine of no deployment is released once older than this (default 30 min). */
  graceMs?: number;
  /** Report only: nothing is released. */
  dryRun?: boolean;
  foreignGraceMs?: number;
  applyForeign?: boolean;
  foreignMinAgeMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: Log;
}

export interface ReapResult {
  gatewayUp: boolean;
  /** `gateway-down`, `cross-check`, or `none` (gateway up and no cross-check: no admin key, or its answer not trusted). */
  mode: 'gateway-down' | 'cross-check' | 'none';
  dryRun: boolean;
  seen: number;
  /** Released (empty in a dry run). */
  released: string[];
  /** What this run released, or would release in a dry run (`<provider>:<id>`, `scaleway:ip:<zone>/<id>`, …). */
  planned: string[];
  failed: string[];
  /** Why the cross-check did not run (gateway up only). */
  skipped?: string;
  foreign: ForeignLeftover[];
}

export const DEFAULT_REAPER_GRACE_MS = 30 * 60_000;
export const DEFAULT_FOREIGN_MIN_AGE_MS = 6 * 3_600_000;
export const MIN_FOREIGN_MIN_AGE_MS = 3_600_000;
const STOPPED = /stopped|exited/;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function probeGateway(opts: ReaperOptions): Promise<boolean> {
  const probes = opts.probes ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  for (let i = 0; i < probes; i++) {
    if (await opts.gatewayUp().catch(() => false)) return true;
    if (i < probes - 1) await sleep(opts.probeIntervalMs ?? 40_000);
  }
  return false;
}

export async function reapOrphans(opts: ReaperOptions): Promise<ReapResult> {
  const log = opts.log ?? (() => {});
  const dryRun = opts.dryRun === true;
  const empty = { dryRun, seen: 0, released: [] as string[], planned: [] as string[], failed: [] as string[], foreign: [] as ForeignLeftover[] };
  const up = await probeGateway(opts);
  const now = (opts.now ?? Date.now)();
  const backends = opts.backends ?? (opts.backend ? [opts.backend] : []);

  let owned: ReadonlySet<string> | null = null;
  let neededTypes: ReadonlySet<string> | null = null;
  let skipped: string | undefined;
  if (up) {
    const answer: OwnedDeployments = opts.owned
      ? await opts.owned().catch((err): OwnedDeployments => ({ skip: `deployments list failed: ${errText(err)}` }))
      : { skip: 'no admin key: cross-check off' };
    if ('skip' in answer) {
      skipped = answer.skip;
      log('reaper: gateway up, cross-check skipped', { namespace: opts.namespace, reason: skipped });
    } else {
      owned = answer.names;
      neededTypes = answer.machineTypes ?? null;
    }
  }
  const minAge = up ? opts.graceMs ?? DEFAULT_REAPER_GRACE_MS : opts.minAgeMs ?? 30 * 60_000;
  const pick = (m: ReplicaMachine) => !skipped && now - m.createdAt >= minAge && (owned === null || !owned.has(m.deployment));
  const result: ReapResult = { gatewayUp: up, mode: skipped ? 'none' : up ? 'cross-check' : 'gateway-down', ...empty, ...(skipped ? { skipped } : {}) };
  for (const backend of backends) await reapBackend(backend, opts.namespace, pick, result, log);
  if (owned) await sweepNetworks(opts, owned, now, result, log);
  for (const backend of backends) await reportForeign(backend, opts, neededTypes, now, result, log);
  return result;
}

async function reportForeign(
  backend: ReapBackend, opts: ReaperOptions, neededTypes: ReadonlySet<string> | null, now: number, result: ReapResult, log: Log,
): Promise<void> {
  if (!backend.listForeign) return;
  const provider = backend.provider ?? 'backend';
  let machines: Awaited<ReturnType<NonNullable<ReapBackend['listForeign']>>>;
  try {
    machines = await backend.listForeign(opts.namespace);
  } catch (err) {
    result.failed.push(`list-foreign:${provider}`);
    log('reaper: foreign list failed', { provider, error: errText(err) });
    return;
  }
  const grace = opts.foreignGraceMs ?? opts.graceMs ?? DEFAULT_REAPER_GRACE_MS;
  const minAge = Math.max(MIN_FOREIGN_MIN_AGE_MS, opts.foreignMinAgeMs ?? DEFAULT_FOREIGN_MIN_AGE_MS);
  for (const m of machines) {
    const age = now - m.createdAt;
    if (age < grace) continue;
    const leftover: ForeignLeftover = {
      id: m.id, provider, namespace: m.namespace, deployment: m.deployment, machineType: m.machineType, zone: m.zone, state: m.state,
      ageHours: Math.round(age / 360_000) / 10, holdsNeededQuota: neededTypes ? neededTypes.has(m.machineType) : null,
    };
    result.foreign.push(leftover);
    if (leftover.holdsNeededQuota !== false) log('ALERT reaper.foreign_quota_held', { ...leftover, protects: opts.namespace });
    // ponytail: only stopped machines go; whether a running machine of another namespace is idle cannot be seen from here.
    if (!opts.applyForeign || !STOPPED.test(m.state) || age < minAge) continue;
    const id = `${provider}:foreign:${m.namespace}/${m.id}`;
    result.planned.push(id);
    try {
      await backend.releaseReplica(m, 'reaper-foreign');
      result.released.push(id);
    } catch (err) {
      result.failed.push(id);
      log('reaper: foreign release failed', { id, error: errText(err) });
    }
  }
}

async function reapBackend(
  backend: ReapBackend, namespace: string, pick: (m: ReplicaMachine) => boolean, result: ReapResult, log: Log,
): Promise<void> {
  let machines: ReplicaMachine[];
  try {
    machines = await backend.listReplicas(namespace);
  } catch (err) {
    // One provider failing to list must not spare the other provider's machines; the next run retries this one.
    result.failed.push(`list:${backend.provider ?? 'backend'}`);
    log('reaper: list failed', { provider: backend.provider, error: errText(err) });
    return;
  }
  result.seen += machines.length;
  const doomed = machines.filter(pick);
  log(result.gatewayUp ? 'reaper: machines of no deployment' : 'reaper: gateway down, releasing replicas', {
    namespace, provider: backend.provider, mode: result.mode, seen: machines.length, releasing: doomed.length, dryRun: result.dryRun,
    ...(doomed.length ? { ids: doomed.map(m => `${m.deployment}/${m.id}`) } : {}),
  });
  for (const machine of doomed) {
    result.planned.push(`${backend.provider ?? 'backend'}:${machine.id}`);
    if (result.dryRun) continue;
    try {
      await backend.releaseReplica(machine, 'reaper');
      result.released.push(machine.id);
    } catch (err) {
      result.failed.push(machine.id);
      log('reaper: release failed', { id: machine.id, error: errText(err) });
    }
  }
}

/** Cross-check only: tagged IPs / security groups of a deployment the gateway does not have, used by no server. */
async function sweepNetworks(opts: ReaperOptions, owned: ReadonlySet<string>, now: number, result: ReapResult, log: Log): Promise<void> {
  const grace = opts.graceMs ?? DEFAULT_REAPER_GRACE_MS;
  for (const sweeper of opts.networks ?? []) {
    let listed: { resources: NetworkResource[]; errors: string[] };
    try {
      listed = await sweeper.listNetwork(opts.namespace);
    } catch (err) {
      result.failed.push(`list-network:${sweeper.provider ?? 'network'}`);
      log('reaper: network list failed', { provider: sweeper.provider, error: errText(err) });
      continue;
    }
    for (const e of listed.errors) result.failed.push(`list-network:${e}`);
    const doomed = listed.resources.filter(r => r.deployment !== null && !owned.has(r.deployment) && !r.inUse
      && (r.createdAt === null || now - r.createdAt >= grace));
    if (doomed.length) log('reaper: network leftovers of no deployment', { provider: sweeper.provider, items: doomed.map(r => r.label), dryRun: result.dryRun });
    for (const r of doomed) {
      const id = `${sweeper.provider ?? 'network'}:${r.kind}:${r.zone}/${r.id}`;
      result.planned.push(id);
      if (result.dryRun) continue;
      try {
        await sweeper.releaseNetwork(r);
        result.released.push(id);
      } catch (err) {
        result.failed.push(id);
        log('reaper: network release failed', { id, error: errText(err) });
      }
    }
  }
}

export function reapSummary(r: ReapResult): string {
  if (r.skipped) return `reaper: NOT CHECKED (${r.skipped}) — ${r.seen} machine(s) listed, none compared, nothing released:`;
  return r.dryRun ? `reaper: DRY RUN, nothing released (pass --apply or REAPER_APPLY=1) — would release ${r.planned.length}:` : 'reaper:';
}

export function reapExitCode(r: ReapResult): number {
  return r.failed.length ? 1 : r.skipped ? 3 : 0;
}

/** Kept for callers from before the cross-check: same function (without `owned` it only acts when the gateway is down). */
export const reapIfGatewayDown = reapOrphans;

/**
 * The deployments a gateway owns, from its own `GET /v1/deployments` with an ADMIN key. Trusted only when the answer is
 * the full list (`scope: "all"`: an admin key acting for no app) of the same namespace; anything else — a non-admin key
 * (its list is filtered to its app), another namespace, a gateway build from before `scope`, a non-2xx — is a skip.
 */
export async function ownedFromGateway(input: {
  gatewayUrl: string; adminKey: string; namespace: string; fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<OwnedDeployments> {
  const res = await (input.fetchImpl ?? fetch)(`${input.gatewayUrl.replace(/\/$/, '')}/v1/deployments`, {
    headers: { Authorization: `Bearer ${input.adminKey}` }, signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
  });
  if (!res.ok) return { skip: `GET /v1/deployments answered HTTP ${res.status}` };
  const body = await res.json().catch(() => null) as { namespace?: unknown; scope?: unknown; deployments?: unknown } | null;
  if (!body || !Array.isArray(body.deployments)) return { skip: 'GET /v1/deployments: unexpected answer' };
  if (body.namespace !== input.namespace) return { skip: `gateway namespace '${String(body.namespace)}' is not '${input.namespace}'` };
  if (body.scope !== 'all') return { skip: 'GET /v1/deployments is not the full admin list (admin key? gateway build with `scope`?)' };
  const names = new Set<string>();
  const machineTypes = new Set<string>();
  type Listed = { name?: unknown; spec?: { machineType?: unknown; placements?: Array<{ machineType?: unknown }> } };
  for (const d of body.deployments as Listed[]) {
    if (typeof d?.name === 'string') names.add(d.name);
    for (const t of [d?.spec?.machineType, ...(Array.isArray(d?.spec?.placements) ? d.spec.placements.map(p => p?.machineType) : [])]) {
      if (typeof t === 'string' && t) machineTypes.add(t);
    }
  }
  return { names, machineTypes };
}
