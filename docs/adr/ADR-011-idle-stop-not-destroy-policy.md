# ADR-011: Idle Policy — Stop, Not Destroy; 5-min Floor

**Status:** Accepted
**Date:** 2026-04-17
**Deciders:** Marcos

## Context

Previous idle policy:
- `IDLE_TIMEOUT_MS = 15 min` — terminate pod after 15 min of inactivity.
- `MIN_IDLE_TIMEOUT_MS = 10 min` — adaptive floor (adaptive formula was
  `bootMs × 2`, capped at the floor below and a 60-min ceiling).

Observed waste (from `memory/project_babelcast_tests.md` + cost ledger):
~$32k/year in post-ready idle billing alone, driven by three factors:
1. 15-min grace is too generous for small-/fast-boot pods where user
   disengagement is frequent.
2. `terminate` discards the pod entirely — the next session pays a full
   cold start even if the user returns 30s later.
3. The 10-min floor anchors the effective timeout above 10 min even when
   the adaptive formula wanted 5 min.

## Decision

Two changes applied together:

1. **Idle default: 15 → 5 min.** `IDLE_TIMEOUT_MS` in
   `server/constants.ts` + `DEFAULT_CONFIG.idleTimeoutMin` in
   `config-persistence.ts`.
2. **`stop` instead of `terminate`** on idle trip. The 2-hour auto-destroy
   already scheduled by `scheduleAutoDestroy()` handles the hard delete.
3. **Adaptive floor 10 → 5 min** in `server/gpu-idle-logic.ts`
   (`MIN_IDLE_TIMEOUT_MS`) so the floor doesn't cap the new 5-min default.
   Heavy images (70B boot × 2) still get their proportionally longer idle
   window via the adaptive formula.

## Reasoning

- **5-min default.** Matches observed user return cadence — re-engagement
  after 5 min is a fresh session in most UX. Balances responsiveness of
  resume against cumulative idle cost.
- **Stop vs terminate.** Stop preserves VRAM-warmed state on providers
  that support it (RunPod Secure, TensorDock VMs). Resume is typically
  ~10× faster than a cold redeploy because the container state and
  recently-pulled image layers are retained.
- **Why 2h auto-destroy?** A stopped pod still incurs storage cost. 2h
  is long enough for a natural return within the workday and short enough
  that an abandoned pod doesn't accumulate overnight.

## Alternatives Considered

### Always keep warm (no idle stop)
Rejected — single-tenant cost does not justify.

### Snapshot on every stop (via CRIUgpu)
Deferred — see ADR-012. Snapshot provides a better "cold" path but still
benefits from having the stop threshold tight. Non-contradictory.

### Dynamic idle based on user session patterns
Deferred — requires per-user telemetry we don't have.

## Consequences

### Positive
- Estimated ~$25k/year recovery of post-ready idle billing.
- Resume path is fast because stopped pods retain image cache.
- Heavy images unaffected (adaptive formula still scales with boot time).

### Negative
- Users returning after >5 min incur a resume (~10s on RunPod), not a
  continuation.
- Slightly higher risk of hitting provider stopped-instance limits if many
  profiles are idle simultaneously.

## Monitoring

```
- idle_stop_count_total{provider}
- idle_resume_count_total{provider}
- idle_auto_destroy_count_total{provider}
- stopped_pod_age_seconds{provider}
```

## Notes

Implemented in Phase A (commit `5466b8f` + `a298754`). The `MIN_IDLE_TIMEOUT_MS`
floor fix was a follow-up after merge because `gpu-idle-logic.ts` was
untracked on main during the Phase A agent's worktree session.
