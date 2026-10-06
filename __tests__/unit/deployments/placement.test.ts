import { describe, expect, it } from 'vitest';
import {
  countryOf, effectivePrice, geoTier, isPlacementMiss, rankCandidates, rankOffers, zoneCountry, type VastOffer,
} from '../../../src/deployments/placement';
import type { CatalogEntry } from '../../../src/deployments/types';

const offer = (id: number, geolocation: string, dph: number, rel = 0.99, down = 1000, machine_id = id * 10): VastOffer =>
  ({ id, geolocation, dph_total: dph, reliability2: rel, inet_down: down, machine_id });

describe('geography', () => {
  it('reads the country after the last comma and the zone prefix', () => {
    expect(countryOf('Paris, FR')).toBe('FR');
    expect(countryOf('Kansas City, Missouri, US')).toBe('US');
    expect(countryOf('')).toBeNull();
    expect(zoneCountry('fr-par-2')).toBe('FR');
    expect(zoneCountry('nl-ams-1')).toBe('NL');
  });

  it('tiers: FR 0, neighbors 1, rest of EU/EEA 2, others 3', () => {
    expect(geoTier('FR', 'FR')).toBe(0);
    expect(['BE', 'LU', 'DE', 'CH', 'NL', 'ES', 'IT', 'GB', 'MC', 'AD'].map(c => geoTier(c, 'FR'))).toEqual(Array(10).fill(1));
    expect(geoTier('PL', 'FR')).toBe(2);
    expect(geoTier('NO', 'FR')).toBe(2);
    expect(geoTier('US', 'FR')).toBe(3);
    expect(geoTier(null, 'FR')).toBe(3);
  });
});

describe('rankOffers', () => {
  it('a French host beats a cheaper US one (a far host drops out while anything near exists)', () => {
    const ranked = rankOffers([offer(1, 'Dallas, US', 0.30), offer(2, 'Paris, FR', 0.55)], { near: 'FR', allowFar: true });
    expect(ranked.map(o => o.id)).toEqual([2]);
  });

  it('far hosts are excluded unless nothing near exists AND allowFar', () => {
    expect(rankOffers([offer(1, 'Dallas, US', 0.3), offer(2, 'Warsaw, PL', 0.5)], { near: 'FR', allowFar: true }).map(o => o.id)).toEqual([2]);
    expect(rankOffers([offer(1, 'Dallas, US', 0.3)], { near: 'FR' })).toEqual([]);
    expect(rankOffers([offer(1, 'Dallas, US', 0.3)], { near: 'FR', allowFar: true }).map(o => o.id)).toEqual([1]);
  });

  it('within a tier a reliable host beats a slightly cheaper unreliable one', () => {
    // 0.40 × (1 + 4 × 0.04) = 0.464 > 0.42 × (1 + 4 × 0.005) = 0.4284
    const ranked = rankOffers([offer(1, 'Lyon, FR', 0.40, 0.96), offer(2, 'Paris, FR', 0.42, 0.995)], { near: 'FR' });
    expect(ranked.map(o => o.id)).toEqual([2, 1]);
    expect(effectivePrice({ dph_total: 1, reliability2: 1 })).toBe(1);
  });

  it('a neighbor never beats France, and ties break on download bandwidth', () => {
    const ranked = rankOffers([
      offer(1, 'Brussels, BE', 0.2), offer(2, 'Paris, FR', 0.5, 0.99, 600), offer(3, 'Paris, FR', 0.5, 0.99, 2000),
    ], { near: 'FR' });
    expect(ranked.map(o => o.id)).toEqual([3, 2, 1]);
  });

  it('skips hosts that failed to boot recently', () => {
    expect(rankOffers([offer(1, 'Paris, FR', 0.3), offer(2, 'Paris, FR', 0.4)], { near: 'FR', avoidMachines: new Set([10]) }).map(o => o.id))
      .toEqual([2]);
  });
});

describe('rankCandidates', () => {
  const base = { near: 'FR', defaultProvider: 'scaleway' as const, defaultZone: 'fr-par-2' };
  const catalog: CatalogEntry[] = [
    { zone: 'fr-par-2', machineType: 'L4-1-24G', hourlyPrice: 0.75, availability: 'shortage' },
    { zone: 'fr-par-1', machineType: 'L4-1-24G', hourlyPrice: 0.80, availability: 'available' },
    { zone: 'nl-ams-1', machineType: 'L4-1-24G', hourlyPrice: 0.70, availability: 'available' },
    { zone: 'pl-waw-2', machineType: 'L4-1-24G', hourlyPrice: 0.60, availability: 'available' },
    { zone: 'fr-par-2', machineType: 'L40S-1-48G', hourlyPrice: 1.4, availability: 'available' },
  ];

  it('France first, then neighbors, then the rest of the EU; shortage zones skipped', () => {
    const { ranked, skipped } = rankCandidates([
      { zone: 'pl-waw-2', machineType: 'L4-1-24G', maxEurPerHour: 1 },
      { zone: 'nl-ams-1', machineType: 'L4-1-24G', maxEurPerHour: 1 },
      { zone: 'fr-par-2', machineType: 'L4-1-24G', maxEurPerHour: 1 },
      { zone: 'fr-par-1', machineType: 'L4-1-24G', maxEurPerHour: 1 },
    ], catalog, base);
    expect(ranked.map(c => c.zone)).toEqual(['fr-par-1', 'nl-ams-1', 'pl-waw-2']);
    expect(skipped).toEqual(['scaleway L4-1-24G@fr-par-2: shortage']);
  });

  it('respects each candidate cap and keeps unknown entries priced at their cap', () => {
    const { ranked, skipped } = rankCandidates([
      { zone: 'fr-par-2', machineType: 'L40S-1-48G', maxEurPerHour: 1 },
      { zone: 'fr-par-3', machineType: 'L4-1-24G', maxEurPerHour: 0.9 },
    ], catalog, base);
    expect(skipped[0]).toMatch(/L40S-1-48G@fr-par-2: €1.4\/h over cap €1/);
    expect(ranked).toEqual([expect.objectContaining({ zone: 'fr-par-3', rankPrice: 0.9, tier: 0 })]);
  });

  it('a Vast candidate ranks after a French zone and before the rest of the EU; cheapest wins inside a tier', () => {
    const { ranked } = rankCandidates([
      { zone: 'pl-waw-2', machineType: 'L4-1-24G', maxEurPerHour: 1 },
      { provider: 'vast', machineType: 'RTX 5090', maxEurPerHour: 0.65 },
      { zone: 'nl-ams-1', machineType: 'L4-1-24G', maxEurPerHour: 1 },
      { zone: 'fr-par-1', machineType: 'L4-1-24G', maxEurPerHour: 1 },
    ], catalog, base);
    expect(ranked.map(c => `${c.provider}:${c.zone ?? c.machineType}`))
      .toEqual(['scaleway:fr-par-1', 'vast:RTX 5090', 'scaleway:nl-ams-1', 'scaleway:pl-waw-2']);
  });
});

describe('isPlacementMiss', () => {
  it.each(['out_of_stock', 'Out of stock', 'zone in shortage', 'HTTP 412 precondition failed', 'quota exceeded',
    'insufficient capacity', 'L4 is not sold in nl-ams-3', 'no vast offer for RTX 5090'])('%s → next candidate', (msg) => {
    expect(isPlacementMiss(new Error(msg))).toBe(true);
  });
  it('a credential error stops the walk', () => {
    expect(isPlacementMiss(new Error('HTTP 401 unauthorized'))).toBe(false);
    expect(isPlacementMiss(Object.assign(new Error('precondition'), { status: 412 }))).toBe(true);
  });
});
