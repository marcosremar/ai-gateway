/**
 * Distance between countries, for placement (`placements.ts`). Latency grows with distance (light in fibre ≈ 1 ms of
 * RTT per 100 km, plus routing), and EU membership says nothing about it: the owner, in France, measured ~60 ms to a
 * Vast host in Slovakia (2026-10-06) — EU, but ~1100 km away and badly peered.
 *
 * Each country is one point: its main datacenter hub (usually the capital, Frankfurt for DE, Milan for IT, Zurich for
 * CH, Ashburn for US), not its geometric centre — hosts and users cluster there, so the hub-to-hub distance is
 * what the packets travel (Paris → Amsterdam ≈ 430 km, Paris → Warsaw ≈ 1370 km). Unknown country = infinitely far.
 */

/** [latitude, longitude] of each country's main hub. All of Europe/EEA plus the usual non-EU hosting countries. */
export const COUNTRY_HUBS: Readonly<Record<string, readonly [number, number]>> = {
  // EU / EEA
  FR: [48.86, 2.35], BE: [50.85, 4.35], LU: [49.61, 6.13], NL: [52.37, 4.9], DE: [50.11, 8.68], AT: [48.21, 16.37],
  IT: [45.46, 9.19], ES: [40.42, -3.7], PT: [38.72, -9.14], IE: [53.35, -6.26], DK: [55.68, 12.57], SE: [59.33, 18.07],
  FI: [60.17, 24.94], NO: [59.91, 10.75], IS: [64.15, -21.94], PL: [52.23, 21.01], CZ: [50.08, 14.44], SK: [48.15, 17.11],
  HU: [47.5, 19.04], SI: [46.06, 14.51], HR: [45.81, 15.98], RO: [44.43, 26.1], BG: [42.7, 23.32], GR: [37.98, 23.73],
  CY: [35.17, 33.36], MT: [35.9, 14.51], EE: [59.44, 24.75], LV: [56.95, 24.11], LT: [54.69, 25.28], LI: [47.14, 9.52],
  // Rest of Europe and neighbours
  GB: [51.51, -0.13], CH: [47.37, 8.54], MC: [43.74, 7.42], AD: [42.51, 1.52], RS: [44.79, 20.45], BA: [43.86, 18.41],
  ME: [42.44, 19.26], MK: [41.99, 21.43], AL: [41.33, 19.82], MD: [47.01, 28.86], UA: [50.45, 30.52], BY: [53.9, 27.56],
  TR: [41.01, 28.98], IL: [32.08, 34.78], RU: [55.76, 37.62], GE: [41.72, 44.79], MA: [33.57, -7.59],
  // Main non-European hosting countries
  US: [39.04, -77.49], CA: [45.5, -73.57], MX: [19.43, -99.13], BR: [-23.55, -46.63], AR: [-34.6, -58.38],
  IN: [19.08, 72.88], SG: [1.35, 103.82], HK: [22.32, 114.17], TW: [25.03, 121.57], JP: [35.68, 139.69],
  KR: [37.57, 126.98], CN: [31.23, 121.47], TH: [13.76, 100.5], VN: [10.82, 106.63], ID: [-6.21, 106.85],
  AU: [-33.87, 151.21], NZ: [-36.85, 174.76], ZA: [-26.2, 28.05], AE: [25.2, 55.27], SA: [24.71, 46.68],
};

const EARTH_RADIUS_KM = 6371;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle (haversine) distance in km between two countries' hubs; `Infinity` when either is unknown. */
export function countryDistanceKm(from: string | null | undefined, to: string | null | undefined): number {
  const a = from ? COUNTRY_HUBS[from.toUpperCase()] : undefined;
  const b = to ? COUNTRY_HUBS[to.toUpperCase()] : undefined;
  if (!a || !b) return Infinity;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h))));
}
