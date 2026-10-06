/**
 * Hyperstack GPU Provider Client.
 *
 * Hyperstack (by NexGen Cloud) exposes bare-metal GPU virtual machines with
 * NVIDIA drivers pre-installed (570.195.03 confirmed on H100 PCIe as of
 * 2026-04-17). Because they are full VMs (KVM), we get CAP_SYS_ADMIN +
 * CAP_CHECKPOINT_RESTORE + unrestricted syscall access — the prerequisites
 * for CRIU/cuda-checkpoint snapshot capture.
 *
 * API reference: https://infrahub-api-doc.nexgencloud.com/ (base:
 * https://infrahub-api.nexgencloud.com/v1).
 *
 * This client focuses on the minimum viable surface needed for the snapshot
 * path — create/stop/terminate/list/getInstance/listOffers. Other lifecycle
 * hooks (reboot, snapshot-on-provider) are intentionally deferred: the
 * snapshot capture itself is implemented above this layer via SSH + CRIU.
 */

import type {
  GpuInstance,
  GpuOffer,
  InstanceSpec,
  ListOffersOptions,
  ProviderCredentials,
} from './types';
import { AbstractGpuProvider, TIMEOUTS, pollUntilReady } from './abstract-provider';
import type { AbstractGpuProviderOptions } from './abstract-provider';
import { normalizeInstanceStatus } from './instance-status';

const HYPERSTACK_API_BASE =
  process.env.HYPERSTACK_API_BASE || 'https://infrahub-api.nexgencloud.com/v1';
const DEFAULT_HYPERSTACK_REGION = 'CANADA-1';
const DEFAULT_HYPERSTACK_IMAGE_NAME = 'Ubuntu Server 22.04 LTS R570 CUDA 12.8 with Docker';
const HYPERSTACK_IMAGE_FALLBACKS = [
  DEFAULT_HYPERSTACK_IMAGE_NAME,
  'Ubuntu Server 24.04 LTS R570 CUDA 12.8 with Docker',
  'Ubuntu Server 22.04 LTS R550 CUDA 12.4 with Docker',
  'Ubuntu Server 22.04 LTS R535 CUDA 12.2 with Docker',
] as const;

/** Default boot time estimate for Hyperstack VMs (pre-pulled cloud image). */
const HYPERSTACK_BOOT_TIME_SECS = 90;

/**
 * Map our canonical GPU type names (see server/config.ts PREFERRED_GPU_TYPES)
 * to Hyperstack flavor identifiers. The real identifiers are retrieved via
 * the flavors endpoint at runtime, but we pre-define a mapping for the most
 * common GPUs so offer listing stays predictable.
 */
const HYPERSTACK_GPU_NAME_MAP: Record<string, string> = {
  'NVIDIA H100 80GB HBM3': 'H100-80G-PCIe',
  'NVIDIA H100': 'H100-80G-PCIe',
  'H100': 'H100-80G-PCIe',
  'NVIDIA L40': 'L40-48G-PCIe',
  'L40': 'L40-48G-PCIe',
  'NVIDIA L40S': 'L40S-48G-PCIe',
  'L40S': 'L40S-48G-PCIe',
  'NVIDIA RTX A6000': 'A6000-48G-PCIe',
  'RTX A6000': 'A6000-48G-PCIe',
  'NVIDIA RTX A4000': 'RTX-A4000',
  'RTX A4000': 'RTX-A4000',
  'NVIDIA A100 80GB PCIe': 'A100-80G-PCIe',
  'NVIDIA A100': 'A100-80G-PCIe',
  'A100': 'A100-80G-PCIe',
};

/**
 * Raw Hyperstack VM payload (subset — only fields we use). The real API
 * returns many more fields but we stick to the ones that stabilize our
 * lifecycle operations.
 */
interface HyperstackVmRaw {
  id: number;
  name?: string;
  status?: string;
  power_state?: string;
  fixed_ip?: string;
  floating_ip?: string;
  flavor?: { id: number; name?: string; gpu?: string };
  image?: { id?: number; name?: string };
  environment?: { id?: number; name?: string };
  created_at?: string;
  [key: string]: unknown;
}

interface HyperstackFlavorRaw {
  id: number;
  name: string;
  display_name?: string | null;
  gpu?: string;
  gpu_count?: number;
  ram?: number;
  cpu?: number;
  disk?: number;
  price_per_hour?: number;
  region?: string;
  region_name?: string;
  stock_available?: boolean;
  // Driver version may or may not be exposed per-flavor depending on API rev;
  // we keep the field so tests can inject it.
  driver_version?: string;
}

interface HyperstackFlavorGroupRaw {
  gpu?: string;
  region_name?: string;
  flavors?: HyperstackFlavorRaw[];
}

interface HyperstackEnvironmentRaw {
  id: number;
  name: string;
  region?: string;
  features?: {
    green_status?: string;
    [key: string]: unknown;
  };
}

interface HyperstackImageRaw {
  id: number;
  name: string;
  region_name?: string;
  version?: string;
  type?: string;
  is_public?: boolean;
}

interface HyperstackImageGroupRaw {
  region_name?: string;
  images?: HyperstackImageRaw[];
}

/** Minimal snapshot shape exposed to callers. Hyperstack returns more fields
 *  (size_gb, created_at, source_vm) but we only surface the identity triple. */
export interface HyperstackSnapshot {
  id: number;
  name: string;
  status: string;
  description?: string;
  region?: string;
  createdAt?: string;
  sourceVmId?: number;
}

/** Minimal custom-image shape. Hyperstack groups images by region + OS type;
 *  we flatten that into a single list so callers can filter client-side. */
export interface HyperstackImage {
  id: number;
  name: string;
  region?: string;
  version?: string;
  /** Hyperstack marks whether the image is a shared platform image (`Ubuntu`,
   *  `Rocky`, etc.) vs a user-owned custom image promoted from a snapshot. */
  type?: string;
  isPublic?: boolean;
}

/** Raw shape of `GET /core/snapshots` response entries. */
interface HyperstackSnapshotRaw {
  id: number;
  name: string;
  status?: string;
  description?: string;
  region?: string;
  region_name?: string;
  created_at?: string;
  vm?: { id?: number };
  vm_id?: number;
  [key: string]: unknown;
}

export interface HyperstackClientOptions extends AbstractGpuProviderOptions {
  /** Override the API base URL (useful for mocked tests). */
  apiBase?: string;
  /** Default region (e.g. 'CANADA-1'). Callers can override per-instance. */
  defaultRegion?: string;
}

export class HyperstackClient extends AbstractGpuProvider {
  readonly providerId = 'hyperstack';
  readonly bootTimeSecs = HYPERSTACK_BOOT_TIME_SECS;
  private readonly apiBase: string;
  private readonly defaultRegion?: string;

  constructor(opts?: HyperstackClientOptions) {
    super(opts);
    this.apiBase = (opts?.apiBase ?? HYPERSTACK_API_BASE).replace(/\/+$/, '');
    this.defaultRegion = opts?.defaultRegion;
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'api_key': apiKey,
    };
  }

  private mapStatus(raw: HyperstackVmRaw): string {
    const status = (raw.status || '').toLowerCase();
    const power = (raw.power_state || '').toLowerCase();
    // Prefer combined active+running signal, then fall back to raw fields.
    if (status === 'active' && power === 'running') return normalizeInstanceStatus('running');
    if (power === 'shutdown') return normalizeInstanceStatus('stopped');
    return normalizeInstanceStatus(raw.status || raw.power_state || 'unknown');
  }

  private toGpuInstance(raw: HyperstackVmRaw): GpuInstance {
    const ip = (raw.floating_ip || raw.fixed_ip || '') as string;
    const endpoint = ip ? `http://${ip}:8000` : '';
    return {
      instanceId: String(raw.id),
      instanceName: raw.name,
      endpoint,
      ipAddress: ip,
      status: this.mapStatus(raw),
      gpuType: raw.flavor?.gpu,
      sshHost: ip,
      sshPort: 22,
      providerMeta: {
        provider: 'hyperstack',
        flavorId: raw.flavor?.id,
        flavorName: raw.flavor?.name,
        region: raw.environment?.name,
        createdAt: raw.created_at,
      },
    };
  }

  // ── Discovery & listing ────────────────────────────────────────────────

  async listInstances(credentials: ProviderCredentials): Promise<GpuInstance[]> {
    try {
      const data = await this.fetchJson<{ instances?: HyperstackVmRaw[] }>(
        `${this.apiBase}/core/virtual-machines`,
        { method: 'GET', headers: this.headers(credentials.apiKey) },
        TIMEOUTS.read,
        'hyperstack',
      );
      return (data.instances ?? []).map((v) => this.toGpuInstance(v));
    } catch (err) {
      this.log.warn(`[hyperstack] listInstances failed: ${this.errMsg(err)}`);
      return [];
    }
  }

  async discoverInstance(
    credentials: ProviderCredentials,
    gpuTypes: string[],
  ): Promise<GpuInstance | null> {
    const instances = await this.listInstances(credentials);
    // Prefer running instances; fall back to any matching flavor.
    const matches = instances.filter(
      (i) => !gpuTypes.length || gpuTypes.some((g) => (i.gpuType ?? '').includes(g)),
    );
    const running = matches.find((m) => m.status === 'running');
    return running ?? matches[0] ?? null;
  }

  async listOffers(
    options: ListOffersOptions,
    credentials: ProviderCredentials,
  ): Promise<GpuOffer[]> {
    try {
      const data = await this.fetchJson<{ flavors?: HyperstackFlavorRaw[]; data?: HyperstackFlavorGroupRaw[] }>(
        `${this.apiBase}/core/flavors`,
        { method: 'GET', headers: this.headers(credentials.apiKey) },
        TIMEOUTS.read,
        'hyperstack',
      );
      const flavors = Array.isArray(data.flavors)
        ? data.flavors
        : (data.data ?? []).flatMap((group) =>
            (group.flavors ?? []).map((flavor) => ({
              ...flavor,
              gpu: flavor.gpu || group.gpu,
              region_name: flavor.region_name || group.region_name,
            })),
          );
      const desired = new Set(options.gpuTypes ?? []);
      const offers: GpuOffer[] = [];
      for (const f of flavors) {
        const gpuName = f.gpu ?? '';
        if (!gpuName.trim()) continue;
        if (desired.size > 0) {
          if (![...desired].some((d) => this.matchesGpuType(gpuName, d))) continue;
        }
        const region = f.region ?? f.region_name ?? 'unknown';
        if (options.region && region.toUpperCase() !== options.region.toUpperCase()) continue;
        offers.push({
          provider: 'hyperstack',
          gpuType: gpuName,
          gpuName,
          available: f.stock_available === false ? 0 : 1,
          pricePerHr: f.price_per_hour ?? 0,
          region,
          vram: this.gpuVram(gpuName),
          offerId: f.name || String(f.id),
          numGpus: f.gpu_count ?? 1,
          ramGb: f.ram,
          cpuCores: f.cpu,
          diskGb: f.disk,
          // When the API surfaces a driver version we propagate it so the
          // snapshot gate can trust only recent drivers (see autoSelect gating).
          ...((f as unknown as Record<string, unknown>).driver_version
            ? { driverVersion: String((f as unknown as Record<string, unknown>).driver_version) }
            : {}),
        } as GpuOffer & { driverVersion?: string });
      }
      if (options.limit) return offers.slice(0, options.limit);
      return offers;
    } catch (err) {
      this.log.warn(`[hyperstack] listOffers failed: ${this.errMsg(err)}`);
      return [];
    }
  }

  private normalizeGpuName(name: string): string {
    return name
      .toLowerCase()
      .replace(/nvidia|geforce/g, ' ')
      .replace(/80gb|80g/g, '80')
      .replace(/48gb|48g/g, '48')
      .replace(/24gb|24g/g, '24')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  private matchesGpuType(actual: string, desired: string): boolean {
    const normalizedActual = this.normalizeGpuName(actual);
    const normalizedDesired = this.normalizeGpuName(desired);
    if (normalizedActual.includes(normalizedDesired) || normalizedDesired.includes(normalizedActual)) {
      return true;
    }
    const mapped = HYPERSTACK_GPU_NAME_MAP[desired] ?? HYPERSTACK_GPU_NAME_MAP[desired.trim()];
    if (!mapped) return false;
    const normalizedMapped = this.normalizeGpuName(mapped);
    return normalizedMapped.includes(normalizedActual) || normalizedActual.includes(normalizedMapped);
  }

  private gpuVram(gpuName: string): number {
    const n = gpuName.toLowerCase();
    if (n.includes('h100')) return 80;
    if (n.includes('a100')) return 80;
    if (n.includes('l40s') || n.includes('l40')) return 48;
    if (n.includes('a6000')) return 48;
    if (n.includes('a4000')) return 16;
    if (n.includes('rtx 5090')) return 32;
    if (n.includes('rtx 4090')) return 24;
    return 0;
  }

  private async resolveEnvironmentName(
    regionOrEnvironment: string | undefined,
    credentials: ProviderCredentials,
  ): Promise<string> {
    const target = (regionOrEnvironment || this.defaultRegion || DEFAULT_HYPERSTACK_REGION).toUpperCase();
    const directName = regionOrEnvironment?.trim();
    if (directName?.startsWith('default-')) return directName;

    const data = await this.fetchJson<{ environments?: HyperstackEnvironmentRaw[] }>(
      `${this.apiBase}/core/environments`,
      { method: 'GET', headers: this.headers(credentials.apiKey) },
      TIMEOUTS.read,
      'hyperstack',
    );
    const environments = data.environments ?? [];
    if (directName) {
      const direct = environments.find((env) => env.name === directName);
      if (direct) return direct.name;
    }

    const candidates = environments.filter((env) => (env.region ?? '').toUpperCase() === target);
    const preferred =
      candidates.find((env) => env.name === `default-${target}`) ??
      candidates.find((env) => env.features?.green_status === 'GREEN') ??
      candidates[0];
    if (!preferred) {
      throw new Error(`[hyperstack] No environment found for region ${target}`);
    }
    return preferred.name;
  }

  private async resolveImageName(
    region: string,
    credentials: ProviderCredentials,
  ): Promise<string> {
    const override = process.env.HYPERSTACK_IMAGE_NAME?.trim();
    if (override) return override;

    const data = await this.fetchJson<{ images?: HyperstackImageGroupRaw[] }>(
      `${this.apiBase}/core/images`,
      { method: 'GET', headers: this.headers(credentials.apiKey) },
      TIMEOUTS.read,
      'hyperstack',
    );
    const images = (data.images ?? []).flatMap((group) =>
      (group.images ?? []).map((image) => ({
        ...image,
        region_name: image.region_name || group.region_name,
      })),
    );
    const inRegion = images.filter((image) => (image.region_name ?? '').toUpperCase() === region.toUpperCase());
    for (const preferredName of HYPERSTACK_IMAGE_FALLBACKS) {
      const match = inRegion.find((image) => image.name === preferredName);
      if (match) return match.name;
    }
    const dockerImage = inRegion.find((image) => /docker/i.test(image.name));
    if (dockerImage) return dockerImage.name;
    throw new Error(`[hyperstack] No Docker-capable image found for region ${region}`);
  }

  private async createSecurityRule(
    instanceId: string,
    credentials: ProviderCredentials,
    port: number,
    protocol: 'tcp' | 'udp' = 'tcp',
  ): Promise<void> {
    const body = {
      remote_ip_prefix: '0.0.0.0/0',
      direction: 'ingress',
      ethertype: 'IPv4',
      protocol,
      port_range_min: port,
      port_range_max: port,
    };
    try {
      await this.fetchRaw(
        `${this.apiBase}/core/virtual-machines/${instanceId}/sg-rules`,
        { method: 'POST', headers: this.headers(credentials.apiKey), body: JSON.stringify(body) },
        TIMEOUTS.write,
      );
    } catch (err) {
      const message = this.errMsg(err);
      if (/already exists|duplicate/i.test(message)) return;
      throw err;
    }
  }

  private async ensureSecurityRule(
    instanceId: string,
    credentials: ProviderCredentials,
    port: number,
    protocol: 'tcp' | 'udp' = 'tcp',
  ): Promise<void> {
    await this.createSecurityRule(instanceId, credentials, port, protocol);
    const applied = await pollUntilReady<boolean>(
      async () => {
        const detail = await this.fetchJson<{ instance?: HyperstackVmRaw }>(
          `${this.apiBase}/core/virtual-machines/${instanceId}`,
          { method: 'GET', headers: this.headers(credentials.apiKey) },
          TIMEOUTS.read,
          'hyperstack',
        ).catch(() => ({ instance: undefined }));
        if (detail.instance && !Array.isArray(detail.instance.security_rules)) {
          // Some Hyperstack responses do not echo security_rules after a
          // successful create call. Treat the POST as authoritative so deploy
          // does not sit in a 30s confirmation loop for every port.
          return true;
        }
        const rules = (detail.instance?.security_rules ?? []) as Array<Record<string, unknown>>;
        const match = rules.find((rule) =>
          String(rule.direction || '').toLowerCase() === 'ingress' &&
          String(rule.protocol || '').toLowerCase() === protocol &&
          Number(rule.port_range_min) === port &&
          Number(rule.port_range_max) === port,
        );
        if (!match) return null;
        const status = String(match.status || '').toUpperCase();
        if (status === 'SUCCESS') return true;
        if (status === 'ERROR' || status === 'FAILED') {
          throw new Error(`[hyperstack] security rule ${protocol}/${port} failed`);
        }
        return null;
      },
      { baseIntervalMs: 3_000, maxWaitMs: 30_000 },
    );
    if (!applied) {
      this.log.warn(`[hyperstack] security rule ${protocol}/${port} did not confirm within timeout`);
    }
  }

  // ── Create / lifecycle ────────────────────────────────────────────────

  async createInstance(
    spec: InstanceSpec,
    credentials: ProviderCredentials,
    userId?: string,
  ): Promise<GpuInstance> {
    await this._runPreflight(credentials);

    // Resolve flavor id from the requested GPU types (first match wins).
    this.log.warn(`[hyperstack][DEBUG] createInstance spec.gpuTypes=${JSON.stringify(spec.gpuTypes)} spec.region=${JSON.stringify(spec.region)}`);
    const offers = await this.listOffers({ gpuTypes: spec.gpuTypes, region: spec.region }, credentials);
    this.log.warn(`[hyperstack][DEBUG] listOffers returned ${offers.length} offers; first=${JSON.stringify(offers[0] ?? null)}`);
    const chosen = offers[0];
    if (!chosen || !chosen.offerId) {
      throw new Error(`[hyperstack] No matching flavor for GPUs ${spec.gpuTypes?.join(',') ?? '(any)'}`);
    }

    const envVars: Record<string, string> = { TZ: 'UTC', ...(spec.env ?? {}) };

    // Hyperstack runs arbitrary "user_data" (cloud-init). Installing NVIDIA
    // driver 570+ if missing is the user's responsibility at this tier —
    // default Canada-1 images ship with 570 already. We inject the docker
    // run command as a systemd service so the app starts automatically.
    const dockerImage = spec.dockerImage || '';
    if (!dockerImage) throw new Error('[hyperstack] spec.dockerImage is required');
    const region = spec.region || chosen.region || this.defaultRegion || DEFAULT_HYPERSTACK_REGION;
    const environmentName = await this.resolveEnvironmentName(region, credentials);

    // Image selection priority. Hyperstack's VM-create endpoint only accepts
    // `image_name` (not `image_id`); when callers pin by id we look up the
    // name via listImages.
    //   1. spec.imageName
    //   2. spec.imageId  — resolved to name via listImages()
    //   3. env HYPERSTACK_BENCH_IMAGE_NAME
    //   4. env HYPERSTACK_BENCH_IMAGE_ID — resolved to name via listImages()
    //   5. resolveImageName() — region-aware lookup of the stock Ubuntu image.
    const resolveImageNameById = async (id: number | string): Promise<string | undefined> => {
      const images = await this.listImages(credentials).catch(() => [] as HyperstackImage[]);
      const match = images.find((im) => String(im.id) === String(id));
      return match?.name;
    };
    let imageName: string | undefined;
    if (spec.imageName) {
      imageName = spec.imageName;
    } else if (spec.imageId !== undefined) {
      imageName = await resolveImageNameById(spec.imageId);
      if (!imageName) throw new Error(`[hyperstack] imageId=${spec.imageId} not found in listImages`);
    } else if (process.env.HYPERSTACK_BENCH_IMAGE_NAME) {
      imageName = process.env.HYPERSTACK_BENCH_IMAGE_NAME;
    } else if (process.env.HYPERSTACK_BENCH_IMAGE_ID) {
      imageName = await resolveImageNameById(process.env.HYPERSTACK_BENCH_IMAGE_ID);
      if (!imageName) throw new Error(`[hyperstack] HYPERSTACK_BENCH_IMAGE_ID=${process.env.HYPERSTACK_BENCH_IMAGE_ID} not found in listImages`);
    } else {
      imageName = await this.resolveImageName(region, credentials);
    }
    const imageBody: Record<string, unknown> = { image_name: imageName };

    const body: Record<string, unknown> = {
      name: `ai-gateway-${Date.now()}`,
      environment_name: environmentName,
      ...imageBody,
      flavor_name: chosen.offerId,
      key_name: process.env.HYPERSTACK_KEY_NAME || 'ai-gateway-default',
      count: 1,
      assign_floating_ip: true,
      user_data: this.buildUserData(dockerImage, envVars, spec.dockerStartCmd),
    };

    const created = await this.fetchJson<{ instances?: HyperstackVmRaw[]; status?: boolean }>(
      `${this.apiBase}/core/virtual-machines`,
      { method: 'POST', headers: this.headers(credentials.apiKey), body: JSON.stringify(body) },
      TIMEOUTS.create,
      'hyperstack',
    );
    const raw = created.instances?.[0];
    if (!raw) throw new Error(`[hyperstack] createVM returned no instance`);

    const machineKey = spec.machineKey ?? 'vastInstance'; // piggyback existing machineKey slot
    await this.persistInstance(userId, machineKey, {
      provider: 'hyperstack',
      instanceId: String(raw.id),
      flavorId: chosen.offerId,
    });

    // Poll for floating IP / running state.
    const final = await pollUntilReady<HyperstackVmRaw>(
      async () => {
        const detail = await this.fetchJson<{ instance?: HyperstackVmRaw }>(
          `${this.apiBase}/core/virtual-machines/${raw.id}`,
          { method: 'GET', headers: this.headers(credentials.apiKey) },
          TIMEOUTS.read,
          'hyperstack',
        ).catch(() => ({ instance: undefined }));
        if (!detail.instance) return null;
        if (detail.instance.floating_ip && this.mapStatus(detail.instance) === 'running') return detail.instance;
        return null;
      },
      { baseIntervalMs: 10_000, maxWaitMs: 300_000 },
    );

    const readyInstance = final ?? raw;

    // Hyperstack VMs are secure-by-default and do not expose ingress until
    // explicit rules are attached. Apply them after the VM is ACTIVE so the
    // API accepts the rule and the gateway can probe the endpoint immediately.
    const sgResults = await Promise.allSettled([
      this.ensureSecurityRule(String(readyInstance.id), credentials, 22, 'tcp'),
      this.ensureSecurityRule(String(readyInstance.id), credentials, 8000, 'tcp'),
    ]);
    for (const result of sgResults) {
      if (result.status === 'rejected') {
        this.log.warn(`[hyperstack] security rule creation skipped: ${this.errMsg(result.reason)}`);
      }
    }

    return this.toGpuInstance(readyInstance);
  }

  private buildUserData(
    dockerImage: string,
    env: Record<string, string>,
    dockerStartCmd?: string,
  ): string {
    const envFlags = Object.entries(env)
      .map(([k, v]) => `-e ${shellEscape(k)}=${shellEscape(v)}`)
      .join(' ');
    const runCmd = dockerStartCmd?.trim()
      ? ` bash -lc ${shellEscape(dockerStartCmd)}`
      : '';
    // Docker-capable Hyperstack images ship with Docker preinstalled, but the
    // daemon may still be starting during first-boot cloud-init.
    const script = `#!/bin/bash
set -euxo pipefail
systemctl enable --now docker || true
for i in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker rm -f ai-gateway-app || true
docker pull ${shellEscape(dockerImage)}
docker run -d --gpus all --restart unless-stopped \\
  -p 8000:8000 -p 8001:8001/udp \\
  ${envFlags} \\
  --name ai-gateway-app ${shellEscape(dockerImage)}${runCmd}
`;
    return script;
  }

  async startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    await this.fetchRaw(
      `${this.apiBase}/core/virtual-machines/${encodeURIComponent(instanceId)}/start`,
      { method: 'GET', headers: this.headers(credentials.apiKey) },
      TIMEOUTS.write,
    );
  }

  async stopInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    await this.fetchRaw(
      `${this.apiBase}/core/virtual-machines/${encodeURIComponent(instanceId)}/stop`,
      { method: 'GET', headers: this.headers(credentials.apiKey) },
      TIMEOUTS.write,
    );
  }

  async deleteInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    await this.fetchRaw(
      `${this.apiBase}/core/virtual-machines/${encodeURIComponent(instanceId)}`,
      { method: 'DELETE', headers: this.headers(credentials.apiKey) },
      TIMEOUTS.write,
    );
  }

  async getInstanceStatus(
    instanceId: string,
    credentials: ProviderCredentials,
  ): Promise<string | null> {
    try {
      const data = await this.fetchJson<{ instance?: HyperstackVmRaw }>(
        `${this.apiBase}/core/virtual-machines/${encodeURIComponent(instanceId)}`,
        { method: 'GET', headers: this.headers(credentials.apiKey) },
        TIMEOUTS.read,
        'hyperstack',
      );
      if (!data.instance) return null;
      return this.mapStatus(data.instance);
    } catch (err) {
      this.log.warn(`[hyperstack] getInstanceStatus failed: ${this.errMsg(err)}`);
      return null;
    }
  }

  async resolveInstanceEndpoint(
    instanceId: string,
    credentials: ProviderCredentials,
  ): Promise<string | null> {
    try {
      const data = await this.fetchJson<{ instance?: HyperstackVmRaw }>(
        `${this.apiBase}/core/virtual-machines/${encodeURIComponent(instanceId)}`,
        { method: 'GET', headers: this.headers(credentials.apiKey) },
        TIMEOUTS.read,
        'hyperstack',
      );
      const ip = data.instance?.floating_ip ?? data.instance?.fixed_ip ?? '';
      return ip ? `http://${ip}:8000` : null;
    } catch {
      return null;
    }
  }

  // ── Custom OS Images & Snapshots ─────────────────────────────────────────
  //
  // Hyperstack's image/snapshot model is two-stage:
  //   1. `POST /core/virtual-machines/{id}/snapshots` with `{name, description}`
  //      captures a point-in-time snapshot of a *stopped* VM's disks.
  //   2. `POST /core/snapshots/{id}/image` with `{name}` promotes that
  //      snapshot into a reusable Custom OS Image that later VMs can boot
  //      from via `image_name` or `image_id` in the VM-create payload.
  //
  // Route shapes verified against the live API (2026-04-18):
  //   POST /core/virtual-machines/1/snapshots        → 404 "VM 1 was not found"
  //   POST /core/virtual-machines/1/snapshot (singular) → 404 Not Found
  //   POST /core/snapshots/1/image  {name:"x"}       → 404 "Snapshot not found"
  //     (rejects description, is_public, region — name is the only accepted field)
  //   DELETE /core/snapshots/1                       → 404 "Snapshot 1 does not exist"

  /**
   * Create a snapshot from a running/stopped VM. Hyperstack requires both
   * `name` and `description` (4xx if either is missing). Returns minimal
   * identity info; poll `listSnapshots()` for status transitions.
   */
  async createSnapshot(
    instanceId: string,
    name: string,
    credentials: ProviderCredentials,
    description?: string,
  ): Promise<HyperstackSnapshot> {
    const body = {
      name,
      // `description` is required by the API; fall back to a default tying
      // the snapshot to the source VM so operators can trace provenance.
      description: description?.trim() || `ai-gateway snapshot of VM ${instanceId}`,
    };
    const data = await this.fetchJson<{
      snapshot?: HyperstackSnapshotRaw;
      id?: number;
      name?: string;
      status?: string;
    }>(
      `${this.apiBase}/core/virtual-machines/${encodeURIComponent(instanceId)}/snapshots`,
      { method: 'POST', headers: this.headers(credentials.apiKey), body: JSON.stringify(body) },
      TIMEOUTS.write,
      'hyperstack',
    );
    const raw = data.snapshot ?? (data.id !== undefined ? (data as HyperstackSnapshotRaw) : undefined);
    if (!raw || raw.id === undefined) {
      throw new Error(`[hyperstack] createSnapshot returned no snapshot id`);
    }
    return this.toSnapshot(raw);
  }

  async listSnapshots(credentials: ProviderCredentials): Promise<HyperstackSnapshot[]> {
    const data = await this.fetchJson<{ snapshots?: HyperstackSnapshotRaw[] }>(
      `${this.apiBase}/core/snapshots`,
      { method: 'GET', headers: this.headers(credentials.apiKey) },
      TIMEOUTS.read,
      'hyperstack',
    );
    return (data.snapshots ?? []).map((s) => this.toSnapshot(s));
  }

  async deleteSnapshot(
    snapshotId: string | number,
    credentials: ProviderCredentials,
  ): Promise<void> {
    await this.fetchRaw(
      `${this.apiBase}/core/snapshots/${encodeURIComponent(String(snapshotId))}`,
      { method: 'DELETE', headers: this.headers(credentials.apiKey) },
      TIMEOUTS.write,
    );
  }

  /**
   * Promote a snapshot into a reusable Custom OS Image. Hyperstack's API only
   * accepts `{name}` on this route (verified: `description`, `is_public`,
   * `region` all rejected with "Unknown field"). The new image appears under
   * `listImages()` with type distinct from the stock Ubuntu images.
   */
  async createImageFromSnapshot(
    snapshotId: string | number,
    name: string,
    credentials: ProviderCredentials,
  ): Promise<HyperstackImage> {
    const data = await this.fetchJson<{
      image?: HyperstackImageRaw;
      id?: number;
      name?: string;
    }>(
      `${this.apiBase}/core/snapshots/${encodeURIComponent(String(snapshotId))}/image`,
      { method: 'POST', headers: this.headers(credentials.apiKey), body: JSON.stringify({ name }) },
      TIMEOUTS.write,
      'hyperstack',
    );
    const raw = data.image ?? (data.id !== undefined ? (data as HyperstackImageRaw) : undefined);
    if (!raw || raw.id === undefined) {
      throw new Error(`[hyperstack] createImageFromSnapshot returned no image id`);
    }
    return this.toImage(raw);
  }

  async listImages(credentials: ProviderCredentials): Promise<HyperstackImage[]> {
    const data = await this.fetchJson<{ images?: HyperstackImageGroupRaw[] }>(
      `${this.apiBase}/core/images`,
      { method: 'GET', headers: this.headers(credentials.apiKey) },
      TIMEOUTS.read,
      'hyperstack',
    );
    const images: HyperstackImage[] = [];
    for (const group of data.images ?? []) {
      for (const img of group.images ?? []) {
        images.push(
          this.toImage({
            ...img,
            region_name: img.region_name || group.region_name,
          }),
        );
      }
    }
    return images;
  }

  /**
   * Hibernate a VM (suspend-to-disk). Resume with `hibernateRestore()`.
   * Verified: the route accepts GET only — OPTIONS returns `allow: OPTIONS,
   * GET, HEAD`. POST/PUT are 405. Matches the `/start` and `/stop` pattern
   * used elsewhere in the Hyperstack API.
   */
  async hibernate(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    await this.fetchRaw(
      `${this.apiBase}/core/virtual-machines/${encodeURIComponent(instanceId)}/hibernate`,
      { method: 'GET', headers: this.headers(credentials.apiKey) },
      TIMEOUTS.write,
    );
  }

  async hibernateRestore(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    await this.fetchRaw(
      `${this.apiBase}/core/virtual-machines/${encodeURIComponent(instanceId)}/hibernate-restore`,
      { method: 'GET', headers: this.headers(credentials.apiKey) },
      TIMEOUTS.write,
    );
  }

  private toSnapshot(raw: HyperstackSnapshotRaw): HyperstackSnapshot {
    const out: HyperstackSnapshot = {
      id: Number(raw.id),
      name: String(raw.name ?? ''),
      status: String(raw.status ?? 'unknown'),
    };
    if (raw.description) out.description = raw.description;
    const region = raw.region ?? raw.region_name;
    if (region) out.region = String(region);
    if (raw.created_at) out.createdAt = String(raw.created_at);
    const srcVm = raw.vm?.id ?? raw.vm_id;
    if (srcVm !== undefined) out.sourceVmId = Number(srcVm);
    return out;
  }

  private toImage(raw: HyperstackImageRaw): HyperstackImage {
    const out: HyperstackImage = {
      id: Number(raw.id),
      name: String(raw.name),
    };
    if (raw.region_name) out.region = String(raw.region_name);
    if (raw.version) out.version = String(raw.version);
    if (raw.type) out.type = String(raw.type);
    if (raw.is_public !== undefined) out.isPublic = Boolean(raw.is_public);
    return out;
  }

  /** Driver 570.195.03 confirmed on H100 PCIe Canada-1 (April 2026). */
  static readonly DEFAULT_DRIVER_MAJOR = 570;
}

function shellEscape(s: string): string {
  // Wrap in single quotes and escape any single quote inside.
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
