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
 * Only Scaleway is supported as a backend for now (`provider: 'scaleway'`).
 */

export type DeploymentProvider = 'scaleway';

export interface RegistryAuth {
  server?: string;
  username: string;
  password: string;
}

export interface DeploymentSpec {
  /** Slug, `[a-z0-9-]`, 2–40 chars. Part of the URL and of the machine tag. */
  name: string;
  provider: DeploymentProvider;
  /** Docker image reference, e.g. `vllm/vllm-omni:v0.28.0` or `ghcr.io/me/app:1`. */
  image: string;
  /** Port the container listens on. */
  port: number;
  /** Overrides the image entrypoint. */
  entrypoint?: string;
  /** Arguments passed after the image (the container command). */
  args: string[];
  /** Environment for the container. Never returned by the API (values may be secrets). */
  env: Record<string, string>;
  /** Credentials for a private registry. Never returned by the API. */
  registryAuth?: RegistryAuth;
  /** Path the replica answers 2xx on once the model is loaded. */
  healthPath: string;
  /** Scaleway commercial type, e.g. `L4-1-24G` (GPU) or `DEV1-S` (CPU). */
  machineType: string;
  zone: string;
  /** Scaleway OS image id; default: GPU OS image for GPU types, Ubuntu for CPU types. */
  osImageId?: string;
  volumeGb?: number;
  /** Request the GPU inside the container (`--gpus all`). Default: true for GPU machine types. */
  gpu: boolean;
  minReplicas: number;
  maxReplicas: number;
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
}

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
}

export interface CreateReplicaInput {
  spec: DeploymentSpec;
  replicaToken: string;
  cloudInit: string;
  namespace: string;
}

/** What the controller needs from a cloud. Implemented by `ScalewayDeploymentBackend` (and fakes in tests). */
export interface DeploymentBackend {
  readonly provider: DeploymentProvider;
  createReplica(input: CreateReplicaInput): Promise<ReplicaMachine>;
  /** Every replica of every deployment of this namespace. Must throw (not return []) when the provider fails. */
  listReplicas(namespace: string): Promise<ReplicaMachine[]>;
  releaseReplica(machine: ReplicaMachine): Promise<void>;
  /** Catalog price (EUR/h), `null` when the type is not sold in the zone. */
  hourlyPrice(zone: string, machineType: string): Promise<number | null>;
}

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
  spec: Omit<DeploymentSpec, 'env' | 'registryAuth'> & { envKeys: string[]; privateRegistry: boolean };
  status: 'paused' | 'scaled-to-zero' | 'warming' | 'ready' | 'degraded';
  desiredReplicas: number;
  replicas: ReplicaView[];
  inflight: number;
  waiting: number;
  lastRequestAt: string | null;
  lastError: string | null;
  invokeUrl: string;
}
