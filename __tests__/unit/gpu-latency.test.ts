// ── gpu-latency unit suite ────────────────────────────────────────────────────
// Covers the pure exported functions parseCountryCode and rankOffers.
// Also exercises probeHostFull (mocked TCP) and scheduleBackgroundProbes.
//
// Network I/O (net.createConnection) and latency-db writes are mocked —
// no real sockets, no real disk or DB access.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GpuOffer } from '../../src/gpu-providers/types';

// ── Mock net module ───────────────────────────────────────────────────────────

vi.mock('net', () => {
  const createConnection = vi.fn();
  return { default: { createConnection }, createConnection };
});

// ── Mock latency-db ───────────────────────────────────────────────────────────

const mockUpsertHostMeta = vi.fn().mockResolvedValue(undefined);
const mockSaveProbeResult = vi.fn().mockResolvedValue(undefined);
const mockGetHostRttMap = vi.fn().mockReturnValue({});

vi.mock('../../server/latency-db', () => ({
  upsertHostMeta: (...args: unknown[]) => mockUpsertHostMeta(...args),
  saveProbeResult: (...args: unknown[]) => mockSaveProbeResult(...args),
  getHostRttMap: (...args: unknown[]) => mockGetHostRttMap(...args),
}));

// ── Mock safe-catch ───────────────────────────────────────────────────────────

vi.mock('../../src/safe-catch', () => ({
  safeCatch: (tag: string) => (err: unknown) => {},
}));

// ── Import SUT ────────────────────────────────────────────────────────────────

import { parseCountryCode, rankOffers, probeHostFull, scheduleBackgroundProbes } from '../../server/gpu-latency';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOffer(overrides: Partial<GpuOffer> = {}): GpuOffer {
  return {
    gpuName: 'RTX 4090',
    gpuType: 'RTX 4090',
    vram: 24,
    pricePerHr: 0.5,
    available: 1,
    provider: 'vast',
    hostId: 'host-1',
    geolocation: 'Frankfurt, DE',
    ...overrides,
  } as GpuOffer;
}

// ── parseCountryCode ─────────────────────────────────────────────────────────

describe('parseCountryCode', () => {
  it('extracts two-letter code from "City, CC" format', () => {
    expect(parseCountryCode('Frankfurt, DE')).toBe('DE');
    expect(parseCountryCode('Paris, FR')).toBe('FR');
    expect(parseCountryCode('Tokyo, JP')).toBe('JP');
  });

  it('handles extra whitespace around code', () => {
    expect(parseCountryCode('Amsterdam,  NL')).toBe('NL');
    expect(parseCountryCode('London , GB')).toBe('GB');
  });

  it('returns empty string for undefined', () => {
    expect(parseCountryCode(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(parseCountryCode('')).toBe('');
  });

  it('returns empty string when no comma present', () => {
    expect(parseCountryCode('Germany')).toBe('');
  });

  it('returns empty string for lowercase cc', () => {
    // Code is uppercased internally but must be 2 letters A-Z
    expect(parseCountryCode('Berlin, de')).toBe('DE');
  });

  it('returns empty string for non-alpha or length != 2', () => {
    expect(parseCountryCode('SomeCity, US3')).toBe('');
    expect(parseCountryCode('SomeCity, U')).toBe('');
    expect(parseCountryCode('SomeCity, USA')).toBe('');
  });

  it('handles city names with multiple commas (uses last segment)', () => {
    expect(parseCountryCode('North, East, US')).toBe('US');
  });

  it('handles known country codes correctly', () => {
    const codes = ['US', 'GB', 'DE', 'FR', 'JP', 'SG', 'AU', 'BR', 'CA', 'NL'];
    for (const cc of codes) {
      expect(parseCountryCode(`City, ${cc}`)).toBe(cc);
    }
  });
});

// ── rankOffers ───────────────────────────────────────────────────────────────

describe('rankOffers', () => {
  it('returns an empty array for empty input', () => {
    expect(rankOffers([], 48.86, 2.35)).toEqual([]);
  });

  it('returns a copy — input is not mutated', () => {
    const offers = [makeOffer({ geolocation: 'Frankfurt, DE' })];
    const result = rankOffers(offers, 48.86, 2.35);
    expect(result).not.toBe(offers);
    expect(offers).toHaveLength(1);
  });

  it('sorts by totalMs ascending', () => {
    // Host-1: US (far from Paris) — expect higher total latency
    // Host-2: DE (near Paris) — expect lower total latency
    const offers = [
      makeOffer({ hostId: 'us-1', geolocation: 'Virginia, US', gpuName: 'RTX 4090' }),
      makeOffer({ hostId: 'de-1', geolocation: 'Frankfurt, DE', gpuName: 'RTX 4090' }),
    ];
    // Client in Paris (lat 48.86, lon 2.35)
    const ranked = rankOffers(offers, 48.86, 2.35);
    expect(ranked[0].hostId).toBe('de-1');
    expect(ranked[1].hostId).toBe('us-1');
    expect(ranked[0].totalMs).toBeLessThanOrEqual(ranked[1].totalMs);
  });

  it('annotates rttSource as "geo" when no host RTT available', () => {
    const offers = [makeOffer({ hostId: 'h1', geolocation: 'Frankfurt, DE' })];
    const [r] = rankOffers(offers, 48.86, 2.35, {}, {});
    expect(r.rttSource).toBe('geo');
  });

  it('annotates rttSource as "host" when host RTT provided', () => {
    const offers = [makeOffer({ hostId: 'h1', geolocation: 'Frankfurt, DE' })];
    const hostRtts = { 'h1': 12 };
    const [r] = rankOffers(offers, 48.86, 2.35, {}, hostRtts);
    expect(r.rttSource).toBe('host');
    expect(r.networkRttMs).toBe(12);
  });

  it('uses host RTT over geo estimate when both available', () => {
    const offer = makeOffer({ hostId: 'h1', geolocation: 'Tokyo, JP' }); // Tokyo far from Paris
    const hostRtts = { 'h1': 5 }; // artificially low RTT
    const [r] = rankOffers([offer], 48.86, 2.35, {}, hostRtts);
    expect(r.networkRttMs).toBe(5);
    expect(r.rttSource).toBe('host');
  });

  it('assigns 10_000km distance for unknown country code', () => {
    const offer = makeOffer({ hostId: 'h1', geolocation: 'Unknown City, XX' });
    const [r] = rankOffers([offer], 0, 0);
    // No coords for XX → distance defaults to 10_000km
    expect(r.distanceKm).toBe(10_000);
    // RTT should be geo estimate from 10_000km distance
    expect(r.networkRttMs).toBeGreaterThan(100);
    expect(r.rttSource).toBe('geo');
  });

  it('assigns countryCode from geolocation field', () => {
    const offers = [
      makeOffer({ hostId: 'a', geolocation: 'Singapore, SG' }),
      makeOffer({ hostId: 'b', geolocation: 'Tokyo, JP' }),
    ];
    const ranked = rankOffers(offers, 0, 0);
    const cc = ranked.map(r => r.countryCode);
    expect(cc).toContain('SG');
    expect(cc).toContain('JP');
  });

  it('uses lower inference time for higher-bandwidth GPU', () => {
    // H100 (3350 GB/s) should have lower inferenceMs than T4 (300 GB/s)
    const h100 = makeOffer({ hostId: 'h100', gpuName: 'H100', geolocation: 'Frankfurt, DE' });
    const t4   = makeOffer({ hostId: 't4',   gpuName: 'T4',   geolocation: 'Frankfurt, DE' });
    const [r1, r2] = rankOffers([h100, t4], 48.86, 2.35);
    expect(r1.inferenceMs).toBeLessThan(r2.inferenceMs);
    expect(r1.gpuName).toBe('H100');
  });

  it('assigns BASELINE_INFERENCE_MS (200ms) for unknown GPU model', () => {
    const offer = makeOffer({ gpuName: 'MYSTERY GPU 9000' });
    const [r] = rankOffers([offer], 48.86, 2.35);
    expect(r.inferenceMs).toBe(200);
  });

  it('totalMs = networkRttMs + inferenceMs', () => {
    const offer = makeOffer({ hostId: 'h1', gpuName: 'RTX 4090' });
    const hostRtts = { 'h1': 30 };
    const [r] = rankOffers([offer], 48.86, 2.35, {}, hostRtts);
    expect(r.totalMs).toBe(r.networkRttMs + r.inferenceMs);
  });

  it('preserves all original offer fields', () => {
    const offer = makeOffer({ hostId: 'h1', vram: 48, pricePerHr: 0.75 });
    const [r] = rankOffers([offer], 48.86, 2.35);
    expect(r.vram).toBe(48);
    expect(r.pricePerHr).toBe(0.75);
  });

  it('handles offers with no geolocation (undefined → empty CC)', () => {
    const offer = makeOffer({ hostId: 'h1', geolocation: undefined });
    expect(() => rankOffers([offer], 48.86, 2.35)).not.toThrow();
    const [r] = rankOffers([offer], 48.86, 2.35);
    expect(r.countryCode).toBe('');
    expect(r.distanceKm).toBe(10_000);
  });

  it('handles multiple offers with same totalMs without crashing', () => {
    const offers = [
      makeOffer({ hostId: 'a', geolocation: 'Frankfurt, DE', gpuName: 'RTX 4090' }),
      makeOffer({ hostId: 'b', geolocation: 'Frankfurt, DE', gpuName: 'RTX 4090' }),
    ];
    const ranked = rankOffers(offers, 48.86, 2.35, {}, { 'a': 15, 'b': 15 });
    expect(ranked).toHaveLength(2);
  });
});

// ── probeHostFull ─────────────────────────────────────────────────────────────

describe('probeHostFull', () => {
  let netMock: typeof import('net');

  beforeEach(async () => {
    netMock = await import('net');
    vi.clearAllMocks();
  });

  function setupSocketFactory(rttMs: number | null) {
    const { createConnection } = netMock as unknown as { createConnection: ReturnType<typeof vi.fn> };
    createConnection.mockImplementation((_opts: unknown, ..._rest: unknown[]) => {
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const socket = {
        on(event: string, cb: (...args: unknown[]) => void) {
          listeners[event] = listeners[event] || [];
          listeners[event].push(cb);
          // Trigger event asynchronously
          if (event === 'connect' && rttMs !== null) {
            setTimeout(() => listeners['connect']?.forEach(f => f()), rttMs);
          }
          if (event === 'error' && rttMs === null) {
            setTimeout(() => listeners['error']?.forEach(f => f(new Error('refused'))), 1);
          }
          return socket;
        },
        once(event: string, cb: (...args: unknown[]) => void) {
          return socket.on(event, cb);
        },
        destroy: vi.fn(),
      };
      return socket;
    });
  }

  it('returns null medianMs / p90Ms when all probes fail', async () => {
    setupSocketFactory(null);
    const result = await probeHostFull('192.0.2.1');
    expect(result.medianMs).toBeNull();
    expect(result.p90Ms).toBeNull();
    expect(result.samples).toBe(0);
  });
});

// ── scheduleBackgroundProbes ──────────────────────────────────────────────────

describe('scheduleBackgroundProbes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertHostMeta.mockResolvedValue(undefined);
    mockSaveProbeResult.mockResolvedValue(undefined);
    mockGetHostRttMap.mockReturnValue({});
  });

  it('skips offers without hostId or hostIp', () => {
    const offers = [
      makeOffer({ hostId: undefined, hostIp: '1.2.3.4' }),
      makeOffer({ hostId: 'h1', hostIp: undefined }),
    ];
    scheduleBackgroundProbes(offers as unknown as GpuOffer[]);
    expect(mockUpsertHostMeta).not.toHaveBeenCalled();
  });

  it('calls upsertHostMeta for each probe-eligible offer', () => {
    const offers = [
      makeOffer({ hostId: 'probe-upsert-1', hostIp: '10.1.0.1', provider: 'vast', gpuName: 'RTX 4090', geolocation: 'Frankfurt, DE', pricePerHr: 0.5 }),
    ];
    scheduleBackgroundProbes(offers);
    expect(mockUpsertHostMeta).toHaveBeenCalledWith('probe-upsert-1', expect.objectContaining({
      hostIp: '10.1.0.1',
      provider: 'vast',
      gpuName: 'RTX 4090',
    }));
  });

  it('does not double-probe the same host concurrently', () => {
    // Use a unique hostId not seen in any prior test to avoid _probing set contamination
    const offers = [
      makeOffer({ hostId: 'probe-dedup-1', hostIp: '10.2.0.1' }),
      makeOffer({ hostId: 'probe-dedup-1', hostIp: '10.2.0.1' }),
    ];
    scheduleBackgroundProbes(offers);
    // First occurrence adds to _probing and calls upsertHostMeta; second is skipped
    expect(mockUpsertHostMeta).toHaveBeenCalledTimes(1);
  });
});
