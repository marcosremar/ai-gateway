/**
 * VastVmClient — Vast.ai KVM-mode deploys for snapshot-capable pods.
 *
 * WHY a separate client:
 *   Vast.ai containers silently strip CAP_SYS_ADMIN and CAP_CHECKPOINT_RESTORE
 *   (cap bound 0x00000000a80425fb — confirmed 2026-04-10). That breaks CRIU
 *   dump/restore, which is the whole point of the snapshot path. KVM-mode
 *   deploys ("runtype: vm") expose a full virtual machine; the guest OS
 *   controls kernel capabilities and we can install NVIDIA driver 570+
 *   (required for cuda-checkpoint).
 *
 *   Not every host on Vast.ai supports VM mode — only hosts with
 *   `vms_enabled: true` do. This client narrows the offer search to those.
 *
 * Docs:
 *   - https://docs.vast.ai/vms
 *   - https://docs.vast.ai/linux-virtual-machines
 */

import { VastClient } from './vast-client';
import type { VastClientOptions } from './vast-client';
import type { InstanceSpec } from './types';

export interface VastVmClientOptions extends VastClientOptions {}

export class VastVmClient extends VastClient {
  readonly providerId: string = 'vast-vm';
  protected readonly _runtype: 'ssh_direct' | 'vm' = 'vm';

  constructor(opts?: VastVmClientOptions) {
    super(opts);
  }

  /**
   * Narrow offer search to KVM-capable hosts. Also relax direct-port
   * requirement (VM mode provides its own SSH path via console).
   */
  protected _augmentOfferSearch(searchBody: Record<string, unknown>, _spec: InstanceSpec): void {
    // Required: host must advertise KVM VM support.
    searchBody.vms_enabled = { eq: true };
    // VM-mode deploys handle networking via the VM's OS, not container port
    // forwarding, so we don't need direct_port_count.
    delete searchBody.direct_port_count;
  }
}
