import { describe, expect, it } from 'vitest';
import {
  countryOf, distanceBucket, effectivePrice, isOutOfStock, MAX_NEAR_KM, rankCandidates, rankOffers, zoneCountry, type VastOffer,
} from '../../../src/deployments/placements';
import { countryDistanceKm } from '../../../src/deployments/geo';
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

  it('great-circle distance between hubs: Paris → Amsterdam ~430 km, → Warsaw ~1370 km; unknown = far', () => {
    expect(countryDistanceKm('FR', 'FR')).toBe(0);
    expect(countryDistanceKm('FR', 'NL')).toBeGreaterThan(400);
    expect(countryDistanceKm('FR', 'NL')).toBeLessThan(460);
    expect(countryDistanceKm('FR', 'PL')).toBeGreaterThan(1330);
    expect(countryDistanceKm('FR', 'PL')).toBeLessThan(1410);
    expect(countryDistanceKm('FR', 'ZZ')).toBe(Infinity);
    expect(countryDistanceKm('FR', 'US')).toBeGreaterThan(MAX_NEAR_KM);
    expect(distanceBucket('FR', 'FR')).toBe(0);
    expect(distanceBucket('SK', 'FR')).toBe(2); // ~1090 km: the owner measured ~60 ms to a Slovak host
    expect(distanceBucket(null, 'FR')).toBe(Infinity);
  });
});

describe('rankOffers', () => {
  it('a French host beats a cheaper US one (a far host drops out while anything near exists)', () => {
    const ranked = rankOffers([offer(1, 'Dallas, US', 0.30), offer(2, 'Paris, FR', 0.55)], { near: 'FR', allowFar: true });
    expect(ranked.map(o => o.id)).toEqual([2]);
  });

  it('far hosts are excluded unless nothing near exists AND allowFar', () => {
    expect(rankOffers([offer(1, 'Dallas, US', 0.3), offer(2, 'Warsaw, PL', 0.5)], { near: 'FR', allowFar: true }).map(o => o.id)).toEqual([2]);
    expect(rankOffers([offer(1, 'Somewhere, ZZ', 0.1)], { near: 'FR' })).toEqual([]);
    expect(rankOffers([offer(1, 'Dallas, US', 0.3)], { near: 'FR' })).toEqual([]);
    expect(rankOffers([offer(1, 'Dallas, US', 0.3)], { near: 'FR', allowFar: true }).map(o => o.id)).toEqual([1]);
  });

  it('from France, DE/CH/BE/NL beat SK/PL/RO even when those are cheaper', () => {
    const ranked = rankOffers([
      offer(1, 'Bratislava, SK', 0.20), offer(2, 'Warsaw, PL', 0.22), offer(3, 'Bucharest, RO', 0.18),
      offer(4, 'Frankfurt, DE', 0.50), offer(5, 'Zurich, CH', 0.48), offer(6, 'Brussels, BE', 0.49), offer(7, 'Amsterdam, NL', 0.47),
    ], { near: 'FR' });
    expect(ranked.slice(0, 4).map(o => o.id).sort()).toEqual([4, 5, 6, 7]);
    expect(ranked.map(o => o.id)).toEqual([7, 5, 6, 4, 1, 2, 3]);
  });

  it('a different near changes the order: from Poland, SK and PL come first', () => {
    const ranked = rankOffers([
      offer(1, 'Bratislava, SK', 0.30), offer(2, 'Warsaw, PL', 0.40), offer(4, 'Frankfurt, DE', 0.35), offer(7, 'Amsterdam, NL', 0.10),
    ], { near: 'PL' });
    expect(ranked.map(o => o.id)).toEqual([2, 1, 4, 7]);
  });

  it('within a band a reliable host beats a slightly cheaper unreliable one', () => {
    // 0.40 × (1 + 4 × 0.04) = 0.464 > 0.42 × (1 + 4 × 0.005) = 0.4284
    const ranked = rankOffers([offer(1, 'Lyon, FR', 0.40, 0.96), offer(2, 'Paris, FR', 0.42, 0.995)], { near: 'FR' });
    expect(ranked.map(o => o.id)).toEqual([2, 1]);
    expect(effectivePrice({ dph_total: 1, reliability2: 1 })).toBe(1);
  });

  it('inside the same 500-km band the users\' country goes first, then price decides (Brussels beats a pricier Amsterdam); ties break on bandwidth', () => {
    const ranked = rankOffers([
      offer(1, 'Brussels, BE', 0.2), offer(2, 'Paris, FR', 0.5, 0.99, 600), offer(3, 'Paris, FR', 0.5, 0.99, 2000),
      offer(4, 'Madrid, ES', 0.1), offer(5, 'Amsterdam, NL', 0.3),
    ], { near: 'FR' });
    expect(ranked.map(o => o.id)).toEqual([3, 2, 1, 5, 4]);
    expect(rankOffers([offer(1, 'London, GB', 0.2), offer(2, 'Paris, FR', 0.5)], { near: 'GB' }).map(o => o.id)).toEqual([1, 2]);
  });

  it('a host that already passed the RTT gate sorts first, by measured RTT in 5-ms bands, then in the usual order', () => {
    const market = [
      offer(1, 'Paris, FR', 0.3), offer(2, 'London, GB', 0.6), offer(3, 'Warsaw, PL', 0.7), offer(4, 'Brussels, BE', 0.2), offer(5, 'Dallas, US', 0.1),
    ];
    const ids = (knownRtt: Map<number, number>) => rankOffers(market, { near: 'FR', knownRtt }).map(o => o.id);
    expect(ids(new Map())).toEqual([1, 4, 2, 3]);
    expect(ids(new Map([[20, 44]]))).toEqual([2, 1, 4, 3]);
    expect(ids(new Map([[20, 44], [30, 41]]))).toEqual([2, 3, 1, 4]);
    expect(ids(new Map([[20, 44], [30, 38]]))).toEqual([3, 2, 1, 4]);
    expect(ids(new Map([[50, 10]]))).toEqual([1, 4, 2, 3]);
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

  it('closer bands first (fr-par 0 km, nl-ams ~430 km share band 0, pl-waw ~1370 km), cheapest inside; shortage skipped', () => {
    const { ranked, skipped } = rankCandidates([
      { zone: 'pl-waw-2', machineType: 'L4-1-24G', maxEurPerHour: 1 },
      { zone: 'nl-ams-1', machineType: 'L4-1-24G', maxEurPerHour: 1 },
      { zone: 'fr-par-2', machineType: 'L4-1-24G', maxEurPerHour: 1 },
      { zone: 'fr-par-1', machineType: 'L4-1-24G', maxEurPerHour: 1 },
    ], catalog, base);
    expect(ranked.map(c => c.zone)).toEqual(['nl-ams-1', 'fr-par-1', 'pl-waw-2']);
    expect(skipped).toEqual(['scaleway L4-1-24G@fr-par-2: shortage']);
  });

  it('respects each candidate cap and keeps unknown entries priced at their cap', () => {
    const { ranked, skipped } = rankCandidates([
      { zone: 'fr-par-2', machineType: 'L40S-1-48G', maxEurPerHour: 1 },
      { zone: 'fr-par-3', machineType: 'L4-1-24G', maxEurPerHour: 0.9 },
    ], catalog, base);
    expect(skipped[0]).toMatch(/L40S-1-48G@fr-par-2: €1.4\/h over cap €1/);
    expect(ranked).toEqual([expect.objectContaining({ zone: 'fr-par-3', rankPrice: 0.9, bucket: 0 })]);
  });

  it('a Vast candidate ranks after zones within 500 km and before zones 1000+ km away', () => {
    const { ranked } = rankCandidates([
      { zone: 'pl-waw-2', machineType: 'L4-1-24G', maxEurPerHour: 1 },
      { provider: 'vast', machineType: 'RTX 5090', maxEurPerHour: 0.65 },
      { zone: 'nl-ams-1', machineType: 'L4-1-24G', maxEurPerHour: 1 },
      { zone: 'fr-par-1', machineType: 'L4-1-24G', maxEurPerHour: 1 },
    ], catalog, base);
    expect(ranked.map(c => `${c.provider}:${c.zone ?? c.machineType}`))
      .toEqual(['scaleway:nl-ams-1', 'scaleway:fr-par-1', 'vast:RTX 5090', 'scaleway:pl-waw-2']);
  });
});

describe('one out-of-stock detector for both walks', () => {
  it("the Vast backend's no-offer errors read as out of stock (next candidate); quota and credentials do not", () => {
    expect(isOutOfStock(new Error('out_of_stock: no vast offer for RTX 5090 under €0.5/h near FR'))).toBe(true);
    expect(isOutOfStock(new Error('out_of_stock: every vast offer tried was taken (offer 2: not available)'))).toBe(true);
    expect(isOutOfStock(new Error('vast PUT /asks/2/: HTTP 401 unauthorized'))).toBe(false);
    expect(isOutOfStock(Object.assign(new Error('scaleway HTTP 403: quota'), { status: 403 }))).toBe(false);
  });
});
