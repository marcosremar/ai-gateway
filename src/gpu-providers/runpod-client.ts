import type { GpuInstance, GpuOffer, InstanceSpec, ListOffersOptions, ProviderCredentials } from './types';
import { AbstractGpuProvider, TIMEOUTS } from './abstract-provider';
import type { AbstractGpuProviderOptions } from './abstract-provider';

/** GPU types to try in order of preference.
 *  Must match RunPod's REST API enum values exactly.
 *  RTX 5090 only — fastest for real-time STT/LLM/TTS pipeline.
 *  If unavailable, the gateway falls back to cloud providers (Groq). */
export const RUNPOD_GPU_FALLBACK = [
  'NVIDIA GeForce RTX 5090',
];

/** Full RunPod GPU type names keyed by short display name */
export const RUNPOD_GPU_TYPE_MAP: Record<string, string> = {
  'RTX 3090': 'NVIDIA GeForce RTX 3090',
  'RTX3090': 'NVIDIA GeForce RTX 3090',
  'RTX 4090': 'NVIDIA GeForce RTX 4090',
  'RTX4090': 'NVIDIA GeForce RTX 4090',
  'RTX 5090': 'NVIDIA GeForce RTX 5090',
  'RTX5090': 'NVIDIA GeForce RTX 5090',
  'RTX A5000': 'NVIDIA RTX A5000',
  'RTXA5000': 'NVIDIA RTX A5000',
  'RTX A6000': 'NVIDIA RTX A6000',
  'RTXA6000': 'NVIDIA RTX A6000',
  'A40': 'NVIDIA A40',
  'A100': 'NVIDIA A100 80GB PCIe',
  'H100': 'NVIDIA H100 80GB HBM3',
  // Legacy mappings (GPUs no longer on RunPod — map to cheapest alternative)
  'RTX 4080': 'NVIDIA GeForce RTX 4090',
  'RTX4080': 'NVIDIA GeForce RTX 4090',
  'RTX A4000': 'NVIDIA RTX A5000',
  'RTXA4000': 'NVIDIA RTX A5000',
};

export interface RunpodClientOptions extends AbstractGpuProviderOptions {}

export class RunpodClient extends AbstractGpuProvider {
  readonly providerId = 'runpod';
  /** First cold boot can take 10-20 min (image pull + model download). Max wait = 2x = 40 min. */
  readonly bootTimeSecs = 1200;

  private static readonly API_BASE = 'https://rest.runpod.io/v1';

  constructor(opts?: RunpodClientOptions) {
    super(opts);
  }

  /** RunPod GET requests only need Authorization (no Content-Type). */
  private authHeaders(apiKey: string): Record<string, string> {
    return { Authorization: `Bearer ${apiKey}` };
  }

  private resolveEndpoint(pod: Record<string, unknown>): string {
    const podId = pod.id as string;
    const runtime = pod.runtime as Record<string, unknown> | undefined;
    const runtimePorts = runtime?.ports as Array<Record<string, unknown>> | undefined;
    const runtimeIp = runtimePorts?.[0]?.ip;
    const runtimePort = runtimePorts?.find((p) => p.privatePort === 8000)?.publicPort;
    const topIp = pod.publicIp as string | undefined;
    const portMappings = pod.portMappings as Record<string, number> | undefined;
    const topPort = portMappings?.['8000'];
    return runtimeIp && runtimePort ? `http://${runtimeIp}:${runtimePort}`
      : topIp && topPort ? `http://${topIp}:${topPort}`
      : `https://${podId}-8000.proxy.runpod.net`;
  }

  async discoverInstance(
    credentials: ProviderCredentials,
    _gpuTypes: string[],
  ): Promise<GpuInstance | null> {
    const { apiKey } = credentials;
    try {
      const res = await this.fetchRaw(`${RunpodClient.API_BASE}/pods`, {
        headers: this.authHeaders(apiKey),
      }, TIMEOUTS.read);
      if (!res.ok) {
        this.log.warn(`[runpod] discoverInstance: HTTP ${res.status}`);
        this.emitError({
          operation: 'discoverInstance', message: `HTTP ${res.status}`,
          httpStatus: res.status, retryable: res.status >= 500,
        });
        return null;
      }
      const pods = (await res.json()) as Array<Record<string, unknown>>;
      if (!Array.isArray(pods) || pods.length === 0) return null;

      const running =
        pods.find((p) => p.desiredStatus === 'RUNNING' && p.runtime != null) ??
        pods.find((p) => p.desiredStatus === 'RUNNING') ??
        pods[0];

      const endpoint = this.resolveEndpoint(running);
      return {
        instanceId: running.id as string,
        endpoint,
        status: (running.desiredStatus as string) || 'RUNNING',
      };
    } catch (err) {
      this.log.warn(`[runpod] discoverInstance failed: ${this.errMsg(err)}`);
      this.emitError({
        operation: 'discoverInstance', message: this.errMsg(err), retryable: true,
      });
      return null;
    }
  }

  async createInstance(
    spec: InstanceSpec,
    credentials: ProviderCredentials,
    userId?: string,
  ): Promise<GpuInstance> {
    const { apiKey, hfToken } = credentials;
    const podName = `parle-autoscale-${Date.now()}`;

    // Build env vars: base defaults + auto-detected keys + explicit overrides
    const envVars: Record<string, string> = {
      TORCHINDUCTOR_CUDAGRAPH_TREES: '0',
      ...(hfToken || spec.hfToken ? { HF_TOKEN: hfToken || spec.hfToken! } : {}),
    };
    // Auto-inject CONF_GROQ_API_KEY for ultralight/API-based images
    // (container expects CONF_ prefix via Pydantic Settings env_prefix)
    if (process.env.GROQ_API_KEY) envVars.CONF_GROQ_API_KEY = process.env.GROQ_API_KEY;
    // Merge explicit env overrides from tier config
    if (spec.env) Object.assign(envVars, spec.env);

    // Volume mount: when storageGb > 0, mount at /workspace for model cache persistence.
    // Use HF_HOME env var to redirect HuggingFace cache to the volume — this lets the
    // image's own CMD/ENTRYPOINT run unmodified (no dockerStartCmd override needed).
    // IMPORTANT: Do NOT override dockerStartCmd — it causes crash loops on parle-s2s images.
    const needsVolume = (spec.storageGb ?? 50) > 0;
    if (needsVolume) {
      envVars.HF_HOME = '/workspace/huggingface';
    }

    // Auto-detect container disk size from Docker image when not explicitly configured
    if (!spec.dockerImage) {
      throw new Error('[runpod] spec.dockerImage is required — no default image');
    }
    const imageName = spec.dockerImage;
    let diskGb = spec.storageGb ?? 0;
    if (diskGb <= 0) {
      diskGb = await AbstractGpuProvider.estimateImageDiskGb(imageName, 20);
      this.log.log(`[runpod] Auto-detected disk size for ${imageName}: ${diskGb}GB`);
    }

    const basePodConfig: Record<string, unknown> = {
      name: podName,
      imageName,
      supportPublicIp: true,
      // Container disk: auto-sized from image, minimum 10GB (RunPod requirement).
      // Volume: only for full pipeline images that need model cache persistence.
      containerDiskInGb: Math.max(diskGb, 10),
      volumeInGb: needsVolume ? Math.max(diskGb, 10) : 0,
      ...(needsVolume ? { volumeMountPath: '/workspace' } : {}),
      // IMPORTANT: Do NOT expose the same port on both HTTP and TCP — RunPod's proxy
      // will permanently return 404 if you do. Use HTTP for proxy access, TCP for SSH.
      ports: spec.ports ?? ['8000/http', '22/tcp'],
      env: envVars,
      // Cloud type + spot: defaults to COMMUNITY + interruptible for cost; override for reliability
      cloudType: spec.cloudType ?? 'COMMUNITY',
      interruptible: spec.interruptible ?? true,
      // Region filter: e.g. 'US-TX-3', 'EU-RO-1', 'CA-MTL-1'
      ...(spec.region ? { dataCenterId: spec.region } : {}),
    };

    // ── CPU-only pods ──────────────────────────────────────────────────
    if (spec.computeType === 'CPU') {
      const cpuFlavors = spec.cpuFlavorIds?.length ? spec.cpuFlavorIds : ['cpu3c'];
      const cpuBody = {
        ...basePodConfig,
        computeType: 'CPU',
        cpuFlavorIds: cpuFlavors,
        // vcpuCount controls the number of vCPUs for CPU pods (default 2)
        ...(spec.vcpus ? { vcpuCount: spec.vcpus } : {}),
      };
      // Remove GPU-specific fields that aren't applicable
      delete cpuBody.gpuCount;

      this.log.log(`[runpod] Creating CPU pod (flavors: ${cpuFlavors.join(', ')})...`);

      const res = await this.fetchRaw(`${RunpodClient.API_BASE}/pods`, {
        method: 'POST',
        headers: { ...this.authHeaders(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify(cpuBody),
      }, TIMEOUTS.create);

      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const podId = data.id as string;
        const endpoint = this.resolveEndpoint(data);

        await this.persistInstance(userId, spec.machineKey || 'runpodPod', {
          podId, endpoint, status: 'CREATING', podName,
        });

        this.log.log(`[runpod] Created CPU pod ${podName} (${podId}) → ${endpoint}`);
        return { instanceId: podId, instanceName: podName, endpoint, status: 'CREATING', gpuType: 'CPU' };
      }

      const errText = await res.text().catch(() => '');
      this.log.warn(`[runpod] CPU pod creation failed: HTTP ${res.status} ${errText.substring(0, 300)}`);
      this.emitError({
        operation: 'createInstance', message: `CPU pod creation failed: HTTP ${res.status}`,
        httpStatus: res.status, retryable: res.status >= 500,
      });
      throw new Error(`RunPod CPU pod creation failed: HTTP ${res.status} — ${errText.substring(0, 200)}`);
    }

    // ── GPU pods ───────────────────────────────────────────────────────
    basePodConfig.gpuCount = spec.gpuCount ?? 1;

    const rawGpuTypes = spec.gpuTypes?.length ? spec.gpuTypes : RUNPOD_GPU_FALLBACK;
    // Map short names (e.g. "RTX 3090") to RunPod API names (e.g. "NVIDIA GeForce RTX 3090")
    const gpuTypesToTry = [...new Set(rawGpuTypes.map((t) => RUNPOD_GPU_TYPE_MAP[t] ?? t))];

    const TRANSIENT_RETRY_MAX = 2;
    const TRANSIENT_RETRY_DELAY_MS = 3_000;

    for (const gpuType of gpuTypesToTry) {
      let lastErrText = '';
      let success = false;

      for (let attempt = 0; attempt <= TRANSIENT_RETRY_MAX; attempt++) {
        if (attempt > 0) {
          this.log.log(`[runpod] Retrying create pod with ${gpuType} (attempt ${attempt + 1}/${TRANSIENT_RETRY_MAX + 1})`);
          await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAY_MS * attempt));
        }

        const res = await this.fetchRaw(`${RunpodClient.API_BASE}/pods`, {
          method: 'POST',
          headers: { ...this.authHeaders(apiKey), 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...basePodConfig, gpuTypeIds: [gpuType] }),
        }, TIMEOUTS.create);

        if (res.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          const podId = data.id as string;
          const endpoint = this.resolveEndpoint(data);

          await this.persistInstance(userId, spec.machineKey || 'runpodPod', {
            podId, endpoint, status: 'CREATING', podName,
          });

          this.log.log(`[runpod] Created pod ${podName} (${podId}) with ${gpuType} → ${endpoint}`);
          return { instanceId: podId, instanceName: podName, endpoint, status: 'CREATING', gpuType };
        }

        lastErrText = await res.text().catch(() => '');
        const unavailable = lastErrText.includes('no instances') || lastErrText.includes('unavailable')
          || lastErrText.includes('no longer any instances') || lastErrText.includes('instances available');
        if (unavailable) {
          this.log.log(`[runpod] ${gpuType} unavailable, trying next GPU type...`);
          success = false;
          break; // Don't retry unavailable — no point, move to next GPU type
        }

        // Transient errors (5xx, timeout) — retry
        const isTransient = res.status >= 500 || res.status === 429 || res.status === 0;
        if (isTransient && attempt < TRANSIENT_RETRY_MAX) {
          this.log.warn(`[runpod] Create pod transient error HTTP ${res.status} — will retry`);
          continue;
        }

        this.log.warn(`[runpod] Create pod failed for ${gpuType}: HTTP ${res.status} ${lastErrText.substring(0, 300)}`);
        break;
      }

      if (success) break; // shouldn't reach here (returns inside loop), but safety
    }

    this.emitError({
      operation: 'createInstance', message: 'All GPU types exhausted on RunPod',
      errorCode: 'NO_GPU_AVAILABLE', retryable: false,
    });
    throw new Error('No GPU types available on RunPod (all exhausted)');
  }

  async startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { apiKey } = credentials;
    const res = await this.fetchRaw(`${RunpodClient.API_BASE}/pods/${instanceId}/start`, {
      method: 'POST',
      headers: { ...this.authHeaders(apiKey), 'Content-Type': 'application/json' },
    }, TIMEOUTS.write);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`RunPod start failed: HTTP ${res.status} ${body.substring(0, 300)}`);
    }
  }

  async stopInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { apiKey } = credentials;
    const res = await this.fetchRaw(`${RunpodClient.API_BASE}/pods/${instanceId}/stop`, {
      method: 'POST',
      headers: { ...this.authHeaders(apiKey), 'Content-Type': 'application/json' },
    }, TIMEOUTS.write);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`RunPod stop failed: HTTP ${res.status} ${body.substring(0, 300)}`);
    }
  }

  async deleteInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { apiKey } = credentials;
    const res = await this.fetchRaw(`${RunpodClient.API_BASE}/pods/${instanceId}`, {
      method: 'DELETE',
      headers: this.authHeaders(apiKey),
    }, TIMEOUTS.write);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`RunPod delete failed: HTTP ${res.status} ${body.substring(0, 300)}`);
    }
  }

  async listInstances(credentials: ProviderCredentials): Promise<GpuInstance[]> {
    const { apiKey } = credentials;
    try {
      const res = await this.fetchRaw(`${RunpodClient.API_BASE}/pods`, {
        headers: this.authHeaders(apiKey),
      }, TIMEOUTS.read);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.log.warn(`[runpod] listInstances failed: HTTP ${res.status} ${body.substring(0, 300)}`);
        this.emitError({
          operation: 'listInstances', message: `HTTP ${res.status}`,
          httpStatus: res.status, retryable: res.status >= 500,
        });
        return [];
      }
      const pods = (await res.json()) as Array<Record<string, unknown>>;
      if (!Array.isArray(pods)) return [];
      return pods.map((pod) => {
        const endpoint = this.resolveEndpoint(pod);
        return {
          instanceId: pod.id as string,
          instanceName: pod.name as string | undefined,
          endpoint,
          status: (pod.desiredStatus as string) ?? 'UNKNOWN',
          gpuType: pod.gpuDisplayName as string | undefined,
        };
      });
    } catch (err) {
      this.log.warn(`[runpod] listInstances failed: ${this.errMsg(err)}`);
      this.emitError({
        operation: 'listInstances', message: this.errMsg(err), retryable: true,
      });
      return [];
    }
  }

  async getInstanceStatus(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    try {
      const { apiKey } = credentials;
      const res = await this.fetchRaw(`${RunpodClient.API_BASE}/pods/${instanceId}`, {
        headers: this.authHeaders(apiKey),
      }, TIMEOUTS.read);
      if (res.status === 404) return null;
      if (!res.ok) {
        this.log.warn(`[runpod] getInstanceStatus(${instanceId}): HTTP ${res.status}`);
        this.emitError({
          operation: 'getInstanceStatus', instanceId, message: `HTTP ${res.status}`,
          httpStatus: res.status, retryable: res.status >= 500,
        });
        return null;
      }
      const data = (await res.json()) as Record<string, unknown>;
      // NOTE: REST API v1 only exposes `desiredStatus` (RUNNING/EXITED).
      // RUNNING means "pod is scheduled to run" — the container may still be booting.
      // To check actual container readiness, use HTTP health checks on the proxy URL.
      return (data.desiredStatus as string) ?? null;
    } catch (err) {
      this.log.warn(`[runpod] getInstanceStatus(${instanceId}) failed: ${this.errMsg(err)}`);
      this.emitError({
        operation: 'getInstanceStatus', instanceId, message: this.errMsg(err), retryable: true,
      });
      return null;
    }
  }

  /** Returns the hourly cost for a pod ($/hr), or null if unavailable. */
  async getInstanceCost(instanceId: string, credentials: ProviderCredentials): Promise<number | null> {
    try {
      const { apiKey } = credentials;
      const res = await this.fetchRaw(`${RunpodClient.API_BASE}/pods/${instanceId}`, {
        headers: this.authHeaders(apiKey),
      }, TIMEOUTS.read);
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      const costPerHr = data.costPerHr as number | undefined;
      return costPerHr ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Returns rich pod detail including runtime status.
   * The `runtime` field is null while the container is still starting (image pull / init).
   * Once the container is up, `runtime` contains ports, uptime, and GPU info.
   */
  async getInstanceDetail(instanceId: string, credentials: ProviderCredentials): Promise<{
    desiredStatus: string | null;
    runtime: Record<string, unknown> | null;
    imageName: string | null;
    gpuType: string | null;
    costPerHr: number | null;
    uptimeSecs: number | null;
  } | null> {
    try {
      const { apiKey } = credentials;
      const res = await this.fetchRaw(`${RunpodClient.API_BASE}/pods/${instanceId}`, {
        headers: this.authHeaders(apiKey),
      }, TIMEOUTS.read);
      if (res.status === 404) return null;
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      const runtime = (data.runtime as Record<string, unknown>) ?? null;
      const uptimeSecs = runtime?.uptimeInSeconds as number | null ?? null;
      return {
        desiredStatus: (data.desiredStatus as string) ?? null,
        runtime,
        imageName: (data.imageName as string) ?? null,
        gpuType: (data.machine as Record<string, unknown>)?.gpuDisplayName as string ?? data.gpuType as string ?? null,
        costPerHr: (data.costPerHr as number) ?? null,
        uptimeSecs,
      };
    } catch (err) {
      this.log.warn(`[runpod] getInstanceDetail(${instanceId}) failed: ${this.errMsg(err)}`);
      return null;
    }
  }

  /** Re-resolve endpoint for an existing pod (fetches current publicIp + portMappings). */
  async resolveInstanceEndpoint(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    try {
      const { apiKey } = credentials;
      const res = await this.fetchRaw(`${RunpodClient.API_BASE}/pods/${instanceId}`, {
        headers: this.authHeaders(apiKey),
      }, TIMEOUTS.read);
      if (!res.ok) {
        this.log.warn(`[runpod] resolveInstanceEndpoint(${instanceId}): HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as Record<string, unknown>;
      return this.resolveEndpoint(data);
    } catch (err) {
      this.log.warn(`[runpod] resolveInstanceEndpoint(${instanceId}) failed: ${this.errMsg(err)}`);
      return null;
    }
  }

  /** List available GPU types with real-time pricing from RunPod GraphQL API. */
  async listOffers(options: ListOffersOptions, credentials: ProviderCredentials): Promise<GpuOffer[]> {
    const { apiKey } = credentials;
    try {
      const query = `{ gpuTypes { id displayName memoryInGb communityPrice securePrice stockStatus communitySpotPrice secureSpotPrice } }`;
      const res = await this.fetchRaw('https://api.runpod.io/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query }),
      }, TIMEOUTS.read);

      if (!res.ok) {
        this.log.warn(`[runpod] listOffers GraphQL failed: HTTP ${res.status}`);
        return this._staticOffers(options);
      }

      const data = (await res.json()) as { data?: { gpuTypes?: Array<Record<string, unknown>> } };
      const gpuTypes = data?.data?.gpuTypes;
      if (!Array.isArray(gpuTypes)) return this._staticOffers(options);

      const filterSet = options.gpuTypes?.length
        ? new Set(options.gpuTypes.map(t => (RUNPOD_GPU_TYPE_MAP[t] ?? t).toLowerCase()))
        : null;

      const offers: GpuOffer[] = [];
      for (const gpu of gpuTypes) {
        const displayName = (gpu.displayName || gpu.id || '') as string;
        const fullId = (gpu.id || '') as string;
        const vram = (gpu.memoryInGb || 0) as number;
        const communityPrice = (gpu.communityPrice || 0) as number;
        const stockStatus = (gpu.stockStatus || '') as string;
        const available = stockStatus === 'High' ? 10 : stockStatus === 'Medium' ? 5 : stockStatus === 'Low' ? 1 : 0;

        if (available === 0 && communityPrice === 0) continue;
        if (filterSet && !filterSet.has(fullId.toLowerCase()) && !filterSet.has(displayName.toLowerCase())) continue;

        offers.push({
          provider: 'runpod',
          gpuType: displayName.replace(/\s+/g, '').replace(/^NVIDIA/i, ''),
          gpuName: displayName,
          available,
          pricePerHr: communityPrice,
          region: '',
          vram,
          offerId: fullId,
        });
      }

      return offers
        .sort((a, b) => a.pricePerHr - b.pricePerHr)
        .slice(0, options.limit ?? 100);
    } catch (err) {
      this.log.warn(`[runpod] listOffers failed: ${this.errMsg(err)}`);
      return this._staticOffers(options);
    }
  }

  /** Fallback static offers from RUNPOD_GPU_TYPE_MAP when GraphQL is unreachable. */
  private _staticOffers(options: ListOffersOptions): GpuOffer[] {
    const seen = new Set<string>();
    const offers: GpuOffer[] = [];
    for (const [short, full] of Object.entries(RUNPOD_GPU_TYPE_MAP)) {
      if (seen.has(full)) continue;
      seen.add(full);
      if (options.gpuTypes?.length && !options.gpuTypes.some(t => (RUNPOD_GPU_TYPE_MAP[t] ?? t) === full)) continue;
      offers.push({
        provider: 'runpod',
        gpuType: short,
        gpuName: full,
        available: -1, // unknown
        pricePerHr: 0, // unknown
        region: '',
        vram: 0,
      });
    }
    return offers;
  }
}
