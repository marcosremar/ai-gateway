# Cross-Ownership Harvest — Routing + State Cluster (x6)

File cluster: `src/gateway/routing/`, `src/gateway/state/`, `src/client/`.
Wave: cross-ownership harvest — items catalogued across multiple audit docs whose
target code lives in this cluster. Each is safe, localized, back-compatible, and
covered by a unit test in `__tests__/opt/x6-routing-state.test.ts`.

Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/x6-routing-state.test.ts`
Result: 29 tests, all passing. Existing tests touching these modules
(`04-provider-routing`, `03-autoscaling-w3`, `04-provider-routing-w2`,
`08-storage`, `08-storage-w2`, `08-storage-w4`, `06-observability-w2`) re-run
green (194 passing) — no behavioral regressions.

## Implemented

| ID | File:line | Change | Test |
|----|-----------|--------|------|
| #9 | src/gateway/routing/provider-racer.ts:73-96,113-123,212-216 | Added opt-in `overallDeadlineMs` race ceiling so a candidate with no `timeoutMs` cannot wedge the pipeline; fires once, aborts all controllers, surfaces the all-failed path. Wired into both single- and multi-candidate paths (single uses `min(timeoutMs, deadline)`). | `provider-racer #9 — overall deadline` (3 cases: multi abort, single abort, winner-before-deadline) |
| #10 | src/gateway/routing/provider-racer.ts:22-37,189-192 | `otherCancelled` now reflects reality (`controllers.length > 1`) instead of the hard-coded `true`; single-candidate path reports `false`. | `provider-racer #10/#87` (single false, multi true) |
| #87 | src/gateway/routing/provider-racer.ts:26-31,180-193 | Added `wastedCalls` counter on `RaceResult` + opt-in `onWaste(n)` callback so operators can weigh speculative/loser call cost against the latency win. | `provider-racer #10/#87` (counts losers; onWaste invoked with count) |
| #14 | src/gateway/routing/provider-racer.ts:38-60 | New pure `computeRetryDelayMs(attempt, {baseMs,maxMs,retryAfterMs,rand})` — exponential backoff with full jitter honoring a `Retry-After` floor; injectable `rand` for deterministic tests. Available for callers to honor 429s instead of immediate hard-fail. | `provider-racer #14 — computeRetryDelayMs` (4 cases: growth, cap, jitter bounds, Retry-After floor) |
| #516 | src/gateway/routing/ewma-tracker.ts:57-83,131-136,158-180 | New pure `updatePeak(prevPeak,newLatency,ewma,decay)` that latches onto new highs and decays the peak only slowly (default 5%/sample) toward the mean, so a brief tail spike keeps the provider deprioritised for many samples (legacy 0.5 blend averaged it away in ~3 samples). `record()` now uses it; `peakDecay` is configurable, `decay=0.5` reproduces legacy. | `ewma-tracker #516 — updatePeak` (latch, slow decay, never < ewma, legacy decay=0.5, end-to-end via record/rankingByScore) |
| #517 | src/gateway/routing/ewma-tracker.ts:64-114,194-225 | `pickBest` now treats a provider with `< minSamples` observations as "unknown" so one fast fluke cannot pin routing. Opt-in via `new EWMATracker(decay, { minSamples })`; default 1 preserves legacy single-sample trust. | `ewma-tracker #517 — min-sample gate` (default trust, gate below N, eligible at N, all-cold cost tie-break) |
| #506 | src/gateway/state/readiness-state.ts:89-99 | Widened `PER_STAGE_RING_SIZE` 20 → 100 so per-stage p95 (index 94/100) is no longer dominated by a single spike (was 2nd-worst of 20). | `readiness-state #506` (one spike among 100 does not move p95) |
| #507 | src/gateway/state/readiness-state.ts:104-123 | Per-stage ring index is reset on wrap (`(idx+1) % SIZE`) so the counter no longer grows unbounded for the process lifetime. | `readiness-state #507` (index bounded after 1000 records; values still cycle) |
| #508 | src/gateway/state/readiness-state.ts:104-106 | Init guard changed from `!perStageRingIdx[key]` to `=== undefined` so a legitimate counter value of 0 is not treated as uninitialised. | `readiness-state #508` (counter value 0 not reset; wrap overwrites index 0) |
| #720 | src/gateway/state/readiness-state.ts:7,366-372 | `saveColdStartProfile` now writes to `.tmp` then `renameSync`s into place (atomic), mirroring deploy-state/cost-state — a crash mid-write no longer corrupts the profiles file. | `readiness-state #720` (write→rename order; write target is `.tmp`) |
| #543 | src/gateway/state/cost-state.ts:204-213 | `persistDailySpend` now writes the tracked `dailySpendResetDate` instead of wall-clock "now", so a write that fires just after a UTC rollover (before the monitor reset) no longer stamps the new day with yesterday's spend. | `cost-state #543` (persisted `date` equals the set reset date, not today) |
| #545 | src/gateway/state/cost-state.ts:39-59,86-99 | Added `deploysBlockedTotal{soft_limit_exceeded,hard_limit_exceeded}` counter (+ `resetDeploysBlocked()`), incremented in `canAffordDeploy` refusal paths, so operators can surface `gateway_deploys_blocked_total{reason}` and see how often the cap throttles work. | `cost-state #545` (no bump without cap; hard vs soft counted separately) |
| #510 | src/gateway/state/metrics-state.ts:135-145 | `getLatencyTrend` now defensively copies the live ring (`latencyRing.slice()`) on the un-wrapped branch instead of aliasing it — removes a latent footgun where future in-place mutation would corrupt the shared buffer. | `metrics-state #510` (live ring unchanged after computing trend) |
| #511 | src/gateway/state/metrics-state.ts:122-145,279-292 | Extracted OLS slope into a pure exported `olsSlope(ys, xs?)` (index-as-time by default, accepts real timestamps; guards degenerate inputs / zero denominator → 0, no NaN). `getLatencyTrend` reuses it and `slopeMs` is documented as per-sample (not a wall-clock rate). | `metrics-state #511` (slope sign/magnitude; degenerate inputs safe) |

## Deferred (out of scope / risky / cross-file)

| ID | File | Reason |
|----|------|--------|
| #349 | src/client/ai-client.ts:305-306 | Behavioral: requires measuring *real* time-to-first-chunk from a streaming TTS response and threading it through `synthesize()`. Non-streaming synthesize has no first-chunk signal; a faithful fix needs a streaming code path change — too invasive for a safe localized harvest. |
| #352 | src/client/ai-client.ts + src/gateway/providers/cloud/fallback.ts | Out of ownership: wiring the TTFAC tracker into the shared `FallbackOptions`/`withProviderFallback` requires editing `fallback.ts` (outside this cluster). `synthesize()` already pre-ranks via `rankByTtfac`, so the gap is in the fallback module, not the client. |
| #528 | src/gateway/state/cost-state.ts:29 | Behavioral + cross-module: folding per-token cloud spend into the daily budget gate changes budget semantics and depends on `src/tracking/` spend wiring + the monitor loop in `server/`. High-impact; needs an ADR-level decision, not a localized edit. |
| #544 | src/gateway/state/cost-state.ts:110 | `flushDailySpend()` is already correct; the finding is "confirm it is wired to SIGTERM/beforeExit", which lives in `server/` shutdown code (outside this cluster). No safe in-cluster change. |
| #708 | src/gateway/state/deploy-state.ts:196-205 | `clearPersistedDeploy` vs concurrent `persistDeployState` race needs a process-wide write lock/serialized queue spanning both functions; correctness-sensitive concurrency change deferred to avoid subtle regressions. |
| #14 (retry wiring) | src/gateway/routing/provider-racer.ts | Only the pure `computeRetryDelayMs` helper was added. Actually retrying inside `raceProviders` on `AggregateError` is a behavioral change (extra upstream calls, latency) and is left to callers; deferred to keep the race semantics back-compat. |
