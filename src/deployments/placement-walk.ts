/**
 * One replica create, walked over a list of places — the single path for both spec fields:
 *
 *   - no `candidates`: the spec's zone/type, then each `placements` entry IN ORDER (`placementsOf`, no ranking), all on
 *     the spec's provider at its `maxEurPerHour` (the `placements` semantics, unchanged);
 *   - `candidates`: ranked (`rankCandidates`: near the users, then cheap), any provider, each at its own cap.
 *
 * Each place gets the live price check (not sold / over cap → skip, no create), then the create; an out-of-stock
 * answer (`isOutOfStock`) moves to the next place, any other error stops the walk (it would fail everywhere).
 * `placement` says where the replica landed and why earlier places were skipped (`lastPlacement` in the view).
 */

import { DEFAULT_NEAR, isOutOfStock, placementsOf, rankCandidates } from './placements';
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

/** Thrown when the walk ends without a replica; carries the placement summary. */
export class PlacementError extends Error {
  constructor(message: string, readonly placement: string) { super(message); }
}

/** One place to try: the spec narrowed to it. */
interface Step { provider: DeploymentProvider; spec: DeploymentSpec }

const fmtEur = (n: number) => `€${Math.round(n * 1000) / 1000}/h`;
const where = (s: Step) => (s.provider === 'vast' ? `vast ${s.spec.machineType}` : `${s.provider} ${s.spec.machineType}@${s.spec.zone}`);

/** The spec as one candidate sees it (a pinned OS image only holds in its own zone, as for `placements`). */
function candidateSpec(spec: DeploymentSpec, c: PlacementCandidate & { provider: DeploymentProvider }): DeploymentSpec {
  const zone = c.zone ?? spec.zone;
  const { osImageId, ...rest } = spec;
  return {
    ...rest, ...(zone === spec.zone && osImageId ? { osImageId } : {}),
    provider: c.provider, zone, machineType: c.machineType, maxEurPerHour: c.maxEurPerHour,
    gpu: c.provider === 'vast' ? true : isGpuMachineType(c.machineType),
  };
}

/** Catalog price check; `skip` = why this place is not tried. A market-priced backend (Vast) caps its offers itself. */
async function priceOf(backend: DeploymentBackend, spec: DeploymentSpec): Promise<{ price: number | null; skip?: string }> {
  if (backend.marketPriced) return { price: null };
  const price = await backend.hourlyPrice(spec.zone, spec.machineType);
  if (price == null) return { price, skip: `${spec.machineType} is not sold in ${spec.zone}` };
  if (price > spec.maxEurPerHour) {
    return { price, skip: `${spec.machineType} costs €${price}/h in ${spec.zone}, above maxEurPerHour €${spec.maxEurPerHour}` };
  }
  return { price };
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

/** The places to try, in order, plus what the ranking already left out. */
async function stepsOf(args: PlaceArgs): Promise<{ steps: Step[]; skipped: string[]; ranked: boolean }> {
  const { spec } = args;
  if (!spec.candidates?.length) {
    return { steps: placementsOf(spec).map(s => ({ provider: spec.provider, spec: s })), skipped: [], ranked: false };
  }
  const { ranked, skipped } = rankCandidates(spec.candidates, await catalogOf(args, spec.candidates), {
    near: spec.near ?? DEFAULT_NEAR, ...(spec.allowFar ? { allowFar: true } : {}), defaultProvider: spec.provider, defaultZone: spec.zone,
  });
  return { steps: ranked.map(c => ({ provider: c.provider, spec: candidateSpec(spec, c) })), skipped, ranked: true };
}

export async function placeReplica(args: PlaceArgs): Promise<PlaceResult> {
  const { steps, skipped, ranked } = await stepsOf(args);
  const near = ranked ? ` near ${args.spec.near ?? DEFAULT_NEAR}` : '';
  const withSkipped = (text: string) => (skipped.length ? `${text}; skipped: ${skipped.join('; ')}` : text);
  for (const step of steps) {
    const backend = args.backendFor(step.provider);
    if (!backend) {
      if (!ranked) throw new Error(`no backend configured for provider '${step.provider}'`);
      skipped.push(`${where(step)}: provider not configured`);
      continue;
    }
    const { price, skip } = await priceOf(backend, step.spec);
    if (skip) { skipped.push(skip); continue; }
    let machine: ReplicaMachine;
    try {
      machine = await args.create(backend, step.spec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Out of stock here: the next place may still have one. Any other error is the spec's or the account's.
      if (!isOutOfStock(err)) throw new PlacementError(msg, withSkipped(`failed at ${where(step)}: ${msg}`));
      skipped.push(step.provider === 'vast' ? `${where(step)}: ${msg.slice(0, 160)}` : `${step.spec.machineType} out of stock in ${step.spec.zone}`);
      args.log?.('deployments: out of stock, trying the next placement', { deployment: args.spec.name, place: where(step) });
      continue;
    }
    const cost = price != null ? fmtEur(price) : `≤ ${fmtEur(step.spec.maxEurPerHour)}`;
    return { machine, price, placement: withSkipped(`${where(step)} (${cost})${near}`) };
  }
  const message = skipped.join('; ') || 'no placement';
  throw new PlacementError(ranked ? `out_of_stock: ${message}` : message, `no replica placed; skipped: ${message}`);
}
