// Autoscaler-specific types — shared across sub-modules and the facade

export type AutoScaleRoute = 'llm' | 's2s';
export type GpuBootState = 'idle' | 'booting' | 'ready';
export type ScaleTrigger = 'sessions' | 'latency' | 'manual' | 'predictive';
export type GpuProvider = 'tensordock' | 'runpod' | 'vast' | 'modal' | 'skypilot';

/** One GPU tier in the cascade: llm → tier[0] → tier[1] → tier[2] */
export interface GpuTierConfig {
  provider: GpuProvider;
  instanceId?: string;
  endpoint?: string;
  apiKey?: string;
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
