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

import type { HostRecord } from './host-reputation';
import type { RttBaseline } from './rtt-gate';

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
   * deployment keeps its zone (its reserved IP lives there): only `machineType` may change. An entry with `provider`
   * runs there, with its own `machineType`, `maxEurPerHour` and `maxReplicas` (the most that provider may hold).
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
  /** Pressure-based autoscaling knobs (scale-out threshold, window, latency / error targets, overflow, drain). */
  autoscale?: AutoscaleSpec;
  /** Warm-up windows: keep N replicas up on a schedule (a class at 9:00), whatever the load. */
  warmSchedule?: WarmScheduleEntry[];
  reserveQuota?: QuotaReservation;
  scaling?: ScalingSpec;
  /** With no request for this long the deployment scales down to `minReplicas` (0 = scale to zero). */
  idleMinutes: number;
  /** A replica not ready after this long is replaced. */
  bootTimeoutMinutes: number;
  /** Extra replicas (above the idle base) are removed only after load stayed low this long. */
  scaleDownDelaySeconds: number;
  /**
   * How long an invoke waits for a replica during a cold start before answering 503 + Retry-After. The gateway caps the
   * wait at DEPLOYMENTS_MAX_WAIT_SECONDS (default 240): the platform in front cuts a request with no bytes at 5 min.
   */
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
  fileUrls?: Record<string, FileUrl>;
  /**
   * Realtime voice on this replica (docs/realtime-edge.md): the generic `aigw-edge` sidecar runs next to the model
   * container (`docker run --network host`, same on any GPU and any model image), terminates WebRTC (UDP `udpPorts`)
   * and the gateway-relayed WebSocket behind the token-gated nginx (`/__aigw/rt/*`), and calls the model over
   * 127.0.0.1. On Vast (one container per host: no sidecar) the edge runs as a process of that container and each UDP
   * port is mapped on its own (`vastReplicaInit`, `realtime-ports.ts`).
   */
  realtime?: RealtimeSpec;
  /**
   * What going idle does: `delete` (default) removes the machine; `stop` powers it off and keeps its disk, IP and
   * firewall (billed for disk and IP only), and the next demand powers it back on (~2 min instead of a full boot).
   */
  idleAction?: 'delete' | 'stop';
  /** Placement ladder (≤ 20). Absent: one place only, `zone` + `machineType` + `maxEurPerHour` (on `provider`). */
  candidates?: PlacementCandidate[];
  /** ISO country the users are in (latency preference); default `DEFAULT_NEAR` (placements.ts). */
  near?: string;
  /** Accept a far host/zone (beyond `MAX_NEAR_KM` of `near`) when nothing nearer exists. Default false. */
  allowFar?: boolean;
  /**
   * Vast: a freshly rented host whose measured RTT from the gateway (median, ms) is above this is released as
   * `too-far` and avoided 24 h (`rtt-gate.ts`). With a baseline (see `maxRttExcessMs`) it is an optional upper bound;
   * without one it is the whole rule, default `DEFAULT_MAX_RTT_MS` (35, measured from NL).
   */
  maxRttMs?: number;
  maxRttExcessMs?: number;
  /**
   * Vast: lowest CUDA version the host driver must support (`cuda_max_good`), for the image's own CUDA. A driver older
   * than the image's runtime fails at the first CUDA call (error 804, "forward compatibility"): vllm/vllm-omni v0.28 is
   * CUDA 13.0 (torch 2.13+cu130, driver ≥ 580) and a 5090 host on driver 570 (CUDA 12.8) could not start it (2026-10-06). Never below the GPU's own floor
   * (`minCudaFor`).
   */
  minCuda?: number;
}

export interface FileUrl { url: string; sha256: string }

/** One exposed port, or the range `port`..`to` (e.g. a TURN relay range). */
export interface ExposedPort { protocol: 'tcp' | 'udp'; port: number; to?: number }

/** `DeploymentSpec.realtime`: the edge sidecar's knobs. */
export interface RealtimeSpec {
  /** Concurrent realtime sessions per replica (`RT_MAX_SESSIONS`). Default: the machine type's `RT_MAX_SESSIONS` env, else 8. */
  maxSessions?: number;
  /** Edge image; default `DEFAULT_EDGE_IMAGE` (cloud-init.ts). */
  edgeImage?: string;
  /** UDP range for WebRTC media, opened in the replica's firewall. Default `DEFAULT_RT_UDP_PORTS`. */
  udpPorts?: [number, number];
  /** Edge settings written to the sidecar's env (`EDGE_TUNING_KEYS` in spec.ts); the keys the gateway sets itself win. */
  env?: Record<string, string>;
  requireWebrtc?: boolean;
}

/** An alternative placement of a replica (see `DeploymentSpec.placements`). */
export interface Placement { provider?: DeploymentProvider; zone?: string; machineType?: string; maxEurPerHour?: number; maxReplicas?: number; image?: string }

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
  /** Client warm window (`POST /v1/deployments/:name/warm`): keep `replicas` up until `until` (ms). */
  warm?: { replicas: number; until: number };
  hold?: ScalingHold;
  spend?: { month: string; eur: number; at: number };
  measured?: Record<string, MeasuredTimes>;
}

/**
 * One window of the warm-up schedule: from `start` to `end` (`HH:MM`, local to `timeZone`, default Europe/Paris; an `end`
 * before `start` runs past midnight) on `days` (0 = Sunday; absent = every day), keep at least `minReplicas` up.
 */
export interface WarmScheduleEntry {
  days?: number[];
  start: string;
  end: string;
  timeZone?: string;
  minReplicas: number;
}

export interface QuotaReservation {
  quota: number;
  windows: WarmScheduleEntry[];
}

export interface ReservationView {
  holder: string;
  machineType: string;
  quota: number;
  windows: WarmScheduleEntry[];
  active: { replicas: number; until: string } | null;
}

/** Pressure-based autoscaling knobs (`autoscale.ts`); every one optional, defaults in `AUTOSCALE_DEFAULTS`. */
export interface AutoscaleSpec {
  scaleOutAt?: number;
  scaleInAt?: number;
  windowSeconds?: number;
  latencyP95Ms?: number;
  errorRate?: number;
  maxInflightFactor?: number;
  drainSeconds?: number;
}

export type ScalingMode = 'economy' | 'balanced' | 'fast';

export interface ScalingSpec {
  target?: { p50Ms?: number; p95Ms?: number };
  budget?: { eurPerHour?: number; eurPerMonth?: number; maxReplicas?: number };
  mode: ScalingMode;
}

export interface ScalingHold { replicas: number; until: number }

export interface MeasuredTimes { boot: number[]; resume: number[] }

export interface CapacityTime { seconds: number; source: 'default' | 'measured'; samples: number }

export interface CapacityEntry {
  machineType: string;
  image: string;
  ceiling: { sessions: number; source: 'default' | 'configured' | 'measured'; samples: number };
  boot: CapacityTime;
  resume: CapacityTime;
  confident: boolean;
  missing: string[];
}

export interface CapacityView {
  deployment: string;
  mode: ScalingMode | null;
  target: ScalingSpec['target'] | null;
  budget: (NonNullable<ScalingSpec['budget']> & { month: string; spentEur: number; exhausted: boolean }) | null;
  hold: { replicas: number; until: string } | null;
  capacity: CapacityEntry[];
  reservations: ReservationView[];
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
  /** When the provider takes the host back (Vast rental end, ms); absent when it never does (`expiry.ts`). */
  expiresAt?: number | null;
  placementNote?: string;
  /** The provider reports that this machine's boot cannot succeed (e.g. the image does not exist). */
  bootError?: string;
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
  /**
   * Called with the machine id as soon as the provider has created it, before it is configured and powered on. The
   * controller keeps that machine out of its plan until `createReplica` returns (see `DeploymentController.creatingIds`).
   */
  onCreated?: (machineId: string) => void;
}

/** What the controller needs from a cloud. Implemented by `ScalewayDeploymentBackend` (and fakes in tests). */
export interface DeploymentBackend {
  readonly provider: DeploymentProvider;
  createReplica(input: CreateReplicaInput): Promise<ReplicaMachine>;
  /** Every replica of every deployment of this namespace. Must throw (not return []) when the provider fails. */
  listReplicas(namespace: string): Promise<ReplicaMachine[]>;
  listForeign?(namespace: string): Promise<Array<ReplicaMachine & { namespace: string }>>;
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
  /** RTT (median ms) from the gateway to the replica's front, null when no sample came back (the RTT gate). */
  measureRtt?(machine: ReplicaMachine): Promise<number | null>;
  measureBaselineRtt?(near: string): Promise<RttBaseline | null>;
  recordRtt?(machine: ReplicaMachine, rttMs: number, baselineMs?: number | null): void;
  noteHost?(machine: ReplicaMachine, note: HostNote): void;
  /** Price + stock of types in zones, for ranking `candidates` (Scaleway). Absent: candidates are ranked without it. */
  catalog?(zones: string[]): Promise<CatalogEntry[]>;
  /**
   * Credentials for an image in the provider's own registry, used when the spec has no `registryAuth` — so a caller
   * deploying `rg.fr-par.scw.cloud/…` never has to send (and the gateway never stores) a registry secret. `null` for
   * any other registry.
   */
  registryAuthFor?(image: string): RegistryAuth | null;
  /** Read-only: the market offers a create would try for this spec, best first (Vast). */
  previewOffers?(spec: DeploymentSpec): Promise<OfferPreview[]>;
  offersReport?(spec: DeploymentSpec): Promise<OffersReport>;
}

export interface HostNote { rttMs?: number; baselineMs?: number | null; bootMs?: number; udp?: 'ok' | 'blocked' }

export interface SkippedOffer { offerId: number; machineId: number | null; location: string | null; usdPerHour: number; reason: string }

export interface OffersReport { offers: OfferPreview[]; skipped: SkippedOffer[]; hosts: HostRecord[] }

export interface OfferPreview {
  rank: number;
  wouldTry: boolean;
  offerId: number;
  machineId: number | null;
  location: string | null;
  distanceKm: number;
  usdPerHour: number;
  effectiveUsdPerHour: number;
  reliability: number;
  inetDownMbps: number;
  inetUpMbps: number | null;
  cudaMax: number | null;
  directPorts: number | null;
  gpu: string | null;
  knownRttMs: number | null;
  host?: HostRecord | null;
  gateVerdict?: 'pass' | 'too-far' | null;
}

export interface OffersPreview {
  offers: OfferPreview[];
  skipped: SkippedOffer[];
  hosts: HostRecord[];
  gate: { near: string; rule: 'relative' | 'absolute'; anchor: string | null; baselineMs: number | null; maxRttExcessMs: number; maxRttMs: number | null };
}

export interface CatalogEntry { zone: string; machineType: string; hourlyPrice: number | null; availability: string | null }

/** How the controller reaches a replica's HTTP front. */
/**
 * Liveness and readiness apart: `down` = the replica's front (nginx `/__aigw/ready`) does not answer — the machine or
 * its boot is not there; `busy` = the front answers but the app's health path does not (timeout, 5xx, a stage not
 * ready) — warming during a boot, saturated once it served; `ready` = both answer.
 */
export type ProbeResult = 'ready' | 'busy' | 'down';

export interface ReplicaProbe {
  /** `true` when the replica finished booting (`/__aigw/ready`) and the app answers its health path. */
  ready(machine: ReplicaMachine, spec: DeploymentSpec, token: string): Promise<boolean>;
  /** Liveness + readiness in one answer (`ProbeResult`); probes without it are read as `ready` / `down`. */
  check?(machine: ReplicaMachine, spec: DeploymentSpec, token: string): Promise<ProbeResult>;
}

export interface PendingNetworkRelease {
  deployment: string;
  network: DeploymentNetwork;
  since: number;
  attempts: number;
  lastAttemptAt: number | null;
  lastError: string | null;
}

export interface DeploymentStore {
  load(): Promise<{ deployments: DeploymentRecord[]; profiles: Profile[]; networkReleases?: PendingNetworkRelease[] }>;
  saveDeployment(record: DeploymentRecord): Promise<void>;
  deleteDeployment(name: string, release?: PendingNetworkRelease): Promise<void>;
  deleteNetworkRelease(ipId: string): Promise<void>;
  saveProfile(profile: Profile): Promise<void>;
  deleteProfile(name: string): Promise<void>;
  readonly fresh?: boolean;
  readonly writeError?: string | null;
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
  /** Ready but saturated (health check timed out while it had work): no new request beyond its target. */
  busy: boolean;
  /** Being drained before a scale-in: no new request; released once empty or after `autoscale.drainSeconds`. */
  draining: boolean;
  stagesOut: string[];
  /** Measured RTT from the gateway (RTT gate, Vast); null when not measured. */
  rttMs: number | null;
  rttBaselineMs: number | null;
  udp: 'ok' | 'blocked' | null;
  /** Minutes until the provider takes the host back (Vast); null when it never does. */
  expiresInMinutes: number | null;
}

export interface DeploymentView {
  name: string;
  spec: Omit<DeploymentSpec, 'env' | 'envByMachineType' | 'registryAuth' | 'bootScript' | 'files' | 'fileUrls'> & {
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
  /** Why the deployment has the replica count it has: pressure, floor, what blocks a scale-out (`autoscale.ts`). */
  autoscale: {
    desired: number; pressureWant: number; reason: string; blockedBy: string | null; floor: number; warmFloor: number;
    load: number; p95Ms: number | null; errorRate: number;
  };
  /** Client warm window in force (`POST …/warm`), or null. */
  warm: { replicas: number; until: string } | null;
  realtime: { active: number; capacity: number; refusedSessions: number; scalingOut: boolean } | null;
  sessions: number;
  hold: { replicas: number; until: string } | null;
  warnings: string[];
}
