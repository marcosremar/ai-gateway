# ADR-014: Snapshot-Capable Provider Landscape (2026)

**Status:** Accepted
**Date:** 2026-04-17
**Deciders:** Marcos
**Amends:** [ADR-005](ADR-005-snapgpu-criu-policy.md) — corrects the
"SnapGPU" reference

## Context

ADR-005 referenced "SnapGPU" as a CRIU-supporting GPU provider alongside
RunPod and TensorDock. Research in April 2026 (see
`docs/compete-with-modal.md` for full breakdown) found that:

- **SnapGPU is not a cloud provider.** No live service exists under that
  name. The term in ADR-005 appears to have been a placeholder for the
  internal CRIU-based boot mechanism.
- **RunPod** (Community and Secure) does *not* expose `--privileged` or
  `--cap-add SYS_ADMIN` via UI or API — containers always run with the
  default Docker capability set. CRIU is not viable out-of-the-box.
- **Vast.ai containers** strip `CAP_SYS_ADMIN` (cap bound `a80425fb`) —
  confirmed in our own memory (`feedback_vast_ssh_and_caps.md`) and by
  external comparison write-ups.
- **TensorDock** default driver is in the 525-535 range; CRIUgpu requires
  driver 570+. Upgrading in-place is possible but host stability is
  inconsistent.
- **Modal** uses CRIU internally but does not expose it as a primitive —
  they are a serverless product, not an IaaS we can layer on.

Meanwhile, two paths do work:

1. **Vast.ai VM mode (KVM)** — launched in 2024, expanded in 2026. Root
   access, custom kernel, custom driver via `apt install`. Host selection
   is narrower than container mode but pricing parity with containers.
2. **Hyperstack** — H100 PCIe VMs ship with driver 570.195.03 out of the
   box. Full VM = full root. Confirmed via their public doc.

## Decision

For the **snapshot path** (ADR-012 capture + restore), the cascade is:

```
Primary:   Vast.ai VM mode (vast-vm)
Secondary: Hyperstack H100 (hyperstack)
```

For the **cold path** (deploys without snapshot — first-time images,
unsnapshottable workloads, or when snapshot storage is disabled):

```
RunPod → Vast.ai (containers) → TensorDock → Modal
```

unchanged from the pre-existing cascade. Phase A optimizations (ADR-010,
ADR-011) apply to the cold path.

TensorDock is **excluded** from the snapshot cascade until driver default
moves to 570+.

## Reasoning

- **Why Vast.ai VM first?** Existing API keys, lowest $/hr among viable
  providers, operational familiarity. Host selection is limited but not
  blocking.
- **Why Hyperstack second?** Driver 570+ default is documented and stable.
  Price is enterprise-tier but the snapshot path only runs when we
  actually need it, so the blended cost remains reasonable.
- **Why not RunPod Secure Cloud for snapshot?** A support ticket could
  reportedly unlock custom caps, but that is a per-account negotiation,
  not a repeatable primitive. Unreliable as a tier.
- **Why keep RunPod + TensorDock + Modal for cold path?** They are the
  cost and availability floor. Most deploys don't hit the snapshot path
  anyway (first-time images, rarely-used workloads, dev deploys).
- **Correcting "SnapGPU" naming.** The correct term is `cuda-checkpoint`
  (NVIDIA) composed with CRIU 4.0+ (upstream "CRIUgpu"). Future writing
  should use those names.

## Alternatives Considered

### CoreWeave CKS for snapshot
Rejected for current phase — enterprise contract required, no self-serve
4090 consumer GPUs. Revisit when volume justifies the contract.

### Lambda Labs for snapshot
Rejected — H100+ only (no RTX 4090). Keeps it in reserve for future
workloads that specifically need H100.

### Wait for RunPod to expose privileged containers
Rejected as the path of least action — unpredictable timeline and would
have blocked ADR-012 indefinitely.

### Single unified cascade (snapshot and cold combined)
Rejected — snapshot providers have different cost curves than cold-path
providers. Mixing them means many deploys pay snapshot-tier prices for
no benefit.

## Consequences

### Positive
- ADR-012 has a real implementation target (Vast-VM + Hyperstack clients
  shipped in `src/gateway/providers/gpu/{vast-vm-client,hyperstack-client}.ts`).
- Cold-path cascade is unchanged, so Phase A benefits apply universally.

### Negative
- Two cascades to reason about during debugging.
- Vast.ai VM host availability is narrower than containers; fallback to
  Hyperstack carries a price step-up.

## Monitoring

```
- deploy_path_total{type=snapshot|cold}
- deploy_provider_total{provider,path}
- snapshot_provider_exclusion_total{provider,reason}
```

## Notes

Implemented alongside Phase B (commit `94ab70c` — providers).
Env vars `HYPERSTACK_API_KEY` + `R2_SNAPSHOTS_*` documented in
`.env.example`.

ADR-005 remains in effect as the policy document; this ADR supersedes its
provider list.
