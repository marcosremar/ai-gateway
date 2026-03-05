/**
 * Dependency interfaces for the autoscaler module.
 * The host application provides concrete implementations (Prisma, Redis, etc.)
 * so the autoscaler package has zero framework dependencies.
 */

/** Reads/writes user-level AI provider settings (backed by Prisma, KV, etc.) */
export interface SettingsStore {
  get(userId: string): Promise<Record<string, unknown>>;
  patch(userId: string, partial: Record<string, unknown>): Promise<void>;
}

/** Key/value operations (used by StatePersistence) */
export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSecs?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** SCAN keys matching a pattern. Returns all matching keys. */
  scan(pattern: string): Promise<string[]>;
}

/** List operations (used by LatencyTracker) */
export interface ListStore {
  /** Push value to the right of a list */
  rpush(key: string, value: string): Promise<void>;
  /** Trim list to keep only elements in [start, stop] range */
  ltrim(key: string, start: number, stop: number): Promise<void>;
  /** Get list elements in [start, stop] range */
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

/** Hash operations (used by SessionTracker) */
export interface HashStore {
  /** Set hash field */
  hset(key: string, field: string, value: string): Promise<void>;
  /** Delete hash field */
  hdel(key: string, field: string): Promise<void>;
  /** Get all hash fields */
  hgetall(key: string): Promise<Record<string, string>>;
}

/**
 * Low-level key/value + list + hash store (backed by Redis, etc.).
 * All methods are async to allow network-backed implementations.
 * Kept as intersection for backward compatibility — concrete adapters implement all ops.
 */
export type StateStore = KvStore & ListStore & HashStore;

/** Resolves session counts and teacher→student relationships */
export interface SessionResolver {
  /** Count DB-persisted active sessions for a user within the time window */
  countDbSessions(userId: string, windowMinutes: number): Promise<number>;
  /** Given a student ID, resolve the teacher's userId (or null if not enrolled) */
  resolveTeacher(studentId: string): Promise<string | null>;
}

export interface Logger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Resolves provider API credentials for a given user + provider name. */
export interface CredentialStore {
  resolve(userId: string, provider: string): Promise<import('./gpu-providers/types').ProviderCredentials | null>;
}

/** Queries persisted GPU lifecycle log entries. */
export interface LifecycleLogStore {
  query(params: {
    userIds: string[];
    eventType?: string;
    provider?: string;
    limit: number;
    sortOrder: 'asc' | 'desc';
  }): Promise<import('./autoscaler/lifecycle-logger').GpuLifecycleLogEntry[]>;
}

/** Resolves which user IDs should be visible for a given userId (e.g. admin logs for teachers). */
export interface UserRoleResolver {
  resolveVisibleUserIds(userId: string): Promise<string[]>;
}

/** Persists GPU benchmark results (health, inference, boot). */
export interface BenchmarkStore {
  create(data: Record<string, unknown>): Promise<void>;
  query(params: {
    userId: string;
    benchType?: string;
    provider?: string;
    limit: number;
  }): Promise<Record<string, unknown>[]>;
}

/** Queries API usage logs for cost analysis and anomaly detection. */
export interface UsageLogStore {
  /** Group usage by user with sum of costs */
  groupByUser(params: {
    startDate: Date;
    minCost?: number;
  }): Promise<{ userId: string; costUsd: number }[]>;

  /** Count usage logs by context (e.g., 'background') */
  countByContext(params: {
    context: string;
    startDate: Date;
  }): Promise<number>;

  /** Count usage logs in a date range */
  countInRange(params: {
    context?: string;
    startDate: Date;
    endDate: Date;
  }): Promise<number>;

  /** Group usage by model and route for expensive model detection */
  groupByModelAndRoute(params: {
    context: string;
    models: string[];
    startDate: Date;
  }): Promise<{ model: string; route: string; count: number; costUsd: number }[]>;

  /** Count logs by stage with zero cost (for untracked detection) */
  countByStage(params: {
    stage: string;
    costUsd: number;
    startDate: Date;
  }): Promise<number>;
}

/** DI interface for vault persistence (encrypted secret storage) */
export interface VaultStore {
  get(name: string): Promise<string | null>;
  set(name: string, encrypted: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
}

/** All external dependencies the autoscaler needs. Provided by the host app. */
export interface AutoscalerDeps {
  settingsStore: SettingsStore;
  stateStore: StateStore; // host provides full StateStore; internals only use sub-interfaces
  sessionResolver: SessionResolver;
  usageLogStore?: UsageLogStore;
  logger?: Logger;
  hooks?: import('./hooks').GatewayHooks;
  vaultStore?: VaultStore;
}
