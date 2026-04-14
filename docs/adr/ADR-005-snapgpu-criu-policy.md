# ADR-005: SnapGPU/CRIU Fast Boot Policy

**Status:** Accepted
**Date:** 2024-05-12
**Deciders:** Marcos

## Context

GPU cold-start is slow: loading PyTorch, transformers, whisper, and the model itself can take 2-5 minutes. We need faster boot times while maintaining reliability.

## Decision

Implement **snapshot/restore** via CRIU (Checkpoint/Restore In Userspace) for fast boot. SnapGPU is a wrapper that manages CRIU for GPU pods.

```typescript
// From server/snapgpu-policy.ts
interface SnapshotPolicy {
  // Conditions for using snapshot restore
  shouldUseSnapshot(): boolean {
    return (
      providerSupportsCriu() &&           // RunPod/TensorDock/SnapGPU ✓, Vast.ai ✗, Modal ✗
      workloadBenefitsFromCriu() &&        // GGUF/llama.cpp ✓, PyTorch-based ✗
      snapshotNotStale() &&                // < 7 days old
      !snapshotConsistentlySlower()         // restore not slower than cold boot
    );
  }
}
```

**Target:** <30s snapshot restoration vs 2-5 minutes cold boot

## Reasoning

### Why conditional?
CRIU is only faster in a narrow envelope:

| Factor | Impact |
|--------|--------|
| Python import overhead | PyTorch, transformers dominate when cold start > ~5.5s |
| Model loading | GGUF/llama.cpp is fast to load from disk |
| Snapshot restore overhead | CRIU restore itself takes ~2-3s |

**Findings from benchmarking:**
- GGUF/llama.cpp: **1.85× SLOWER** under CRIU (3006ms cold → 5566ms restore for Mistral 7B Q4)
- PyTorch-based (Whisper, transformers): CRIU **significantly faster**

### Why 7-day stale threshold?
- Models update frequently
- CUDA/driver changes invalidate snapshots
- Disk images may change

### Why auto-disable?
If restore is consistently slower than cold boot (e.g., after model update), disable automatically via metrics.

## Snapshot Lifecycle

```
1. First boot (cold) → install models → capture snapshot
2. Subsequent boots → restore from snapshot (< 30s)
3. Every 7 days → recapture snapshot
4. If metrics show restore slower → disable, use cold boot
```

## Provider Support

| Provider | Privileged Containers | CRIU Support | Notes |
|----------|----------------------|--------------|-------|
| RunPod | ✓ (Secure Cloud) | ✓ | Primary |
| Vast.ai | ✗ (strips CAP_SYS_ADMIN) | ✗ | Community cloud limitation |
| TensorDock | ✓ | ✓ | Full VMs |
| Modal | ✗ | ✗ | Serverless runtime |
| SnapGPU | ✓ | ✓ | CRIU wrapper |

## Alternatives Considered

### Always use CRIU
- Would be slower for GGUF workloads
- Rejected

### Never use CRIU
- Slower cold starts
- Rejected

### Lazy model loading
- Models downloaded on first request
- Adds first-request latency
- Chose snapshot approach instead

## Consequences

- **Positive:** <30s boot time for supported workloads
- **Positive:** Significant cost savings (less idle billing)
- **Positive:** Better user experience (faster first response)
- **Negative:** Complexity in snapshot lifecycle management
- **Negative:** Not all providers support CRIU
- **Negative:** Model updates require snapshot refresh

## Monitoring

- `snapshot_restore_duration_ms`
- `snapshot_cold_boot_duration_ms`
- `snapshot_restore_count_total`
- `snapshot_auto_disable_total`
