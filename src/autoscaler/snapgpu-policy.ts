/**
 * SnapGPU Policy — decides whether a tier should attempt a CRIU snapshot
 * restore vs a cold boot for a given deploy attempt.
 *
 * The autoscaler should NOT restore from a snapshot just because one exists
 * in the KV store. CRIU is only faster than cold boot in a narrow envelope:
 *
 *   1. Provider must allow privileged containers (CAP_SYS_ADMIN / CHECKPOINT_RESTORE).
 *      Vast.ai community cloud strips `--privileged` and `vm:true` template
 *      flags — confirmed 2026-04-10 with `capBnd=00000000a80425fb` (no
 *      CAP_SYS_ADMIN bit 21, no CAP_CHECKPOINT_RESTORE bit 40). Trying to
 *      restore there will fail at `criu dump`.
 *
 *   2. Workload must benefit from CRIU. Benchmark 2026-04-10 showed llama.cpp
 *      / GGUF models are 1.85× SLOWER under CRIU restore vs cold start
 *      (3006ms cold → 5566ms restore for Mistral 7B Q4). CRIU only pays off
 *      when cold start > ~5.5s and is dominated by Python import overhead
 *      (PyTorch, transformers, whisper).
 *
 *   3. Snapshot must not be stale. The snapshot KV entry includes the image
 *      tag it was captured against; if the tier config changes the image,
 *      the snapshot can't be trusted even if it's "fresh".
 *
 * This module is deliberately kept free of I/O dependencies so it can be
 * unit-tested without the registry, KV store, or provider clients.
 */

import type { GpuTierConfig } from '../types';

/** A set of providers known to support privileged containers required for CRIU. */
export const PRIVILEGED_PROVIDERS = new Set<string>([
  'runpod',        // Secure Cloud pods support --privileged
  'tensordock',    // Full VMs via cloud-init can run --privileged
  'snapgpu',       // Wrapper — the decision is made via the resolved backend
]);

/** Providers known to NOT support privileged containers on their public tier. */
export const UNPRIVILEGED_PROVIDERS = new Set<string>([
  'vast',          // Community cloud strips --privileged silently
  'modal',         // Hosted runtime — no CRIU surface
  'skypilot',      // Abstraction over multiple clouds; varies
]);

/** Snapshot metadata as persisted by boot-orchestrator after a successful boot. */
export interface PersistedSnapshot {
  snapshotId: string;
  appName?: string;
  createdAt: number;
  /** Image reference this snapshot was captured against. Snapshot is invalid
   *  when the tier config points at a different image. */
  imageRef?: string;
  /** Backend provider the snapshot was captured on (vast/runpod/tensordock).
   *  Currently informational — cross-backend restore is not supported. */
  backend?: string;
}

export interface SnapshotPolicyInput {
  /** Resolved tier config for the upcoming boot attempt. */
  tierConfig: GpuTierConfig;
  /** The snapshot record loaded from the KV store (or null if none exists). */
  snapshot: PersistedSnapshot | null;
  /** Whether snapshot is currently auto-disabled for this workload due to
   *  poor restore performance. Coming from SnapgpuMetrics.isDisabled(). */
  autoDisabled: boolean;
  /** The underlying backend provider that snapgpu will use (vast/runpod/...).
   *  For non-snapgpu tiers, this is the same as tierConfig.provider. */
  resolvedBackend: string;
  /** Current wall-clock time. Injected for deterministic tests. */
  now?: number;
}

export type SnapshotPolicyDecision =
  | { use: true; snapshotId: string; reason: 'policy_ok' }
  | { use: false; reason:
      | 'no_snapshot'
      | 'provider_not_privileged'
      | 'auto_disabled'
      | 'stale_age'
      | 'image_mismatch'
      | 'explicit_override'
      | 'workload_unsuitable' };

/** Snapshots older than this are assumed stale. Matches the existing 7-day
 *  TTL that boot-orchestrator was already enforcing. */
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Heuristic: images matching these patterns are known GGUF/llama.cpp
 *  workloads where CRIU is slower than cold boot and should be rejected. */
const UNSUITABLE_IMAGE_PATTERNS = [
  /gguf/i,
  /llama-?cpp/i,
  /ollama/i,
];

/**
 * Decide whether the upcoming boot should use a CRIU snapshot restore.
 *
 * Returns a tagged union so callers can log the rejection reason via the
 * lifecycle logger and so tests can assert precise behavior.
 *
 * @param input Policy inputs (tier config + persisted snapshot + state)
 * @returns Decision with reason code
 */
export function shouldUseSnapshot(input: SnapshotPolicyInput): SnapshotPolicyDecision {
  const { tierConfig, snapshot, autoDisabled, resolvedBackend } = input;
  const now = input.now ?? Date.now();

  // 1. Explicit override: if the caller already set snapgpuRestoreFromSnapshot
  //    in the tier config, we honor their choice and short-circuit the policy.
  //    This preserves the existing "manual restore" contract for tests and
  //    advanced users who know what they're doing.
  if (tierConfig.snapgpuRestoreFromSnapshot) {
    return { use: true, snapshotId: tierConfig.snapgpuRestoreFromSnapshot, reason: 'policy_ok' };
  }

  // 2. No snapshot persisted → nothing to restore from.
  if (!snapshot?.snapshotId) {
    return { use: false, reason: 'no_snapshot' };
  }

  // 3. Auto-disabled by metrics (restore was consistently slower than cold).
  if (autoDisabled) {
    return { use: false, reason: 'auto_disabled' };
  }

  // 4. Backend must support privileged containers. The resolvedBackend is the
  //    underlying provider snapgpu will deploy on, not the wrapper name.
  if (UNPRIVILEGED_PROVIDERS.has(resolvedBackend)) {
    return { use: false, reason: 'provider_not_privileged' };
  }

  // 5. Snapshot age — silent fallback to cold boot keeps the behavior safe
  //    when a pod was deleted out-of-band but the KV entry lingered.
  const age = now - (snapshot.createdAt || 0);
  if (age > SNAPSHOT_MAX_AGE_MS) {
    return { use: false, reason: 'stale_age' };
  }

  // 6. Image mismatch — snapshot was captured against a different image
  //    than the tier currently wants to deploy. CRIU restore into a
  //    different image is guaranteed to break.
  if (snapshot.imageRef && tierConfig.dockerImage && snapshot.imageRef !== tierConfig.dockerImage) {
    return { use: false, reason: 'image_mismatch' };
  }

  // 7. Workload suitability — reject GGUF / llama.cpp images where CRIU is
  //    empirically slower than cold boot. The image name is the only signal
  //    we have at this layer; a more sophisticated check would look at the
  //    pod's runtime cold-vs-restore history (see SnapgpuMetrics).
  if (tierConfig.dockerImage && UNSUITABLE_IMAGE_PATTERNS.some(re => re.test(tierConfig.dockerImage!))) {
    return { use: false, reason: 'workload_unsuitable' };
  }

  return { use: true, snapshotId: snapshot.snapshotId, reason: 'policy_ok' };
}
