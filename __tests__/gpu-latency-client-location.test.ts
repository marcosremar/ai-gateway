/**
 * Client-location aware GPU ranking (server/gpu-latency.ts).
 *
 * The latency that matters is client → GPU. These cover:
 *   - parsing GPU_CLIENT_LOCATION
 *   - region "near" expansion around the client (Lyon)
 *   - gateway-origin TCP probes ignored when the gateway is far from the client
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { GpuOffer } from '../src/gpu-providers/types';

vi.mock('../server/latency-db', () => ({
  upsertHostMeta: async () => {},
  saveProbeResult: async () => {},
  getHostRttMap: async () => ({}),
}));

import {
  parseLatLon,
  getConfiguredClientLocation,
  countriesNear,
  resolveNearRegion,
  rankOffers,
} from '../server/gpu-latency';

const LYON = { lat: 45.76, lon: 4.84 };
const VIRGINIA = { lat: 38.9, lon: -77.04 };

const offer = (hostId: string, geolocation: string, pricePerHr = 0.4): GpuOffer => ({
  provider: 'vast', gpuType: 'RTX 4090', gpuName: 'RTX 4090', available: 1,
  pricePerHr, region: geolocation, vram: 24, geolocation, hostId,
});

describe('parseLatLon / getConfiguredClientLocation', () => {
  afterEach(() => { delete process.env.GPU_CLIENT_LOCATION; });

  it('parses "lat,lon" and rejects garbage', () => {
    expect(parseLatLon('45.76, 4.84')).toEqual(LYON);
    expect(parseLatLon('')).toBeNull();
    expect(parseLatLon('45.76')).toBeNull();
    expect(parseLatLon('abc,4')).toBeNull();
    expect(parseLatLon('95,4')).toBeNull();
    expect(parseLatLon(',4')).toBeNull();
  });

  it('reads GPU_CLIENT_LOCATION', () => {
    expect(getConfiguredClientLocation()).toBeNull();
    process.env.GPU_CLIENT_LOCATION = '45.76,4.84';
    expect(getConfiguredClientLocation()).toEqual(LYON);
  });
});

describe('region "near"', () => {
  it('lists nearby countries around Lyon, nearest first', () => {
    const ccs = countriesNear(LYON);
    expect(ccs.slice(0, 3).sort()).toEqual(['CH', 'FR', 'IT']);
    expect(ccs).toContain('DE');
    expect(ccs).not.toContain('US');
    expect(ccs).not.toContain('RO'); // Bucharest ~1700km
  });

  it('expands near / near:<km> and leaves other regions untouched', () => {
    expect(resolveNearRegion('near:500', LYON)!.split(',').sort()).toEqual(['CH', 'FR', 'IT']);
    expect(resolveNearRegion('NEAR', LYON)).toBe(countriesNear(LYON).join(','));
    expect(resolveNearRegion('FR,CH', LYON)).toBe('FR,CH');
    expect(resolveNearRegion('', null)).toBe('');
  });

  it('needs a client location for near', () => {
    expect(resolveNearRegion('near', null)).toBeNull();
  });

  it('falls back to the single nearest hub instead of "any region"', () => {
    expect(resolveNearRegion('near:1', LYON)).toBe(countriesNear(LYON, Infinity)[0]);
  });
});

describe('rankOffers — probe origin', () => {
  // A host the gateway (in Virginia) measured at 5ms — meaningless for Lyon.
  const offers = [offer('us-host', 'United States, US', 0.3), offer('fr-host', 'France, FR', 0.5)];
  const hostRtts = { 'us-host': 5 };

  it('uses gateway probes when the gateway sits with the client', () => {
    const ranked = rankOffers(offers, VIRGINIA.lat, VIRGINIA.lon, {}, hostRtts, VIRGINIA);
    expect(ranked[0].hostId).toBe('us-host');
    expect(ranked[0].rttSource).toBe('host');
  });

  it('ignores gateway probes when the client is far away (Lyon)', () => {
    const ranked = rankOffers(offers, LYON.lat, LYON.lon, {}, hostRtts, VIRGINIA);
    expect(ranked[0].hostId).toBe('fr-host');
    expect(ranked.every(o => o.rttSource === 'geo')).toBe(true);
  });

  it('keeps legacy behaviour when no probe origin is given', () => {
    const ranked = rankOffers(offers, LYON.lat, LYON.lon, {}, hostRtts);
    expect(ranked[0].hostId).toBe('us-host');
  });
});
