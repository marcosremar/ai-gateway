/**
 * Scaleway Instance provider — cheap x86 CPU instances.
 *
 * API docs: https://www.scaleway.com/en/developers/api/instances/
 * Auth: X-Auth-Token header with the Scaleway secret key.
 * Pricing: DEV1-L (4 vCPU, 8GB) = €0.042/hr ≈ $0.0007/min
 *
 * Used primarily for bot deployment (CPU-only Chromium pods) as a cheaper
 * alternative to RunPod CPU pods ($0.12/hr vs €0.042/hr).
 *
 * Region/zone is passed via spec.region (e.g. 'fr-par-1', 'nl-ams-1').
 * Instance IDs are stored as 'zone:serverId' so all management ops know which zone to target.
 */

import { AbstractGpuProvider, TIMEOUTS, FetchError } from '../gpu-providers/abstract-provider';
import type { AbstractGpuProviderOptions } from '../gpu-providers/abstract-provider';
import type { GpuInstance, InstanceSpec, ProviderCredentials } from '../gpu-providers/types';

// ── Constants ────────────────────────────────────────────────────────────────

const SCW_API = process.env.SCALEWAY_API_BASE || 'https://api.scaleway.com/instance/v1';
const SCW_IAM_API = process.env.SCALEWAY_IAM_API_BASE || 'https://api.scaleway.com/iam/v1alpha1';

/** All known Scaleway zones — queried in parallel for listInstances. */
const KNOWN_ZONES = ['fr-par-1', 'fr-par-2', 'fr-par-3', 'nl-ams-1', 'nl-ams-2', 'nl-ams-3', 'pl-waw-1', 'pl-waw-2', 'pl-waw-3'];

/** Fallback zone used only when no region is specified. */
const FALLBACK_ZONE = 'fr-par-1';

/** Ubuntu 24.04 Noble Numbat x86_64 image UUID (fallback when image lookup fails). */
const UBUNTU_IMAGE_UUID = '2d6e9935-3dcd-49bd-a445-89ee55f3d781';

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

// ── Client ───────────────────────────────────────────────────────────────────

export class ScalewayClient extends AbstractGpuProvider {
  readonly providerId = 'scaleway';
  readonly bootTimeSecs = 90; // ~60-90s for small instances

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
  private async resolveProjectId(credentials: ProviderCredentials): Promise<string> {
    if (this.projectIdCache) return this.projectIdCache;

    // authId holds the access key (SCWxxxxx), apiKey holds the secret key
    const accessKey = credentials.authId || process.env.SCALEWAY_ACCESS_KEY || '';
    if (!accessKey) throw new Error('Scaleway access key required (set authId or SCALEWAY_ACCESS_KEY)');

    const res = await this.fetchJson<{ default_project_id: string }>(
      `${SCW_IAM_API}/api-keys/${accessKey}`,
      { headers: this.scwHeaders(credentials.apiKey) },
      TIMEOUTS.read,
      'scaleway',
    );
    this.projectIdCache = res.default_project_id;
    return res.default_project_id;
  }

  // ── Instance lifecycle ─────────────────────────────────────────────────

  async createInstance(
    spec: InstanceSpec,
    credentials: ProviderCredentials,
    _userId?: string,
  ): Promise<GpuInstance> {
    if (!spec.region) {
      this.log.log(`[scaleway] WARNING: no region specified, falling back to ${FALLBACK_ZONE}. Pass spec.region to deploy in a specific zone.`);
    }
    const zone = spec.region || FALLBACK_ZONE;
    const headers = this.scwHeaders(credentials.apiKey);

    // Pick the best type that meets RAM requirements, with quota fallback
    const minRam = spec.ramGb ?? 12;
    // Sort candidates: prefer types that meet RAM, sorted by RAM descending
    const candidates = COMMERCIAL_TYPES
      .filter(t => t.ramGb >= Math.min(minRam, 8)) // at least 8GB
      .sort((a, b) => b.ramGb - a.ramGb);
    if (candidates.length === 0) candidates.push(COMMERCIAL_TYPES.find(t => t.type === DEFAULT_BOT_TYPE)!);
    const ct = candidates[0];

    const name = `babelcast-bot-${Date.now()}`;
    const tags = ['babelcast', 'bot'];

    // Find the Docker InstantApp image or use Ubuntu
    const imageId = await this.findUbuntuImage(zone, credentials.apiKey);

    // Resolve the project ID from the API key
    const projectId = await this.resolveProjectId(credentials);

    // Try candidates in order (largest RAM first), fallback on quota errors
    let createRes: ScwCreateResponse | null = null;
    let usedType = ct;
    for (const candidate of candidates) {
      this.log.log(`[scaleway] Trying ${candidate.type} (${candidate.vcpus} vCPU, ${candidate.ramGb}GB) in ${zone}...`);
      try {
        createRes = await this.fetchJson<ScwCreateResponse>(
          `${this.zoneUrl(zone)}/servers`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              name,
              commercial_type: candidate.type,
              image: imageId,
              project: projectId,
              tags,
              dynamic_ip_required: true,
            }),
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
    this.log.log(`[scaleway] Server created: ${server.id} (${usedType.type})`);

    // Step 2: Set user_data (cloud-init) to pull and run the Docker image
    if (spec.dockerImage) {
      const userData = this.buildUserData(spec);
      await this.setUserData(zone, server.id, credentials.apiKey, userData);
    }

    // Step 3: Power on the server
    await this.serverAction(zone, server.id, 'poweron', credentials.apiKey);
    this.log.log(`[scaleway] Server ${server.id} powering on...`);

    // Step 4: Wait for public IP
    const ip = await this.waitForIp(zone, server.id, credentials.apiKey);
    const endpoint = ip ? `http://${ip}:8080` : '';

    this.log.log(`[scaleway] Server ready: ${server.id} at ${ip || 'no-ip'} (€${usedType.pricePerHr}/hr)`);

    return {
      instanceId: this.encodeId(zone, server.id),
      instanceName: name,
      endpoint,
      ipAddress: ip || undefined,
      status: 'starting',
      providerMeta: { zone, commercialType: usedType.type, pricePerHr: usedType.pricePerHr },
    };
  }

  async discoverInstance(
    credentials: ProviderCredentials,
    _gpuTypes: string[],
  ): Promise<GpuInstance | null> {
    const instances = await this.listInstances(credentials);
    return instances.find(i => i.status === 'running') ?? null;
  }

  async startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { zone, serverId } = this.decodeId(instanceId);
    await this.serverAction(zone, serverId, 'poweron', credentials.apiKey);
  }

  async stopInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { zone, serverId } = this.decodeId(instanceId);
    await this.serverAction(zone, serverId, 'poweroff', credentials.apiKey);
  }

  async deleteInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { zone, serverId } = this.decodeId(instanceId);
    const headers = this.scwHeaders(credentials.apiKey);

    // Try to terminate first (force poweroff + delete)
    try {
      await this.serverAction(zone, serverId, 'terminate', credentials.apiKey);
      this.log.log(`[scaleway] Terminated server ${serverId} in ${zone}`);
      return;
    } catch {
      // terminate action may not work if server is in certain states
    }

    // Fallback: poweroff then delete
    try {
      await this.serverAction(zone, serverId, 'poweroff', credentials.apiKey);
      // Wait briefly for poweroff
      await new Promise(r => setTimeout(r, 5000));
    } catch {
      // May already be stopped
    }

    await this.fetchRaw(
      `${this.zoneUrl(zone)}/servers/${serverId}`,
      { method: 'DELETE', headers },
      TIMEOUTS.write,
    );
    this.log.log(`[scaleway] Deleted server ${serverId} in ${zone}`);
  }

  async getInstanceStatus(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    const { zone, serverId } = this.decodeId(instanceId);
    try {
      const res = await this.fetchJson<ScwGetResponse>(
        `${this.zoneUrl(zone)}/servers/${serverId}`,
        { headers: this.scwHeaders(credentials.apiKey) },
        TIMEOUTS.read,
        'scaleway',
      );
      return res.server.state;
    } catch {
      return null;
    }
  }

  async listInstances(credentials: ProviderCredentials): Promise<GpuInstance[]> {
    const headers = this.scwHeaders(credentials.apiKey);

    // Query all known zones in parallel
    const results = await Promise.allSettled(
      KNOWN_ZONES.map(async (zone) => {
        const res = await this.fetchJson<ScwListResponse>(
          `${this.zoneUrl(zone)}/servers?tags=babelcast&per_page=50`,
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
    const { zone, serverId } = this.decodeId(instanceId);
    try {
      const res = await this.fetchJson<ScwGetResponse>(
        `${this.zoneUrl(zone)}/servers/${serverId}`,
        { headers: this.scwHeaders(credentials.apiKey) },
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
    return {
      instanceId: this.encodeId(zone, s.id),
      instanceName: s.name,
      endpoint: ip ? `http://${ip}:8080` : '',
      ipAddress: ip || undefined,
      status: s.state,
      providerMeta: { zone, commercialType: s.commercial_type, tags: s.tags },
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
