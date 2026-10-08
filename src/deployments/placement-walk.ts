/**
 * One replica create, walked over a list of places — the single path for both spec fields:
 *
 *   - no `candidates`: the spec's zone/type, then each `placements` entry IN ORDER (`placementsOf`, no ranking), on the
 *     spec's provider at its `maxEurPerHour`, or on the entry's own provider at the entry's cap and replica limit;
 *   - `candidates`: ranked (`rankCandidates`: near the users, then cheap), any provider, each at its own cap.
 *
 * Each place gets the live price check (not sold / over cap → skip, no create), then the create; an out-of-stock
 * answer (`isOutOfStock`) moves to the next place, a quota refusal (`quotaMachineType`) to the next place of another
 * machine type, any other error stops the walk (it would fail everywhere).
 * `placement` says where the replica landed and why earlier places were skipped (`lastPlacement` in the view).
 */

import { DEFAULT_NEAR, isOutOfStock, placementsOf, quotaMachineType, rankCandidates } from './placements';
import { isGpuMachineType, vastRefusal } from './spec';
import type { CatalogEntry, DeploymentBackend, DeploymentProvider, DeploymentSpec, PlacementCandidate, ReplicaMachine } from './types';

export interface PlaceResult { machine: ReplicaMachine; price: number | null; placement: string }

export interface PlaceArgs {
  spec: DeploymentSpec;
  backendFor: (provider: DeploymentProvider) => DeploymentBackend | undefined;
  /** Creates the replica of `spec` (already narrowed to one place) on `backend`. */
  create: (backend: DeploymentBackend, spec: DeploymentSpec) => Promise<ReplicaMachine>;
  /**
   * Gate before each create, given what the place bills per hour (the catalog price, or the cap on a market-priced
   * backend): a reason to skip the place (spend ceiling), or null. A cheaper place further down may still pass.
   */
  admit?: (eurPerHour: number) => string | null;
  placed?: (provider: DeploymentProvider) => number;
  forVast?: (spec: DeploymentSpec) => DeploymentSpec;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

/** Thrown when the walk ends without a replica; carries the placement summary. */
export class PlacementError extends Error {
  constructor(message: string, readonly placement: string) { super(message); }
}

/** One place to try: the spec narrowed to it. */
interface Step { provider: DeploymentProvider; spec: DeploymentSpec; limit?: number }

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
    const limitOf = (s: DeploymentSpec) => spec.placements?.find(p => p.provider === s.provider && p.machineType === s.machineType)?.maxReplicas;
    return { steps: placementsOf(spec).map(s => ({ provider: s.provider, spec: s, limit: limitOf(s) })), skipped: [], ranked: false };
  }
  const { ranked, skipped } = rankCandidates(spec.candidates, await catalogOf(args, spec.candidates), {
    near: spec.near ?? DEFAULT_NEAR, ...(spec.allowFar ? { allowFar: true } : {}), defaultProvider: spec.provider, defaultZone: spec.zone,
  });
  return { steps: ranked.map(c => ({ provider: c.provider, spec: candidateSpec(spec, c) })), skipped, ranked: true };
}

export function vastUnfit(spec: DeploymentSpec, backendFor: PlaceArgs['backendFor']): string | null {
  if (!spec.registryAuth && backendFor('scaleway')?.registryAuthFor?.(spec.image)) {
    return `${spec.image} is private and the spec has no registryAuth (a pull-only credential) for a vast host`;
  }
  return vastRefusal(spec, true);
}

export async function placeReplica(args: PlaceArgs): Promise<PlaceResult> {
  const { steps, skipped, ranked } = await stepsOf(args);
  const near = ranked ? ` near ${args.spec.near ?? DEFAULT_NEAR}` : '';
  const withSkipped = (text: string) => (skipped.length ? `${text}; skipped: ${skipped.join('; ')}` : text);
  const overQuota = new Set<string>();
  for (const step of steps) {
    if (overQuota.has(`${step.provider}/${step.spec.machineType}`)) continue;
    const backend = args.backendFor(step.provider);
    if (!backend) {
      if (!ranked && step.provider === args.spec.provider) throw new Error(`no backend configured for provider '${step.provider}'`);
      skipped.push(`${where(step)}: provider not configured`);
      continue;
    }
    if (step.provider === 'vast' && args.forVast) step.spec = args.forVast(step.spec);
    const unfit = step.provider === 'vast' ? vastUnfit(step.spec, args.backendFor) : null;
    if (unfit) { skipped.push(`${where(step)}: ${unfit}`); continue; }
    const { price, skip } = await priceOf(backend, step.spec);
    if (skip) { skipped.push(skip); continue; }
    if (step.limit !== undefined && (args.placed?.(step.provider) ?? 0) >= step.limit) {
      skipped.push(`${where(step)}: its ${step.limit} fallback replica${step.limit > 1 ? 's are' : ' is'} in use (placement maxReplicas)`);
      continue;
    }
    const refused = args.admit?.(price ?? step.spec.maxEurPerHour);
    if (refused) { skipped.push(`${where(step)}: ${refused}`); continue; }
    let machine: ReplicaMachine;
    try {
      machine = await args.create(backend, step.spec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const quotaType = quotaMachineType(err, step.spec.machineType);
      if (quotaType) {
        overQuota.add(`${step.provider}/${quotaType}`);
        skipped.push(`quota reached for ${quotaType} on ${step.provider} (${msg.slice(0, 160)})`);
        args.log?.('deployments: quota reached, skipping the machine type', { deployment: args.spec.name, place: where(step), machineType: quotaType });
        continue;
      }
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
  throw new PlacementError(ranked ? `${overQuota.size ? 'quota' : 'out_of_stock'}: ${message}` : message, `no replica placed; skipped: ${message}`);
}
