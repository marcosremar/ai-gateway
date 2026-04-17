# ADR-012: CRIUgpu Snapshot Lifecycle — Capture, Restore, Catalog

**Status:** Accepted
**Date:** 2026-04-17
**Deciders:** Marcos
**Supersedes (in part):** [ADR-005](ADR-005-snapgpu-criu-policy.md)

## Context

ADR-005 defined the *policy* for CRIU-based fast boot (when to use
snapshots, staleness thresholds, auto-disable on regression) but never
defined the *executor* — how snapshots are captured, where they live, how
they are fetched, how fallback works. As a result, no deploy in production
ever restored from a snapshot; the policy was dead code.

Meanwhile, the primitive matured in 2025:
- NVIDIA `cuda-checkpoint` (driver 570+) dumps VRAM, CUDA graphs, and
  `torch.compile` caches.
- CRIU 4.0+ integrates it as `CRIUgpu` — transparent, no API interception.
- Modal reports 10× cold-start wins (45s → 5s on vLLM-Qwen) using exactly
  this stack.

Our own bench (see `memory/project_criu_benchmark.md`) validated the
primitive: driver 565 + CRIU 4.0, dump 4.3s, restore 3.6s, VRAM intact.

## Decision

Implement the full snapshot lifecycle as a capture/restore/catalog system
wired into the deploy loop, gated on provider capability.

### Capture (`server/gpu-snapshot.ts`)

On first `allServicesLoaded === true` for a deploy (observed via event-bus
`gpu.deployed`), fire an **asynchronous** capture job. Capture is
best-effort — any failure logs a warning and never breaks the deploy.

Pre-check gates:
1. Provider is `vast-vm` or `hyperstack`. (RunPod containers, Vast.ai
   containers, and TensorDock are excluded — see ADR-014 for provider
   landscape analysis.)
2. `nvidia-smi --query-gpu=driver_version` major ≥ 570.
3. `capsh --has-p=CAP_CHECKPOINT_RESTORE` OR `CAP_SYS_ADMIN`.

Flow:
```
ssh  → sudo criu dump --tree $PID --images-dir /tmp/snapshot --leave-running
ssh  → tar --zstd -cf /tmp/snapshot.tar.zst /tmp/snapshot
upload → R2 snapshots/{provider}/{imageHash}/{modelHash}-{driverMajor}.tar.zst
write → ~/.babelcast/snapshot-catalog.json (append record)
```

### Restore (`server/gpu-deploy-loop.ts`)

On every deploy, after `createInstance()` succeeds:
1. Compute match key `{imageHash, modelHash, provider, driverMajor}`.
2. Query `snapshot-catalog.json` for a match with `age < 7 days`.
3. If match and the deploy provider is `vast-vm`/`hyperstack`: SSH, download,
   `sudo criu restore --images-dir /tmp/snapshot`, health check.
4. Success → skip pull/boot/model-load, sinalize ready.
5. Failure → **transparent fallback** to cold path, increment
   `snapshot_auto_disable_total`. ADR-005's auto-disable counter takes
   over from there.

### Storage (R2)

Snapshots are 500MB-2GB per checkpoint; rare egress (one restore per new
pod). R2 is correctly priced for this. **Do not confuse with model weights**
— `memory/feedback_r2_slow_for_bulk_downloads.md` documents that R2 is
~8× slower than HF CloudFront for 4GB+ weights.

Env: `R2_SNAPSHOTS_BUCKET`, `R2_SNAPSHOTS_ENDPOINT`, `R2_SNAPSHOTS_ACCESS_KEY`,
`R2_SNAPSHOTS_SECRET_KEY`. Leaving these unset disables snapshot entirely.

## Reasoning

- **Async capture, best-effort.** A failed capture should never be observable
  by the user. Cold start continues as before, worst case.
- **Event-bus hook instead of direct call in `gpu-poll-health.ts`.** Phase A
  also modified `gpu-poll-health.ts`; the Phase B agent picked the event-bus
  route to avoid a file-ownership conflict during parallel development. Same
  semantics, zero merge collision.
- **7-day staleness.** Inherited from ADR-005. Model updates, driver bumps,
  and image changes all invalidate snapshots; 7 days is the observed cadence
  floor.
- **Provider gating.** See ADR-014.

## Alternatives Considered

### Synchronous capture blocking first-request
Rejected — trades one cold-start win for a delayed first response.
Unacceptable for latency-sensitive workloads.

### Single global snapshot per image
Rejected — model hashes vary per deploy (domain prompts, fine-tunes,
quantization presets). Multi-dimensional key is mandatory.

### Self-hosted snapshot storage (local NVMe)
Rejected — loses portability across providers. Snapshots need to be
provider-agnostic so a restore on Hyperstack can use a capture from
Vast-VM (subject to driver match).

### Modal-style memory-snapshot-during-boot
Rejected for now — requires modification to user Python code (their
`@memory_snapshot()` decorator). Our gateway is transport-agnostic; we
operate on any container.

## Consequences

### Positive
- Cold start **30-60s → 3-8s** on snapshot-eligible providers.
- Standby pool (ADR-013) becomes cheap because restored pods are fast.
- ADR-005 stops being dead code — policy + executor now aligned.

### Negative
- Restore path is brittle to provider SSH/driver quirks; auto-disable
  protects against silent regressions.
- R2 storage bill (~$0.015/GB/month) for N profiles × snapshot size.

## Monitoring

```
- snapshot_capture_count_total{provider,status}
- snapshot_capture_duration_ms{provider}
- snapshot_restore_count_total{provider,status}
- snapshot_restore_duration_ms{provider}
- snapshot_cold_fallback_total{reason}
- snapshot_catalog_size_bytes
```

## Notes

Implemented in Phase B (commits `94ab70c`, `16d28bd`, `fc8a290`, `122cfcf`).
Bench harness at `scripts/bench-snapshot.ts`; must run on a real Vast.ai
VM or Hyperstack VM — never on macOS (per
`memory/feedback_coldstart_bench_on_real_gpu.md`).

ADR-005 is retained as the *policy* document; this ADR is the *executor*.
