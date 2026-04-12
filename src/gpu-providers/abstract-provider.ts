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

// ── Rate limiter ────────────────────────────────────────────────────────────

/** Simple rate limiter that enforces a minimum interval between calls. */
export class RateLimiter {
  private lastCallMs = 0;
  constructor(private minIntervalMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCallMs;
    if (elapsed < this.minIntervalMs) {
      await new Promise(r => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastCallMs = Date.now();
  }
}

/** Default rate limit: ~3 requests/second (334ms between calls). */
export const DEFAULT_RATE_LIMIT_MS = 334;

// ── Shared retry / polling utilities ─────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 2) */
  maxRetries?: number;
  /** Base delay in ms before first retry (default: 2000) */
  baseDelayMs?: number;
  /** Backoff growth factor (default: 2.0 for exponential) */
  growth?: number;
  /** Maximum delay cap in ms (default: 30_000) */
  maxDelayMs?: number;
  /** Predicate: should we retry this error? Default: always retry */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

/**
 * Retry a function with configurable backoff.
 * Delay formula: min(baseDelayMs * growth^attempt, maxDelayMs)
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 2_000;
  const growth = opts.growth ?? 2.0;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries || !shouldRetry(err, attempt)) throw err;
      const delay = Math.min(baseDelayMs * Math.pow(growth, attempt), maxDelayMs);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr; // unreachable but satisfies TypeScript
}

export interface PollOptions {
  /** Maximum total wait time in ms (default: 300_000 = 5 min) */
  maxWaitMs?: number;
  /** Base poll interval in ms (default: 5_000) */
  baseIntervalMs?: number;
  /** Backoff growth factor per attempt (default: 1.4) */
  growth?: number;
  /** Maximum single interval cap in ms (default: 30_000) */
  maxIntervalMs?: number;
}

/**
 * Poll a check function with exponential backoff until it returns a truthy value.
 * Returns the truthy result, or null if maxWaitMs is exceeded.
 */
export async function pollUntilReady<T>(
  checkFn: (attempt: number, elapsedMs: number) => Promise<T | null | false | undefined>,
  opts: PollOptions = {},
): Promise<T | null> {
  const maxWaitMs = opts.maxWaitMs ?? 300_000;
  const baseIntervalMs = opts.baseIntervalMs ?? 5_000;
  const growth = opts.growth ?? 1.4;
  const maxIntervalMs = opts.maxIntervalMs ?? 30_000;

  let elapsed = 0;
  let attempt = 0;

  while (elapsed < maxWaitMs) {
    const delay = Math.min(baseIntervalMs * Math.pow(growth, attempt), maxIntervalMs);
    await new Promise(r => setTimeout(r, delay));
    elapsed += delay;
    attempt++;

    const result = await checkFn(attempt, elapsed);
    if (result) return result;
  }

  return null;
}

// ── Shared constants ────────────────────────────────────────────────────────

/** Default timeouts (ms) for provider HTTP calls. */
export const TIMEOUTS: Record<string, number> & { read: number; write: number; create: number; deploy: number } = {
  read: parseInt(process.env.GPU_TIMEOUT_READ_MS || '10000', 10),
  write: parseInt(process.env.GPU_TIMEOUT_WRITE_MS || '15000', 10),
  create: parseInt(process.env.GPU_TIMEOUT_CREATE_MS || '30000', 10),
  deploy: parseInt(process.env.GPU_TIMEOUT_DEPLOY_MS || '180000', 10),
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
  /** Rate limiter for provider API calls. Subclasses can override via constructor. */
  protected rateLimiter: RateLimiter;

  constructor(opts?: AbstractGpuProviderOptions) {
    this.log = opts?.logger ?? defaultLogger;
    this.onInstancePersist = opts?.onInstancePersist;
    this.hooks = opts?.hooks;
    this.rateLimiter = new RateLimiter(DEFAULT_RATE_LIMIT_MS);
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

  /**
   * Preflight account check — runs BEFORE attempting deploy to detect blocked
   * accounts (zero quota, insufficient balance, expired credentials, etc.)
   * and fail fast with a clear error.
   *
   * Why this matters: providers like RunPod silently accept pod creation
   * requests even when the account is blocked, then never assign hardware.
   * Without preflight, each blocked deploy burns 3+ minutes before timing out,
   * which during multi-tier fallback compounds to ~10 minutes of dead air.
   *
   * Default impl is a no-op (always green) — concrete clients override with
   * their own balance/quota query. Returning `canDeploy: false` causes
   * createInstance to throw immediately with `blockReason`.
   *
   * Implementations MUST be cheap (single API call, < 5s) and MUST tolerate
   * the API being unreachable (return `null` instead of throwing — gateway
   * proceeds optimistically rather than blocking on transient errors).
   */
  async preflight(_credentials: ProviderCredentials): Promise<{
    canDeploy: boolean;
    blockReason: string | null;
    balance?: number;
    quota?: number;
  } | null> {
    return { canDeploy: true, blockReason: null };
  }

  /**
   * Helper for concrete clients: call preflight() and throw if blocked.
   * Use this at the top of createInstance() to fail fast on blocked accounts.
   */
  protected async _runPreflight(credentials: ProviderCredentials): Promise<void> {
    let result: Awaited<ReturnType<typeof this.preflight>>;
    try {
      result = await this.preflight(credentials);
    } catch (err) {
      // Preflight should never throw — but if it does, treat as "unreachable"
      // and proceed optimistically rather than hard-blocking.
      this.log.warn(`[${this.providerId}] preflight threw (proceeding optimistically): ${this.errMsg(err)}`);
      return;
    }
    if (result === null) {
      // API unreachable — don't hard-fail. Provider might still work.
      this.log.warn(`[${this.providerId}] preflight skipped (account API unreachable)`);
      return;
    }
    const balanceStr = result.balance != null ? `$${result.balance.toFixed(2)}` : '?';
    const quotaStr = result.quota != null ? String(result.quota) : '?';
    this.log.log(`[${this.providerId}] preflight ok: balance=${balanceStr} quota=${quotaStr}`);
    if (!result.canDeploy) {
      const msg = result.blockReason || `${this.providerId} account blocked`;
      this.log.warn(`[${this.providerId}] PREFLIGHT BLOCKED: ${msg}`);
      this.emitError({
        operation: 'createInstance',
        message: msg,
        retryable: false,
      });
      throw new Error(`${this.providerId} preflight blocked: ${msg}`);
    }
  }
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
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new FetchError(
        `${label ?? this.providerId}: invalid JSON response (HTTP ${res.status}): ${text.substring(0, 200)}`,
        res.status,
        text,
      );
    }
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
   * Returns the decompressed estimate (compressed * 3) + 10GB overhead, minimum 10GB.
   * Falls back to `fallbackGb` if the API call fails (e.g. private registry).
   *
   * NOTE: This estimates Docker image size only — it does NOT account for models
   * downloaded at runtime (vLLM, TGI, etc.). For runtime-download images,
   * callers should set storageGb explicitly based on model size:
   *   - 7B Q4: ~5GB model → 50GB total disk
   *   - 13B Q4: ~8GB model → 80GB total disk
   *   - 32B Q4/AWQ: ~20GB model → 120GB total disk
   *   - 70B Q4: ~40GB model → 200GB total disk
   *
   * Supports Docker Hub images: `user/repo:tag` or `library/image:tag`.
   */
  static async estimateImageDiskGb(dockerImage: string, fallbackGb = 40): Promise<number> {
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
