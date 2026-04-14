# ADR-001: GPU Cascade Order — RunPod → Vast.ai → TensorDock → Modal

**Status:** Accepted
**Date:** 2024-01-15
**Deciders:** Marcos

## Context

We need to deploy self-hosted GPU inference across multiple cloud providers. Each provider has different capabilities, pricing, and constraints. We must choose an order (cascade) that prioritizes reliability, cost-efficiency, and feature support.

## Decision

Provider cascade order: **RunPod → Vast.ai → TensorDock → Modal**

```typescript
// From server/config.ts
export const PROVIDER_CASCADE = ['runpod', 'vast', 'tensordock', 'modal'] as const;
```

## Reasoning

### RunPod (primary)
- Supports **privileged containers** required for SnapGPU/CRIU snapshot restore
- "Secure Cloud" pods with best reliability
- Network volumes for persistent GGUF cache
- Full container customization

### Vast.ai (secondary)
- More affordable than RunPod
- **Cannot support CRIU** — community cloud strips `CAP_SYS_ADMIN` and `CAP_CHECKPOINT_RESTORE`
- Best for stateless/spot workloads
- Lower pull rate limits (mitigated via DockerHub credentials)

### TensorDock (tertiary)
- Full VMs via cloud-init that can run privileged containers
- Good for custom configurations
- Provides another fallback with different failure modes

### Modal (last resort)
- Serverless runtime — no CRIU surface
- Acts as fallback for specialized workloads (e.g., MOSS-TTS)
- Pay-per-second billing, no idle cost

## Alternatives Considered

### Alphabetical order (Modal → RunPod → TensorDock → Vast.ai)
- Ignores capability differences — Modal can't run SnapGPU images
- Would cause unnecessary cold boots

### Cheapest-first
- Vast.ai is cheapest but lacks CRIU support
- Would result in worse cold-start performance

## Consequences

- **Positive:** SnapGPU/CRIU works reliably on RunPod, TensorDock
- **Positive:** Cascade provides redundancy — if one provider fails, next in chain handles
- **Negative:** Order is somewhat rigid; mitigated by `PROVIDER_CHAIN` env var for customization
- **Negative:** Vast.ai CRIU limitation requires conditional logic in snapshot policy

## Notes

- CRIU snapshot restore is only faster than cold boot in a narrow envelope: Python import overhead (PyTorch, transformers, whisper) dominates when cold start > ~5.5s
- See ADR-005 for SnapGPU/CRIU policy details
