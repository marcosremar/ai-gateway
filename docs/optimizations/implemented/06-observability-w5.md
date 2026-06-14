# Observability, Metrics & Cost — Wave 5 (implemented)

Continuation of waves 1-4 for [`docs/optimizations/06-observability-cost.md`](../06-observability-cost.md)
(IDs 501-600). The safe, localized, in-scope pool is now **effectively exhausted** —
waves 1-4 already landed the bulk of the safe items (and several recommendations'
*code* was implemented even where the test tag lived elsewhere). Wave 5 deliberately
does fewer, higher-confidence items: it closes the remaining **exposition gaps**
(diagnostic counters that existed on their module singletons but were never surfaced
to `/metrics`) and completes the **SLO breach windowing** that #598 left half-built.

Strict ownership respected: only `src/alerting/slo-targets.ts` and `server/metrics.ts`
were edited (both in the ownership set). No behavior removed; all changes additive.

Tests: [`__tests__/opt/06-observability-w5.test.ts`](../../../__tests__/opt/06-observability-w5.test.ts) — **15 tests, all passing.**
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/06-observability-w5.test.ts`
Waves 1-5 re-run together: **117 tests, all green** (no regression to 1-4).

## Implemented

| ID | Title | File(s) | Change | Test |
|----|-------|---------|--------|------|
| #525 | Unknown provider:stage silently costs $0 | `server/metrics.ts` | The unmapped-pair counter already existed in `cost-tracker` (`getInferenceCostStats().unmappedRequests`) but was dropped from the snapshot/exposition. Added `cost.unmappedRequests` to the snapshot and emit `gateway_cost_unmapped_total` (counter) so a growing silent-spend gap is scrapeable / alertable. | snapshot delta = exactly the # of unmapped records; mapped pair doesn't bump it; counter line rendered |
| #580 | Event-bus handler errors swallowed with no metric | `server/metrics.ts` | `server/event-bus.ts` already counts per-event handler exceptions (`handlerErrorCount()`), but nothing exported it. Snapshot now carries `observability.eventHandlerErrors`; exposition emits `gateway_event_handler_errors_total`. | throwing handler bumps both the counter and the exported metric delta by 1 |
| #582 | `emitHook` swallows errors with no counter | `server/metrics.ts` | `src/events/hooks.ts` already counts hook callback failures (`getHookErrorCount()`); now surfaced as `observability.hookErrors` + `gateway_hook_errors_total`. | throwing `onScaleUp` bumps `getHookErrorCount` and the metric delta by 1 |
| #589 | `metrics-collector` cardinality drops invisible | `server/metrics.ts` | The cardinality cap + drop counter landed in wave 2 (`metrics.getDroppedCardinalityCount()`) but the drop count was never exported. Now `observability.droppedCardinality` + `gateway_metrics_dropped_cardinality_total`. | series past the cap increment the exported counter |
| #598 (cont.) | SLO breach window tracker | `src/alerting/slo-targets.ts` | Wave 3 added `evaluateSlos()` (single-snapshot breaches) and `breachAction(count)`, but nothing held breaches over time, so `SLO_BREACH_POLICY`'s page (2-in-30m) / failover (5-in-60m) **windows were dead config** — the count had no source. Added `SloBreachTracker`: records breaches with timestamps, prunes to the widest policy window (+ a hard per-metric cap), and computes the windowed count per metric → `breachAction`. `recordBreaches(evaluateSlos(...))` returns per-metric escalations in one call. Pure + clock-injectable. | none→warn→page→failover ladder; stale breaches pruned out of window; per-metric isolation; `recordBreaches` one-step escalation; `maxPerMetric` bound; `clear()` |

### Notes on approach / safety

- **Purely additive.** The four `/metrics` items add new snapshot fields and new
  Prometheus lines (new metric names) only — no existing metric name, value, or
  HELP string changed. Existing dashboards/tests are untouched.
- **Defensive reads.** The new diagnostic snapshot reads go through a `safeReadCounter`
  helper: a missing/throwing source yields `0` rather than failing the whole
  `/metrics` scrape (regression-tested: snapshot/exposition never throw).
- **No new cross-boundary coupling beyond ownership.** `server/metrics.ts` now imports
  `handlerErrorCount` (`server/event-bus.ts`), `getHookErrorCount` (`src/events/hooks.ts`),
  and the `metrics` singleton (`src/metrics-collector`) — all inside the ownership set.
- **`SloBreachTracker` is opt-in.** It's a new class no live path constructs yet; it's the
  seam an SLO-monitor loop (out of ownership) would call. The value path is ready:
  `evaluateSlos` (#598) → `recordBreaches` → `breachAction` (all in this owned module).
- **Counters are process-global singletons.** The w5 tests assert *deltas* and exposition
  *shape* (TYPE lines, regex) rather than absolute zero, because the opt suite shares a
  worker and sibling tests may have already incremented these counters — keeps the suite
  order-independent.

## Safe pool status

**Exhausted for this ownership set.** A walk of every owned file confirms the remaining
audit IDs are either already implemented in code (waves 1-4, sometimes tagged in other
test files), or require touching modules outside the strict ownership list. The
deferred table below records the specific blocker for each remaining ID.

## Deferred (with reasons)

| ID(s) | Reason deferred |
|-------|-----------------|
| #503 | Reconciling nearest-rank vs interpolated percentile gateway-wide touches `src/gateway/providers/cloud/ttfac-tracker.ts` (out of ownership); a local-only canonical export would be a half-measure. (#501/#502 already aligned the owned call sites.) |
| #505–#511 | Latency-ring shape / per-stage ring / p95-cache live in `src/gateway/state/metrics-state.ts` & `readiness-state.ts` — `src/gateway/state/**` is explicitly excluded. |
| #512, #516–#521, #564–#575, #600 | Distributed tracer / OTLP / OTel span lifecycle / EWMA / TTFAC / Langfuse live under `src/platform/observability/**` and `src/gateway/routing|providers/**` — out of ownership. (`src/observability/*` are thin barrels.) |
| #522, #523 | Cost-model consolidation (flat-rate ↔ per-token) is High-impact/cross-cutting across `server/cost-tracker.ts` ↔ `src/tracking/pricing.ts` ↔ call sites (`server/ai-handlers.ts`); needs an ADR + broad edits, not a safe localized diff. |
| #535, #536, #538–#540, #549, #550 | RunPod volume attachment metadata, multi-provider (TensorDock/Modal) audit, restart double-charge, balance reconciliation require provider-API calls and/or `server/gpu-monitor-loop.ts` — out of ownership / network-touching. |
| #541–#547, #551 | Daily-spend persistence/atomicity/threshold-flush/`deploys_blocked` counter & the CostWatcher↔monitor-loop merge live in `src/gateway/state/cost-state.ts` / `server/gpu-monitor-loop.ts` — out of ownership. |
| #576, #583 | Consolidating the two event buses / per-hook timeout isolation (`src/events/merge-hooks.ts`) are M-effort architectural changes spanning out-of-ownership files; risk breaking many existing tests. |
| #514, #515, #524, #527, #530, #532–#534, #537, #553–#563, #577–#579, #581, #584–#594, #597, #599 | **Already implemented** in waves 1-4 (verified in source). Several recommendations' code landed even though the test tag lives in another wave's file (e.g. #514/#515 percentile fixes carry explanatory comments in `performance-profiler`/`benchmark-tracker`). |
