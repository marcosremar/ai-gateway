/**
 * Scaleway Instance provider — cheap x86 CPU instances + GPU (L4) workloads.
 *
 * API docs: https://www.scaleway.com/en/developers/api/instances/
 * Block volumes: https://www.scaleway.com/en/developers/api/block/
 * Auth: X-Auth-Token header with the Scaleway secret key.
 * Pricing: DEV1-L (4 vCPU, 8GB) = €0.042/hr ≈ $0.0007/min
 *          L4-1-24G = €0.7875/hr (fr-par-2)
 *
 * Used for bot deployment (CPU-only Chromium pods) and GPU hosts (Qwen TTS / cloud-play).
 *
 * Region/zone is passed via spec.region (e.g. 'fr-par-1', 'nl-ams-1').
 * Instance IDs are stored as 'zone:serverId' so all management ops know which zone to target.
 */

import { AbstractGpuProvider, TIMEOUTS, FetchError } from '../gpu-providers/abstract-provider';
import type { AbstractGpuProviderOptions } from '../gpu-providers/abstract-provider';
import type { GpuInstance, InstanceSpec, ProviderCredentials } from '../gpu-providers/types';
import { normalizeInstanceStatus } from '../gateway/providers/gpu/instance-status';

// ── Constants ────────────────────────────────────────────────────────────────

const SCW_API = process.env.SCALEWAY_API_BASE || 'https://api.scaleway.com/instance/v1';
const SCW_IAM_API = process.env.SCALEWAY_IAM_API_BASE || 'https://api.scaleway.com/iam/v1alpha1';
const SCW_BLOCK_API = process.env.SCALEWAY_BLOCK_API_BASE || 'https://api.scaleway.com/block/v1alpha1';
const SCW_MARKETPLACE_API = process.env.SCALEWAY_MARKETPLACE_API_BASE || 'https://api.scaleway.com/marketplace/v2';

export class PartialListError<T> extends Error {
  constructor(readonly items: T[], readonly failedZones: string[], message: string) {
    super(message);
    this.name = 'PartialListError';
  }
}

/** All known Scaleway zones — queried in parallel for listInstances. */
export const KNOWN_ZONES = ['fr-par-1', 'fr-par-2', 'fr-par-3', 'nl-ams-1', 'nl-ams-2', 'nl-ams-3', 'pl-waw-1', 'pl-waw-2', 'pl-waw-3'];

/** Fallback zone used only when no region is specified. */
const FALLBACK_ZONE = 'fr-par-1';

/** Ubuntu 24.04 Noble Numbat x86_64 image UUID (fallback when image lookup fails). */
const UBUNTU_IMAGE_UUID = '2d6e9935-3dcd-49bd-a445-89ee55f3d781';

/**
 * Ubuntu Noble GPU OS (passthrough) in fr-par-2 — default for L4 workloads.
 * Override via SCALEWAY_GPU_IMAGE or spec.imageId.
 */
const DEFAULT_GPU_IMAGE_UUID = '3307b9e4-3cfa-49b5-896e-ce914e4ef4aa';

/** Default SBS root volume size (GB) for GPU commercial types. */
const DEFAULT_GPU_VOLUME_GB = 60;

/** Scaleway GPU commercial types (table price €/hr, fr-par-2 as of 2026-09). */
const GPU_TYPES: Array<{ type: string; pricePerHr: number }> = [
  { type: 'L4-1-24G', pricePerHr: 0.7875 },
  // Other GPU types for documentation / future use:
  // L40S-1-48G, H100-1-80G, etc. — add when needed with current table prices.
];

/** Scaleway commercial types sorted by price (cheapest first). */
const COMMERCIAL_TYPES: Array<{ type: string; vcpus: number; ramGb: number; pricePerHr: number }> = [
  { type: 'STARDUST1-S', vcpus: 1, ramGb: 1, pricePerHr: 0.00015 },
  { type: 'DEV1-S', vcpus: 2, ramGb: 2, pricePerHr: 0.0088 },
  { type: 'DEV1-M', vcpus: 3, ramGb: 4, pricePerHr: 0.0198 },
  { type: 'PLAY2-NANO', vcpus: 2, ramGb: 4, pricePerHr: 0.027 },
  { type: 'DEV1-L', vcpus: 4, ramGb: 8, pricePerHr: 0.042 },
  { type: 'PLAY2-MICRO', vcpus: 4, ramGb: 8, pricePerHr: 0.054 },
  { type: 'DEV1-XL', vcpus: 4, ramGb: 12, pricePerHr: 0.0638 },
];

/** Default type for bot pods (4 vCPU, 12GB — comfortable for Chromium + avatar).
 *  NOTE: availability varies by zone — not all types exist in all zones.
 *  The create flow tries largest-first with quota/availability fallback. */
const DEFAULT_BOT_TYPE = 'DEV1-XL';

// ── Scaleway API response types ──────────────────────────────────────────────

type ScwProduct = { hourly_price?: number; gpu?: number; gpu_info?: { gpu_name?: string; gpu_memory?: number } };

/** One GPU server type in one zone (see `ScalewayClient.listGpuOffers`). */
export type ScalewayGpuOffer = {
  zone: string;
  commercialType: string;
  hourlyPrice: number;
  gpuCount: number;
  gpuName: string | null;
  gpuMemoryGb: number | null;
  availability: string | null;
};

interface ScwServer {
  id: string;
  name: string;
  state: string; // 'running' | 'stopped' | 'stopped in place' | 'stopping' | 'starting' | 'locked'
  public_ip?: { address: string } | null;
  public_ips?: Array<{ id?: string; address: string; family?: string }>;
  commercial_type: string;
  tags?: string[];
  creation_date?: string;
  volumes?: Record<string, { id: string }>;
}

interface ScwCreateResponse {
  server: ScwServer;
}

interface ScwListResponse {
  servers: ScwServer[];
}

interface ScwGetResponse {
  server: ScwServer;
}

interface TypeCandidate {
  type: string;
  vcpus?: number;
  ramGb?: number;
  pricePerHr: number;
}

function isGpuCommercialType(type: string): boolean {
  return GPU_TYPES.some(t => t.type === type) || /L4/i.test(type);
}

function volumeIdsFromServer(server: ScwServer): string[] {
  return Object.values(server.volumes ?? {}).map(v => v.id).filter(Boolean);
}

/** IPv4 first: a routed-IP server lists its IPv6 too, and callers dial the v4 address. */
function ipv4Of(server: ScwServer): string | null {
  return server.public_ips?.find(ip => ip.family === 'inet')?.address
    ?? server.public_ip?.address
    ?? server.public_ips?.find(ip => !ip.address.includes(':'))?.address
    ?? null;
}

/** Firewall rule for `createSecurityGroup` (inbound accept from anywhere on one port, or `port`..`portTo`). */
export interface ScalewayFirewallRule {
  protocol: 'TCP' | 'UDP';
  port: number;
  portTo?: number;
}

export interface ScalewayGroupRule {
  id: string;
  protocol: string;
  direction: string;
  action: string;
  ipRange: string;
  port: number | null;
  portTo: number | null;
  editable: boolean;
}

export interface ScalewayIp {
  id: string;
  address: string;
}

/** Pre-release GET attempts (for the volume IDs) and the pause between them; a 404 ends the retries at once. */
const RELEASE_GET_ATTEMPTS = 3;
const releaseGetRetryMs = () => Number(process.env.SCALEWAY_RELEASE_GET_RETRY_MS ?? 1000);

/**
 * A server with SBS volumes cannot be `terminate`d, and DELETE answers 400 `resource_still_in_use` ("instance should be
 * powered off") until it is `stopped` (live QA 2026-10-07: every replica release logged it, the 5 s pause was never
 * enough for an L40S). Poll its state every SCALEWAY_POWEROFF_POLL_MS for at most SCALEWAY_POWEROFF_WAIT_MS before the
 * DELETE, which is itself retried while the API still says the server is in use.
 */
const poweroffWaitMs = () => Number(process.env.SCALEWAY_POWEROFF_WAIT_MS ?? 180_000);
const poweroffPollMs = () => Number(process.env.SCALEWAY_POWEROFF_POLL_MS ?? 5_000);
const DELETABLE_STATES = new Set(['stopped', 'stopped in place']);
const stillInUse = (err: unknown) => err instanceof FetchError && (err.status === 400 || err.status === 409 || err.status === 412)
  && /resource_still_in_use|powered off|in use/i.test(`${err.body} ${err.message}`);

/** Attempts × SCALEWAY_VOLUME_RETRY_MS: SBS volumes only detach some time after terminate (measured up to ~3 min). */
const VOLUME_DROP_ATTEMPTS = Number(process.env.SCALEWAY_VOLUME_ATTEMPTS ?? 90);

// ── Client ───────────────────────────────────────────────────────────────────

export interface ScalewayBlockVolume {
  id: string; zone: string; name: string; status: string; attached: boolean; createdAt: number; updatedAt: number; sizeGb: number;
}

export class ScalewayClient extends AbstractGpuProvider {
  readonly providerId = 'scaleway';
  readonly bootTimeSecs = 90; // ~60-90s for small instances

  /** In-memory volume IDs by encoded instance id (for destroy when meta not passed). */
  private volumeIdsByInstance = new Map<string, string[]>();

  /** Releases still powering off / deleting, by instance id: a second call (the list still shows it) joins, never repeats. */
  private readonly releasing = new Map<string, Promise<void>>();

  constructor(opts?: AbstractGpuProviderOptions) {
    super(opts);
  }

  // ── Auth headers (Scaleway uses X-Auth-Token, not Bearer) ──────────────

  private scwHeaders(secretKey: string): Record<string, string> {
    return {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Auth-Token': secretKey,
    };
  }

  private zoneUrl(zone: string): string {
    return `${SCW_API}/zones/${zone}`;
  }

  private blockZoneUrl(zone: string): string {
    return `${SCW_BLOCK_API}/zones/${zone}`;
  }

  /** Encode zone + server UUID into a composite instanceId. */
  private encodeId(zone: string, serverId: string): string {
    return `${zone}:${serverId}`;
  }

  /** Decode composite instanceId → { zone, serverId }. Falls back to FALLBACK_ZONE for plain UUIDs. */
  private decodeId(instanceId: string): { zone: string; serverId: string } {
    const idx = instanceId.lastIndexOf(':');
    if (idx > 0) {
      return { zone: instanceId.slice(0, idx), serverId: instanceId.slice(idx + 1) };
    }
    // Plain UUID from before this change — assume fallback zone
    return { zone: FALLBACK_ZONE, serverId: instanceId };
  }

  /** Resolve the default project ID from the API key metadata. Cached after first call. */
  private projectIdCache: string | null = null;
  private projectIdPromise: Promise<string> | null = null;
  private async resolveProjectId(credentials: ProviderCredentials): Promise<string> {
    // Return cached value if available
    if (this.projectIdCache) return this.projectIdCache;
    // Prevent concurrent resolution (race condition)
    if (this.projectIdPromise) return this.projectIdPromise;
    // Validate credentials
    const secretKey = credentials.apiKey || process.env.SCALEWAY_SECRET_KEY;
    if (!secretKey) {
      throw new Error('Scaleway secret key required (set apiKey or SCALEWAY_SECRET_KEY)');
    }
    // authId holds the access key (SCWxxxxx), apiKey holds the secret key
    const accessKey = credentials.authId || process.env.SCALEWAY_ACCESS_KEY || '';
    if (!accessKey) throw new Error('Scaleway access key required (set authId or SCALEWAY_ACCESS_KEY)');

    // Start new resolution
    this.projectIdPromise = this.resolveProjectIdImpl(secretKey, accessKey);
    try {
      const result = await this.projectIdPromise;
      this.projectIdCache = result;
      return result;
    } finally {
      this.projectIdPromise = null;
    }
  }

  /** The API key's default project (cached): where a resource goes when SCW_PROJECT_ID is not set. */
  defaultProjectId(credentials: ProviderCredentials): Promise<string> {
    return this.resolveProjectId(credentials);
  }

  private async resolveProjectIdImpl(secretKey: string, accessKey: string): Promise<string> {
    const res = await this.fetchJson<{ default_project_id?: string }>(
      `${SCW_IAM_API}/api-keys/${accessKey}`,
      { headers: this.scwHeaders(secretKey) },
      TIMEOUTS.read,
      'scaleway',
    );
    const projectId = res.default_project_id;
    if (!projectId || typeof projectId !== 'string') {
      throw new Error('Scaleway: no default_project_id in API response');
    }
    return projectId;
  }

  /** Resolve commercial type candidates from InstanceSpec. */
  private resolveTypeCandidates(spec: InstanceSpec): TypeCandidate[] {
    if (spec.commercialType) {
      const gpu = GPU_TYPES.find(t => t.type === spec.commercialType);
      if (gpu) return [gpu];
      const cpu = COMMERCIAL_TYPES.find(t => t.type === spec.commercialType);
      if (cpu) return [cpu];
      return [{ type: spec.commercialType, pricePerHr: 0 }];
    }

    const wantsL4 = (spec.gpuTypes ?? []).some(g => /L4/i.test(g));
    if (wantsL4) {
      const l4 = GPU_TYPES.find(t => t.type === 'L4-1-24G')!;
      return [l4];
    }

    // CPU bot ladder — largest RAM first with quota fallback
    const minRam = spec.ramGb ?? 12;
    const candidates = COMMERCIAL_TYPES
      .filter(t => t.ramGb >= Math.min(minRam, 8))
      .sort((a, b) => b.ramGb - a.ramGb);
    if (candidates.length === 0) {
      const defaultType = COMMERCIAL_TYPES.find(t => t.type === DEFAULT_BOT_TYPE);
      if (!defaultType) throw new Error('No Scaleway instance type available');
      return [defaultType];
    }
    return candidates;
  }

  // ── Instance lifecycle ─────────────────────────────────────────────────

  async createInstance(
    spec: InstanceSpec,
    credentials: ProviderCredentials,
    _userId?: string,
  ): Promise<GpuInstance> {
    const secretKey = credentials.apiKey || process.env.SCALEWAY_SECRET_KEY;
    if (!secretKey) {
      throw new Error('Scaleway secret key required (set apiKey or SCALEWAY_SECRET_KEY)');
    }
    if (!spec.region) {
      this.log.log(`[scaleway] WARNING: no region specified, falling back to ${FALLBACK_ZONE}. Pass spec.region to deploy in a specific zone.`);
    }
    const zone = spec.region || FALLBACK_ZONE;
    const headers = this.scwHeaders(secretKey);

    const candidates = this.resolveTypeCandidates(spec);
    const primary = candidates[0];
    const gpuPath = isGpuCommercialType(primary.type);
    const attachVolume = spec.volumeGb != null || gpuPath;
    const volumeGb = spec.volumeGb ?? (gpuPath ? DEFAULT_GPU_VOLUME_GB : undefined);

    const name = spec.label || `babelcast-bot-${Date.now()}`;
    const tags = [
      'babelcast',
      ...(gpuPath ? ['gpu'] : ['bot']),
      ...(spec.tags ?? []),
    ];

    // Image: explicit override → GPU default → Ubuntu lookup for CPU
    let imageId: string;
    if (spec.imageId != null && spec.imageId !== '') {
      imageId = String(spec.imageId);
    } else if (gpuPath) {
      imageId = process.env.SCALEWAY_GPU_IMAGE || DEFAULT_GPU_IMAGE_UUID;
    } else {
      // With an SBS root volume the image must be an SBS image compatible with the type (marketplace lookup);
      // the bot path without a volume keeps the legacy listing.
      imageId = await this.findUbuntuImage(zone, secretKey, attachVolume ? primary.type : undefined);
    }

    const projectId = spec.projectId || await this.resolveProjectId(credentials);

    // Try candidates in order; GPU / explicit commercialType has a single candidate
    let createRes: ScwCreateResponse | null = null;
    let usedType = primary;
    for (const candidate of candidates) {
      this.log.log(
        candidate.vcpus != null
          ? `[scaleway] Trying ${candidate.type} (${candidate.vcpus} vCPU, ${candidate.ramGb}GB) in ${zone}...`
          : `[scaleway] Trying ${candidate.type} in ${zone}...`,
      );
      const body: Record<string, unknown> = {
        name,
        commercial_type: candidate.type,
        image: imageId,
        project: projectId,
        tags,
        dynamic_ip_required: !spec.publicIpIds?.length,
      };
      if (attachVolume && volumeGb != null) {
        body.volumes = {
          0: { size: volumeGb * 1e9, volume_type: 'sbs_volume' },
        };
        body.routed_ip_enabled = true;
      }
      if (spec.publicIpIds?.length) {
        body.public_ips = spec.publicIpIds;
        body.routed_ip_enabled = true;
      }
      if (spec.securityGroupId) body.security_group = spec.securityGroupId;
      try {
        createRes = await this.fetchJson<ScwCreateResponse>(
          `${this.zoneUrl(zone)}/servers`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          },
          TIMEOUTS.create,
          'scaleway',
        );
        usedType = candidate;
        break;
      } catch (err) {
        const isQuota = err instanceof FetchError && err.body.includes('quotas_exceeded');
        if (isQuota && candidate !== candidates[candidates.length - 1]) {
          this.log.log(`[scaleway] ${candidate.type} quota exceeded, trying next...`);
          continue;
        }
        throw err;
      }
    }
    if (!createRes) throw new Error('No Scaleway instance type available');

    const server = createRes.server;
    const volumeIds = volumeIdsFromServer(server);
    const encodedId = this.encodeId(zone, server.id);
    if (volumeIds.length) this.volumeIdsByInstance.set(encodedId, volumeIds);
    this.log.log(`[scaleway] Server created: ${server.id} (${usedType.type})${volumeIds.length ? ` volumes=[${volumeIds.join(',')}]` : ''}`);

    try {
      // From here the server exists and is listed (state `stopped` until the power-on below): tell the caller first.
      spec.onServerCreated?.(encodedId);
      // A server Scaleway has just created may answer 404 for a moment (eventual consistency). NB the 404s of the
      // 06/10/2026 stress were NOT that: the deployment controller listed the still-`stopped` server mid-create, read it
      // as halted and deleted it (fixed with `onServerCreated`). Each retry names its step so the next 404 says which.
      const fresh = <T>(label: string, step: () => Promise<T>) => this.retryNotFound(step, `${server.id} ${label}`);
      // user_data: custom cloud-init takes precedence over docker bot script
      for (const [key, data] of Object.entries(spec.userDataFiles ?? {})) {
        await fresh(`user_data ${key}`, () => this.setUserDataKey(zone, server.id, secretKey, key, data));
      }
      const cloudInit = spec.cloudInitFor
        ? spec.cloudInitFor({ serverId: server.id, ip: ipv4Of(server) })
        : spec.cloudInit;
      if (cloudInit) {
        // '#!' script or '#cloud-config' YAML go as-is; a bare command list becomes a bash script.
        const script = cloudInit.startsWith('#')
          ? cloudInit
          : `#!/bin/bash\n${cloudInit}\n`;
        await fresh('user_data cloud-init', () => this.setUserData(zone, server.id, secretKey, script));
      } else if (spec.dockerImage) {
        await fresh('user_data cloud-init', () => this.setUserData(zone, server.id, secretKey, this.buildUserData(spec)));
      }

      await fresh('poweron', () => this.serverAction(zone, server.id, 'poweron', secretKey));
      this.log.log(`[scaleway] Server ${server.id} powering on...`);

      const ip = await this.waitForIp(zone, server.id, secretKey);
      const endpoint = ip ? `http://${ip}:8080` : '';

      const pricePerHr = usedType.pricePerHr || await this.getHourlyPrice(zone, usedType.type, credentials).catch(() => null) || 0;
      this.log.log(`[scaleway] Server ready: ${server.id} at ${ip || 'no-ip'} (${pricePerHr ? `€${pricePerHr}/hr` : 'price unknown'})`);

      return {
        instanceId: encodedId,
        instanceName: name,
        endpoint,
        ipAddress: ip || undefined,
        status: normalizeInstanceStatus('starting'),
        providerMeta: {
          provider: 'scaleway',
          zone,
          commercialType: usedType.type,
          pricePerHr,
          tags,
          ...(volumeIds.length ? { volumeIds } : {}),
          ...(spec.publicIpIds?.length ? { publicIpIds: spec.publicIpIds } : {}),
          ...(server.creation_date ? { createdAt: server.creation_date } : {}),
        },
      };
    } catch (err) {
      // Best-effort cleanup of server + SBS volumes (like babylon cloud-play)
      this.log.warn(`[scaleway] server ${server.id} exists but did not start; cleaning up: ${this.errMsg(err)}`);
      // A cleanup that fails must say so: the server and its volume keep billing until something else deletes them
      // (the deployment controller releases a tagged server it does not know on its next list).
      await this.deleteInstance(encodedId, credentials).catch((cleanupErr: unknown) => {
        this.log.warn(`[scaleway] cleanup of server ${server.id} failed, it may still bill: ${this.errMsg(cleanupErr)}`);
      });
      throw err;
    }
  }

  async discoverInstance(
    credentials: ProviderCredentials,
    _gpuTypes: string[],
  ): Promise<GpuInstance | null> {
    const instances = await this.listInstances(credentials);
    return instances.find(i => i.status === 'running') ?? null;
  }

  async startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const secretKey = credentials.apiKey || process.env.SCALEWAY_SECRET_KEY;
    if (!secretKey) throw new Error('Scaleway secret key required');
    const { zone, serverId } = this.decodeId(instanceId);
    try {
      await this.serverAction(zone, serverId, 'poweron', secretKey);
    } catch (err) {
      const msg = this.errMsg(err);
      // 404 = already started, ignore; re-throw others
      if (msg.includes('404') || msg.includes('not found')) {
        this.log.log(`[scaleway] Server ${instanceId} already running or not found`);
        return;
      }
      throw err;
    }
  }

  async stopInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const secretKey = credentials.apiKey || process.env.SCALEWAY_SECRET_KEY;
    if (!secretKey) throw new Error('Scaleway secret key required');
    const { zone, serverId } = this.decodeId(instanceId);
    try {
      await this.serverAction(zone, serverId, 'poweroff', secretKey);
    } catch (err) {
      const msg = this.errMsg(err);
      // 404 = already stopped, ignore; re-throw others
      if (msg.includes('404') || msg.includes('not found')) {
        this.log.log(`[scaleway] Server ${instanceId} already stopped or not found`);
        return;
      }
      throw err;
    }
  }

  async deleteInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    await this.releaseInstance(instanceId, credentials, { awaitVolumes: true });
  }

  /**
   * Terminate the server and delete its SBS volumes (Scaleway never deletes them with the server). With
   * `awaitVolumes: false` the call returns once the server is gone and the volumes keep retrying in the
   * background — for hosts that must not block a request for the minutes a volume takes to detach.
   */
  async releaseInstance(
    instanceId: string, credentials: ProviderCredentials, opts: { awaitVolumes: boolean; volumeIds?: string[] },
  ): Promise<void> {
    const secretKey = credentials.apiKey || process.env.SCALEWAY_SECRET_KEY;
    if (!secretKey) throw new Error('Scaleway secret key required');
    const pending = this.releasing.get(instanceId);
    if (pending) return opts.awaitVolumes ? pending : undefined;
    const { zone, serverId } = this.decodeId(instanceId);
    const headers = this.scwHeaders(secretKey);

    // Collect volume IDs before the server disappears (SBS volumes are NOT auto-deleted). Sources, unioned: what the
    // caller already saw (a list response), what this client created in this process, and a fresh GET. The GET is
    // retried on anything but 404: one transient 429/503 here used to terminate the server and leave its volume
    // billing whenever the machine was found by list (e.g. after a process restart) rather than created here.
    const volumeIds = new Set([...(opts.volumeIds ?? []), ...(this.volumeIdsByInstance.get(instanceId) ?? [])]);
    for (let attempt = 0; attempt < RELEASE_GET_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchJson<ScwGetResponse>(
          `${this.zoneUrl(zone)}/servers/${serverId}`,
          { headers },
          TIMEOUTS.read,
          'scaleway',
        );
        for (const id of volumeIdsFromServer(res.server)) volumeIds.add(id);
        break;
      } catch (err) {
        if (err instanceof FetchError && err.status === 404) break; // already gone
        if (attempt < RELEASE_GET_ATTEMPTS - 1) await new Promise(r => setTimeout(r, releaseGetRetryMs()));
      }
    }

    // Try to terminate first (force poweroff + delete); refused for servers with SBS volumes (the GPU OS images).
    let serverGone = false;
    try {
      await this.serverAction(zone, serverId, 'terminate', secretKey);
      this.log.log(`[scaleway] Terminated server ${serverId} in ${zone}`);
      serverGone = true;
    } catch {
      // terminate is refused for SBS-backed servers and in some states: power off, wait for `stopped`, then DELETE.
    }

    const dropVolumes = async () => {
      this.volumeIdsByInstance.delete(instanceId);
      if (volumeIds.size) await this.dropVolumes(zone, [...volumeIds], secretKey);
    };
    if (serverGone) {
      const dropping = dropVolumes();
      if (opts.awaitVolumes) await dropping;
      else void dropping.catch(err => this.log.warn(`[scaleway] volume cleanup failed: ${this.errMsg(err)}`));
      return;
    }
    // The power-off takes a minute or more: a host that must not block (the gateway's reconcile) gets the call back
    // once the power-off was asked, and the wait + DELETE + volumes finish in the background (a failure there is
    // logged; the server is listed again and released by the next tick). The reaper (`awaitVolumes`) waits for it all.
    const finishing = this.powerOffAndDelete(zone, serverId, secretKey).then(dropVolumes)
      .finally(() => this.releasing.delete(instanceId));
    this.releasing.set(instanceId, finishing);
    if (opts.awaitVolumes) return finishing;
    void finishing.catch(err => this.log.warn(`[scaleway] release of ${serverId} failed: ${this.errMsg(err)}`));
  }

  /** Power off, wait (bounded) for a deletable state, then DELETE — retried while the API answers `resource_still_in_use`. */
  private async powerOffAndDelete(zone: string, serverId: string, secretKey: string): Promise<void> {
    const headers = this.scwHeaders(secretKey);
    const url = `${this.zoneUrl(zone)}/servers/${serverId}`;
    const deadline = Date.now() + poweroffWaitMs();
    const powerOff = () => this.serverAction(zone, serverId, 'poweroff', secretKey).catch(() => { /* stopping or stopped already */ });
    await powerOff();
    for (let poll = 1; ; poll++) {
      let state: string | null = 'unknown';
      try {
        state = (await this.fetchJson<ScwGetResponse>(url, { headers }, TIMEOUTS.read, 'scaleway')).server?.state ?? 'unknown';
      } catch (err) {
        if (err instanceof FetchError && err.status === 404) return; // gone already
      }
      const timedOut = Date.now() >= deadline;
      if (DELETABLE_STATES.has(String(state)) || timedOut) {
        try {
          await this.fetchOk(url, { method: 'DELETE', headers }, TIMEOUTS.write);
          this.log.log(`[scaleway] Deleted server ${serverId} in ${zone}`);
          return;
        } catch (err) {
          if (err instanceof FetchError && err.status === 404) return;
          if (timedOut || !stillInUse(err)) throw err;
        }
      } else if (state === 'running' && poll % 6 === 0) await powerOff(); // the first power-off did not take
      await new Promise(r => setTimeout(r, poweroffPollMs()));
    }
  }

  /** One server by id, or `null` when it no longer exists (404). Other errors throw. */
  async getInstance(instanceId: string, credentials: ProviderCredentials): Promise<GpuInstance | null> {
    const secretKey = credentials.apiKey || process.env.SCALEWAY_SECRET_KEY;
    if (!secretKey) throw new Error('Scaleway secret key required');
    const { zone, serverId } = this.decodeId(instanceId);
    try {
      const res = await this.fetchJson<ScwGetResponse>(`${this.zoneUrl(zone)}/servers/${serverId}`,
        { headers: this.scwHeaders(secretKey) }, TIMEOUTS.read, 'scaleway');
      return this.toGpuInstance(res.server, zone);
    } catch (err) {
      if (err instanceof FetchError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Servers carrying `tag` in the given zones (default: all known zones), optionally scoped to a project.
   * Unlike `listInstances`, a zone that fails to answer throws: a caller deciding "nothing is running, create
   * one" must not read a failed zone as empty.
   */
  async listInstancesByTag(
    tag: string,
    credentials: ProviderCredentials,
    opts: { zones?: string[]; projectId?: string } = {},
  ): Promise<GpuInstance[]> {
    const secretKey = credentials.apiKey || process.env.SCALEWAY_SECRET_KEY;
    if (!secretKey) throw new Error('Scaleway secret key required');
    const project = opts.projectId ? `project=${encodeURIComponent(opts.projectId)}&` : '';
    const zones = opts.zones ?? KNOWN_ZONES;
    const lists = await Promise.allSettled(zones.map(async (zone) => {
      const res = await this.fetchJson<ScwListResponse>(
        `${this.zoneUrl(zone)}/servers?${project}tags=${encodeURIComponent(tag)}&per_page=50`,
        { headers: this.scwHeaders(secretKey) }, TIMEOUTS.read, 'scaleway');
      return res.servers.map(server => this.toGpuInstance(server, zone));
    }));
    const instances = lists.flatMap(l => (l.status === 'fulfilled' ? l.value : []));
    const failed = zones.flatMap((zone, i) => {
      const l = lists[i];
      return l.status === 'rejected' ? [`${zone}: ${l.reason instanceof Error ? l.reason.message : String(l.reason)}`] : [];
    });
    if (failed.length) throw new PartialListError(instances, failed.map(f => f.slice(0, f.indexOf(':'))), failed.join('; '));
    return instances;
  }

  /** SBS volumes of a zone (block/v1alpha1), optionally scoped to a project: id, name, status, attachments, times. */
  async listBlockVolumes(zone: string, credentials: ProviderCredentials, opts: { projectId?: string } = {}): Promise<ScalewayBlockVolume[]> {
    const secretKey = this.requireSecret(credentials);
    const project = opts.projectId ? `project_id=${encodeURIComponent(opts.projectId)}&` : '';
    const res = await this.fetchJson<{ volumes?: Array<Record<string, unknown>> }>(
      `${this.blockZoneUrl(zone)}/volumes?${project}page_size=100`, { headers: this.scwHeaders(secretKey) }, TIMEOUTS.read, 'scaleway');
    return (res.volumes ?? []).map(v => ({
      id: String(v.id), zone, name: String(v.name ?? ''), status: String(v.status ?? ''),
      attached: Array.isArray(v.references) && v.references.length > 0,
      createdAt: Date.parse(String(v.created_at ?? '')), updatedAt: Date.parse(String(v.updated_at ?? v.created_at ?? '')),
      sizeGb: Math.round(Number(v.size ?? 0) / 1e9),
    }));
  }

  /** Deletes one SBS volume (404 = already gone). */
  async deleteBlockVolume(zone: string, volumeId: string, credentials: ProviderCredentials): Promise<void> {
    const res = await this.fetchRaw(`${this.blockZoneUrl(zone)}/volumes/${volumeId}`,
      { method: 'DELETE', headers: { 'X-Auth-Token': this.requireSecret(credentials) } }, TIMEOUTS.write);
    if (!res.ok && res.status !== 404) throw new Error(`delete volume ${volumeId}: HTTP ${res.status}`);
  }

  /**
   * Catalog hourly price (EUR) of a commercial type in a zone, from `products/servers`; `null` when the type is
   * not sold there. Lets a caller cap spend on the live price instead of a table that goes stale.
   */
  async getHourlyPrice(zone: string, commercialType: string, credentials: ProviderCredentials): Promise<number | null> {
    const secretKey = this.requireSecret(credentials);
    for (let page = 1; page < 20; page++) {
      const res = await this.fetchJson<{ servers?: Record<string, { hourly_price?: number }> }>(
        `${this.zoneUrl(zone)}/products/servers?per_page=100&page=${page}`,
        { headers: this.scwHeaders(secretKey) }, TIMEOUTS.read, 'scaleway');
      const entries = Object.entries(res.servers ?? {});
      const hit = entries.find(([name]) => name === commercialType)?.[1];
      if (hit) return typeof hit.hourly_price === 'number' && Number.isFinite(hit.hourly_price) ? hit.hourly_price : null;
      if (entries.length < 100) return null;
    }
    return null;
  }

  /**
   * GPU server types offered in each zone, with table price, GPU and stock, for callers that pick an equivalent
   * when their usual type is missing, out of stock or over their cap. Sources: `GET /products/servers` (price, `gpu`,
   * `gpu_info.gpu_memory` in bytes) and `GET /products/servers/availability` (`available` / `scarce` / `shortage`;
   * null when that read fails). A zone whose catalog fails is skipped; all zones failing throws, so "no offers" is
   * never confused with "could not read".
   */
  async listGpuOffers(zones: string[], credentials: ProviderCredentials): Promise<ScalewayGpuOffer[]> {
    const secretKey = this.requireSecret(credentials);
    const headers = this.scwHeaders(secretKey);
    const out: ScalewayGpuOffer[] = [];
    let failed = 0;
    for (const zone of zones) {
      let products: Record<string, ScwProduct>;
      try { products = await this.productsOf(zone, secretKey); }
      catch (err) { failed++; this.log.log(`[scaleway] GPU catalog of ${zone} unavailable: ${this.errMsg(err)}`); continue; }
      let stock: Record<string, { availability?: string }> = {};
      try {
        stock = (await this.fetchJson<{ servers?: Record<string, { availability?: string }> }>(
          `${this.zoneUrl(zone)}/products/servers/availability?per_page=100`, { headers }, TIMEOUTS.read, 'scaleway')).servers ?? {};
      } catch { /* availability unknown: the caller decides whether to try */ }
      for (const [commercialType, product] of Object.entries(products)) {
        if (!(Number(product.gpu) > 0) || typeof product.hourly_price !== 'number' || !Number.isFinite(product.hourly_price)) continue;
        out.push({
          zone, commercialType, hourlyPrice: product.hourly_price, gpuCount: Number(product.gpu),
          gpuName: product.gpu_info?.gpu_name ?? null,
          gpuMemoryGb: typeof product.gpu_info?.gpu_memory === 'number' ? product.gpu_info.gpu_memory / 1024 ** 3 : null,
          availability: stock[commercialType]?.availability ?? null,
        });
      }
    }
    if (zones.length && failed === zones.length) throw new Error(`scaleway: GPU catalog unavailable in all ${zones.length} zone(s)`);
    return out;
  }

  /**
   * The same OS image in another zone: Scaleway image UUIDs are per zone, so a GPU image pinned in fr-par-2 does not
   * exist in pl-waw-2. Reads the marketplace label of `imageId` and returns the local image with that label in
   * `toZone` compatible with `commercialType` (SBS flavour first), or null.
   */
  async imageLike(imageId: string, toZone: string, commercialType: string, credentials: ProviderCredentials): Promise<string | null> {
    const headers = this.scwHeaders(this.requireSecret(credentials));
    const source = await this.fetchJson<{ local_image?: { label?: string }; label?: string }>(
      `${SCW_MARKETPLACE_API}/local-images/${imageId}`, { headers }, TIMEOUTS.read, 'scaleway');
    const label = source.local_image?.label ?? source.label;
    if (!label) return null;
    const res = await this.fetchJson<{ local_images: Array<{ id: string; compatible_commercial_types?: string[]; type?: string }> }>(
      `${SCW_MARKETPLACE_API}/local-images?image_label=${encodeURIComponent(label)}&zone=${toZone}&page_size=100`, { headers }, TIMEOUTS.read, 'scaleway');
    const compatible = res.local_images.filter(i => i.compatible_commercial_types?.includes(commercialType));
    return (compatible.find(i => (i.type ?? 'instance_sbs') === 'instance_sbs') ?? compatible[0])?.id ?? null;
  }

  private async productsOf(zone: string, secretKey: string): Promise<Record<string, ScwProduct>> {
    const all: Record<string, ScwProduct> = {};
    for (let page = 1; page < 20; page++) {
      const res = await this.fetchJson<{ servers?: Record<string, ScwProduct> }>(
        `${this.zoneUrl(zone)}/products/servers?per_page=100&page=${page}`,
        { headers: this.scwHeaders(secretKey) }, TIMEOUTS.read, 'scaleway');
      const entries = Object.entries(res.servers ?? {});
      Object.assign(all, Object.fromEntries(entries));
      if (entries.length < 100) break;
    }
    return all;
  }

  // ── Network: reserved routed IPs and security groups ───────────────────
  // A reserved IP survives poweroff and server deletion, so a DNS name pointing at it stays valid; the
  // security group is the instance-level firewall. Both are project resources the host keeps and reuses.

  async reserveRoutedIp(zone: string, credentials: ProviderCredentials, opts: { projectId: string; tags?: string[] }): Promise<ScalewayIp> {
    const secretKey = this.requireSecret(credentials);
    const res = await this.fetchJson<{ ip: ScalewayIp }>(`${this.zoneUrl(zone)}/ips`, {
      method: 'POST', headers: this.scwHeaders(secretKey),
      body: JSON.stringify({ project: opts.projectId, type: 'routed_ipv4', tags: opts.tags ?? [] }),
    }, TIMEOUTS.write, 'scaleway');
    return { id: res.ip.id, address: res.ip.address };
  }

  async listIps(zone: string, credentials: ProviderCredentials, opts: { projectId: string; tag?: string }): Promise<ScalewayIp[]> {
    const secretKey = this.requireSecret(credentials);
    const tag = opts.tag ? `&tags=${encodeURIComponent(opts.tag)}` : '';
    const res = await this.fetchJson<{ ips: ScalewayIp[] }>(`${this.zoneUrl(zone)}/ips?project=${encodeURIComponent(opts.projectId)}${tag}`,
      { headers: this.scwHeaders(secretKey) }, TIMEOUTS.read, 'scaleway');
    return res.ips.map(ip => ({ id: ip.id, address: ip.address }));
  }

  async deleteIp(zone: string, ipId: string, credentials: ProviderCredentials): Promise<void> {
    await this.fetchOk(`${this.zoneUrl(zone)}/ips/${ipId}`, { method: 'DELETE', headers: this.scwHeaders(this.requireSecret(credentials)) });
  }

  /** Stateful group: inbound drop by default, each rule an inbound accept from anywhere; outbound accept. */
  async createSecurityGroup(zone: string, credentials: ProviderCredentials, opts: {
    projectId: string; name: string; rules: ScalewayFirewallRule[]; tags?: string[]; description?: string;
  }): Promise<string> {
    const secretKey = this.requireSecret(credentials);
    const res = await this.fetchJson<{ security_group: { id: string } }>(`${this.zoneUrl(zone)}/security_groups`, {
      method: 'POST', headers: this.scwHeaders(secretKey),
      body: JSON.stringify({
        name: opts.name, project: opts.projectId, tags: opts.tags ?? [], stateful: true,
        inbound_default_policy: 'drop', outbound_default_policy: 'accept', description: opts.description ?? '',
      }),
    }, TIMEOUTS.write, 'scaleway');
    const id = res.security_group.id;
    for (const rule of opts.rules) await this.addSecurityGroupRule(zone, id, rule, credentials);
    return id;
  }

  async addSecurityGroupRule(zone: string, groupId: string, rule: ScalewayFirewallRule, credentials: ProviderCredentials): Promise<void> {
    await this.fetchJson(`${this.zoneUrl(zone)}/security_groups/${groupId}/rules`, {
      method: 'POST', headers: this.scwHeaders(this.requireSecret(credentials)),
      body: JSON.stringify({
        protocol: rule.protocol, direction: 'inbound', action: 'accept', ip_range: '0.0.0.0/0', dest_port_from: rule.port,
        ...(rule.portTo && rule.portTo > rule.port ? { dest_port_to: rule.portTo } : {}),
      }),
    }, TIMEOUTS.write, 'scaleway');
  }

  async listSecurityGroupRules(zone: string, groupId: string, credentials: ProviderCredentials): Promise<ScalewayGroupRule[]> {
    const res = await this.fetchJson<{ rules: Array<{
      id: string; protocol: string; direction: string; action: string; ip_range: string;
      dest_port_from?: number | null; dest_port_to?: number | null; editable?: boolean;
    }> }>(`${this.zoneUrl(zone)}/security_groups/${groupId}/rules?per_page=100`,
      { headers: this.scwHeaders(this.requireSecret(credentials)) }, TIMEOUTS.read, 'scaleway');
    return res.rules.map(r => ({
      id: r.id, protocol: r.protocol, direction: r.direction, action: r.action, ipRange: r.ip_range,
      port: r.dest_port_from ?? null, portTo: r.dest_port_to ?? null, editable: r.editable !== false,
    }));
  }

  async deleteSecurityGroupRule(zone: string, groupId: string, ruleId: string, credentials: ProviderCredentials): Promise<void> {
    await this.fetchOk(`${this.zoneUrl(zone)}/security_groups/${groupId}/rules/${ruleId}`,
      { method: 'DELETE', headers: this.scwHeaders(this.requireSecret(credentials)) });
  }

  async listSecurityGroups(zone: string, credentials: ProviderCredentials, opts: { projectId: string; name?: string }): Promise<Array<{ id: string; name: string }>> {
    const secretKey = this.requireSecret(credentials);
    const name = opts.name ? `&name=${encodeURIComponent(opts.name)}` : '';
    const res = await this.fetchJson<{ security_groups: Array<{ id: string; name: string }> }>(
      `${this.zoneUrl(zone)}/security_groups?project=${encodeURIComponent(opts.projectId)}${name}`,
      { headers: this.scwHeaders(secretKey) }, TIMEOUTS.read, 'scaleway');
    return res.security_groups.map(g => ({ id: g.id, name: g.name }));
  }

  async deleteSecurityGroup(zone: string, groupId: string, credentials: ProviderCredentials): Promise<void> {
    await this.fetchOk(`${this.zoneUrl(zone)}/security_groups/${groupId}`, { method: 'DELETE', headers: this.scwHeaders(this.requireSecret(credentials)) });
  }

  /** `fetchRaw` returns error responses as-is; writes here must fail loudly (a silently failed user_data PATCH
   *  boots a machine without its boot script, billing until a watchdog notices). */
  private async fetchOk(url: string, init: RequestInit, timeout = TIMEOUTS.write): Promise<Response> {
    const res = await this.fetchRaw(url, init, timeout);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new FetchError(`scaleway HTTP ${res.status}: ${body.substring(0, 300)}`, res.status, body);
    }
    return res;
  }

  private requireSecret(credentials: ProviderCredentials): string {
    const secretKey = credentials.apiKey || process.env.SCALEWAY_SECRET_KEY;
    if (!secretKey) throw new Error('Scaleway secret key required');
    return secretKey;
  }

  /**
   * Delete SBS volumes via block/v1alpha1. Retries while volumes are still
   * attached (brief window after terminate). Does not throw if volumes linger.
   */
  private async dropVolumes(zone: string, ids: string[], secretKey: string): Promise<void> {
    const remaining = [...ids];
    const retryMs = Number(process.env.SCALEWAY_VOLUME_RETRY_MS ?? 2_000);
    const maxAttempts = VOLUME_DROP_ATTEMPTS;
    for (let attempt = 0; attempt < maxAttempts && remaining.length; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, retryMs));
      for (const id of [...remaining]) {
        try {
          const res = await this.fetchRaw(
            `${this.blockZoneUrl(zone)}/volumes/${id}`,
            {
              method: 'DELETE',
              headers: { 'X-Auth-Token': secretKey },
            },
            TIMEOUTS.write,
          );
          if (res.ok || res.status === 404) {
            remaining.splice(remaining.indexOf(id), 1);
          }
        } catch {
          // Keep retrying
        }
      }
    }
    if (remaining.length) {
      this.log.warn(`[scaleway] volume(s) ${remaining.join(',')} not deleted (still attached?)`);
    } else if (ids.length) {
      this.log.log(`[scaleway] Deleted ${ids.length} SBS volume(s)`);
    }
  }

  async getInstanceStatus(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    const secretKey = credentials.apiKey || process.env.SCALEWAY_SECRET_KEY;
    if (!secretKey) return null;
    const { zone, serverId } = this.decodeId(instanceId);
    try {
      const res = await this.fetchJson<ScwGetResponse>(
        `${this.zoneUrl(zone)}/servers/${serverId}`,
        { headers: this.scwHeaders(secretKey) },
        TIMEOUTS.read,
        'scaleway',
      );
      return normalizeInstanceStatus(res.server.state);
    } catch {
      return null;
    }
  }

  async listInstances(credentials: ProviderCredentials): Promise<GpuInstance[]> {
    const secretKey = credentials.apiKey || process.env.SCALEWAY_SECRET_KEY;
    if (!secretKey) return [];
    const headers = this.scwHeaders(secretKey);
    // Default tag filter keeps bot pods scoped. Set SCALEWAY_LIST_TAG=* (or empty) to list all.
    const tagFilter = process.env.SCALEWAY_LIST_TAG;
    const tagQuery =
      tagFilter === '*' || tagFilter === ''
        ? ''
        : `tags=${encodeURIComponent(tagFilter ?? 'babelcast')}&`;

    // Query all known zones in parallel
    const results = await Promise.allSettled(
      KNOWN_ZONES.map(async (zone) => {
        const res = await this.fetchJson<ScwListResponse>(
          `${this.zoneUrl(zone)}/servers?${tagQuery}per_page=50`,
          { headers },
          TIMEOUTS.read,
          'scaleway',
        );
        return res.servers.map(s => this.toGpuInstance(s, zone));
      }),
    );

    return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  }

  async resolveInstanceEndpoint(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    const secretKey = credentials.apiKey || process.env.SCALEWAY_SECRET_KEY;
    if (!secretKey) return null;
    const { zone, serverId } = this.decodeId(instanceId);
    try {
      const res = await this.fetchJson<ScwGetResponse>(
        `${this.zoneUrl(zone)}/servers/${serverId}`,
        { headers: this.scwHeaders(secretKey) },
        TIMEOUTS.read,
        'scaleway',
      );
      const ip = ipv4Of(res.server);
      return ip ? `http://${ip}:8080` : null;
    } catch {
      return null;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private toGpuInstance(s: ScwServer, zone: string): GpuInstance {
    const ip = ipv4Of(s);
    const volumeIds = volumeIdsFromServer(s);
    const publicIpIds = (s.public_ips ?? []).map(p => p.id).filter((id): id is string => !!id);
    return {
      instanceId: this.encodeId(zone, s.id),
      instanceName: s.name,
      endpoint: ip ? `http://${ip}:8080` : '',
      ipAddress: ip || undefined,
      status: normalizeInstanceStatus(s.state),
      providerMeta: {
        provider: 'scaleway',
        zone,
        commercialType: s.commercial_type,
        tags: s.tags,
        state: s.state,
        ...(s.creation_date ? { createdAt: s.creation_date } : {}),
        ...(volumeIds.length ? { volumeIds } : {}),
        ...(publicIpIds.length ? { publicIpIds } : {}),
      },
    };
  }

  /** Waits between retries of a call on a just-created server that answered 404 (eventual consistency); then gives up. */
  freshServerRetryMs: number[] = [1_000, 2_000, 4_000];

  startPollMs = 5_000;

  private async retryNotFound<T>(step: () => Promise<T>, label: string): Promise<T> {
    for (const waitMs of this.freshServerRetryMs) {
      try {
        return await step();
      } catch (err) {
        if (!(err instanceof FetchError && err.status === 404)) throw err;
        this.log.log(`[scaleway] new server not visible yet (404 on ${label}), retrying in ${waitMs} ms`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    return step();
  }

  private async serverAction(zone: string, serverId: string, action: string, secretKey: string): Promise<void> {
    await this.fetchJson(
      `${this.zoneUrl(zone)}/servers/${serverId}/action`,
      {
        method: 'POST',
        headers: this.scwHeaders(secretKey),
        body: JSON.stringify({ action }),
      },
      TIMEOUTS.write,
      'scaleway',
    );
  }

  private async waitForIp(zone: string, serverId: string, secretKey: string, timeoutMs = 120_000): Promise<string | null> {
    const start = Date.now();
    let stopped = 0;
    while (Date.now() - start < timeoutMs) {
      let state: string | undefined;
      try {
        const res = await this.fetchJson<ScwGetResponse>(
          `${this.zoneUrl(zone)}/servers/${serverId}`,
          { headers: this.scwHeaders(secretKey) },
          TIMEOUTS.read,
        );
        state = res.server.state;
        const ip = ipv4Of(res.server);
        if (ip && state !== 'stopped') return ip;
      } catch {
        // Server may not be ready yet
      }
      stopped = state === 'stopped' ? stopped + 1 : 0;
      if (stopped === 2) {
        this.log.warn(`[scaleway] Server ${serverId} is still stopped after its power-on; asking again`);
        await this.serverAction(zone, serverId, 'poweron', secretKey);
      }
      await new Promise(r => setTimeout(r, this.startPollMs));
    }
    if (stopped) throw new Error(`server ${serverId} still stopped ${Math.round(timeoutMs / 1000)} s after its power-on`);
    return null;
  }

  private async setUserDataKey(zone: string, serverId: string, secretKey: string, key: string, data: string | Uint8Array): Promise<void> {
    if (!/^[A-Za-z0-9._-]+$/.test(key) || key === 'cloud-init') throw new Error(`invalid Scaleway user_data key '${key}'`);
    await this.fetchOk(
      `${this.zoneUrl(zone)}/servers/${serverId}/user_data/${key}`,
      { method: 'PATCH', headers: { 'X-Auth-Token': secretKey, 'Content-Type': 'text/plain' }, body: data as BodyInit },
      TIMEOUTS.write,
    );
  }

  private async setUserData(zone: string, serverId: string, secretKey: string, data: string): Promise<void> {
    // Scaleway user_data is set via a special endpoint (not JSON — raw text)
    await this.fetchOk(
      `${this.zoneUrl(zone)}/servers/${serverId}/user_data/cloud-init`,
      {
        method: 'PATCH',
        headers: {
          'X-Auth-Token': secretKey,
          'Content-Type': 'text/plain',
        },
        body: data,
      },
      TIMEOUTS.write,
    );
  }

  /**
   * Build a cloud-init script that pulls and runs the Docker image.
   * The bot exposes port 8080 (HTTP API), 5900 (VNC), 3099 (avatar).
   */
  private buildUserData(spec: InstanceSpec): string {
    const image = spec.dockerImage || process.env.BOT_DOCKER_IMAGE || 'marcosremar/meet-teams-bot:latest';
    const envFlags = Object.entries(spec.env || {})
      .map(([k, v]) => `-e ${k}="${v}"`)
      .join(' ');

    // Install v4l2loopback on HOST first, then Docker, then run bot with --device
    return `#!/bin/bash
set -e
exec > /var/log/cloud-init-bot.log 2>&1

# Install v4l2loopback on HOST for virtual camera (avatar → Teams)
apt-get update -qq
apt-get install -y -qq linux-headers-$(uname -r) v4l2loopback-dkms v4l-utils 2>/dev/null || true
modprobe v4l2loopback exclusive_caps=1 video_nr=10 card_label="AvatarCam" 2>/dev/null || true
ls -la /dev/video* 2>/dev/null || echo "No video devices"

command -v docker >/dev/null || apt-get install -y -qq docker.io

# Determine device flags
V4L2_FLAGS=""
if [ -e /dev/video10 ]; then
  echo "v4l2loopback ready: /dev/video10"
  V4L2_FLAGS="--device /dev/video10"
fi

# Pull and run the bot container
docker pull ${image}
docker run -d \\
  --name babelcast-bot \\
  --shm-size 2g \\
  --restart unless-stopped \\
  $V4L2_FLAGS \\
  -p 8080:8080 \\
  -p 5900:5900 \\
  -p 3099:3099 \\
  ${envFlags} \\
  ${image}
`;
  }

  /**
   * Find the Docker InstantApp image for the given zone.
   * Falls back to a known UUID if the API call fails.
   */
  private async findUbuntuImage(zone: string, secretKey: string, commercialType?: string): Promise<string> {
    // Marketplace local image compatible with this commercial type, SBS flavour (the create attaches sbs_volume).
    if (commercialType) {
      try {
        const res = await this.fetchJson<{ local_images: Array<{ id: string; compatible_commercial_types?: string[]; type?: string }> }>(
          `${SCW_MARKETPLACE_API}/local-images?image_label=ubuntu_noble&zone=${zone}&page_size=100`,
          { headers: this.scwHeaders(secretKey) },
          TIMEOUTS.read,
        );
        const compatible = res.local_images.filter(i => i.compatible_commercial_types?.includes(commercialType));
        const pick = compatible.find(i => (i.type ?? 'instance_sbs') === 'instance_sbs') ?? compatible[0];
        if (pick) return pick.id;
      } catch {
        // fall through to the legacy image listing
      }
    }
    try {
      const res = await this.fetchJson<{ images: Array<{ id: string; name: string }> }>(
        `${this.zoneUrl(zone)}/images?arch=x86_64&per_page=50`,
        { headers: this.scwHeaders(secretKey) },
        TIMEOUTS.read,
      );
      // Prefer Ubuntu 24.04, fallback to 22.04
      const noble = res.images.find(i => i.name.toLowerCase().includes('ubuntu 24.04') || i.name.includes('ubuntu-noble'));
      if (noble) return noble.id;
      const jammy = res.images.find(i => i.name.toLowerCase().includes('ubuntu 22.04') || i.name.includes('ubuntu-jammy'));
      if (jammy) return jammy.id;
    } catch {
      // API error — use known fallback
    }
    return UBUNTU_IMAGE_UUID;
  }
}
