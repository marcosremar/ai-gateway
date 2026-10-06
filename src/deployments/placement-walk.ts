/**
 * One replica create, walked over the placement ladder: without `candidates` it is the single place of the spec
 * (`provider` + `zone` + `machineType` under `maxEurPerHour`, exactly the pre-ladder behavior); with them, the
 * candidates are ranked (`rankCandidates`) and tried in order — price checked against each one's cap, skipped when not
 * sold / over cap / out of stock, first success wins. The returned `placement` says where it landed and why earlier
 * candidates were skipped (`lastPlacement` in the deployment view).
 */

import { DEFAULT_NEAR, isPlacementMiss, rankCandidates } from './placement';
import { isGpuMachineType } from './spec';
import type { CatalogEntry, DeploymentBackend, DeploymentProvider, DeploymentSpec, PlacementCandidate, ReplicaMachine } from './types';

export interface PlaceResult { machine: ReplicaMachine; price: number | null; placement: string }

export interface PlaceArgs {
  spec: DeploymentSpec;
  backendFor: (provider: DeploymentProvider) => DeploymentBackend | undefined;
  /** Creates the replica of `spec` (already narrowed to one place) on `backend`. */
  create: (backend: DeploymentBackend, spec: DeploymentSpec) => Promise<ReplicaMachine>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

/** Thrown when no candidate could place a replica; carries the placement summary. */
export class PlacementError extends Error {
  constructor(message: string, readonly placement: string) { super(message); }
}

const fmtEur = (n: number) => `€${Math.round(n * 1000) / 1000}/h`;
const where = (provider: DeploymentProvider, s: Pick<DeploymentSpec, 'machineType' | 'zone'>) =>
  provider === 'vast' ? `vast ${s.machineType}` : `${provider} ${s.machineType}@${s.zone}`;

/** The spec as one candidate sees it. */
function specFor(spec: DeploymentSpec, c: PlacementCandidate & { provider: DeploymentProvider }): DeploymentSpec {
  return {
    ...spec, provider: c.provider, zone: c.zone ?? spec.zone, machineType: c.machineType, maxEurPerHour: c.maxEurPerHour,
    gpu: c.provider === 'vast' ? true : isGpuMachineType(c.machineType),
  };
}

/** Catalog price check (skipped on a market-priced backend, which applies the cap to its offers itself). */
async function checkPrice(backend: DeploymentBackend, spec: DeploymentSpec): Promise<number | null> {
  if (backend.marketPriced) return null;
  const price = await backend.hourlyPrice(spec.zone, spec.machineType);
  if (price == null) throw new Error(`${spec.machineType} is not sold in ${spec.zone}`);
  if (price > spec.maxEurPerHour) {
    throw new Error(`${spec.machineType} costs €${price}/h in ${spec.zone}, above maxEurPerHour €${spec.maxEurPerHour}`);
  }
  return price;
}

async function catalogOf(args: PlaceArgs, candidates: PlacementCandidate[]): Promise<CatalogEntry[]> {
  const scw = args.backendFor('scaleway');
  const zones = [...new Set(candidates.filter(c => (c.provider ?? args.spec.provider) === 'scaleway').map(c => c.zone ?? args.spec.zone))];
  if (!scw?.catalog || !zones.length) return [];
  try {
    return await scw.catalog(zones);
  } catch (err) {
    // Ranking without stock is still a ranking; each create checks the live price anyway.
    args.log?.('deployments: catalog unavailable, ranking candidates without it', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function placeReplica(args: PlaceArgs): Promise<PlaceResult> {
  const { spec } = args;
  if (!spec.candidates?.length) {
    const backend = args.backendFor(spec.provider);
    if (!backend) throw new Error(`no backend configured for provider '${spec.provider}'`);
    const price = await checkPrice(backend, spec);
    const machine = await args.create(backend, spec);
    return { machine, price, placement: `${where(spec.provider, spec)}${price != null ? ` (${fmtEur(price)})` : ''}` };
  }

  const near = spec.near ?? DEFAULT_NEAR;
  const { ranked, skipped } = rankCandidates(spec.candidates, await catalogOf(args, spec.candidates), {
    near, ...(spec.allowFar ? { allowFar: true } : {}), defaultProvider: spec.provider, defaultZone: spec.zone,
  });
  for (const c of ranked) {
    const cspec = specFor(spec, c);
    const label = where(c.provider, cspec);
    const backend = args.backendFor(c.provider);
    if (!backend) { skipped.push(`${label}: provider not configured`); continue; }
    try {
      const price = await checkPrice(backend, cspec);
      const machine = await args.create(backend, cspec);
      const landed = `${label}${price != null ? ` (${fmtEur(price)})` : ` (≤ ${fmtEur(c.maxEurPerHour)})`} near ${near}`;
      return { machine, price, placement: skipped.length ? `${landed}; skipped: ${skipped.join('; ')}` : landed };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isPlacementMiss(err) && !/costs €.*above maxEurPerHour/.test(msg)) {
        throw new PlacementError(msg, `failed at ${label}: ${msg}${skipped.length ? `; skipped: ${skipped.join('; ')}` : ''}`);
      }
      skipped.push(`${label}: ${msg.slice(0, 160)}`);
      args.log?.('deployments: candidate skipped', { deployment: spec.name, candidate: label, reason: msg });
    }
  }
  const summary = `no candidate placed a replica; skipped: ${skipped.join('; ') || 'none ranked'}`;
  throw new PlacementError(`out_of_stock: ${summary}`, summary);
}
