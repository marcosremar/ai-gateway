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
  /** Neon API key (or set NEON_API_KEY env var) */
  apiKey?: string;

  // ── ADOPT mode — track an existing Neon project ────────────────────────
  /** If provided, the driver adopts this existing Neon project instead of creating a new one. */
  projectId?: string;
  /** Optional fallback connection string when adopting (used if no endpoint is returned) */
  connectionString?: string;

  // ── CREATE mode — provision a new Neon project ─────────────────────────
  /** Display name for the new Neon project (defaults to workload name) */
  projectName?: string;
  /** Region, e.g. "aws-us-east-1", "aws-eu-central-1" */
  regionId?: string;
  /** PostgreSQL major version (15, 16, 17). Defaults to Neon's current default. */
  pgVersion?: number;
  /** Autoscaling lower bound in CU. Default: 0.25 (free-tier minimum). */
  autoscalingMinCu?: number;
  /** Autoscaling upper bound in CU. Default: 2. */
  autoscalingMaxCu?: number;
  /** Idle seconds before compute suspends. Default: 0 (immediate, free-tier friendly). */
  suspendTimeoutSeconds?: number;
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
