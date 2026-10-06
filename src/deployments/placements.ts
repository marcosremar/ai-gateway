/**
 * Where a replica may be created: the spec's own zone/type first, then each `placements` entry in order
 * (`DeploymentSpec.placements`). The controller moves to the next one only when the provider says the type is out
 * of stock there (`isOutOfStock`).
 */
import type { DeploymentSpec } from './types';

/** The spec once per placement, primary first, duplicates dropped. */
export function placementsOf(spec: DeploymentSpec): DeploymentSpec[] {
  const seen = new Set<string>();
  const out: DeploymentSpec[] = [];
  for (const p of [{}, ...(spec.placements ?? [])]) {
    const zone = p.zone ?? spec.zone;
    const machineType = p.machineType ?? spec.machineType;
    const key = `${zone}/${machineType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Scaleway image ids are per zone: a pinned image only holds in its own zone (elsewhere the backend looks up the
    // same image there).
    const { osImageId, ...rest } = spec;
    out.push({ ...rest, ...(zone === spec.zone && osImageId ? { osImageId } : {}), zone, machineType });
  }
  return out;
}

/**
 * The provider has no machine of this type in this zone right now. Scaleway answers a server create with
 * `412 {"type":"out_of_stock"}` (seen 2026-10-06 for L40S and L4 in fr-par-2); quota and capacity wordings count too.
 */
export function isOutOfStock(err: unknown): boolean {
  const e = err as { status?: unknown; body?: unknown; message?: unknown } | null;
  const text = `${typeof e?.message === 'string' ? e.message : ''} ${typeof e?.body === 'string' ? e.body : ''}`;
  if (/out_of_stock|out of stock|shortage|insufficient capacity|no (?:more )?capacity|not enough (?:stock|capacity)/i.test(text)) return true;
  return e?.status === 412 && /stock|capacity|available/i.test(text);
}
