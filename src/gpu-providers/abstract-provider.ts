/**
 * Abstract base class for GPU provider clients.
 *
 * Provides shared utilities (logging, error formatting, HTTP helpers, instance persistence)
 * so concrete providers only implement provider-specific logic.
 */

import type { GpuProviderClient, GpuInstance, InstanceSpec, ProviderCredentials, OnInstancePersist } from './types';
import type { Logger } from '../deps';
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

  constructor(opts?: AbstractGpuProviderOptions) {
    this.log = opts?.logger ?? defaultLogger;
    this.onInstancePersist = opts?.onInstancePersist;
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
}
