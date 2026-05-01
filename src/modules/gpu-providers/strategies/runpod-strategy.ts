// ── RunPod provider strategy ─────────────────────────────────────────────────
// RunPod Secure Cloud is reliable enough that race deploys are unnecessary:
// defaultRaceCount=1, single-shot. Tier cascade is enabled so a RunPod
// failure falls forward to the next configured provider.
//
// HARD RULE (per CLAUDE.md): RunPod must ALWAYS use SECURE cloud. NEVER
// COMMUNITY — community machines are unreliable third-party hardware that
// frequently die mid-task. This strategy hardcodes `cloudType: 'SECURE'`.

import type { GpuProviderClient, ProviderCredentials } from '../types';
import type { DeployExtra } from '../deploy-extra';
import {
  defaultCleanup,
  type CreateOptionsBase,
  type ProviderStrategy,
} from './base-strategy';

export const runpodStrategy: ProviderStrategy = {
  name: 'runpod',
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
      // CLAUDE.md hard rule — never COMMUNITY.
      cloudType: 'SECURE' as const,
      ...(extra.dockerStartCmd ? { dockerStartCmd: extra.dockerStartCmd } : {}),
      ...(extra.containerDiskInGb ? { containerDiskInGb: extra.containerDiskInGb } : {}),
      ...(extra.volumeId ? { volumeId: extra.volumeId } : {}),
      ...(extra.label ? { label: extra.label } : {}),
    };
  },

  cleanup(client: GpuProviderClient, instanceId: string, creds: ProviderCredentials) {
    return defaultCleanup(client, instanceId, creds);
  },
};
