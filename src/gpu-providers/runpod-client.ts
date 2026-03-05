import type { GpuInstance, InstanceSpec, ProviderCredentials } from './types';
import { AbstractGpuProvider, TIMEOUTS } from './abstract-provider';
import type { AbstractGpuProviderOptions } from './abstract-provider';

/** GPU types to try in order of preference (cheapest first).
 *  Must match RunPod's REST API enum values exactly.
 *  Pricing (approx): A5000 $0.16/h → 3090 $0.22/h → A6000 $0.33/h → 4090 $0.34/h → A40 $0.35/h */
export const RUNPOD_GPU_FALLBACK = [
  'NVIDIA RTX A5000',
  'NVIDIA GeForce RTX 3090',
  'NVIDIA RTX A6000',
  'NVIDIA GeForce RTX 4090',
  'NVIDIA A40',
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
    // Auto-inject GROQ_API_KEY for ultralight/API-based images
    if (process.env.GROQ_API_KEY) envVars.GROQ_API_KEY = process.env.GROQ_API_KEY;
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
    const basePodConfig: Record<string, unknown> = {
      name: podName,
      imageName: spec.dockerImage || 'marcosremar/parle-s2s:latest',
      gpuCount: spec.gpuCount ?? 1,
      supportPublicIp: true,
      // Container disk: minimum 10GB even for lightweight (RunPod requires it).
      // Volume: only for full pipeline images that need model cache persistence.
      containerDiskInGb: Math.max(spec.storageGb ?? 50, 10),
      volumeInGb: needsVolume ? (spec.storageGb ?? 50) : 0,
      ...(needsVolume ? { volumeMountPath: '/workspace' } : {}),
      // IMPORTANT: Do NOT expose the same port on both HTTP and TCP — RunPod's proxy
      // will permanently return 404 if you do. Use HTTP for proxy access, TCP for SSH.
      ports: ['8000/http', '22/tcp'],
      env: envVars,
    };

    const rawGpuTypes = spec.gpuTypes?.length ? spec.gpuTypes : RUNPOD_GPU_FALLBACK;
    // Map short names (e.g. "RTX 3090") to RunPod API names (e.g. "NVIDIA GeForce RTX 3090")
    const gpuTypesToTry = [...new Set(rawGpuTypes.map((t) => RUNPOD_GPU_TYPE_MAP[t] ?? t))];

    for (const gpuType of gpuTypesToTry) {
      const res = await this.fetchRaw(`${RunpodClient.API_BASE}/pods`, {
        method: 'POST',
        headers: { ...this.authHeaders(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...basePodConfig, gpuTypeIds: [gpuType] }),
      }, TIMEOUTS.create);

      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const podId = data.id as string;
        const endpoint = this.resolveEndpoint(data);

        // Use the proxy URL as-is — it's the reliable way to reach the pod.
        // Direct IPs (from publicIp/portMappings) may not be reachable from
        // all networks. The proxy URL always works once the pod is running.

        await this.persistInstance(userId, spec.machineKey || 'runpodPod', {
          podId, endpoint, status: 'CREATING', podName,
        });

        this.log.log(`[runpod] Created pod ${podName} (${podId}) with ${gpuType} → ${endpoint}`);
        return { instanceId: podId, instanceName: podName, endpoint, status: 'CREATING', gpuType };
      }

      const errText = await res.text().catch(() => '');
      const unavailable = errText.includes('no instances') || errText.includes('unavailable');
      if (unavailable) {
        this.log.log(`[runpod] ${gpuType} unavailable, trying next...`);
        continue;
      }
      this.log.warn(`[runpod] Create pod failed: HTTP ${res.status} ${errText.substring(0, 300)}`);
    }

    throw new Error('Nenhum GPU type disponível no RunPod (todos esgotados)');
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
        return null;
      }
      const data = (await res.json()) as Record<string, unknown>;
      // NOTE: REST API v1 only exposes `desiredStatus` (RUNNING/EXITED).
      // RUNNING means "pod is scheduled to run" — the container may still be booting.
      // To check actual container readiness, use HTTP health checks on the proxy URL.
      return (data.desiredStatus as string) ?? null;
    } catch (err) {
      this.log.warn(`[runpod] getInstanceStatus(${instanceId}) failed: ${this.errMsg(err)}`);
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
}
