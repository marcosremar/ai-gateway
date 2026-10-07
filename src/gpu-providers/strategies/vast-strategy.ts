// ── Vast.ai (container mode) provider strategy ───────────────────────────────
// Vast.ai's SSH proxy is the #1 source of "zombie" pods, so the safe default
// is race=3 within Vast (rather than failing over to the next provider). The
// tier cascade is therefore disabled by default for Vast — callers that want
// the cascade can explicitly set `extra.noTierCascade = false`.

import type { GpuProviderClient, ProviderCredentials } from '../types';
import type { DeployExtra } from '../deploy-extra';
import {
  defaultCleanup,
  type CreateOptionsBase,
  type ProviderStrategy,
} from './base-strategy';

export const vastStrategy: ProviderStrategy = {
  name: 'vast',
  defaultRaceCount: 3,
  defaultSshTimeoutSec: 90,
  // Vast handles its own redundancy via in-tier race; cascade off by default.
  allowTierCascade: false,
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
      // Vast.ai-specific fields. Vast client sets `runtype: 'args'` itself;
      // strategies just forward the user-supplied bits.
      ...(extra.onstart ? { onstart: extra.onstart } : {}),
      ...(extra.templateHashId ? { templateHashId: extra.templateHashId } : {}),
      ...(extra.forceSshTunnel ? { forceSshTunnel: extra.forceSshTunnel } : {}),
      ...(extra.label ? { label: extra.label } : {}),
      ...(extra.searchMode ? { searchMode: extra.searchMode } : {}),
      ...(extra.strictFastBoot ? { strictFastBoot: extra.strictFastBoot } : {}),
      ...(extra.requireDirectPort ? { directPortRequired: 1 } : {}),
    };
  },

  cleanup(client: GpuProviderClient, instanceId: string, creds: ProviderCredentials) {
    return defaultCleanup(client, instanceId, creds);
  },
};
