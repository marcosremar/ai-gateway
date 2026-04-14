# ADR-007: GPU Autoscaler Tier Design

**Status:** Accepted
**Date:** 2026-02-20
**Deciders:** Marcos

## Context

GPU instances from different providers have vastly different:
- **Boot times** — RunPod (~31s), Vast.ai (~60-120s), Modal (~5-10s serverless)
- **Costs** — $0.44/hr (Vast.ai RTX 4090) to $2.00+/hr (RunPod RTX 5090)
- **Reliability** — Vast.ai is community-hosted, RunPod is managed

A flat provider list doesn't express the cost-vs-reliability trade-off.

## Decision

**Multi-tier cascade with automatic failover:**

```
Tier 0: RunPod (managed, reliable, moderate cost)
  ↓ fail
Tier 1: TensorDock / Vast.ai (cheaper, less reliable)
  ↓ fail
Tier 2: Modal (serverless, auto-scales to zero, different pricing model)
```

Each tier has:
- Independent circuit breaker
- Health check interval
- Idle timeout (auto-stop after 15 min)
- Auto-destroy (2 hours after stop)

### Decision builder

The `buildDecision()` function evaluates:
1. Active sessions (is GPU actually needed?)
2. Current tier state (is circuit open?)
3. Cost budget (are we within budget?)
4. Predictive warmup (will we need a GPU soon?)

## Consequences

### Positive
- Cost-optimized — cheapest tier tried first
- Resilient — automatic failover to next tier
- Budget-safe — cost monitoring prevents runaway spending

### Negative
- Complex state machine (tier selection, circuit breakers, cooldowns)
- Harder to debug — need to know which tier was attempted

## Alternatives Considered

1. **Single provider** — Simple but single point of failure
2. **Parallel boot across all providers** — Fastest but most expensive
3. **Manual tier selection** — Flexible but complex for users

## References

- `src/autoscaler/` — All autoscaler modules
- `CLAUDE.md` (GPU Machine Deployment section)
