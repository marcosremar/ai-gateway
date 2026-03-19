/**
 * IP geolocation + RunPod datacenter lookup for the GPU Status card.
 * IP geolocation: ipapi.co (free, HTTPS, no key, 30k req/month).
 * RunPod datacenters: GraphQL query → static map.
 */

export interface IpLocation {
  country: string;      // "United States"
  countryCode: string;  // "US"
  city: string;         // "Dallas"
  flag: string;         // "🇺🇸"
  lat?: number;         // latitude (populated by fetchMyLocation)
  lon?: number;         // longitude
}

export interface GeoLocation extends IpLocation {
  lat: number;
  lon: number;
}

// In-memory cache — IPs / pod IDs don't change during a session
const _cache = new Map<string, IpLocation | null>();

/** Convert ISO 3166-1 alpha-2 country code to flag emoji. */
function codeToFlag(code: string): string {
  if (!code || code.length !== 2) return '';
  const A = 0x1F1E6 - 0x41;
  return String.fromCodePoint(code.charCodeAt(0) + A, code.charCodeAt(1) + A);
}

/** Returns true for private/loopback IPs that can't be geolocated. */
function isPrivate(ip: string): boolean {
  return !ip
    || ip === 'localhost'
    || ip.startsWith('127.')
    || ip.startsWith('10.')
    || ip.startsWith('192.168.')
    || ip.match(/^172\.(1[6-9]|2\d|3[01])\./) !== null;
}

// ── IP geolocation ───────────────────────────────────────────────────────────

/**
 * Lookup geolocation for a public IP via ipapi.co.
 * Returns null for private IPs or on lookup failure.
 */
export async function fetchIpLocation(ip: string): Promise<IpLocation | null> {
  if (!ip || isPrivate(ip)) return null;
  if (_cache.has(ip)) return _cache.get(ip)!;

  try {
    const res = await fetch(
      `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) { _cache.set(ip, null); return null; }
    const d = await res.json() as Record<string, unknown>;
    if (d.error) { _cache.set(ip, null); return null; }

    const loc: IpLocation = {
      country: String(d.country_name || ''),
      countryCode: String(d.country_code || ''),
      city: String(d.city || ''),
      flag: codeToFlag(String(d.country_code || '')),
    };
    _cache.set(ip, loc);
    return loc;
  } catch {
    _cache.set(ip, null);
    return null;
  }
}

/** Extract the best IP from deploy state metadata for geolocation. */
export function extractIp(providerMeta: Record<string, unknown>, sshHost: string): string {
  const fromMeta = String(providerMeta?.hostIp || providerMeta?.host_ip || '');
  if (fromMeta && !isPrivate(fromMeta)) return fromMeta;
  if (sshHost && !isPrivate(sshHost) && !sshHost.includes('.proxy.')) return sshHost;
  return '';
}

// ── RunPod datacenter lookup ─────────────────────────────────────────────────

/** Static map of known RunPod datacenter IDs → location. */
const RUNPOD_DC: Record<string, { country: string; countryCode: string; city: string }> = {
  'EU-RO-1':    { country: 'Romania',        countryCode: 'RO', city: 'Bucharest'  },
  'EU-RO-2':    { country: 'Romania',        countryCode: 'RO', city: 'Bucharest'  },
  'EU-RO-3':    { country: 'Romania',        countryCode: 'RO', city: 'Bucharest'  },
  'US-KY-3':    { country: 'United States',  countryCode: 'US', city: 'Kentucky'   },
  'US-TX-3':    { country: 'United States',  countryCode: 'US', city: 'Texas'      },
  'US-GA-1':    { country: 'United States',  countryCode: 'US', city: 'Georgia'    },
  'US-OR-1':    { country: 'United States',  countryCode: 'US', city: 'Oregon'     },
  'CA-MTL-1':   { country: 'Canada',         countryCode: 'CA', city: 'Montreal'   },
  'EU-NL-1':    { country: 'Netherlands',    countryCode: 'NL', city: 'Amsterdam'  },
  'EU-SE-1':    { country: 'Sweden',         countryCode: 'SE', city: 'Stockholm'  },
  'EU-CZ-1':    { country: 'Czech Republic', countryCode: 'CZ', city: 'Prague'     },
  'OC-AU-1':    { country: 'Australia',      countryCode: 'AU', city: 'Sydney'     },
  'AP-JP-1':    { country: 'Japan',          countryCode: 'JP', city: 'Tokyo'      },
  'AP-SG-1':    { country: 'Singapore',      countryCode: 'SG', city: 'Singapore'  },
  'APAC-SNG-3': { country: 'Singapore',      countryCode: 'SG', city: 'Singapore'  },
  'AX-MIA-1':   { country: 'United States',  countryCode: 'US', city: 'Miami'      },
  'AX-MN-1':    { country: 'United States',  countryCode: 'US', city: 'Minnesota'  },
};

/**
 * Query RunPod GraphQL to get the pod's datacenter, then map to IpLocation.
 * Result is cached per podId.
 */
export async function fetchRunPodDatacenter(podId: string, apiKey: string): Promise<IpLocation | null> {
  const cacheKey = `runpod:${podId}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey)!;

  try {
    const gql = `{ pod(input: {podId: "${podId}"}) { machine { dataCenterId } } }`;
    const res = await fetch('https://api.runpod.io/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query: gql }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) { _cache.set(cacheKey, null); return null; }

    const json = await res.json() as Record<string, unknown>;
    const dcId = (json?.data as Record<string, unknown>)?.pod as Record<string, unknown>;
    const dataCenterId = String(
      ((dcId?.machine as Record<string, unknown>)?.dataCenterId) || ''
    );

    const dc = RUNPOD_DC[dataCenterId];
    if (!dc) { _cache.set(cacheKey, null); return null; }

    const loc: IpLocation = { ...dc, flag: codeToFlag(dc.countryCode) };
    _cache.set(cacheKey, loc);
    return loc;
  } catch {
    _cache.set(cacheKey, null);
    return null;
  }
}

// ── Gateway own-location lookup ──────────────────────────────────────────────

interface LocationCacheEntry { loc: GeoLocation | null; fetchedAt: number; }
let _myLocationCache: LocationCacheEntry | undefined;
const LOCATION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const LOCATION_ERROR_TTL_MS = 5 * 60 * 1000;  // 5 min retry on failure

/**
 * Fetch the gateway's own geographic location by resolving its external IP.
 * ipapi.co/json/ (no IP param) returns the caller's location including lat/lon.
 * Cached for 1 hour (5 min on error to allow retry).
 */
export async function fetchMyLocation(): Promise<GeoLocation | null> {
  if (_myLocationCache !== undefined) {
    const ttl = _myLocationCache.loc ? LOCATION_CACHE_TTL_MS : LOCATION_ERROR_TTL_MS;
    if (Date.now() - _myLocationCache.fetchedAt < ttl) return _myLocationCache.loc;
  }
  try {
    const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(4000) });
    if (!res.ok) { _myLocationCache = { loc: null, fetchedAt: Date.now() }; return null; }
    const d = await res.json() as Record<string, unknown>;
    if (d.error) { _myLocationCache = { loc: null, fetchedAt: Date.now() }; return null; }
    const loc: GeoLocation = {
      country: String(d.country_name || ''),
      countryCode: String(d.country_code || ''),
      city: String(d.city || ''),
      flag: codeToFlag(String(d.country_code || '')),
      lat: Number(d.latitude) || 0,
      lon: Number(d.longitude) || 0,
    };
    _myLocationCache = { loc, fetchedAt: Date.now() };
    return loc;
  } catch {
    _myLocationCache = { loc: null, fetchedAt: Date.now() };
    return null;
  }
}

/**
 * Parse Vast.ai / TensorDock region strings like "United States, US" into IpLocation.
 * Returns null if the string doesn't contain a recognizable country code.
 */
export function parseProviderRegion(region: string): IpLocation | null {
  if (!region) return null;
  const parts = region.split(',');
  const cc = parts[parts.length - 1].trim();
  if (cc.length !== 2 || !cc.match(/^[A-Za-z]{2}$/)) return null;
  const country = parts.length > 1 ? parts.slice(0, -1).join(',').trim() : cc;
  return { country, countryCode: cc.toUpperCase(), city: '', flag: codeToFlag(cc.toUpperCase()) };
}
