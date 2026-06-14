# Observability, Metrics & Cost Tracking — Wave 2 (implemented)

Continuation of `docs/optimizations/06-observability-cost.md` (IDs 501-600).
Wave 1 lives in `docs/optimizations/implemented/06-observability*.md` and
`__tests__/opt/06-observability.test.ts`. This wave picks a **different** batch of
safe, localized items. All edits stay within the assigned ownership set; nothing
in `src/gateway/state/**`, `src/modules/**`, `src/index.ts`, or build config was
touched.

Tests: `__tests__/opt/06-observability-w2.test.ts` (21 tests, all pass).
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/06-observability-w2.test.ts`
Full opt suite re-verified green (680 tests, 22 files) — no regression to wave 1.

| ID | File:line | Change | Test |
|----|-----------|--------|------|
| #577 | src/events/index.ts:36-141 | EventBus history is now a fixed-size ring buffer with a write cursor — emit is O(1), no `Array.shift()` reindex on a hot bus. `getHistory`/`getStats`/`clearHistory` read the ring in chronological order. | `#577 EventBus history ring buffer…` (+ wrap-around verified via spike) |
| #579 | server/event-bus.ts:48-141 | Server bus keeps a bounded (1000) queryable history; new `getEventHistory(event?, limit)` + `clearEventHistory()` so budget/GPU-lifecycle events are inspectable after the fact. | `#579 server event-bus keeps a bounded, queryable history` |
| #581 | server/event-bus.ts:63-113 | Skip the audit-trail `JSON.stringify(data)` entirely when `LOG_LEVEL` is above info (warn/error/fatal/silent) — no wasted stringify for a line nobody will see. | (behavioral; covered indirectly — history records still populated) |
| #584 | src/request-logger/index.ts:50-101 | Index entries by `requestId` in a `Map`; `logResponse`/`getById` are O(1) instead of an `Array.find` per response. Index entry evicted with the ring entry (guarded against id reuse). | `#584 request-logger logResponse/getById use an id index` |
| #585 | src/request-logger/index.ts:60-156 | Cache each entry's epoch ms (`tsMs`); `getStats` RPM window uses it instead of `new Date(e.timestamp)` per entry per call. | `#585 getStats RPM counts recent entries via cached epoch` |
| #586 | src/error-summary/index.ts:27-131 | Cache epoch ms (`tsMs`) on each `ErrorEntry`; `getSummary`/`checkAlerts` filters use it instead of re-parsing the ISO string on every pass over up to 1000 entries. | `#586 error-summary stores epoch ms alongside the ISO timestamp` |
| #589 | src/metrics-collector/index.ts:71-178 | Cardinality guard: cap distinct label-sets per metric name (env `METRICS_MAX_SERIES_PER_METRIC`, default 1000; runtime `setMaxSeriesPerMetric`). New series past the cap are dropped + counted (`getDroppedCardinalityCount`); existing series keep updating. Prevents the classic Prometheus blowup from a high-cardinality label. | `#589 metrics-collector caps series per metric…` (2 tests) |
| #597 | src/alerting/alert-router.ts:14-52 | Dedupe map expires lazily on lookup (stale key dropped + re-added), with an amortized full sweep only once per dedupe window — no per-`route()` O(n) scan during an alert storm. | `#597 AlertRouter dedupe re-fires after the window via lazy expiry` |
| #562 | src/tracking/cost-anomaly-detector.ts:86-108,209-211 | New `idle_gpu_waste` anomaly: a billing GPU (`active`, `costPerHr>0`) that served no request past `idleGpuMinutes` is flagged with estimated wasted USD. Fed by an injected `getIdleGpuSnapshot()`. The biggest waste class (paying $/hr for nothing). | `#562 cost-anomaly-detector flags idle billing GPU waste` (2 tests) |
| #561 | src/tracking/cost-anomaly-detector.ts:184-209 | `untracked_realtime` now estimates cost from audio-minute duration when the store exposes `sumRealtimeDurationMinutes` (× `realtimeUsdPerMinute`), instead of reporting $0. Falls back to count-only when unavailable. | `#561 cost-anomaly-detector estimates realtime cost from duration` (2 tests) |
| #559/#560 | src/tracking/cost-anomaly-detector.ts:214-249 | New `detectAndAlert()` routes warning/critical anomalies (skips info) to an injected `alertSink` (structural AlertRouter shape — no import cycle). A throwing sink never breaks detection. | `#559/#560 detectAndAlert routes warning/critical anomalies to the sink` (2 tests) |
| #524 | server/cost-tracker.ts:31-37 | Map previously-missing `fireworks:tts` and `ollama:{llm,stt,tts}` so those requests are counted, not silently $0 + unmapped. (`deepgram:stt`/`elevenlabs:tts` deliberately left to the unmapped path — wave-1 tests assert they stay unmapped.) | `#524 cost-tracker maps previously-missing provider:stage pairs` (2 tests) |
| #537 | server/gpu-cost-audit.ts:20-58,134-160 | `StoppedPodAudit.estMonthlyUsd` + report `stoppedPodsMonthlyUsd`: each stopped pod gets a storage-cost estimate (`estStoppedPodMonthlyUsd`, env-tunable rate/default disk) so operators prioritize cleanup by dollars, not a bare count. | `#537 stopped-pod audit attaches a monthly storage cost estimate` |
| #556 | src/tracking/spend-tracker.ts:78-104 | Count invalid (negative/non-finite) cost records (`getInvalidCount`) so a systematic bad-cost bug is observable as a metric, not just log noise. Also rejects `NaN`/`Infinity`. | `#556 SpendTracker exposes an invalid-record counter` |
| #555 | src/tracking/budget-guard.ts:52-60 | Remove self-mapping no-op downgrade entries (`gpt-4o-mini-tts`/`whisper-…turbo` → themselves) from `DEFAULT_DOWNGRADES`; they were dead config obscuring which models actually have a cheaper tier. Behavior unchanged (the `!== model` guard already skipped them). | `#555 budget-guard default downgrades only list real cheaper tiers` |
| #599 | src/alerting/slo-targets.ts:71-86 | `resolveDailySpendSlo(env?)` derives the daily-spend SLO from `DAILY_BUDGET_USD` (the live cap the deploy gate reads), falling back to the documented default when unset/zero/invalid — so raising the env cap won't false-alarm an SLO check. | `#599 daily-spend SLO is derived from the live budget env` (2 tests) |

## Notes / design choices

- **Backward-compat:** every new struct field (`tsMs`, `estMonthlyUsd`) is optional
  or additive; new methods are additive. Existing call sites and wave-1 tests are
  untouched in behavior. Re-ran the entire opt suite (680 tests) — all green.
- **#581** is gated on `LOG_LEVEL` read once at module load; the env value pino
  itself reads, so it stays consistent with actual log filtering.
- **#589** cap defaults to 1000 (matching Prometheus practice); a `setMaxSeriesPerMetric`
  setter exists for runtime tuning and deterministic tests (env is read once at
  load and the module is shared across test files in a worker).
- **#559/#560** uses a structural `AnomalyAlertSink` interface rather than importing
  `AlertRouter` to avoid an `src/tracking` → `src/alerting` dependency/cycle; the
  real `AlertRouter.route` satisfies it.

## Deferred (and why)

| ID | Reason |
|----|--------|
| #501-#511, #532-#533 | Live in `server/metrics.ts` (snapshot/scrape internals) — large, high-traffic file; the sort-caching + ring-dimension changes are not localized and risk the hot scrape path. Defer to a focused metrics.ts pass. |
| #505/#506/#507 | Latency-ring shape lives in `src/gateway/state/metrics-state.ts` / `readiness-state.ts` — **out of ownership** (`src/gateway/state/**`, another owner). |
| #512/#521/#564-#575 | Distributed tracer / OTLP / OTel under `src/platform/observability/**` — out of the assigned ownership set; tracer span-duration and OTLP retry are non-trivial behavior changes. |
| #516-#520 | EWMA / TTFAC trackers under `src/gateway/routing/**` and `src/gateway/providers/**` — out of ownership. |
| #522/#523/#529/#530/#531 | Cost-model reconciliation (flat-rate vs per-token) is a High-impact, M-effort cross-cutting change spanning `server/cost-tracker.ts` ↔ `src/tracking/pricing.ts` ↔ call sites; needs an ADR and broad call-site edits — not a safe localized diff. |
| #527 | Persisting inference cost touches `src/gateway/state/cost-state.ts` (daily-spend file) — out of ownership. |
| #534-#536/#538-#540/#549-#550 | RunPod volume rate config, multi-provider audit expansion, and balance reconciliation require provider-API calls / `server/gpu-monitor-loop.ts` (not in ownership) — network-touching, deferred. |
| #541-#548/#551 | Daily-spend persistence/atomicity/threshold-persist live in `src/gateway/state/cost-state.ts` — out of ownership. |
| #553/#554 | Budget-guard hot-path uses `getDailyTotalFast` already (wave-1 #552); switching `checkAndDowngrade` off `getDailySummary` is a behavior change to the guard's per-provider logic — deferred to keep the diff minimal and avoid altering downgrade semantics. |
| #557 | Per-user rolling-baseline z-scores (M effort) need historical state the current `UsageLogStore` doesn't expose — larger design change. |
| #563 | `gateway_cost_per_success_usd` export lives in `server/metrics.ts` scrape path — deferred with the metrics.ts batch. |
| #576/#583 | Consolidating the two event buses / per-hook timeout isolation are M-effort architectural changes (touch `merge-hooks.ts`, both buses) — deferred. |
| #578 | Per-type ring buffers for `getHistory` filtering — the ring (#577) already makes emit O(1); per-type indexing is a further optimization with more state, low marginal value now. |
| #587 | True error *rate* needs total-operation counts the error-summary collection doesn't track — requires plumbing request totals in (cross-module). |
| #588 | Already addressed in wave 1 (the `samples` array is gone; `sampleCount` counter remains). |
| #591-#594/#598/#600 | Prometheus histogram export, SLO evaluator, Langfuse batching live in `server/metrics.ts` / `src/platform/observability/**` — out of ownership or large behavior changes. |
