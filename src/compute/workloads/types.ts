/**
 * Unified Workload types — GPU inference, bots, databases, and future services
 * all share one lifecycle model.
 */

// ── Workload Types ──────────────────────────────────────────────────────────

export type WorkloadType = 'gpu' | 'bot' | 'db';

export type WorkloadStatus =
  | 'idle'
  | 'deploying'
  | 'running'
  | 'stopped'
  | 'error';

/** Discriminated config per workload type */
export type WorkloadConfig =
  | GpuWorkloadConfig
  | BotWorkloadConfig
  | DbWorkloadConfig;

export interface GpuWorkloadConfig {
  type: 'gpu';
  /** RunPod/Vast API key */
  apiKey?: string;
  dockerImage?: string;
  gpuTypes?: string[];
  storageGb?: number;
  env?: Record<string, string>;
  region?: string;
}

export interface BotWorkloadConfig {
  type: 'bot';
  /** "teams" | "whatsapp" */
  botKind: string;
  apiKey?: string;
  dockerImage?: string;
  meetingUrl?: string;
  env?: Record<string, string>;
}

export interface DbWorkloadConfig {
  type: 'db';
  /** Neon project ID (if connecting to existing) */
  projectId?: string;
  /** Neon API key */
  apiKey?: string;
  /** Direct connection string override */
  connectionString?: string;
}

// ── Core Workload ───────────────────────────────────────────────────────────

export interface Workload {
  id: string;
  type: WorkloadType;
  /** Human-readable name: "gpu-inference", "teams-bot", "whatsapp-bot", "postgres" */
  name: string;
  status: WorkloadStatus;
  /** Provider running this workload: "runpod", "vast", "fly", "neon", etc. */
  provider: string;
  /** Reachable endpoint (HTTP URL, connection string, etc.) */
  endpoint?: string;
  /** Hourly cost in USD (0 for free-tier/serverless) */
  costPerHr: number;
  /** Provider-specific instance/pod ID */
  instanceId?: string;
  /** Type-specific metadata (podId, gpuType, meetingUrl, branchId, etc.) */
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  /** Last error message (when status = 'error') */
  error?: string;
}

// ── Workload Driver ─────────────────────────────────────────────────────────

/**
 * Each workload type implements this interface. The registry delegates
 * lifecycle operations to the appropriate driver.
 */
export interface WorkloadDriver {
  readonly type: WorkloadType;

  /** Deploy a new workload. Returns the created Workload record. */
  deploy(name: string, config: WorkloadConfig): Promise<Workload>;

  /** Stop (pause) a running workload — preserves state for resume. */
  stop(workload: Workload): Promise<Workload>;

  /** Start/resume a stopped workload. */
  start(workload: Workload): Promise<Workload>;

  /** Permanently destroy a workload. */
  terminate(workload: Workload): Promise<void>;

  /** Poll current status from the provider. */
  status(workload: Workload): Promise<Workload>;
}

// ── Events ──────────────────────────────────────────────────────────────────

export type WorkloadEventType =
  | 'created'
  | 'status_changed'
  | 'terminated';

export interface WorkloadEvent {
  type: WorkloadEventType;
  workload: Workload;
  previousStatus?: WorkloadStatus;
  timestamp: number;
}

export type WorkloadEventHandler = (event: WorkloadEvent) => void;
