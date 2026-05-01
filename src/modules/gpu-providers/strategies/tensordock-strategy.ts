// ── TensorDock provider strategy ─────────────────────────────────────────────
// TensorDock is bare-metal marketplace. The big quirk is that an existing
// stopped instance can be resumed for free — we always check for one before
// creating new infra (the tryResumeExisting hook implements this).

import type { GpuProviderClient, ProviderCredentials } from '../types';
import type { DeployExtra } from '../deploy-extra';
import {
  defaultCleanup,
  type CreateOptionsBase,
  type ProviderStrategy,
  type ResumeAttempt,
} from './base-strategy';

export const tensordockStrategy: ProviderStrategy = {
  name: 'tensordock',
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
      // TensorDock runs the install on the host VM, not in a Docker
      // container — preserves the legacy bareMetal flag.
      bareMetal: true,
      interruptible: extra.interruptible,
      onPollProgress: base.onPollProgress,
      ...(extra.dockerStartCmd ? { dockerStartCmd: extra.dockerStartCmd } : {}),
      ...(extra.containerDiskInGb ? { containerDiskInGb: extra.containerDiskInGb } : {}),
      ...(extra.label ? { label: extra.label } : {}),
    };
  },

  /** Discover an existing TensorDock instance and try to resume it. Returns
   *  resumed=false when no candidate exists or the candidate is in an
   *  unrecognised state. The caller is responsible for re-polling /health
   *  on the returned instance. */
  async tryResumeExisting(
    client: GpuProviderClient,
    creds: ProviderCredentials,
    gpuTypes: string[],
  ): Promise<ResumeAttempt> {
    const existing = await client.discoverInstance(creds, gpuTypes);
    if (!existing || !existing.instanceId) {
      return { resumed: false, reason: 'no existing instance' };
    }
    const status = (existing.status ?? '').toLowerCase();
    const isStopped = ['stopped', 'paused', 'suspended'].includes(status);
    const isRunning = ['running', 'active'].includes(status);

    if (isStopped) {
      await client.startInstance(existing.instanceId, creds);
      let endpoint = existing.endpoint || '';
      if (!endpoint) {
        const resolved = await client.resolveInstanceEndpoint(existing.instanceId, creds);
        if (resolved) endpoint = resolved;
      }
      return {
        resumed: true,
        instance: { ...existing, endpoint, status: 'running' },
        reason: 'resumed stopped instance',
      };
    }
    if (isRunning && existing.endpoint) {
      return {
        resumed: true,
        instance: existing,
        reason: 'attached to running instance',
      };
    }
    return { resumed: false, reason: `unknown state ${existing.status}` };
  },

  cleanup(client: GpuProviderClient, instanceId: string, creds: ProviderCredentials) {
    return defaultCleanup(client, instanceId, creds);
  },
};
