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
}

export interface InstanceSpec {
  gpuTypes: string[];
  gpuCount?: number;
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
}

/**
 * @deprecated All providers now implement `listInstances` directly on `GpuProviderClient`.
 * Use `GpuProviderClient` instead.
 */
export type MonitorableProvider = GpuProviderClient;
