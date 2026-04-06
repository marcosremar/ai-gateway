import type { GpuInstance, GpuOffer, InstanceSpec, ListOffersOptions, ProviderCredentials } from './types';
import { AbstractGpuProvider, TIMEOUTS } from './abstract-provider';
import type { AbstractGpuProviderOptions } from './abstract-provider';

/** GPU types to try in order of preference.
 *  Must match RunPod's REST API enum values exactly.
 *  Tries RTX 5090 first, then falls back to GPUs with spot availability. */
export const RUNPOD_GPU_FALLBACK = [
  'NVIDIA GeForce RTX 5090',
  'NVIDIA GeForce RTX 4090',
  'NVIDIA RTX A6000',
  'NVIDIA L40S',
  'NVIDIA RTX A5000',
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
  'L40S': 'NVIDIA L40S',
  'L40': 'NVIDIA L40',
  'L4': 'NVIDIA L4',
  'H200': 'NVIDIA H200',
  'B200': 'NVIDIA B200',
  'A100': 'NVIDIA A100 80GB PCIe',
  'A100 80GB SXM': 'NVIDIA A100-SXM4-80GB',
  'A100 80GB PCIe': 'NVIDIA A100 80GB PCIe',
  'A100-SXM4-80GB': 'NVIDIA A100-SXM4-80GB',
  'H100': 'NVIDIA H100 80GB HBM3',
  // Legacy mappings (GPUs no longer on RunPod — map to cheapest alternative)
  'RTX 4080': 'NVIDIA GeForce RTX 4090',
  'RTX4080': 'NVIDIA GeForce RTX 4090',
  'RTX A4000': 'NVIDIA RTX A5000',
  'RTXA4000': 'NVIDIA RTX A5000',
};

/**
 * Map generic region codes → RunPod-specific datacenter IDs.
 * RunPod REST API now requires exact datacenter IDs (e.g. 'EU-RO-1') in
 * dataCenterIds[] — generic codes like 'EU' or 'US' are no longer accepted.
 * If a region is already a specific ID (contains '-'), it's used as-is.
 */
const RUNPOD_DATACENTER_MAP: Record<string, string[]> = {
  EU: ['EU-RO-1', 'EU-SE-1', 'EU-CZ-1', 'EU-NL-1', 'EU-FR-1', 'EUR-IS-1', 'EUR-IS-2', 'EUR-IS-3', 'EUR-NO-1'],
  US: ['US-TX-3', 'US-TX-1', 'US-TX-4', 'US-IL-1', 'US-KS-2', 'US-KS-3', 'US-GA-1', 'US-GA-2', 'US-WA-1', 'US-CA-2', 'US-NC-1', 'US-DE-1'],
  CA: ['CA-MTL-1', 'CA-MTL-2', 'CA-MTL-3'],
  AP: ['AP-JP-1'],
  OC: ['OC-AU-1'],
};

/** Resolve a region string to RunPod datacenter IDs.
 * 'EU-RO-1' → ['EU-RO-1']  (already specific)
 * 'EU'      → ['EU-RO-1', 'EU-SE-1', ...]  (expand generic code)
 * ''        → []  (any datacenter)
 */
function resolveDatacenterIds(region: string | undefined): string[] | undefined {
  if (!region) return undefined;
  // Already a specific datacenter ID (e.g. 'EU-RO-1', 'US-TX-3')
  if (region.includes('-')) return [region];
  // Generic region code — expand to all known datacenters
  const ids = RUNPOD_DATACENTER_MAP[region.toUpperCase()];
  if (ids) return ids;
  // Unknown code — omit to avoid schema error (fall back to any datacenter)
  return undefined;
}

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

  /**
   * Fetch with automatic retry on transient errors (5xx, network failures).
   * Returns immediately on 4xx (not transient).
   */
  private async _fetchWithRetry(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    maxRetries = 2,
  ): Promise<Response> {
    const RETRY_DELAY_MS = 2_000;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.rateLimiter.wait();
        const res = await this.fetchRaw(url, init, timeoutMs);
        if (res.status < 500 || attempt >= maxRetries) return res;
        this.log.warn(`[runpod] _fetchWithRetry: HTTP ${res.status} on attempt ${attempt + 1}/${maxRetries + 1}, retrying in ${RETRY_DELAY_MS}ms...`);
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        this.log.warn(`[runpod] _fetchWithRetry: network error on attempt ${attempt + 1}/${maxRetries + 1} (${this.errMsg(err)}), retrying in ${RETRY_DELAY_MS}ms...`);
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  private resolveEndpoint(pod: Record<string, unknown>): string {
    const podId = pod.id as string;
    const runtime = pod.runtime as Record<string, unknown> | undefined;
    const runtimePorts = runtime?.ports as Array<Record<string, unknown>> | undefined;
    const runtimeIp = typeof runtimePorts?.[0]?.ip === 'string' ? runtimePorts[0].ip : undefined;
    const portEntry = runtimePorts?.find((p) => p.privatePort === 8000);
    const runtimePort = typeof portEntry?.publicPort === 'number' ? portEntry.publicPort : undefined;
    const topIp = typeof pod.publicIp === 'string' ? pod.publicIp : undefined;
    const portMappings = pod.portMappings as Record<string, unknown> | undefined;
    const topPort = typeof portMappings?.['8000'] === 'number' ? portMappings['8000'] as number : undefined;
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
      const res = await this._fetchWithRetry(`${RunpodClient.API_BASE}/pods`, {
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
    // NOTE: Do NOT set TORCHINDUCTOR_CUDAGRAPH_TREES=0 — faster-qwen3-tts depends on CUDA
    // graph trees for real-time inference and breaks when they are disabled.
    const envVars: Record<string, string> = {
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
      // Redirect ALL caches/temp to /workspace to prevent container disk from filling up.
      // Container disk (overlay at /) is limited and fills up silently, causing pod EXITED.
      envVars.HF_HOME = '/workspace/huggingface';
      envVars.TMPDIR = '/workspace/tmp';
      envVars.PIP_CACHE_DIR = '/workspace/.pip_cache';
      envVars.TRANSFORMERS_CACHE = '/workspace/huggingface';
    }

    // Auto-detect container disk size from Docker image when not explicitly configured
    if (!spec.dockerImage) {
      throw new Error('[runpod] spec.dockerImage is required — no default image');
    }
    const imageName = spec.dockerImage;
    const { getMinDiskGb } = await import('./deploy-settings');
    let diskGb = spec.storageGb ?? 0;
    if (diskGb <= 0) {
      diskGb = await AbstractGpuProvider.estimateImageDiskGb(imageName, 20);
      this.log.log(`[runpod] Auto-detected disk size for ${imageName}: ${diskGb}GB`);
    }
    diskGb = Math.max(diskGb, getMinDiskGb());

    const basePodConfig: Record<string, unknown> = {
      name: podName,
      imageName,
      supportPublicIp: true,
      // Container disk: auto-sized from image, minimum 10GB (RunPod requirement).
      // Volume: only for full pipeline images that need model cache persistence.
      // Minimum 20GB container disk — 10GB is too tight (pip packages + model cache + temp files
      // can fill it silently, causing pod EXITED after ~5-8min).
      containerDiskInGb: spec.computeType === 'CPU'
        ? Math.min(spec.containerDiskInGb || 10, 10)   // CPU pods: max 10GB
        : spec.containerDiskInGb ? Math.max(spec.containerDiskInGb, 20) : Math.max(diskGb, 20),
      // Network volume: when volumeId is provided, attach it instead of creating ephemeral storage.
      // This lets LLM GGUFs (~7-12GB) persist across pod restarts, eliminating re-download on cold boot.
      ...(spec.volumeId
        ? { networkVolumeId: spec.volumeId, volumeMountPath: '/workspace' }
        : {
            volumeInGb: needsVolume ? Math.max(diskGb, 10) : 0,
            ...(needsVolume ? { volumeMountPath: '/workspace' } : {}),
          }),
      // IMPORTANT: Do NOT expose the same port on both HTTP and TCP — RunPod's proxy
      // will permanently return 404 if you do. Use HTTP for proxy access, TCP for SSH.
      // HTTP for proxy access, TCP for SSH, UDP for WebRTC media (STUN/TURN range)
      ports: spec.ports ?? ['8000/http', '22/tcp', '8001/udp'],
      env: envVars,
      // IMPORTANT: ALWAYS use SECURE cloud. NEVER use COMMUNITY — community machines are
      // unreliable third-party hardware that dies mid-task (pods exit after ~8min, CDI GPU errors,
      // OOM, etc.). Secure Cloud uses RunPod's own verified servers.
      cloudType: 'SECURE',
      // On-demand by default (reliable). Set interruptible=true for spot (cheaper but can be interrupted).
      interruptible: spec.interruptible ?? false,
      // Region filter: generic codes ('EU','US') are expanded to specific datacenter IDs.
      // RunPod REST API requires exact IDs (e.g. 'EU-RO-1') — generic codes cause HTTP 400.
      ...(() => { const ids = resolveDatacenterIds(spec.region); return ids ? { dataCenterIds: ids } : {}; })(),
      // Custom start command (overrides Docker CMD/ENTRYPOINT)
      ...(spec.dockerStartCmd ? { dockerStartCmd: Array.isArray(spec.dockerStartCmd) ? spec.dockerStartCmd : ['bash', '-c', spec.dockerStartCmd] } : {}),
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
      delete (cpuBody as Record<string, unknown>).gpuCount;

      this.log.log(`[runpod] Creating CPU pod (flavors: ${cpuFlavors.join(', ')})...`);

      await this.rateLimiter.wait();
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

    const requestedSpot = basePodConfig.interruptible === true;

    // Track per-GPU failure reasons for diagnostics
    const gpuFailures: Array<{ gpu: string; status: number; reason: string }> = [];

    for (const gpuType of gpuTypesToTry) {
      let lastErrText = '';
      let success = false;

      for (let attempt = 0; attempt <= TRANSIENT_RETRY_MAX; attempt++) {
        if (attempt > 0) {
          this.log.log(`[runpod] Retrying create pod with ${gpuType} (attempt ${attempt + 1}/${TRANSIENT_RETRY_MAX + 1})`);
          await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAY_MS * attempt));
        }

        await this.rateLimiter.wait();
        const res = await this.fetchRaw(`${RunpodClient.API_BASE}/pods`, {
          method: 'POST',
          headers: { ...this.authHeaders(apiKey), 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...basePodConfig, gpuTypeIds: [gpuType] }),
        }, TIMEOUTS.create);

        if (res.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          const podId = data.id as string;
          const endpoint = this.resolveEndpoint(data);

          // ── Ghost machine detection ─────────────────────────────────────
          // RunPod may return HTTP 200 with a machine object, but then silently
          // fail to schedule the pod (machine becomes {} within seconds). This
          // happens when no physical machine can satisfy the storage/GPU request.
          // Poll the pod after a short delay to verify the machine was actually assigned.
          const GHOST_CHECK_DELAY_MS = 10_000;
          const GHOST_CHECK_RETRIES = 3;
          let ghostDetected = false;
          for (let gc = 0; gc < GHOST_CHECK_RETRIES; gc++) {
            await new Promise((r) => setTimeout(r, GHOST_CHECK_DELAY_MS));
            try {
              const checkRes = await this._fetchWithRetry(`${RunpodClient.API_BASE}/pods/${podId}`, {
                headers: this.authHeaders(apiKey),
              }, TIMEOUTS.read);
              if (checkRes.ok) {
                const pod = (await checkRes.json()) as Record<string, unknown>;
                const machine = pod.machine as Record<string, unknown> | undefined;
                const hasMachine = machine && Object.keys(machine).length > 0;
                const runtime = pod.runtime as Record<string, unknown> | undefined;
                if (hasMachine || runtime) {
                  // Machine still assigned or container already running — good
                  this.log.log(`[runpod] Post-create check: pod ${podId} machine assigned ✓`);
                  ghostDetected = false;
                  break;
                }
                this.log.warn(`[runpod] Post-create check ${gc + 1}/${GHOST_CHECK_RETRIES}: pod ${podId} has empty machine{} (ghost assignment)`);
                ghostDetected = true;
              }
            } catch {
              // Network error during check — don't treat as ghost, proceed normally
              ghostDetected = false;
              break;
            }
          }

          if (ghostDetected) {
            // Delete the ghost pod and try next GPU type
            this.log.warn(`[runpod] Ghost machine detected for ${gpuType} — pod ${podId} created but no machine assigned. Deleting and trying next GPU.`);
            this.emitError({
              operation: 'createInstance', instanceId: podId,
              message: `Ghost machine: pod created with ${gpuType} but machine became empty (no physical machine available for requested config: disk=${basePodConfig.containerDiskInGb}GB, volume=${basePodConfig.volumeInGb ?? 0}GB)`,
              errorCode: 'GHOST_MACHINE', retryable: true,
              metadata: { gpuType, containerDiskInGb: basePodConfig.containerDiskInGb, volumeInGb: basePodConfig.volumeInGb },
            });
            try {
              await this.fetchRaw(`${RunpodClient.API_BASE}/pods/${podId}`, {
                method: 'DELETE', headers: this.authHeaders(apiKey),
              }, TIMEOUTS.write);
            } catch { /* best effort cleanup */ }
            gpuFailures.push({ gpu: gpuType, status: 200, reason: 'ghost machine — created but no physical machine assigned' });
            break; // Move to next GPU type
          }

          await this.persistInstance(userId, spec.machineKey || 'runpodPod', {
            podId, endpoint, status: 'CREATING', podName,
          });

          const mode = basePodConfig.interruptible ? 'spot' : 'on-demand';
          this.log.log(`[runpod] Created ${mode} pod ${podName} (${podId}) with ${gpuType} → ${endpoint}`);
          return { instanceId: podId, instanceName: podName, endpoint, status: 'CREATING', gpuType };
        }

        lastErrText = await res.text().catch(() => '');
        const noSpotPrice = lastErrText.includes('No spot price found') || lastErrText.includes('no spot price');
        const unavailable = lastErrText.includes('no instances') || lastErrText.includes('unavailable')
          || lastErrText.includes('no longer any instances') || lastErrText.includes('instances available');
        const balanceTooLow = lastErrText.includes('balance is too low') || lastErrText.includes('add funds');

        // Insufficient balance — no point retrying or trying other GPUs
        if (balanceTooLow) {
          this.log.error(`[runpod] Account balance too low — cannot create any pods`);
          gpuFailures.push({ gpu: gpuType, status: res.status, reason: `balance too low` });
          throw new Error(`RunPod account balance too low to rent a pod. Please add funds.`);
        }

        // If spot was requested but no spot price exists, auto-fallback to on-demand for this GPU type
        if (noSpotPrice && basePodConfig.interruptible) {
          this.log.log(`[runpod] No spot pricing for ${gpuType} — falling back to on-demand`);
          basePodConfig.interruptible = false;
          // Retry immediately with on-demand (don't count as a retry attempt)
          await this.rateLimiter.wait();
          const odRes = await this.fetchRaw(`${RunpodClient.API_BASE}/pods`, {
            method: 'POST',
            headers: { ...this.authHeaders(apiKey), 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...basePodConfig, gpuTypeIds: [gpuType] }),
          }, TIMEOUTS.create);
          // Restore original spot setting for next GPU type
          basePodConfig.interruptible = true;

          if (odRes.ok) {
            const data = (await odRes.json()) as Record<string, unknown>;
            const podId = data.id as string;
            const endpoint = this.resolveEndpoint(data);
            await this.persistInstance(userId, spec.machineKey || 'runpodPod', {
              podId, endpoint, status: 'CREATING', podName,
            });
            this.log.log(`[runpod] Created on-demand pod ${podName} (${podId}) with ${gpuType} → ${endpoint}`);
            return { instanceId: podId, instanceName: podName, endpoint, status: 'CREATING', gpuType };
          }
          const odErrText = await odRes.text().catch(() => '');
          const odBalanceLow = odErrText.includes('balance is too low') || odErrText.includes('add funds');
          if (odBalanceLow) {
            this.log.error(`[runpod] Account balance too low — cannot create any pods`);
            gpuFailures.push({ gpu: gpuType, status: odRes.status, reason: `balance too low` });
            throw new Error(`RunPod account balance too low to rent a pod. Please add funds.`);
          }
          this.log.log(`[runpod] On-demand fallback also failed for ${gpuType}: ${odErrText.substring(0, 120)}`);
          gpuFailures.push({ gpu: gpuType, status: odRes.status, reason: `spot→on-demand fallback: ${odErrText.substring(0, 150)}` });
          break; // Move to next GPU type
        }

        if (unavailable || noSpotPrice) {
          this.log.log(`[runpod] ${gpuType} unavailable (${lastErrText.substring(0, 120)}), trying next GPU type...`);
          gpuFailures.push({ gpu: gpuType, status: res.status, reason: `unavailable: ${lastErrText.substring(0, 150)}` });
          success = false;
          break; // Don't retry unavailable — no point, move to next GPU type
        }

        // Transient errors (5xx, timeout) — retry only if body doesn't reveal a permanent issue
        const isTransient = res.status >= 500 || res.status === 429 || res.status === 0;
        const bodyRevealsPermanent = lastErrText.includes('balance') || lastErrText.includes('funds')
          || lastErrText.includes('unauthorized') || lastErrText.includes('forbidden');
        if (isTransient && !bodyRevealsPermanent && attempt < TRANSIENT_RETRY_MAX) {
          this.log.warn(`[runpod] Create pod transient error HTTP ${res.status} — will retry`);
          continue;
        }

        this.log.warn(`[runpod] Create pod failed for ${gpuType}: HTTP ${res.status} ${lastErrText.substring(0, 1000)}`);
        gpuFailures.push({ gpu: gpuType, status: res.status, reason: `HTTP ${res.status}: ${lastErrText.substring(0, 150)}` });
        break;
      }

      if (success) break; // shouldn't reach here (returns inside loop), but safety
    }

    // Log detailed per-GPU failure summary for diagnostics
    const failSummary = gpuFailures.map(f => `${f.gpu} → ${f.reason}`).join(' | ');
    this.log.error(`[runpod] All ${gpuTypesToTry.length} GPU types exhausted. Failures: ${failSummary}`);

    this.emitError({
      operation: 'createInstance', message: `All GPU types exhausted on RunPod: ${failSummary}`,
      errorCode: 'NO_GPU_AVAILABLE', retryable: false,
    });
    throw new Error(`No GPU types available on RunPod (all exhausted). Tried ${gpuTypesToTry.length} types: ${failSummary}`);
  }

  async startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { apiKey } = credentials;
    await this.rateLimiter.wait();
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
    await this.rateLimiter.wait();
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
    await this.rateLimiter.wait();
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
      const res = await this._fetchWithRetry(`${RunpodClient.API_BASE}/pods`, {
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
      const res = await this._fetchWithRetry(`${RunpodClient.API_BASE}/pods/${instanceId}`, {
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

  /** Returns the hourly cost for a pod ($/hr), or null if unavailable.
   *  Also logs the estimated total cost based on actual runtime. */
  async getInstanceCost(instanceId: string, credentials: ProviderCredentials): Promise<number | null> {
    try {
      const { apiKey } = credentials;
      await this.rateLimiter.wait();
      const res = await this.fetchRaw(`${RunpodClient.API_BASE}/pods/${instanceId}`, {
        headers: this.authHeaders(apiKey),
      }, TIMEOUTS.read);
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      const costPerHr = data.costPerHr as number | undefined;
      if (costPerHr == null) return null;

      // Calculate and log estimated total cost from actual runtime
      const runtime = data.runtime as Record<string, unknown> | undefined;
      const uptimeSeconds = (runtime?.uptimeInSeconds as number) ?? null;
      if (uptimeSeconds != null && uptimeSeconds > 0) {
        const estimatedTotalCost = costPerHr * (uptimeSeconds / 3600);
        this.log.log(
          `[runpod] Pod ${instanceId}: $${costPerHr.toFixed(4)}/hr × ${(uptimeSeconds / 3600).toFixed(2)}h uptime = ~$${estimatedTotalCost.toFixed(4)} estimated total`,
        );
      }

      return costPerHr;
    } catch (e) {
      this.log.debug(`[runpod] getInstanceCost(${instanceId}) failed: ${this.errMsg(e)}`);
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
    /** True when desiredStatus=RUNNING but machine={} and runtime=null — pod is stuck. */
    ghostMachine: boolean;
  } | null> {
    try {
      const { apiKey } = credentials;
      await this.rateLimiter.wait();
      const res = await this.fetchRaw(`${RunpodClient.API_BASE}/pods/${instanceId}`, {
        headers: this.authHeaders(apiKey),
      }, TIMEOUTS.read);
      if (res.status === 404) return null;
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      const runtime = (data.runtime as Record<string, unknown>) ?? null;
      const uptimeSecs = runtime?.uptimeInSeconds as number | null ?? null;
      const machine = data.machine as Record<string, unknown> | undefined;
      const hasMachine = machine && Object.keys(machine).length > 0;
      const desiredStatus = (data.desiredStatus as string) ?? null;

      // Ghost machine: pod wants to run but has no machine and no runtime.
      // This means RunPod accepted the request but couldn't schedule it.
      const ghostMachine = desiredStatus === 'RUNNING' && !hasMachine && !runtime;
      if (ghostMachine) {
        this.log.warn(`[runpod] getInstanceDetail(${instanceId}): ghost machine detected — RUNNING but machine={} and runtime=null`);
        this.emitError({
          operation: 'getInstanceDetail', instanceId,
          message: `Ghost machine: pod ${instanceId} is RUNNING but has no machine assigned and no runtime`,
          errorCode: 'GHOST_MACHINE', retryable: false,
        });
      }

      return {
        desiredStatus,
        runtime,
        imageName: (data.imageName as string) ?? null,
        gpuType: (data.machine as Record<string, unknown>)?.gpuDisplayName as string ?? data.gpuType as string ?? null,
        costPerHr: (data.costPerHr as number) ?? null,
        uptimeSecs,
        ghostMachine,
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
      const res = await this._fetchWithRetry(`${RunpodClient.API_BASE}/pods/${instanceId}`, {
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

  /** Check account balance via RunPod GraphQL API. Returns balance in USD or null on failure. */
  async checkBalance(credentials: ProviderCredentials): Promise<{ balance: number } | null> {
    const { apiKey } = credentials;
    try {
      await this.rateLimiter.wait();
      const res = await this.fetchRaw('https://api.runpod.io/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query: '{ myself { currentSpendPerHr creditBalance } }' }),
      }, 5_000);
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: { myself?: { creditBalance?: number; currentSpendPerHr?: number } } };
      const balance = data?.data?.myself?.creditBalance;
      return typeof balance === 'number' ? { balance } : null;
    } catch (e) {
      this.log.debug(`[runpod] checkBalance failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** List available GPU types with real-time pricing from RunPod GraphQL API. */
  async listOffers(options: ListOffersOptions, credentials: ProviderCredentials): Promise<GpuOffer[]> {
    const { apiKey } = credentials;
    try {
      const query = `{ gpuTypes { id displayName memoryInGb communityPrice securePrice communitySpotPrice secureSpotPrice } }`;
      await this.rateLimiter.wait();
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

      // Whitelist GPU types through the known mapping to prevent arbitrary strings
      const filterSet = options.gpuTypes?.length
        ? new Set(options.gpuTypes.flatMap(t => {
            const mapped = RUNPOD_GPU_TYPE_MAP[t] ?? (RUNPOD_GPU_FALLBACK.includes(t) ? t : null);
            return mapped ? [mapped.toLowerCase()] : [t.toLowerCase()]; // pass-through if not in map but still filter
          }))
        : null;

      const offers: GpuOffer[] = [];
      for (const gpu of gpuTypes) {
        const displayName = (gpu.displayName || gpu.id || '') as string;
        const fullId = (gpu.id || '') as string;
        const vram = (gpu.memoryInGb || 0) as number;
        // IMPORTANT: Use SECURE pricing only — NEVER use community machines (unreliable third-party hardware)
        const securePrice = (gpu.securePrice || 0) as number;
        const secureSpotPrice = (gpu.secureSpotPrice || 0) as number;
        // stockStatus was removed from RunPod GraphQL API — infer from price
        const available = securePrice > 0 ? -1 : 0;

        if (securePrice === 0) continue;  // Skip GPUs not available on Secure Cloud
        if (filterSet && !filterSet.has(fullId.toLowerCase()) && !filterSet.has(displayName.toLowerCase())) continue;

        offers.push({
          provider: 'runpod',
          gpuType: fullId,    // Full RunPod API name (e.g. "NVIDIA RTX A5000") — matches allowlist and createPod
          gpuName: fullId,    // Use fullId so it matches ALLOWED_GPU_TYPES format
          available,
          pricePerHr: securePrice,
          spotPricePerHr: secureSpotPrice,
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
