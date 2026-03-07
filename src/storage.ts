/**
 * GatewayStorage — single interface the host app implements to wire
 * the ai-gateway to its persistence layer (Prisma, Drizzle, etc.).
 *
 * Replaces 6 separate DI interfaces (SettingsStore, SessionResolver,
 * LifecycleLogStore, UserRoleResolver, BenchmarkStore, CredentialStore).
 */

import type { ProviderCredentials } from './gpu-providers/types';
import type { GpuLifecycleLogEntry } from './autoscaler/lifecycle-logger';
import type { ProviderAccount } from './autoscaler/cost-monitor';
import type { DeploySessionRecord } from './types';

export interface GatewayStorage {
  // ── Required (minimum for autoscaler to work) ──────────────────────────────

  /** Read user's AI provider settings. */
  getSettings(userId: string): Promise<Record<string, unknown>>;

  /** Merge partial update into user's AI provider settings. */
  patchSettings(userId: string, partial: Record<string, unknown>): Promise<void>;

  /** Count active sessions for a user within the time window. */
  countSessions(userId: string, windowMinutes: number): Promise<number>;

  /** Given a student ID, resolve the teacher's userId (or null). */
  resolveTeacher(studentId: string): Promise<string | null>;

  // ── Optional (implement only what you need) ─────────────────────────────────

  /** Resolve GPU provider API credentials. Falls back to env vars if not provided. */
  resolveCredentials?(userId: string, provider: string): Promise<ProviderCredentials | null>;

  /** Query persisted GPU lifecycle log entries. */
  queryLifecycleLogs?(params: {
    userIds: string[];
    eventType?: string;
    provider?: string;
    limit: number;
    sortOrder: 'asc' | 'desc';
  }): Promise<GpuLifecycleLogEntry[]>;

  /** Resolve which user IDs are visible (e.g. admin sees teacher's logs). */
  resolveVisibleUserIds?(userId: string): Promise<string[]>;

  /** Persist a GPU benchmark result. */
  createBenchmark?(data: Record<string, unknown>): Promise<void>;

  /** Query persisted GPU benchmark results. */
  queryBenchmarks?(params: {
    userId: string;
    benchType?: string;
    provider?: string;
    limit: number;
  }): Promise<Record<string, unknown>[]>;

  /** Persist a GPU lifecycle event (fire-and-forget). */
  logLifecycleEvent?(entry: GpuLifecycleLogEntry): void;

  /** Load all provider accounts across all users (for cost monitor sweeps). */
  loadAllAccounts?(): Promise<ProviderAccount[]>;

  // ── Deploy Sessions (optional) ──────────────────────────────────────────────

  /** Create a new deploy session record. Returns the session ID. */
  createDeploySession?(data: {
    userId: string;
    provider: string;
    gpuModel: string;
    dockerImage?: string;
    region?: string;
  }): Promise<string>;

  /** Update an existing deploy session record. */
  updateDeploySession?(id: string, data: Partial<{
    status: string;
    serverReadyAt: Date;
    stoppedAt: Date;
    provisionTimeS: number;
    errorMessage: string;
    providerInstanceId: string;
    endpoint: string;
    /** Merge into metadata JSON (e.g. healthMs, firstInferenceMs) */
    metadata: Record<string, unknown>;
  }>): Promise<void>;

  /** Query deploy session records for given users. */
  queryDeploySessions?(params: {
    userIds: string[];
    limit: number;
    sortOrder: 'asc' | 'desc';
  }): Promise<DeploySessionRecord[]>;
}
