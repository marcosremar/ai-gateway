/**
 * Placement: where a replica should run. Pure ranking, no I/O — the Vast backend ranks market offers with
 * `rankOffers`, and the controller orders a spec's `candidates` with `rankCandidates`.
 *
 * The owner's three goals, in this order of tie-breaking: reliable, cheap, low latency for users in France.
 * Geography decides the tier (latency is physics: a host in Paris answers in ~5 ms, one in Virginia in ~80 ms);
 * inside a tier, the cheapest *effective* price wins, where an unreliable host is priced as if it cost more.
 */

import type { CatalogEntry, DeploymentProvider, PlacementCandidate } from './types';

export type { CatalogEntry };

/** The owner's region: users (students, teachers) are in France. Used when a spec sets no `near`. */
export const DEFAULT_NEAR = 'FR';

/** Neighbors of France with short, well-peered paths to Paris (≤ ~20 ms): Benelux, DE, CH, ES, IT, GB, MC, AD. */
const FR_NEIGHBORS = new Set(['BE', 'LU', 'DE', 'CH', 'NL', 'ES', 'IT', 'GB', 'MC', 'AD']);

/** EU + EEA: same legal space and typically 20–50 ms from France. */
const EU_EEA = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
]);

/** Tier of a country for users near `near`: 0 same country, 1 neighbor, 2 rest of EU/EEA, 3 far. */
export function geoTier(country: string | null, near: string): 0 | 1 | 2 | 3 {
  const cc = (country ?? '').toUpperCase();
  const home = near.toUpperCase();
  if (!cc) return 3;
  if (cc === home) return 0;
  // The neighbor table is France's; for another `near`, only "same country" and "EU/EEA" are meaningful.
  if (home === 'FR' && FR_NEIGHBORS.has(cc)) return 1;
  if (EU_EEA.has(cc)) return 2;
  return 3;
}

/** Country code of a Vast `geolocation` ("Paris, FR", "Quebec, CA", "FR"): what follows the last comma. */
export function countryOf(geolocation: string | null | undefined): string | null {
  if (!geolocation) return null;
  const cc = geolocation.slice(geolocation.lastIndexOf(',') + 1).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(cc) ? cc : null;
}

// ── Vast offers ─────────────────────────────────────────────────────────────

/** The fields of a Vast `/bundles/` offer the ranking reads. */
export interface VastOffer {
  id: number;
  machine_id?: number;
  dph_total: number;
  reliability2: number;
  inet_down: number;
  geolocation?: string | null;
  gpu_name?: string;
}

/**
 * Weight of unreliability in the effective price: a host at reliability 0.95 is priced 20 % higher than a perfect one
 * (1 + 4 × 0.05). A failed boot costs a whole boot of billed minutes plus the replacement's, so a few % of
 * reliability is worth more than a few cents/h.
 */
export const UNRELIABILITY_WEIGHT = 4;

export function effectivePrice(o: Pick<VastOffer, 'dph_total' | 'reliability2'>): number {
  const r = Math.min(1, Math.max(0, Number(o.reliability2) || 0));
  return o.dph_total * (1 + UNRELIABILITY_WEIGHT * (1 - r));
}

export interface RankOffersOptions {
  near: string;
  /** Allow far (tier 3) offers when no tier ≤ 2 offer exists. */
  allowFar?: boolean;
  /** Host machine ids to leave out (recent boot failures). */
  avoidMachines?: ReadonlySet<number>;
}

/** Offers ordered best first: geography tier, then effective price, then download bandwidth (faster image pull). */
export function rankOffers<T extends VastOffer>(offers: readonly T[], opts: RankOffersOptions): T[] {
  const usable = offers.filter(o => o.machine_id === undefined || !opts.avoidMachines?.has(o.machine_id));
  const tiered = usable.map(o => ({ o, tier: geoTier(countryOf(o.geolocation), opts.near), eff: effectivePrice(o) }));
  const near = tiered.filter(t => t.tier <= 2);
  const pool = near.length ? near : opts.allowFar ? tiered : [];
  return pool
    .sort((a, b) => a.tier - b.tier || a.eff - b.eff || (b.o.inet_down || 0) - (a.o.inet_down || 0))
    .map(t => t.o);
}

// ── Scaleway zones / candidates ─────────────────────────────────────────────

/** Country of a Scaleway zone (`fr-par-2` → FR, `nl-ams-1` → NL, `pl-waw-3` → PL). */
export function zoneCountry(zone: string | undefined): string | null {
  const cc = /^([a-z]{2})-[a-z]{3}-\d$/.exec(zone ?? '')?.[1];
  return cc ? cc.toUpperCase() : null;
}

/**
 * A Vast candidate has no zone: the backend picks the host near `near` itself. It ranks after a Scaleway zone in the
 * same country (a marketplace host is less reliable than a datacenter) and with the neighbors, priced at its cap
 * (the market price is at most that).
 */
export const VAST_CANDIDATE_TIER = 1;

export interface RankedCandidate extends PlacementCandidate {
  provider: DeploymentProvider;
  /** Known price for the ranking (catalog price, or the cap when unknown). */
  rankPrice: number;
  tier: number;
}

/**
 * Candidates ordered best first: geography tier (Scaleway zone country; Vast = `VAST_CANDIDATE_TIER`), then price.
 * Dropped: a zone in `shortage`, a type the catalog prices above the candidate's cap, and far zones (tier 3) unless
 * `allowFar`. A candidate the catalog does not know stays in, priced at its cap (the create checks the live price).
 * Stable: equal candidates keep the caller's order.
 */
export function rankCandidates(
  candidates: readonly PlacementCandidate[],
  catalog: readonly CatalogEntry[],
  opts: { near: string; allowFar?: boolean; defaultProvider: DeploymentProvider; defaultZone: string },
): { ranked: RankedCandidate[]; skipped: string[] } {
  const ranked: RankedCandidate[] = [];
  const skipped: string[] = [];
  for (const c of candidates) {
    const provider = c.provider ?? opts.defaultProvider;
    if (provider === 'vast') {
      ranked.push({ ...c, provider, rankPrice: c.maxEurPerHour, tier: VAST_CANDIDATE_TIER });
      continue;
    }
    const zone = c.zone ?? opts.defaultZone;
    const label = `scaleway ${c.machineType}@${zone}`;
    const tier = geoTier(zoneCountry(zone), opts.near);
    if (tier === 3 && !opts.allowFar) { skipped.push(`${label}: far from ${opts.near}`); continue; }
    const entry = catalog.find(e => e.zone === zone && e.machineType === c.machineType);
    if (entry?.availability === 'shortage') { skipped.push(`${label}: shortage`); continue; }
    if (entry?.hourlyPrice != null && entry.hourlyPrice > c.maxEurPerHour) {
      skipped.push(`${label}: €${entry.hourlyPrice}/h over cap €${c.maxEurPerHour}`);
      continue;
    }
    ranked.push({ ...c, provider, zone, rankPrice: entry?.hourlyPrice ?? c.maxEurPerHour, tier });
  }
  const order = ranked.map((c, i) => ({ c, i }));
  order.sort((a, b) => a.c.tier - b.c.tier || a.c.rankPrice - b.c.rankPrice || a.i - b.i);
  return { ranked: order.map(x => x.c), skipped };
}

/**
 * A create error that means "this place has no machine for us now" (try the next candidate), not a bug or a
 * credential problem (stop and back off): sold out, quota, capacity, HTTP 412 (Scaleway's precondition failure on
 * an exhausted zone), and the backend's own "no offer" errors.
 */
export function isPlacementMiss(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number } | null)?.status;
  return status === 412 || /out[_ ]of[_ ]stock|shortage|\b412\b|quota|capacity|insufficient|not sold|no (vast )?offer|not available|already rented/i.test(msg);
}
