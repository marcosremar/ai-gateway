// Autoscaler-specific types — shared across sub-modules and the facade

export type AutoScaleRoute = 'llm' | 's2s';
export type GpuBootState = 'idle' | 'booting' | 'ready';
export type ScaleTrigger = 'sessions' | 'latency' | 'manual' | 'predictive';
export type GpuProvider = 'tensordock' | 'runpod' | 'vast' | 'modal' | 'skypilot';

/**
 * Per-stage timeout config (ms). Each stage of the boot pipeline has a hard
 * deadline — if the stage doesn't complete in time it's aborted and the
 * engine moves to the next tier in the fallback chain.
 */
export interface StageTimeouts {
  /** Max time for discoverInstance (default: 30s) */
  discoverMs?: number;
  /** Max time for createInstance — includes offer search + API call + endpoint polling (default: 120s) */
  createMs?: number;
  /** Max time for startInstance on an existing stopped instance (default: 30s) */
  startMs?: number;
}

/** Default stage timeouts per provider (ms) */
export const DEFAULT_STAGE_TIMEOUTS: Record<string, Required<StageTimeouts>> = {
  vast:       { discoverMs: 30_000, createMs: 120_000, startMs: 30_000 },
  runpod:     { discoverMs: 30_000, createMs: 90_000,  startMs: 30_000 },
  tensordock: { discoverMs: 30_000, createMs: 120_000, startMs: 30_000 },
  modal:      { discoverMs: 15_000, createMs: 60_000,  startMs: 15_000 },
};

const FALLBACK_STAGE_TIMEOUTS: Required<StageTimeouts> = {
  discoverMs: 30_000, createMs: 120_000, startMs: 30_000,
};

/** Resolve effective stage timeouts: tier config > provider defaults > fallback */
export function resolveStageTimeouts(provider: string, overrides?: StageTimeouts): Required<StageTimeouts> {
  const defaults = DEFAULT_STAGE_TIMEOUTS[provider] ?? FALLBACK_STAGE_TIMEOUTS;
  return {
    discoverMs: overrides?.discoverMs ?? defaults.discoverMs,
    createMs: overrides?.createMs ?? defaults.createMs,
    startMs: overrides?.startMs ?? defaults.startMs,
  };
}

/** One GPU tier in the cascade: llm → tier[0] → tier[1] → tier[2] */
export interface GpuTierConfig {
  provider: GpuProvider;
  instanceId?: string;
  endpoint?: string;
  apiKey?: string;
  /**
   * When true, this tier boots immediately on startup and the idle watchdog
   * will never shut it down. Use for GPU instances that must always be ready.
   * Default: false (on-demand, subject to idle shutdown)
   */
  alwaysActive?: boolean;
  /**
   * Number of GPU instances to keep active for this tier.
   * When > 1, multiple instances are provisioned for redundancy/load balancing.
   * Only effective when alwaysActive is true.
   * Default: 1
   */
  replicas?: number;
  /** TensorDock Authorization ID (api_key param) */
  authId?: string;
  /** Ordered GPU type preferences */
  gpuTypes?: string[];
  /** HuggingFace token for model downloads */
  hfToken?: string;
  /** Docker image to deploy (e.g. marcosremar/parle-s2s:latest) */
  dockerImage?: string;
  /** Extra environment variables to inject into the container */
  env?: Record<string, string>;
  /** Disk/volume storage in GB. 0 = no volume (for lightweight images with own CMD). */
  storageGb?: number;
  /** Per-stage timeouts (ms). Overrides provider defaults. */
  stageTimeouts?: StageTimeouts;
  /** Optional region filter (e.g. 'US', 'EU', 'CA' for Vast; 'US-TX-3' for RunPod; city for TensorDock) */
  region?: string;
}

export interface AutoScalerConfig {
  enabled: boolean;
  threshold: number;
  windowMinutes: number;
  maxLatencyMs: number;
  tiers: GpuTierConfig[];
  gpuTypes?: string[];
  /** Minutos de inatividade antes de parar GPU (padrão: 15) */
  idleGraceMinutes?: number;
  /** Load balancing strategy across ready tiers. Default: 'hash' */
  loadBalanceStrategy?: import('./autoscaler/load-balancer').LoadBalanceStrategy;
  /** Declarative fallback chains per pipeline stage */
  fallbackChains?: import('./providers/declarative-chain').FallbackChainConfig[];
  /** Predictive pre-warm config (disabled by default) */
  predictiveWarmup?: import('./autoscaler/predictive-warmup').PredictiveWarmupConfig;
  // Backward-compat single-tier fields (deprecated)
  gpuProvider?: GpuProvider;
  gpuInstanceId?: string;
  gpuEndpoint?: string;
  gpuApiKey?: string;
}

/** Tier is stopped / not yet booted */
export interface IdleTierState {
  state: 'idle';
  tierIndex: number;
  unhealthy?: boolean;
  /** Consecutive boot failures count */
  bootFailCount?: number;
  /** Timestamp until which this tier is in cooldown (no re-boot) */
  cooldownUntil?: number;
  /** True when user explicitly stopped this tier — prevents auto-boot until manual start */
  manualStop?: boolean;
}

/** Tier boot has been triggered; waiting for health probe to pass */
export interface BootingTierState {
  state: 'booting';
  tierIndex: number;
  endpoint: string;
  bootTriggeredAt: number;
  trigger: ScaleTrigger;
  /** Carries bootFailCount from the idle state that transitioned here */
  prevBootFailCount: number;
  /** Instance ID discovered/created at runtime (may differ from config) */
  discoveredInstanceId?: string;
  /** SSH host for fallback health checks (Vast.ai without direct ports) */
  sshHost?: string;
  /** SSH port for fallback health checks */
  sshPort?: number;
  /** Monitor URL for setup progress display (e.g. TensorDock :9090) */
  monitorUrl?: string;
}

/** Tier is healthy and serving traffic */
export interface ReadyTierState {
  state: 'ready';
  tierIndex: number;
  endpoint: string;
  lastHealthyAt: number;
  activeGpuType?: string;
  trigger?: ScaleTrigger;
  bootedAt?: number;
  /** SSH host for fallback health checks (Vast.ai without direct ports) */
  sshHost?: string;
  /** SSH port for fallback health checks */
  sshPort?: number;
}

/** Discriminated union of all possible tier runtime states */
export type GpuTierState = IdleTierState | BootingTierState | ReadyTierState;

/** A persisted GPU deploy session record. */
export interface DeploySessionRecord {
  id: string;
  provider: string;
  gpuModel: string;
  dockerImage?: string;
  region?: string;
  status: string; // 'deploying' | 'ready' | 'failed' | 'stopped' | 'deleted'
  startedAt: string; // ISO
  serverReadyAt?: string;
  stoppedAt?: string;
  provisionTimeS?: number;
  errorMessage?: string;
  providerInstanceId?: string;
  endpoint?: string;
  /** Health check latency in ms when deploy became ready */
  healthMs?: number;
  /** First inference latency in ms */
  firstInferenceMs?: number;
}

export interface AutoScaleDecision {
  route: AutoScaleRoute;
  endpoint?: string;
  allEndpoints?: string[];
  reason: string;
  activeSessions: number;
  threshold: number;
  maxLatencyMs: number;
  p95LatencyMs: number | null;
  gpuState: GpuBootState;
  gpuEndpoint?: string;
  bootedAt?: number;
  trigger?: ScaleTrigger;
  enabled: boolean;
  activeTiers: number;
  bootingTiers: number;
  totalTiers: number;
  estimatedReadySecs?: number | null;
}
