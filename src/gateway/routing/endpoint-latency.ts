/**
 * Endpoint latency probe: measures the round trip to each replica from where THIS process runs and orders them.
 *
 * The number that matters is the one seen by the caller (for the parle client's server that is the server calling the
 * TTS host, not the student's browser), so the probe lives in the gateway and is measured on the spot instead of being
 * guessed from a region name. Complements `PerformanceRanker`, which orders a chain by real traffic but has nothing to
 * go on before the first requests: probe once at boot (or when a replica is added), let the ranker take over.
 */
import type { FallbackEntry } from '../providers/cloud/fallback';

export interface EndpointProbeOptions {
  /** Path fetched on each endpoint. Must be cheap and unauthenticated (a health route). Default '/health'. */
  path?: string;
  /** Requests per endpoint. Default 5. */
  samples?: number;
  /** The first request pays TCP + TLS setup; when samples > 1 it is dropped unless this is false. Default true. */
  discardFirst?: boolean;
  /** Per-request timeout in ms. Default 2000. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Monotonic clock in ms (tests inject one). Default performance.now. */
  now?: () => number;
}

export interface EndpointLatency {
  endpoint: string;
  /** Median of the successful samples, or null when none succeeded. */
  medianMs: number | null;
  samplesMs: number[];
  failures: number;
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export async function probeEndpointLatency(endpoint: string, opts: EndpointProbeOptions = {}): Promise<EndpointLatency> {
  const { path = '/health', samples = 5, discardFirst = true, timeoutMs = 2000, fetchImpl = fetch, now = () => performance.now() } = opts;
  const url = `${endpoint.replace(/\/$/, '')}${path}`;
  const taken: number[] = [];
  let failures = 0;
  for (let i = 0; i < samples; i++) {
    const start = now();
    const ok = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
      .then((res) => res.ok, () => false);
    const elapsed = now() - start;
    if (ok) taken.push(elapsed);
    else failures++;
  }
  const useful = discardFirst && samples > 1 ? taken.slice(taken[0] === undefined ? 0 : 1) : taken;
  return { endpoint, medianMs: median(useful.length ? useful : taken), samplesMs: taken, failures };
}

/** Fastest first; endpoints that never answered go last, in their original order. */
export async function rankEndpointsByLatency(endpoints: string[], opts: EndpointProbeOptions = {}): Promise<EndpointLatency[]> {
  const probed = await Promise.all(endpoints.map((endpoint) => probeEndpointLatency(endpoint, opts)));
  const alive = probed.filter((p) => p.medianMs !== null).sort((a, b) => a.medianMs! - b.medianMs!);
  return [...alive, ...probed.filter((p) => p.medianMs === null)];
}

/**
 * Reorders the replicas of a chain by measured latency. Entries that have an endpoint are placed, fastest first, in the
 * slots those entries occupied; entries without an endpoint (cloud fallbacks) keep their position.
 */
export async function orderChainByLatency(chain: FallbackEntry[], opts: EndpointProbeOptions = {}): Promise<FallbackEntry[]> {
  const replicas = chain.filter((entry) => entry.endpoint);
  if (replicas.length < 2) return [...chain];
  const ranked = await rankEndpointsByLatency([...new Set(replicas.map((entry) => entry.endpoint!))], opts);
  const rank = new Map(ranked.map((row, index) => [row.endpoint, index]));
  const ordered = [...replicas].sort((a, b) => rank.get(a.endpoint!)! - rank.get(b.endpoint!)!);
  let next = 0;
  return chain.map((entry) => (entry.endpoint ? ordered[next++]! : entry));
}
