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

const HYPERSTACK_API_BASE =
  process.env.HYPERSTACK_API_BASE || 'https://infrahub-api.nexgencloud.com/v1';

/** Default boot time estimate for Hyperstack VMs (pre-pulled cloud image). */
const HYPERSTACK_BOOT_TIME_SECS = 90;

/**
 * Map our canonical GPU type names (see server/config.ts PREFERRED_GPU_TYPES)
 * to Hyperstack flavor identifiers. The real identifiers are retrieved via
 * the flavors endpoint at runtime, but we pre-define a mapping for the most
 * common GPUs so offer listing stays predictable.
 */
const HYPERSTACK_GPU_NAME_MAP: Record<string, string> = {
  'NVIDIA H100 80GB HBM3': 'H100-PCIe-80G',
  'NVIDIA H100': 'H100-PCIe-80G',
  'H100': 'H100-PCIe-80G',
  'NVIDIA L40': 'L40-PCIe-48G',
  'L40': 'L40-PCIe-48G',
  'NVIDIA L40S': 'L40S-PCIe-48G',
  'L40S': 'L40S-PCIe-48G',
  'NVIDIA RTX A6000': 'A6000-PCIe-48G',
  'RTX A6000': 'A6000-PCIe-48G',
  'NVIDIA A100 80GB PCIe': 'A100-PCIe-80G',
  'NVIDIA A100': 'A100-PCIe-80G',
  'A100': 'A100-PCIe-80G',
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
  gpu?: string;
  gpu_count?: number;
  ram?: number;
  cpu?: number;
  disk?: number;
  price_per_hour?: number;
  region?: string;
  // Driver version may or may not be exposed per-flavor depending on API rev;
  // we keep the field so tests can inject it.
  driver_version?: string;
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
    if (status === 'active' && power === 'running') return 'running';
    if (status === 'creating' || status === 'building') return 'creating';
    if (status === 'error' || status === 'failed') return 'error';
    if (status === 'stopped' || power === 'shutdown') return 'stopped';
    if (status === 'deleting' || status === 'deleted') return 'deleted';
    return status || power || 'unknown';
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
      const data = await this.fetchJson<{ flavors?: HyperstackFlavorRaw[] }>(
        `${this.apiBase}/core/flavors`,
        { method: 'GET', headers: this.headers(credentials.apiKey) },
        TIMEOUTS.read,
        'hyperstack',
      );
      const flavors = data.flavors ?? [];
      const desired = new Set((options.gpuTypes ?? []).map((g) => g.toLowerCase()));
      const offers: GpuOffer[] = [];
      for (const f of flavors) {
        const gpuName = f.gpu ?? '';
        if (desired.size > 0) {
          const lower = gpuName.toLowerCase();
          if (![...desired].some((d) => lower.includes(d) || d.includes(lower))) continue;
        }
        if (options.region && f.region && options.region.toUpperCase() !== (f.region ?? '').toUpperCase()) continue;
        offers.push({
          provider: 'hyperstack',
          gpuType: gpuName,
          gpuName,
          available: 1,
          pricePerHr: f.price_per_hour ?? 0,
          region: f.region ?? 'unknown',
          vram: this.gpuVram(gpuName),
          offerId: String(f.id),
          numGpus: f.gpu_count ?? 1,
          ramGb: f.ram,
          cpuCores: f.cpu,
          diskGb: f.disk,
          // When the API surfaces a driver version we propagate it so the
          // snapshot gate can trust only recent drivers (see autoSelect gating).
          ...((f as Record<string, unknown>).driver_version
            ? { driverVersion: String((f as Record<string, unknown>).driver_version) }
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

  private gpuVram(gpuName: string): number {
    const n = gpuName.toLowerCase();
    if (n.includes('h100')) return 80;
    if (n.includes('a100')) return 80;
    if (n.includes('l40s') || n.includes('l40')) return 48;
    if (n.includes('a6000')) return 48;
    if (n.includes('rtx 5090')) return 32;
    if (n.includes('rtx 4090')) return 24;
    return 0;
  }

  // ── Create / lifecycle ────────────────────────────────────────────────

  async createInstance(
    spec: InstanceSpec,
    credentials: ProviderCredentials,
    userId?: string,
  ): Promise<GpuInstance> {
    await this._runPreflight(credentials);

    // Resolve flavor id from the requested GPU types (first match wins).
    const offers = await this.listOffers({ gpuTypes: spec.gpuTypes, region: spec.region }, credentials);
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

    const body: Record<string, unknown> = {
      name: `ai-gateway-${Date.now()}`,
      environment_name: spec.region || this.defaultRegion || 'CANADA-1',
      image_name: 'Ubuntu Server 22.04 LTS R570 CUDA 12.8',
      flavor_name: chosen.offerId,
      key_name: process.env.HYPERSTACK_KEY_NAME || 'ai-gateway-default',
      count: 1,
      assign_floating_ip: true,
      user_data: this.buildUserData(dockerImage, envVars),
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

    return this.toGpuInstance(final ?? raw);
  }

  private buildUserData(dockerImage: string, env: Record<string, string>): string {
    const envFlags = Object.entries(env)
      .map(([k, v]) => `-e ${shellEscape(k)}=${shellEscape(v)}`)
      .join(' ');
    // Minimal cloud-init: pull image, run with --gpus all, expose 8000.
    const script = `#!/bin/bash\nset -euxo pipefail\ndocker pull ${shellEscape(dockerImage)}\ndocker run -d --gpus all --restart unless-stopped \\\n  -p 8000:8000 -p 8001:8001/udp \\\n  ${envFlags} \\\n  --name ai-gateway-app ${shellEscape(dockerImage)}\n`;
    return script;
  }

  async startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    await this.fetchRaw(
      `${this.apiBase}/core/virtual-machines/${instanceId}/start`,
      { method: 'GET', headers: this.headers(credentials.apiKey) },
      TIMEOUTS.write,
    );
  }

  async stopInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    await this.fetchRaw(
      `${this.apiBase}/core/virtual-machines/${instanceId}/stop`,
      { method: 'GET', headers: this.headers(credentials.apiKey) },
      TIMEOUTS.write,
    );
  }

  async deleteInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    await this.fetchRaw(
      `${this.apiBase}/core/virtual-machines/${instanceId}`,
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
        `${this.apiBase}/core/virtual-machines/${instanceId}`,
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
        `${this.apiBase}/core/virtual-machines/${instanceId}`,
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

  /** Driver 570.195.03 confirmed on H100 PCIe Canada-1 (April 2026). */
  static readonly DEFAULT_DRIVER_MAJOR = 570;
}

function shellEscape(s: string): string {
  // Wrap in single quotes and escape any single quote inside.
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
