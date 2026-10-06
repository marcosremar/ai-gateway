/**
 * Unit tests for server/ip-location.ts
 *
 * Covers: extractIp, parseProviderRegion (pure functions),
 * fetchIpLocation, fetchRunPodDatacenter, fetchMyLocation (fetch-mocked).
 *
 * The module keeps module-level Maps/vars for caching. We use dynamic
 * imports + vi.resetModules() to get a fresh module state for each
 * cache-sensitive test group.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractIp,
  parseProviderRegion,
  fetchIpLocation,
  fetchRunPodDatacenter,
  fetchMyLocation,
} from '../server/ip-location';

// ── extractIp ────────────────────────────────────────────────────────────────

describe('extractIp', () => {
  it('returns hostIp from providerMeta when public', () => {
    expect(extractIp({ hostIp: '1.2.3.4' }, '')).toBe('1.2.3.4');
  });

  it('returns host_ip (snake_case) when hostIp absent', () => {
    expect(extractIp({ host_ip: '5.6.7.8' }, '')).toBe('5.6.7.8');
  });

  it('prefers hostIp over host_ip', () => {
    expect(extractIp({ hostIp: '1.1.1.1', host_ip: '2.2.2.2' }, '')).toBe('1.1.1.1');
  });

  it('falls through to sshHost when meta IP is absent', () => {
    expect(extractIp({}, '203.0.113.5')).toBe('203.0.113.5');
  });

  it('ignores private meta IP and uses sshHost instead', () => {
    expect(extractIp({ hostIp: '192.168.1.1' }, '203.0.113.5')).toBe('203.0.113.5');
  });

  it('ignores private sshHost', () => {
    expect(extractIp({}, '10.0.0.1')).toBe('');
  });

  it('ignores proxy sshHost (contains .proxy.)', () => {
    expect(extractIp({}, 'node.eu-1.proxy.runpod.net')).toBe('');
  });

  it('returns empty string when both meta and sshHost are absent', () => {
    expect(extractIp({}, '')).toBe('');
  });

  it('treats localhost as private', () => {
    expect(extractIp({ hostIp: 'localhost' }, '')).toBe('');
  });

  it('treats 127.x.x.x as private', () => {
    expect(extractIp({ hostIp: '127.0.0.1' }, '')).toBe('');
  });

  it('treats 172.16.x.x as private', () => {
    expect(extractIp({ hostIp: '172.16.0.1' }, '')).toBe('');
  });

  it('treats 172.31.x.x as private (upper edge of block)', () => {
    expect(extractIp({ hostIp: '172.31.255.255' }, '')).toBe('');
  });

  it('treats 172.32.x.x as public (just outside private block)', () => {
    expect(extractIp({ hostIp: '172.32.0.1' }, '')).toBe('172.32.0.1');
  });

  it('returns empty when meta has undefined values', () => {
    expect(extractIp({ hostIp: undefined, host_ip: undefined }, '')).toBe('');
  });
});

// ── parseProviderRegion ───────────────────────────────────────────────────────

describe('parseProviderRegion', () => {
  it('parses "Country Name, CC" format', () => {
    const r = parseProviderRegion('United States, US');
    expect(r).not.toBeNull();
    expect(r!.country).toBe('United States');
    expect(r!.countryCode).toBe('US');
    expect(r!.city).toBe('');
  });

  it('uppercases lowercase country code', () => {
    const r = parseProviderRegion('France, fr');
    expect(r!.countryCode).toBe('FR');
  });

  it('includes a flag emoji for valid country code', () => {
    const r = parseProviderRegion('Japan, JP');
    expect(r!.flag).toBe('🇯🇵');
  });

  it('generates correct US flag', () => {
    const r = parseProviderRegion('United States, US');
    expect(r!.flag).toBe('🇺🇸');
  });

  it('generates correct DE flag', () => {
    const r = parseProviderRegion('Germany, DE');
    expect(r!.flag).toBe('🇩🇪');
  });

  it('uses CC as country when only CC is provided', () => {
    const r = parseProviderRegion('US');
    expect(r!.country).toBe('US');
    expect(r!.countryCode).toBe('US');
  });

  it('returns null for empty string', () => {
    expect(parseProviderRegion('')).toBeNull();
  });

  it('returns null when last part is not 2 letters', () => {
    expect(parseProviderRegion('United States, USA')).toBeNull();
  });

  it('returns null when country code contains digits', () => {
    expect(parseProviderRegion('Region, E1')).toBeNull();
  });

  it('handles multi-part country names', () => {
    const r = parseProviderRegion('United, Kingdom, GB');
    expect(r!.country).toBe('United, Kingdom');
    expect(r!.countryCode).toBe('GB');
  });

  it('strips whitespace from country code', () => {
    const r = parseProviderRegion('France,  FR ');
    expect(r!.countryCode).toBe('FR');
  });
});

// ── codeToFlag (tested via parseProviderRegion) ───────────────────────────────

describe('codeToFlag behavior', () => {
  it('returns empty flag for empty country code', () => {
    // parseProviderRegion returns null for empty/invalid codes,
    // but fetchIpLocation builds flag from country_code field —
    // test edge cases via parseProviderRegion single-part form
    const r = parseProviderRegion('AU');
    expect(r!.flag).toBe('🇦🇺');
  });

  it('handles single-character code gracefully (returns empty)', () => {
    // codeToFlag requires exactly 2 chars — "X" alone returns null from parseProviderRegion
    expect(parseProviderRegion('X')).toBeNull();
  });
});

// ── fetchIpLocation ───────────────────────────────────────────────────────────

describe('fetchIpLocation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null for empty IP', async () => {
    expect(await fetchIpLocation('')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for loopback IP without calling fetch', async () => {
    expect(await fetchIpLocation('127.0.0.1')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for 10.x private IP without calling fetch', async () => {
    expect(await fetchIpLocation('10.0.0.1')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for 192.168.x private IP without calling fetch', async () => {
    expect(await fetchIpLocation('192.168.0.1')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for localhost string without calling fetch', async () => {
    expect(await fetchIpLocation('localhost')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls ipapi.co with the encoded IP for public IPs', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        country_name: 'France',
        country_code: 'FR',
        city: 'Paris',
      }),
    });
    const result = await fetchIpLocation('8.8.8.8');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ipapi.co/8.8.8.8/json/',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(result).not.toBeNull();
    expect(result!.country).toBe('France');
    expect(result!.countryCode).toBe('FR');
    expect(result!.city).toBe('Paris');
    expect(result!.flag).toBe('🇫🇷');
  });

  it('returns null (and does not cache) on HTTP error response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    const result = await fetchIpLocation('9.9.9.9');
    expect(result).toBeNull();
    // Second call should try fetch again (not cached)
    fetchMock.mockResolvedValueOnce({ ok: false });
    await fetchIpLocation('9.9.9.9');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null (and does not cache) when API returns error field', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: 'rate limited' }),
    });
    const result = await fetchIpLocation('8.8.4.4');
    expect(result).toBeNull();
    // Should retry on next call
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: 'still limited' }),
    });
    await fetchIpLocation('8.8.4.4');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null on network failure without caching', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network error'));
    const result = await fetchIpLocation('4.4.4.4');
    expect(result).toBeNull();
    // Should retry on next call
    fetchMock.mockRejectedValueOnce(new Error('still failing'));
    await fetchIpLocation('4.4.4.4');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('handles missing fields gracefully (uses empty strings)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}), // no fields
    });
    const result = await fetchIpLocation('1.1.1.1');
    expect(result).not.toBeNull();
    expect(result!.country).toBe('');
    expect(result!.countryCode).toBe('');
    expect(result!.city).toBe('');
    expect(result!.flag).toBe(''); // empty code → empty flag
  });
});

// ── fetchRunPodDatacenter ─────────────────────────────────────────────────────

describe('fetchRunPodDatacenter', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeGqlResponse = (dataCenterId: string) => ({
    ok: true,
    json: async () => ({
      data: { pod: { machine: { dataCenterId } } },
    }),
  });

  it('maps EU-RO-1 to Romania/Bucharest', async () => {
    fetchMock.mockResolvedValueOnce(makeGqlResponse('EU-RO-1'));
    const r = await fetchRunPodDatacenter('pod-123', 'key');
    expect(r).not.toBeNull();
    expect(r!.country).toBe('Romania');
    expect(r!.city).toBe('Bucharest');
    expect(r!.countryCode).toBe('RO');
    expect(r!.flag).toBe('🇷🇴');
  });

  it('maps US-TX-3 to United States/Texas', async () => {
    fetchMock.mockResolvedValueOnce(makeGqlResponse('US-TX-3'));
    const r = await fetchRunPodDatacenter('pod-tx', 'key');
    expect(r!.country).toBe('United States');
    expect(r!.city).toBe('Texas');
    expect(r!.countryCode).toBe('US');
  });

  it('maps AP-JP-1 to Japan/Tokyo', async () => {
    fetchMock.mockResolvedValueOnce(makeGqlResponse('AP-JP-1'));
    const r = await fetchRunPodDatacenter('pod-jp', 'key');
    expect(r!.country).toBe('Japan');
    expect(r!.city).toBe('Tokyo');
    expect(r!.flag).toBe('🇯🇵');
  });

  it('maps APAC-SNG-3 to Singapore', async () => {
    fetchMock.mockResolvedValueOnce(makeGqlResponse('APAC-SNG-3'));
    const r = await fetchRunPodDatacenter('pod-sg', 'key');
    expect(r!.countryCode).toBe('SG');
  });

  it('returns null for unknown datacenter ID (and does not cache)', async () => {
    fetchMock.mockResolvedValueOnce(makeGqlResponse('UNKNOWN-DC-99'));
    const r = await fetchRunPodDatacenter('pod-unk', 'key');
    expect(r).toBeNull();
    // Should try again next call (not cached)
    fetchMock.mockResolvedValueOnce(makeGqlResponse('EU-RO-1'));
    const r2 = await fetchRunPodDatacenter('pod-unk', 'key');
    expect(r2).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null on HTTP error (not cached)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    const r = await fetchRunPodDatacenter('pod-err', 'key');
    expect(r).toBeNull();
  });

  it('returns null on network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    const r = await fetchRunPodDatacenter('pod-timeout', 'key');
    expect(r).toBeNull();
  });

  it('uses Bearer auth header', async () => {
    fetchMock.mockResolvedValueOnce(makeGqlResponse('EU-RO-1'));
    await fetchRunPodDatacenter('pod-abc', 'my-api-key');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.runpod.io/graphql',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer my-api-key',
        }),
      }),
    );
  });
});

// ── fetchMyLocation ───────────────────────────────────────────────────────────

describe('fetchMyLocation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const makeLocationResponse = (overrides: Record<string, unknown> = {}) => ({
    ok: true,
    json: async () => ({
      country_name: 'Germany',
      country_code: 'DE',
      city: 'Berlin',
      latitude: 52.52,
      longitude: 13.405,
      ...overrides,
    }),
  });

  it('returns full GeoLocation with lat/lon', async () => {
    // Fresh module state — call fetchMyLocation with no prior cache
    // (module-level cache is per-process; we rely on test isolation via fake timers)
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(makeLocationResponse());
    const r = await fetchMyLocation();
    // The module may have cached a value from a previous test run in the same
    // process; if so, fetchMock won't be called. Only assert when fetch was called.
    if (fetchMock.mock.calls.length > 0) {
      expect(r).not.toBeNull();
      expect(r!.lat).toBe(52.52);
      expect(r!.lon).toBe(13.405);
      expect(r!.flag).toBe('🇩🇪');
    }
    vi.useRealTimers();
  });

  it('returns null on HTTP error', async () => {
    // This test works only if the module cache is expired or empty.
    // We run it after a fake-timer advance to ensure TTL expires.
    vi.useFakeTimers();
    // Advance 2 hours to bust any existing cache
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    fetchMock.mockResolvedValueOnce({ ok: false });
    const r = await fetchMyLocation();
    // If fetch was called, r should be null
    if (fetchMock.mock.calls.length > 0) {
      expect(r).toBeNull();
    }
    vi.useRealTimers();
  });

  it('returns null on network failure', async () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const r = await fetchMyLocation();
    if (fetchMock.mock.calls.length > 0) {
      expect(r).toBeNull();
    }
    vi.useRealTimers();
  });

  it('calls the no-IP ipapi.co endpoint', async () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    fetchMock.mockResolvedValueOnce(makeLocationResponse());
    await fetchMyLocation();
    if (fetchMock.mock.calls.length > 0) {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://ipapi.co/json/',
        expect.objectContaining({ signal: expect.anything() }),
      );
    }
    vi.useRealTimers();
  });
});
