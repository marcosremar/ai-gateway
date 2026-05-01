/**
 * SnapgpuClient — wrapper provider that delivers fast cold starts via
 * CRIU + cuda-checkpoint snapshots on top of cheaper backend providers
 * (Vast.ai or RunPod).
 *
 * Architecture:
 *   This client doesn't talk to its own GPU API. It delegates create/start/
 *   stop/delete/listInstances to an underlying provider client (Vast or
 *   RunPod), but FORCES the snapgpu-runtime Docker image and exposes
 *   snapshot-related operations via HTTP to the snapgpu-gateway running
 *   inside the deployed container.
 *
 * Why a wrapper instead of a fresh provider:
 *   snapgpu has no hardware. It's a *capability layer* — snapshots that
 *   shrink cold boot from 2 min → 2-5 s — that runs ON TOP of any GPU
 *   host with NVIDIA driver 570+. The wrapper lets the user keep paying
 *   Vast.ai prices while gaining Modal-class cold starts.
 *
 * Boot lifecycle controlled by the autoscaler:
 *   1. createInstance() → underlying.createInstance() with snapgpu image
 *   2. /health goes 200 → snapgpu-gateway is up
 *   3. POST /v1/apps registers the app spec
 *   4. POST /v1/invoke/{app}/{fn} runs first inference (loads model)
 *   5. POST /v1/snapshots captures CPU+GPU state
 *   6. Future cold boots restore from that snapshot in seconds
 *
 * The snapshot ID is persisted via the onInstancePersist hook so the next
 * deploy can find it via listSnapshots().
 */

import type {
  GpuInstance,
  InstanceSpec,
  ProviderCredentials,
} from './types';
import { AbstractGpuProvider, TIMEOUTS } from './abstract-provider';
import type { AbstractGpuProviderOptions } from './abstract-provider';
import type { GpuProviderRegistry } from './registry';
import type { B2StoreConfig } from '../../../storage/b2-store';
import type { R2StoreConfig } from '../../../storage/r2-store';
import type { S3StoreConfig } from '../../../storage/s3-store';

/** Default Docker image for the snapgpu-runtime base. Override per tier in spec.dockerImage. */
export const DEFAULT_SNAPGPU_IMAGE =
  process.env.SNAPGPU_DEFAULT_IMAGE || 'marcosremar/snapgpu-runtime:latest';

/** Backend providers snapgpu can sit on top of. */
export type SnapgpuBackend = 'vast' | 'runpod';

/**
 * Low-level S3 config for checkpoint persistence (raw endpoint + credentials).
 * Prefer passing a `B2StoreConfig`, `R2StoreConfig`, or `S3StoreConfig` directly
 * — those are the native types already used by the rest of the app via
 * `@parle/ai-gateway/object-storage`.
 */
export interface SnapgpuS3Config {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
  keyPrefix?: string;
}

/**
 * Any S3-compatible config accepted by `SnapgpuClientOptions.s3Config`.
 * Accepts the native object-storage config types (B2StoreConfig, R2StoreConfig,
 * S3StoreConfig) as well as the raw SnapgpuS3Config for manual overrides.
 */
export type SnapgpuS3Input =
  | SnapgpuS3Config
  | B2StoreConfig
  | R2StoreConfig
  | S3StoreConfig;

/**
 * Normalise any S3 input type to the flat SnapgpuS3Config that gets injected
 * as env vars into the container. Detects the input shape via discriminating
 * fields: keyId → B2, accountId → R2, accessKeyId → generic S3, otherwise
 * treat as SnapgpuS3Config passthrough.
 */
export function normalizeSnapgpuS3Config(cfg: SnapgpuS3Input): SnapgpuS3Config {
  if ('keyId' in cfg) {
    // B2StoreConfig
    return {
      endpoint: cfg.endpoint ?? `https://s3.${cfg.region}.backblazeb2.com`,
      bucket: cfg.bucket,
      accessKey: cfg.keyId,
      secretKey: cfg.applicationKey,
      region: cfg.region,
    };
  }
  if ('accountId' in cfg) {
    // R2StoreConfig
    return {
      endpoint: cfg.endpoint ?? `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      bucket: cfg.bucket,
      accessKey: cfg.accessKeyId,
      secretKey: cfg.secretAccessKey,
      region: 'auto',
    };
  }
  if ('accessKeyId' in cfg) {
    // S3StoreConfig
    return {
      endpoint: cfg.endpoint,
      bucket: cfg.bucket,
      accessKey: cfg.accessKeyId,
      secretKey: cfg.secretAccessKey,
      region: cfg.region,
    };
  }
  // SnapgpuS3Config — already in the right shape
  return cfg as SnapgpuS3Config;
}

export interface SnapgpuClientOptions extends AbstractGpuProviderOptions {
  /** Registry used to look up the backend provider (vast/runpod). Required. */
  registry: GpuProviderRegistry;
  /** Default backend when spec.snapgpuBackend is not set. */
  defaultBackend?: SnapgpuBackend;
  /**
   * S3 config for checkpoint persistence. When set, snapshots are automatically
   * uploaded to S3 after creation and downloaded on new worker boots.
   * Can also be provided per-instance via spec.snapgpuS3Config.
   *
   * Accepts the same config types used by `@parle/ai-gateway/object-storage`:
   *   - `B2StoreConfig`  — Backblaze B2 (recommended: free egress, cheap storage)
   *   - `R2StoreConfig`  — Cloudflare R2 (free egress)
   *   - `S3StoreConfig`  — any S3-compatible service (AWS, MinIO, etc.)
   *   - `SnapgpuS3Config` — raw endpoint + credentials (manual override)
   */
  s3Config?: SnapgpuS3Input;
}

/**
 * Snapshot metadata returned by snapgpu-gateway /v1/snapshots routes.
 * Mirrors gateway/db.py SnapshotModel.
 */
export interface SnapshotInfo {
  snapshot_id: string;
  app_name: string;
  function_name?: string | null;
  class_name?: string | null;
  image_tag: string;
  size_bytes: number;
  gpu_memory_included: boolean;
  created_at: string;
}

export class SnapgpuClient extends AbstractGpuProvider {
  readonly providerId = 'snapgpu';
  /** snapgpu cold boot includes the underlying provider's pull + the snapgpu
   *  gateway start. With pre-baked images on Vast.ai, expect ~90-120 s on first
   *  boot. After the first snapshot, subsequent boots run ~5-10 s. */
  readonly bootTimeSecs = parseInt(process.env.SNAPGPU_BOOT_TIME_SECS || '120', 10);

  private readonly registry: GpuProviderRegistry;
  private readonly defaultBackend: SnapgpuBackend;
  private readonly s3Config?: SnapgpuS3Config;

  constructor(opts: SnapgpuClientOptions) {
    super(opts);
    this.registry = opts.registry;
    this.defaultBackend = opts.defaultBackend ?? 'vast';
    this.s3Config = opts.s3Config ? normalizeSnapgpuS3Config(opts.s3Config) : undefined;
  }

  /**
   * Resolve the underlying provider for this spec. Falls back to the
   * configured default. Throws if the chosen backend isn't registered.
   */
  private _backend(spec: InstanceSpec): { provider: AbstractGpuProvider; backendId: SnapgpuBackend } {
    const backendId = (spec.snapgpuBackend as SnapgpuBackend | undefined) ?? this.defaultBackend;
    const client = this.registry.get(backendId);
    if (!client) {
      throw new Error(
        `[snapgpu] backend "${backendId}" is not registered. Register a VastClient/RunpodClient before using SnapgpuClient.`,
      );
    }
    return { provider: client as AbstractGpuProvider, backendId };
  }

  /**
   * Override of preflight: delegate to the underlying provider so quota/balance
   * checks still apply. (Snapgpu itself doesn't have an account.)
   */
  async preflight(credentials: ProviderCredentials): Promise<{
    canDeploy: boolean;
    blockReason: string | null;
    balance?: number;
    quota?: number;
  } | null> {
    // Default backend is used for the preflight; spec is unavailable here.
    const client = this.registry.get(this.defaultBackend);
    if (!client) return null;
    return (client as AbstractGpuProvider).preflight(credentials);
  }

  /**
   * Discover an existing snapgpu instance. Just delegates to the backend
   * — there's nothing snapgpu-specific to discover.
   */
  async discoverInstance(
    credentials: ProviderCredentials,
    gpuTypes: string[],
  ): Promise<GpuInstance | null> {
    const backend = this.registry.get(this.defaultBackend);
    if (!backend) return null;
    return backend.discoverInstance(credentials, gpuTypes);
  }

  async createInstance(
    spec: InstanceSpec,
    credentials: ProviderCredentials,
    userId?: string,
  ): Promise<GpuInstance> {
    const { provider, backendId } = this._backend(spec);

    // Force the snapgpu-runtime image. The user's original dockerImage is
    // either an app-specific child of snapgpu-runtime (e.g.
    // marcosremar/snapgpu-runtime-babelcast) or unset (use base).
    const dockerImage = spec.dockerImage ?? DEFAULT_SNAPGPU_IMAGE;

    // Inject snapgpu-specific env so the gateway control plane knows what
    // to preload. The downstream provider passes these through unchanged.
    const env: Record<string, string> = {
      ...spec.env,
      SNAPGPU_PORT: '8000',
    };
    if (spec.snapgpuPreloadApp) {
      env.SNAPGPU_PRELOAD_APP = spec.snapgpuPreloadApp;
      env.SNAPGPU_APP_NAME = spec.snapgpuPreloadApp;
    }
    if (spec.snapgpuRestoreFromSnapshot) {
      env.SNAPGPU_RESTORE_SNAPSHOT_ID = spec.snapgpuRestoreFromSnapshot;
    }

    // Inject S3 credentials so the container can upload/download checkpoints
    // automatically. Priority: spec-level config > client-level config > env vars.
    const s3 = (spec as Record<string, unknown>).snapgpuS3Config as SnapgpuS3Config | undefined
      ?? this.s3Config
      ?? (process.env.SNAPGPU_S3_ENDPOINT ? {
        endpoint: process.env.SNAPGPU_S3_ENDPOINT,
        bucket: process.env.SNAPGPU_S3_BUCKET ?? '',
        accessKey: process.env.SNAPGPU_S3_ACCESS_KEY ?? '',
        secretKey: process.env.SNAPGPU_S3_SECRET_KEY ?? '',
        region: process.env.SNAPGPU_S3_REGION,
        keyPrefix: process.env.SNAPGPU_S3_KEY_PREFIX,
      } : undefined);

    if (s3?.endpoint && s3.bucket && s3.accessKey && s3.secretKey) {
      env.SNAPGPU_S3_ENDPOINT = s3.endpoint;
      env.SNAPGPU_S3_BUCKET = s3.bucket;
      env.SNAPGPU_S3_ACCESS_KEY = s3.accessKey;
      env.SNAPGPU_S3_SECRET_KEY = s3.secretKey;
      if (s3.region) env.SNAPGPU_S3_REGION = s3.region;
      if (s3.keyPrefix) env.SNAPGPU_S3_KEY_PREFIX = s3.keyPrefix;
      this.log.log(`[snapgpu] S3 checkpoint persistence enabled → ${s3.endpoint}/${s3.bucket}`);
    }

    // Snapgpu needs port 8000 exposed for the FastAPI control plane.
    // We don't override the user's ports list if they set it explicitly,
    // but we make sure 8000/http is in there.
    const ports = spec.ports ? [...spec.ports] : ['8000/http', '22/tcp'];
    if (!ports.some((p) => p.startsWith('8000/'))) ports.unshift('8000/http');

    this.log.log(
      `[snapgpu] createInstance via backend=${backendId}, image=${dockerImage}, preload=${spec.snapgpuPreloadApp ?? 'none'}`,
    );

    const result = await provider.createInstance(
      { ...spec, dockerImage, env, ports },
      credentials,
      userId,
    );

    // Annotate the instance so downstream code knows snapgpu is in play.
    return {
      ...result,
      providerMeta: {
        // Spread backend metadata first, then override with snapgpu-specific
        // fields. This preserves host details (reliability, inetDown, etc.)
        // while ensuring `provider` is always 'snapgpu'.
        ...(result.providerMeta ?? {}),
        provider: 'snapgpu',
        backendProvider: backendId,
        snapgpuImage: dockerImage,
      },
    };
  }

  async startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    // No spec available here — use default backend. Callers that resume across
    // backends should pass a spec via createInstance to set the backend up front.
    const backend = this.registry.getOrThrow(this.defaultBackend);
    return backend.startInstance(instanceId, credentials);
  }

  async stopInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const backend = this.registry.getOrThrow(this.defaultBackend);
    return backend.stopInstance(instanceId, credentials);
  }

  async deleteInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const backend = this.registry.getOrThrow(this.defaultBackend);
    return backend.deleteInstance(instanceId, credentials);
  }

  async getInstanceStatus(
    instanceId: string,
    credentials: ProviderCredentials,
  ): Promise<string | null> {
    const backend = this.registry.getOrThrow(this.defaultBackend);
    return backend.getInstanceStatus(instanceId, credentials);
  }

  async listInstances(credentials: ProviderCredentials): Promise<GpuInstance[]> {
    // Cross-backend listing: ask all known backends and merge. This is
    // intentionally permissive — the same credentials object may be valid
    // for multiple backends if the host app set them up that way.
    const results: GpuInstance[] = [];
    for (const backendId of ['vast', 'runpod'] as const) {
      const client = this.registry.get(backendId);
      if (!client) continue;
      try {
        const list = await client.listInstances(credentials);
        for (const inst of list) {
          // Heuristic: only count instances running the snapgpu-runtime image.
          // Without this filter we'd return every instance the user owns.
          if (this._looksLikeSnapgpuInstance(inst)) results.push(inst);
        }
      } catch (err) {
        this.log.warn(`[snapgpu] listInstances backend=${backendId} failed: ${this.errMsg(err)}`);
      }
    }
    return results;
  }

  private _looksLikeSnapgpuInstance(inst: GpuInstance): boolean {
    const meta = inst.providerMeta;
    if (!meta) return false;
    if (meta.provider === 'snapgpu') return true;
    // Fallback: check if the image name contains snapgpu-runtime
    const img = (meta as Record<string, unknown>)['dockerImage'];
    return typeof img === 'string' && img.includes('snapgpu-runtime');
  }

  async resolveInstanceEndpoint(
    instanceId: string,
    credentials: ProviderCredentials,
  ): Promise<string | null> {
    const backend = this.registry.getOrThrow(this.defaultBackend);
    return backend.resolveInstanceEndpoint(instanceId, credentials);
  }

  // ── Snapshot CRUD (delegated to the snapgpu-gateway over HTTP) ─────────

  /**
   * Create a snapshot of the running container at `endpoint`. Returns the
   * snapshot ID, or null if snapgpu reported no CRIU/cuda-checkpoint
   * available (gracefully degraded boot).
   */
  async getAppPid(endpoint: string, appName: string): Promise<number | null> {
    const url = `${endpoint.replace(/\/$/, '')}/v1/apps/${encodeURIComponent(appName)}/pid`;
    try {
      const res = await this.fetchRaw(url, { method: 'GET' }, 5_000);
      if (!res.ok) return null;
      const data = (await res.json()) as { pid?: number; found?: boolean };
      return data.pid ?? null;
    } catch {
      return null;
    }
  }

  async createSnapshot(
    endpoint: string,
    appName: string,
    options: { functionName?: string; className?: string; includeGpu?: boolean; pid?: number } = {},
  ): Promise<string | null> {
    const url = `${endpoint.replace(/\/$/, '')}/v1/snapshots`;
    try {
      const res = await this.fetchRaw(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app_name: appName,
            function_name: options.functionName,
            class_name: options.className,
            include_gpu: options.includeGpu ?? true,
            pid: options.pid,
          }),
        },
        TIMEOUTS.create,
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log.warn(`[snapgpu] createSnapshot HTTP ${res.status}: ${text.slice(0, 200)}`);
        return null;
      }
      const data = (await res.json()) as { snapshot_id?: string };
      if (data.snapshot_id) {
        this.log.log(`[snapgpu] created snapshot ${data.snapshot_id} for ${appName}`);
        return data.snapshot_id;
      }
      return null;
    } catch (err) {
      this.log.warn(`[snapgpu] createSnapshot failed: ${this.errMsg(err)}`);
      this.emitError({
        operation: 'createSnapshot',
        message: this.errMsg(err),
        retryable: true,
      });
      return null;
    }
  }

  /** List all snapshots known to the snapgpu-gateway at `endpoint`. */
  async listSnapshots(endpoint: string): Promise<SnapshotInfo[]> {
    const url = `${endpoint.replace(/\/$/, '')}/v1/snapshots`;
    try {
      const res = await this.fetchRaw(url, {}, TIMEOUTS.read);
      if (!res.ok) return [];
      const data = (await res.json()) as { snapshots?: SnapshotInfo[] };
      return data.snapshots ?? [];
    } catch (err) {
      this.log.warn(`[snapgpu] listSnapshots failed: ${this.errMsg(err)}`);
      return [];
    }
  }

  /**
   * Restore a snapshot at the running gateway. Returns true on success.
   * The container's PID 1 (uvicorn) keeps running; the snapshot restores
   * the *application* process inside the warm pool.
   */
  async restoreSnapshot(endpoint: string, snapshotId: string): Promise<boolean> {
    const url = `${endpoint.replace(/\/$/, '')}/v1/snapshots/${encodeURIComponent(snapshotId)}/restore`;
    try {
      const res = await this.fetchRaw(
        url,
        { method: 'POST' },
        TIMEOUTS.create,
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log.warn(`[snapgpu] restoreSnapshot HTTP ${res.status}: ${text.slice(0, 200)}`);
        return false;
      }
      this.log.log(`[snapgpu] restored snapshot ${snapshotId}`);
      return true;
    } catch (err) {
      this.log.warn(`[snapgpu] restoreSnapshot failed: ${this.errMsg(err)}`);
      return false;
    }
  }

  /** Delete a snapshot — frees disk on the gateway. */
  async deleteSnapshot(endpoint: string, snapshotId: string): Promise<boolean> {
    const url = `${endpoint.replace(/\/$/, '')}/v1/snapshots/${encodeURIComponent(snapshotId)}`;
    try {
      const res = await this.fetchRaw(url, { method: 'DELETE' }, TIMEOUTS.write);
      return res.ok;
    } catch (err) {
      this.log.warn(`[snapgpu] deleteSnapshot failed: ${this.errMsg(err)}`);
      return false;
    }
  }

  /**
   * Trigger an S3 snapshot sync on a running gateway: downloads the latest
   * checkpoint for `appName` from S3, extracts it, and registers it locally.
   *
   * Call this on a fresh worker BEFORE calling restoreSnapshot() so the restore
   * can succeed even if the worker has no local snapshots yet.
   *
   * Returns the snapshot_id that was downloaded, or null if S3 is not configured,
   * no snapshot exists for the app, or the download failed (all non-fatal).
   */
  async syncSnapshotFromS3(endpoint: string, appName: string): Promise<string | null> {
    const url = `${endpoint.replace(/\/$/, '')}/v1/snapshots/s3-sync`;
    try {
      const res = await this.fetchRaw(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_name: appName }),
        },
        TIMEOUTS.create,
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log.warn(`[snapgpu] syncSnapshotFromS3 HTTP ${res.status}: ${text.slice(0, 200)}`);
        return null;
      }
      const data = (await res.json()) as { snapshot_id?: string; found?: boolean };
      if (data.found && data.snapshot_id) {
        this.log.log(`[snapgpu] S3 sync complete: snapshot ${data.snapshot_id} ready for app=${appName}`);
        return data.snapshot_id;
      }
      this.log.log(`[snapgpu] S3 sync: no snapshot found for app=${appName}`);
      return null;
    } catch (err) {
      this.log.warn(`[snapgpu] syncSnapshotFromS3 failed: ${this.errMsg(err)}`);
      return null;
    }
  }

  /**
   * Check what snapshot is available on S3 for an app, without downloading it.
   * Useful to decide whether to attempt a restore before deploying a worker.
   */
  async getS3Manifest(endpoint: string, appName: string): Promise<{
    available: boolean;
    snapshotId?: string;
    uploadedAt?: string;
    sizeBytes?: number;
  }> {
    const url = `${endpoint.replace(/\/$/, '')}/v1/snapshots/s3-manifest/${encodeURIComponent(appName)}`;
    try {
      const res = await this.fetchRaw(url, {}, TIMEOUTS.read);
      if (!res.ok) return { available: false };
      const data = (await res.json()) as {
        available?: boolean;
        snapshot_id?: string;
        uploaded_at?: string;
        size_bytes?: number;
      };
      return {
        available: !!data.available,
        snapshotId: data.snapshot_id,
        uploadedAt: data.uploaded_at,
        sizeBytes: data.size_bytes,
      };
    } catch {
      return { available: false };
    }
  }

  /**
   * Probe the snapgpu-gateway /health endpoint. Returns true if the gateway
   * is reachable AND reporting CRIU + cuda-checkpoint as available.
   */
  async probeSnapgpuReady(endpoint: string): Promise<{
    reachable: boolean;
    criuReady: boolean;
    cudaCheckpointReady: boolean;
  }> {
    const url = `${endpoint.replace(/\/$/, '')}/health`;
    try {
      const res = await this.fetchRaw(url, {}, 5_000);
      if (!res.ok) return { reachable: false, criuReady: false, cudaCheckpointReady: false };
      const data = (await res.json()) as {
        status?: string;
        criu?: boolean;
        cuda_checkpoint?: boolean;
      };
      return {
        reachable: data.status === 'ok',
        criuReady: !!data.criu,
        cudaCheckpointReady: !!data.cuda_checkpoint,
      };
    } catch {
      return { reachable: false, criuReady: false, cudaCheckpointReady: false };
    }
  }
}
