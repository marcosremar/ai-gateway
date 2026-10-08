/**
 * Placement: where a replica may run. Two spec fields, one walk (`placement-walk.ts`):
 *
 *   - `placements` (Scaleway): the spec's own zone/type first, then each entry IN ORDER (`placementsOf`), at the spec's
 *     `maxEurPerHour`; the walk moves on only when the type is not sold, over the cap, out of stock (`isOutOfStock`)
 *     or over the account's quota (`quotaMachineType`: that machine type is then skipped in every zone).
 *   - `candidates` (Scaleway and Vast): a ladder ranked here (`rankCandidates`), each entry with its own cap.
 *
 * The ranking is pure, no I/O — the Vast backend ranks market offers with `rankOffers`. The owner's three goals:
 * reliable, cheap, low latency for users in France. Distance decides first (`geo.ts`: great-circle km from the `near`
 * country, in 500-km bands — latency is physics, EU membership is not); inside a band, a host in the users' own country
 * goes before one across a border, then the cheapest *effective* price wins, where an unreliable host is priced as if
 * it cost more. Vast hosts are then measured (`rtt-gate.ts`), and one that passed sorts first on later creates.
 */
import { countryDistanceKm } from './geo';
import type { CatalogEntry, DeploymentProvider, DeploymentSpec, PlacementCandidate } from './types';

export type { CatalogEntry };

// ── `placements`: ordered Scaleway alternatives ─────────────────────────────

/** The spec once per placement, primary first, duplicates dropped. */
export function placementsOf(spec: DeploymentSpec): DeploymentSpec[] {
  const seen = new Set<string>();
  const out: DeploymentSpec[] = [];
  for (const p of [{}, ...(spec.placements ?? [])]) {
    const zone = p.zone ?? spec.zone;
    const machineType = p.machineType ?? spec.machineType;
    const key = `${zone}/${machineType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Scaleway image ids are per zone: a pinned image only holds in its own zone (elsewhere the backend looks up the
    // same image there).
    const { osImageId, ...rest } = spec;
    out.push({ ...rest, ...(zone === spec.zone && osImageId ? { osImageId } : {}), zone, machineType });
  }
  return out;
}

/**
 * The provider has no machine of this type in this zone right now. Scaleway answers a server create with
 * `412 {"type":"out_of_stock"}` (seen 2026-10-06 for L40S and L4 in fr-par-2); capacity wordings count too. A quota refusal is not one: it holds
 * for the machine type in every zone (`quotaMachineType`).
 */
export function isOutOfStock(err: unknown): boolean {
  const e = err as { status?: unknown; body?: unknown; message?: unknown } | null;
  const text = `${typeof e?.message === 'string' ? e.message : ''} ${typeof e?.body === 'string' ? e.body : ''}`;
  if (/out_of_stock|out of stock|shortage|insufficient capacity|no (?:more )?capacity|not enough (?:stock|capacity)/i.test(text)) return true;
  return e?.status === 412 && /stock|capacity|available/i.test(text);
}

export function quotaMachineType(err: unknown, fallback: string): string | null {
  const e = err as { body?: unknown; message?: unknown } | null;
  const text = `${typeof e?.message === 'string' ? e.message : ''} ${typeof e?.body === 'string' ? e.body : ''}`;
  if (!/quota/i.test(text)) return null;
  return /cp_servers_type_(\w+)/.exec(text)?.[1].replace(/_/g, '-') ?? fallback;
}

// ── Geography and ranking (`candidates`, Vast offers) ───────────────────────

/** The owner's region: users (students, teachers) are in France. Used when a spec sets no `near`. */
export const DEFAULT_NEAR = 'FR';

/**
 * Width of a distance band (km). Within ~500 km, RTT differences are a few ms (≈ 1 ms per 100 km of fibre) and
 * routing noise dominates, so price decides; across bands, distance does.
 */
export const DISTANCE_BUCKET_KM = 500;
/**
 * Beyond this a host is "far": ~25 ms of fibre alone before routing, so ≥ 40–60 ms in practice — too slow for a
 * conversation. Covers western and central Europe from France (Warsaw 1370 km, Bucharest ~1870 km, Lisbon ~1450 km).
 * Far hosts are used only when nothing nearer exists and the spec has `allowFar`.
 */
export const MAX_NEAR_KM = 2500;

/** Distance band of a country from `near`: 0 = < 500 km, 1 = 500–1000 km, …; `Infinity` when unknown. */
export function distanceBucket(country: string | null, near: string): number {
  const km = countryDistanceKm(near, country);
  return Number.isFinite(km) ? Math.floor(km / DISTANCE_BUCKET_KM) : Infinity;
}

/** Within `MAX_NEAR_KM` of `near`. */
export function isNear(country: string | null, near: string): boolean {
  return countryDistanceKm(near, country) <= MAX_NEAR_KM;
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
  inet_up?: number;
  direct_port_count?: number;
  geolocation?: string | null;
  gpu_name?: string;
  /** Highest CUDA version the host driver supports. */
  cuda_max_good?: number;
  /** Rental end (Unix seconds) and seconds left: `expiry.ts`. */
  end_date?: number | string | null;
  duration?: number | null;
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
  /** Allow far (> `MAX_NEAR_KM`) offers when no near offer exists. */
  allowFar?: boolean;
  /** Host machine ids to leave out (recent boot failures). */
  avoidMachines?: ReadonlySet<number>;
  /** Host machine id → RTT (ms) it measured when it last passed the RTT gate. */
  knownRtt?: ReadonlyMap<number, number>;
}

export const KNOWN_RTT_BAND_MS = 5;

/**
 * Offers ordered best first: hosts that already passed the RTT gate (by measured RTT, in 5-ms bands), then distance
 * band, then the users' own country before a neighbour, then effective price, then download bandwidth (faster pull).
 */
export function rankOffers<T extends VastOffer>(offers: readonly T[], opts: RankOffersOptions): T[] {
  const usable = offers.filter(o => o.machine_id === undefined || !opts.avoidMachines?.has(o.machine_id));
  const scored = usable.map((o) => {
    const cc = countryOf(o.geolocation);
    const rtt = o.machine_id === undefined ? undefined : opts.knownRtt?.get(o.machine_id);
    return {
      o, near: isNear(cc, opts.near), bucket: distanceBucket(cc, opts.near), eff: effectivePrice(o),
      known: rtt === undefined ? Infinity : Math.floor(rtt / KNOWN_RTT_BAND_MS), abroad: cc === opts.near.toUpperCase() ? 0 : 1,
    };
  });
  const near = scored.filter(t => t.near);
  const pool = near.length ? near : opts.allowFar ? scored : [];
  const byBucket = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1); // Infinity-safe
  return pool
    .sort((a, b) => byBucket(a.known, b.known) || byBucket(a.bucket, b.bucket) || a.abroad - b.abroad || a.eff - b.eff
      || (b.o.inet_down || 0) - (a.o.inet_down || 0))
    .map(t => t.o);
}

// ── Scaleway zones / candidates ─────────────────────────────────────────────

/** Country of a Scaleway zone (`fr-par-2` → FR, `nl-ams-1` → NL, `pl-waw-3` → PL). */
export function zoneCountry(zone: string | undefined): string | null {
  const cc = /^([a-z]{2})-[a-z]{3}-\d$/.exec(zone ?? '')?.[1];
  return cc ? cc.toUpperCase() : null;
}

/**
 * Distance band given to a Vast candidate (it has no zone: the backend picks the host near `near` itself, and the RTT
 * gate rejects a far one): after a Scaleway zone within 500 km (a datacenter is more reliable than a marketplace
 * host), level with zones 500–1000 km away, priced at its cap (the market price is at most that).
 */
export const VAST_CANDIDATE_BUCKET = 1;

export interface RankedCandidate extends PlacementCandidate {
  provider: DeploymentProvider;
  /** Known price for the ranking (catalog price, or the cap when unknown). */
  rankPrice: number;
  /** Distance band from `near` (`distanceBucket`; Vast = `VAST_CANDIDATE_BUCKET`). */
  bucket: number;
}

/**
 * Candidates ordered best first: distance band (Scaleway zone country: fr-par 0 km, nl-ams ~430 km, pl-waw ~1370 km;
 * Vast = `VAST_CANDIDATE_BUCKET`), then price. Dropped: a zone in `shortage`, a type the catalog prices above the
 * candidate's cap, and zones beyond `MAX_NEAR_KM` unless `allowFar`. A candidate the catalog does not know stays in, priced at its cap (the create checks the live price).
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
      ranked.push({ ...c, provider, rankPrice: c.maxEurPerHour, bucket: VAST_CANDIDATE_BUCKET });
      continue;
    }
    const zone = c.zone ?? opts.defaultZone;
    const label = `scaleway ${c.machineType}@${zone}`;
    const country = zoneCountry(zone);
    const bucket = distanceBucket(country, opts.near);
    if (!isNear(country, opts.near) && !opts.allowFar) { skipped.push(`${label}: far from ${opts.near}`); continue; }
    const entry = catalog.find(e => e.zone === zone && e.machineType === c.machineType);
    if (entry?.availability === 'shortage') { skipped.push(`${label}: shortage`); continue; }
    if (entry?.hourlyPrice != null && entry.hourlyPrice > c.maxEurPerHour) {
      skipped.push(`${label}: €${entry.hourlyPrice}/h over cap €${c.maxEurPerHour}`);
      continue;
    }
    ranked.push({ ...c, provider, zone, rankPrice: entry?.hourlyPrice ?? c.maxEurPerHour, bucket });
  }
  const order = ranked.map((c, i) => ({ c, i }));
  const byBucket = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1); // Infinity-safe
  order.sort((a, b) => byBucket(a.c.bucket, b.c.bucket) || a.c.rankPrice - b.c.rankPrice || a.i - b.i);
  return { ranked: order.map(x => x.c), skipped };
}
