# ADR-010: Persistent Pull History + Dynamic Tier Ranking

**Status:** Accepted
**Date:** 2026-04-17
**Deciders:** Marcos

## Context

Cold-start on GPU deploys is dominated by image pull (60-600s) and model load.
Two pre-existing mechanisms were undermining each other:

1. `pull-time-estimator.ts` kept pull durations in an in-memory ring buffer
   (500 records max). Every gateway restart erased the history, forcing the
   next deploy to fall back to the conservative 2× safety-multiplier default.
2. Tier cascade (`startDeployWithTiers`) was a fixed order —
   `RunPod → Vast.ai → TensorDock → Modal` — based on cost alone. If RunPod
   was 30% slower than Vast on a given day, deploys still went to RunPod
   first and the slow path was paid on every cold start.

## Decision

**Persist `pull-time-estimator` history** to `~/.babelcast/pull-history.json`
and **rank providers in the tier cascade by observed P50 cold-start latency**,
with cost retained as the tiebreaker (±10% P50 window).

```typescript
// server/pull-history-persistence.ts
// Debounced 10s writes, atomic tmp+rename (same pattern as ADR-009 cooldowns).

// server/tier-ranking.ts
// 7-day EWMA over pullMs + bootMs + modelLoadMs per provider.
// Persisted to ~/.babelcast/tier-ranking.json.
// Applied in buildGpuTiers via reorderByLatency().
```

Cooldown (ADR-009) is orthogonal and not affected — ranking reorders active
providers only.

## Reasoning

- **Why persist rather than recompute?** First deploy post-restart is the
  worst-case path. Persisting converts "always conservative" to "calibrated
  on day one."
- **Why P50 and not P95?** P50 tracks typical experience. P95 is dominated
  by tail events (cold pods, slow hosts) that cooldown already handles.
- **Why 7-day window?** Shorter windows (24h) flap on transient provider
  issues. Longer (30d) masks sustained regressions.
- **Why keep cost as tiebreaker?** When two providers are within 10% on
  latency, $0.05/hr difference × hundreds of deploys/day is material.

## Alternatives Considered

### Always rank by cost only (status quo)
Rejected — ignores observed reality. A provider that's cheaper on paper but
consistently slower to boot wastes GPU-idle budget on every cold start.

### Always rank by latency only
Rejected — on parity-latency days, burns cost unnecessarily.

### Global ranking (shared across tenants)
Rejected — out of scope for this single-tenant deployment and would require
stateful multi-gateway coordination.

## Consequences

### Positive
- First-deploy-post-restart uses calibrated timeouts (no 2× safety hit).
- Tier cascade adapts to reality without manual reordering.
- Zero change to per-request code paths — runs at boot + tick-time only.

### Negative
- Adds two JSON files to `~/.babelcast/` persistence surface.
- Latency observations can be poisoned by a single slow deploy; 7-day EWMA
  mitigates but does not eliminate.

## Monitoring

```
- pull_history_persisted_entries
- tier_ranking_reorder_count_total
- tier_ranking_p50_ms{provider}
```

## Notes

Implemented in Phase A (commit `9dd56a4`, `863d660`). See
`docs/compete-with-modal.md` for the broader cold-start roadmap.
