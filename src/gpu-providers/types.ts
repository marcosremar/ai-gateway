export interface ProviderCredentials {
  apiKey: string;
  /** TensorDock marketplace v0 Authorization ID */
  authId?: string;
  hfToken?: string;
}

// ── Provider-specific metadata interfaces ──────────────────────────────────
// Each provider returns a different shape from createInstance(); typing them
// concretely lets host apps narrow on `meta.provider` and access fields safely
// without `as any` casts or string-key indexing.

// Each interface includes `[key: string]: unknown` so it remains assignable to
// `Record<string, unknown>` (used by legacy host-app code that hasn't migrated
// to the discriminated union yet). New code should narrow on `meta.provider`.

export interface RunpodProviderMeta {
  provider: 'runpod';
  /** RunPod GPU type (e.g. "NVIDIA GeForce RTX 4090") */
  gpuType?: string;
  gpuVramGb?: number;
  costPerHr?: number;
  dataCenterId?: string;
  cloudType?: 'COMMUNITY' | 'SECURE';
  [key: string]: unknown;
}

export interface VastProviderMeta {
  provider: 'vast';
  hostIp?: string;
  reliability2?: number;
  inetDown?: number;
  inetUp?: number;
  dphTotal?: number;
  region?: string;
  cpuName?: string;
  cpuCores?: number;
  ramGb?: number;
  gpuVramGb?: number;
  numGpus?: number;
  diskGb?: number;
  diskReadMbps?: number;
  diskWriteMbps?: number;
  pcieBw?: number;
  cudaVersion?: number;
  /** SSH tunnel was used (no direct ports) */
  sshTunnel?: boolean;
  /** Hint that this offer was an SSH-only host */
  sshOnlyHint?: boolean;
  [key: string]: unknown;
}

export interface TensordockProviderMeta {
  provider: 'tensordock';
  hostnodeId?: string;
  /** Location tier: 0=residential, 3-4=data center */
  tier?: number;
  uptimePct?: number;
  city?: string;
  pricePerHr?: number;
  cpuCores?: number;
  ramGb?: number;
  [key: string]: unknown;
}

export interface ModalProviderMeta {
  provider: 'modal';
  appName?: string;
  region?: string;
  [key: string]: unknown;
}

export interface FlyioProviderMeta {
  provider: 'flyio';
  costPerHr?: number;
  createdAt?: string;
  [key: string]: unknown;
}

export interface ScalewayProviderMeta {
  provider: 'scaleway';
  zone?: string;
  commercialType?: string;
  pricePerHr?: number;
  tags?: string[];
  [key: string]: unknown;
}

/** Generic fallback metadata for providers that haven't been explicitly typed yet. */
export interface GenericProviderMeta {
  provider: string;
  [key: string]: unknown;
}

/** Union of all provider-specific metadata shapes. Discriminate on `.provider`. */
export type ProviderMeta =
  | RunpodProviderMeta
  | VastProviderMeta
  | TensordockProviderMeta
  | ModalProviderMeta
  | FlyioProviderMeta
  | ScalewayProviderMeta
  | GenericProviderMeta;

export interface GpuInstance {
  instanceId: string;
  instanceName?: string;
  endpoint: string;
  monitorUrl?: string;
  ipAddress?: string;
  status: string;
  gpuType?: string;
  portForwards?: Array<{ internal_port: number; external_port: number }>;
  /** SSH host for fallback health checks (e.g. Vast.ai without direct ports) */
  sshHost?: string;
  /** SSH port for fallback health checks */
  sshPort?: number;
  /** Provider-specific metadata. Discriminated union — narrow on `meta.provider`. */
  providerMeta?: ProviderMeta;
}

export interface InstanceSpec {
  gpuTypes?: string[];
  gpuCount?: number;
  /** Create a CPU-only pod (no GPU). When set to 'CPU', gpuTypes is ignored. */
  computeType?: 'GPU' | 'CPU';
  /** RunPod CPU flavor IDs for CPU-only pods (e.g. ['cpu3c', 'cpu5c']). Tried in order. */
  cpuFlavorIds?: string[];
  vcpus?: number;
  ramGb?: number;
  storageGb?: number;
  /** Which settings key to persist the new instance under */
  machineKey?: 'runpodPod' | 'runpodPod2' | 'tensordockInstance' | 'tensordockInstance2' | 'vastInstance' | 'vastInstance2';
  hfRepoUrl?: string;
  dockerImage?: string;
  hfToken?: string;
  /** Extra environment variables to inject into the container */
  env?: Record<string, string>;
  /** Vast.ai template hash ID — pre-configured image/env/ports for faster boot */
  templateHashId?: string;
  /** Cancel creation immediately if GPU unavailable (Vast.ai fail-fast) */
  cancelUnavail?: boolean;
  /** Region filter (e.g. 'US', 'EU' for Vast; 'US-TX-3' for RunPod; city name for TensorDock) */
  region?: string;
  /** Startup script to run on boot (Vast.ai onstart). Defaults to '/app/start.sh'. */
  onstart?: string;
  /** Override Docker CMD (RunPod dockerStartCmd). Used for custom boot scripts like Docker builders. */
  dockerStartCmd?: string;
  /** Install deps directly on VM instead of Docker (faster boot, no Docker overhead) */
  bareMetal?: boolean;
  /** Ports to expose on the instance (RunPod format, e.g. ['8000/http', '22/tcp']). Defaults to provider-specific defaults. */
  ports?: string[];
  /** RunPod cloud type. IMPORTANT: ALWAYS use 'SECURE'. NEVER use 'COMMUNITY' — community
   *  machines are unreliable third-party hardware that frequently die mid-task. */
  cloudType?: 'COMMUNITY' | 'SECURE';
  /** RunPod interruptible (spot) instance. Default false (on-demand). Set true for cheaper spot pricing. */
  interruptible?: boolean;
  /** RunPod container disk size in GB (overlay filesystem at /). Default ~10GB. Increase for workloads
   *  that install pip packages, download models to ~/.cache, or write temp files outside /workspace. */
  containerDiskInGb?: number;
  /** RunPod Network Volume ID. When provided, attaches an existing network volume at /workspace.
   *  Pre-caching LLM GGUFs on a network volume eliminates ~5-10min download on each cold boot. */
  volumeId?: string;
  /** Extra search filters passed to the provider API (e.g. Vast.ai { direct_port_count: { gte: 1 } }) */
  extraSearch?: Record<string, unknown>;
  /** Vast.ai-only: cap on hourly price for offer search. Filters out offers above this dph_total. */
  maxPricePerHr?: number;
  /** Vast.ai-only: number of parallel deploy attempts (race). Default 2, max 5.
   *  Useful because Vast.ai hosts often reclaim/fail mid-boot — racing N hosts increases success rate. */
  raceCount?: number;
}

// ── GPU Offer Discovery ───────────────────────────────────────────────────

export interface GpuOffer {
  provider: string;
  gpuType: string;
  gpuName: string;
  available: number;
  pricePerHr: number;
  /** Spot (interruptible) price per hour, or 0 if spot is unavailable. */
  spotPricePerHr?: number;
  region: string;
  vram: number;
  offerId?: string;

  // Extended fields (optional — not all providers populate these)
  /** Human-readable geolocation, e.g. "France, FR" or "California, US" */
  geolocation?: string;
  /** Host reliability score (0–1) */
  reliability?: number;
  /** Download speed in Mbps */
  inetDown?: number;
  /** Upload speed in Mbps */
  inetUp?: number;
  /** Provider-specific host identifier */
  hostId?: string;
  /** CPU model name, e.g. "AMD EPYC 7453" */
  cpuName?: string;
  /** Effective CPU cores */
  cpuCores?: number;
  /** Total system RAM in GB */
  ramGb?: number;
  /** Available disk space in GB */
  diskGb?: number;
  /** Number of GPUs in this offer */
  numGpus?: number;
  /** Total GPU FLOPS */
  totalFlops?: number;
  /** Provider-specific host IP (for direct connections) */
  hostIp?: string;
  /** Direct port for host connection */
  hostDirectPort?: number;
  /** Disk read bandwidth in MB/s (for SSD detection) */
  diskBwReadMbps?: number;
}

export interface ListOffersOptions {
  gpuTypes?: string[];
  region?: string;
  limit?: number;
}

/** Callback to persist instance data to the host app's settings store. */
export type OnInstancePersist = (userId: string, machineKey: string, data: Record<string, unknown>) => Promise<void>;

export interface GpuProviderClient {
  readonly providerId: string;
  /** Average cold-start time in seconds (includes model download). Used for boot-timeout calculations. */
  readonly bootTimeSecs: number;
  discoverInstance(credentials: ProviderCredentials, gpuTypes: string[]): Promise<GpuInstance | null>;
  createInstance(spec: InstanceSpec, credentials: ProviderCredentials, userId?: string): Promise<GpuInstance>;
  startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void>;
  stopInstance(instanceId: string, credentials: ProviderCredentials): Promise<void>;
  deleteInstance(instanceId: string, credentials: ProviderCredentials): Promise<void>;
  getInstanceStatus(instanceId: string, credentials: ProviderCredentials): Promise<string | null>;
  /** List all instances on the account (for cost monitoring / orphan detection). */
  listInstances(credentials: ProviderCredentials): Promise<GpuInstance[]>;
  /** Re-resolve endpoint for an existing instance (e.g. to get direct IP after initial proxy). */
  resolveInstanceEndpoint(instanceId: string, credentials: ProviderCredentials): Promise<string | null>;
  /** Provider-specific health check (e.g. SSH exec for Vast.ai when HTTP is unreachable) */
  checkHealth?(instanceId: string, credentials: ProviderCredentials): Promise<boolean>;
  /** Reboot instance (stop/start container) without losing GPU priority */
  rebootInstance?(instanceId: string, credentials: ProviderCredentials): Promise<void>;
  /** Take a snapshot of a running instance and push to a container registry */
  takeSnapshot?(instanceId: string, credentials: ProviderCredentials): Promise<string | null>;
  /** Get hourly cost for a running instance, or null if not available. */
  getInstanceCost?(instanceId: string, credentials: ProviderCredentials): Promise<number | null>;
  /** Retrieve recent container logs, or null if not supported. */
  getInstanceLogs?(instanceId: string, credentials: ProviderCredentials, lines?: number): Promise<string | null>;
  /** List available GPU offers with real-time pricing and availability. */
  listOffers?(options: ListOffersOptions, credentials: ProviderCredentials): Promise<GpuOffer[]>;
}

/**
 * @deprecated All providers now implement `listInstances` directly on `GpuProviderClient`.
 * Use `GpuProviderClient` instead.
 */
export type MonitorableProvider = GpuProviderClient;
