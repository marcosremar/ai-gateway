/**
 * Great-circle distance from a fixed site to cloud zones. A prior for where to place a replica BEFORE renting
 * anything: fibre carries a signal at ~200 km/ms one way, so the round trip is at best distance / 100 ms, and real
 * routes add a few ms. It picks the candidates; `endpoint-latency.ts` then measures the ones that exist.
 */
export interface GeoPoint { lat: number; lon: number }

export const SITES = {
  lyon: { lat: 45.764, lon: 4.836 },
  paris: { lat: 48.857, lon: 2.352 },
} as const satisfies Record<string, GeoPoint>;

/** Metro area of each Scaleway zone prefix (zones are `<region>-<n>`, all zones of a region share a metro). */
export const SCALEWAY_REGION_POINTS: Record<string, GeoPoint> = {
  'fr-par': { lat: 48.857, lon: 2.352 },
  'nl-ams': { lat: 52.370, lon: 4.895 },
  'pl-waw': { lat: 52.230, lon: 21.012 },
};

const EARTH_KM = 6371;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/** Best-case round trip over fibre, in ms (real routes are slower; use it to compare zones, not to promise). */
export const fibreRoundTripMs = (km: number): number => km / 100;

export interface ZoneDistance { zone: string; km: number; bestCaseRttMs: number }

/** Scaleway zones (e.g. 'fr-par-2') nearest to `origin` first; zones of an unknown region are dropped. */
export function rankScalewayZonesByDistance(origin: GeoPoint, zones: string[]): ZoneDistance[] {
  return zones
    .flatMap((zone) => {
      const point = SCALEWAY_REGION_POINTS[zone.replace(/-\d+$/, '')];
      if (!point) return [];
      const km = distanceKm(origin, point);
      return [{ zone, km: Math.round(km), bestCaseRttMs: Math.round(fibreRoundTripMs(km) * 10) / 10 }];
    })
    .sort((a, b) => a.km - b.km || a.zone.localeCompare(b.zone));
}
