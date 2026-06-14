# Implemented — Autoscaling, Reliability & Resilience — WAVE 3 (IDs 201-300)

Continuation (wave 3) of `docs/optimizations/03-autoscaling-reliability.md`. High-value,
SAFE, LOCALIZED fixes within the owned file set. Each change is a minimal diff that adds a
pure, unit-testable helper (and, where safe, wires it) without altering tested public
contracts or source-text assertions relied on by the existing suites.

Tests: `__tests__/opt/03-autoscaling-w3.test.ts`
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/03-autoscaling-w3.test.ts`
→ **29 passed** (29 unit tests).

Wave-1/2 opt suites (`03-autoscaling.test.ts`, `03-autoscaling-w2.test.ts`,
`03-idle-logic.test.ts`) re-run green (74 passed). Impacted existing suites re-run green:
circuit-breaker ×3 (27), ewma-tracker, request-batcher ×2, load-balancer, standby-pool ×4,
predictive ×2, health ×2, gpu-deploy + auto-recovery (229), autoscaler-unit.

| ID | File | Change | Test(s) |
|----|------|--------|---------|
| 233 | src/gateway/autoscaler/circuit-breaker.ts | `shouldCountFailure(requestId, lastCountedFailureId)` pure helper + optional `requestId` arg on `recordFailure`/`recordRequest` + persisted `lastCountedFailureId`. A request whose failure is reported via *both* `recordRequest(success=false)` and `recordFailure()` now counts **once** (was double-counted, tripping the threshold at half the intended count). No id → legacy always-count preserved. | "recordFailure same id once", "recordRequest dedups by id", "legacy behavior preserved" |
| 235 | src/gateway/autoscaler/circuit-breaker.ts | `canAdmitHalfOpenProbe(inFlight, halfOpenMaxConcurrent)` pure helper + new `canProbe(tier, inFlight)` method. The documented `halfOpenMaxConcurrent` (default 1) was never enforced — a burst in half-open all hit the recovering pod. Now closed→admit, open→refuse, half-open→cap to configured concurrency. | "canAdmitHalfOpenProbe enforces concurrency", "canProbe closed/open/half-open" |
| 237 | src/gateway/autoscaler/circuit-breaker.ts | `shouldForceReset(state, openedAt, recoveryTimeoutMs, now, maxRecoveryWindows)` pure helper, wired into `applyTimeTransition` + new `maxRecoveryWindows` config (default 5). A breaker stuck open/half-open past N recovery windows now force-resets to closed, so a recovered tier isn't blocked forever by a half-open path that keeps failing. | "shouldForceReset windows", "stuck-open resets to closed on read" |
| 251 | src/gateway/routing/ewma-tracker.ts | `effectiveScore(adjustedEwma, peak, peakWeight)` pure helper + new `rankingByScore(peakWeight)` method. Routing now has a tail-aware score that folds the tracked `peak` in (the "PeakEWMA" intent), deprioritising spiky-tail providers. Legacy `ranking()`/`getLatency()` left byte-identical (back-compat tests untouched). | "effectiveScore folds peak / reorders spiky", "rankingByScore sorted score field", "legacy ranking unchanged" |
| 252 | src/gateway/routing/ewma-tracker.ts | `stalePenaltyFactor(elapsedMs, thresholdMs, perWindow, maxFactor)` pure helper (used by `rankingByScore`). Penalty now scales with *how* stale a provider is (was a flat ×1.1 for anything >60s), capped. A 1-hour-cold provider is distrusted more than a 61s-cold one. Legacy flat penalty in `_applyStaleDecay` preserved. | "stalePenaltyFactor scales + capped" |
| 271 | src/gateway/autoscaler/request-batcher.ts | `computeBatchWaitMs(...)` pure helper + optional `minFirstWaitMs` config, wired into `submit`. The first-item adaptive window was `maxWaitMs/maxBatchSize` (tiny → batches rarely accumulate); an opt-in floor lets the first item gather a real batch. Default `minFirstWaitMs=0` → byte-identical legacy behavior. | "legacy proportional", "floors first-item wait (capped)", "minFirstWaitMs delays single-item flush" |
| 278 | src/gateway/autoscaler/predictive-warmup.ts | `warmCountForForecast(predicted, maxTiers, reqsPerTier)` pure helper. Sizes pre-warm to the forecast (one tier per N predicted reqs, clamped `[1, maxTiers]`) instead of always booting tier 0 only. | "sizes warm count to forecast" |
| 283 | server/standby-pool.ts | `canRefillPool(poolSize, healthy, min, max, slack)` pure helper, wired into `refillProfile` with `slack=0` (exact cap). The pool could previously overshoot `maxStandby` by one (`>= max+1`), defeating a dollar/hr cap. The old +1 slack is now an explicit opt-in parameter. | "refills only below floor and below exact max" |
| 285 | server/gpu-standby.ts | `standbyP95Multiplier(env, fallback)` + `shouldTriggerStandbyOnLatency(p95, target, mult)` pure helpers, wired into `checkStandbyTriggers`. The standby latency trigger was a hardcoded `p95 > target*2`; the multiplier is now tunable via `STANDBY_P95_MULTIPLIER`, clamped `[1.2, 10]`. | "standbyP95Multiplier parse/clamp", "shouldTriggerStandbyOnLatency" |
| 287 | server/gpu-standby.ts | `isDrainComplete(active, elapsed, timeout)` pure helper, wired into the handover drain loop. The loop now exits the instant `activeRequests` hits 0 (or on timeout) instead of always sleeping a fixed 200ms tick past completion — shorter handover. | "isDrainComplete exits early / on timeout" |
| 294 | src/gateway/autoscaler/load-balancer.ts | `tryConsumeWithBalance(client, tokens)` — single read-modify-write returning `{ allowed, remaining }`. `checkRateLimit` now uses it instead of `tryConsume` + a separate `getTokenBalance` (halves KV ops per gated request). Fails closed on store errors, matching `tryConsume`. | "single-op consume+balance", "checkRateLimit contract preserved", "fails closed" |
| 208 | server/gpu-monitor-loop.ts | `computeIdleWarnLevel(idleMs, timeoutMs, warnAt, imminentAt)` pure helper. Maps idle fraction to `none`/`warn`/`imminent` so the caller can re-warn at 90% (the old latch warned exactly once at 75%). Helper landed; latch re-wiring deferred (see below). | "escalates none→warn→imminent" |
| 242 | server/gpu-monitor-loop.ts | `decayCrashCounter(attempts, healthyForMs, windowMs)` pure helper + `monitorHealthySinceMs` streak tracking wired into the healthy/failed probe branches. The crash-recovery counter now decays by one after a sustained-healthy window (default 1h), restoring recovery budget for a genuinely-later crash — without the blanket per-request reset that would reopen the infinite crash→reset loop (#243 preserved). | "decayCrashCounter restores budget only after window" |
| 255 | server/gpu-monitor-loop.ts | `latencyTrendAction(slope, warmSlope, rebenchSlope)` pure helper. Maps a measured latency slope to `none`/`warm`/`rebenchmark` so the trend detector can act (pre-warm / re-benchmark) before P95 demotion instead of only logging. | "maps slope to early action" |
| 256 | server/gpu-warmth-monitor.ts | `warmthFailureAction(consecutiveFailures, markThreshold, escalateThreshold)` pure helper, wired into the warmth poll catch block. Staged escalation: `none` < 10, `mark-unhealthy` ≥ 10 (preserves prior behaviour), `escalate` ≥ 20 (stops the warmth monitor so recovery can take over a pod that's clearly not coming up). Uses `>=` so a skipped count still fires. | "stages none→mark-unhealthy→escalate" |
| 249 | src/gateway/autoscaler/health.ts | `classifyHealthStatus(status)` pure helper returning `healthy`/`degraded`/`unhealthy`. Lets routing treat `degraded` distinctly (downgrade / per-stage fallback) instead of lumping it with `healthy` as `probeGpuHealth` does. `probeGpuHealth`'s accept-set left unchanged (SSH/HTTP tests untouched). | "separates degraded from healthy" |

## Notes / partial wiring (intentional, to stay localized)

- **#208** — the idle-warning latch lives inside `checkIdleAction` (a wave-1 pure helper with
  a tested signature). The re-warn helper `computeIdleWarnLevel` is landed and unit-tested;
  re-routing the latch through it would change `checkIdleAction`'s contract, so the wiring is
  deferred to avoid touching a tested signature under the no-full-suite constraint.
- **#251/#252** — `getLatency()`/`ranking()` and `_applyStaleDecay()` are deliberately left
  byte-identical (existing `ewma-tracker.test.ts` asserts the flat ×1.1 at exactly 61s). The
  new behaviour is exposed via `rankingByScore()` + the pure helpers so callers can opt in
  without breaking back-compat.
- **#271** — `minFirstWaitMs` defaults to 0 so `autoscaler-request-batcher.test.ts`
  ("single item triggers immediate flush … computed wait is 0", advancing only 10ms) stays
  green; the floor is opt-in.
- **#283** — switched the refill cap from `max+1` to exact (`slack=0`). The +1 slack is
  retained as an opt-in parameter. No existing standby-pool test exercised the overshoot path
  (all use `minStandby` that short-circuits before the cap check), verified green.

## Deferred (and why)

- **#236 (treat circuit `getState` time-transition as derived / no write on read)** —
  DEFERRED. The existing read-path persistence is deliberate and already race-hardened in
  wave-2 (`getState` only writes when the *local* snapshot changes). Making reads fully
  derived needs a broader refactor of how `applyTimeTransition` + `canProbe` observe state
  and risks the concurrent last-write-wins guarantees the wave-2 tests lock. Not localized.
- **#250 (SSH health probe connection reuse / control-master)** — DEFERRED (effort M). Needs
  process/connection lifecycle management around `probeGpuHealthSsh` and platform-specific SSH
  multiplexing; not a pure-helper change and hard to unit-test without spawning ssh.
- **#291 (queue-depth running-total key instead of SCAN-per-call)** — DEFERRED. A correct
  running total requires atomic INCR/DECR coupled with the existing `increment`/`decrement`
  (the #290 atomicity concern); doing it safely is a storage-semantics change, not localized,
  and `queue-depth` tests lock the SCAN-based total shape.
- **#276 (predictive-warmup EWMA decay)** / **#277 (ROI gate)** — DEFERRED (carried from
  wave-1). `autoscaler-predictive-warmup.test.ts` locks the raw-`hincrby` counter semantics;
  decay-on-write breaks them. Behavioral redesign, not localized.
- **#290 (atomic queue-depth INCR/DECR)** / **#292 (load-balancer split-brain)** /
  **#295 (runaway-detector shared state)** — DEFERRED. All require a shared/atomic store
  primitive (cross-process correctness), which is an architectural change to the KV contract,
  not a localized helper.
- **#298 (budget hard-terminate → drain-then-stop)** — DEFERRED. Touches the budget
  enforcement path that ends a live session; changing terminate→pausable-stop interacts with
  the resume manager and daily-spend accounting and needs integration coverage beyond unit.
