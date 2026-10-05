/**
 * Placement fallback (`src/deployments/placement.ts`): a replica refused for capacity in one zone/type goes to the next
 * candidate, in the caller's order, each with its own price cap. Regression for 2026-10-05: Scaleway answered
 * `412 out_of_stock` for L4-1-24G in fr-par-2 and the gateway never tried another zone (parle
 * `docs/reports/2026-10-05-validacao-aula-lia`).
 */

import { describe, expect, it } from 'vitest';
import { candidatesOf, isCapacityError, placeReplica, PlacementError } from '../../../src/deployments/placement';
import { buildSpec, SpecError } from '../../../src/deployments/spec';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import type { DeploymentSpec, ReplicaMachine } from '../../../src/deployments/types';

const profiles = new Map(BUILTIN_PROFILES.map(p => [p.name, p]));

/** The parle ladder: L4 Paris → L4 rest of EU → L40S (Paris, EU) → H100 (Paris, EU). */
const LADDER = [
  ...['fr-par-2', 'fr-par-1', 'fr-par-3', 'nl-ams-1', 'pl-waw-2'].map(zone => ({ zone, machineType: 'L4-1-24G', maxEurPerHour: 1 })),
  ...['fr-par-2', 'pl-waw-2'].map(zone => ({ zone, machineType: 'L40S-1-48G', maxEurPerHour: 1.6 })),
  ...['fr-par-2', 'pl-waw-2'].map(zone => ({ zone, machineType: 'H100-1-80G', maxEurPerHour: 3.1 })),
];

/** Scaleway catalog of 2026-10-05 (EUR/h): L4 only in fr-par-1/2 and pl-waw-2, L40S/H100 in fr-par-2 and pl-waw-2. */
const PRICES: Record<string, number> = {
  'fr-par-1/L4-1-24G': 0.7875, 'fr-par-2/L4-1-24G': 0.7875, 'pl-waw-2/L4-1-24G': 0.7875,
  'fr-par-2/L40S-1-48G': 1.469916, 'pl-waw-2/L40S-1-48G': 1.469916,
  'fr-par-2/H100-1-80G': 2.8665, 'pl-waw-2/H100-1-80G': 2.8665,
};

function cloud(opts: { outOfStock?: string[]; shortage?: string[]; prices?: Record<string, number> } = {}) {
  const tried: string[] = [];
  const backend = {
    hourlyPrice: async (zone: string, type: string) => (opts.prices ?? PRICES)[`${zone}/${type}`] ?? null,
    availability: async (zone: string, type: string) => (opts.shortage?.includes(`${zone}/${type}`) ? 'shortage' as const : 'available' as const),
  };
  const create = async (spec: DeploymentSpec): Promise<ReplicaMachine> => {
    const key = `${spec.zone}/${spec.machineType}`;
    tried.push(key);
    if (opts.outOfStock?.includes(key)) {
      throw Object.assign(new Error('scaleway HTTP 412: {"type":"out_of_stock","message":"Out of stock"}'), { status: 412 });
    }
    return { id: `${spec.zone}:x`, deployment: spec.name, ip: null, state: 'starting', createdAt: 0, zone: spec.zone, machineType: spec.machineType, pricePerHour: null };
  };
  return { backend, create, tried };
}

const spec = () => buildSpec('tts', { profile: 'qwen3-tts', candidates: LADDER }, { profiles });

describe('placement fallback', () => {
  it('recognises the provider capacity refusals, and nothing else', () => {
    expect(isCapacityError(new Error('scaleway HTTP 412: {"type":"out_of_stock"}'))).toBe(true);
    expect(isCapacityError(new Error('quotas_exceeded for L4'))).toBe(true);
    expect(isCapacityError(new Error('scaleway HTTP 401: denied'))).toBe(false);
  });

  it('the spec takes the first candidate as its zone/type/cap', () => {
    expect(spec()).toMatchObject({ zone: 'fr-par-2', machineType: 'L4-1-24G', maxEurPerHour: 1 });
    expect(candidatesOf(buildSpec('a', { profile: 'qwen3-tts' }, { profiles }))).toEqual([{ zone: 'fr-par-2', machineType: 'L4-1-24G', maxEurPerHour: 1 }]);
  });

  it('L4 out of stock in fr-par-2 → next Paris zone that sells it (fr-par-3 not sold, skipped)', async () => {
    const c = cloud({ outOfStock: ['fr-par-2/L4-1-24G'] });
    const placed = await placeReplica(spec(), c.backend, c.create);
    expect(placed.candidate).toMatchObject({ zone: 'fr-par-1', machineType: 'L4-1-24G' });
    expect(placed.skipped).toEqual([expect.objectContaining({ zone: 'fr-par-2', reason: 'capacity' })]);
  });

  it('no L4 in Paris → L4 elsewhere in the EU, before any dearer tier', async () => {
    const c = cloud({ outOfStock: ['fr-par-2/L4-1-24G'], shortage: ['fr-par-1/L4-1-24G'] });
    const placed = await placeReplica(spec(), c.backend, c.create);
    expect(placed.candidate).toMatchObject({ zone: 'pl-waw-2', machineType: 'L4-1-24G' });
    expect(placed.skipped.map(s => `${s.zone}:${s.reason}`)).toEqual(['fr-par-2:capacity', 'fr-par-1:shortage', 'fr-par-3:not-sold', 'nl-ams-1:not-sold']);
    expect(c.tried).toEqual(['fr-par-2/L4-1-24G', 'pl-waw-2/L4-1-24G']); // shortage and unsold are never created
  });

  it('no L4 anywhere → L40S Paris, then L40S EU, then H100, each under its own cap', async () => {
    const noL4 = ['fr-par-1/L4-1-24G', 'fr-par-2/L4-1-24G', 'pl-waw-2/L4-1-24G'];
    let placed = await placeReplica(spec(), cloud({ outOfStock: noL4 }).backend, cloud({ outOfStock: noL4 }).create);
    expect(placed).toMatchObject({ candidate: { zone: 'fr-par-2', machineType: 'L40S-1-48G' }, price: 1.469916 });
    const c = cloud({ outOfStock: [...noL4, 'fr-par-2/L40S-1-48G'] });
    expect((await placeReplica(spec(), c.backend, c.create)).candidate).toMatchObject({ zone: 'pl-waw-2', machineType: 'L40S-1-48G' });
    const h = cloud({ outOfStock: [...noL4, 'fr-par-2/L40S-1-48G', 'pl-waw-2/L40S-1-48G'] });
    placed = await placeReplica(spec(), h.backend, h.create);
    expect(placed).toMatchObject({ candidate: { zone: 'fr-par-2', machineType: 'H100-1-80G', maxEurPerHour: 3.1 }, price: 2.8665 });
  });

  it('a candidate above its own cap is skipped, never rented', async () => {
    const c = cloud({ prices: { ...PRICES, 'fr-par-2/L4-1-24G': 1.2 } });
    const placed = await placeReplica(spec(), c.backend, c.create);
    expect(placed.skipped[0]).toMatchObject({ zone: 'fr-par-2', reason: 'over-cap' });
    expect(c.tried).toEqual(['fr-par-1/L4-1-24G']);
  });

  it('every candidate refused → PlacementError listing each reason; a non-capacity error stops at once', async () => {
    const all = Object.keys(PRICES);
    const c = cloud({ outOfStock: all });
    await expect(placeReplica(spec(), c.backend, c.create)).rejects.toThrow(PlacementError);
    await expect(placeReplica(spec(), c.backend, c.create)).rejects.toThrow(/H100-1-80G@pl-waw-2: capacity/);
    const tried: string[] = [];
    await expect(placeReplica(spec(), c.backend, async (s) => { tried.push(s.zone); throw new Error('scaleway HTTP 401: denied'); }))
      .rejects.toThrow('401');
    expect(tried).toEqual(['fr-par-2']);
  });

  it('validates the list: shape, duplicates, GPU-only for a GPU spec, at most 40', () => {
    expect(() => buildSpec('a', { profile: 'qwen3-tts', candidates: [{ zone: 'fr-par-2' }] }, { profiles })).toThrow(SpecError);
    expect(() => buildSpec('a', { profile: 'qwen3-tts', candidates: [LADDER[0], LADDER[0]] }, { profiles })).toThrow(/repeats/);
    expect(() => buildSpec('a', { profile: 'qwen3-tts', candidates: [LADDER[0], { zone: 'fr-par-2', machineType: 'DEV1-S', maxEurPerHour: 1 }] }, { profiles }))
      .toThrow(/GPU/);
    expect(buildSpec('a', { profile: 'qwen3-tts', candidates: [] }, { profiles }).candidates).toBeUndefined();
  });
});
