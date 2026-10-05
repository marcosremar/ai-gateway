/**
 * Placement — where a new replica goes when the spec's own zone/type cannot take it.
 *
 * A spec may carry an ordered `candidates` list of `{ zone, machineType, maxEurPerHour }` (the caller's preference,
 * e.g. "L4 in Paris → L4 elsewhere in the EU → L40S → H100"). For each create the controller walks it in order and
 * takes the first one that:
 *   1. is sold in the zone (catalog price not `null`),
 *   2. costs at most that candidate's own `maxEurPerHour` (a dearer GPU tier carries its own cap),
 *   3. is not reported `shortage` by the provider's stock read (when the backend exposes it), and
 *   4. the provider actually accepts — a create refused for capacity (`out_of_stock`, quota, shortage) moves on to the
 *      next candidate; any other error stops the walk (it would fail the same way elsewhere).
 * Every skip is recorded with its reason so the log says which candidate won and why the earlier ones did not.
 * Without `candidates` the list is the spec's own `{ zone, machineType, maxEurPerHour }`, so old specs behave as before.
 */

import type { DeploymentBackend, DeploymentSpec, PlacementCandidate, ReplicaMachine } from './types';

/** Upper bound on the list a caller may send (3 GPU tiers × ~10 EU zones fits). */
export const MAX_PLACEMENT_CANDIDATES = 40;

/** A create error that another zone or GPU type can fix: out of stock, quota or capacity of that type. */
export function isCapacityError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${(error as { body?: unknown }).body ?? ''}` : String(error);
  return /out[_ ]of[_ ]stock|quotas?[_ ]exceeded|insufficient[_ ]capacity|no (?:more )?(?:capacity|instances? available)|shortage/i.test(text);
}

export function candidatesOf(spec: DeploymentSpec): PlacementCandidate[] {
  if (spec.candidates?.length) return spec.candidates;
  return [{ zone: spec.zone, machineType: spec.machineType, maxEurPerHour: spec.maxEurPerHour }];
}

export interface PlacementSkip {
  zone: string;
  machineType: string;
  reason: 'not-sold' | 'over-cap' | 'shortage' | 'capacity';
  detail: string;
}

export interface PlacementResult {
  machine: ReplicaMachine;
  candidate: PlacementCandidate;
  price: number;
  /** Index in the candidate list (0 = the first choice). */
  index: number;
  skipped: PlacementSkip[];
}

export class PlacementError extends Error {
  constructor(message: string, readonly skipped: PlacementSkip[]) {
    super(message);
  }
}

const summary = (skipped: PlacementSkip[]) => skipped.map(s => `${s.machineType}@${s.zone}: ${s.reason}`).join('; ');

/**
 * Walks the candidates in order and creates the replica on the first that takes it. `create` receives the spec with
 * that candidate's zone, type and cap. Throws `PlacementError` (with every skip) when none did, or the first
 * non-capacity create error as-is.
 */
export async function placeReplica(
  spec: DeploymentSpec,
  backend: Pick<DeploymentBackend, 'hourlyPrice' | 'availability'>,
  create: (placed: DeploymentSpec) => Promise<ReplicaMachine>,
): Promise<PlacementResult> {
  const skipped: PlacementSkip[] = [];
  const candidates = candidatesOf(spec);
  for (const [index, candidate] of candidates.entries()) {
    const { zone, machineType, maxEurPerHour } = candidate;
    const price = await backend.hourlyPrice(zone, machineType);
    if (price == null) {
      skipped.push({ zone, machineType, reason: 'not-sold', detail: `${machineType} is not sold in ${zone}` });
      continue;
    }
    if (price > maxEurPerHour) {
      skipped.push({ zone, machineType, reason: 'over-cap', detail: `${machineType} costs €${price}/h in ${zone}, above maxEurPerHour €${maxEurPerHour}` });
      continue;
    }
    const stock = backend.availability ? await backend.availability(zone, machineType).catch(() => null) : null;
    if (stock === 'shortage') {
      skipped.push({ zone, machineType, reason: 'shortage', detail: `${machineType} in ${zone}: provider reports shortage` });
      continue;
    }
    try {
      const machine = await create({ ...spec, zone, machineType, maxEurPerHour });
      return { machine, candidate, price, index, skipped };
    } catch (err) {
      if (!isCapacityError(err)) throw err;
      skipped.push({ zone, machineType, reason: 'capacity', detail: err instanceof Error ? err.message : String(err) });
    }
  }
  if (candidates.length === 1 && skipped.length === 1) throw new PlacementError(skipped[0]!.detail, skipped);
  throw new PlacementError(`no candidate could take a replica (${summary(skipped)})`, skipped);
}

export { summary as placementSummary };
