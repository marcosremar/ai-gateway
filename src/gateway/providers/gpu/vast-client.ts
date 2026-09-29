/**
 * Vast.ai GPU Provider Client
 *
 * Supports two Vast.ai resource types:
 *   1. **On-demand instances** — raw GPU rentals via /instances/
 *   2. **Serverless endpoints** — vLLM endptjobs via /endptjobs/
 *
 * listInstances() returns both, so the cost monitor catches any
 * running/rented resource that isn't tracked by the autoscaler.
 *
 * Optimizations over naive usage:
 *   - **stop** pauses (preserves data/GPU priority) instead of destroying
 *   - **reboot** uses dedicated API to restart without losing GPU priority
 *   - **recycle** re-pulls image on same host without losing GPU priority
 *   - **GET /instances/{id}/** for single-instance lookup (fallback to v1 filtered list)
 *   - **template_hash_id** for pre-configured fast boot
 *   - **cancel_unavail** for fail-fast when GPU unavailable
 *   - **Exponential backoff** on endpoint polling
 *   - **takeSnapshot** to capture container state for near-instant future boots
 */

import type { GpuInstance, GpuOffer, InstanceSpec, ListOffersOptions, ProviderCredentials } from './types';
import { AbstractGpuProvider, TIMEOUTS } from './abstract-provider';
import type { AbstractGpuProviderOptions } from './abstract-provider';
import { getMinInetDownMbps } from './deploy-settings';
import { normalizeInstanceStatus } from './instance-status';
import {
  VAST_DESKTOP_MAX_PER_HR,
  rankVastOffers,
  vastDesktopSearchFilters,
  type VastOfferRankInput,
} from './vast/offer-policy';
import os from 'os';
import path from 'path';
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { spawn } from 'child_process';
import { isSshClientAvailable } from './ssh-tunnel';
import { createLogger } from '../../../logger';

/** When `spec.minInetDownMbps` is unset, floor at this Mbps (never clamp an explicit caller value).
 *  Deploy-settings often persist 2000 which zeros consumer-GPU inventory; 500 is a sensible default. */
const DEFAULT_CREATE_INET_DOWN_MBPS = 500;

const log = createLogger('vast-client');

const VAST_API_BASE = process.env.VAST_API_BASE || 'https://console.vast.ai/api/v0';

// Port > 70000 gets identity mapping on Vast.ai (external == host port, not randomized).
// We map container:8000 → host:VAST_IDENTITY_PORT for stable, predictable access.
const VAST_IDENTITY_PORT = 70008;

// ── Polling constants ─────────────────────────────────────────────────────────
const POLL_BASE_MS = 5_000;
const POLL_GROWTH = 1.4;
const POLL_MAX_MS = 30_000;
// Vast.ai on-demand instances typically get an IP within 2 min for small images,
// but large images (e.g. 52GB Blackwell) can take 15-25 min to pull + start.
// We poll generously here; the boot health poller (engine.ts) handles "app ready".
const POLL_TOTAL_MAX_MS = 1_800_000; // 30 minutes

// ── Host reliability tracking ────────────────────────────────────────────────
// Hosts that reclaim instances during loading are blacklisted for a cooldown period.
// This prevents wasting time and money on unreliable hosts.
const UNSTABLE_HOST_COOLDOWN_MS = parseInt(process.env.VAST_UNSTABLE_HOST_COOLDOWN_MS || String(30 * 60 * 1000), 10);
const MAX_UNSTABLE_HOSTS = 50;

// ── Rate limiting ────────────────────────────────────────────────────────────
// Vast.ai limits to ~4.5 req/s. We use a token bucket at 3 req/s to stay safe.
const RATE_LIMIT_INTERVAL_MS = 334; // ~3 req/s
const RATE_LIMIT_429_RETRY_MS = parseInt(process.env.VAST_RATE_LIMIT_429_RETRY_MS || '2000', 10);
const RATE_LIMIT_429_MAX_RETRIES = 3;

// ── Offer cache ─────────────────────────────────────────────────────────────
// Reduced from 60s to 10s because GPU availability changes rapidly.
// A stale cache could cause deploy failures when all GPUs get rented between requests.
const OFFER_CACHE_TTL_MS = parseInt(process.env.VAST_OFFER_CACHE_TTL_MS || '10000', 10); // 10s

// ── Host reputation persistence ─────────────────────────────────────────────
const REPUTATION_DIR = process.env.AI_GATEWAY_CONFIG_DIR || path.join(os.homedir(), '.ai-gateway');
const REPUTATION_PATH = path.join(REPUTATION_DIR, 'vast-host-reputation.json');

// ── Aggressive host blacklist (per-host failure counters + escalating bans) ─
// Distinct from _unstableHosts (a single-level flag). This tracks repeated
// failures so hosts that consistently break get longer bans.
const HOST_BLACKLIST_DIR = path.join(os.homedir(), '.babelcast');
const HOST_BLACKLIST_PATH = path.join(HOST_BLACKLIST_DIR, 'vast-host-blacklist.json');
const HOST_BAN_1_FAILURE_MS = 5 * 60 * 1000;      // 5 min
const HOST_BAN_2_FAILURES_MS = 30 * 60 * 1000;    // 30 min
const HOST_BAN_3PLUS_FAILURES_MS = 60 * 60 * 1000; // 1 hour
const HOST_FAILURE_RESET_MS = 24 * 60 * 60 * 1000; // reset counter after 24h clean

interface HostFailureRecord {
  count: number;
  bannedUntilMs: number;
  lastFailureMs: number;
}

/** Check if an IP address is RFC1918 private / loopback / link-local (unreachable from internet). */
function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  if (ip === '0.0.0.0' || ip === '::' || ip === '::1') return true;
  // IPv4 private ranges
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('169.254.')) return true;
  // IPv6 private ranges
  if (ip.startsWith('fe80:') || ip.startsWith('fe80%')) return true; // link-local
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;       // ULA (unique local)
  return false;
}

/** AbortError raised when a caller cancels createInstance via spec.signal. */
function deployCancelledError(): DOMException {
  return new DOMException('Deploy cancelled', 'AbortError');
}

/** setTimeout that rejects early when `signal` aborts. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return Promise.reject(deployCancelledError());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(deployCancelledError()); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Server-side fetch size for listOffers when a client-side geo filter applies. */
const VAST_GEO_FETCH_LIMIT = 1000;

/** Max IPs to track in _recentlyUsedIps before pruning (prevents memory leak). */
const MAX_RECENTLY_USED_IPS = 200;

/**
 * Check if a geolocation string matches a country code.
 * Handles both "France, FR" and bare "FR" formats from Vast.ai.
 */
function geoMatchesCountryCode(geo: string, cc: string): boolean {
  if (!geo || !cc) return false;
  const upperCc = cc.toUpperCase();
  // Format "Country, CC" — check both ends
  if (geo.endsWith(`, ${upperCc}`) || geo.toUpperCase().startsWith(`${upperCc},`)) return true;
  // Format bare "CC" — exact match (case-insensitive)
  if (geo.toUpperCase() === upperCc) return true;
  return false;
}

/** Normalize short GPU type names (e.g. 'RTX3090') to Vast.ai search names (e.g. 'RTX 3090') */
function normalizeGpuNames(gpuTypes: string[]): string[] {
  if (!gpuTypes || !Array.isArray(gpuTypes)) return [];
  return gpuTypes.map((t) => {
    if (!t || typeof t !== 'string') return '';
    // Replace underscores with spaces (e.g. 'RTX_3090' → 'RTX 3090')
    let name = t.replace(/_/g, ' ');
    // Strip NVIDIA prefix — Vast.ai uses short names like "RTX A6000", not "NVIDIA RTX A6000"
    name = name.replace(/^NVIDIA\s+(GeForce\s+)?/i, '');
    // Add space before digits if missing (e.g. 'RTX3090' → 'RTX 3090', 'RTXA5000' → 'RTX A5000')
    name = name.replace(/^(RTX)(\d)/, '$1 $2').replace(/^(RTX)(A)/, '$1 $2');
    return name;
  }).filter(Boolean);
}

/** Strip inst- / endpt- prefix to get the raw Vast.ai numeric ID */
function stripPrefix(id: string): { rawId: string; type: 'instance' | 'endpoint' } {
  if (id.startsWith('inst-')) return { rawId: id.slice(5), type: 'instance' };
  if (id.startsWith('endpt-')) return { rawId: id.slice(6), type: 'endpoint' };
  return { rawId: id, type: 'instance' };
}

/** Load persisted unstable hosts from disk. */
async function loadHostReputation(): Promise<Map<string, number>> {
  try {
    let fileExists: boolean;
    try {
      await access(REPUTATION_PATH);
      fileExists = true;
    } catch {
      fileExists = false;
    }
    if (!fileExists) return new Map();
    const raw = await readFile(REPUTATION_PATH, 'utf8');
    const data = JSON.parse(raw) as Record<string, number>;
    const map = new Map<string, number>();
    const now = Date.now();
    for (const [ip, ts] of Object.entries(data)) {
      // Only load entries that haven't expired
      if (now - ts < UNSTABLE_HOST_COOLDOWN_MS) map.set(ip, ts);
    }
    return map;
  } catch (err) { log.debug({ error: err instanceof Error ? err.message : String(err) }, 'loadHostReputation failed (intentionally ignored)'); return new Map(); }
}

/** Save unstable hosts to disk (debounced by caller). */
async function saveHostReputation(hosts: Map<string, number>): Promise<void> {
  try {
    let dirExists: boolean;
    try {
      await access(REPUTATION_DIR);
      dirExists = true;
    } catch {
      dirExists = false;
    }
    if (!dirExists) await mkdir(REPUTATION_DIR, { recursive: true });
    const obj: Record<string, number> = {};
    for (const [ip, ts] of hosts) obj[ip] = ts;
    await writeFile(REPUTATION_PATH, JSON.stringify(obj, null, 2));
  } catch (err) { log.debug({ error: err instanceof Error ? err.message : String(err) }, 'saveHostReputation failed (intentionally ignored)'); }
}

/** Offer cache entry */
interface OfferCacheEntry {
  offers: Array<Record<string, unknown>>;
  ts: number;
  key: string;
}

export interface VastClientOptions extends AbstractGpuProviderOptions {}

export class VastClient extends AbstractGpuProvider {
  readonly providerId: string = 'vast';
  /**
   * runtype passed to PUT /asks/{id}/. Overridden by VastVmClient to 'vm'
   * for KVM-mode deploys (required for CRIU/snapshot capture — containers
   * strip CAP_SYS_ADMIN even with --privileged).
   */
  protected readonly _runtype: 'ssh_direct' | 'vm' = 'ssh_direct';
  /** Vast.ai cold boot base.
   *
   * The boot-poller uses 3× this value as the maximum wait (= 30 min default).
   * That matches POLL_TOTAL_MAX_MS (30 min) inside _pollForEndpoint.
   *
   * For large images (50 GB+) on slow hosts, raise this:
   *   VAST_BOOT_TIME_SECS=1200  → poller waits up to 60 min
   *
   * Why Vast.ai deployments appear "frozen":
   *   1. The Docker HEALTHCHECK inside the image fires before the model loads
   *      → Vast.ai auto-destroys the instance.  Fix: remove HEALTHCHECK from
   *      the Dockerfile (or add --start-period=600s).
   *   2. The boot-poller timeout (bootTimeSecs × 3) expires before the 50+ GB
   *      image finishes pulling on a slow host → tier resets to idle and the
   *      instance is orphaned.  Fix: raise VAST_BOOT_TIME_SECS.
   *   3. Interruptible instances are reclaimed during the pull phase.
   *      Fix: use on-demand (spec.interruptible = false). */
  readonly bootTimeSecs = parseInt(process.env.VAST_BOOT_TIME_SECS || '600', 10);
  private _lastRequestMs = 0;
  /** IPs of hosts where we recently created instances (cross-call dedup). */
  private _recentlyUsedIps = new Set<string>();
  /** Hosts that reclaimed instances during loading — blacklisted with expiry timestamps. */
  private _unstableHosts: Map<string, number>;
  /** Debounce timer for persisting reputation. */
  private _reputationSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Offer search cache — avoids redundant API calls within TTL. */
  private _offerCache: OfferCacheEntry | null = null;
  /** Aggressive per-host failure counter → escalating cooldowns (persisted). */
  private _hostFailures = new Map<string, HostFailureRecord>();
  private _hostFailuresPath = HOST_BLACKLIST_PATH;
  /** Debounce timer for persisting host blacklist. */
  private _hostFailuresSaveTimer: ReturnType<typeof setTimeout> | null = null;

  dispose(): void {
    if (this._reputationSaveTimer) {
      clearTimeout(this._reputationSaveTimer);
      this._reputationSaveTimer = null;
    }
    if (this._hostFailuresSaveTimer) {
      clearTimeout(this._hostFailuresSaveTimer);
      this._hostFailuresSaveTimer = null;
    }
  }

  constructor(opts?: VastClientOptions) {
    super(opts);
    // P1b: Load persisted host reputation from disk (fire-and-forget)
    this._unstableHosts = new Map();
    loadHostReputation().then((map) => {
      this._unstableHosts = map;
      if (map.size > 0) {
        this.log.log(`[vast] Loaded ${map.size} unstable hosts from disk`);
      }
    }).catch(() => { /* ignore */ });
    // Load aggressive-blacklist per-host failure counters (fire-and-forget)
    this._loadHostFailures().then(() => {
      if (this._hostFailures.size > 0) {
        const banned = [...this._hostFailures.values()].filter(r => r.bannedUntilMs > Date.now()).length;
        this.log.log(`[vast] Loaded ${this._hostFailures.size} host failure records from disk (${banned} currently banned)`);
      }
    }).catch(() => { /* ignore */ });
  }

  /**
   * Hook for subclasses to further constrain the offer search. The default
   * VastClient implementation is a no-op. VastVmClient overrides to require
   * KVM-capable hosts (vms_enabled == true).
   */
  protected _augmentOfferSearch(_searchBody: Record<string, unknown>, _spec: InstanceSpec): void {
    // no-op in base class
  }

  /** Check if any requested GPU type requires Blackwell CUDA (12.8+). */
  private _needsBlackwellCuda(gpuTypes?: string[]): boolean {
    if (!gpuTypes?.length) return false;
    const blackwell = ['5090', '5080', '5070', 'B200', 'B100', 'GB200'];
    return gpuTypes.some(g => blackwell.some(b => g.includes(b)));
  }

  /** Mark a host as unstable (reclaimed an instance during loading). Persists to disk. */
  private _markHostUnstable(ip: string): void {
    this._unstableHosts.set(ip, Date.now());
    this.log.warn(`[vast] Host ${ip} marked as unstable (instance reclaimed during loading). Cooldown: ${UNSTABLE_HOST_COOLDOWN_MS / 60_000}min`);
    // Prune old entries
    if (this._unstableHosts.size > MAX_UNSTABLE_HOSTS) {
      const oldest = [...this._unstableHosts.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this._unstableHosts.delete(oldest[0]);
    }
    // Debounced persist to disk
    this._persistReputation();
  }

  /** Debounced save of host reputation to disk. */
  private _persistReputation(): void {
    if (this._reputationSaveTimer) clearTimeout(this._reputationSaveTimer);
    this._reputationSaveTimer = setTimeout(async () => {
      this._reputationSaveTimer = null;
      await saveHostReputation(this._unstableHosts);
    }, 500);
  }

  /** Check if a host is currently blacklisted. */
  private _isHostUnstable(ip: string): boolean {
    const ts = this._unstableHosts.get(ip);
    if (!ts) return false;
    if (Date.now() - ts > UNSTABLE_HOST_COOLDOWN_MS) {
      this._unstableHosts.delete(ip); // Cooldown expired
      return false;
    }
    return true;
  }

  // ── Aggressive host blacklist (escalating cooldowns) ────────────────────────

  /** Load per-host failure counters from disk. Drops stale/expired records. */
  private async _loadHostFailures(): Promise<void> {
    try {
      let fileExists: boolean;
      try {
        await access(this._hostFailuresPath);
        fileExists = true;
      } catch {
        fileExists = false;
      }
      if (!fileExists) return;
      const raw = await readFile(this._hostFailuresPath, 'utf8');
      const data = JSON.parse(raw) as Record<string, HostFailureRecord>;
      const now = Date.now();
      for (const [ip, rec] of Object.entries(data)) {
        if (!rec || typeof rec !== 'object') continue;
        const lastFailure = Number(rec.lastFailureMs) || 0;
        // Drop records whose last failure is older than the reset window AND
        // whose ban has fully expired — they're no longer useful signal.
        if (now - lastFailure > HOST_FAILURE_RESET_MS && (Number(rec.bannedUntilMs) || 0) <= now) {
          continue;
        }
        this._hostFailures.set(ip, {
          count: Number(rec.count) || 0,
          bannedUntilMs: Number(rec.bannedUntilMs) || 0,
          lastFailureMs: lastFailure,
        });
      }
    } catch (err) {
      this.log.debug(`[vast] _loadHostFailures failed: ${this.errMsg(err)}`);
    }
  }

  /** Persist per-host failure counters to disk (debounced). */
  private _persistHostFailures(): void {
    if (this._hostFailuresSaveTimer) clearTimeout(this._hostFailuresSaveTimer);
    this._hostFailuresSaveTimer = setTimeout(async () => {
      this._hostFailuresSaveTimer = null;
      try {
        let dirExists: boolean;
        try {
          await access(HOST_BLACKLIST_DIR);
          dirExists = true;
        } catch {
          dirExists = false;
        }
        if (!dirExists) await mkdir(HOST_BLACKLIST_DIR, { recursive: true });
        const obj: Record<string, HostFailureRecord> = {};
        for (const [ip, rec] of this._hostFailures) obj[ip] = rec;
        await writeFile(this._hostFailuresPath, JSON.stringify(obj, null, 2));
      } catch (err) {
        this.log.debug(`[vast] _persistHostFailures failed: ${this.errMsg(err)}`);
      }
    }, 500);
  }

  /** True if the host has an active ban (ban expiry in the future). */
  private _isHostBanned(ip: string): boolean {
    if (!ip) return false;
    const rec = this._hostFailures.get(ip);
    if (!rec) return false;
    if (rec.bannedUntilMs <= Date.now()) {
      // Ban expired. Keep the count around so the next failure escalates;
      // _loadHostFailures will eventually drop it after HOST_FAILURE_RESET_MS.
      return false;
    }
    return true;
  }

  /**
   * Record a failure for this host — increment counter and escalate cooldown:
   *   1 failure  → 5 min ban
   *   2 failures → 30 min ban
   *   3+ failures → 1 hour ban
   */
  private _recordHostFailure(ip: string): void {
    if (!ip) return;
    const now = Date.now();
    const existing = this._hostFailures.get(ip);
    const count = (existing?.count ?? 0) + 1;

    let banMs: number;
    if (count <= 1) banMs = HOST_BAN_1_FAILURE_MS;
    else if (count === 2) banMs = HOST_BAN_2_FAILURES_MS;
    else banMs = HOST_BAN_3PLUS_FAILURES_MS;

    const rec: HostFailureRecord = {
      count,
      bannedUntilMs: now + banMs,
      lastFailureMs: now,
    };
    this._hostFailures.set(ip, rec);
    this.log.warn(`[vast] Host ${ip} failure #${count} → banned for ${Math.round(banMs / 60_000)}min`);
    this._persistHostFailures();
  }

  /** Clear this host's failure record after a successful boot. */
  private _recordHostSuccess(ip: string): void {
    if (!ip) return;
    if (!this._hostFailures.has(ip)) return;
    this._hostFailures.delete(ip);
    this.log.log(`[vast] Host ${ip} success → cleared failure record`);
    this._persistHostFailures();
  }

  /**
   * Best-effort cleanup of an instance that failed during creation/setup.
   *
   * Why this exists: bare empty-catch cleanup blocks were
   * silently leaking instances when cleanup failed (e.g., API timeout, rate
   * limit). Each leaked instance is a $0.30-1.00/hr bill running until manual
   * intervention. This helper retries once and ALWAYS surfaces the failure
   * via log + emitError + persistence event so cost-monitor can reconcile it.
   */
  private async _safeCleanupInstance(instanceId: string, apiKey: string, reason: string): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.deleteInstance(instanceId, { apiKey });
        if (attempt > 0) this.log.log(`[vast] cleanup ${instanceId} succeeded on retry (reason: ${reason})`);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
      }
    }
    // Cleanup failed after retry — instance is potentially orphaned and accruing cost.
    // Log loudly so the orphan-detection sweep picks it up.
    const errMsg = this.errMsg(lastErr);
    this.log.error(`[vast] ⚠ ORPHAN RISK: failed to delete instance ${instanceId} (${reason}): ${errMsg}`);
    this.emitError({
      operation: 'cleanup',
      instanceId,
      message: `Failed to delete instance after ${reason}: ${errMsg}`,
      retryable: false,
    });
  }

  /**
   * Rate-limited fetch for Vast.ai API.
   * Enforces minimum interval between requests and retries on 429.
   */
  private async _vastFetch(url: string, init?: RequestInit, timeout = TIMEOUTS.read): Promise<Response> {
    // Enforce minimum interval between requests (~3 req/s)
    const now = Date.now();
    const elapsed = now - this._lastRequestMs;
    if (elapsed < RATE_LIMIT_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, RATE_LIMIT_INTERVAL_MS - elapsed));
    }
    this._lastRequestMs = Date.now();

    // Fetch with 429 retry
    let lastRes: Response | undefined;
    for (let attempt = 0; attempt <= RATE_LIMIT_429_MAX_RETRIES; attempt++) {
      lastRes = await this.fetchRaw(url, init, timeout);
      if (lastRes.status !== 429) return lastRes;

      if (attempt < RATE_LIMIT_429_MAX_RETRIES) {
        const backoff = RATE_LIMIT_429_RETRY_MS * (attempt + 1);
        this.log.warn(`[vast] 429 rate limited on ${url.replace(VAST_API_BASE, '')}, retry in ${backoff}ms (${attempt + 1}/${RATE_LIMIT_429_MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, backoff));
        this._lastRequestMs = Date.now();
      }
    }

    // All retries exhausted — throw instead of returning 429 (callers expect valid data)
    const errMsg = `Vast.ai rate limit exhausted after ${RATE_LIMIT_429_MAX_RETRIES} retries: ${url.replace(VAST_API_BASE, '')}`;
    this.emitError({
      operation: '_vastFetch',
      message: errMsg,
      errorCode: 'HTTP_429',
      httpStatus: 429,
      retryable: true,
    });
    throw new Error(errMsg);
  }

  async discoverInstance(
    credentials: ProviderCredentials,
    _gpuTypes: string[],
  ): Promise<GpuInstance | null> {
    const instances = await this.listInstances(credentials);
    // Prefer instances that are fully running with a reachable endpoint.
    // Fall back to any running/booting instance (may still be coming up).
    const USABLE_STATUSES = new Set(['running', 'booting']);
    const withEndpoint = instances.find(
      (i) => USABLE_STATUSES.has(i.status?.toLowerCase() ?? '') && !!i.endpoint,
    );
    if (withEndpoint) return withEndpoint;
    const anyRunning = instances.find(
      (i) => USABLE_STATUSES.has(i.status?.toLowerCase() ?? ''),
    );
    return anyRunning ?? null;
  }

  // ── Templates ────────────────────────────────────────────────────────────
  // Vast.ai templates are pre-configured "blueprints" that contain a Docker
  // image, environment vars, ports, onstart command, etc. They have two
  // benefits over passing the same fields on every create:
  //   1. **Hosts cache by template** — once a host has run the template once,
  //      subsequent instances on the same host skip the docker pull entirely.
  //      For a 15GB image this drops the boot time from ~25 min to ~30 sec.
  //   2. **Cleaner metadata** — Vast's marketplace shows the template name
  //      so you can identify the workload across instances.
  //
  // Use `findOrCreateTemplate(name, ...)` for idempotent setup: it lists
  // your existing templates first, returning the hash_id if a matching
  // (name + image) one already exists, or creating a new one otherwise.

  /**
   * Spec for creating a Vast.ai template. Mirrors the POST /template/ body
   * with TS-friendly camelCase field names.
   */
  /* eslint-disable @typescript-eslint/no-unused-vars */
  // (interface defined inline to avoid bloating ./types.ts; only used here)

  /**
   * Create a Vast.ai template via POST /template/. Returns the new template's
   * `hash_id` which can be passed as `templateHashId` to `createInstance()`.
   *
   * NOTE: this is idempotent at the API level — Vast.ai allows duplicate
   * templates with the same name. Use `findOrCreateTemplate()` for true
   * idempotency.
   */
  async createTemplate(
    spec: {
      name: string;
      image: string;          // e.g. 'marcosremar/trellis2'
      tag?: string;           // default: 'latest'
      envVars?: Record<string, string>;  // expanded into -e KEY=VAL flags
      exposePorts?: number[]; // expanded into -p PORT:PORT flags
      onstartCmd?: string;    // command to run after boot
      diskSpaceGb?: number;   // recommended disk
      useSsh?: boolean;       // default: true
      useJupyter?: boolean;   // default: false
    },
    credentials: ProviderCredentials,
  ): Promise<{ hashId: string; id: number }> {
    const tag = spec.tag ?? 'latest';
    // Build the env string Vast.ai expects: "-p 8000:8000 -e KEY=VAL ..."
    const envParts: string[] = [];
    for (const port of spec.exposePorts ?? [8000]) {
      envParts.push(`-p ${port}:${port}`);
    }
    for (const [k, v] of Object.entries(spec.envVars ?? {})) {
      envParts.push(`-e ${k}=${v}`);
    }
    const envString = envParts.join(' ');

    const body = {
      name: spec.name,
      image: spec.image,
      tag,
      image_uuid: `${spec.image}:${tag}`,
      env: envString,
      onstart_cmd: spec.onstartCmd ?? '',
      runtype: 'args',
      use_jupyter_lab: spec.useJupyter ?? false,
      use_ssh: spec.useSsh ?? true,
      extra_filters: {},
      disk_space: spec.diskSpaceGb ?? 16,
    };

    const res = await this._vastFetch(`${VAST_API_BASE}/template/`, {
      method: 'POST',
      headers: this.jsonHeaders(credentials.apiKey),
      body: JSON.stringify(body),
    }, TIMEOUTS.create);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Vast.ai createTemplate failed: HTTP ${res.status} ${errText.substring(0, 300)}`);
    }
    const data = (await res.json()) as { success: boolean; template?: { hash_id: string; id: number }; msg?: string };
    if (!data.success || !data.template?.hash_id) {
      throw new Error(`Vast.ai createTemplate returned unexpected payload: ${JSON.stringify(data).substring(0, 300)}`);
    }
    this.log.log(`[vast] Created template "${spec.name}" → ${data.template.hash_id} (id=${data.template.id})`);
    return { hashId: data.template.hash_id, id: data.template.id };
  }

  /**
   * List all templates owned by the current user. Returns a minimal projection
   * suitable for matching by name/image.
   */
  async listTemplates(credentials: ProviderCredentials): Promise<Array<{
    hashId: string;
    id: number;
    name: string;
    image: string;
    tag?: string;
  }>> {
    const res = await this._vastFetch(`${VAST_API_BASE}/users/current/templates/`, {
      method: 'GET',
      headers: this.jsonHeaders(credentials.apiKey),
    }, TIMEOUTS.read);
    if (!res.ok) {
      throw new Error(`Vast.ai listTemplates failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { templates?: Array<Record<string, unknown>> };
    return (data.templates ?? []).map((t) => ({
      hashId: (t.hash_id as string) ?? '',
      id: (t.id as number) ?? 0,
      name: (t.name as string) ?? '',
      image: (t.image as string) ?? (t.image_uuid as string) ?? '',
      tag: t.tag as string | undefined,
    })).filter(t => t.hashId);
  }

  /**
   * Idempotent template setup: if a template with the same name AND image
   * already exists, return its hash_id. Otherwise create one.
   *
   * This is the recommended way to set up a template once and reuse it
   * across deploys — host caching kicks in after the first deploy on each
   * host, so subsequent deploys to the same host skip the docker pull.
   */
  async findOrCreateTemplate(
    spec: Parameters<typeof this.createTemplate>[0],
    credentials: ProviderCredentials,
  ): Promise<{ hashId: string; id: number; created: boolean }> {
    const tag = spec.tag ?? 'latest';
    const wantImage = spec.image;
    const wantTag = tag;
    try {
      const existing = await this.listTemplates(credentials);
      const match = existing.find(t =>
        t.name === spec.name &&
        t.image === wantImage &&
        (t.tag === wantTag || (!t.tag && wantTag === 'latest'))
      );
      if (match) {
        this.log.log(`[vast] Reusing existing template "${spec.name}" → ${match.hashId}`);
        return { hashId: match.hashId, id: match.id, created: false };
      }
    } catch (e) {
      this.log.warn(`[vast] listTemplates failed, will try to create: ${this.errMsg(e)}`);
    }
    const created = await this.createTemplate(spec, credentials);
    return { ...created, created: true };
  }

  /**
   * Update an existing template's name, image tag, description, or disk space.
   * Vast.ai regenerates the hash_id on update — the returned hashId may differ.
   */
  async updateTemplate(
    hashId: string,
    updates: {
      name?: string;
      image?: string;
      tag?: string;
      diskSpaceGb?: number;
      desc?: string;
    },
    credentials: ProviderCredentials,
  ): Promise<{ hashId: string; id: number }> {
    const body: Record<string, unknown> = { hash_id: hashId };
    if (updates.name !== undefined) body.name = updates.name;
    if (updates.image !== undefined) body.image = updates.image;
    if (updates.tag !== undefined) body.tag = updates.tag;
    if (updates.diskSpaceGb !== undefined) body.disk_space = updates.diskSpaceGb;
    if (updates.desc !== undefined) body.desc = updates.desc;

    const res = await this._vastFetch(`${VAST_API_BASE}/template/`, {
      method: 'PUT',
      headers: this.jsonHeaders(credentials.apiKey),
      body: JSON.stringify(body),
    }, TIMEOUTS.create);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Vast.ai updateTemplate failed: HTTP ${res.status} ${errText.substring(0, 300)}`);
    }
    const data = (await res.json()) as { success: boolean; template?: { id: number; hash_id: string } };
    if (!data.success) throw new Error(`Vast.ai updateTemplate returned success=false`);
    const newHashId = data.template?.hash_id ?? hashId;
    this.log.log(`[vast] Updated template ${hashId} → ${newHashId}`);
    return { hashId: newHashId, id: data.template?.id ?? 0 };
  }

  /**
   * Delete a template by its numeric ID (not hash_id).
   * Use `listTemplates()` to find the numeric ID if you only have the hash_id.
   */
  async deleteTemplate(templateId: number, credentials: ProviderCredentials): Promise<void> {
    const res = await this._vastFetch(`${VAST_API_BASE}/template/?template_id=${templateId}`, {
      method: 'DELETE',
      headers: this.jsonHeaders(credentials.apiKey),
    }, TIMEOUTS.create);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Vast.ai deleteTemplate(${templateId}) failed: HTTP ${res.status} ${errText.substring(0, 300)}`);
    }
    this.log.log(`[vast] Deleted template id=${templateId}`);
  }

  // ── Serverless Endpoints ──────────────────────────────────────────────────
  // Vast.ai serverless = an auto-scaling GPU cluster behind a named endpoint.
  // You define scaling params (min_load, target_util, max_workers) on the
  // endpoint, then attach one or more "worker groups" that each recruit from
  // different GPU offer pools (by template + search query).
  // Traffic is load-balanced via run.vast.ai/route/ → worker URL.

  /**
   * Create a serverless endpoint. Returns the new endpoint's numeric ID.
   * After creation, add at least one worker group via `createWorkerGroup()`.
   */
  async createEndpoint(
    spec: {
      /** Endpoint name — also used as the routing key in routeRequest(). */
      name: string;
      /** Minimum load before scaling (default: 10). */
      minLoad?: number;
      /** Target GPU utilization 0–1 (default: 0.9). */
      targetUtil?: number;
      /** Cold-start overhead multiplier for scheduling (default: 2.5). */
      coldMult?: number;
      /** Pre-warmed (cold) workers kept alive (default: 5). */
      coldWorkers?: number;
      /** Hard cap on concurrent workers (default: 20). */
      maxWorkers?: number;
    },
    credentials: ProviderCredentials,
  ): Promise<{ id: number; name: string }> {
    const body: Record<string, unknown> = { endpoint_name: spec.name };
    if (spec.minLoad !== undefined) body.min_load = spec.minLoad;
    if (spec.targetUtil !== undefined) body.target_util = spec.targetUtil;
    if (spec.coldMult !== undefined) body.cold_mult = spec.coldMult;
    if (spec.coldWorkers !== undefined) body.cold_workers = spec.coldWorkers;
    if (spec.maxWorkers !== undefined) body.max_workers = spec.maxWorkers;

    const res = await this._vastFetch(`${VAST_API_BASE}/endptjobs/`, {
      method: 'POST',
      headers: this.jsonHeaders(credentials.apiKey),
      body: JSON.stringify(body),
    }, TIMEOUTS.create);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Vast.ai createEndpoint failed: HTTP ${res.status} ${errText.substring(0, 300)}`);
    }
    const data = (await res.json()) as { success: boolean; result?: number };
    if (!data.success || !data.result) {
      throw new Error(`Vast.ai createEndpoint unexpected payload: ${JSON.stringify(data).substring(0, 200)}`);
    }
    this.log.log(`[vast] Created serverless endpoint "${spec.name}" → id=${data.result}`);
    return { id: data.result, name: spec.name };
  }

  /** List all serverless endpoints on the account with their scaling config. */
  async listEndpoints(credentials: ProviderCredentials): Promise<Array<{
    id: number;
    name: string;
    /** Per-endpoint API key used for routeRequest() and getEndpointLogs(). */
    apiKey: string;
    state: string;
    minLoad: number;
    targetUtil: number;
    coldWorkers: number;
    maxWorkers: number;
    createdAt: string;
  }>> {
    const res = await this._vastFetch(`${VAST_API_BASE}/endptjobs/`, {
      headers: this.jsonHeaders(credentials.apiKey),
    }, TIMEOUTS.read);
    if (!res.ok) throw new Error(`Vast.ai listEndpoints failed: HTTP ${res.status}`);
    const raw = (await res.json()) as Record<string, unknown>;
    const items = (Array.isArray(raw) ? raw : (raw.results as unknown[] ?? [])) as Array<Record<string, unknown>>;
    return items.map(ep => ({
      id: (ep.id as number) ?? 0,
      name: (ep.endpoint_name as string) ?? '',
      apiKey: (ep.api_key as string) ?? '',
      state: (ep.endpoint_state as string) ?? 'unknown',
      minLoad: (ep.min_load as number) ?? 10,
      targetUtil: (ep.target_util as number) ?? 0.9,
      coldWorkers: (ep.cold_workers as number) ?? 5,
      maxWorkers: (ep.max_workers as number) ?? 20,
      createdAt: (ep.created_at as string) ?? '',
    }));
  }

  /**
   * Delete a serverless endpoint and terminate all its workers.
   * Returns which workers were deleted vs which failed to terminate.
   */
  async deleteEndpoint(endpointId: number, credentials: ProviderCredentials): Promise<{
    deletedWorkers: number[];
    failedWorkers: number[];
  }> {
    const res = await this._vastFetch(`${VAST_API_BASE}/endptjobs/${endpointId}/`, {
      method: 'DELETE',
      headers: this.jsonHeaders(credentials.apiKey),
    }, TIMEOUTS.create);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Vast.ai deleteEndpoint(${endpointId}) failed: HTTP ${res.status} ${errText.substring(0, 300)}`);
    }
    const data = (await res.json()) as { success: boolean; deleted_workers?: number[]; failed_workers?: number[]; msg?: string };
    this.log.log(`[vast] Deleted endpoint id=${endpointId}: ${data.msg ?? 'ok'}`);
    return { deletedWorkers: data.deleted_workers ?? [], failedWorkers: data.failed_workers ?? [] };
  }

  /**
   * Create a worker group attached to an endpoint.
   * A worker group defines which GPUs to recruit (via templateHash + searchParams)
   * and its own scaling parameters. One endpoint can have multiple worker groups
   * targeting different GPU tiers (e.g. RTX 4090 + A100 fallback).
   */
  async createWorkerGroup(
    spec: {
      endpointId?: number;
      endpointName?: string;
      templateHash?: string;
      templateId?: number;
      /** Vast.ai offer search query string, e.g. "verified=true rentable=true gpu_ram>=24" */
      searchParams?: string;
      /** Extra args passed to the worker container at launch. */
      launchArgs?: string;
      /** Minimum GPU VRAM in GB for worker offers. */
      gpuRamGb?: number;
      minLoad?: number;
      targetUtil?: number;
      coldMult?: number;
      coldWorkers?: number;
      maxWorkers?: number;
      testWorkers?: number;
    },
    credentials: ProviderCredentials,
  ): Promise<{ id: number }> {
    const body: Record<string, unknown> = {};
    if (spec.endpointId !== undefined) body.endpoint_id = spec.endpointId;
    if (spec.endpointName !== undefined) body.endpoint_name = spec.endpointName;
    if (spec.templateHash !== undefined) body.template_hash = spec.templateHash;
    if (spec.templateId !== undefined) body.template_id = spec.templateId;
    if (spec.searchParams !== undefined) body.search_params = spec.searchParams;
    if (spec.launchArgs !== undefined) body.launch_args = spec.launchArgs;
    if (spec.gpuRamGb !== undefined) body.gpu_ram = spec.gpuRamGb;
    if (spec.minLoad !== undefined) body.min_load = spec.minLoad;
    if (spec.targetUtil !== undefined) body.target_util = spec.targetUtil;
    if (spec.coldMult !== undefined) body.cold_mult = spec.coldMult;
    if (spec.coldWorkers !== undefined) body.cold_workers = spec.coldWorkers;
    if (spec.maxWorkers !== undefined) body.max_workers = spec.maxWorkers;
    if (spec.testWorkers !== undefined) body.test_workers = spec.testWorkers;

    const res = await this._vastFetch(`${VAST_API_BASE}/workergroups/`, {
      method: 'POST',
      headers: this.jsonHeaders(credentials.apiKey),
      body: JSON.stringify(body),
    }, TIMEOUTS.create);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Vast.ai createWorkerGroup failed: HTTP ${res.status} ${errText.substring(0, 300)}`);
    }
    const data = (await res.json()) as { success: boolean; id?: number };
    if (!data.success) throw new Error(`Vast.ai createWorkerGroup returned success=false`);
    this.log.log(`[vast] Created worker group → id=${data.id}`);
    return { id: data.id ?? 0 };
  }

  /** List all worker groups on the account. */
  async listWorkerGroups(credentials: ProviderCredentials): Promise<Array<{
    id: number;
    endpointId: number;
    endpointName: string;
    templateHash: string;
    searchQuery: Record<string, unknown>;
    gpuRamGb: number;
    maxWorkers: number;
    createdAt: string;
  }>> {
    const res = await this._vastFetch(`${VAST_API_BASE}/workergroups/`, {
      headers: this.jsonHeaders(credentials.apiKey),
    }, TIMEOUTS.read);
    if (!res.ok) throw new Error(`Vast.ai listWorkerGroups failed: HTTP ${res.status}`);
    const raw = (await res.json()) as Record<string, unknown>;
    const items = (Array.isArray(raw) ? raw : (raw.results as unknown[] ?? [])) as Array<Record<string, unknown>>;
    return items.map(wg => ({
      id: (wg.id as number) ?? 0,
      endpointId: (wg.endpoint_id as number) ?? 0,
      endpointName: (wg.endpoint_name as string) ?? '',
      templateHash: (wg.template_hash as string) ?? '',
      searchQuery: (wg.search_query as Record<string, unknown>) ?? {},
      gpuRamGb: (wg.gpu_ram as number) ?? 0,
      maxWorkers: (wg.max_workers as number) ?? 0,
      createdAt: (wg.created_at as string) ?? '',
    }));
  }

  /**
   * Update a worker group's scaling params, GPU filter, or template.
   * ⚠️ Vast.ai requires `endpointId` or `endpointName` even for partial updates
   * (returns 400 "Missing endpoint ID" otherwise).
   */
  async updateWorkerGroup(
    id: number,
    updates: {
      minLoad?: number;
      targetUtil?: number;
      coldMult?: number;
      testWorkers?: number;
      templateHash?: string;
      templateId?: number;
      searchParams?: string;
      launchArgs?: string;
      gpuRamGb?: number;
      endpointName?: string;
      endpointId?: number;
    },
    credentials: ProviderCredentials,
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (updates.minLoad !== undefined) body.min_load = updates.minLoad;
    if (updates.targetUtil !== undefined) body.target_util = updates.targetUtil;
    if (updates.coldMult !== undefined) body.cold_mult = updates.coldMult;
    if (updates.testWorkers !== undefined) body.test_workers = updates.testWorkers;
    if (updates.templateHash !== undefined) body.template_hash = updates.templateHash;
    if (updates.templateId !== undefined) body.template_id = updates.templateId;
    if (updates.searchParams !== undefined) body.search_params = updates.searchParams;
    if (updates.launchArgs !== undefined) body.launch_args = updates.launchArgs;
    if (updates.gpuRamGb !== undefined) body.gpu_ram = updates.gpuRamGb;
    if (updates.endpointName !== undefined) body.endpoint_name = updates.endpointName;
    if (updates.endpointId !== undefined) body.endpoint_id = updates.endpointId;

    const res = await this._vastFetch(`${VAST_API_BASE}/workergroups/${id}/`, {
      method: 'PUT',
      headers: this.jsonHeaders(credentials.apiKey),
      body: JSON.stringify(body),
    }, TIMEOUTS.create);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Vast.ai updateWorkerGroup(${id}) failed: HTTP ${res.status} ${errText.substring(0, 300)}`);
    }
    this.log.log(`[vast] Updated worker group id=${id}`);
  }

  /** Delete a worker group and stop its workers. */
  async deleteWorkerGroup(id: number, credentials: ProviderCredentials): Promise<{
    deletedWorkers: number[];
    failedWorkers: number[];
  }> {
    const res = await this._vastFetch(`${VAST_API_BASE}/workergroups/${id}/`, {
      method: 'DELETE',
      headers: this.jsonHeaders(credentials.apiKey),
    }, TIMEOUTS.create);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Vast.ai deleteWorkerGroup(${id}) failed: HTTP ${res.status} ${errText.substring(0, 300)}`);
    }
    const data = (await res.json()) as { success: boolean; deleted_workers?: number[]; failed_workers?: number[]; msg?: string };
    this.log.log(`[vast] Deleted worker group id=${id}: ${data.msg ?? 'ok'}`);
    return { deletedWorkers: data.deleted_workers ?? [], failedWorkers: data.failed_workers ?? [] };
  }

  /**
   * Get logs from a serverless endpoint.
   * Uses run.vast.ai (different base URL from the management API).
   * Requires the endpoint's own `apiKey` (from `listEndpoints()`) — NOT the account key.
   */
  async getEndpointLogs(
    endpointName: string,
    endpointApiKey: string,
    lines: number = 100,
  ): Promise<string | null> {
    try {
      const res = await this._vastFetch('https://run.vast.ai/get_endpoint_logs/', {
        method: 'POST',
        headers: this.jsonHeaders(endpointApiKey),
        body: JSON.stringify({ endpoint: endpointName, tail: lines }),
      }, TIMEOUTS.read);
      if (!res.ok) return null;
      const data = (await res.json()) as { logs?: string };
      return data.logs ?? null;
    } catch (err) {
      this.log.debug(`[vast] getEndpointLogs("${endpointName}") failed: ${this.errMsg(err)}`);
      return null;
    }
  }

  /**
   * Route an inference request to the least-loaded available worker.
   * Returns the worker's URL to direct the actual inference request to.
   *
   * Uses run.vast.ai (Vast.ai's inference router).
   * Requires the endpoint's own `apiKey` from `listEndpoints()`.
   * `cost` is an estimated compute cost hint used for load-balancing (any positive number).
   *
   * Returns null if no worker is currently available (cold start in progress).
   */
  async routeRequest(
    endpointName: string,
    endpointApiKey: string,
    cost: number = 100,
  ): Promise<{ url: string; reqnum: number; signature: string; requestId: string } | null> {
    try {
      const res = await this._vastFetch('https://run.vast.ai/route/', {
        method: 'POST',
        headers: this.jsonHeaders(endpointApiKey),
        body: JSON.stringify({ endpoint: endpointName, cost }),
      }, 10_000);
      if (!res.ok) return null;
      const data = (await res.json()) as {
        url?: string;
        reqnum?: number;
        signature?: string;
        __request_id?: string;
        status?: string;
      };
      if (!data.url) {
        this.log.log(`[vast] routeRequest("${endpointName}"): no worker available (status=${data.status ?? 'cold'})`);
        return null;
      }
      return {
        url: data.url,
        reqnum: data.reqnum ?? 0,
        signature: data.signature ?? '',
        requestId: data.__request_id ?? '',
      };
    } catch (err) {
      this.log.debug(`[vast] routeRequest("${endpointName}") failed: ${this.errMsg(err)}`);
      return null;
    }
  }

  async createInstance(
    spec: InstanceSpec,
    credentials: ProviderCredentials,
    userId?: string,
  ): Promise<GpuInstance> {
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);

    // ── Preflight: account balance check ──────────────────────────────────
    await this._runPreflight(credentials);

    // ── 1. Auto-detect disk from Docker image if not specified ─────────────
    if (!spec.dockerImage) {
      throw new Error('[vast] spec.dockerImage is required — no default image');
    }
    const imageName = spec.dockerImage;
    const { getMinDiskGb } = await import('./deploy-settings');
    let diskGb = spec.storageGb ?? 0;
    if (diskGb <= 0) {
      diskGb = await AbstractGpuProvider.estimateImageDiskGb(imageName, 20);
      this.log.log(`[vast] Auto-detected disk size for ${imageName}: ${diskGb}GB`);
    }
    diskGb = Math.max(diskGb, getMinDiskGb());

    // ── 2. Search for cheapest available offer ─────────────────────────────
    // P0b: NOTE — direct_port_count filter intentionally REMOVED. SSH-only hosts
    // (e.g. RTX 5090 Blackwell) are now first-class citizens via SSH tunnel fallback.
    // We try direct-port hosts first (faster), then SSH-only as a 2nd-pass fallback.
    const isHighQualitySearch = spec.searchMode === 'full' ? false : spec.strictFastBoot !== false;
    const searchBody: Record<string, unknown> = {
      limit: 50,
      // Spot/interruptible offers are searched with type:'bid' (≈50-70% cheaper
      // than on-demand). On-demand otherwise. Without this, --prefer-spot was a
      // no-op on Vast and every job paid on-demand price.
      type: spec.interruptible ? 'bid' : 'on-demand',
      rentable: { eq: true },
      rented: { eq: false },
      // gpu_frac=1.0 → only the WHOLE physical GPU. This also excludes a
      // dedicated single GPU on a multi-GPU rig (gpu_frac<1 there), which
      // wipes out most A6000/L40S/4090 offers. Gate it to strict mode only;
      // num_gpus already pins the GPU count we rent.
      ...(isHighQualitySearch ? { gpu_frac: { eq: 1.0 } } : {}),
      // cpu_ram >= 16GB. 32GB excludes most consumer-GPU hosts; 16GB is
      // enough headroom for small/medium models. Override via spec.ramGb.
      cpu_ram: { gte: 16384 },
      // Verified hosts only in strict mode — most quality hosts are
      // unverified but carry high reliability2, so don't hard-require it
      // outside strict (it alone zeroed A6000 offers).
      ...(isHighQualitySearch ? { verified: { eq: true } } : {}),
      num_gpus: { eq: spec.gpuCount ?? 1 },
      disk_space: { gte: diskGb },
      // P0b: Phase-1 — prefer direct-port hosts (no SSH tunnel needed, faster)
      ...(isHighQualitySearch ? { direct_port_count: { gte: 1 } } : {}),
      // CUDA filter: 12.8+ for Blackwell (RTX 5090/5080), 12.4+ for everything else
      cuda_vers: { gte: this._needsBlackwellCuda(spec.gpuTypes) ? 12.8 : 12.4 },
      // Host quality filters — fast internet critical for 10GB+ images to boot under 15min
      // Strict-fast-boot opts into a higher reliability bar (0.97) to filter out
      // hosts that historically zombie. Default 0.95 keeps backwards compat.
      reliability2: { gte: isHighQualitySearch ? 0.97 : 0.95 },
      // Minimum download bandwidth. Explicit spec.minInetDownMbps is never clamped.
      // When unset, use min(deploy-settings, DEFAULT_CREATE_INET_DOWN_MBPS=500) so a
      // stale persisted 2000 does not wipe consumer-GPU inventory.
      inet_down: {
        gte:
          spec.minInetDownMbps != null
            ? spec.minInetDownMbps
            : Math.min(getMinInetDownMbps(), DEFAULT_CREATE_INET_DOWN_MBPS),
      },
      inet_up: { gte: 100 },            // Minimum 100 Mb/s upload
      ...(spec.directPortRequired ? { direct_port_count: { gte: spec.directPortRequired } } : {}),
      order: [['dph_total', 'asc']],
    };

    const isDesktopPolicy = spec.offerPolicy === 'desktop';
    if (isDesktopPolicy) {
      const desktopCap = spec.maxPricePerHr ?? VAST_DESKTOP_MAX_PER_HR;
      Object.assign(
        searchBody,
        vastDesktopSearchFilters({
          maxPerHr: desktopCap,
          ...(spec.minInetDownMbps != null ? { minInetDownMbps: spec.minInetDownMbps } : {}),
        }),
      );
      this.log.log(
        `[vast] Desktop offer policy: reliability≥0.95 inet_down>1000 dph≤$${desktopCap}/hr`,
      );
    }

    // Filter by GPU type if specified
    const gpuTypes = spec.gpuTypes?.filter(t => t && t.length > 0 && t.length <= 50);
    if (gpuTypes?.length) {
      searchBody.gpu_name = { in: normalizeGpuNames(gpuTypes) };
    }

    // Filter by minimum RAM if specified
    if (spec.ramGb) {
      searchBody.cpu_ram = { gte: spec.ramGb * 1024 };  // Vast.ai uses MB
    }

    // Merge extra search filters (e.g. { direct_port_count: { gte: 1 } })
    if (spec.extraSearch) {
      Object.assign(searchBody, spec.extraSearch);
    }

    // Subclasses (e.g. VastVmClient) may further narrow the offer search.
    this._augmentOfferSearch(searchBody, spec);

    // Filter by region/geolocation if specified (e.g. 'US', 'EU', 'FR', 'DE', 'France,Spain')
    // Vast.ai geolocation format: "France, FR" — client-side endsWith(', CC') is the only
    // reliable filter. Server-side geolocation eq filter does not work for country codes.
    const EU_CC = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','NO','CH','GB','IS'];
    let createGeoFilter: string[] | undefined;
    if (spec.region) {
      const r = spec.region.toUpperCase();
      if (r === 'EU' || r === 'EUROPE') {
        createGeoFilter = EU_CC;
      } else {
        // Support comma-separated list of country codes or names (e.g. 'FR,ES' or 'France,Spain')
        // Map full names to 2-letter codes for the endsWith filter
        const COUNTRY_TO_CC: Record<string, string> = {
          FRANCE: 'FR', SPAIN: 'ES', GERMANY: 'DE', NETHERLANDS: 'NL', ITALY: 'IT',
          PORTUGAL: 'PT', POLAND: 'PL', SWEDEN: 'SE', NORWAY: 'NO', SWITZERLAND: 'CH',
          UNITEDKINGDOM: 'GB', UK: 'GB', UNITEDSTATES: 'US', USA: 'US',
        };
        createGeoFilter = r.split(',').map(s => {
          const trimmed = s.trim().replace(/\s+/g, '');
          return COUNTRY_TO_CC[trimmed] ?? trimmed;
        });
      }
    }

    // Filter by max price per hour if specified
    if (spec.maxPricePerHr) {
      searchBody.dph_total = { lte: spec.maxPricePerHr };
    }

    let offers = await this._searchOffers(searchBody, headers);

    // Client-side enforcement — Vast.ai server-side filters do NOT honor
    // numeric thresholds for inet_down / inet_up reliably (offers come back
    // below the requested gte). Re-filter here so callers can trust the
    // bandwidth contract (large image pulls depend on it).
    // NOTE: skip filter when field absent (== null) — real Vast offers always
    // include inet_down/inet_up; missing field signals a non-prod payload
    // (test mock or partial response). Filtering these out caused 100+ unit
    // tests to fail when the bandwidth filter was added.
    {
      const inetFilter = searchBody.inet_down as { gte?: number; gt?: number } | undefined;
      const minDownGte = inetFilter?.gte;
      const minDownGt = inetFilter?.gt;
      const minUp = (searchBody.inet_up as { gte?: number } | undefined)?.gte;
      if (typeof minDownGte === 'number' || typeof minDownGt === 'number' || typeof minUp === 'number') {
        const before = offers.length;
        offers = offers.filter(o => {
          if (typeof minDownGte === 'number' && o.inet_down != null && Number(o.inet_down) < minDownGte) return false;
          if (typeof minDownGt === 'number' && o.inet_down != null && Number(o.inet_down) <= minDownGt) return false;
          if (typeof minUp === 'number' && o.inet_up != null && Number(o.inet_up) < minUp) return false;
          return true;
        });
        if (offers.length !== before) {
          const downLabel = typeof minDownGt === 'number' ? `>${minDownGt}` : `>=${minDownGte ?? '-'}`;
          this.log.log(`[vast] Bandwidth client-filter: ${before} → ${offers.length} offers (down${downLabel}, up>=${minUp ?? '-'})`);
        }
      }
    }

    // Client-side geo filter — Vast.ai geolocation is "Country, CC", so endsWith(', CC')
    if (createGeoFilter && offers.length) {
      const before = offers.length;
      offers = offers.filter(o => {
        const geo = String(o.geolocation || '');
        return createGeoFilter!.some(cc => geoMatchesCountryCode(geo, cc));
      });
      this.log.log(`[vast] Geo filter (create): ${before} → ${offers.length} offers matching [${createGeoFilter.join(',')}]`);
    }

    // Desktop policy: client-side rank (strict >1000 Mbps, ≥0.95, price cap). Prefer not
    // relaxing quality floors — desktop callers need bandwidth/reliability.
    if (isDesktopPolicy && offers.length) {
      const desktopCap = spec.maxPricePerHr ?? VAST_DESKTOP_MAX_PER_HR;
      const before = offers.length;
      const rankInputs: VastOfferRankInput[] = offers.map((o) => ({
        id: Number(o.id),
        dph_total: Number(o.dph_total),
        reliability2: Number(o.reliability2),
        inet_down: Number(o.inet_down),
        num_gpus: Number(o.num_gpus ?? 1),
        gpu_name: String(o.gpu_name ?? ''),
        rentable: o.rentable !== false,
        rented: o.rented === true,
        verified: o.verified as boolean | undefined,
      }));
      const ranked = rankVastOffers(rankInputs, desktopCap);
      const order = new Map(ranked.map((r, i) => [r.id, i]));
      offers = offers
        .filter((o) => order.has(Number(o.id)))
        .sort((a, b) => (order.get(Number(a.id)) ?? 0) - (order.get(Number(b.id)) ?? 0));
      if (offers.length !== before) {
        this.log.log(`[vast] Desktop rankVastOffers: ${before} → ${offers.length} (cap $${desktopCap}/hr)`);
      }
    }

    // Fallback: relax network requirements to find more hosts.
    // Skip quality soft-relax when the caller locked floors (desktop policy, or
    // explicit minInetDownMbps / maxPricePerHr from a facade). Softening to
    // reliability 0.9 + 500 Mbps would violate those policies.
    const floorsLocked =
      isDesktopPolicy ||
      spec.minInetDownMbps != null ||
      spec.maxPricePerHr != null;

    if (!offers.length && !floorsLocked) {
      const slowPullEstSec = Math.round((diskGb * 8 * 1024) / 500);
      this.log.warn(
        `[vast] No offers with strict filters — relaxing to inet_down: 500, reliability: 0.9. ` +
        `⚠ Slow hosts at 500 Mbps will take ~${Math.round(slowPullEstSec / 60)}min to pull the ${diskGb}GB image. ` +
        `Boot poller cap raised to 30 min to compensate.`,
      );
      searchBody.inet_down = { gte: 500 };
      searchBody.inet_up = { gte: 100 };
      searchBody.reliability2 = { gte: 0.9 };
      try {
        offers = await this._searchOffers(searchBody, headers);
        if (createGeoFilter && offers.length) {
          offers = offers.filter(o => {
            const geo = String(o.geolocation || '');
            return createGeoFilter!.some(cc => geoMatchesCountryCode(geo, cc));
          });
        }
      } catch (retryErr) {
        this.log.error(`[vast] Relaxed search also failed: ${this.errMsg(retryErr)}`);
      }
    } else if (!offers.length && floorsLocked) {
      // Soft step only: drop verified — never relax inet/reliability floors.
      this.log.warn(
        isDesktopPolicy
          ? '[vast] Desktop policy: no offers — soft step: drop verified=true only (keeping inet_down>1000, reliability≥0.95)'
          : `[vast] No offers — soft step: drop verified only (caller floors locked: minInetDown=${spec.minInetDownMbps ?? 'default'} maxPrice=${spec.maxPricePerHr ?? 'none'}; not relaxing to 0.9/500)`,
      );
      delete searchBody.verified;
      try {
        offers = await this._searchOffers(searchBody, headers);
        if (createGeoFilter && offers.length) {
          offers = offers.filter(o => {
            const geo = String(o.geolocation || '');
            return createGeoFilter!.some(cc => geoMatchesCountryCode(geo, cc));
          });
        }
        if (offers.length && isDesktopPolicy) {
          const desktopCap = spec.maxPricePerHr ?? VAST_DESKTOP_MAX_PER_HR;
          const rankInputs: VastOfferRankInput[] = offers.map((o) => ({
            id: Number(o.id),
            dph_total: Number(o.dph_total),
            reliability2: Number(o.reliability2),
            inet_down: Number(o.inet_down),
            num_gpus: Number(o.num_gpus ?? 1),
            gpu_name: String(o.gpu_name ?? ''),
            rentable: o.rentable !== false,
            rented: o.rented === true,
          }));
          const ranked = rankVastOffers(rankInputs, desktopCap);
          const order = new Map(ranked.map((r, i) => [r.id, i]));
          offers = offers
            .filter((o) => order.has(Number(o.id)))
            .sort((a, b) => (order.get(Number(a.id)) ?? 0) - (order.get(Number(b.id)) ?? 0));
        }
      } catch (retryErr) {
        this.log.error(`[vast] Soft-step search failed: ${this.errMsg(retryErr)}`);
      }
    }

      // P0b: Phase-2 fallback — SSH-only hosts (no direct ports). Critical for
      // RTX 5090 Blackwell hosts which often have direct_port_end: -1.
      // Only run if Phase-1 yielded NOTHING — we don't want to consume API
      // bandwidth on this when we already have offers.
      // strictFastBoot suppresses Phase-2 entirely: SSH-only hosts go through
      // ssh*.vast.ai proxies which are the source of the "zombie" status
      // (status=running but SSH refused). When the caller asks for fast-boot
      // we'd rather fail loudly here than ship a slow/zombie pod.
      // directPortRequired also suppresses Phase-2: caller explicitly requires
      // direct ports — adding SSH-only hosts defeats the purpose and causes
      // tunnel hangs (direct_port=-1 forever while container loads).
    if (offers.length === 0 && !spec.strictFastBoot && !spec.directPortRequired) {
      this.log.log('[vast] Phase-2: searching SSH-only hosts (no direct_port filter)');
      const sshOnlyBody = { ...searchBody };
      delete sshOnlyBody.direct_port_count;
      try {
        const sshOffers = await this._searchOffers(sshOnlyBody, headers);
        let filtered = sshOffers;
        if (createGeoFilter && filtered.length) {
          filtered = filtered.filter(o => {
            const geo = String(o.geolocation || '');
            return createGeoFilter!.some(cc => geoMatchesCountryCode(geo, cc));
          });
        }
        // Mark SSH-only offers and merge (dedupe by id)
        const seenIds = new Set(offers.map(o => String(o.id)));
        for (const o of filtered) {
          if (!seenIds.has(String(o.id))) {
            (o as Record<string, unknown>)._sshOnlyHint = true;
            offers.push(o);
          }
        }
        this.log.log(`[vast] Phase-2 added ${filtered.length} SSH-only offers (total: ${offers.length})`);
      } catch (sshErr) {
        this.log.warn(`[vast] SSH-only fallback search failed: ${this.errMsg(sshErr)}`);
      }
    }

    // ── Tiered offer ranking: prefer fast internet, expand budget progressively ──
    // Tier 1 (≤avg×1.2): try fastest internet first at near-average price.
    // Tier 2 (≤avg×1.3): expand to slightly more expensive if Tier 1 exhausted.
    // Tier 3 (≤avg×1.4): expand further.
    // Tier 4: everything else (expensive, last resort).
    // Within each tier, offers are sorted by inet_down desc (fastest boot).
    if (offers.length > 1) {
      const avgPrice = offers.reduce((s, o) => s + Number(o.dph_total || 0), 0) / offers.length;
      const tiers = [1.2, 1.3, 1.4, Infinity];
      const ranked: typeof offers = [];
      const seen = new Set<string>();

      for (const mult of tiers) {
        const ceiling = mult === Infinity ? Infinity : avgPrice * mult;
        const tier = offers.filter(o => !seen.has(String(o.id)) && Number(o.dph_total || 0) <= ceiling);
        tier.sort((a, b) => Number(b.inet_down || 0) - Number(a.inet_down || 0));
        for (const o of tier) { seen.add(String(o.id)); ranked.push(o); }
      }

      offers = ranked;
      const t1Count = offers.filter(o => Number(o.dph_total || 0) <= avgPrice * 1.2).length;
      this.log.log(`[vast] Tiered ranking: avg $${avgPrice.toFixed(3)}/hr, ${t1Count} in Tier1 (≤$${(avgPrice * 1.2).toFixed(3)}), ${offers.length} total — top: ${Number(offers[0]?.inet_down || 0).toFixed(0)} Mbps @ $${Number(offers[0]?.dph_total || 0).toFixed(3)}/hr`);
    }

    if (!offers.length) {
      const gpuFilter = spec.gpuTypes?.length ? normalizeGpuNames(spec.gpuTypes).join(', ') : 'any';
      this.log.error(`[vast] No offers found. GPU filter: [${gpuFilter}], disk: ${diskGb}GB, region: ${spec.region || 'any'}`);
      throw new Error(`No GPUs available on Vast.ai (0 offers matched). GPU filter: [${gpuFilter}], disk: ${diskGb}GB`);
    }

    // ── 2. Build env vars ──────────────────────────────────────────────────
    const envVars: Record<string, string> = {};
    const hfToken = credentials.hfToken ?? spec.hfToken ?? undefined;
    if (hfToken) {
      envVars.HF_TOKEN = hfToken;
    }
    // Auto-inject CONF_GROQ_API_KEY for ultralight/API-based images
    // (container expects CONF_ prefix via Pydantic Settings env_prefix)
    if (process.env.GROQ_API_KEY) envVars.CONF_GROQ_API_KEY = process.env.GROQ_API_KEY;
    // Merge explicit env overrides from tier config
    if (spec.env) Object.assign(envVars, spec.env);

    // ── 3. Hedged deploy: try N offers in parallel, keep first success ─────
    // P0a: Vast.ai is unreliable (host reclaims, slow pulls). Default raceCount=2
    // for Vast.ai (overridable via spec.raceCount). Each parallel attempt picks
    // a different offer; the first one to return a healthy endpoint wins, the
    // others are torn down to avoid runaway costs.
    const offerFailures: Array<{ offerId: string; gpu: string; reason: string }> = [];
    const failuresMutex = { push: (f: typeof offerFailures[number]) => offerFailures.push(f) };
    // Internal offer-hedge count. Default 2 (Vast hosts reclaim/zombie often), but
    // honour spec.raceCount when the caller pins it — raceCount:1 ⇒ exactly ONE
    // instance created (no duplicate billing). VAST_OFFER_RACE overrides the default.
    const envOfferRace = parseInt(process.env.VAST_OFFER_RACE ?? '', 10);
    const defaultOfferRace = Number.isFinite(envOfferRace) && envOfferRace > 0 ? envOfferRace : 2;
    const raceCount = Math.max(1, Math.min(5, spec.raceCount ?? defaultOfferRace));
    const offerPool = offers.slice(0, 10);
    const losers: Array<{ instanceId: string; contractId: string }> = [];

    this.log.log(`[vast] Hedged deploy: race=${raceCount}, pool=${offerPool.length} offers`);

    const winner = await this._raceOffers({
      offers: offerPool,
      raceCount,
      headers,
      apiKey,
      diskGb,
      imageName,
      envVars,
      spec,
      userId,
      failures: failuresMutex,
      losers,
    });

    // Tear down losing parallel attempts (fire-and-forget but logged)
    if (losers.length > 0) {
      this.log.log(`[vast] Tearing down ${losers.length} losing parallel attempts`);
      for (const loser of losers) {
        this.deleteInstance(loser.instanceId, { apiKey })
          .then(() => this.log.log(`[vast] Cleaned up loser ${loser.contractId}`))
          .catch((e) => this.log.warn(`[vast] Failed to clean up loser ${loser.contractId}: ${this.errMsg(e)}`));
      }
    }

    if (winner) {
      // P1a: Auto-snapshot in background (no await — non-blocking)
      if ((spec as any).autoSnapshot !== false && !(spec as any)._sshOnlyHint) {
        setTimeout(() => {
          this.takeSnapshot(winner.instanceId, { apiKey })
            .then((ref) => ref && this.log.log(`[vast] Auto-snapshot scheduled for ${winner.instanceId}: ${ref}`))
            .catch((e) => this.log.debug(`[vast] Auto-snapshot failed for ${winner.instanceId}: ${this.errMsg(e)}`));
        }, 60_000); // wait 1min so container is fully booted
      }
      return winner;
    }

    if (spec.signal?.aborted) throw deployCancelledError();

    const failSummary = offerFailures.map(f => `${f.gpu}(${f.offerId}): ${f.reason}`).join(' | ');
    this.log.error(`[vast] All ${offerPool.length} offers exhausted. Failures: ${failSummary}`);
    // Invalidate offer cache on total failure
    this._offerCache = null;

    this.emitError({
      operation: 'createInstance',
      message: `All offers exhausted on Vast.ai: ${failSummary}`,
      errorCode: 'NO_GPU_AVAILABLE',
      retryable: false,
    });
    throw new Error(`No GPUs available on Vast.ai (creation failed on ${offerFailures.length} offers). ${failSummary}`);
  }

  /**
   * P0a: Hedged deploy — try multiple offers in parallel, return first success.
   * Tracks "loser" instances so caller can clean them up.
   */
  private async _raceOffers(args: {
    offers: Array<Record<string, unknown>>;
    raceCount: number;
    headers: Record<string, string>;
    apiKey: string;
    diskGb: number;
    imageName: string;
    envVars: Record<string, string>;
    spec: InstanceSpec;
    userId?: string;
    failures: { push: (f: { offerId: string; gpu: string; reason: string }) => void };
    losers: Array<{ instanceId: string; contractId: string }>;
  }): Promise<GpuInstance | null> {
    const { offers, raceCount, headers, apiKey, diskGb, imageName, envVars, spec, userId, failures, losers } = args;

    let nextOfferIdx = 0;
    const inflight = new Map<number, Promise<{ result: GpuInstance | null; idx: number; offerId: string }>>();

    // Every instance an in-flight attempt has actually created, keyed by
    // contractId. Populated synchronously by `_tryOffer` the moment a contract
    // exists — BEFORE the long endpoint poll / SSH-tunnel wait. This lets us
    // delete a loser the instant we have a winner, instead of waiting minutes
    // for the loser's own retry chain to settle (the dual-billing cost leak).
    let winner: GpuInstance | null = null;
    let winnerInstanceId: string | null = null;
    const created = new Map<string, { instanceId: string; contractId: string }>();

    const deleteLoser = (rec: { instanceId: string; contractId: string }) => {
      losers.push(rec);
      this.deleteInstance(rec.instanceId, { apiKey })
        .then(() => this.log.log(`[vast] Eagerly deleted loser ${rec.contractId}`))
        .catch((e) => this.log.warn(`[vast] Failed to delete loser ${rec.contractId}: ${this.errMsg(e)}`));
    };

    const aborted = () => spec.signal?.aborted === true;
    const abortWake: Promise<null> | null = spec.signal
      ? new Promise((resolve) => {
          if (spec.signal!.aborted) resolve(null);
          else spec.signal!.addEventListener('abort', () => resolve(null), { once: true });
        })
      : null;

    const onCreated = (rec: { instanceId: string; contractId: string }) => {
      // Late create after a winner already exists (or after a cancel) — kill it on sight.
      if ((winner && rec.instanceId !== winnerInstanceId) || aborted()) {
        deleteLoser(rec);
        return;
      }
      created.set(rec.contractId, rec);
    };

    const launch = (): boolean => {
      if (aborted() || nextOfferIdx >= offers.length) return false;
      const idx = nextOfferIdx++;
      const offer = offers[idx];
      const offerId = String(offer.id);
      const p = this._tryOffer({
        offer, headers, apiKey, diskGb, imageName, envVars, spec, userId, failures, onCreated,
      }).then((result) => ({ result, idx, offerId }));
      inflight.set(idx, p);
      return true;
    };

    // Launch initial wave
    for (let i = 0; i < raceCount; i++) {
      if (!launch()) break;
    }

    while (inflight.size > 0 && !winner) {
      const settled = await (abortWake ? Promise.race([...inflight.values(), abortWake]) : Promise.race(inflight.values()));
      if (!settled || aborted()) {
        // Cancelled — destroy everything created so far; in-flight attempts
        // notice the signal and clean up whatever they create later.
        this.log.log(`[vast] Deploy cancelled — destroying ${created.size} instance(s) created by this race`);
        for (const rec of created.values()) deleteLoser(rec);
        created.clear();
        inflight.clear();
        break;
      }
      inflight.delete(settled.idx);
      if (settled.result) {
        // Winner! Eagerly tear down every loser instance that already exists.
        // Any loser still mid-create will be caught by `onCreated` above.
        winner = settled.result;
        winnerInstanceId = winner.instanceId;
        for (const [cid, rec] of created) {
          if (rec.instanceId !== winnerInstanceId) {
            created.delete(cid);
            deleteLoser(rec);
          }
        }
        inflight.clear();
        break;
      }
      // Failed attempt — launch next offer to keep raceCount in flight
      launch();
    }

    return winner;
  }

  /**
   * P0a: Try a single offer — extracted from createInstance for hedged deploy.
   * Returns the GpuInstance on success, or null on failure (failure logged via `failures.push`).
   */
  private async _tryOffer(args: {
    offer: Record<string, unknown>;
    headers: Record<string, string>;
    apiKey: string;
    diskGb: number;
    imageName: string;
    envVars: Record<string, string>;
    spec: InstanceSpec;
    userId?: string;
    failures: { push: (f: { offerId: string; gpu: string; reason: string }) => void };
    onCreated?: (rec: { instanceId: string; contractId: string }) => void;
  }): Promise<GpuInstance | null> {
    const { offer, headers, apiKey, diskGb, imageName, envVars, spec, userId, failures, onCreated } = args;
    const offerId = String(offer.id);
    const gpuName = (offer.gpu_name || 'unknown') as string;
    const pricePerHr = (offer.dph_total || 0) as number;
    const isSshOnlyHint = Boolean((offer as Record<string, unknown>)._sshOnlyHint);
    // Vast.ai instance label. Prefer the caller-supplied spec.label (the
    // user-given task name) so the instance is identifiable in the Vast
    // console + reconcilable to its owning task. Fallback keeps the old
    // gateway-generated `parle-autoscale-*` label for legacy / opt-out
    // callers (AIGW_LABEL_OPTIONAL=1).
    const baseName = spec.label && spec.label.length > 0 ? spec.label : `parle-autoscale-${Date.now()}`;
    // Append a short timestamp suffix so race deploys don't collide on
    // identical labels (Vast tolerates duplicates but it makes the
    // console unreadable).
    const instanceName = `${baseName}-${Date.now().toString(36).slice(-6)}`;

    // ssh_direct: Vast.ai provides SSH access + runs onstart script.
    // Works on ALL hosts (including those without direct ports like RTX 5090).
    const onstart = spec.onstart || '/app/start.sh';
    // Spot bid: on Vast, setting `price` on create makes the instance
    // interruptible (bid). Bid ~1.4× the offer's market floor to lower the
    // preemption rate while staying well under on-demand; cap at maxPricePerHr.
    let bidPrice = 0;
    if (spec.interruptible) {
      bidPrice = Math.max(pricePerHr * 1.4, pricePerHr + 0.01);
      if (spec.maxPricePerHr && spec.maxPricePerHr > 0) {
        bidPrice = Math.min(bidPrice, spec.maxPricePerHr);
      }
      bidPrice = Math.round(bidPrice * 1000) / 1000;
      this.log.log(`[vast] interruptible bid $${bidPrice}/hr on offer ${offerId} (floor $${pricePerHr}/hr, ${gpuName})`);
    }
    const createBody: Record<string, unknown> = {
      client_id: 'me',
      image: imageName,
      label: instanceName,
      disk: diskGb + 15,
      runtype: this._runtype,
      ...(spec.interruptible && bidPrice > 0 ? { price: bidPrice } : {}),
      onstart: `nohup bash -c ${JSON.stringify(onstart)} > /var/log/app.log 2>&1 &`,
      env: {
        TZ: 'UTC',
        ...envVars,
        // Identity port: host:70008 → container:8000. Vast.ai gives identity
        // mapping for ports >70000, so external port stays 70008 (not randomized).
        ...(spec.useIdentityPort
          ? { [`-p ${VAST_IDENTITY_PORT}:8000`]: '1' }
          : { '-p 8000:8000': '1' }),
        '-p 8001:8001/udp': '1',
      },
      ...(spec.templateHashId ? { template_hash_id: spec.templateHashId } : {}),
      ...(spec.cancelUnavail === true ? { cancel_unavail: true } : {}),
      ...((process.env.DOCKERHUB_USERNAME || process.env.DOCKER_HUB_USER) && (process.env.DOCKERHUB_TOKEN || process.env.DOCKER_HUB_TOKEN)
        ? { image_login: `-u ${process.env.DOCKERHUB_USERNAME || process.env.DOCKER_HUB_USER} -p ${process.env.DOCKERHUB_TOKEN || process.env.DOCKER_HUB_TOKEN} docker.io` }
        : {}),
    };

    // Set once the contract exists: any exception after that point must destroy
    // it, otherwise it keeps billing when no other attempt wins the race.
    let createdInstanceId: string | null = null;
    try {
      if (spec.signal?.aborted) throw deployCancelledError();
      const createRes = await this._vastFetch(`${VAST_API_BASE}/asks/${offerId}/`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(createBody),
      }, TIMEOUTS.create);

      if (!createRes.ok) {
        const errText = await createRes.text().catch(() => '');
        const unavailable = errText.includes('not available') || errText.includes('already rented');
        if (unavailable) {
          this.log.log(`[vast] Offer ${offerId} (${gpuName}) unavailable, trying next...`);
          failures.push({ offerId, gpu: gpuName, reason: 'unavailable/rented' });
          return null;
        }
        this.log.warn(`[vast] Create on offer ${offerId} failed: HTTP ${createRes.status} ${errText.substring(0, 300)}`);
        failures.push({ offerId, gpu: gpuName, reason: `HTTP ${createRes.status}: ${errText.substring(0, 100)}` });
        return null;
      }

      const createData = (await createRes.json()) as Record<string, unknown>;
      if (!createData.success) {
        this.log.warn(`[vast] Create on offer ${offerId} returned: ${JSON.stringify(createData).substring(0, 300)}`);
        failures.push({ offerId, gpu: gpuName, reason: `API returned success=false` });
        return null;
      }

      const contractId = String(createData.new_contract);
      const instanceId = `inst-${contractId}`;
      createdInstanceId = instanceId;
      // Register the live contract immediately so a parallel winner can tear
      // this down right away — before the (potentially multi-minute) endpoint
      // poll / SSH-tunnel wait below. Prevents dual-billing on SSH-only hosts.
      onCreated?.({ instanceId, contractId });

      // P3: Adaptive polling — base timeout on host's actual download speed.
      // Faster hosts get tighter timeouts; slower hosts get more headroom.
      // Note: Docker pull is slower than raw bandwidth due to layer extraction,
      // decompression, and filesystem writes. Use 3x safety factor (was 2x, too tight
      // for 20GB+ images like smplest-x which timed out at 14 min on 25GB).
      const inetDown = (offer.inet_down as number) || 500; // Mbps
      const pullEstimateS = (diskGb * 8 * 1024) / Math.max(inetDown, 100); // theoretical seconds
      const isLargeImage = diskGb > 15;
      const safetyMultiplier = isLargeImage ? 3 : 2; // large images need more headroom (decompression overhead)
      const CREATE_POLL_MAX_MS = Math.max(
        Math.min(Math.round(pullEstimateS * safetyMultiplier * 1000), 1_800_000), // cap 30 min (matches POLL_TOTAL_MAX_MS)
        isLargeImage ? 600_000 : 180_000, // floor: 10 min for large images, 3 min otherwise
      );
      let { endpoint, ip, sshHost, sshPort } = await this._pollForEndpoint(contractId, headers, CREATE_POLL_MAX_MS, inetDown, spec.onPollProgress, spec.signal);
      if (spec.signal?.aborted) throw deployCancelledError();

      // forceSshTunnel: skip the direct endpoint even if it looks reachable.
      // Use this on residential hosts where the direct port is unreliable but
      // SSH tunneling works fine. The probe stage above will have validated
      // the L7 reachability — but if even L7 succeeds and you still want a
      // tunnel (e.g. for stable WebSocket connections), this forces it.
      if (endpoint && spec.forceSshTunnel) {
        this.log.log(`[vast] Instance ${contractId} forceSshTunnel=true — clearing direct endpoint ${endpoint} to force SSH tunnel fallback`);
        endpoint = '';
      }

      // If instance vanished (no endpoint), verify it still exists before trying SSH.
      if (!endpoint) {
        const stillExists = await this._fetchInstanceDetail(contractId, headers);
        if (!stillExists || !stillExists.ip || ['exited', 'failed', 'destroyed', 'error', 'deleted'].includes(stillExists.status?.toLowerCase())) {
          const reason = 'instance vanished during startup (host reclaimed)';
          // Best-effort fetch of pre-destroy logs for diagnostics. Host reclaims
          // are the #1 Vast.ai failure mode and the logs are usually our only clue.
          try {
            const logs = await this.getInstanceLogs(instanceId, { apiKey }, 50);
            if (logs) this.log.warn(`[vast] Instance ${contractId} logs before destroy:\n${logs.substring(0, 500)}`);
            else this.log.warn(`[vast] Instance ${contractId} returned null logs (likely already destroyed)`);
          } catch (logErr) {
            this.log.warn(`[vast] Instance ${contractId}: log fetch failed (${this.errMsg(logErr)}) — proceeding to cleanup`);
          }
          this.log.warn(`[vast] Instance ${contractId} no longer exists (status=${stillExists?.status ?? 'gone'}) — ${reason}.`);
          const offerIp = String(offer.public_ipaddr ?? '');
          if (offerIp) {
            this._markHostUnstable(offerIp);
            this._recordHostFailure(offerIp);
          }
          await this._safeCleanupInstance(instanceId, apiKey, `host reclaim: ${reason}`);
          failures.push({ offerId, gpu: gpuName, reason });
          return null;
        }
        ip = stillExists.ip;
        sshHost = stillExists.sshHost;
        sshPort = stillExists.sshPort;
      }

      // SSH-only hosts: use SSH tunnel
      if (!endpoint && ip && sshHost && sshPort && !(await isSshClientAvailable())) {
        // Without an ssh binary the tunnel can never open — don't wait for key
        // propagation + 20 retries (~10 min of billing) to find that out.
        const reason = 'ssh client not installed on the gateway host — SSH-only instance unusable';
        this.log.warn(`[vast] Instance ${contractId}: ${reason}. Destroying...`);
        await this._safeCleanupInstance(instanceId, apiKey, reason);
        failures.push({ offerId, gpu: gpuName, reason });
        return null;
      }

      if (!endpoint && ip && sshHost && sshPort) {
        this.log.log(`[vast] Instance ${contractId} is SSH-only (no direct ports). Setting up SSH tunnel to ${sshHost}:${sshPort}...`);
        // P2-1 (docs/improvement-plan.md): capture the full SSH tunnel error
        // rather than the static string "SSH tunnel failed". Before this fix,
        // the lifecycle event `deploy_failed` carried an 80-char truncation
        // that hid the actual root cause (SSH key path, permission denied,
        // port blocked, etc.). Insights report 2026-04-12 showed 40%+ of
        // Vast failures with this opaque message.
        let tunnelFailReason = 'SSH tunnel failed';
        try {
          const { getOrCreateTunnel } = await import('./ssh-tunnel');
          const tunnel = getOrCreateTunnel(sshHost, sshPort, 8000);
          // Vast.ai propagates user SSH keys to the container at boot, but there's
          // a ~10-15s delay between status=running and the keys being available.
          // Sleeping here avoids the first-attempt "Permission denied" failure.
          // VMs take longer for SSH key propagation (~30s) than containers (~10s).
          const keyPropMs = this._runtype === 'vm' ? 30_000 : 10_000;
          this.log.log(`[vast] Instance ${contractId} waiting ${keyPropMs / 1000}s for SSH key propagation...`);
          await sleepAbortable(keyPropMs, spec.signal);
          const ok = await tunnel.open(15_000);
          if (ok) {
            this.log.log(`[vast] SSH tunnel opened: ${tunnel.endpoint} → ${sshHost}:8000`);
            // Successful boot → clear any lingering failure record for this host
            if (ip) this._recordHostSuccess(ip);
            return {
              instanceId,
              instanceName,
              endpoint: tunnel.endpoint,
              status: 'running',
              gpuType: gpuName,
              ipAddress: ip,
              sshHost,
              sshPort,
              providerMeta: {
                provider: 'vast',
                gpuVramGb: ((offer.gpu_ram as number) ?? 0) / 1024,
                inetDown: offer.inet_down as number | undefined,
                inetUp: offer.inet_up as number | undefined,
                dphTotal: pricePerHr,
                sshTunnel: true,
                sshOnlyHint: isSshOnlyHint,
              },
            };
          }
          // tunnel.open() returned false without throwing — the tunnel
          // module reports the reason via lastError on its state. Capture
          // whatever it exposes so the upstream failure summary is useful.
          const tunnelLastErr = (tunnel as { lastError?: string }).lastError;
          tunnelFailReason = tunnelLastErr
            ? `ssh_tunnel_open_false: ${tunnelLastErr}`.slice(0, 400)
            : `ssh_tunnel_open_returned_false (host=${sshHost}:${sshPort}, no exception thrown)`;
          this.log.warn(`[vast] SSH tunnel failed for ${contractId}: ${tunnelFailReason}. Destroying...`);
        } catch (tunnelErr) {
          const errMsg = this.errMsg(tunnelErr);
          // Preserve the full error up to 400 chars so the upstream summary
          // carries something diagnosable (key path, exit code, stderr).
          tunnelFailReason = `ssh_tunnel_exception: ${errMsg}`.slice(0, 400);
          this.log.warn(`[vast] SSH tunnel error for ${contractId}: ${tunnelFailReason}`);
        }
        // SSH tunnel failed → record host failure before cleanup
        if (ip) this._recordHostFailure(ip);
        await this._safeCleanupInstance(instanceId, apiKey, tunnelFailReason);
        failures.push({ offerId, gpu: gpuName, reason: tunnelFailReason });
        return null;
      }

      if (!endpoint) {
        this.log.warn(`[vast] Instance ${contractId} has no endpoint and no SSH — destroying...`);
        await this._safeCleanupInstance(instanceId, apiKey, 'no endpoint, no SSH');
        failures.push({ offerId, gpu: gpuName, reason: 'no endpoint, no SSH' });
        return null;
      }

      // Track host IP to avoid placing multiple instances on the same host
      if (ip) {
        this._recentlyUsedIps.add(ip);
        if (this._recentlyUsedIps.size > MAX_RECENTLY_USED_IPS) {
          const oldest = this._recentlyUsedIps.values().next().value;
          if (oldest !== undefined) this._recentlyUsedIps.delete(oldest);
        }
        // Successful boot → clear any lingering failure record for this host
        this._recordHostSuccess(ip);
      }

      await this.persistInstance(userId, spec.machineKey || 'vastInstance', {
        instanceId,
        instanceName,
        endpoint,
        ipAddress: ip,
        gpuType: gpuName,
        status: normalizeInstanceStatus('creating'),
        pricePerHr,
      });

      this.log.log(`[vast] Created ${instanceName} (${contractId}) with ${gpuName} @ $${pricePerHr}/h → ${endpoint || '(pending)'}${sshHost ? ` (ssh: ${sshHost}:${sshPort})` : ''}`);
      return {
        instanceId,
        instanceName,
        endpoint,
        status: normalizeInstanceStatus('creating'),
        gpuType: gpuName,
        ipAddress: ip,
        sshHost,
        sshPort,
        providerMeta: {
          provider: 'vast',
          hostIp: ip,
          reliability2: offer.reliability2 as number | undefined,
          inetDown: offer.inet_down as number | undefined,
          inetUp: offer.inet_up as number | undefined,
          dphTotal: pricePerHr,
          region: (offer.geolocation || '') as string,
          cpuName: (offer.cpu_name || '') as string,
          cpuCores: (offer.cpu_cores_effective || 0) as number,
          ramGb: ((offer.cpu_ram || 0) as number) / 1024,
          gpuVramGb: ((offer.gpu_ram || 0) as number) / 1024,
          numGpus: (offer.num_gpus || 1) as number,
          diskGb: (offer.disk_space || 0) as number,
          diskReadMbps: (offer.disk_bw_read || 0) as number,
          diskWriteMbps: (offer.disk_bw_write || 0) as number,
          pcieBw: (offer.pcie_bw || 0) as number,
          cudaVersion: (offer.cuda_max_good || 0) as number,
        },
      };
    } catch (e) {
      this.log.warn(`[vast] Create on offer ${offerId} error: ${this.errMsg(e)}`);
      if (createdInstanceId) await this._safeCleanupInstance(createdInstanceId, apiKey, `create aborted: ${this.errMsg(e)}`);
      failures.push({ offerId, gpu: gpuName, reason: this.errMsg(e) });
      return null;
    }
  }

  async startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    // Vast.ai on-demand instances auto-start on creation.
    // For stopped instances, restart via PUT with state: 'running'.
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);
    const { rawId } = stripPrefix(instanceId);

    const res = await this._vastFetch(`${VAST_API_BASE}/instances/${rawId}/`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ state: 'running' }),
    }, TIMEOUTS.write);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (body.includes('already') || body.includes('running')) {
        this.log.log(`[vast] startInstance(${instanceId}): already running`);
        return;
      }
      this.log.warn(`[vast] startInstance(${instanceId}) failed: HTTP ${res.status} ${body.substring(0, 300)}`);
      throw new Error(`Vast start failed for ${instanceId}: HTTP ${res.status} ${body.substring(0, 300)}`);
    }
  }

  /**
   * Stop (pause) an instance — preserves data, stops GPU billing.
   * The instance can be restarted later with startInstance().
   * For permanent deletion, use deleteInstance().
   */
  async stopInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);
    const { rawId, type } = stripPrefix(instanceId);

    if (type === 'endpoint') {
      // Serverless endpoints can only be deleted, not stopped
      const deleteRes = await this._vastFetch(`${VAST_API_BASE}/endptjobs/${rawId}/`, {
        method: 'DELETE',
        headers,
      }, TIMEOUTS.write);
      if (!deleteRes.ok) {
        const body = await deleteRes.text().catch(() => '');
        this.log.warn(`[vast] stopInstance(${instanceId}) endpoint delete failed: HTTP ${deleteRes.status} ${body.substring(0, 300)}`);
        this.emitError({
          operation: 'stopInstance', instanceId, message: `Endpoint delete failed: HTTP ${deleteRes.status}`,
          httpStatus: deleteRes.status, retryable: deleteRes.status >= 500,
        });
        throw new Error(`Vast endpoint delete failed for ${instanceId}: HTTP ${deleteRes.status} ${body.substring(0, 300)}`);
      }
      return;
    }

    // On-demand instance — STOP (pause, preserves data, allows restart)
    const res = await this._vastFetch(`${VAST_API_BASE}/instances/${rawId}/`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ state: 'stopped' }),
    }, TIMEOUTS.write);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // If stop fails (e.g. instance already stopped/destroyed), log but don't throw for idempotency
      if (body.includes('already') || body.includes('stopped') || body.includes('not found')) {
        this.log.log(`[vast] stopInstance(${instanceId}): already stopped or not found`);
        return;
      }
      this.log.warn(`[vast] stopInstance(${instanceId}) failed: HTTP ${res.status} ${body.substring(0, 300)}`);
      this.emitError({
        operation: 'stopInstance', instanceId, message: `Stop failed: HTTP ${res.status}`,
        httpStatus: res.status, retryable: res.status >= 500,
      });
      throw new Error(`Vast stop failed for ${instanceId}: HTTP ${res.status} ${body.substring(0, 300)}`);
    }
    this.log.log(`[vast] stopInstance(${instanceId}): paused (data preserved, restartable)`);
  }

  /**
   * Permanently destroy an instance and all its data.
   * This is irreversible — use stopInstance() to pause instead.
   */
  async deleteInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);
    const { rawId, type } = stripPrefix(instanceId);

    const endpoint = type === 'endpoint'
      ? `${VAST_API_BASE}/endptjobs/${rawId}/`
      : `${VAST_API_BASE}/instances/${rawId}/`;

    const res = await this._vastFetch(endpoint, {
      method: 'DELETE',
      headers,
    }, TIMEOUTS.write);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // 404 = already destroyed (idempotent)
      if (res.status === 404) {
        this.log.log(`[vast] deleteInstance(${instanceId}): already gone (404)`);
        return;
      }
      this.log.warn(`[vast] deleteInstance(${instanceId}) failed: HTTP ${res.status} ${body.substring(0, 300)}`);
      this.emitError({
        operation: 'deleteInstance', instanceId, message: `Delete failed: HTTP ${res.status}`,
        httpStatus: res.status, retryable: res.status >= 500,
      });
      throw new Error(`Vast delete failed for ${instanceId}: HTTP ${res.status} ${body.substring(0, 300)}`);
    }
    this.log.log(`[vast] deleteInstance(${instanceId}): permanently destroyed`);
  }

  /**
   * Fetch container logs from a Vast.ai instance for debugging.
   * Uses the Vast.ai /instances/{id}/logs/ endpoint.
   *
   * If the HTTP-based path yields nothing (common on hosts that have already
   * reclaimed the container), falls back to shelling out to `ssh` and tailing
   * likely log file locations on the host directly. This is our best chance
   * to capture diagnostics on the #1 failure mode (host reclaim / process exit).
   */
  async getInstanceLogs(instanceId: string, credentials: ProviderCredentials, lines: number = 200, filter?: string): Promise<string | null> {
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);
    const { rawId } = stripPrefix(instanceId);

    const applyFilter = (text: string | null): string | null => {
      if (!text || !filter) return text;
      const filtered = text.split('\n').filter(line => line.includes(filter)).join('\n');
      return filtered || null;
    };

    const httpLogs = await this._fetchContainerLogsViaHttp(rawId, headers, lines);
    if (httpLogs && httpLogs.trim()) return applyFilter(httpLogs) ?? httpLogs;

    // Container logs empty — try Vast daemon logs (captures pre-start failures, image
    // pull errors, OOM kills, host-side issues invisible to the container).
    // Vast.ai docs: pass daemon_logs=true to get host daemon logs instead of container logs.
    const daemonLogs = await this._fetchDaemonLogs(rawId, headers, lines);
    if (daemonLogs && daemonLogs.trim()) {
      this.log.log(`[vast] getInstanceLogs(${instanceId}): container logs empty, returning daemon logs`);
      return applyFilter(`[daemon] ${daemonLogs}`) ?? `[daemon] ${daemonLogs}`;
    }

    // Both log paths yielded nothing — try SSH tail as a last resort.
    try {
      const detail = await this._fetchInstanceDetail(rawId, headers);
      const sshHost = detail?.sshHost;
      const sshPort = detail?.sshPort;
      if (!sshHost || !sshPort) {
        this.log.debug(`[vast] getInstanceLogs(${instanceId}): no ssh host/port for fallback`);
        return applyFilter(httpLogs) ?? httpLogs;
      }
      const sshLogs = await this._fetchContainerLogsViaSsh(sshHost, sshPort);
      if (sshLogs && sshLogs.trim()) return applyFilter(sshLogs) ?? sshLogs;
      return applyFilter(httpLogs) ?? httpLogs;
    } catch (err) {
      this.log.debug(`[vast] getInstanceLogs(${instanceId}) ssh fallback failed: ${this.errMsg(err)}`);
      return applyFilter(httpLogs) ?? httpLogs;
    }
  }

  /** Fetch Vast host daemon logs (host-side events: image pull, OOM, container exit). */
  private async _fetchDaemonLogs(rawId: string, headers: Record<string, string>, lines: number): Promise<string | null> {
    try {
      const res = await this._vastFetch(
        `${VAST_API_BASE}/instances/request_logs/${rawId}/`,
        { method: 'PUT', headers, body: JSON.stringify({ tail: lines, daemon_logs: true }) },
        TIMEOUTS.read,
      );
      if (!res.ok) return null;
      const data = await res.json() as Record<string, unknown>;
      const resultUrl = data.result_url as string | undefined;
      if (!resultUrl) return null;
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const logRes = await fetch(resultUrl, { signal: AbortSignal.timeout(5000) });
          if (logRes.ok) {
            const text = await logRes.text();
            if (text.trim()) return text;
          }
        } catch (err) { this.log.debug({ error: err instanceof Error ? err.message : String(err) }, 'S3 log fetch not ready yet'); }
      }
      return null;
    } catch (err) { this.log.debug({ error: err instanceof Error ? err.message : String(err) }, '_fetchContainerLogsViaSsh failed'); return null; }
  }

  /**
   * Internal: original HTTP log-fetch path.
   * Uses Vast's async /instances/request_logs/{id}/ endpoint which uploads
   * to S3, then falls back to status_msg from instance detail.
   */
  private async _fetchContainerLogsViaHttp(
    rawId: string,
    headers: Record<string, string>,
    lines: number,
  ): Promise<string | null> {
    try {
      // Request logs via Vast.ai async log service
      const reqRes = await this._vastFetch(
        `${VAST_API_BASE}/instances/request_logs/${rawId}/`,
        { method: 'PUT', headers, body: JSON.stringify({ tail: lines }) },
        TIMEOUTS.read,
      );
      if (!reqRes.ok) {
        this.log.debug(`[vast] request_logs failed: HTTP ${reqRes.status}`);
        return null;
      }

      const reqData = await reqRes.json() as Record<string, unknown>;
      const resultUrl = reqData.result_url as string | undefined;

      // If we got a direct S3 URL, fetch the full logs
      if (resultUrl) {
        // Poll S3 URL (async upload may take 2-5s)
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const logRes = await fetch(resultUrl, { signal: AbortSignal.timeout(5000) });
            if (logRes.ok) {
              const text = await logRes.text();
              if (text.trim()) return text;
            }
          } catch (err) { this.log.debug({ error: err instanceof Error ? err.message : String(err), attempt }, 'S3 not ready yet, retry'); }
        }
      }

      // Fallback: read status_msg from instance detail
      await new Promise(r => setTimeout(r, 2000));
      const logsRes = await this._vastFetch(
        `${VAST_API_BASE}/instances/${rawId}/`,
        { method: 'GET', headers },
        TIMEOUTS.read,
      );
      if (!logsRes.ok) return null;
      const data = await logsRes.json() as Record<string, unknown>;
      return String(data.status_msg || '') || null;
    } catch (err) {
      this.log.debug(`[vast] _fetchContainerLogsViaHttp(${rawId}) failed: ${this.errMsg(err)}`);
      return null;
    }
  }

  /**
   * Shell out to `ssh` to tail likely log files on the host. Best-effort
   * diagnostic path for when the Vast HTTP logs API returns nothing.
   *
   * Captures:
   *   1. /var/log/app.log (if present)
   *   2. /tmp/*.log (fallback)
   *   3. Running python / sshd process list (so we can tell if the app crashed)
   *
   * Returns captured stdout (possibly containing stderr echoes) or null.
   * 15s hard wall-clock timeout.
   */
private _fetchContainerLogsViaSsh(sshHost: string, sshPort: number): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      if (!sshHost || !sshPort) {
        resolve(null);
        return;
      }

      const remoteCmd =
        'tail -200 /var/log/app.log 2>/dev/null || ' +
        'tail -100 /tmp/*.log 2>/dev/null || ' +
        'echo "no log files found"; ' +
        'echo ===; ' +
        'pgrep -af python | head -5; ' +
        'echo ===; ' +
        'pgrep -af sshd | head -3';

      let stdout = '';
      let stderr = '';
      let settled = false;
      let proc: ReturnType<typeof spawn> | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const settle = (val: string | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (proc) {
          try { proc.kill('SIGTERM'); } catch (err) {
            // Intentionally ignored — process already dead or not our child
            log.debug({ error: err instanceof Error ? err.message : String(err) }, 'SIGTERM kill failed (intentionally ignored)');
          }
          const p = proc;
          setTimeout(() => { try { p.kill('SIGKILL'); } catch (err) {
            // Intentionally ignored — process already dead or not our child
            log.debug({ error: err instanceof Error ? err.message : String(err) }, 'SIGKILL kill failed (intentionally ignored)');
          } }, 1_000);
        }
        resolve(val);
      };

      timer = setTimeout(() => {
        this.log.debug(`[vast] _fetchContainerLogsViaSsh(${sshHost}:${sshPort}) timed out after 15s`);
        settle(stdout.trim() ? stdout : null);
      }, 15_000);

      try {
        proc = spawn('ssh', [
          '-p', String(sshPort),
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'UserKnownHostsFile=/dev/null',
          '-o', 'ConnectTimeout=10',
          '-o', 'LogLevel=ERROR',
          `root@${sshHost}`,
          remoteCmd,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        proc.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (stdout.length > 64 * 1024) stdout = stdout.slice(-64 * 1024);
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
          if (stderr.length > 8 * 1024) stderr = stderr.slice(-8 * 1024);
        });

        proc.on('error', (err) => {
          this.log.debug(`[vast] _fetchContainerLogsViaSsh(${sshHost}:${sshPort}) spawn error: ${err.message}`);
          settle(stdout.trim() ? stdout : null);
        });

        proc.on('exit', (code) => {
          if (code !== 0 && code !== null) {
            this.log.debug(`[vast] _fetchContainerLogsViaSsh(${sshHost}:${sshPort}) exited ${code}: ${stderr.substring(0, 200)}`);
          }
          settle(stdout.trim() ? stdout : null);
        });
      } catch (err) {
        this.log.debug(`[vast] _fetchContainerLogsViaSsh spawn threw: ${this.errMsg(err)}`);
        settle(null);
      }
    });
  }

  /**
   * Reboot instance — stops and starts container without losing GPU priority.
   * Faster than stop+start because the GPU allocation is preserved.
   */
  async rebootInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);
    const { rawId, type } = stripPrefix(instanceId);

    if (type === 'endpoint') {
      this.log.warn(`[vast] rebootInstance(${instanceId}): endpoints don't support reboot, skipping`);
      return;
    }

    const res = await this._vastFetch(`${VAST_API_BASE}/instances/reboot/${rawId}/`, {
      method: 'PUT',
      headers,
    }, TIMEOUTS.write);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.log.warn(`[vast] rebootInstance(${instanceId}) failed: HTTP ${res.status} ${body.substring(0, 300)}`);
      throw new Error(`Vast reboot failed for ${instanceId}: HTTP ${res.status} ${body.substring(0, 300)}`);
    }
    this.log.log(`[vast] rebootInstance(${instanceId}): rebooting (GPU priority preserved)`);
  }

  /**
   * Change the bid price on an interruptible (spot) instance.
   *
   * Only applicable to instances created with type='bid'. On-demand instances
   * ignore this call (bid price doesn't apply to fixed-price contracts).
   * Price range: $0.001–$32/hr. Use to stay competitive when outbid, or to
   * reduce cost when demand drops.
   */
  async changeBid(instanceId: string, bidPricePerHr: number, credentials: ProviderCredentials): Promise<void> {
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);
    const { rawId, type } = stripPrefix(instanceId);

    if (type === 'endpoint') {
      this.log.warn(`[vast] changeBid(${instanceId}): endpoints don't support bid changes`);
      return;
    }
    if (bidPricePerHr < 0.001 || bidPricePerHr > 32) {
      throw new Error(`[vast] changeBid: price must be $0.001–$32/hr (got ${bidPricePerHr})`);
    }

    const res = await this._vastFetch(`${VAST_API_BASE}/instances/bid_price/${rawId}/`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ client_id: 'me', price: bidPricePerHr }),
    }, TIMEOUTS.write);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.log.warn(`[vast] changeBid(${instanceId}) failed: HTTP ${res.status} ${body.substring(0, 300)}`);
      throw new Error(`Vast changeBid failed for ${instanceId}: HTTP ${res.status} ${body.substring(0, 300)}`);
    }
    this.log.log(`[vast] changeBid(${instanceId}): bid updated to $${bidPricePerHr.toFixed(3)}/hr`);
  }

  /**
   * Recycle instance — destroys and recreates the container from a freshly pulled
   * image WITHOUT losing GPU priority on the host.
   *
   * Use this when a new image tag is available and you want to hot-reload the
   * container on the same host (e.g. fast-fix deploy):
   *   - Unlike stop+create: preserves GPU allocation, no waiting for a new host
   *   - Unlike reboot: re-pulls the Docker image so you get the latest layers
   *
   * Volume data IS preserved (Vast.ai docs: "pull new image, destroy and
   * recreate instance (keeps the volumes)"). Container disk is reset.
   */
  async recycleInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);
    const { rawId, type } = stripPrefix(instanceId);

    if (type === 'endpoint') {
      this.log.warn(`[vast] recycleInstance(${instanceId}): endpoints don't support recycle, skipping`);
      return;
    }

    const res = await this._vastFetch(`${VAST_API_BASE}/instances/recycle/${rawId}/`, {
      method: 'PUT',
      headers,
    }, TIMEOUTS.write);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.log.warn(`[vast] recycleInstance(${instanceId}) failed: HTTP ${res.status} ${body.substring(0, 300)}`);
      throw new Error(`Vast recycle failed for ${instanceId}: HTTP ${res.status} ${body.substring(0, 300)}`);
    }
    this.log.log(`[vast] recycleInstance(${instanceId}): recycling (re-pulling image, GPU priority preserved)`);
  }

  /**
   * Take a snapshot of a running container and push it to a registry.
   * Returns the snapshot/image reference, or null if the API doesn't return one.
   * Future instances using this snapshot skip Docker image download = near-instant boot.
   */
  async takeSnapshot(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);
    const { rawId, type } = stripPrefix(instanceId);

    if (type === 'endpoint') {
      this.log.warn(`[vast] takeSnapshot(${instanceId}): endpoints don't support snapshots`);
      return null;
    }

    const res = await this._vastFetch(`${VAST_API_BASE}/instances/command/${rawId}/`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ command: 'take_snapshot' }),
    }, TIMEOUTS.create);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.log.warn(`[vast] takeSnapshot(${instanceId}) failed: HTTP ${res.status} ${body.substring(0, 300)}`);
      throw new Error(`Vast snapshot failed for ${instanceId}: HTTP ${res.status} ${body.substring(0, 300)}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const resultUrl = (data.result_url as string) ?? null;
    this.log.log(`[vast] takeSnapshot(${instanceId}): snapshot scheduled${resultUrl ? ` → ${resultUrl}` : ''}`);
    return resultUrl;
  }

  async getInstanceStatus(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);
    const { rawId, type } = stripPrefix(instanceId);

    if (type === 'endpoint') {
      // Serverless endpoints
      try {
        const res = await this._vastFetch(`${VAST_API_BASE}/endptjobs/${rawId}/`, {
          headers,
        }, 8_000);
        if (!res.ok) {
          this.log.warn(`[vast] getInstanceStatus(${instanceId}): HTTP ${res.status}`);
          return null;
        }
        const data = (await res.json()) as Record<string, unknown>;
        const workers = (data.current_workers ?? data.cold_workers ?? 0) as number;
        return normalizeInstanceStatus(workers > 0 ? 'running' : 'idle');
      } catch (err) {
        this.log.warn(`[vast] getInstanceStatus(${instanceId}) failed: ${this.errMsg(err)}`);
        return null;
      }
    }

    // On-demand instance — try GET /instances/{id}/ first, fallback to list
    try {
      const detail = await this._fetchInstanceDetail(rawId, headers);
      return detail?.status != null ? normalizeInstanceStatus(detail.status) : null;
    } catch (err) {
      this.log.warn(`[vast] getInstanceStatus(${instanceId}) failed: ${this.errMsg(err)}`);
      return null;
    }
  }

  /** Returns the hourly cost for an instance ($/hr), or null if unavailable. */
  async getInstanceCost(instanceId: string, credentials: ProviderCredentials): Promise<number | null> {
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);
    const { rawId, type } = stripPrefix(instanceId);

    try {
      if (type === 'endpoint') {
        const res = await this._vastFetch(`${VAST_API_BASE}/endptjobs/${rawId}/`, { headers }, TIMEOUTS.read);
        if (!res.ok) return null;
        const data = (await res.json()) as Record<string, unknown>;
        return (data.dph_total as number) ?? null;
      }

      const res = await this._vastFetch(`${VAST_API_BASE}/instances/${rawId}/`, { headers }, TIMEOUTS.read);
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      const inst = (data.instances ?? data) as Record<string, unknown>;
      return (inst.dph_total as number) ?? null;
    } catch (e) {
      this.log.debug(`[vast] getInstanceCost(${instanceId}) failed: ${this.errMsg(e)}`);
      return null;
    }
  }

  /** Re-resolve endpoint for an existing instance (e.g. to get direct IP after boot). */
  async resolveInstanceEndpoint(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);
    const { rawId } = stripPrefix(instanceId);

    try {
      const detail = await this._fetchInstanceDetail(rawId, headers);
      if (detail && !detail.endpoint) {
        this.log.log(`[vast] resolveEndpoint ${instanceId}: status=${detail.status}, ip=${detail.ip || 'none'}`);
      }
      return detail?.endpoint || null;
    } catch (err) {
      this.log.warn(`[vast] resolveInstanceEndpoint(${instanceId}) failed: ${this.errMsg(err)}`);
      return null;
    }
  }

  /**
   * Lists ALL resources on the Vast.ai account:
   *   - On-demand GPU instances (/instances/)
   *   - Serverless endpoints (/endptjobs/)
   */
  async listInstances(credentials: ProviderCredentials): Promise<GpuInstance[]> {
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);
    const results: GpuInstance[] = [];

    // ── 1. On-demand instances ─────────────────────────────────────────────
    try {
      const res = await this._vastFetch(`${VAST_API_BASE}/instances/`, {
        headers,
      }, TIMEOUTS.read);
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const instances = (data.instances || data) as Array<Record<string, unknown>>;
        if (Array.isArray(instances)) {
          for (const inst of instances) {
            const id = String(inst.id ?? inst.machine_id ?? '');
            if (!id) continue;
            const parsed = this._parseInstance(inst);
            results.push({
              instanceId: `inst-${id}`,
              instanceName: inst.label as string | undefined,
              endpoint: parsed.endpoint,
              status: parsed.status,
              gpuType: inst.gpu_name as string | undefined,
              ipAddress: parsed.ip,
              sshHost: parsed.sshHost,
              sshPort: parsed.sshPort,
            });
          }
        }
      } else {
        const body = await res.text().catch(() => '');
        this.log.warn(`[vast] listInstances /instances/ failed: HTTP ${res.status} ${body.substring(0, 300)}`);
      }
    } catch (err) {
      this.log.warn(`[vast] listInstances /instances/ error: ${this.errMsg(err)}`);
    }

    // ── 2. Serverless endpoints ────────────────────────────────────────────
    try {
      const res = await this._vastFetch(`${VAST_API_BASE}/endptjobs/`, {
        headers,
      }, TIMEOUTS.read);
      if (res.ok) {
        const raw = (await res.json()) as unknown;
        const endpoints = Array.isArray(raw)
          ? raw
          : ((raw as Record<string, unknown>).results as unknown[] ??
             (raw as Record<string, unknown>).endpoints as unknown[] ??
             []);
        if (Array.isArray(endpoints)) {
          for (const ep of endpoints as Array<Record<string, unknown>>) {
            const id = String(ep.id ?? '');
            if (!id) continue;
            // Serverless endpoints that have workers are "running"
            const workers = (ep.current_workers ?? ep.cold_workers ?? 0) as number;
            const status = normalizeInstanceStatus(workers > 0 ? 'running' : 'idle');
            results.push({
              instanceId: `endpt-${id}`,
              instanceName: ep.endpoint_name as string | undefined,
              endpoint: (ep.endpoint_url as string) ?? '',
              status,
              gpuType: ep.gpu_name as string | undefined,
            });
          }
        }
      } else {
        const body = await res.text().catch(() => '');
        this.log.warn(`[vast] listInstances /endptjobs/ failed: HTTP ${res.status} ${body.substring(0, 300)}`);
      }
    } catch (err) {
      this.log.warn(`[vast] listInstances /endptjobs/ error: ${this.errMsg(err)}`);
    }

    return results;
  }

  /** List available GPU offers with real-time pricing from Vast.ai marketplace. */
  async listOffers(options: ListOffersOptions, credentials: ProviderCredentials): Promise<GpuOffer[]> {
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);
    const limit = options.limit ?? 100;
    // The geo filter below runs client-side, so a small server-side limit would
    // return the N cheapest offers worldwide and then drop most of them
    // (limit=10 near Lyon → 1 offer). Over-fetch when a region is set and
    // truncate after filtering.
    const fetchLimit = options.region ? Math.max(limit, VAST_GEO_FETCH_LIMIT) : limit;

    const searchBody: Record<string, unknown> = {
      limit: fetchLimit,
      type: 'on-demand',
      rentable: { eq: true },
      rented: { eq: false },
      // Whole physical GPU only — no fractional slices that share
      // VRAM with other tenants. See deploy() filter for details.
      gpu_frac: { eq: 1.0 },
      verified: { eq: true },
      reliability2: { gte: 0.9 },
      order: [['dph_total', 'asc']],
    };

    if (options.gpuTypes?.length) {
      searchBody.gpu_name = { in: normalizeGpuNames(options.gpuTypes) };
    }
    // Client-side geo filter — same logic as createMachine.
    // Vast.ai geolocation format: "France, FR" — server-side { eq: "FR" } never matches.
    // Always filter client-side after fetch.
    const EU_CC = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','NO','CH','GB','IS'];
    const COUNTRY_TO_CC: Record<string, string> = {
      FRANCE: 'FR', SPAIN: 'ES', GERMANY: 'DE', NETHERLANDS: 'NL', ITALY: 'IT',
      PORTUGAL: 'PT', POLAND: 'PL', SWEDEN: 'SE', NORWAY: 'NO', SWITZERLAND: 'CH',
      UNITEDKINGDOM: 'GB', UK: 'GB', UNITEDSTATES: 'US', USA: 'US',
    };
    let listGeoFilter: string[] | undefined;
    if (options.region) {
      const r = options.region.toUpperCase();
      if (r === 'EU' || r === 'EUROPE') {
        listGeoFilter = EU_CC;
      } else {
        listGeoFilter = r.split(',').map(s => {
          const trimmed = s.trim().replace(/\s+/g, '');
          return COUNTRY_TO_CC[trimmed] ?? trimmed;
        });
      }
    }

    try {
      let offers = await this._searchOffers(searchBody, headers, false);

      // Client-side geo filter
      if (listGeoFilter && offers.length) {
        const before = offers.length;
        offers = offers.filter(o => {
          const geo = String(o.geolocation || '');
          return listGeoFilter!.some(cc => geoMatchesCountryCode(geo, cc));
        });
        this.log.log(`[vast] Geo filter: ${before} → ${offers.length} offers matching [${listGeoFilter.join(',')}]`);
      }

      // Map to GpuOffer format — do NOT group, show all offers
      const result: GpuOffer[] = offers.map(offer => ({
        provider: 'vast',
        gpuType: (offer.gpu_name || 'unknown') as string,
        gpuName: (offer.gpu_name || 'unknown') as string,
        available: 1,
        pricePerHr: (offer.dph_total || 0) as number,
        region: (offer.geolocation || '') as string,
        vram: ((offer.gpu_ram || 0) as number) / 1024, // MB → GB
        offerId: String(offer.id ?? ''),
        geolocation: (offer.geolocation || undefined) as string | undefined,
        reliability: (offer.reliability2 || undefined) as number | undefined,
        inetDown: (offer.inet_down || undefined) as number | undefined,
        inetUp: (offer.inet_up || undefined) as number | undefined,
        hostId: offer.host_id != null ? String(offer.host_id) : undefined,
        cpuName: (offer.cpu_name || undefined) as string | undefined,
        cpuCores: (offer.cpu_cores_effective || undefined) as number | undefined,
        ramGb: offer.cpu_ram ? ((offer.cpu_ram as number) / 1024) : undefined,
        diskGb: (offer.disk_space || undefined) as number | undefined,
        numGpus: (offer.num_gpus || undefined) as number | undefined,
        totalFlops: (offer.total_flops || undefined) as number | undefined,
        // Host IP + first direct port let the latency scheduler TCP-probe the
        // machine before renting it (gpu-latency.ts skips offers without an IP).
        hostIp: offer.public_ipaddr && !isPrivateIp(String(offer.public_ipaddr)) ? String(offer.public_ipaddr) : undefined,
        hostDirectPort: Number(offer.direct_port_start) > 0 ? Number(offer.direct_port_start) : undefined,
      }));

      return result
        .sort((a, b) => a.pricePerHr - b.pricePerHr || (a.gpuType ?? '').localeCompare(b.gpuType ?? ''))
        .slice(0, limit);
    } catch (err) {
      this.log.warn(`[vast] listOffers failed: ${this.errMsg(err)}`);
      return [];
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Poll for endpoint assignment with exponential backoff.
   * P3: Adaptive polling — `inetDownMbps` (host download speed) tightens initial
   * intervals for fast hosts. Slow hosts get the legacy 5s base interval.
   */
  private async _pollForEndpoint(
    contractId: string,
    headers: Record<string, string>,
    maxWaitMs: number = POLL_TOTAL_MAX_MS,
    inetDownMbps?: number,
    onPollProgress?: (info: { elapsedS: number; status: string; instanceId: string; ip: string; sshHost?: string; sshPort?: number }) => void,
    signal?: AbortSignal,
  ): Promise<{ endpoint: string; ip: string; sshHost?: string; sshPort?: number }> {
    let endpoint = '';
    let ip = '';
    let sshHost: string | undefined;
    let sshPort: number | undefined;
    let elapsed = 0;
    let attempt = 0;

    // Terminal statuses that mean the instance will never recover
    const TERMINAL_STATUSES = new Set(['exited', 'failed', 'destroyed', 'error', 'deleted']);
    let seenOnce = false;       // true once the API returns the instance at least once
    let missingStreak = 0;      // consecutive polls where a previously-seen instance is gone
    const MAX_MISSING_STREAK = 5; // abort after 5 consecutive "not found" polls (~55s with backoff)
    let sshOnlyRunningCount = 0; // consecutive polls where instance is running with SSH but no endpoint

    // P3: Adaptive base interval — fast hosts (>5Gbps) get 2s base, slow get 5s
    const isFastHost = (inetDownMbps ?? 0) >= 5000;
    const baseMs = isFastHost ? 2_000 : POLL_BASE_MS;

    // Initial delay: Vast.ai API takes 3-5s to propagate. Fast hosts: 2s; slow: 5s.
    if (attempt === 0) {
      const initialDelay = isFastHost ? 2_000 : 5_000;
      await sleepAbortable(initialDelay, signal);
      elapsed += initialDelay;
    }

    while (elapsed < maxWaitMs) {
      const delay = Math.min(baseMs * Math.pow(POLL_GROWTH, attempt), POLL_MAX_MS);
      await sleepAbortable(delay, signal);
      elapsed += delay;
      attempt++;

      try {
        const detail = await this._fetchInstanceDetail(contractId, headers);
        if (detail) {
          seenOnce = true;
          missingStreak = 0;
          ip = detail.ip;
          endpoint = detail.endpoint;
          sshHost = detail.sshHost;
          sshPort = detail.sshPort;

          // Invoke progress callback so the caller can broadcast status updates
          if (onPollProgress) {
            onPollProgress({ elapsedS: Math.round(elapsed / 1000), status: detail.status ?? 'unknown', instanceId: `inst-${contractId}`, ip, sshHost, sshPort });
          }

          // Bail early on terminal statuses — instance won't recover
          if (TERMINAL_STATUSES.has(detail.status?.toLowerCase())) {
            this.log.warn(`[vast] Instance ${contractId} in terminal status '${detail.status}' after ${Math.round(elapsed / 1000)}s — aborting poll`);
            this.emitError({
              operation: '_pollForEndpoint', instanceId: `inst-${contractId}`,
              message: `Instance reached terminal status '${detail.status}' after ${Math.round(elapsed / 1000)}s`,
              errorCode: 'TERMINAL_STATUS', retryable: false,
              metadata: { status: detail.status, elapsedSecs: Math.round(elapsed / 1000) },
            });
            break;
          }

          if (endpoint) {
            // Verify endpoint is actually reachable (some hosts report ports but are firewalled)
            const reachable = await this._probeEndpoint(endpoint, 8_000);
            if (reachable) {
              this.log.log(`[vast] Instance ${contractId} got endpoint after ${Math.round(elapsed / 1000)}s: ${endpoint} (status=${detail.status})`);
              break;
            }
            // Endpoint not reachable — clear it so SSH tunnel kicks in
            this.log.warn(`[vast] Instance ${contractId} endpoint ${endpoint} not reachable — will use SSH tunnel`);
            endpoint = '';
          }

          // Early exit for SSH-only instances: if running with SSH but no endpoint
          // after 3 consecutive polls (~30s), the host likely has no direct ports.
          // Return early so createInstance can try the next offer faster.
          if (!endpoint && sshHost && sshPort && detail.status?.toLowerCase() === 'running') {
            sshOnlyRunningCount++;
            if (sshOnlyRunningCount >= 3) {
              this.log.log(`[vast] Instance ${contractId} SSH-only (no endpoint after ${Math.round(elapsed / 1000)}s, ssh=${sshHost}:${sshPort}) — returning early, will try next offer`);
              break;
            }
          } else {
            sshOnlyRunningCount = 0;
          }

          // Log progress on every ~30s boundary to aid debugging
          if (attempt % 3 === 0) {
            this.log.log(`[vast] Instance ${contractId} still loading (${Math.round(elapsed / 1000)}s, status=${detail.status ?? 'unknown'}, ip=${ip || 'none'}, ssh=${sshHost ? `${sshHost}:${sshPort}` : 'none'})`);
          }
        } else {
          if (seenOnce) {
            missingStreak++;
            this.log.warn(`[vast] Instance ${contractId} disappeared from API (${Math.round(elapsed / 1000)}s, streak=${missingStreak}/${MAX_MISSING_STREAK})`);
            if (missingStreak >= MAX_MISSING_STREAK) {
              this.log.warn(`[vast] Instance ${contractId} vanished after being seen — likely reclaimed by host. Aborting poll.`);
              this.emitError({
                operation: '_pollForEndpoint', instanceId: `inst-${contractId}`,
                message: `Instance vanished from API after ${Math.round(elapsed / 1000)}s (was previously visible)`,
                errorCode: 'INSTANCE_VANISHED', retryable: true,
                metadata: { ip, sshHost, sshPort, elapsedSecs: Math.round(elapsed / 1000) },
              });
              break;
            }
          } else {
            this.log.log(`[vast] Instance ${contractId} not found in API yet (${Math.round(elapsed / 1000)}s)`);
          }
        }
      } catch (err) {
        this.log.warn(`[vast] Polling instance ${contractId} attempt ${attempt} failed: ${this.errMsg(err)}`);
      }
    }

    if (!endpoint) {
      this.log.warn(`[vast] Instance ${contractId} has no endpoint after ${Math.round(elapsed / 1000)}s of polling (ip=${ip || 'none'}, ssh=${sshHost ? `${sshHost}:${sshPort}` : 'none'})`);
      this.emitError({
        operation: '_pollForEndpoint', instanceId: `inst-${contractId}`,
        message: `No endpoint after ${Math.round(elapsed / 1000)}s of polling`,
        errorCode: 'TIMEOUT', retryable: false,
        metadata: { ip, sshHost, sshPort, elapsedSecs: Math.round(elapsed / 1000) },
      });
    }

    return { endpoint, ip, sshHost, sshPort };
  }

  /** Quick TCP probe to verify an endpoint is reachable (not firewalled). */
  /**
   * Two-stage probe: first TCP connect, then HTTP GET. This catches the
   * common Vast.ai residential-host failure mode where the host's port
   * mapping accepts the TCP SYN even though the container app isn't
   * actually listening yet. A successful TCP connect alone isn't enough —
   * we need an actual HTTP response (or even an HTTP-shaped error like
   * 404, which still proves something is listening at L7).
   */
  private async _probeEndpoint(endpoint: string, timeoutMs: number = 8_000): Promise<boolean> {
    try {
      const url = new URL(endpoint);
      const { createConnection } = await import('net');
      // Stage 1: TCP connect
      // url.port is "" when the scheme uses the default port — pick 443 for
      // https and 80 for http rather than passing NaN to createConnection,
      // which would otherwise reject the probe before the TCP attempt fires.
      const portStr = url.port || (url.protocol === 'https:' ? '443' : '80');
      const port = parseInt(portStr, 10);
      const tcpOk = await new Promise<boolean>((resolve) => {
        const socket = createConnection(
          { host: url.hostname, port, timeout: timeoutMs },
          () => { socket.destroy(); resolve(true); }
        );
        socket.on('error', () => { socket.destroy(); resolve(false); });
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
      });
      if (!tcpOk) return false;
      // Stage 2: HTTP GET. We accept any HTTP response (even 404 or 500)
      // because that proves L7 is responding. AbortSignal cancels after
      // timeoutMs to avoid waiting forever on a slow app.
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeoutMs);
        const res = await fetch(`${endpoint.replace(/\/$/, '')}/health`, {
          method: 'GET',
          signal: ctl.signal,
        }).catch(() => null);
        clearTimeout(t);
        if (res) return true;  // any HTTP response (even errors) = L7 alive
        // Try root path as fallback (some apps don't have /health)
        const ctl2 = new AbortController();
        const t2 = setTimeout(() => ctl2.abort(), timeoutMs);
        const res2 = await fetch(endpoint, { method: 'GET', signal: ctl2.signal }).catch(() => null);
        clearTimeout(t2);
        return res2 !== null;
      } catch (err) { this.log.debug({ error: err instanceof Error ? err.message : String(err) }, 'L7 health check HTTP failed'); return false; }
    } catch (err) { this.log.debug({ error: err instanceof Error ? err.message : String(err) }, 'L7 health check failed'); return false; }
  }

  /**
   * Search Vast.ai offers with the given body, returning the offers array.
   * Deduplicates by machine_id so we spread across different physical hosts
   * (avoids funneling all instances onto the same broken host).
   *
    * P2b: Caches results with OFFER_CACHE_TTL_MS TTL. Cache key = stringified searchBody.
    * Cache is invalidated when createInstance fails on all offers.
    * @param deduplicateByIp - If true, keep only one offer per IP (for deploy). If false, keep all (for listing).
    */
  private async _searchOffers(
    searchBody: Record<string, unknown>,
    headers: Record<string, string>,
    deduplicateByIp = true,
  ): Promise<Array<Record<string, unknown>>> {
    // P2b: Check cache first
    const cacheKey = JSON.stringify(searchBody);
    const now = Date.now();
    if (this._offerCache && this._offerCache.key === cacheKey && (now - this._offerCache.ts) < OFFER_CACHE_TTL_MS) {
      this.log.log(`[vast] Offer cache hit (age: ${Math.round((now - this._offerCache.ts) / 1000)}s, ${this._offerCache.offers.length} offers)`);
      // Return a shallow copy so callers can mutate without poisoning the cache
      return this._offerCache.offers.map(o => ({ ...o }));
    }

    const searchRes = await this._vastFetch(`${VAST_API_BASE}/bundles/`, {
      method: 'POST',
      headers,
      body: JSON.stringify(searchBody),
    }, TIMEOUTS.write);

    if (!searchRes.ok) {
      const errText = await searchRes.text().catch(() => '');
      throw new Error(`[vast] Search offers failed: HTTP ${searchRes.status} ${errText.substring(0, 300)}`);
    }

    const searchData = (await searchRes.json()) as Record<string, unknown>;
    const allOffers = (searchData.offers || []) as Array<Record<string, unknown>>;

    // Deduplicate by public_ipaddr — keep cheapest offer per physical host.
    // A single host can have many machine_ids/host_ids (one per GPU), but
    // they all share the same public_ipaddr. Spreading across IPs avoids
    // funneling all instances onto the same broken host.
    // Also skip: recently used hosts (cross-call dedup), unstable hosts
    // (single-strike flag) and banned hosts (aggressive persistent blacklist).
    // When deduplicateByIp=false (listOffers), keep all offers — only filter bad hosts.
    const seenIps = deduplicateByIp ? new Set<string>(this._recentlyUsedIps) : new Set<string>();
    let unstableSkipped = 0;
    let bannedSkipped = 0;
    let recentlyUsedSkipped = 0;
    const deduplicated: Array<Record<string, unknown>> = [];
    for (const offer of allOffers) {
      const ip = String(offer.public_ipaddr ?? '');
      if (deduplicateByIp) {
        if (ip && seenIps.has(ip)) continue;
        if (ip && this._isHostBanned(ip)) { bannedSkipped++; continue; }
        if (ip && this._isHostUnstable(ip)) { unstableSkipped++; continue; }
        if (ip) { seenIps.add(ip); }
      } else {
        if (ip && this._isHostBanned(ip)) { bannedSkipped++; continue; }
        if (ip && this._isHostUnstable(ip)) { unstableSkipped++; continue; }
        if (ip && this._recentlyUsedIps.has(ip)) { recentlyUsedSkipped++; continue; }
      }
      deduplicated.push(offer);
    }

    const dedupType = deduplicateByIp ? 'unique hosts' : 'offers';
    this.log.log(`[vast] Search: ${allOffers.length} offers → ${deduplicated.length} ${dedupType} (${deduplicateByIp ? `${this._recentlyUsedIps.size} recently used, ` : ''}${unstableSkipped} unstable skipped, ${bannedSkipped} banned skipped)${!deduplicateByIp ? `, ${recentlyUsedSkipped} recently used (not excluded for listing)` : ''}`);

    // P2b: Populate cache (snapshot before mutations by callers)
    this._offerCache = {
      offers: deduplicated.map(o => ({ ...o })),
      ts: Date.now(),
      key: cacheKey,
    };

    return deduplicated;
  }

  /** Parse instance data into ip/endpoint/status/ssh info */
  private _parseInstance(inst: Record<string, unknown>): {
    ip: string; endpoint: string; status: string;
    sshHost?: string; sshPort?: number;
  } {
    const ip = (inst.public_ipaddr || inst.ssh_host || '') as string;
    const status = normalizeInstanceStatus(String(inst.actual_status ?? inst.cur_state ?? 'unknown'));
    const sshHost = (inst.ssh_host ?? inst.public_ipaddr) as string | undefined;
    const rawSshPort = inst.ssh_port as number | undefined;
    const parsedSshPort = rawSshPort && rawSshPort >= 1 && rawSshPort <= 65535 ? rawSshPort : undefined;
    // VM-mode Vast.ai instances expose SSH on port 22 directly; the API often omits ssh_port for VMs.
    const sshPort = parsedSshPort ?? (this._runtype === 'vm' && sshHost ? 22 : undefined);

    if (!ip) {
      this.log.log(`[vast] _parseInstance: no IP yet (status=${status}, cur_state=${inst.cur_state}, actual_status=${inst.actual_status})`);
      return { ip: '', endpoint: '', status, sshHost, sshPort };
    }

    // Log raw port data for debugging connectivity issues
    const ports = inst.ports as Record<string, unknown> | undefined;
    const directPort = inst.direct_port_start as number | undefined;
    this.log.log(`[vast] _parseInstance: ip=${ip} status=${status} direct_port=${directPort ?? 'none'} ports=${ports ? Object.keys(ports).join(',') : 'none'} ssh=${sshHost}:${sshPort}`);

    // Reject private/unreachable IPs (NAT-only hosts reporting RFC1918 as public)
    if (isPrivateIp(ip)) {
      this.log.warn(`[vast] Instance has private IP ${ip} as public_ipaddr — unreachable (will use SSH health check)`);
      this.emitError({
        operation: '_parseInstance', message: `Private IP ${ip} as public_ipaddr — unreachable`,
        errorCode: 'PRIVATE_IP', retryable: false, metadata: { ip },
      });
      // Still return SSH info so the boot poller can use SSH health checks
      return { ip, endpoint: '', status, sshHost, sshPort };
    }

    // Parse ports — Vast.ai format: { "8000/tcp": [{ "HostIp": "...", "HostPort": "..." }] }
    // Only trust direct port mapping if direct_port_start > 0 (SSH-only hosts report ports
    // in Docker NAT format but they're NOT accessible without SSH tunnel)
    const hasDirect = directPort && directPort > 0;
    if (ports && hasDirect) {
      // Check both '8000/tcp' and '8000' keys (API inconsistency)
      const p8000 = (ports['8000/tcp'] ?? ports['8000']) as Array<{ HostPort?: string; HostIp?: string }> | undefined;
      const entry = p8000?.find((e) => Number(e.HostPort) > 0);
      if (entry?.HostPort) {
        // Use HostIp if it's a public routable IP, otherwise fall back to instance ip
        const hostIp = entry.HostIp && !isPrivateIp(entry.HostIp) ? entry.HostIp : ip;
        return { ip, endpoint: `http://${hostIp}:${entry.HostPort}`, status, sshHost, sshPort };
      }
    }

    // Fallback: direct port mapping (skip invalid ports like -1 or 0 during loading)
    if (directPort && directPort > 0) {
      return { ip, endpoint: `http://${ip}:${directPort}`, status, sshHost, sshPort };
    }

    // Cloudflare tunnel fallback — Vast.ai injects a 'webpage' field with a trycloudflare.com
    // tunnel URL per port. Additive to direct ports; useful for SSH-only hosts or when direct
    // port is not yet available. Stable URL (doesn't change on restart like random port assignments).
    const webpage = (inst.webpage as string | undefined)?.trim();
    if (webpage && webpage.startsWith('https://') && webpage.includes('.trycloudflare.com')) {
      this.log.log(`[vast] _parseInstance: using Cloudflare tunnel endpoint: ${webpage}`);
      return { ip, endpoint: webpage, status, sshHost, sshPort };
    }

    // No valid port mapping yet — instance still loading or using SSH-only access
    return { ip, endpoint: '', status, sshHost, sshPort };
  }

  async checkBalance(credentials: ProviderCredentials): Promise<{ balance: number } | null> {
    const { apiKey } = credentials;
    if (!apiKey) return null;
    try {
      const res = await this._vastFetch(`${VAST_API_BASE}/users/current/`, {
        headers: this.jsonHeaders(apiKey),
      }, 8_000);
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      const balance = typeof data.credit === 'number' ? data.credit : null;
      if (balance === null) return null;
      return { balance };
    } catch (err) { this.log.debug({ error: err instanceof Error ? err.message : String(err) }, '_getBalance failed'); return null; }
  }

  /**
   * Preflight: check Vast.ai account balance before deploy.
   * Override of AbstractGpuProvider.preflight().
   *
   * Vast.ai requires positive credit to launch instances. Below ~$0.50 the
   * smallest pods (~$0.30/hr) can't even start a 1-hour job.
   */
  async preflight(credentials: ProviderCredentials): Promise<{
    canDeploy: boolean;
    blockReason: string | null;
    balance?: number;
    quota?: number;
  } | null> {
    const result = await this.checkBalance(credentials);
    if (!result) return null;  // API unreachable — proceed optimistically
    if (result.balance < 0.5) {
      return {
        canDeploy: false,
        blockReason: `Vast.ai balance too low: $${result.balance.toFixed(4)}. Add credit at console.vast.ai/billing.`,
        balance: result.balance,
      };
    }
    return { canDeploy: true, blockReason: null, balance: result.balance };
  }

  /** Log health warnings derived from instance fields (disk full, expiry, etc.). */
  private _warnInstanceHealth(inst: Record<string, unknown>, rawId: string): void {
    const diskUtil = inst.disk_util as number | undefined;
    if (diskUtil && diskUtil > 0.90) {
      this.log.warn(`[vast] Instance ${rawId} disk ${Math.round(diskUtil * 100)}% full — container may crash soon`);
    }
    const timeRemainingS = inst.time_remaining as number | undefined;
    if (timeRemainingS !== undefined && timeRemainingS > 0 && timeRemainingS < 30 * 60) {
      this.log.warn(`[vast] Instance ${rawId} has only ${Math.round(timeRemainingS / 60)}min remaining before expiry`);
    }
  }

  /**
   * Fetch detail for a single on-demand instance by raw Vast.ai ID.
   * Tries GET /instances/{id}/ first (efficient), falls back to v1 list with
   * server-side ID filter if the direct endpoint is unavailable.
   */
  private async _fetchInstanceDetail(
    rawId: string,
    headers: Record<string, string>,
  ): Promise<{ ip: string; endpoint: string; status: string; sshHost?: string; sshPort?: number } | null> {
    // ── 1. Direct single-instance GET (most efficient) ─────────────────────
    try {
      const res = await this._vastFetch(`${VAST_API_BASE}/instances/${rawId}/`, {
        headers,
      }, 8_000);
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        // v0 API may wrap in 'instances' key (singular object) or return flat
        const inst = (data.instances ?? data) as Record<string, unknown>;
        if (inst && typeof inst === 'object' && (inst.id || inst.public_ipaddr || inst.actual_status)) {
          this._warnInstanceHealth(inst, rawId);
          return this._parseInstance(inst);
        }
      }
      // 200 but empty/null body → fall through to list API
    } catch (e) {
      this.log.debug(`[vast] Direct instance lookup for ${rawId} failed, trying list API: ${this.errMsg(e)}`);
    }

    // ── 2. Fallback: v1 list API with server-side ID filter ────────────────
    // GET /v1/instances/?select_filters={"id":{"eq":N}}&select_cols=[...]
    try {
      const v1Base = VAST_API_BASE.replace('/api/v0', '/api/v1');
      const filterParam = encodeURIComponent(JSON.stringify({ id: { eq: Number(rawId) } }));
      const colsParam = encodeURIComponent(JSON.stringify([
        'id', 'actual_status', 'cur_state', 'public_ipaddr',
        'ssh_host', 'ssh_port', 'ports', 'direct_port_start', 'direct_port_count',
        'disk_util', 'gpu_util', 'gpu_temp', 'time_remaining', 'webpage',
      ]));
      const res = await this._vastFetch(
        `${v1Base}/instances/?select_filters=${filterParam}&select_cols=${colsParam}`,
        { headers },
        8_000,
      );
      if (!res.ok) {
        this.log.warn(`[vast] _fetchInstanceDetail(${rawId}): v1 list fallback HTTP ${res.status}`);
        return null;
      }

      const data = (await res.json()) as Record<string, unknown>;
      const instances = data.instances as Array<Record<string, unknown>> | null;
      if (!Array.isArray(instances)) return null;

      const inst = instances.find(i => String(i.id) === rawId);
      if (!inst) {
        this.log.log(`[vast] _fetchInstanceDetail(${rawId}): not found via v1 filter (${data.instances_found ?? 0} results)`);
        return null;
      }

      this._warnInstanceHealth(inst, rawId);
      return this._parseInstance(inst);
    } catch (err) {
      this.log.warn(`[vast] _fetchInstanceDetail(${rawId}) failed: ${this.errMsg(err)}`);
      return null;
    }
  }
}
