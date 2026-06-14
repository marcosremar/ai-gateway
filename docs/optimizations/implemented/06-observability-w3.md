# Observability, Metrics & Cost Tracking — Wave 3 (implemented)

Source audit: [`docs/optimizations/06-observability-cost.md`](../06-observability-cost.md) (IDs 501-600).
Continuation of waves 1 & 2. This wave implements 15 NEW, high-value, SAFE, localized
items, each with a unit test in
[`__tests__/opt/06-observability-w3.test.ts`](../../../__tests__/opt/06-observability-w3.test.ts).

Tests: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/06-observability-w3.test.ts`
→ **26 tests, all passing**. w1+w2 suites re-run green (no regressions).

## Implemented

| ID | Lens | File(s) | What changed |
|----|------|---------|--------------|
| #501 | Reliability | `server/metrics.ts` | `snapshotMetrics()` no longer re-sorts the 1000-entry `latencyRing` on every `/metrics` scrape. Added `getSortedLatencies()` — a sorted copy cached against `latencyRingGeneration` (same pattern as `getP95Latency()`); the sort happens once per new sample batch, not per scrape. |
| #502 | Reliability | `server/diagnostics-handlers.ts` | `handleDiagnosticsScores` sorted `latencyRing` twice (p50 + p95) using `Math.floor` (off-by-one, overstating the tail). Now sorts once and slices both percentiles via the shared `computePercentile()`, so diagnostics agree with `/metrics`. |
| #527 | Cost | `server/cost-tracker.ts` | Cumulative inference cost was RAM-only, lost on restart. Added `getCumulativeInferenceCostUsd()` (for persistence) and `loadInferenceCostTotal()` (monotonic seed at startup — only advances, never lowers). |
| #530 | Cost | `src/tracking/pricing.ts` | Pricing table was undated. Added `PRICING_TABLE_AS_OF` revision stamp + `isPricingStale(maxAgeMonths, now)` so a startup check/test can warn when rates are likely out of date. |
| #532 | Cost | `server/metrics.ts` | Renamed misleading `costPerGpuRequest` (which blends idle-time spend) to `blendedCostPerGpuRequestUsd` so consumers don't read it as a true per-request cost. |
| #533 | Cost | `server/metrics.ts` | `cloudRequests` was an allow-list sum of 3 providers (dropped fireworks/openrouter/deepgram). Now `cloudRequests = max(0, requestsTotal − gpuRequests)`, capturing all cloud providers. |
| #534 | Cost | `server/gpu-cost-audit.ts` | RunPod volume rate was a hardcoded `0.10` literal. Now read from `RUNPOD_VOLUME_USD_PER_GB_MONTH` env (default 0.10) and exposed via `estRunpodVolumeMonthlyUsd(sizeGb)`, also used inside the audit for consistency. |
| #557 | Cost | `src/tracking/cost-anomaly-detector.ts` | Absolute spend thresholds cause power-user alert fatigue and miss cheap-user spikes. Added opt-in per-user baseline z-score detection (`baseline_spend_spike`) via `getUserSpendBaselines` dep + `spendZScore()` helper + `baselineSpikeZScore`/`baselineSpikeMinUsd` config. Behavior unchanged when no baseline provider is supplied. |
| #563 | Cost | `server/cost-tracker.ts`, `server/metrics.ts` | Cost was never divided by *successful* requests, hiding retry-burning providers. `recordInferenceCost` now takes an optional `success` flag; stats expose `costPerSuccessByProvider`; `/metrics` exports `gateway_cost_per_success_usd{provider}`. |
| #578 | Cost | `src/events/index.ts` | `getHistory(type)` filtered the full 1000-entry ring per call. Added per-type history rings so a filtered query reads only that type's events; `clearHistory()` clears them too. |
| #587 | Functionality | `src/error-summary/index.ts` | High-error alert was a raw count (can't tell 50/60 from 50/50000). Added `recordOperation()` (bounded op-timestamp ring) so `checkAlerts` computes a true error RATE (errors ÷ ops) when ops are tracked, falling back to the absolute-volume threshold otherwise. |
| #592 | Cost | `server/metrics.ts` | `gateway_requests_by_provider` accepted any provider string → unbounded label cardinality. Added `isKnownProvider()` allow-list; unknown providers collapse into a single `provider="other"` series in the exposition. |
| #593 | Cost | `server/metrics.ts` | `gateway_gpu_ready` carried the free-form status in a label (one lingering series per distinct status). Kept the boolean gauge but added `gateway_gpu_status` as a bounded-enum gauge (fixed status set + `other`), exactly one of which is 1. |
| #594 | Cost | `server/cost-tracker.ts`, `server/metrics.ts` | Daily spend gauge resets at midnight (Grafana `increase()` goes negative). Added a monotonic `cumulativeInferenceCostUsd` (not reset by `resetDailyInferenceCost`) exported as the counter `gateway_inference_spend_usd_total`. |
| #598 | Reliability | `src/alerting/slo-targets.ts` | `SLO_TARGETS`/`SLO_BREACH_POLICY` had no evaluator. Added `evaluateSlos(snapshot, env)` (ceiling vs. floor metrics, daily-spend target derived from `DAILY_BUDGET_USD` per #599) + `breachAction(count)` mapping breach counts to none/warn/page/failover. |

## Notes on approach / safety

- All `server/metrics.ts` changes are additive or relabels; existing metric names
  (`gateway_daily_spend_usd`, `gateway_gpu_ready`, etc.) are preserved. Two thin
  public wrappers (`getMetricsSnapshot`, `renderPrometheusMetrics`) were added so the
  snapshot/exposition is testable without the HTTP handler.
- `recordInferenceCost`'s new `success` param defaults to `true` — every existing
  call site keeps its previous behavior.
- The cost-anomaly baseline check and the error-summary rate alert are both opt-in:
  they only activate when the host wires the new dep/recorder, so no live path
  changes behavior until intentionally connected.

## Deferred (with reason)

| ID(s) | Reason |
|-------|--------|
| #564–#575 (distributed-tracer / OTLP / otel span lifecycle, retry, dead-letter, unbounded `completedSpans`, AsyncLocalStorage context, in-memory↔OTLP unification) | Canonical sources live in `src/platform/observability/**` (the `src/observability/*` files are thin barrels). `src/platform/**` is outside this task's strict ownership list — SKIPPED to respect boundaries. |
| #600 (Langfuse batching/retry + correlation id) | Lives in `src/platform/observability/langfuse-hooks.ts` — outside ownership. |
| #503 (gateway-wide nearest-rank vs. interpolated percentile reconciliation) | Changing `computePercentile`'s definition globally is a cross-cutting behavioral change affecting SLO checks/dashboards (risk of moving every percentile at once). #501/#502 already align the call sites on the existing nearest-rank helper; a full nearest-rank↔interpolation reconciliation is a larger, riskier change deferred for a dedicated PR. |
| #538, #539, #546, #549, #550 (GPU spend double-charge on restart, UTC budget-day boundary, re-armable budget warnings, terminate headroom, balance-delta reconciliation) | Logic lives in `server/gpu-monitor-loop.ts` — not in the ownership list. |
| #541–#544, #509–#511 (debounced-persist threshold flush, atomic write, reset-date persist, SIGTERM flush wiring; p95-cache TTL, ring aliasing, OLS slope units) | Logic lives in `src/gateway/state/cost-state.ts` / `src/gateway/state/metrics-state.ts` — outside ownership (`src/gateway/state/**` explicitly excluded). |
| #516–#520 (EWMA peak/min-samples/eviction, TTFAC export & sweep) | Live in `src/gateway/routing/**` and `src/gateway/providers/cloud/**` — outside ownership. |
| #547, #548, #599 (live-wiring `CostWatcher` to the spend counter + monitor loop) | `CostWatcher` (#547/#548 building blocks) and `resolveDailySpendSlo` (#599) already exist from earlier waves; the remaining work is *wiring* them into `server/gpu-monitor-loop.ts`, which is outside ownership. The SLO evaluator (#598) here consumes `resolveDailySpendSlo` so the value path is ready. |
