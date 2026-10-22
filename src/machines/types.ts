import type { ExposedPort } from '../deployments/types';

export type MachineProvider = 'scaleway' | 'vast' | 'runpod';

export type MachineStatus = 'creating' | 'running' | 'paused' | 'released' | 'failed';

export interface MachineRequest {
    provider: MachineProvider | 'cheapest';
    machineType: string;
  maxUsdPerHour: number;
    image: string;
  diskGb: number;
  ports: ExposedPort[];
    sshPublicKey?: string;
    onstart?: string;
    env: Record<string, string>;
    zone?: string;
    near?: string;
  minCpuCores?: number;
  minRamGb?: number;
    minGpuFrac?: number;
  vm?: boolean;
}

export interface MachineRecord {
  id: string;
  owner: string;
  holder: string | null;
  namespace: string;
  request: MachineRequest;
  provider: MachineProvider | null;
  providerId: string | null;
  status: MachineStatus;
  ip: string | null;
    ports: Record<string, number>;
  usdPerHour: number | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  deadlineAt: number;
  idleMinutes: number;
  lastSeenAt: number;
  endReason: string | null;
  /** When the gateway paused it for lack of provider credit (`MACHINES_PAUSE_BELOW_USD`); null while running. */
  pausedAt?: number | null;
  jobId: string | null;
  lastError: string | null;
}

export type JobStatus = 'starting' | 'running' | 'succeeded' | 'failed' | 'timeout';

export interface JobInput { url: string; path: string }

export interface JobRecord {
  id: string;
  owner: string;
  holder: string | null;
  machineId: string;
  command: string;
  inputs: JobInput[];
  output: { url: string; path: string } | null;
  status: JobStatus;
    tokenHash: string;
  exitCode: number | null;
  log: string;
  result: { uploaded: boolean; bytes: number | null; sha256: string | null } | null;
  createdAt: number;
  endedAt: number | null;
  error: string | null;
}

export interface ProviderMachine {
  providerId: string;
  provider: MachineProvider;
  machineId: string;
  state: 'starting' | 'running' | 'stopped';
  ip: string | null;
  ports: Record<string, number>;
  usdPerHour: number | null;
  createdAt: number;
}

export interface CreateMachineInput {
  machineId: string;
  namespace: string;
  request: MachineRequest;
}

export interface MachineBackend {
  readonly provider: MachineProvider;
    quote(request: MachineRequest): Promise<number | null>;
  create(input: CreateMachineInput): Promise<ProviderMachine>;
    list(namespace: string): Promise<ProviderMachine[]>;
    release(providerId: string): Promise<void>;
  offers?(request: MachineRequest): Promise<unknown[]>;
  /** Account credit in USD (`null` = unknown). With `pause`/`resume`, the controller pauses machines when it falls too low. */
  credit?(): Promise<number | null>;
  /** Power off keeping the disk (billed for storage only), and power back on. */
  pause?(providerId: string): Promise<void>;
  resume?(providerId: string): Promise<void>;
}

export interface MachineLimits {
    maxHours: number;
    maxLifetimeHours: number;
  defaultIdleMinutes: number;
  maxUsdPerHour: number;
    ownerMaxUsdPerHour?: Record<string, number>;
  pauseBelowUsd?: number;
  maxRunning: number;
  ownerUsdPerDay: number;
  ownerUsdPerMonth: number;
  holderUsdPerDay: number;
  globalUsdPerDay: number;
    createTimeoutMs: number;
}

export interface MachineView {
  id: string;
  owner: string;
  holder: string | null;
  provider: MachineProvider | null;
  providerId: string | null;
  status: MachineStatus;
  machineType: string;
  image: string;
  ip: string | null;
  ports: Record<string, number>;
  ssh: boolean;
  onstart: boolean;
  envKeys: string[];
  usdPerHour: number | null;
  costUsd: number;
  createdAt: string;
  deadlineAt: string;
  idleMinutes: number;
  lastSeenAt: string;
  endedAt: string | null;
  endReason: string | null;
  jobId: string | null;
  lastError: string | null;
}

export interface JobView {
  id: string;
  owner: string;
  holder: string | null;
  machineId: string;
  status: JobStatus;
  inputs: string[];
  output: { host: string; path: string } | null;
  exitCode: number | null;
  result: JobRecord['result'];
  createdAt: string;
  endedAt: string | null;
  error: string | null;
  machine: MachineView | null;
}
