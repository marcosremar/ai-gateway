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
 *   - **GET /instances/{id}/** for single-instance lookup (fallback to list)
 *   - **template_hash_id** for pre-configured fast boot
 *   - **cancel_unavail** for fail-fast when GPU unavailable
 *   - **Exponential backoff** on endpoint polling
 *   - **takeSnapshot** to capture container state for near-instant future boots
 */

import type { GpuInstance, GpuOffer, InstanceSpec, ListOffersOptions, ProviderCredentials } from './types';
import { AbstractGpuProvider, TIMEOUTS } from './abstract-provider';
import type { AbstractGpuProviderOptions } from './abstract-provider';

const VAST_API_BASE = 'https://console.vast.ai/api/v0';

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
const UNSTABLE_HOST_COOLDOWN_MS = 30 * 60 * 1000; // 30 min cooldown after a reclaim
const MAX_UNSTABLE_HOSTS = 50;

// ── Rate limiting ────────────────────────────────────────────────────────────
// Vast.ai limits to ~4.5 req/s. We use a token bucket at 3 req/s to stay safe.
const RATE_LIMIT_INTERVAL_MS = 334; // ~3 req/s
const RATE_LIMIT_429_RETRY_MS = 2_000;
const RATE_LIMIT_429_MAX_RETRIES = 3;

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

/** Max IPs to track in _recentlyUsedIps before pruning (prevents memory leak). */
const MAX_RECENTLY_USED_IPS = 200;

/** Normalize short GPU type names (e.g. 'RTX3090') to Vast.ai search names (e.g. 'RTX 3090') */
function normalizeGpuNames(gpuTypes: string[]): string[] {
  return gpuTypes.map((t) => {
    // Replace underscores with spaces (e.g. 'RTX_3090' → 'RTX 3090')
    let name = t.replace(/_/g, ' ');
    // Strip NVIDIA prefix — Vast.ai uses short names like "RTX A6000", not "NVIDIA RTX A6000"
    name = name.replace(/^NVIDIA\s+(GeForce\s+)?/i, '');
    // Add space before digits if missing (e.g. 'RTX3090' → 'RTX 3090', 'RTXA5000' → 'RTX A5000')
    name = name.replace(/^(RTX)(\d)/, '$1 $2').replace(/^(RTX)(A)/, '$1 $2');
    return name;
  });
}

/** Strip inst- / endpt- prefix to get the raw Vast.ai numeric ID */
function stripPrefix(id: string): { rawId: string; type: 'instance' | 'endpoint' } {
  if (id.startsWith('inst-')) return { rawId: id.slice(5), type: 'instance' };
  if (id.startsWith('endpt-')) return { rawId: id.slice(6), type: 'endpoint' };
  return { rawId: id, type: 'instance' };
}

export interface VastClientOptions extends AbstractGpuProviderOptions {}

export class VastClient extends AbstractGpuProvider {
  readonly providerId = 'vast';
  readonly bootTimeSecs = 600; // 10 min base — engine uses 2× (20 min) for large images
  private _lastRequestMs = 0;
  /** IPs of hosts where we recently created instances (cross-call dedup). */
  private _recentlyUsedIps = new Set<string>();
  /** Hosts that reclaimed instances during loading — blacklisted with expiry timestamps. */
  private _unstableHosts = new Map<string, number>(); // ip → timestamp when blacklisted

  constructor(opts?: VastClientOptions) {
    super(opts);
  }

  /** Check if any requested GPU type requires Blackwell CUDA (12.8+). */
  private _needsBlackwellCuda(gpuTypes?: string[]): boolean {
    if (!gpuTypes?.length) return false;
    const blackwell = ['5090', '5080', '5070', 'B200', 'B100', 'GB200'];
    return gpuTypes.some(g => blackwell.some(b => g.includes(b)));
  }

  /** Mark a host as unstable (reclaimed an instance during loading). */
  private _markHostUnstable(ip: string): void {
    this._unstableHosts.set(ip, Date.now());
    this.log.warn(`[vast] Host ${ip} marked as unstable (instance reclaimed during loading). Cooldown: ${UNSTABLE_HOST_COOLDOWN_MS / 60_000}min`);
    // Prune old entries
    if (this._unstableHosts.size > MAX_UNSTABLE_HOSTS) {
      const oldest = [...this._unstableHosts.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this._unstableHosts.delete(oldest[0]);
    }
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
    // Fall back to any non-terminal running instance (may still be booting).
    const USABLE_STATUSES = new Set(['running', 'active', 'loading']);
    const withEndpoint = instances.find(
      (i) => USABLE_STATUSES.has(i.status?.toLowerCase() ?? '') && !!i.endpoint,
    );
    if (withEndpoint) return withEndpoint;
    const anyRunning = instances.find(
      (i) => USABLE_STATUSES.has(i.status?.toLowerCase() ?? ''),
    );
    return anyRunning ?? null;
  }

  async createInstance(
    spec: InstanceSpec,
    credentials: ProviderCredentials,
    userId?: string,
  ): Promise<GpuInstance> {
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);

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
    const searchBody: Record<string, unknown> = {
      limit: 50,
      type: 'on-demand',
      rentable: { eq: true },
      rented: { eq: false },
      num_gpus: { eq: spec.gpuCount ?? 1 },
      disk_space: { gte: diskGb },
      // No direct_port_count filter — Docker NAT via '-p 8000:8000' in env handles port mapping
      // CUDA filter: 12.8+ for Blackwell (RTX 5090/5080), 12.4+ for everything else
      cuda_vers: { gte: this._needsBlackwellCuda(spec.gpuTypes) ? 12.8 : 12.4 },
      // Host quality filters — fast internet critical for 10GB+ images to boot under 15min
      reliability2: { gte: 0.95 },      // >95% reliability score
      inet_down: { gte: 2000 },         // Minimum 2 Gb/s download (10GB image in ~40s)
      inet_up: { gte: 200 },            // Minimum 200 Mb/s upload
      order: [['dph_total', 'asc']],
    };

    // Filter by GPU type if specified
    if (spec.gpuTypes?.length) {
      searchBody.gpu_name = { in: normalizeGpuNames(spec.gpuTypes) };
    }

    // Filter by minimum RAM if specified
    if (spec.ramGb) {
      searchBody.cpu_ram = { gte: spec.ramGb * 1024 };  // Vast.ai uses MB
    }

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
    if ((spec as any).maxPricePerHr) {
      searchBody.dph_total = { lte: (spec as any).maxPricePerHr };
    }

    let offers = await this._searchOffers(searchBody, headers);

    // Client-side geo filter — Vast.ai geolocation is "Country, CC", so endsWith(', CC')
    if (createGeoFilter && offers.length) {
      const before = offers.length;
      offers = offers.filter(o => {
        const geo = String(o.geolocation || '');
        return createGeoFilter!.some(cc => geo.endsWith(`, ${cc}`) || geo.toUpperCase().startsWith(`${cc},`));
      });
      this.log.log(`[vast] Geo filter (create): ${before} → ${offers.length} offers matching [${createGeoFilter.join(',')}]`);
    }

    // Fallback: relax network requirements to find more hosts
    if (!offers.length) {
      this.log.warn('[vast] No offers with strict filters — relaxing to inet_down: 500, reliability: 0.9');
      searchBody.inet_down = { gte: 500 };
      searchBody.inet_up = { gte: 100 };
      searchBody.reliability2 = { gte: 0.9 };
      try {
        offers = await this._searchOffers(searchBody, headers);
        if (createGeoFilter && offers.length) {
          offers = offers.filter(o => {
            const geo = String(o.geolocation || '');
            return createGeoFilter!.some(cc => geo.endsWith(`, ${cc}`) || geo.toUpperCase().startsWith(`${cc},`));
          });
        }
      } catch (retryErr) {
        this.log.error(`[vast] Relaxed search also failed: ${this.errMsg(retryErr)}`);
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
    if (credentials.hfToken || spec.hfToken) {
      envVars.HF_TOKEN = (credentials.hfToken || spec.hfToken)!;
    }
    // Auto-inject CONF_GROQ_API_KEY for ultralight/API-based images
    // (container expects CONF_ prefix via Pydantic Settings env_prefix)
    if (process.env.GROQ_API_KEY) envVars.CONF_GROQ_API_KEY = process.env.GROQ_API_KEY;
    // Merge explicit env overrides from tier config
    if (spec.env) Object.assign(envVars, spec.env);

    // ── 3. Try cheapest offers (up to 10 unique hosts) ─────────────────────
    // Track per-offer failure reasons for diagnostics
    const offerFailures: Array<{ offerId: string; gpu: string; reason: string }> = [];

    for (const offer of offers.slice(0, 10)) {
      const offerId = offer.id;
      const gpuName = (offer.gpu_name || 'unknown') as string;
      const pricePerHr = (offer.dph_total || 0) as number;

      // ssh_direct: Vast.ai provides SSH access + runs onstart script.
      // Works on ALL hosts (including those without direct ports like RTX 5090).
      // The app is launched via onstart and port-forwarded via SSH tunnel.
      const onstart = spec.onstart || '/app/start.sh';
      const createBody: Record<string, unknown> = {
        client_id: 'me',
        image: imageName,
        // Do NOT include 'price' — omitting it = on-demand (fixed price, non-interruptible).
        disk: diskGb + 15,
        runtype: 'ssh_direct',
        onstart: `nohup bash -c ${JSON.stringify(onstart)} > /var/log/app.log 2>&1 &`,
        // Port mappings via env dict (works when host has direct ports)
        env: {
          TZ: 'UTC',
          ...envVars,
          '-p 8000:8000': '1',
          '-p 8001:8001/udp': '1',
        },
        // Template support: use pre-configured template for faster boot
        ...(spec.templateHashId ? { template_hash_id: spec.templateHashId } : {}),
        // Don't cancel_unavail — let it queue instead of silently destroying
        ...(spec.cancelUnavail === true ? { cancel_unavail: true } : {}),
        // Docker Hub auth to avoid unauthenticated pull rate limits (10 pulls/hr)
        ...((process.env.DOCKERHUB_USERNAME || process.env.DOCKER_HUB_USER) && (process.env.DOCKERHUB_TOKEN || process.env.DOCKER_HUB_TOKEN)
          ? { image_login: `-u ${process.env.DOCKERHUB_USERNAME || process.env.DOCKER_HUB_USER} -p ${process.env.DOCKERHUB_TOKEN || process.env.DOCKER_HUB_TOKEN} docker.io` }
          : {}),
      };

      try {
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
            offerFailures.push({ offerId: String(offerId), gpu: gpuName, reason: 'unavailable/rented' });
            continue;
          }
          this.log.warn(`[vast] Create on offer ${offerId} failed: HTTP ${createRes.status} ${errText.substring(0, 300)}`);
          offerFailures.push({ offerId: String(offerId), gpu: gpuName, reason: `HTTP ${createRes.status}: ${errText.substring(0, 100)}` });
          continue;
        }

        const createData = (await createRes.json()) as Record<string, unknown>;
        if (!createData.success) {
          this.log.warn(`[vast] Create on offer ${offerId} returned: ${JSON.stringify(createData).substring(0, 300)}`);
          offerFailures.push({ offerId: String(offerId), gpu: gpuName, reason: `API returned success=false` });
          continue;
        }

        const contractId = String(createData.new_contract);
        const instanceId = `inst-${contractId}`;
        const instanceName = `parle-autoscale-${Date.now()}`;

        // Poll for IP assignment — timeout based on image size + host download speed.
        // Formula: compressed_size / bandwidth * safety, clamped to [3min, 15min].
        const inetDown = (offer.inet_down as number) || 500; // Mbps
        const pullEstimateS = (diskGb * 8 * 1024) / Math.max(inetDown, 100); // theoretical seconds
        const CREATE_POLL_MAX_MS = Math.max(
          Math.min(Math.round(pullEstimateS * 2 * 1000), 900_000), // 2x safety, cap 15 min
          180_000, // floor 3 min
        );
        let { endpoint, ip, sshHost, sshPort } = await this._pollForEndpoint(contractId, headers, CREATE_POLL_MAX_MS);

        // If instance vanished (no endpoint), verify it still exists before trying SSH.
        // _pollForEndpoint may have cached ip/sshHost from an early poll before the host reclaimed.
        if (!endpoint) {
          const stillExists = await this._fetchInstanceDetail(contractId, headers);
          if (!stillExists || !stillExists.ip || ['exited', 'failed', 'destroyed', 'error', 'deleted'].includes(stillExists.status?.toLowerCase())) {
            const reason = 'instance vanished during startup (host reclaimed)';
            try {
              const logs = await this.getInstanceLogs(instanceId, { apiKey }, 50);
              if (logs) this.log.warn(`[vast] Instance ${contractId} logs before destroy:\n${logs.substring(0, 500)}`);
            } catch {}
            this.log.warn(`[vast] Instance ${contractId} no longer exists (status=${stillExists?.status ?? 'gone'}) — ${reason}. Destroying and trying next offer...`);
            const offerIp = String(offer.public_ipaddr ?? '');
            if (offerIp) this._markHostUnstable(offerIp);
            try { await this.deleteInstance(instanceId, { apiKey }); } catch (delErr) { this.log.debug(`[vast] Cleanup of ${contractId} failed: ${this.errMsg(delErr)}`); }
            offerFailures.push({ offerId: String(offerId), gpu: gpuName, reason });
            continue;
          }
          // Refresh ip/sshHost/sshPort from the live check
          ip = stillExists.ip;
          sshHost = stillExists.sshHost;
          sshPort = stillExists.sshPort;
        }

        // SSH-only hosts (RTX 5090 Blackwell often have no direct ports):
        // Use SSH tunnel to forward port 8000 to localhost
        if (!endpoint && ip && sshHost && sshPort) {
          this.log.log(`[vast] Instance ${contractId} is SSH-only (no direct ports). Setting up SSH tunnel to ${sshHost}:${sshPort}...`);
          try {
            const { getOrCreateTunnel } = await import('../../server/ssh-tunnel');
            const tunnel = getOrCreateTunnel(sshHost, sshPort, 8000);
            const ok = await tunnel.open(15_000);
            if (ok) {
              this.log.log(`[vast] SSH tunnel opened: ${tunnel.endpoint} → ${sshHost}:8000`);
              // Return the tunnel endpoint as the instance endpoint
              return {
                instanceId,
                instanceName: `parle-autoscale-${Date.now()}`,
                endpoint: tunnel.endpoint,
                status: 'running',
                gpuType: gpuName,
                ipAddress: ip,
                sshHost,
                sshPort,
                providerMeta: {
                  gpuType: gpuName,
                  gpuVramGb: ((offer.gpu_ram as number) ?? 0) / 1024,
                  inetDown: offer.inet_down as number | undefined,
                  inetUp: offer.inet_up as number | undefined,
                  dphTotal: pricePerHr,
                  sshTunnel: true,
                },
              };
            }
            this.log.warn(`[vast] SSH tunnel failed for ${contractId}. Destroying...`);
          } catch (tunnelErr) {
            this.log.warn(`[vast] SSH tunnel error for ${contractId}: ${this.errMsg(tunnelErr)}`);
          }
          try { await this.deleteInstance(instanceId, { apiKey }); } catch {}
          offerFailures.push({ offerId: String(offerId), gpu: gpuName, reason: 'SSH tunnel failed' });
          continue;
        }

        // No endpoint and no SSH — skip
        if (!endpoint) {
          this.log.warn(`[vast] Instance ${contractId} has no endpoint and no SSH — destroying...`);
          try { await this.deleteInstance(instanceId, { apiKey }); } catch {}
          offerFailures.push({ offerId: String(offerId), gpu: gpuName, reason: 'no endpoint, no SSH' });
          continue;
        }

        // Track host IP to avoid placing multiple instances on the same host
        if (ip) {
          this._recentlyUsedIps.add(ip);
          // Prune oldest entries to prevent memory leak on long-running processes
          if (this._recentlyUsedIps.size > MAX_RECENTLY_USED_IPS) {
            const oldest = this._recentlyUsedIps.values().next().value;
            if (oldest !== undefined) this._recentlyUsedIps.delete(oldest);
          }
        }

        // Persist to settings
        await this.persistInstance(userId, spec.machineKey || 'vastInstance', {
          instanceId,
          instanceName,
          endpoint,
          ipAddress: ip,
          gpuType: gpuName,
          status: 'creating',
          pricePerHr,
        });

        this.log.log(`[vast] Created ${instanceName} (${contractId}) with ${gpuName} @ $${pricePerHr}/h → ${endpoint || '(pending)'}${sshHost ? ` (ssh: ${sshHost}:${sshPort})` : ''}`);
        return {
          instanceId,
          instanceName,
          endpoint,
          status: 'creating',
          gpuType: gpuName,
          ipAddress: ip,
          sshHost,
          sshPort,
          providerMeta: {
            hostIp: ip,
            reliability2: offer.reliability2 as number | undefined,
            inetDown: offer.inet_down as number | undefined,
            inetUp: offer.inet_up as number | undefined,
            dphTotal: pricePerHr,
            region: (offer.geolocation || '') as string,
            // Machine specs
            cpuName: (offer.cpu_name || '') as string,
            cpuCores: (offer.cpu_cores_effective || 0) as number,
            ramGb: ((offer.cpu_ram || 0) as number) / 1024, // MB → GB
            gpuVramGb: ((offer.gpu_ram || 0) as number) / 1024, // MB → GB
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
        offerFailures.push({ offerId: String(offerId), gpu: gpuName, reason: this.errMsg(e) });
      }
    }

    const failSummary = offerFailures.map(f => `${f.gpu}(${f.offerId}): ${f.reason}`).join(' | ');
    this.log.error(`[vast] All ${Math.min(offers.length, 10)} offers exhausted. Failures: ${failSummary}`);

    this.emitError({
      operation: 'createInstance',
      message: `All offers exhausted on Vast.ai: ${failSummary}`,
      errorCode: 'NO_GPU_AVAILABLE',
      retryable: false,
    });
    throw new Error(`No GPUs available on Vast.ai (creation failed on ${offerFailures.length} offers). ${failSummary}`);
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
   */
  async getInstanceLogs(instanceId: string, credentials: ProviderCredentials, lines: number = 200): Promise<string | null> {
    const { apiKey } = credentials;
    const headers = this.jsonHeaders(apiKey);
    const { rawId } = stripPrefix(instanceId);

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
          } catch { /* S3 not ready yet, retry */ }
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
      this.log.debug(`[vast] getInstanceLogs(${instanceId}) failed: ${this.errMsg(err)}`);
      return null;
    }
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
        return workers > 0 ? 'running' : 'idle';
      } catch (err) {
        this.log.warn(`[vast] getInstanceStatus(${instanceId}) failed: ${this.errMsg(err)}`);
        return null;
      }
    }

    // On-demand instance — try GET /instances/{id}/ first, fallback to list
    try {
      const detail = await this._fetchInstanceDetail(rawId, headers);
      return detail?.status ?? null;
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
            const status = workers > 0 ? 'running' : 'idle';
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

    const searchBody: Record<string, unknown> = {
      limit,
      type: 'on-demand',
      rentable: { eq: true },
      rented: { eq: false },
      num_gpus: { eq: 1 },
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
      let offers = await this._searchOffers(searchBody, headers);

      // Client-side geo filter
      if (listGeoFilter && offers.length) {
        const before = offers.length;
        offers = offers.filter(o => {
          const geo = String(o.geolocation || '');
          return listGeoFilter!.some(cc => geo.endsWith(`, ${cc}`) || geo.toUpperCase().startsWith(`${cc},`));
        });
        this.log.log(`[vast] Geo filter: ${before} → ${offers.length} offers matching [${listGeoFilter.join(',')}]`);
      }

      // Group by gpu_name — aggregate availability, keep cheapest price
      const grouped = new Map<string, { count: number; cheapest: Record<string, unknown> }>();
      for (const offer of offers) {
        const name = (offer.gpu_name || 'unknown') as string;
        const existing = grouped.get(name);
        if (existing) {
          existing.count++;
        } else {
          grouped.set(name, { count: 1, cheapest: offer });
        }
      }

      const result: GpuOffer[] = [];
      for (const [gpuName, { count, cheapest }] of grouped) {
        result.push({
          provider: 'vast',
          gpuType: gpuName,
          gpuName,
          available: count,
          pricePerHr: (cheapest.dph_total || 0) as number,
          region: (cheapest.geolocation || '') as string,
          vram: ((cheapest.gpu_ram || 0) as number) / 1024, // MB → GB
          offerId: String(cheapest.id ?? ''),
          // Extended fields from Vast.ai bundle response
          geolocation: (cheapest.geolocation || undefined) as string | undefined,
          reliability: (cheapest.reliability2 || undefined) as number | undefined,
          inetDown: (cheapest.inet_down || undefined) as number | undefined,
          inetUp: (cheapest.inet_up || undefined) as number | undefined,
          hostId: cheapest.host_id != null ? String(cheapest.host_id) : undefined,
          cpuName: (cheapest.cpu_name || undefined) as string | undefined,
          cpuCores: (cheapest.cpu_cores_effective || undefined) as number | undefined,
          ramGb: cheapest.cpu_ram ? ((cheapest.cpu_ram as number) / 1024) : undefined, // MB → GB
          diskGb: (cheapest.disk_space || undefined) as number | undefined,
          numGpus: (cheapest.num_gpus || undefined) as number | undefined,
          totalFlops: (cheapest.total_flops || undefined) as number | undefined,
        });
      }

      return result.sort((a, b) => a.pricePerHr - b.pricePerHr || (a.gpuType ?? '').localeCompare(b.gpuType ?? ''));
    } catch (err) {
      this.log.warn(`[vast] listOffers failed: ${this.errMsg(err)}`);
      return [];
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Poll for endpoint assignment with exponential backoff. */
  private async _pollForEndpoint(
    contractId: string,
    headers: Record<string, string>,
    maxWaitMs: number = POLL_TOTAL_MAX_MS,
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

    // Initial delay: Vast.ai API takes 3-5s to propagate instance after creation
    if (attempt === 0) {
      const initialDelay = 5_000;
      await new Promise((r) => setTimeout(r, initialDelay));
      elapsed += initialDelay;
    }

    while (elapsed < maxWaitMs) {
      const delay = Math.min(POLL_BASE_MS * Math.pow(POLL_GROWTH, attempt), POLL_MAX_MS);
      await new Promise((r) => setTimeout(r, delay));
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
            this.log.log(`[vast] Instance ${contractId} got endpoint after ${Math.round(elapsed / 1000)}s: ${endpoint} (status=${detail.status})`);
            break;
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

  /**
   * Search Vast.ai offers with the given body, returning the offers array.
   * Deduplicates by machine_id so we spread across different physical hosts
   * (avoids funneling all instances onto the same broken host).
   */
  private async _searchOffers(
    searchBody: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<Array<Record<string, unknown>>> {
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
    // Also skip: recently used hosts (cross-call dedup) + unstable hosts (reclaimed instances).
    const seenIps = new Set<string>(this._recentlyUsedIps);
    let unstableSkipped = 0;
    const deduplicated: Array<Record<string, unknown>> = [];
    for (const offer of allOffers) {
      const ip = String(offer.public_ipaddr ?? '');
      if (ip && seenIps.has(ip)) continue;
      if (ip && this._isHostUnstable(ip)) { unstableSkipped++; continue; }
      if (ip) seenIps.add(ip);
      deduplicated.push(offer);
    }

    this.log.log(`[vast] Search: ${allOffers.length} offers → ${deduplicated.length} unique hosts (${this._recentlyUsedIps.size} recently used, ${unstableSkipped} unstable skipped)`);
    return deduplicated;
  }

  /** Parse instance data into ip/endpoint/status/ssh info */
  private _parseInstance(inst: Record<string, unknown>): {
    ip: string; endpoint: string; status: string;
    sshHost?: string; sshPort?: number;
  } {
    const ip = (inst.public_ipaddr || inst.ssh_host || '') as string;
    const status = String(inst.actual_status ?? inst.cur_state ?? 'unknown');
    const sshHost = (inst.ssh_host ?? inst.public_ipaddr) as string | undefined;
    const rawSshPort = inst.ssh_port as number | undefined;
    const sshPort = rawSshPort && rawSshPort >= 1 && rawSshPort <= 65535 ? rawSshPort : undefined;

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
    if (ports) {
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
    } catch {
      return null;
    }
  }

  /**
   * Fetch detail for a single on-demand instance by raw Vast.ai ID.
   * Tries GET /instances/{id}/ first (efficient), falls back to list API.
   */
  private async _fetchInstanceDetail(
    rawId: string,
    headers: Record<string, string>,
  ): Promise<{ ip: string; endpoint: string; status: string; sshHost?: string; sshPort?: number } | null> {
    // Try individual instance endpoint first (most efficient)
    try {
      const res = await this._vastFetch(`${VAST_API_BASE}/instances/${rawId}/`, {
        headers,
      }, 8_000);
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        // API returns { instances: {...} } for single instance
        const inst = (data.instances ?? data) as Record<string, unknown>;
        if (inst && typeof inst === 'object' && (inst.id || inst.public_ipaddr || inst.actual_status)) {
          return this._parseInstance(inst);
        }
      }
      // If response is 200 but data is null/empty, fall through to list API
    } catch (e) {
      this.log.debug(`[vast] Direct instance lookup for ${rawId} failed, trying list API: ${this.errMsg(e)}`);
    }

    // Fallback: list all instances and find the one we need
    try {
      const res = await this._vastFetch(`${VAST_API_BASE}/instances/`, {
        headers,
      }, 8_000);
      if (!res.ok) {
        this.log.warn(`[vast] _fetchInstanceDetail(${rawId}): list fallback HTTP ${res.status}`);
        return null;
      }

      const data = (await res.json()) as Record<string, unknown>;
      const instances = data.instances as Array<Record<string, unknown>> | null;
      if (!Array.isArray(instances)) return null;

      const inst = instances.find(i => String(i.id) === rawId);
      if (!inst) {
        // Debug: log all instance IDs to help diagnose mismatched contract/instance IDs
        const ids = instances.map(i => String(i.id)).join(', ');
        this.log.log(`[vast] _fetchInstanceDetail(${rawId}): not in list (${instances.length} instances: ${ids.substring(0, 200)})`);
        return null;
      }

      return this._parseInstance(inst);
    } catch (err) {
      this.log.warn(`[vast] _fetchInstanceDetail(${rawId}) failed: ${this.errMsg(err)}`);
      return null;
    }
  }
}
