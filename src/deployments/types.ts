/**
 * Deployments — a named Docker image served by N replicas on rented machines, scaled by load.
 *
 * Vocabulary:
 *   - **Deployment**: the spec a caller registers (`PUT /v1/deployments/:name`): image, port, machine type,
 *     replica bounds, idle policy. Persisted by a `DeploymentStore`.
 *   - **Profile**: a reusable, named partial spec (e.g. `qwen3-tts`). A deployment created with
 *     `{ profile: 'qwen3-tts' }` starts from it and overrides fields.
 *   - **Replica**: one machine running the image. The provider (Scaleway) is the source of truth for which
 *     replicas exist — they are found by tag, so a gateway restart never loses track of a billed machine.
 *
 * Backends: Scaleway (`provider: 'scaleway'`, datacenter VMs, any image) and Vast.ai (`provider: 'vast'`, marketplace
 * GPU hosts, boot-script mode only). A spec may list `candidates` across both (placement ladder, `placements.ts`).
 */

export type DeploymentProvider = 'scaleway' | 'vast';

/**
 * One rung of the placement ladder: where a replica may run and the most it may cost there. The controller tries the
 * candidates best first (`rankCandidates`: near the users, then cheap) and the first that rents wins.
 */
export interface PlacementCandidate {
  /** Default: the spec's `provider`. */
  provider?: DeploymentProvider;
  /** Scaleway zone (default: the spec's `zone`); ignored on Vast (the backend picks the host near `near`). */
  zone?: string;
  /** Scaleway commercial type (`L4-1-24G`) or Vast GPU name (`RTX 5090`). */
  machineType: string;
  maxEurPerHour: number;
}

export interface RegistryAuth {
  server?: string;
  username: string;
  password: string;
}

export interface DeploymentSpec {
  /** Slug, `[a-z0-9-]`, 2–40 chars. Part of the URL and of the machine tag. */
  name: string;
  provider: DeploymentProvider;
  /** Docker image reference, e.g. `vllm/vllm-omni:v0.28.0` or `ghcr.io/me/app:1`. Empty in boot-script mode. */
  image: string;
  /** Port the container listens on (ignored in boot-script mode: the script serves 127.0.0.1:8000). */
  port: number;
  /**
   * Boot-script mode: instead of `docker run image`, the replica runs this bash script as root after the gateway's
   * token-gated nginx is up. The script must serve the app on `127.0.0.1:8000` and answer `healthPath` there once
   * ready. For apps that need more than one container (reference files, warm-up, sidecars). Never returned by the API.
   */
  bootScript?: string;
  /**
   * Extra files, base64 by key (≤ 1.68 MB in total). They are packed into user_data and rebuilt at
   * `/srv/aigw/files/<key>` before the app starts (`file-pack.ts`); a Docker app sees them read-only at `/files`.
   * Never returned by the API.
   */
  files?: Record<string, string>;
  /** Overrides the image entrypoint. */
  entrypoint?: string;
  /** Arguments passed after the image (the container command). */
  args: string[];
  /** Environment for the container. Never returned by the API (values may be secrets). */
  env: Record<string, string>;
  /**
   * Environment presets per `machineType` (`{ "L40S-1-48G": { STT_BATCH: "8" } }`): the entry for the spec's
   * machine type is merged under `env` at build time, so a profile can carry tuned GPU settings (an L4 and an
   * L40S need different STT/TTS concurrency) while an explicit `env` value still wins. Never returned by the API.
   */
  envByMachineType?: Record<string, Record<string, string>>;
  /** Credentials for a private registry. Never returned by the API. */
  registryAuth?: RegistryAuth;
  /** Path the replica answers 2xx on once the model is loaded. */
  healthPath: string;
  /** Scaleway commercial type, e.g. `L4-1-24G` (GPU) or `DEV1-S` (CPU). */
  machineType: string;
  zone: string;
  /**
   * Where else a replica may go when `zone`/`machineType` is out of stock, tried in order (each entry overrides the
   * zone, the type or both). Scaleway GPUs run out per zone and per type (2026-10-06: L4 and L40S in shortage in
   * fr-par-1, fr-par-2 and pl-waw-2, only L4 "scarce" in pl-waw-2), so one fixed placement leaves the deployment
   * without a replica while another zone still has one. Every entry still obeys `maxEurPerHour`. An exposed
   * deployment keeps its zone (its reserved IP lives there): only `machineType` may change.
   */
  placements?: Placement[];
  /** Scaleway OS image id; default: GPU OS image for GPU types, Ubuntu for CPU types. */
  osImageId?: string;
  volumeGb?: number;
  /** Request the GPU inside the container (`--gpus all`). Default: true for GPU machine types. */
  gpu: boolean;
  minReplicas: number;
  maxReplicas: number;
  /**
   * Replicas kept while the deployment is in use (a request in the last `idleMinutes`), regardless of load —
   * redundancy for a live session. Default 1. Idle, it goes back to `minReplicas`.
   */
  minActiveReplicas: number;
  /** In-flight requests one replica should carry before another is added. */
  targetInflightPerReplica: number;
  /** With no request for this long the deployment scales down to `minReplicas` (0 = scale to zero). */
  idleMinutes: number;
  /** A replica not ready after this long is replaced. */
  bootTimeoutMinutes: number;
  /** Extra replicas (above the idle base) are removed only after load stayed low this long. */
  scaleDownDelaySeconds: number;
  /** How long an invoke waits for a replica during a cold start before answering 503 + Retry-After. */
  coldStartWaitSeconds: number;
  /** Refuse to create a replica whose catalog price is above this (EUR/h). */
  maxEurPerHour: number;
  /** Hard lifetime of a machine (safety net); it is replaced when reached. */
  maxHours: number;
  /** Paused deployments keep their spec but run no replicas and refuse invokes. */
  paused: boolean;
  /**
   * Reached from the internet on these ports, not only through the gateway (WebRTC, TLS with its own certificate):
   * a reserved IP that outlives the replicas (DNS keeps pointing at it), a firewall that opens only these ports plus
   * the probe port, and the gateway's token-gated probe moved to `PROBE_PORT` so 80/443 stay with the app. The app
   * (boot-script mode) serves its health on `127.0.0.1:<port>`.
   */
  exposure?: { ports: ExposedPort[] };
  /**
   * What going idle does: `delete` (default) removes the machine; `stop` powers it off and keeps its disk, IP and
   * firewall (billed for disk and IP only), and the next demand powers it back on (~2 min instead of a full boot).
   */
  idleAction?: 'delete' | 'stop';
  /** Placement ladder (≤ 20). Absent: one place only, `zone` + `machineType` + `maxEurPerHour` (on `provider`). */
  candidates?: PlacementCandidate[];
  /** ISO country the users are in (latency preference); default `DEFAULT_NEAR` (placements.ts). */
  near?: string;
  /** Accept a far host/zone (outside the EU/EEA) when nothing nearer exists. Default false. */
  allowFar?: boolean;
}

export interface ExposedPort { protocol: 'tcp' | 'udp'; port: number }

/** An alternative placement of a replica (see `DeploymentSpec.placements`). */
export interface Placement { zone?: string; machineType?: string }

/** Reserved IP and firewall of an exposed deployment (`exposure`), kept across replicas. */
export interface DeploymentNetwork { zone: string; ipId: string; ip: string; groupId: string }

/** Fields a profile may preset. */
export type ProfileSpec = Partial<Omit<DeploymentSpec, 'name'>> & { description?: string };

export interface Profile {
  name: string;
  spec: ProfileSpec;
  builtin: boolean;
}

/** Durable per-deployment state besides the spec. */
export interface DeploymentRecord {
  spec: DeploymentSpec;
  /** Shared secret the replica's front proxy requires (`X-Aigw-Token`). */
  replicaToken: string;
  createdAt: number;
  updatedAt: number;
  lastRequestAt: number | null;
  /** App account that owns the deployment (see apps.ts); absent on deployments made before app accounts. */
  app?: string;
  /** Saved image of the app it was deployed from (`appImage`), for traceability. */
  appImage?: string;
  /** Exposed deployments: reserved IP and firewall, created with the first replica and deleted with the deployment. */
  network?: DeploymentNetwork;
}

export type ReplicaPhase = 'booting' | 'ready' | 'unhealthy' | 'halted';

/** One machine as the provider reports it. */
export interface ReplicaMachine {
  id: string;
  deployment: string;
  ip: string | null;
  /** Provider state, e.g. `running`, `starting`, `stopped`, `stopped in place`. */
  state: string;
  createdAt: number;
  zone: string;
  machineType: string;
  pricePerHour: number | null;
  /** Backend that owns the machine (set by the controller from the backend that listed/created it). */
  provider?: DeploymentProvider;
}

export interface CreateReplicaInput {
  spec: DeploymentSpec;
  replicaToken: string;
  cloudInit: string;
  namespace: string;
  /** user_data keys → bytes (boot-script `files`). */
  files?: Record<string, Uint8Array>;
  /** Exposed deployments: the reserved IP and firewall the replica attaches to. */
  network?: DeploymentNetwork;
}

/** What the controller needs from a cloud. Implemented by `ScalewayDeploymentBackend` (and fakes in tests). */
export interface DeploymentBackend {
  readonly provider: DeploymentProvider;
  createReplica(input: CreateReplicaInput): Promise<ReplicaMachine>;
  /** Every replica of every deployment of this namespace. Must throw (not return []) when the provider fails. */
  listReplicas(namespace: string): Promise<ReplicaMachine[]>;
  /** `reason` is the planner's (`boot-timeout`, `scale-down`, …): a backend may learn from it (Vast avoids bad hosts). */
  releaseReplica(machine: ReplicaMachine, reason?: string): Promise<void>;
  /** Exposed deployments: reserve the IP and create the firewall (`known` is reused when it still exists). */
  ensureNetwork?(spec: DeploymentSpec, namespace: string, known?: DeploymentNetwork): Promise<DeploymentNetwork>;
  releaseNetwork?(network: DeploymentNetwork): Promise<void>;
  /** `idleAction: 'stop'`: power off keeping disk and IP, and power back on. */
  stopReplica?(machine: ReplicaMachine): Promise<void>;
  startReplica?(machine: ReplicaMachine): Promise<void>;
  /** Catalog price (EUR/h), `null` when the type is not sold in the zone. */
  hourlyPrice(zone: string, machineType: string): Promise<number | null>;
  /**
   * The backend picks a market offer under `spec.maxEurPerHour` itself at create (Vast): the controller skips the
   * catalog price check (`hourlyPrice` means nothing per zone there).
   */
  readonly marketPriced?: boolean;
  /** Price + stock of types in zones, for ranking `candidates` (Scaleway). Absent: candidates are ranked without it. */
  catalog?(zones: string[]): Promise<CatalogEntry[]>;
  /**
   * Credentials for an image in the provider's own registry, used when the spec has no `registryAuth` — so a caller
   * deploying `rg.fr-par.scw.cloud/…` never has to send (and the gateway never stores) a registry secret. `null` for
   * any other registry.
   */
  registryAuthFor?(image: string): RegistryAuth | null;
}

export interface CatalogEntry { zone: string; machineType: string; hourlyPrice: number | null; availability: string | null }

/** How the controller reaches a replica's HTTP front. */
export interface ReplicaProbe {
  /** `true` when the replica finished booting (`/__aigw/ready`) and the app answers its health path. */
  ready(machine: ReplicaMachine, spec: DeploymentSpec, token: string): Promise<boolean>;
}

export interface DeploymentStore {
  load(): Promise<{ deployments: DeploymentRecord[]; profiles: Profile[] }>;
  saveDeployment(record: DeploymentRecord): Promise<void>;
  deleteDeployment(name: string): Promise<void>;
  saveProfile(profile: Profile): Promise<void>;
  deleteProfile(name: string): Promise<void>;
}

export interface ReplicaView {
  id: string;
  phase: ReplicaPhase;
  ip: string | null;
  providerState: string;
  zone: string;
  machineType: string;
  pricePerHour: number | null;
  ageSeconds: number;
  inflight: number;
}

export interface DeploymentView {
  name: string;
  spec: Omit<DeploymentSpec, 'env' | 'envByMachineType' | 'registryAuth' | 'bootScript' | 'files'> & {
    envKeys: string[]; privateRegistry: boolean; bootScript: boolean; fileKeys: string[];
  };
  status: 'paused' | 'scaled-to-zero' | 'warming' | 'ready' | 'degraded';
  desiredReplicas: number;
  replicas: ReplicaView[];
  inflight: number;
  waiting: number;
  lastRequestAt: string | null;
  lastError: string | null;
  invokeUrl: string;
  app: string | null;
  appImage: string | null;
  /** Exposed deployments: the reserved IP clients connect to (it outlives replicas); null otherwise. */
  publicIp: string | null;
  /** Where the last replica landed and why earlier candidates were skipped (null before the first create). */
  lastPlacement: string | null;
}
