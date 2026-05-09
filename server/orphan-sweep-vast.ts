/**
 * Detect & optionally terminate Vast.ai pods running with images outside an
 * operator-defined allowlist.
 *
 * Why a new module when `gpu-cost-audit.ts` already exists?
 * `auditGpuCosts` covers two cost leaks:
 *   1. RunPod network volumes left behind after a pod terminate.
 *   2. Vast.ai pods stuck in `exited`/`stopped` (storage cost).
 * It does NOT catch the pattern that triggered the May 2026 incident:
 * pods in `running` state launched outside the gateway's tracked
 * deployments — for example a previous `qwen3-tts` deploy from a different
 * machine that the gateway forgot. Those quietly burn the per-hour rate
 * until the provider balance goes negative; subsequent gateway deploys
 * then fail with a misleading "race slots failed" error.
 *
 * The sweep here is intentionally narrow: image-allowlist filter + dollar
 * burn estimate + opt-in destructive pass. Pure detection logic is
 * extracted so unit tests can run without hitting vast.ai.
 */

export interface VastInstanceLite {
  id: number;
  imageUuid: string;
  /** Dollars per hour the pod is currently billing. */
  dphTotal: number;
  startDate: number;
  status?: string | undefined;
}

export interface OrphanSweepReport {
  orphans: VastInstanceLite[];
  burnPerHourUsd: number;
  terminatedIds: number[];
  errors: Array<{ id: number; message: string }>;
}

export interface OrphanSweepDeps {
  listInstances: () => Promise<VastInstanceLite[]>;
  terminate?: (id: number) => Promise<void>;
  allowlistImagePrefixes: readonly string[];
  autoTerminate?: boolean;
  log?: (line: string) => void;
}

/** Pure: which instances are NOT covered by any allowlist prefix. Anything
 *  not on the list is presumed orphan. Empty allowlist flags every
 *  instance — defensive against operator misconfiguration. */
export function detectOrphanInstances(
  instances: readonly VastInstanceLite[],
  allowlistImagePrefixes: readonly string[],
): { orphans: VastInstanceLite[]; burnPerHourUsd: number } {
  const orphans = instances.filter(
    (i) => !allowlistImagePrefixes.some((prefix) => i.imageUuid.startsWith(prefix)),
  );
  const burnPerHourUsd = orphans.reduce((sum, i) => sum + i.dphTotal, 0);
  return { orphans, burnPerHourUsd };
}

export async function runOrphanSweep(deps: OrphanSweepDeps): Promise<OrphanSweepReport> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  const instances = await deps.listInstances();
  const { orphans, burnPerHourUsd } = detectOrphanInstances(instances, deps.allowlistImagePrefixes);
  const report: OrphanSweepReport = { orphans, burnPerHourUsd, terminatedIds: [], errors: [] };

  if (orphans.length === 0) return report;

  log(
    `[orphan-sweep] ${orphans.length} orphan vast pod(s) burning $${burnPerHourUsd.toFixed(2)}/h: ` +
      orphans.map((o) => `id=${o.id} image=${o.imageUuid}`).join('; '),
  );

  if (!deps.autoTerminate || !deps.terminate) return report;

  for (const orphan of orphans) {
    try {
      await deps.terminate(orphan.id);
      report.terminatedIds.push(orphan.id);
      log(`[orphan-sweep] terminated ${orphan.id} (${orphan.imageUuid})`);
    } catch (err) {
      report.errors.push({ id: orphan.id, message: (err as Error).message });
    }
  }
  return report;
}

const VAST_BASE = 'https://console.vast.ai/api/v0';

/** Direct vast.ai REST list — bypasses the gateway's tracked-state cache so
 *  pods leaked from another session are visible. */
export async function listVastInstancesDirect(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<VastInstanceLite[]> {
  const url = `${VAST_BASE}/instances/?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`vast list HTTP ${res.status}`);
  const body = (await res.json()) as { instances?: unknown[] };
  return (body.instances ?? [])
    .filter((i): i is Record<string, unknown> => i !== null && typeof i === 'object')
    .map((raw) => ({
      id: Number(raw.id),
      imageUuid: String(raw.image_uuid ?? ''),
      dphTotal: Number(raw.dph_total ?? 0),
      startDate: Number(raw.start_date ?? 0),
      status: typeof raw.status === 'string' ? raw.status : undefined,
    }));
}

/** Direct vast.ai REST terminate. */
export async function terminateVastInstanceDirect(id: number, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = `${VAST_BASE}/instances/${id}/?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(`vast terminate ${id} HTTP ${res.status}`);
}
