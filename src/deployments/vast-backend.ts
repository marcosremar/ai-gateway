/**
 * `DeploymentBackend` over the Vast.ai REST API, lean and separate from the GPU-pod client
 * (`gateway/providers/gpu/vast-client.ts`): search offers, rank them (`placements.ts`), rent the first that accepts.
 *
 * Vast runs ONE container per host, so a Vast replica is boot-script mode only: the spec's `image` is the container
 * (a public base image) and `vastReplicaInit` runs as its onstart. The token-gated nginx listens on container :80,
 * published on a random host port; the replica's `ip` is `public_ipaddr:<that port>`, so `HttpReplicaProbe` works
 * unchanged. With `spec.realtime` each UDP port of `vastUdpRange` gets its own `-p <n>:<n>/udp` (Vast maps no ranges) and
 * only hosts with that many direct ports are searched. Machines are found by label `aigw:<namespace>:<deployment>` (Vast has no tags).
 */

import { probeRtt } from '../gateway/providers/gpu/rtt-probe';
import { vastReplicaInit } from './cloud-init';
import { MIN_HOST_LEFT_MS, vastEndsAt } from './expiry';
import { countryDistanceKm } from './geo';
import { countryOf, DEFAULT_NEAR, effectivePrice, rankOffers, type VastOffer } from './placements';
import { vastPortCount, vastUdpRange } from './realtime-ports';
import type { OfferPreview } from './types';
import type { CreateReplicaInput, DeploymentBackend, DeploymentSpec, RegistryAuth, ReplicaMachine } from './types';

export const VAST_API = 'https://console.vast.ai/api/v0';

/**
 * EUR → USD for the price cap (Vast prices in USD). Deliberately below the market rate (≈ 1.08–1.18 over 2024–26):
 * the converted cap is then never looser than the caller's EUR cap.
 */
export const EUR_TO_USD = 1.05;
/** Reliability floor: below 0.97 hosts zombie on boot often enough to cost more than they save (repo experience). */
export const MIN_RELIABILITY = 0.97;
/** Used only when no offer passes `MIN_RELIABILITY` — the ranking then prices the extra risk in. */
export const FALLBACK_RELIABILITY = 0.95;
/** Mbps: a 10–20 GB image pulls in a few minutes at 500 Mbps; slower hosts blow the boot timeout. */
export const MIN_INET_DOWN_MBPS = 500;
/** Disk when the spec sets no `volumeGb`: a model image plus its weights cache. */
export const DEFAULT_DISK_GB = 50;
/** A host that failed to boot our image is skipped this long (it may be a bad driver, disk or network). */
export const BAD_HOST_MS = 3_600_000;
/** A host too far by measured RTT (`rtt-gate.ts`) is skipped a day: distance does not change by the hour. */
export const TOO_FAR_HOST_MS = 24 * 3_600_000;
/** RTT samples per measurement (median) and per-sample timeout: one gate check stays within a few seconds. */
export const RTT_SAMPLES = 5;
export const RTT_SAMPLE_TIMEOUT_MS = 2_000;

/** Median RTT (ms) to host:port counting only real response bytes, or null. Injectable for tests. */
export type RttMeasure = (host: string, port: number) => Promise<number | null>;

const defaultRtt: RttMeasure = async (host, port) => (await probeRtt(host, [port], RTT_SAMPLES, RTT_SAMPLE_TIMEOUT_MS)).medianMs;

/** Offers tried per create (a rented-in-between offer answers "not available"); more would only slow the walk. */
export const MAX_RENT_TRIES = 5;

/** The instance list is reused this long: a reconcile kick storm must not become a request storm (Vast rate-limits it). */
export const LIST_CACHE_MS = 5_000;
/** While Vast rate-limits the list, the last good inventory is served this long, then the list fails (honestly). */
export const LIST_STALE_MAX_MS = 90_000;
/** Pause after a 429/5xx on the list when Vast gives no `retry_after`: doubles per consecutive failure, up to the max. */
export const LIST_BACKOFF_MS = 15_000;
export const LIST_BACKOFF_MAX_MS = 120_000;

export const vastLabelPrefix = (namespace: string) => `aigw:${namespace}:`;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface VastInstance {
  id: number;
  label?: string | null;
  actual_status?: string | null;
  public_ipaddr?: string | null;
  ports?: Record<string, Array<{ HostPort?: string }> | undefined> | null;
  machine_id?: number;
  dph_total?: number;
  start_date?: number | null;
  /** Rental end (Unix seconds): the host is taken back then (`expiry.ts`). */
  end_date?: number | string | null;
  duration?: number | null;
  gpu_name?: string;
  geolocation?: string | null;
}

/** Blackwell (RTX 50xx, B100/B200) needs CUDA 12.8 drivers; everything else is fine with 12.4. */
export function minCudaFor(gpuName: string): number {
  return /RTX\s*50\d\d|\bB[12]00\b/i.test(gpuName) ? 12.8 : 12.4;
}

/** The CUDA floor of a spec: the GPU's own and the image's (`spec.minCuda`), whichever is higher. */
export function cudaFloorOf(spec: Pick<DeploymentSpec, 'machineType' | 'minCuda'>): number {
  return Math.max(minCudaFor(spec.machineType), spec.minCuda ?? 0);
}

export function imageLogin(auth: RegistryAuth): string {
  return `-u ${auth.username} -p ${auth.password} ${auth.server ?? 'docker.io'}`;
}

/** Vast `actual_status` → the controller's vocabulary: `running`, `starting` (loading/created), `exited` (halted). */
export function vastState(status: string | null | undefined): string {
  if (status === 'running') return 'running';
  if (status === 'exited' || status === 'stopped' || status === 'offline') return 'exited';
  return 'starting';
}

export class VastApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs?: number) { super(message); }
}

/** `Retry-After` (seconds) header or `retry_after` (seconds) in the JSON body, as ms. */
function retryAfterOf(res: Response, text: string): number | undefined {
  let seconds = Number(res.headers?.get?.('retry-after'));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    try { seconds = Number((JSON.parse(text) as { retry_after?: unknown }).retry_after); } catch { seconds = NaN; }
  }
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) * 1000 : undefined;
}

export class VastDeploymentBackend implements DeploymentBackend {
  readonly provider = 'vast' as const;
  readonly marketPriced = true;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly rtt: RttMeasure;
  /** machine_id → skip until. */
  private readonly badHosts = new Map<number, number>();
  /** instance id → host machine_id (from create and list). */
  private readonly hostOf = new Map<string, number>();
  /** Last good `/instances/` answer (briefly reused, and served while Vast rate-limits). */
  private listCache: { at: number; machines: ReplicaMachine[]; namespace: string } | null = null;
  private listBackoffUntil = 0;
  private listFailures = 0;

  private readonly log: (msg: string, data?: Record<string, unknown>) => void;

  constructor(private readonly apiKey: string, opts: { fetch?: FetchLike; now?: () => number; rtt?: RttMeasure; log?: (msg: string, data?: Record<string, unknown>) => void } = {}) {
    this.log = opts.log ?? (() => {});
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.rtt = opts.rtt ?? defaultRtt;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${VAST_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new VastApiError(res.status, `vast ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`, retryAfterOf(res, text));
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** The `/bundles/` search body for one GPU type under a USD cap. */
  searchBody(spec: DeploymentSpec, reliability: number): Record<string, unknown> {
    return {
      type: 'on-demand',
      rentable: { eq: true },
      rented: { eq: false },
      verified: { eq: true },
      num_gpus: { eq: 1 },
      gpu_name: { in: [spec.machineType] },
      disk_space: { gte: spec.volumeGb ?? DEFAULT_DISK_GB },
      cuda_max_good: { gte: cudaFloorOf(spec) },
      reliability2: { gte: reliability },
      inet_down: { gte: MIN_INET_DOWN_MBPS },
      direct_port_count: { gte: vastPortCount(spec) },
      dph_total: { lte: Math.round(spec.maxEurPerHour * EUR_TO_USD * 1000) / 1000 },
      order: [['dph_total', 'asc']],
      limit: 100,
    };
  }

  /** Offers for the spec, ranked best first (near users, then effective price); bad hosts left out. */
  async pickOffers(spec: DeploymentSpec): Promise<VastOffer[]> {
    const now = this.now();
    for (const [id, until] of this.badHosts) if (until <= now) this.badHosts.delete(id);
    const usdCap = spec.maxEurPerHour * EUR_TO_USD;
    for (const reliability of [MIN_RELIABILITY, FALLBACK_RELIABILITY]) {
      const { offers = [] } = await this.call<{ offers?: VastOffer[] }>('POST', '/bundles/', this.searchBody(spec, reliability));
      // The API's numeric filters are not always applied: check cap and floors again here.
      const cuda = cudaFloorOf(spec);
      // A host whose rental ends within a day would be taken back mid-use: skipped (unknown end = kept).
      const valid = offers.filter(o => o.dph_total <= usdCap && o.reliability2 >= reliability && o.inet_down >= MIN_INET_DOWN_MBPS
        && (o.cuda_max_good === undefined || o.cuda_max_good >= cuda) && this.lastsLongEnough(o, now)
        && (o.direct_port_count === undefined || o.direct_port_count >= vastPortCount(spec)));
      const ranked = rankOffers(valid, {
        near: spec.near ?? DEFAULT_NEAR, ...(spec.allowFar ? { allowFar: true } : {}), avoidMachines: new Set(this.badHosts.keys()),
      });
      if (ranked.length) return ranked;
    }
    return [];
  }

  private lastsLongEnough(offer: VastOffer, now: number): boolean {
    const end = vastEndsAt(offer.end_date, offer.duration, now);
    return end === null || end - now >= MIN_HOST_LEFT_MS;
  }

  async createReplica(input: CreateReplicaInput): Promise<ReplicaMachine> {
    const { spec } = input;
    const offers = await this.pickOffers(spec);
    if (!offers.length) {
      throw new Error(`out_of_stock: no vast offer for ${spec.machineType} under €${spec.maxEurPerHour}/h near ${spec.near ?? DEFAULT_NEAR}`);
    }
    const init = vastReplicaInit(spec, input.replicaToken);
    const env = { ...(spec.envByMachineType?.[spec.machineType] ?? {}), ...spec.env };
    const [udpLo, udpHi] = vastUdpRange(spec) ?? [1, 0];
    const udp = Object.fromEntries(Array.from({ length: udpHi - udpLo + 1 }, (_, i) => [`-p ${udpLo + i}:${udpLo + i}/udp`, '1']));
    const misses: string[] = [];
    for (const offer of offers.slice(0, MAX_RENT_TRIES)) {
      try {
        const res = await this.call<{ success?: boolean; new_contract?: number; error?: string; msg?: string }>('PUT', `/asks/${offer.id}/`, {
          client_id: 'me',
          image: spec.image,
          label: `${vastLabelPrefix(input.namespace)}${spec.name}`,
          disk: spec.volumeGb ?? DEFAULT_DISK_GB,
          runtype: 'ssh_direct',
          // The init script travels in an env var (the onstart field stays short); read from /etc/environment when the
          // onstart shell does not see the container env.
          onstart: 'V="${AIGW_INIT_B64:-$(sed -n \'s/^AIGW_INIT_B64=//p\' /etc/environment | tr -d \'"\')}"; '
            + 'mkdir -p /srv/aigw && echo "$V" | base64 -d > /srv/aigw/init.sh && nohup bash /srv/aigw/init.sh > /srv/aigw/init.log 2>&1 &',
          env: { ...env, AIGW_INIT_B64: Buffer.from(init, 'utf8').toString('base64'), '-p 80:80': '1', ...udp },
          ...(spec.registryAuth ? { image_login: imageLogin(spec.registryAuth) } : {}),
        });
        if (!res.success || res.new_contract == null) throw new Error(`not available: ${res.error ?? res.msg ?? 'success=false'}`);
        const id = String(res.new_contract);
        input.onCreated?.(id); // the cached list lacks it; the controller keeps a fresh create until a list shows it
        if (offer.machine_id !== undefined) this.hostOf.set(id, offer.machine_id);
        this.log('deployments: vast offer rented', {
          deployment: spec.name, id, offer: offer.id, host: offer.machine_id, location: offer.geolocation, usdPerHour: offer.dph_total,
          rank: offers.indexOf(offer) + 1, of: offers.length, skipped: misses,
        });
        return {
          id, deployment: spec.name, ip: null, state: 'starting', createdAt: this.now(), provider: 'vast',
          zone: offer.geolocation ?? '', machineType: offer.gpu_name ?? spec.machineType,
          pricePerHour: Math.round((offer.dph_total / EUR_TO_USD) * 1000) / 1000,
          expiresAt: vastEndsAt(offer.end_date, offer.duration, this.now()),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/not available|already rented|no_such_ask|HTTP 404|HTTP 410/i.test(msg)) throw err;
        misses.push(`offer ${offer.id}: ${msg.slice(0, 80)}`);
      }
    }
    throw new Error(`out_of_stock: every vast offer tried was taken (${misses.join('; ')})`);
  }

  /**
   * Instance list with a short cache and a back-off. A 429/5xx (Vast answered many of them in prod, 2026-10-06) pauses
   * list calls for its `retry_after` (else 15 s doubling to 2 min); meanwhile the last good inventory is served for up
   * to `LIST_STALE_MAX_MS`, and past that the list fails so the controller knows it is blind.
   */
  async listReplicas(namespace: string): Promise<ReplicaMachine[]> {
    const now = this.now();
    const cached = this.listCache?.namespace === namespace ? this.listCache : null;
    if (cached && now - cached.at < LIST_CACHE_MS) return cached.machines.map(m => ({ ...m }));
    if (now < this.listBackoffUntil) {
      if (cached && now - cached.at < LIST_STALE_MAX_MS) return cached.machines.map(m => ({ ...m }));
      throw new VastApiError(429, `vast GET /instances/: backing off ${Math.ceil((this.listBackoffUntil - now) / 1000)}s after a rate limit`);
    }
    try {
      const machines = await this.fetchReplicas(namespace);
      this.listCache = { at: this.now(), machines, namespace };
      this.listFailures = 0;
      return machines.map(m => ({ ...m }));
    } catch (err) {
      if (err instanceof VastApiError && (err.status === 429 || err.status >= 500)) {
        const wait = err.retryAfterMs ?? Math.min(LIST_BACKOFF_MS * 2 ** this.listFailures, LIST_BACKOFF_MAX_MS);
        this.listBackoffUntil = this.now() + wait;
        this.listFailures++;
        if (cached && this.now() - cached.at < LIST_STALE_MAX_MS) return cached.machines.map(m => ({ ...m }));
      }
      throw err;
    }
  }

  private async fetchReplicas(namespace: string): Promise<ReplicaMachine[]> {
    const { instances = [] } = await this.call<{ instances?: VastInstance[] }>('GET', '/instances/');
    const prefix = vastLabelPrefix(namespace);
    return instances.filter(i => i.label?.startsWith(prefix)).map((i) => {
      const id = String(i.id);
      if (i.machine_id !== undefined) this.hostOf.set(id, i.machine_id);
      const hostPort = i.ports?.['80/tcp']?.[0]?.HostPort;
      return {
        id, deployment: i.label!.slice(prefix.length), provider: 'vast' as const,
        ip: i.public_ipaddr && hostPort ? `${i.public_ipaddr.trim()}:${hostPort}` : null,
        state: vastState(i.actual_status),
        createdAt: typeof i.start_date === 'number' ? Math.round(i.start_date * 1000) : this.now(),
        zone: i.geolocation ?? '', machineType: i.gpu_name ?? '',
        pricePerHour: typeof i.dph_total === 'number' ? Math.round((i.dph_total / EUR_TO_USD) * 1000) / 1000 : null,
        expiresAt: vastEndsAt(i.end_date, i.duration, this.now()),
      };
    });
  }

  /**
   * Deletes the instance (its disk goes with it). A host that never booted our image is avoided for `BAD_HOST_MS`;
   * one released by the RTT gate (`too-far`) for `TOO_FAR_HOST_MS`.
   */
  async releaseReplica(machine: ReplicaMachine, reason?: string): Promise<void> {
    const avoidMs = reason === 'too-far' ? TOO_FAR_HOST_MS : reason === 'boot-timeout' ? BAD_HOST_MS : 0;
    const host = this.hostOf.get(machine.id);
    if (avoidMs && host !== undefined) this.badHosts.set(host, this.now() + avoidMs);
    try {
      await this.call('DELETE', `/instances/${machine.id}/`);
    } catch (err) {
      if (!(err instanceof VastApiError && err.status === 404)) throw err;
    }
    this.hostOf.delete(machine.id);
    if (this.listCache) this.listCache.machines = this.listCache.machines.filter(m => m.id !== machine.id); // not listed again as alive
  }

  /** RTT from the gateway to the replica's nginx front (`ip` = public address:mapped port of :80). */
  async measureRtt(machine: ReplicaMachine): Promise<number | null> {
    const m = /^(.+):(\d+)$/.exec(machine.ip ?? '');
    if (!m) return null;
    return this.rtt(m[1], Number(m[2]));
  }

  async previewOffers(spec: DeploymentSpec): Promise<OfferPreview[]> {
    const near = spec.near ?? DEFAULT_NEAR;
    return (await this.pickOffers(spec)).map((o, i) => ({
      rank: i + 1, wouldTry: i < MAX_RENT_TRIES, offerId: o.id, machineId: o.machine_id ?? null, location: o.geolocation ?? null,
      distanceKm: Math.round(countryDistanceKm(near, countryOf(o.geolocation))), usdPerHour: o.dph_total,
      effectiveUsdPerHour: Math.round(effectivePrice(o) * 1000) / 1000, reliability: o.reliability2, inetDownMbps: o.inet_down,
      inetUpMbps: o.inet_up ?? null, cudaMax: o.cuda_max_good ?? null, directPorts: o.direct_port_count ?? null, gpu: o.gpu_name ?? null,
    }));
  }

  /** Not meaningful per zone on Vast: the backend picks a market offer under the cap at create (`marketPriced`). */
  async hourlyPrice(): Promise<number | null> {
    return null;
  }

  /** Hosts currently skipped (for tests and diagnostics). */
  avoidedHosts(): number[] {
    return [...this.badHosts.keys()];
  }
}
