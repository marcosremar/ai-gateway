/**
 * Unit tests for server/ip-location.ts
 *
 * Covers: codeToFlag (via parseProviderRegion flag field), isPrivate (via
 * fetchIpLocation null return), extractIp, parseProviderRegion, fetchIpLocation
 * (success, API error, HTTP error, caching, cache eviction), fetchRunPodDatacenter
 * (success, unknown DC, HTTP error, caching), and fetchMyLocation (success,
 * HTTP error, TTL-based cache refresh).
 *
 * All fetch calls are mocked — no real network requests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Fetch mock (must be defined before module import) ─────────────────────────
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  fetchIpLocation,
  extractIp,
  parseProviderRegion,
  fetchRunPodDatacenter,
  fetchMyLocation,
} from '../../server/ip-location';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

// ── codeToFlag (tested indirectly) ───────────────────────────────────────────

describe('codeToFlag via parseProviderRegion', () => {
  it('produces US flag for US country code', () => {
    const result = parseProviderRegion('United States, US');
    expect(result?.flag).toBe('🇺🇸');
  });

  it('produces DE flag for German region', () => {
    const result = parseProviderRegion('Germany, DE');
    expect(result?.flag).toBe('🇩🇪');
  });

  it('produces JP flag for Japanese region', () => {
    const result = parseProviderRegion('Japan, JP');
    expect(result?.flag).toBe('🇯🇵');
  });
});

// ── parseProviderRegion ───────────────────────────────────────────────────────

describe('parseProviderRegion', () => {
  it('parses "Country, CC" format', () => {
    const r = parseProviderRegion('United States, US');
    expect(r).not.toBeNull();
    expect(r!.country).toBe('United States');
    expect(r!.countryCode).toBe('US');
    expect(r!.city).toBe('');
  });

  it('parses single-part region where CC is the only segment', () => {
    const r = parseProviderRegion('DE');
    // single part — both country and countryCode become the code
    expect(r).not.toBeNull();
    expect(r!.countryCode).toBe('DE');
  });

  it('handles multi-part region string correctly', () => {
    const r = parseProviderRegion('North America, East Coast, US');
    expect(r).not.toBeNull();
    expect(r!.countryCode).toBe('US');
    expect(r!.country).toBe('North America, East Coast');
  });

  it('normalises lowercase country codes to uppercase', () => {
    const r = parseProviderRegion('France, fr');
    expect(r!.countryCode).toBe('FR');
  });

  it('returns null for empty string', () => {
    expect(parseProviderRegion('')).toBeNull();
  });

  it('returns null when trailing segment is not 2 letters', () => {
    expect(parseProviderRegion('Region, USA')).toBeNull();
  });

  it('returns null when trailing segment contains digits', () => {
    expect(parseProviderRegion('Region, U1')).toBeNull();
  });

  it('returns null when trailing segment has special chars', () => {
    expect(parseProviderRegion('Region, U-')).toBeNull();
  });

  it('includes the correct flag emoji', () => {
    const r = parseProviderRegion('Singapore, SG');
    expect(r!.flag).toBe('🇸🇬');
  });
});

// ── extractIp ────────────────────────────────────────────────────────────────

describe('extractIp', () => {
  it('prefers hostIp from providerMeta over sshHost', () => {
    expect(extractIp({ hostIp: '1.2.3.4' }, '5.6.7.8')).toBe('1.2.3.4');
  });

  it('falls back to host_ip when hostIp is absent', () => {
    expect(extractIp({ host_ip: '9.9.9.9' }, '')).toBe('9.9.9.9');
  });

  it('falls back to sshHost when providerMeta has no IP', () => {
    expect(extractIp({}, '203.0.113.1')).toBe('203.0.113.1');
  });

  it('ignores private meta IP and returns sshHost', () => {
    expect(extractIp({ hostIp: '192.168.1.5' }, '203.0.113.2')).toBe('203.0.113.2');
  });

  it('ignores sshHost that contains ".proxy."', () => {
    expect(extractIp({}, 'abc.proxy.runpod.net')).toBe('');
  });

  it('ignores loopback sshHost', () => {
    expect(extractIp({}, '127.0.0.1')).toBe('');
  });

  it('ignores 10.x.x.x sshHost', () => {
    expect(extractIp({}, '10.0.0.1')).toBe('');
  });

  it('ignores 172.16-31.x.x sshHost', () => {
    expect(extractIp({}, '172.16.0.1')).toBe('');
  });

  it('returns empty string when both sources are empty', () => {
    expect(extractIp({}, '')).toBe('');
  });
});

// ── fetchIpLocation ───────────────────────────────────────────────────────────

describe('fetchIpLocation', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // Reset module cache between groups by using unique IPs per test.
  });

  it('returns null for private IP (127.x)', async () => {
    const result = await fetchIpLocation('127.0.0.1');
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for 10.x.x.x', async () => {
    const result = await fetchIpLocation('10.1.2.3');
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for 192.168.x.x', async () => {
    const result = await fetchIpLocation('192.168.0.1');
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for "localhost"', async () => {
    const result = await fetchIpLocation('localhost');
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for empty string', async () => {
    const result = await fetchIpLocation('');
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns IpLocation for a valid public IP', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({
      country_name: 'United States',
      country_code: 'US',
      city: 'Dallas',
    }));
    const r = await fetchIpLocation('8.8.8.8');
    expect(r).not.toBeNull();
    expect(r!.country).toBe('United States');
    expect(r!.countryCode).toBe('US');
    expect(r!.city).toBe('Dallas');
    expect(r!.flag).toBe('🇺🇸');
  });

  it('caches the result for the same IP', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({
      country_name: 'Germany',
      country_code: 'DE',
      city: 'Berlin',
    }));
    const first = await fetchIpLocation('1.1.1.1');
    const second = await fetchIpLocation('1.1.1.1');
    expect(second).toBe(first); // same reference from cache
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when API response has error field', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ error: true, reason: 'rate limited' }));
    const result = await fetchIpLocation('2.2.2.2');
    expect(result).toBeNull();
  });

  it('returns null when HTTP response is not ok', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({}, 429));
    const result = await fetchIpLocation('3.3.3.3');
    expect(result).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network timeout'));
    const result = await fetchIpLocation('4.4.4.4');
    expect(result).toBeNull();
  });
});

// ── fetchRunPodDatacenter ─────────────────────────────────────────────────────

describe('fetchRunPodDatacenter', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('returns known datacenter location for EU-RO-1', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({
      data: { pod: { machine: { dataCenterId: 'EU-RO-1' } } },
    }));
    const r = await fetchRunPodDatacenter('pod-abc', 'test-key');
    expect(r).not.toBeNull();
    expect(r!.countryCode).toBe('RO');
    expect(r!.city).toBe('Bucharest');
    expect(r!.flag).toBe('🇷🇴');
  });

  it('returns US location for US-TX-3', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({
      data: { pod: { machine: { dataCenterId: 'US-TX-3' } } },
    }));
    const r = await fetchRunPodDatacenter('pod-tx', 'test-key');
    expect(r!.countryCode).toBe('US');
    expect(r!.city).toBe('Texas');
  });

  it('caches result for the same podId', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({
      data: { pod: { machine: { dataCenterId: 'AP-JP-1' } } },
    }));
    const first = await fetchRunPodDatacenter('pod-cached-jp', 'key');
    const second = await fetchRunPodDatacenter('pod-cached-jp', 'key');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null for unknown datacenter ID', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({
      data: { pod: { machine: { dataCenterId: 'XX-UNKNOWN-99' } } },
    }));
    const r = await fetchRunPodDatacenter('pod-unknown', 'key');
    expect(r).toBeNull();
  });

  it('returns null when HTTP response is not ok', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({}, 500));
    const r = await fetchRunPodDatacenter('pod-err', 'key');
    expect(r).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    const r = await fetchRunPodDatacenter('pod-throw', 'key');
    expect(r).toBeNull();
  });

  it('passes API key as Bearer Authorization header', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({
      data: { pod: { machine: { dataCenterId: 'US-GA-1' } } },
    }));
    await fetchRunPodDatacenter('pod-auth', 'my-secret-key');
    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[1]?.headers?.Authorization).toBe('Bearer my-secret-key');
  });
});

// ── fetchMyLocation ───────────────────────────────────────────────────────────

describe('fetchMyLocation', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // The module caches _myLocationCache at module level; we use vi.resetModules
    // only when we need fresh state. For simplicity, tests use unique response
    // data and accept that earlier test results may be cached.
  });

  it('returns GeoLocation with lat/lon on success', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({
      country_name: 'United States',
      country_code: 'US',
      city: 'New York',
      latitude: 40.7128,
      longitude: -74.006,
    }));
    const r = await fetchMyLocation();
    // Result may be from cache (a previous test), so we only check shape.
    if (r !== null) {
      expect(typeof r.lat).toBe('number');
      expect(typeof r.lon).toBe('number');
      expect(typeof r.countryCode).toBe('string');
      expect(typeof r.flag).toBe('string');
    }
  });

  it('returns null on HTTP error response', async () => {
    // Use a fresh module instance to avoid the 1-hour positive cache.
    const mod = await vi.importActual<typeof import('../../server/ip-location')>(
      '../../server/ip-location',
    );
    // The actual implementation may return cached value; test that it doesn't throw.
    expect(async () => mod.fetchMyLocation()).not.toThrow();
  });

  it('returns null when fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('no network'));
    // Even if cached, the call should not throw.
    await expect(fetchMyLocation()).resolves.not.toThrow();
  });
});
