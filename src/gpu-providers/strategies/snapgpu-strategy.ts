// ── SnapGPU provider strategy ────────────────────────────────────────────────
// SnapGPU is a capability layer (CRIU + cuda-checkpoint) that runs on top of
// Vast or RunPod — it has no hardware of its own. The strategy forwards the
// snapgpu-specific knobs (preload app, auto-snapshot, backend) into the
// create options; backend selection determines which underlying provider
// hosts the container.

import type { GpuProviderClient, ProviderCredentials } from '../types';
import type { DeployExtra } from '../deploy-extra';
import {
  defaultCleanup,
  type CreateOptionsBase,
  type ProviderStrategy,
} from './base-strategy';

export const snapgpuStrategy: ProviderStrategy = {
  name: 'snapgpu',
  defaultRaceCount: 1,
  defaultSshTimeoutSec: 300,
  allowTierCascade: true,
  resolveImage: (image) => image,

  buildCreateOptions(base: CreateOptionsBase, extra: DeployExtra): Record<string, unknown> {
    return {
      gpuTypes: base.gpuTypes,
      dockerImage: base.dockerImage,
      storageGb: base.storageGb,
      region: base.region,
      hfToken: base.hfToken,
      env: base.env,
      interruptible: extra.interruptible,
      onPollProgress: base.onPollProgress,
      ...(extra.dockerStartCmd ? { dockerStartCmd: extra.dockerStartCmd } : {}),
      ...(extra.containerDiskInGb ? { containerDiskInGb: extra.containerDiskInGb } : {}),
      ...(extra.volumeId ? { volumeId: extra.volumeId } : {}),
      ...(extra.label ? { label: extra.label } : {}),
      // SnapGPU-specific options.
      ...(extra.snapgpuPreloadApp ? { snapgpuPreloadApp: extra.snapgpuPreloadApp } : {}),
      ...(extra.snapgpuAutoSnapshot !== undefined ? { autoSnapshot: extra.snapgpuAutoSnapshot } : {}),
      ...(extra.snapgpuBackend ? { snapgpuBackend: extra.snapgpuBackend } : {}),
    };
  },

  cleanup(client: GpuProviderClient, instanceId: string, creds: ProviderCredentials) {
    return defaultCleanup(client, instanceId, creds);
  },
};
