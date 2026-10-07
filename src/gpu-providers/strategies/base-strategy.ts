// ── Provider Strategy interface — per-provider quirks live in one file each ──
// Replaces the inline `if (providerName === 'tensordock')` /
// `if (providerName === 'runpod')` switches that used to be scattered through
// `server/gpu-deploy-loop.ts`. Each concrete strategy in this folder owns the
// quirks of one provider; the deploy loop is reduced to "ask the strategy".

import type { GpuProviderClient, GpuInstance, ProviderCredentials } from '../types';
import type { ProviderName } from '../deploy-orchestrator';
import type { DeployExtra } from '../deploy-extra';

/** Re-exported for convenience so strategy implementations can import a single barrel. */
export type Instance = GpuInstance;

export interface ResumeAttempt {
  resumed: boolean;
  instance?: Instance;
  reason?: string;
}

export interface SnapshotRestoreAttempt {
  restored: boolean;
  durationMs?: number;
  reason?: string;
  /** Free-form metadata about the snapshot that was restored. */
  meta?: Record<string, unknown>;
}

export interface ReadinessResult {
  result: 'ready' | 'timeout' | 'exited' | 'app_error' | 'cancelled';
  pullTimeS?: number;
  appError?: { message: string; logs?: string };
}

/** Inputs to {@link ProviderStrategy.buildCreateOptions}. The base shape is the
 *  union of fields the deploy loop computes from the call site (gpuTypes,
 *  storageGb, etc.) plus any extras the loop wants to forward. Strategies
 *  decide which fields to keep, which to rename, and which extra
 *  provider-specific keys to layer on top. */
export interface CreateOptionsBase {
  gpuTypes: string[];
  dockerImage: string;
  storageGb: number;
  region?: string;
  hfToken?: string;
  env?: Record<string, string>;
  interruptible?: boolean;
  onPollProgress?: (info: { elapsedS: number; status: string; instanceId: string; ip: string; sshHost?: string; sshPort?: number }) => void;
  /** Allow strategies to pass additional fields through to `createInstance`. */
  [key: string]: unknown;
}

export interface ProviderStrategy {
  readonly name: ProviderName;
  /** Default race count when the caller does not specify. Vast=3 (proxy
   *  flaky), RunPod=1 (SECURE reliable), Modal=1, etc. */
  readonly defaultRaceCount: number;
  /** SSH probe timeout cap in seconds. Vast=90 (proxy fails fast or never),
   *  RunPod=300, Modal=600. */
  readonly defaultSshTimeoutSec: number;
  /** Whether the tier cascade should fall back to the next provider on
   *  failure. Vast=false when used with race (loop within), RunPod/Modal=true. */
  readonly allowTierCascade: boolean;
  /** Resolves the runtime image/script reference (Modal swaps for a deploy
   *  script path; everything else is identity). */
  resolveImage(image: string): string;
  /** Builds provider-specific create options. The base shape is what the
   *  deploy loop already computed; strategies layer SECURE cloud type,
   *  Vast.ai onstart/runtype, snapgpu hooks, etc. */
  buildCreateOptions(base: CreateOptionsBase, extra: DeployExtra): Record<string, unknown>;
  /** TensorDock can resume an existing stopped instance — returns
   *  resumed=true with the instance, otherwise resumed=false. Other
   *  providers leave this method undefined. */
  tryResumeExisting?(client: GpuProviderClient, creds: ProviderCredentials, gpuTypes: string[]): Promise<ResumeAttempt>;
  /** Vast-VM and Hyperstack support CRIU snapshot restore — try it first,
   *  fall through to cold path on failure. Other providers leave this
   *  method undefined. */
  trySnapshotRestore?(instance: Instance, image: string): Promise<SnapshotRestoreAttempt>;
  /** Cleanup hook on cancellation/failure — defaults to
   *  `client.deleteInstance`, but providers can override. */
  cleanup(client: GpuProviderClient, instanceId: string, creds: ProviderCredentials): Promise<void>;
}

/** Default implementation of `cleanup`: delete the instance via the client. */
export async function defaultCleanup(
  client: GpuProviderClient,
  instanceId: string,
  creds: ProviderCredentials,
): Promise<void> {
  await client.deleteInstance(instanceId, creds);
}
