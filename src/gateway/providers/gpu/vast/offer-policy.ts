/**
 * Vast.ai desktop offer policy (ported from babylon testbench).
 *
 * Quality floor for latency-sensitive / desktop workloads:
 *   reliability2 ≥ 0.95, inet_down strictly > 1000 Mbps, dph_total ≤ $0.20/hr.
 */

/** Default max $/hr for desktop-quality Vast offers (configurable via rank/search opts). */
export const VAST_DESKTOP_MAX_PER_HR = 0.20;

export type VastOfferRankInput = {
  id: number;
  dph_total: number;
  reliability2: number;
  inet_down: number;
  num_gpus: number;
  gpu_name: string;
  rentable: boolean;
  rented: boolean;
  verified?: boolean;
};

/**
 * Filter + sort offers by desktop policy.
 * Sort: cheapest dph_total first, then id ascending.
 * Throws if `cap` is non-finite, ≤ 0, or above VAST_DESKTOP_MAX_PER_HR.
 */
export function rankVastOffers(
  offers: readonly VastOfferRankInput[],
  cap = VAST_DESKTOP_MAX_PER_HR,
): VastOfferRankInput[] {
  if (!Number.isFinite(cap) || cap <= 0 || cap > VAST_DESKTOP_MAX_PER_HR) {
    throw new Error('invalid Vast price cap');
  }
  return offers
    .filter(
      (o) =>
        Number.isSafeInteger(o.id) &&
        o.id > 0 &&
        Number.isFinite(o.dph_total) &&
        o.dph_total > 0 &&
        o.dph_total <= cap &&
        Number.isFinite(o.reliability2) &&
        o.reliability2 >= 0.95 &&
        o.reliability2 <= 1 &&
        Number.isFinite(o.inet_down) &&
        o.inet_down > 1000 &&
        Number.isInteger(o.num_gpus) &&
        o.num_gpus > 0 &&
        typeof o.gpu_name === 'string' &&
        o.gpu_name.trim() &&
        o.rentable === true &&
        o.rented === false,
    )
    .sort((a, b) => a.dph_total - b.dph_total || a.id - b.id);
}

export type VastDesktopSearchFilterOpts = {
  maxPerHr?: number;
  minReliability?: number;
  /** If set, used as `inet_down: { gte }`. Default is strict > 1000 via `{ gt: 1000 }`. */
  minInetDownMbps?: number;
};

/**
 * Server-side Vast `/bundles/` search filters for desktop policy.
 * Defaults: reliability2 ≥ 0.95, inet_down > 1000, dph_total ≤ 0.20, verified.
 */
export function vastDesktopSearchFilters(
  opts?: VastDesktopSearchFilterOpts,
): Record<string, unknown> {
  const maxPerHr = opts?.maxPerHr ?? VAST_DESKTOP_MAX_PER_HR;
  const minReliability = opts?.minReliability ?? 0.95;
  const inetDown =
    opts?.minInetDownMbps != null
      ? { gte: opts.minInetDownMbps }
      : { gt: 1000 };
  return {
    reliability2: { gte: minReliability },
    inet_down: inetDown,
    dph_total: { lte: maxPerHr },
    verified: { eq: true },
  };
}
