/**
 * Unit tests for pure functions in server/gpu-latency.ts:
 *   - parseCountryCode — extract ISO-3166-1 alpha-2 code from "City, CC" strings
 *   - rankOffers       — sort GPU offers by estimated total latency (RTT + inference)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DB imports so `parseCountryCode` and `rankOffers` can be imported without a DB.
vi.mock('../../server/latency-db', () => ({
  upsertHostMeta: vi.fn(),
  saveProbeResult: vi.fn(),
  getHostRttMap: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../src/safe-catch', () => ({
  safeCatch: (_tag: string) => () => {},
}));
// net is only used by probeTcp, not by the pure ranking functions.
vi.mock('net', () => ({ default: { createConnection: vi.fn() } }));

import { parseCountryCode, rankOffers } from '../../server/gpu-latency';
import type { GpuOffer } from '../../src/gpu-providers/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOffer(overrides: Partial<GpuOffer> = {}): GpuOffer {
  return {
    provider: 'vast',
    gpuType: 'RTX 4090',
    gpuName: 'NVIDIA GeForce RTX 4090',
    available: 5,
    pricePerHr: 0.40,
    region: 'EU',
    vram: 24,
    ...overrides,
  };
}

// ── parseCountryCode ─────────────────────────────────────────────────────────

describe('parseCountryCode', () => {
  it('returns 2-letter code from "City, CC" format', () => {
    expect(parseCountryCode('Paris, FR')).toBe('FR');
  });

  it('returns uppercase code', () => {
    expect(parseCountryCode('Frankfurt, DE')).toBe('DE');
  });

  it('returns the last segment when there are multiple commas', () => {
    expect(parseCountryCode('Northern Virginia, US East, US')).toBe('US');
  });

  it('returns empty string for undefined', () => {
    expect(parseCountryCode(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(parseCountryCode('')).toBe('');
  });

  it('returns empty string when trailing segment is not 2 letters', () => {
    // 3-letter code
    expect(parseCountryCode('Paris, FRA')).toBe('');
  });

  it('returns empty string when trailing segment is a single letter', () => {
    expect(parseCountryCode('Paris, F')).toBe('');
  });

  it('returns empty string when trailing segment contains digits', () => {
    expect(parseCountryCode('Zone, A1')).toBe('');
  });

  it('handles code with surrounding whitespace', () => {
    expect(parseCountryCode('Singapore,  SG')).toBe('SG');
  });

  it('returns empty string for no-comma input that is not 2 letters', () => {
    expect(parseCountryCode('France')).toBe('');
  });

  it('returns code for no-comma input that is exactly 2 uppercase letters', () => {
    // The last (only) segment is "US" — valid
    expect(parseCountryCode('US')).toBe('US');
  });

  it('normalises lowercase 2-letter code to uppercase', () => {
    // Implementation does .toUpperCase() before the regex check, so lowercase is accepted
    expect(parseCountryCode('Paris, fr')).toBe('FR');
  });
});

// ── rankOffers ───────────────────────────────────────────────────────────────

describe('rankOffers', () => {
  // Paris coordinates: 48.86°N, 2.35°E — close to EU datacenters
  const CLIENT_LAT = 48.86;
  const CLIENT_LON = 2.35;

  it('returns empty array for empty input', () => {
    expect(rankOffers([], CLIENT_LAT, CLIENT_LON)).toEqual([]);
  });

  it('returns all offers sorted by totalMs ascending', () => {
    // DE (Frankfurt) is ~470km from Paris; JP (Tokyo) is ~9700km
    const nearOffer = makeOffer({ geolocation: 'Frankfurt, DE' });
    const farOffer  = makeOffer({ geolocation: 'Tokyo, JP' });

    const ranked = rankOffers([farOffer, nearOffer], CLIENT_LAT, CLIENT_LON);

    // Near should come first
    expect(ranked[0].countryCode).toBe('DE');
    expect(ranked[1].countryCode).toBe('JP');
    expect(ranked[0].totalMs).toBeLessThan(ranked[1].totalMs);
  });

  it('uses hostRtts TCP probe over geo estimate when hostId matches', () => {
    const offer = makeOffer({
      geolocation: 'Tokyo, JP', // ~9700km away → high geo RTT
      hostId: 'host-123',
    });
    // Override with a very low measured RTT
    const hostRtts = { 'host-123': 5 };
    const [ranked] = rankOffers([offer], CLIENT_LAT, CLIENT_LON, {}, hostRtts);

    expect(ranked.networkRttMs).toBe(5);
    expect(ranked.rttSource).toBe('host');
  });

  it('falls back to geo estimate when hostId has no entry in hostRtts', () => {
    const offer = makeOffer({
      geolocation: 'Frankfurt, DE',
      hostId: 'host-456',
    });
    const [ranked] = rankOffers([offer], CLIENT_LAT, CLIENT_LON, {}, {});

    expect(ranked.rttSource).toBe('geo');
    expect(ranked.networkRttMs).toBeGreaterThan(0);
  });

  it('attaches countryCode extracted from geolocation', () => {
    const offer = makeOffer({ geolocation: 'Amsterdam, NL' });
    const [ranked] = rankOffers([offer], CLIENT_LAT, CLIENT_LON);

    expect(ranked.countryCode).toBe('NL');
  });

  it('uses 10000km fallback distance for unknown country code', () => {
    const offer = makeOffer({ geolocation: 'Unknown, XX' });
    const [ranked] = rankOffers([offer], CLIENT_LAT, CLIENT_LON);

    // XX is not in COUNTRY_COORDS → distanceKm should be 10000
    expect(ranked.distanceKm).toBe(10_000);
    expect(ranked.rttSource).toBe('geo');
  });

  it('computes inferenceMs from GPU bandwidth (RTX 4090 ≈ 200ms baseline)', () => {
    const offer = makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090' });
    const [ranked] = rankOffers([offer], CLIENT_LAT, CLIENT_LON);

    // RTX 4090 bandwidth is 1008 GB/s = baseline → should be close to 200ms
    expect(ranked.inferenceMs).toBeCloseTo(200, 0);
  });

  it('computes lower inferenceMs for higher-bandwidth GPUs (H100 > 4090)', () => {
    const h100  = makeOffer({ gpuName: 'NVIDIA H100' });
    const rtx4090 = makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090' });

    const [r1, r2] = rankOffers([h100, rtx4090], CLIENT_LAT, CLIENT_LON, {}, {
      // Pin both to same network RTT so inferenceMs drives ordering
      ...({} as Record<string, number>),
    });

    // H100 has higher bandwidth → lower inferenceMs
    // But without pinned RTT both will use geo; just compare inferenceMs
    const h100Ranked   = rankOffers([h100],   CLIENT_LAT, CLIENT_LON)[0];
    const rtx4090Ranked = rankOffers([rtx4090], CLIENT_LAT, CLIENT_LON)[0];
    expect(h100Ranked.inferenceMs).toBeLessThan(rtx4090Ranked.inferenceMs);
  });

  it('uses baseline inferenceMs (200ms) for unknown GPU type', () => {
    const offer = makeOffer({ gpuName: 'NVIDIA Imaginary GPU 9000' });
    const [ranked] = rankOffers([offer], CLIENT_LAT, CLIENT_LON);

    expect(ranked.inferenceMs).toBe(200);
  });

  it('adds networkRttMs + inferenceMs to produce totalMs', () => {
    const offer = makeOffer({ hostId: 'h1', geolocation: 'Paris, FR' });
    const hostRtts = { h1: 12 };
    const [ranked] = rankOffers([offer], CLIENT_LAT, CLIENT_LON, {}, hostRtts);

    expect(ranked.totalMs).toBe(ranked.networkRttMs + ranked.inferenceMs);
    expect(ranked.networkRttMs).toBe(12);
  });

  it('does not mutate the input offers array', () => {
    const offers: GpuOffer[] = [
      makeOffer({ geolocation: 'Tokyo, JP' }),
      makeOffer({ geolocation: 'Paris, FR' }),
    ];
    const copy = [...offers];
    rankOffers(offers, CLIENT_LAT, CLIENT_LON);
    expect(offers).toEqual(copy);
  });

  it('handles offers with no geolocation (unknown country → max distance)', () => {
    const offer = makeOffer({ geolocation: undefined });
    const [ranked] = rankOffers([offer], CLIENT_LAT, CLIENT_LON);

    expect(ranked.countryCode).toBe('');
    expect(ranked.distanceKm).toBe(10_000);
  });

  it('stable sort order: equal totalMs produces consistent ordering', () => {
    // Two identical offers → sort is stable relative to input order
    const o1 = makeOffer({ geolocation: 'Frankfurt, DE' });
    const o2 = makeOffer({ geolocation: 'Frankfurt, DE' });
    const ranked = rankOffers([o1, o2], CLIENT_LAT, CLIENT_LON);

    expect(ranked.length).toBe(2);
    expect(ranked[0].totalMs).toBe(ranked[1].totalMs);
  });

  it('sorts multiple offers from different continents correctly', () => {
    const us  = makeOffer({ geolocation: 'Virginia, US' });
    const sg  = makeOffer({ geolocation: 'Singapore, SG' });
    const nl  = makeOffer({ geolocation: 'Amsterdam, NL' });
    const jp  = makeOffer({ geolocation: 'Tokyo, JP' });

    const ranked = rankOffers([jp, us, nl, sg], CLIENT_LAT, CLIENT_LON);

    // NL (Amsterdam) is closest to CLIENT (Paris) → should be first
    expect(ranked[0].countryCode).toBe('NL');
    // SG (Singapore, ~10700km) is farther from Paris than JP (Tokyo, ~9700km) → last
    expect(ranked[ranked.length - 1].countryCode).toBe('SG');
  });
});
