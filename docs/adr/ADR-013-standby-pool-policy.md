# ADR-013: Standby Pool Policy

**Status:** Accepted
**Date:** 2026-04-17
**Deciders:** Marcos

## Context

Even with a working snapshot path (ADR-012), the first request of a fresh
deploy still pays the ~5s restore cost. For latency-critical workloads
(real-time translation, interactive agents) that is still too much.

Modal, Beam, and Cerebrium solve this with pre-warmed pools — N restored
pods sit in `/health` loops, not serving traffic, waiting to be checked
out by the first matching request. The economics only work if the restored
pods are cheap to keep alive; hence the hard dependency on ADR-012.

## Decision

Implement `server/standby-pool.ts` as a registry + monitor:

```typescript
setStandbyPoolConfig({
  profile: 'babelcast',
  tier: 'vast-vm',       // or 'hyperstack' — snapshot-capable only
  minStandby: 1,
  maxStandby: 2,
  dockerImage: '...',
  gpuTypes: [...],
});
```

Monitor tick every 30s:
- If `healthy(profile) < minStandby` → trigger async deploy (via injected
  `PoolDeployFn` adapter). Deploys go through the normal snapshot-restore
  path (ADR-012), so refill is fast.
- If `healthy(profile) > maxStandby` → terminate oldest idle pod.

Checkout API:
- `checkout(profile)` → pop a ready pod; pool refills async.
- `release(profile, podId)` → optional return; pool does not depend on it.

### Gating

The pool is **opt-in per profile**. No profile registered = no deploys. The
monitor starts at boot (see `startup-tasks.ts` step 5b) but does nothing
until `setStandbyPoolConfig` is called — typically from the admin UI or a
deploy config.

Adapter functions (`PoolDeployFn`, `PoolTerminateFn`) are wired separately
via `setPoolAdapters()`. Without adapters installed, any registration logs
a warning and is a no-op. This prevents accidental GPU spend during
rollout.

## Reasoning

- **Why tie to snapshot-capable tiers?** Refill cost dominates the pool
  budget. Without snapshot (5-30s boot), pool refill is expensive enough
  that keep-warm is only marginally better than cold-path. With snapshot,
  refill is a rounding error in the hourly burn rate.
- **Why opt-in, adapter-less default?** Rolling out pool across all
  profiles would be a silent multi-hundred-dollar surprise in the monthly
  bill. Explicit gating forces intentional activation.
- **Why min/max (not fixed N)?** Traffic bursts should temporarily expand
  the pool; quiet periods should contract. Simple hysteresis.
- **Why 30s tick?** Balance between reactivity (shorter = faster refill)
  and API-call cost against the provider. Deploy itself is async, so the
  tick is just the decision cadence, not the blocking step.

## Alternatives Considered

### Pool on any provider (not snapshot-gated)
Rejected — economics only justify pool when refill is cheap.

### Predictive pool (ML-based scaling ahead of demand)
Deferred — see throttLL'eM paper (arxiv 2408.05235). Interesting, but
requires traffic history we don't yet have at adequate resolution.

### Single global pool vs per-profile pool
Per-profile chosen because different profiles use different images, models,
and GPUs. Sharing pods across profiles would require live re-provisioning
that defeats the purpose.

## Consequences

### Positive
- First-request latency drops from ~5s (restore) to <200ms (checkout +
  health probe) on pre-provisioned profiles.
- Uniform cold-start experience for recurring workloads.

### Negative
- Baseline cost proportional to `minStandby × N profiles`, even when idle.
- If pool config drifts from actual deploy config (image, env), checked-out
  pods may fail the first real request. Mitigation: include image hash +
  model hash in pool config key.

## Monitoring

```
- standby_pool_size{profile,state}      // state = ready | booting | checked-out
- standby_pool_checkout_count_total{profile}
- standby_pool_checkout_wait_ms{profile}
- standby_pool_refill_count_total{profile}
- standby_pool_scale_down_count_total{profile}
```

## Notes

Implemented in Phase B (commit `122cfcf`) + wiring commit `3e6fbe5`.

**Deferred — not in initial rollout:**
- Adapter implementations (`PoolDeployFn` bridging to `startDeployLoop`;
  `PoolTerminateFn`). Without these, the monitor is running but inactive.
  This is intentional — rollout plan is (1) land the module, (2) ship
  admin UI for pool config, (3) wire adapters and ship with a default
  cap on total pool spend.
- Pool config persistence (currently in-memory only).
