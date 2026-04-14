/**
 * GpuProvisioner — port for provisioning/stopping GPU instances on cloud providers.
 *
 * Abstracts RunPod, Vast.ai, TensorDock, Modal, SnapGPU behind one contract.
 * Use cases depend on this port rather than picking a specific provider.
 */

import type { Provider } from '../entities/deployment';

export interface ProvisionRequest {
  provider: Provider;
  gpuType: string;
  dockerImage: string;
  region?: string;
  apiKey: string;
  /** Startup timeout — how long to wait for /health to return 200. */
  healthTimeoutMs?: number;
}

export interface ProvisionedInstance {
  podId: string;
  endpoint: string;
  provider: Provider;
  gpuType: string;
  /** Hourly cost reported by the provider at provision time. */
  costPerHr: number;
  /** Raw provider-specific metadata (region, host, template, etc.). */
  metadata: Record<string, unknown>;
}

export interface GpuProvisioner {
  provision(request: ProvisionRequest): Promise<ProvisionedInstance>;
  stop(podId: string, provider: Provider, apiKey: string): Promise<void>;
  terminate(podId: string, provider: Provider, apiKey: string): Promise<void>;
}
