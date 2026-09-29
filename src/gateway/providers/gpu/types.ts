export interface ProviderCredentials {
  apiKey: string;
  /** TensorDock marketplace v0 Authorization ID */
  authId?: string;
  hfToken?: string;
  /** Trace ID for correlating gateway requests with provider-side logs. */
  traceId?: string;
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
  /** SBS volume IDs attached at create (deleted on destroy). */
  volumeIds?: string[];
  /** Raw Scaleway state ('running', 'stopped', 'stopped in place', 'stopping', …) — `status` is normalized and
   *  folds 'stopping' into 'stopped', which hosts that poweroff/poweron need to tell apart. */
  state?: string;
  /** Server creation time (ISO), for max-lifetime and boot-deadline policies. */
  createdAt?: string;
  /** Reserved IP ids attached to the server (routed IPv4 kept across poweroff). */
  publicIpIds?: string[];
  [key: string]: unknown;
}

export interface RailwayProviderMeta {
  provider: 'railway';
  environmentId?: string;
  serviceName?: string;
  dockerImage?: string;
  [key: string]: unknown;
}

export interface SnapgpuProviderMeta {
  provider: 'snapgpu';
  /** Underlying provider that hosts the snapgpu container. */
  backendProvider?: 'vast' | 'runpod';
  /** Resolved snapgpu Docker image. */
  snapgpuImage?: string;
  /** ID of the snapshot used to restore this boot, if any. */
  restoredFromSnapshotId?: string;
  /** Most recent snapshot captured for this instance. */
  latestSnapshotId?: string;
  [key: string]: unknown;
}

export interface HyperstackProviderMeta {
  provider: 'hyperstack';
  flavorId?: string | number;
  flavorName?: string;
  region?: string;
  createdAt?: string;
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
  | RailwayProviderMeta
  | SnapgpuProviderMeta
  | HyperstackProviderMeta
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
  /** Human-readable instance label/name to show in provider consoles. */
  label?: string;
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
  /** Custom health check endpoint path. Defaults to '/health'. The gateway's
   *  boot health monitor probes this path; if it returns 200 the instance is
   *  marked ready. Setting this lets apps use /healthz, /api/status, etc. */
  healthEndpoint?: string;
  /** Force SSH tunnel for Vast.ai instances (skip direct-port endpoint).
   *  Use this when targeting residential hosts whose NAT/firewall accepts
   *  TCP SYN packets for the mapped port even when the container app isn't
   *  listening yet — the gateway's direct-port probe gives a false positive
   *  and never falls back to the (working) SSH tunnel. */
  forceSshTunnel?: boolean;
  /** Minimum number of direct ports the host must have. Vast.ai residential
   *  hosts often have direct_port_count=0 (only SSH access), which forces
   *  SSH tunneling and breaks apps that need multiple direct ports. Set to
   *  1 to require at least one direct port (for an HTTP API like FastAPI on :8000),
   *  or 2 to also require :22 for direct SSH. */
  directPortRequired?: number;
  /** Minimum inet_down (Mbps) the host must have. If not set, auto-computed
   *  from image size: imageGb * 8 * 1024 / pullBudgetSec. Default pullBudgetSec=600
   *  so a 15GB image requires ~200 Mbps minimum to pull within 10 minutes. */
  minInetDownMbps?: number;
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
  /** Vast.ai-only: require direct-port, high-reliability offers and skip SSH-only fallback for faster boot. */
  strictFastBoot?: boolean;
  /** Vast.ai-only: offer search mode. 'high_quality' (default) keeps the
   *  reliability-tier filter; 'full' widens the search to all rentable offers. */
  searchMode?: 'high_quality' | 'full';
  /**
   * Vast.ai-only: offer quality policy.
   * - `'default'` — existing search + relaxation (inet_down floor may be ≤500 when unset)
   * - `'desktop'` — babylon desktop floor: reliability ≥ 0.95, inet_down > 1000 Mbps,
   *   max ~$0.20/hr (`maxPricePerHr` or default). Does not relax below those floors.
   */
  offerPolicy?: 'default' | 'desktop';
  /** Vast.ai-only: opt-in to deverified/unverified hosts when no verified offer is rentable.
   *  Trade-off: lower availability blocker, but host may be reclaimed mid-boot.
   *  Default false (verified-only, safer). */
  allowUnverified?: boolean;
  /** Snapgpu-only: which underlying backend provider to deploy on (vast/runpod).
   *  Snapgpu has no hardware of its own — it's a capability layer. */
  snapgpuBackend?: 'vast' | 'runpod';
  /** Snapgpu-only: name of an `App` (snapgpu Python decorator) to preload at boot.
   *  Causes the gateway to call the app's @enter(snap=True) hooks before the
   *  first /v1/invoke request, so model load happens during cold boot, not on the request path. */
  snapgpuPreloadApp?: string;
  /** Snapgpu-only: snapshot ID to restore from on cold boot. If set, the gateway
   *  skips fresh model load and resumes the captured CPU+GPU state instead.
   *  Persisted across deploys via the autoscaler's onInstancePersist hook. */
  snapgpuRestoreFromSnapshot?: string;
  /** Snapgpu-only: when true, the autoscaler should snapshot the running container
   *  after the first successful inference (so the next cold boot is fast). */
  autoSnapshot?: boolean;
  /** Vast.ai: use an identity port (>70000) for stable, predictable external access.
   * Maps external port 70008 → container port 8000. Because Vast.ai gives identity
   * mapping to ports > 70000 (external == requested host port, not randomized),
   * the service is always at ip:70008 without parsing a random port mapping.
   * Requires the host to have at least one direct port allocated. */
  useIdentityPort?: boolean;
  /** Optional callback invoked periodically during instance creation polling.
   *  Receives ({elapsedS, status, instanceId, ip, sshHost, sshPort}).
   *  Allows callers to broadcast progress updates to show the user
   *  that creation is still in progress (e.g., "Pulling image... 45s"). */
  onPollProgress?: (info: { elapsedS: number; status: string; instanceId: string; ip: string; sshHost?: string; sshPort?: number }) => void;
  /** Image override. Hyperstack: numeric Custom OS Image id. Scaleway: marketplace
   *  image UUID string. Preferred over `imageName` where both apply. */
  imageId?: string | number;
  /** Hyperstack-only: pin the VM create to a specific image by name. Useful
   *  for ad-hoc testing; most deploys should use `imageId` instead. */
  imageName?: string;
  /** Scaleway commercial type override (e.g. 'L4-1-24G', 'DEV1-XL'). */
  commercialType?: string;
  /** Raw cloud-init / boot script (bash). When set, used instead of docker bot user-data. */
  cloudInit?: string;
  /** Scaleway SBS root volume size in GB. When set (or commercialType is GPU), attach sbs_volume. */
  volumeGb?: number;
  /** Extra tags for the instance (merged with defaults). */
  tags?: string[];
  /** Scaleway project ID override (else resolve from API key). */
  projectId?: string;
  /** Scaleway: extra user_data keys written before power-on (the cloud-init key has a size limit, so large
   *  payloads such as reference audio go in their own keys and the boot script fetches them from the metadata API). */
  userDataFiles?: Record<string, string | Uint8Array>;
  /** Scaleway: attach these reserved IPs (see `reserveRoutedIp`) instead of a dynamic one — the address survives
   *  poweroff and delete, so DNS pointing at it stays valid. */
  publicIpIds?: string[];
  /** Scaleway: security group (firewall) to attach, see `createSecurityGroup`. */
  securityGroupId?: string;
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
  /** Recycle instance (re-pull image + recreate container) without losing GPU priority */
  recycleInstance?(instanceId: string, credentials: ProviderCredentials): Promise<void>;
  /** Change bid price on an interruptible instance (Vast.ai only) */
  changeBid?(instanceId: string, bidPricePerHr: number, credentials: ProviderCredentials): Promise<void>;
  /** Take a snapshot of a running instance and push to a container registry */
  takeSnapshot?(instanceId: string, credentials: ProviderCredentials): Promise<string | null>;
  /** Get hourly cost for a running instance, or null if not available. */
  getInstanceCost?(instanceId: string, credentials: ProviderCredentials): Promise<number | null>;
  /** Retrieve recent container logs, or null if not supported. Pass `filter` to grep-filter lines. */
  getInstanceLogs?(instanceId: string, credentials: ProviderCredentials, lines?: number, filter?: string): Promise<string | null>;
  /** List available GPU offers with real-time pricing and availability. */
  listOffers?(options: ListOffersOptions, credentials: ProviderCredentials): Promise<GpuOffer[]>;
  /** Dispose of provider resources (timers, connections, etc.). */
  dispose?(): void;
}

/**
 * @deprecated All providers now implement `listInstances` directly on `GpuProviderClient`.
 * Use `GpuProviderClient` instead.
 */
export type MonitorableProvider = GpuProviderClient;
