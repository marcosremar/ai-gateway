/**
 * Abstract base class for GPU provider clients.
 *
 * Provides shared utilities (logging, error formatting, HTTP helpers, instance persistence)
 * so concrete providers only implement provider-specific logic.
 */

import type { GpuProviderClient, GpuInstance, InstanceSpec, ProviderCredentials, OnInstancePersist } from './types';
import type { Logger } from '../deps';
import type { GatewayHooks, ErrorEvent } from '../hooks';
import { emitHook } from '../hooks';
import { defaultLogger } from '../logger';

// ── Shared constants ────────────────────────────────────────────────────────

/** Default timeouts (ms) for provider HTTP calls. */
export const TIMEOUTS: Record<string, number> & { read: number; write: number; create: number; deploy: number } = {
  read: 10_000,
  write: 15_000,
  create: 30_000,
  deploy: 180_000,
};

// ── Shared types ────────────────────────────────────────────────────────────

export interface AbstractGpuProviderOptions {
  onInstancePersist?: OnInstancePersist;
  logger?: Logger;
  hooks?: GatewayHooks;
}

// ── FetchError ──────────────────────────────────────────────────────────────

/** Error thrown by `fetchJson` / `fetchRaw` when the response is not ok. */
export class FetchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

// ── Abstract base class ─────────────────────────────────────────────────────

export abstract class AbstractGpuProvider implements GpuProviderClient {
  abstract readonly providerId: string;
  abstract readonly bootTimeSecs: number;

  protected log: Logger;
  protected onInstancePersist?: OnInstancePersist;
  protected hooks?: GatewayHooks;

  constructor(opts?: AbstractGpuProviderOptions) {
    this.log = opts?.logger ?? defaultLogger;
    this.onInstancePersist = opts?.onInstancePersist;
    this.hooks = opts?.hooks;
  }

  /** Emit an error event via hooks. Fire-and-forget. */
  protected emitError(fields: Omit<ErrorEvent, 'source' | 'timestamp'>): void {
    emitHook(this.hooks, 'onError', {
      source: 'gpu-provider',
      provider: this.providerId,
      ...fields,
      timestamp: Date.now(),
    });
  }

  // ── Abstract methods (must be implemented by subclasses) ────────────────

  abstract discoverInstance(credentials: ProviderCredentials, gpuTypes: string[]): Promise<GpuInstance | null>;
  abstract createInstance(spec: InstanceSpec, credentials: ProviderCredentials, userId?: string): Promise<GpuInstance>;
  abstract startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void>;
  abstract stopInstance(instanceId: string, credentials: ProviderCredentials): Promise<void>;
  abstract deleteInstance(instanceId: string, credentials: ProviderCredentials): Promise<void>;
  abstract getInstanceStatus(instanceId: string, credentials: ProviderCredentials): Promise<string | null>;
  abstract listInstances(credentials: ProviderCredentials): Promise<GpuInstance[]>;
  abstract resolveInstanceEndpoint(instanceId: string, credentials: ProviderCredentials): Promise<string | null>;

  // ── Shared utilities ────────────────────────────────────────────────────

  /** Extract a human-readable message from an unknown error. */
  protected errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** Build standard JSON headers with Bearer auth. */
  protected jsonHeaders(apiKey: string): Record<string, string> {
    return {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
  }

  /**
   * Fetch a URL and parse the JSON response. Throws `FetchError` on non-ok status.
   * Uses full URLs (not base+path) because providers have varied URL patterns.
   */
  protected async fetchJson<T>(
    url: string,
    init?: RequestInit,
    timeout = TIMEOUTS.read,
    label?: string,
  ): Promise<T> {
    const res = await this.fetchRaw(url, init, timeout);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new FetchError(
        `${label ?? this.providerId} HTTP ${res.status}: ${body.substring(0, 300)}`,
        res.status,
        body,
      );
    }
    return res.json() as Promise<T>;
  }

  /** Fetch a URL and return the raw Response (for status-code branching like 404 = not found). */
  protected async fetchRaw(url: string, init?: RequestInit, timeout = TIMEOUTS.read): Promise<Response> {
    return fetch(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeout),
    });
  }

  /** Persist instance data via the onInstancePersist callback, with error logging. */
  protected async persistInstance(
    userId: string | undefined,
    machineKey: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!userId || !this.onInstancePersist) return;
    try {
      await this.onInstancePersist(userId, machineKey, data);
    } catch (err) {
      this.log.error(`[${this.providerId}] Failed to persist instance for user ${userId}: ${this.errMsg(err)}`);
    }
  }

  /**
   * Query Docker Hub Registry API for the compressed image size in GB.
   * Returns the decompressed estimate (compressed * 2.5) + 5GB overhead, minimum 10GB.
   * Falls back to `fallbackGb` if the API call fails (e.g. private registry).
   *
   * Supports Docker Hub images: `user/repo:tag` or `library/image:tag`.
   */
  static async estimateImageDiskGb(dockerImage: string, fallbackGb = 20): Promise<number> {
    try {
      // Parse image name — handle "user/repo:tag", "user/repo" (default :latest), "repo:tag" (library/)
      const [imagePart, tag = 'latest'] = dockerImage.split(':');
      const repo = imagePart.includes('/') ? imagePart : `library/${imagePart}`;

      // 1. Get auth token for Docker Hub (anonymous pull)
      const tokenRes = await fetch(
        `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!tokenRes.ok) return fallbackGb;
      const { token } = (await tokenRes.json()) as { token: string };

      // 2. Get manifest list (fat manifest) to find the amd64 manifest digest
      const manifestListRes = await fetch(
        `https://registry-1.docker.io/v2/${repo}/manifests/${tag}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: [
              'application/vnd.oci.image.index.v1+json',
              'application/vnd.docker.distribution.manifest.list.v2+json',
              'application/vnd.docker.distribution.manifest.v2+json',
              'application/vnd.oci.image.manifest.v1+json',
            ].join(', '),
          },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!manifestListRes.ok) return fallbackGb;

      const manifestData = (await manifestListRes.json()) as Record<string, unknown>;
      let compressedBytes = 0;

      // Check if it's a manifest list (multi-arch) or a single manifest
      if (manifestData.manifests && Array.isArray(manifestData.manifests)) {
        // Multi-arch: find amd64/linux
        const amd64 = (manifestData.manifests as Array<Record<string, unknown>>).find(
          (m) => {
            const p = m.platform as Record<string, string> | undefined;
            return p && p.architecture === 'amd64' && p.os === 'linux';
          },
        );
        if (!amd64) return fallbackGb;

        // Fetch the specific manifest
        const singleRes = await fetch(
          `https://registry-1.docker.io/v2/${repo}/manifests/${amd64.digest as string}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
            },
            signal: AbortSignal.timeout(5_000),
          },
        );
        if (!singleRes.ok) return fallbackGb;
        const single = (await singleRes.json()) as Record<string, unknown>;
        const layers = (single.layers ?? single.fsLayers) as Array<{ size?: number }> | undefined;
        if (layers) compressedBytes = layers.reduce((sum, l) => sum + (l.size ?? 0), 0);
      } else {
        // Single manifest: sum layer sizes directly
        const layers = (manifestData.layers ?? manifestData.fsLayers) as Array<{ size?: number }> | undefined;
        if (layers) compressedBytes = layers.reduce((sum, l) => sum + (l.size ?? 0), 0);
      }

      if (compressedBytes === 0) return fallbackGb;

      // Decompressed estimate: compressed * 3 + 10GB overhead for runtime/tmp/model cache
      const decompressedGb = (compressedBytes / (1024 ** 3)) * 3 + 10;
      return Math.max(Math.ceil(decompressedGb), 10);
    } catch {
      return fallbackGb;
    }
  }
}
