// ── Hyperstack provider strategy ─────────────────────────────────────────────
// Hyperstack is a VM-mode IaaS like vast-vm — it ships Ubuntu + 100GB root
// disk and supports CRIU snapshot capture/restore (driver 570+). The
// strategy implements `trySnapshotRestore` via the snapshot port (the actual
// implementation lives in `server/gpu-snapshot.ts`).

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

export const hyperstackStrategy: ProviderStrategy = {
  name: 'hyperstack',
  defaultRaceCount: 2,
  defaultSshTimeoutSec: 120,
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
      ...(extra.label ? { label: extra.label } : {}),
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
      provider: 'hyperstack',
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
