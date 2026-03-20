/**
 * GPU offer ranking by estimated total latency:
 *   total_ms = network_rtt_ms + whisper_inference_ms (GPU bandwidth based)
 *
 * Network RTT priority (most → least precise):
 *   1. Per-host TCP probe (DB, rolling 24-probe stats) — exact routing to each machine
 *   2. Geo-distance estimate (Haversine) — fallback when no probe available
 *
 * Probing: TCP connect to port 22 (SSH), 5 concurrent probes → median + p90.
 * Results persisted to ~/.babelcast/latency.db via latency-db.ts.
 */

import net from 'net';
import type { GpuOffer } from '../src/gpu-providers/types';
import { upsertHostMeta, saveProbeResult, getHostRttMap } from './latency-db';
import type { ProbeResult } from './latency-db';

// ── Datacenter coordinates (capital / main hub per country) ──────────────────

const COUNTRY_COORDS: Record<string, { lat: number; lon: number }> = {
  FR: { lat: 48.86, lon:   2.35 }, // Paris
  DE: { lat: 50.11, lon:   8.68 }, // Frankfurt (EU datacenter hub)
  NL: { lat: 52.37, lon:   4.90 }, // Amsterdam
  BE: { lat: 50.85, lon:   4.35 }, // Brussels
  CH: { lat: 47.38, lon:   8.54 }, // Zurich
  GB: { lat: 51.51, lon:  -0.13 }, // London
  AT: { lat: 48.21, lon:  16.37 }, // Vienna
  ES: { lat: 40.42, lon:  -3.70 }, // Madrid
  IT: { lat: 45.47, lon:   9.19 }, // Milan
  PL: { lat: 52.23, lon:  21.01 }, // Warsaw
  CZ: { lat: 50.08, lon:  14.44 }, // Prague
  SE: { lat: 59.33, lon:  18.07 }, // Stockholm
  NO: { lat: 59.91, lon:  10.75 }, // Oslo
  FI: { lat: 60.17, lon:  24.94 }, // Helsinki
  DK: { lat: 55.68, lon:  12.57 }, // Copenhagen
  RO: { lat: 44.43, lon:  26.10 }, // Bucharest
  UA: { lat: 50.45, lon:  30.52 }, // Kyiv
  HU: { lat: 47.50, lon:  19.04 }, // Budapest
  EE: { lat: 59.44, lon:  24.75 }, // Tallinn
  IS: { lat: 64.13, lon: -21.82 }, // Reykjavik
  US: { lat: 38.90, lon: -77.04 }, // Virginia (primary US east)
  CA: { lat: 45.50, lon: -73.57 }, // Montreal (RunPod CA)
  MX: { lat: 19.43, lon: -99.13 }, // Mexico City
  BR: { lat: -23.55, lon: -46.63 }, // São Paulo
  JP: { lat: 35.68, lon: 139.65 }, // Tokyo
  KR: { lat: 37.57, lon: 126.98 }, // Seoul
  SG: { lat:  1.35, lon: 103.82 }, // Singapore
  AU: { lat: -33.87, lon: 151.21 }, // Sydney
  IN: { lat: 19.08, lon:  72.88 }, // Mumbai
  HK: { lat: 22.32, lon: 114.17 }, // Hong Kong
  TW: { lat: 25.03, lon: 121.56 }, // Taipei
  IL: { lat: 32.08, lon:  34.78 }, // Tel Aviv
  ZA: { lat: -26.20, lon: 28.04 }, // Johannesburg
  AE: { lat: 25.20, lon:  55.27 }, // Dubai
  VN: { lat: 21.03, lon: 105.85 }, // Hanoi
};

// ── GPU memory bandwidth table (GB/s) ────────────────────────────────────────
// Whisper large-v3 is memory-bandwidth bound: inference_ms ∝ 1/bandwidth.

const GPU_BANDWIDTH_GBS: Array<{ match: string; bw: number }> = [
  { match: 'H200',         bw: 4800 },
  { match: 'H100',         bw: 3350 },
  { match: 'A100 SXM4',   bw: 2000 },
  { match: 'A100',         bw: 1935 },
  { match: 'RTX 5090',     bw: 1792 },
  { match: 'RTX 5080',     bw:  960 },
  { match: 'RTX 4090',     bw: 1008 },
  { match: '3090 Ti',      bw: 1008 },
  { match: 'RTX 3090',     bw:  936 },
  { match: '4090D',        bw:  896 },
  { match: 'L40S',         bw:  864 },
  { match: 'L40',          bw:  864 },
  { match: 'A6000',        bw:  768 },
  { match: 'A5000',        bw:  768 },
  { match: 'A40',          bw:  696 },
  { match: 'RTX 4080',     bw:  716 },
  { match: 'RTX 3080 Ti',  bw:  912 },
  { match: 'RTX 3080',     bw:  760 },
  { match: 'A4500',        bw:  640 },
  { match: 'A10G',         bw:  600 },
  { match: 'A4000',        bw:  448 },
  { match: 'RTX 4070',     bw:  504 },
  { match: 'RTX 3070',     bw:  448 },
  { match: 'T4',           bw:  300 },
  { match: 'L4',           bw:  300 },
];

// Baseline: RTX 4090 (1008 GB/s) ≈ 200ms for a 5s Whisper large-v3 chunk
const BASELINE_BW_GBS       = 1008;
const BASELINE_INFERENCE_MS = 200;

// ── Exported types ────────────────────────────────────────────────────────────

export interface RankedOffer extends GpuOffer {
  networkRttMs: number;
  inferenceMs:  number;
  totalMs:      number;
  distanceKm:   number;
  countryCode:  string;
  /** How the network RTT was determined */
  rttSource: 'host' | 'geo';
}

// ── TCP probe ─────────────────────────────────────────────────────────────────

const TCP_PROBE_TIMEOUT_MS = 3_000;
const TCP_PROBE_COUNT      = 5;

/** Single TCP connect. Returns RTT in ms, or null on timeout/error. */
function probeTcp(ip: string, port: number): Promise<number | null> {
  return new Promise(resolve => {
    const t      = Date.now();
    const socket = net.createConnection({ host: ip, port });
    const timer  = setTimeout(() => { socket.destroy(); resolve(null); }, TCP_PROBE_TIMEOUT_MS);
    socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(Date.now() - t); });
    socket.on('error',   () => { clearTimeout(timer); resolve(null); });
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
  });
}

/**
 * Run TCP probes on ports 22, 443, 80 + any extra ports (e.g. Vast.ai direct_port_start).
 * All probes fire simultaneously — no sequential fallback, no extra latency.
 * Returns stats from the port with the most successful probes (ties → lowest median).
 */
export async function probeHostFull(ip: string, extraPorts: number[] = []): Promise<ProbeResult> {
  const PORTS = [...new Set([22, 443, 80, ...extraPorts])];

  const portResults = await Promise.all(
    PORTS.map(port =>
      Promise.all(Array.from({ length: TCP_PROBE_COUNT }, () => probeTcp(ip, port)))
        .then(raw => raw.filter((r): r is number => r !== null).sort((a, b) => a - b))
    )
  );

  // Pick port with most successes; break ties by lowest median
  const best = portResults
    .filter(v => v.length > 0)
    .sort((a, b) =>
      b.length !== a.length
        ? b.length - a.length
        : a[Math.floor(a.length / 2)] - b[Math.floor(b.length / 2)]
    )[0];

  if (!best) return { medianMs: null, p90Ms: null, samples: 0 };

  const median = best[Math.floor(best.length / 2)];
  const p90    = best[Math.min(Math.ceil(best.length * 0.9) - 1, best.length - 1)];
  return { medianMs: median, p90Ms: p90, samples: best.length };
}

// ── In-flight dedup ───────────────────────────────────────────────────────────

const _probing = new Set<string>(); // host IDs currently being probed

/**
 * Fire-and-forget: probe all offers with fresh hostIps, save results to DB.
 * Skips hosts already being probed or recently saved in DB (handled by caller
 * passing only stale hostRtts).
 */
export function scheduleBackgroundProbes(offers: GpuOffer[]): void {
  for (const offer of offers) {
    const { hostId, hostIp, provider, gpuName, geolocation, pricePerHr, hostDirectPort } = offer;
    if (!hostId || !hostIp) continue;
    if (_probing.has(hostId)) continue;

    upsertHostMeta(hostId, {
      hostIp,
      provider:    provider    ?? '',
      gpuName:     gpuName     ?? '',
      geolocation: geolocation ?? '',
      priceUsd:    pricePerHr  ?? 0,
      directPort:  hostDirectPort,
    });

    const extraPorts = hostDirectPort ? [hostDirectPort] : [];
    _probing.add(hostId);
    probeHostFull(hostIp, extraPorts)
      .then(result => {
        _probing.delete(hostId);
        saveProbeResult(hostId, result);
      })
      .catch(err => { console.debug(`[latency] probe failed for ${hostId}:`, err instanceof Error ? err.message : err); _probing.delete(hostId); });
  }
}

/**
 * Probe all offers with IPs synchronously — used with ?probe=true.
 * Saves results to DB and returns the updated hostRtt map.
 */
export async function probeAndSaveOffers(offers: GpuOffer[]): Promise<Record<string, number>> {
  const toProbe = offers.filter(o => o.hostId && o.hostIp);

  await Promise.all(toProbe.map(async offer => {
    const { hostId, hostIp, provider, gpuName, geolocation, pricePerHr, hostDirectPort } = offer;
    upsertHostMeta(hostId!, {
      hostIp:      hostIp!,
      provider:    provider    ?? '',
      gpuName:     gpuName     ?? '',
      geolocation: geolocation ?? '',
      priceUsd:    pricePerHr  ?? 0,
      directPort:  hostDirectPort,
    });
    const extraPorts = hostDirectPort ? [hostDirectPort] : [];
    const result = await probeHostFull(hostIp!, extraPorts);
    saveProbeResult(hostId!, result);
  }));

  return getHostRttMap(toProbe.map(o => o.hostId!));
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Haversine great-circle distance in km. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Estimate RTT from distance: 10ms base + 0.012ms/km (fiber ~80% speed-of-light). */
function estimateRttMs(distanceKm: number): number {
  return Math.round(10 + distanceKm * 0.012);
}

/** Estimate Whisper large-v3 inference time for a 5s audio chunk. */
function estimateInferenceMs(gpuName: string): number {
  for (const { match, bw } of GPU_BANDWIDTH_GBS) {
    if (gpuName.includes(match)) {
      return Math.round(BASELINE_INFERENCE_MS * BASELINE_BW_GBS / bw);
    }
  }
  return BASELINE_INFERENCE_MS; // unknown GPU → assume 4090 equivalent
}

/** Extract ISO 3166-1 alpha-2 code from "City, CC" geolocation strings. */
export function parseCountryCode(geolocation: string | undefined): string {
  if (!geolocation) return '';
  const parts = geolocation.split(',');
  const cc    = parts[parts.length - 1].trim().toUpperCase();
  return cc.length === 2 && /^[A-Z]{2}$/.test(cc) ? cc : '';
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Rank GPU offers by estimated total latency (network RTT + Whisper inference).
 * RTT priority: per-host TCP probe from DB > geo-distance estimate.
 * Returns a new sorted array — original is not mutated.
 */
export function rankOffers(
  offers:       GpuOffer[],
  clientLat:    number,
  clientLon:    number,
  _unused:      Record<string, number> = {}, // kept for API compat (was country probes)
  hostRtts:     Record<string, number> = {}, // per-host TCP probes from DB
): RankedOffer[] {
  const ranked = offers.map(offer => {
    const cc     = parseCountryCode(offer.geolocation);
    const coords = COUNTRY_COORDS[cc];

    const distanceKm = coords
      ? Math.round(haversineKm(clientLat, clientLon, coords.lat, coords.lon))
      : 10_000;

    let networkRttMs: number;
    let rttSource: RankedOffer['rttSource'];

    if (offer.hostId && hostRtts[offer.hostId] !== undefined) {
      networkRttMs = hostRtts[offer.hostId];
      rttSource    = 'host';
    } else {
      networkRttMs = estimateRttMs(distanceKm);
      rttSource    = 'geo';
    }

    const inferenceMs = estimateInferenceMs(offer.gpuName);
    return {
      ...offer,
      networkRttMs,
      inferenceMs,
      totalMs:    networkRttMs + inferenceMs,
      distanceKm,
      countryCode: cc,
      rttSource,
    };
  });

  return ranked.sort((a, b) => a.totalMs - b.totalMs);
}
