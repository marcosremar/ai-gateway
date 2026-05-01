// ── Vast.ai VM-mode provider strategy ────────────────────────────────────────
// Vast-VM gives us CAP_SYS_ADMIN + CAP_CHECKPOINT_RESTORE + NVIDIA driver 570+,
// which is the minimum CRIU snapshot capture/restore needs. The strategy
// implements `trySnapshotRestore` so the deploy loop can short-circuit cold
// boot when a matching snapshot is available.
//
// We don't import the actual `maybeRestoreSnapshot` here (it lives in
// `server/gpu-snapshot.ts` and `src/` cannot import from `server/`). Instead
// we read the registered restorer from the snapshot port — server bootstrap
// is responsible for wiring the implementation in (see
// `registerSnapshotRestorer` in `./snapshot-port.ts`).

import type { GpuProviderClient, ProviderCredentials } from '../types';
import type { DeployExtra } from '../deploy-extra';
import {
  defaultCleanup,
  type CreateOptionsBase,
  type Instance,
  type ProviderStrategy,
  type SnapshotRestoreAttempt,
} from './base-strategy';
import { getSnapshotRestorer } from './snapshot-port';

export const vastVmStrategy: ProviderStrategy = {
  name: 'vast-vm',
  defaultRaceCount: 2,
  defaultSshTimeoutSec: 90,
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
      ...(extra.onstart ? { onstart: extra.onstart } : {}),
      ...(extra.templateHashId ? { templateHashId: extra.templateHashId } : {}),
      ...(extra.forceSshTunnel ? { forceSshTunnel: extra.forceSshTunnel } : {}),
      ...(extra.label ? { label: extra.label } : {}),
      ...(extra.strictFastBoot ? { strictFastBoot: extra.strictFastBoot } : {}),
    };
  },

  async trySnapshotRestore(instance: Instance, image: string): Promise<SnapshotRestoreAttempt> {
    if (!instance.sshHost || !instance.sshPort) {
      return { restored: false, reason: 'no ssh host/port on instance' };
    }
    const restorer = getSnapshotRestorer();
    if (!restorer) {
      return { restored: false, reason: 'no restorer registered' };
    }
    const out = await restorer({
      provider: 'vast-vm',
      ssh: { host: instance.sshHost, port: instance.sshPort },
      imageRef: image,
      models: [],
    });
    return {
      restored: out.restored,
      durationMs: out.durationMs,
      reason: out.reason,
      meta: out.meta,
    };
  },

  cleanup(client: GpuProviderClient, instanceId: string, creds: ProviderCredentials) {
    return defaultCleanup(client, instanceId, creds);
  },
};
