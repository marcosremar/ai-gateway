export interface ProviderCredentials {
  apiKey: string;
  /** TensorDock marketplace v0 Authorization ID */
  authId?: string;
  hfToken?: string;
}

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
  /** Provider-specific metadata for host reputation tracking */
  providerMeta?: Record<string, unknown>;
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
