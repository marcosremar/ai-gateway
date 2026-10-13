import type { MachineBackend, ProviderMachine } from './types';

type Log = (msg: string, data?: Record<string, unknown>) => void;

export type OwnedMachines = { ids: ReadonlySet<string> } | { skip: string };

export interface MachineReapOptions {
  backends: Array<Pick<MachineBackend, 'provider' | 'list' | 'release'>>;
  namespace: string;
  gatewayUp: () => Promise<boolean>;
  owned?: () => Promise<OwnedMachines>;
  probes?: number;
  probeIntervalMs?: number;
  minAgeMs?: number;
  graceMs?: number;
  maxLifetimeMs?: number;
  dryRun?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: Log;
}

export interface MachineReapResult {
  gatewayUp: boolean;
  mode: 'gateway-down' | 'cross-check' | 'lifetime-only';
  dryRun: boolean;
  seen: number;
  planned: string[];
  released: string[];
  failed: string[];
  skipped?: string;
}

export const DEFAULT_MACHINE_GRACE_MS = 30 * 60_000;
export const DEFAULT_MACHINE_LIFETIME_MS = 73 * 3_600_000;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function probe(opts: MachineReapOptions): Promise<boolean> {
  const probes = opts.probes ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  for (let i = 0; i < probes; i++) {
    if (await opts.gatewayUp().catch(() => false)) return true;
    if (i < probes - 1) await sleep(opts.probeIntervalMs ?? 40_000);
  }
  return false;
}

export async function reapMachines(opts: MachineReapOptions): Promise<MachineReapResult> {
  const log = opts.log ?? (() => {});
  const up = await probe(opts);
  const now = (opts.now ?? Date.now)();
  let owned: ReadonlySet<string> | null = null;
  let skipped: string | undefined;
  if (up) {
    const answer = opts.owned
      ? await opts.owned().catch((err): OwnedMachines => ({ skip: `machines list failed: ${errText(err)}` }))
      : { skip: 'no admin key: cross-check off' };
    if ('skip' in answer) skipped = answer.skip;
    else owned = answer.ids;
  }
  const lifetime = opts.maxLifetimeMs ?? DEFAULT_MACHINE_LIFETIME_MS;
  const minAge = up ? opts.graceMs ?? DEFAULT_MACHINE_GRACE_MS : opts.minAgeMs ?? DEFAULT_MACHINE_GRACE_MS;
  const doomed = (m: ProviderMachine): string | null => {
    const age = now - m.createdAt;
    if (age >= lifetime) return 'lifetime';
    if (!up) return age >= minAge ? 'gateway-down' : null;
    return owned && !owned.has(m.machineId) && age >= minAge ? 'unknown-to-gateway' : null;
  };
  const result: MachineReapResult = {
    gatewayUp: up, mode: !up ? 'gateway-down' : owned ? 'cross-check' : 'lifetime-only', dryRun: opts.dryRun === true,
    seen: 0, planned: [], released: [], failed: [], ...(skipped ? { skipped } : {}),
  };
  for (const backend of opts.backends) {
    let machines: ProviderMachine[];
    try {
      machines = await backend.list(opts.namespace);
    } catch (err) {
      result.failed.push(`list:${backend.provider}`);
      log('reaper: machines list failed', { provider: backend.provider, error: errText(err) });
      continue;
    }
    result.seen += machines.length;
    for (const m of machines) {
      const reason = doomed(m);
      if (!reason) continue;
      const id = `${backend.provider}:machine:${m.machineId}/${m.providerId}`;
      result.planned.push(id);
      log('reaper: machine to release', { id, reason, dryRun: result.dryRun });
      if (result.dryRun) continue;
      try {
        await backend.release(m.providerId);
        result.released.push(id);
      } catch (err) {
        result.failed.push(id);
        log('reaper: machine release failed', { id, error: errText(err) });
      }
    }
  }
  return result;
}

export async function ownedMachinesFromGateway(input: {
  gatewayUrl: string; adminKey: string; namespace: string; fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<OwnedMachines> {
  const res = await (input.fetchImpl ?? fetch)(`${input.gatewayUrl.replace(/\/$/, '')}/v1/machines`, {
    headers: { Authorization: `Bearer ${input.adminKey}` }, signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
  });
  if (res.status === 404) return { skip: 'GET /v1/machines answered 404 (machines off on this gateway, or an older build)' };
  if (!res.ok) return { skip: `GET /v1/machines answered HTTP ${res.status}` };
  const body = await res.json().catch(() => null) as { namespace?: unknown; scope?: unknown; machines?: unknown } | null;
  if (!body || !Array.isArray(body.machines)) return { skip: 'GET /v1/machines: unexpected answer' };
  if (body.namespace !== input.namespace) return { skip: `gateway namespace '${String(body.namespace)}' is not '${input.namespace}'` };
  if (body.scope !== 'all') return { skip: 'GET /v1/machines is not the full admin list' };
  const ids = new Set<string>();
  for (const m of body.machines as Array<{ id?: unknown; status?: unknown }>) {
    if (typeof m?.id === 'string' && (m.status === 'creating' || m.status === 'running')) ids.add(m.id);
  }
  return { ids };
}
