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

/** All known Scaleway zones — queried in parallel for listInstances. */
const KNOWN_ZONES = ['fr-par-1', 'fr-par-2', 'fr-par-3', 'nl-ams-1', 'nl-ams-2', 'nl-ams-3', 'pl-waw-1', 'pl-waw-2', 'pl-waw-3'];

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

interface ScwServer {
  id: string;
  name: string;
  state: string; // 'running' | 'stopped' | 'stopping' | 'starting' | 'locked'
  public_ip?: { address: string } | null;
  public_ips?: Array<{ address: string }>;
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

// ── Client ───────────────────────────────────────────────────────────────────

export class ScalewayClient extends AbstractGpuProvider {
  readonly providerId = 'scaleway';
  readonly bootTimeSecs = 90; // ~60-90s for small instances

  /** In-memory volume IDs by encoded instance id (for destroy when meta not passed). */
  private volumeIdsByInstance = new Map<string, string[]>();

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
      imageId = await this.findUbuntuImage(zone, secretKey);
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
        dynamic_ip_required: true,
      };
      if (attachVolume && volumeGb != null) {
        body.volumes = {
          0: { size: volumeGb * 1e9, volume_type: 'sbs_volume' },
        };
        body.routed_ip_enabled = true;
      }
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
      // user_data: custom cloud-init takes precedence over docker bot script
      if (spec.cloudInit) {
        const script = spec.cloudInit.startsWith('#!')
          ? spec.cloudInit
          : `#!/bin/bash\n${spec.cloudInit}\n`;
        await this.setUserData(zone, server.id, secretKey, script);
      } else if (spec.dockerImage) {
        await this.setUserData(zone, server.id, secretKey, this.buildUserData(spec));
      }

      await this.serverAction(zone, server.id, 'poweron', secretKey);
      this.log.log(`[scaleway] Server ${server.id} powering on...`);

      const ip = await this.waitForIp(zone, server.id, secretKey);
      const endpoint = ip ? `http://${ip}:8080` : '';

      this.log.log(`[scaleway] Server ready: ${server.id} at ${ip || 'no-ip'} (€${usedType.pricePerHr}/hr)`);

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
          pricePerHr: usedType.pricePerHr,
          tags,
          ...(volumeIds.length ? { volumeIds } : {}),
        },
      };
    } catch (err) {
      // Best-effort cleanup of server + SBS volumes (like babylon cloud-play)
      this.log.warn(`[scaleway] create failed after server ${server.id}; cleaning up: ${this.errMsg(err)}`);
      await this.deleteInstance(encodedId, credentials).catch(() => {});
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
    const secretKey = credentials.apiKey || process.env.SCALEWAY_SECRET_KEY;
    if (!secretKey) throw new Error('Scaleway secret key required');
    const { zone, serverId } = this.decodeId(instanceId);
    const headers = this.scwHeaders(secretKey);

    // Collect volume IDs before the server disappears (SBS volumes are NOT auto-deleted)
    let volumeIds = this.volumeIdsByInstance.get(instanceId) ?? [];
    try {
      const res = await this.fetchJson<ScwGetResponse>(
        `${this.zoneUrl(zone)}/servers/${serverId}`,
        { headers },
        TIMEOUTS.read,
        'scaleway',
      );
      const fromServer = volumeIdsFromServer(res.server);
      if (fromServer.length) volumeIds = fromServer;
    } catch {
      // Server may already be gone — keep cached IDs
    }

    // Try to terminate first (force poweroff + delete)
    let serverGone = false;
    try {
      await this.serverAction(zone, serverId, 'terminate', secretKey);
      this.log.log(`[scaleway] Terminated server ${serverId} in ${zone}`);
      serverGone = true;
    } catch {
      // terminate action may not work if server is in certain states
    }

    if (!serverGone) {
      // Fallback: poweroff then delete
      try {
        await this.serverAction(zone, serverId, 'poweroff', secretKey);
        await new Promise(r => setTimeout(r, 5000));
      } catch {
        // May already be stopped
      }

      try {
        await this.fetchRaw(
          `${this.zoneUrl(zone)}/servers/${serverId}`,
          { method: 'DELETE', headers },
          TIMEOUTS.write,
        );
        this.log.log(`[scaleway] Deleted server ${serverId} in ${zone}`);
      } catch (err) {
        const msg = this.errMsg(err);
        if (!msg.includes('404') && !msg.includes('not found')) throw err;
      }
    }

    if (volumeIds.length) {
      await this.dropVolumes(zone, volumeIds, secretKey);
    }
    this.volumeIdsByInstance.delete(instanceId);
  }

  /**
   * Delete SBS volumes via block/v1alpha1. Retries while volumes are still
   * attached (brief window after terminate). Does not throw if volumes linger.
   */
  private async dropVolumes(zone: string, ids: string[], secretKey: string): Promise<void> {
    const remaining = [...ids];
    const retryMs = Number(process.env.SCALEWAY_VOLUME_RETRY_MS ?? 2_000);
    const maxAttempts = 30;
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
      const ip = res.server.public_ip?.address || res.server.public_ips?.[0]?.address;
      return ip ? `http://${ip}:8080` : null;
    } catch {
      return null;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private toGpuInstance(s: ScwServer, zone: string): GpuInstance {
    const ip = s.public_ip?.address || s.public_ips?.[0]?.address;
    const volumeIds = volumeIdsFromServer(s);
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
        ...(volumeIds.length ? { volumeIds } : {}),
      },
    };
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
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await this.fetchJson<ScwGetResponse>(
          `${this.zoneUrl(zone)}/servers/${serverId}`,
          { headers: this.scwHeaders(secretKey) },
          TIMEOUTS.read,
        );
        const ip = res.server.public_ip?.address || res.server.public_ips?.[0]?.address;
        if (ip) return ip;
      } catch {
        // Server may not be ready yet
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    return null;
  }

  private async setUserData(zone: string, serverId: string, secretKey: string, data: string): Promise<void> {
    // Scaleway user_data is set via a special endpoint (not JSON — raw text)
    await this.fetchRaw(
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

# Install Docker
curl -fsSL https://get.docker.com | sh

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
  private async findUbuntuImage(zone: string, secretKey: string): Promise<string> {
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
