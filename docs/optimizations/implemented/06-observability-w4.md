# Observability, Metrics & Cost — Wave 4 (implemented)

Continuation of waves 1-3 for `docs/optimizations/06-observability-cost.md`
(IDs 501-600). Wave 4 implements the next batch of **safe, localized, in-scope**
items. Strict ownership boundary respected (only `src/tracking/`,
`src/alerting/`, `src/metrics-collector/`, `server/metrics.ts`).

Tests: `__tests__/opt/06-observability-w4.test.ts` — **31 tests, all passing.**
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/06-observability-w4.test.ts`

## Implemented

| ID | Title | File(s) | Change | Test |
|----|-------|---------|--------|------|
| #504 | Latency ring labeled "all stages" but only GPU-fed | `server/metrics.ts` | Corrected HELP (GPU-only, not "across all stages"); added correctly-named `gateway_gpu_latency_p{50,95,99}_ms` gauges. Legacy `gateway_latency_p*_ms` kept for back-compat. | renders GPU-scoped gauges; legacy HELP no longer claims "all stages" |
| #529 | TTS/STT priced per-token though billed per char/minute | `src/tracking/pricing.ts` | Added `CostUnit`/`UnitPricing` types, `DEFAULT_UNIT_PRICING` (per-char TTS, per-minute STT), `lookupUnitPricing`, `estimateUnitCost`. Token estimator untouched. | char/minute pricing correct; null fallback for token-only models; negative clamp |
| #531 | GPU/TensorDock $0/token with no hourly attribution | `src/tracking/pricing.ts` | Added `amortizeHourlyCost(costPerHr, latencyMs)` = `costPerHr × latencyMs/3.6e6` (busy-time marginal cost per request). | exact amortization, linear scaling, invalid→0 |
| #548 | `CostWatcher` not wired to the live spend counter | `src/alerting/cost-watcher.ts` | Added `reportFrom(getSpendUsd)` — pulls the live counter and routes through the existing threshold logic (single source of truth). Defensive (never throws). | fires/sticky like report(); survives throwing getter; disabled cap |
| #553 | Per-user budget block scans the whole day list | `src/tracking/budget-guard.ts` | `checkAndDowngrade` now reads the O(1) atomic daily-total hash via a `getDailySpendFast` helper (falls back to `getDailySummary` for trackers lacking `getDailyTotalFast`). | pass/downgrade/block bands; legacy-tracker fallback |
| #554 | `MAX_RECORDS_PER_DAY` truncates list-summed spend | `src/tracking/spend-tracker.ts` | Added `checkBudgetFast` summing the untruncated `spend:daily:` hash (authoritative) instead of the capped records list. | hash total authoritative past list cap; over-budget detection; zero-limit |
| #588 | `metrics-collector.samples` array bounded but pointless | `src/metrics-collector/index.ts` (code already landed in earlier wave) | Regression test locking in that `recentSamples` is a plain counter and no per-sample object ring is retained. | counter monotonic; no `samples` array; reset zeroes |
| #591 | Prometheus latency exposed as gauges, not histograms | `server/metrics.ts` | Added `computeLatencyHistogram` + `LATENCY_BUCKETS_MS`; emit a real cumulative `gateway_gpu_latency_ms` histogram (`_bucket{le}`, `+Inf`, `_sum`, `_count`) so `histogram_quantile()` / cross-instance aggregation works. Gauges kept. | cumulative le-buckets; non-decreasing; empty ring; Prometheus output shape |

### Notes on approach
- **Purely additive**: new exports, one new optional method, corrected HELP
  strings, extra Prometheus lines. No signatures changed, no behavior removed.
  The only swapped read path (#553) falls back gracefully and yields identical
  values for non-truncated data.
- **#588** code was already present from a prior wave (the `samples` ring was
  replaced by `sampleCount`); wave 4 adds the missing regression test so the
  optimization is locked against reintroduction.
- All edited modules import cleanly (verified by the test run transform/import)
  and the full 06-observability suite (waves 1-4, **102 tests**) passes,
  confirming back-compat.

## Deferred (with reasons)

| ID | Title | Reason deferred |
|----|-------|-----------------|
| #503 | `computePercentile` nearest-rank vs interpolated | Recommendation requires reconciling with `TtfacTracker.percentile` in `src/gateway/providers/cloud/ttfac-tracker.ts`, which is **out of ownership**. Adding an unused canonical export in `server/metrics.ts` would be a half-measure; deferred for a cross-module pass. |
| #522 | Two divergent cost models never reconcile | High-impact/High-effort consolidation of `server/cost-tracker.ts` (flat per-request) onto `src/tracking/pricing.ts` (per-token). Wave-1 design intentionally keeps both with the unmapped-warning path; reconciliation risks regressing existing wave-1/2/3 tests. Needs its own ADR + spec. |
| #523 | Per-request cost constants contradict comments | Making token-scaling mandatory for LLM keys changes the meaning of nearly all call sites (cross-module, in `server/ai-handlers.ts` etc. — out of scope). Coupled with #522. |
| #535 | Volume orphan detection by name-substring unreliable | Requires provider-side attachment metadata from `runpod` client (`server/providers.ts`, **out of ownership**). Not localizable to `gpu-cost-audit.ts`. |
| #536 | Audit ignores TensorDock & Modal resources | Needs new `tensordock`/`modal` list-storage API calls via `server/providers.ts` (**out of ownership**). |
| #547 | CostWatcher & monitor-loop duplicate thresholds | The fix routes `server/gpu-monitor-loop.ts` spend through `CostWatcher`; monitor-loop is **out of ownership**. (#548 lays the groundwork: `reportFrom` is the seam the monitor loop would call.) |
| #576 | Two separate event buses with diverging semantics | High-effort consolidation spanning `server/event-bus.ts` + `src/event-bus/` + all consumers; risks breaking many existing tests. Needs a dedicated migration. |
| #583 | Hooks fire serially with no isolation budget | The per-hook timeout belongs in `src/events/merge-hooks.ts`, which is **out of ownership** (only `src/events/hooks.ts` is owned, and its per-hook error counting is already done as #582). |
