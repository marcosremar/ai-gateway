# Implemented — Autoscaling, Reliability & Resilience — WAVE 4 (IDs 201-300)

Continuation (wave 4) of `docs/optimizations/03-autoscaling-reliability.md`. High-value,
SAFE, LOCALIZED fixes within the owned file set. Each change is a minimal diff that adds a
pure, unit-testable helper (and, where safe, wires it) without altering tested public
contracts or source-text assertions relied on by the existing suites.

Tests: `__tests__/opt/03-autoscaling-w4.test.ts`
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/03-autoscaling-w4.test.ts`
→ **53 passed** (53 unit tests).

Regression check (re-run green, no changes needed):
- Wave-1/2/3 autoscaling opt suites + idle-logic: **103 passed**
  (`03-autoscaling.test.ts`, `03-autoscaling-w2.test.ts`, `03-autoscaling-w3.test.ts`,
  `03-idle-logic.test.ts`).
- GPU-deployment opt suites (import the same `server/gpu-*` modules): **125 passed**
  (`02-gpu-deployment-w2.test.ts`, `02-gpu-deployment-w3.test.ts`).
- `watchdog.ts` import smoke (wired helper) loads + compiles clean.

| ID | File | Change | Test(s) |
|----|------|--------|---------|
| 202 | server/gpu-monitor-loop.ts | `resolveIdleTimeoutFromEnv(env, defaultMs)` pure helper, **wired** — `IDLE_TIMEOUT_MS` is now seeded from `IDLE_TIMEOUT_MIN` (minutes, preferred) / `IDLE_TIMEOUT_MS` at module load instead of a hardcoded `5*60_000` that only the runtime API could change. Garbage/non-positive falls back to the default; still overridable via `setIdleTimeoutMs`. | "prefers IDLE_TIMEOUT_MIN", "falls back to ms", "default for garbage", "minutes win" |
| 246 | server/gpu-monitor-loop.ts | `shouldDemoteOnP95(p95, target, idleMultiplier, isActive, activeBoost)` pure helper. P95 demotion can now be evaluated **under active load** (with a higher multiplier — `2×` idle → `3×` active) so a GPU degrading while serving traffic is demoted/re-benchmarked rather than waiting for idle. False on null/invalid P95 or target. | "demotes when idle over target", "higher threshold while active", "false for null/invalid" |
| 298 | server/gpu-monitor-loop.ts | `budgetActionForSpend(spend, budget, {softLimit, hardKillRatio})` pure helper — grades the budget response: `none` / `warn` (soft) / `drain-stop` (resumable pause at 100%) / `terminate` (only ≥1.25×). Replaces the abrupt hard-kill at 100% that killed in-flight sessions and forced a cold boot; the disk is preserved at 100% so the user can resume. | "none below soft", "warn at soft", "drain-stop at 100%", "terminate ≥1.25×", "none when budget 0" |
| 213 | server/gpu-resume-manager.ts | `resumePollIntervalMs(elapsed, base, fastPhase, max)` pure helper, **wired** into the resume health loop. Tight 3s polling for the first minute (catch fast ~19s resumes), then exponential backoff capped at 15s — cuts ~100 probes against a slow-to-resume pod. | "tight base in fast phase", "backs off + capped", "monotonic", "#214 guard intact" |
| 274 | server/gpu-standby.ts | Added the **modal** branch to `terminateOldPod` (`modal.deleteInstance`). A Modal primary promoted from standby previously had no branch in the provider switch (runpod/vast/tensordock/hyperstack only), leaking the old Modal app on handover. | "terminateOldPod source covers modal", "#285 multiplier untouched" |
| 281 | server/standby-pool-adapter.ts | `withinPoolCostBudget(currentUsdPerHr, newPodUsdPerHr, maxUsdPerHr)` pure helper + `STANDBY_POOL_GLOBAL_MAX_USD_PER_HR` env. Adds a dollars/hr admission gate to complement the count-only `POOL_GLOBAL_MAX` (a pool of 4 L40S can silently burn budget). Cap `<=0` disables (legacy); a missing/non-finite cost **fails closed**. | "cap disabled admits", "admits within budget", "refuses over budget", "fails closed for NaN" |
| 282 | server/standby-pool-adapter.ts | `DEFAULT_POOL_HEALTH_TIMEOUT_MS` lowered `20min → 8min` (still env-overridable). A non-healthy pool pod billed for up to 20 min before giving up; 8 min still covers big-model boots while terminating-on-timeout faster to cap waste. | "default health timeout shortened to 8min" |
| 280 | src/gateway/autoscaler/predictive-warmer.ts | `adaptiveSafetyMargin(gpuExpensiveness, coldStartSeverity, opts)` pure helper. Replaces the flat unconditional `1.2` over-provision with an asymmetric margin: lower when the GPU is expensive, higher when cold-start is catastrophic, clamped `[1.0, 1.5]`. Tolerates NaN. | "neutral=base", "expensive lowers", "cold-start raises", "clamped + NaN-safe" |
| 277 | src/gateway/autoscaler/predictive-warmup.ts | `shouldWarmGivenRoi(warms, hits, {minSamples, minHitRate})` pure helper — ROI gate: skips pre-warm for hour-of-week buckets whose past warms didn't realize demand (hit-rate below `minHitRate` once enough history exists), explores otherwise. Stops a bucket repeatedly warming a GPU nobody uses. | "explores with little history", "skips poor hit-rate", "warms reliable bucket", "custom thresholds" |
| 291 | src/gateway/autoscaler/queue-depth-tracker.ts | `isTotalCacheFresh(cachedAt, now, ttl)` pure helper + a short-lived running-total cache on `QueueDepthTracker` (default 1s TTL, **wired**). `getTotalDepth` previously SCAN+GET'd every `shouldScaleUp` call; the cache collapses a burst of reads into one SCAN, and every write invalidates it so the value is never stale across a change. | "isTotalCacheFresh bounds", "burst collapses to 1 SCAN", "write invalidates", "0 TTL disables" |
| 241 | server/gpu-auto-recovery.ts | `deprioritizeProvider(tiers, crashedProvider)` pure helper, **wired** into `startAutoRecoveryDeploy`. Stable-reorders recovery tiers to push the just-crashed provider to the **end** (still a last-resort fallback), so recovery prefers a different provider — the intent the monitor already logged but never enforced. | "moves crashed to end", "keeps as fallback", "null/empty unchanged copy", "multiple tiers" |
| 219 / 220 | src/gateway/autoscaler/boot-timeout.ts (+ watchdog.ts) | `resolveBootTimeoutCap({bootTimeSecs, multiplier, unknownBootSecs, absoluteMaxMs})` pure helper, **wired** into watchdog stuck-booting cleanup. Per-provider multiplier (vast `3×`, others `2×` — matching the engine, #219) and a **300s** assumption for unregistered providers instead of 120s (#220), so a slow boot on an unknown provider isn't killed at the old aggressive 4-min cap. Capped at the absolute max. | "known × multiplier", "unknown 300s default", "caps at max", "multiplier floored", "handleBootTimeout intact" |
| 212 | server/gpu-orphan-cleanup.ts | `modalIdleGraceMs(baseGrace, coldStartMs, {coldStartMultiplier, maxGraceMs})` pure helper. Scales the Modal idle grace by observed cold-start (`max(base, coldStart×2)`, capped) so a just-warmed Modal container that took minutes to warm isn't reaped after a flat 5 min. Missing/zero cold-start → base grace (legacy). | "base with no cold-start", "scales up expensive", "never below base", "caps at max" |
| 209 | server/gpu-health-metrics.ts | `shouldStopForZeroUtil(consecutiveZeroUtilProbes, stopThreshold)` pure helper. Turns sustained 0% GPU utilization into an **idle-stop signal** (default 20 probes, longer than the existing 10-probe warn window) so the idle logic can reclaim cost — previously zero-util only logged a one-time warning. `>=` so a counter jump still fires. | "no stop before threshold", "stops once crossed", "custom threshold", "#247 intact" |

## Notes on wiring vs. helper-only

Consistent with waves 1-3, most items add a **pure, exported helper** that is unit-tested in
isolation; several are also wired at a safe call site (202, 213, 241, 291, 219/220 and the
274 branch / 282 constant are full wirings). The following landed as exported helpers ready to
wire, to keep the diff minimal and avoid touching stateful flows whose contracts the existing
suites assert against:

- **246 / 298** — helpers added; threading them into the live monitor-loop demotion/budget
  blocks touches broadcast + state-machine side effects covered by other suites, so the
  behavioral switch is deferred to a focused change.
- **281 (`withinPoolCostBudget`)** — the gate needs a per-profile `costUsdPerHr` field on
  `StandbyProfileConfig` (a type change beyond this localized scope) before it can be wired
  into `poolDeploy`; the helper + env knob are in place (mirrors the existing
  `canFreshDeployReplaceResumable` / `#283 canRefillPool` pattern).
- **277 / 280 / 209 / 212** — helpers added; wiring requires reading/persisting realized-demand
  hit-rate, per-host cold-start, and feeding the idle-stop decision respectively — deferred to
  avoid expanding the diff into stateful read/write paths.

## Deferred (this wave)

Items intentionally NOT taken this wave — too broad / not localized / risk to existing
contracts, or require interface/state changes outside the safe envelope:

| ID | Why deferred |
|----|--------------|
| 203 / 204 | Lowering the 8h idle ceiling / catch-all 250s override changes the `MIN/MAX_IDLE_TIMEOUT_MS` constants in `gpu-idle-logic.ts` that wave-1 tests assert behavior around; needs an explicit operator-override design (the doc itself proposes "require override above 1h"). |
| 206 | Per-pod persisted destroy deadlines = a file-format + recovery-flow change (multi-pod), beyond a localized helper. |
| 207 / 214 | `shouldTerminateOnMissingClient` / `canFreshDeployReplaceResumable` helpers already exist (waves 1-3); fully threading them rewrites the autoStop/resume cleanup branches with new failure-classification — deferred to a focused change. |
| 211 | Modal default-on idle-stop gating touches the broad `isModalIdleCandidate` + env-default semantics across the sweep; risk of stopping legit deployed apps without a careful name-prefix design. |
| 215 | Provider-aware (storage-billing) destroy-window shortening needs per-provider billing metadata not modeled here. |
| 216 / 218 / 221 / 222 / 223 / 224 / 225 / 226 / 227 / 228 / 229 / 230 | Watchdog/engine/tier-lifecycle/cleanup boot-state-machine items — stateful, multi-file flows with restart/discovery semantics; not safely localized to a pure helper this wave. |
| 231 | Persisting circuit-breaker `performanceHistory` is a KV-format + recompute design (M). |
| 233-238 | Already implemented (waves 2-3). |
| 236 | Already mitigated — `getState` only persists when the time-transition changed the local snapshot (race-safe), per current code. |
| 239 / 240 / 242 / 243 / 244 / 245 / 247 / 248 / 249 / 251-260 | Already implemented in prior waves. |
| 250 | SSH control-master/connection reuse = infra change in `health.ts`, not a localized helper. |
| 261-271 | Already implemented (waves 2-3): timer unrefs, memory-watcher, TimerManager sweep, request-batcher. |
| 272 | Parallelizing the orphan sweep (`Promise.allSettled` over providers) restructures the live sweep loop with race-with-active-deploy safety checks — deferred to avoid touching the kill path. |
| 273 | Replacing the `collectTrackedInstanceIds` regex with a structured instance-ID field is a cross-module tracking change (High effort, touches transition logging). |
| 275 | `_standbyErrorResetTimer` is already cleared on the success path (via `stopStandbyMonitor`) in current code. |
| 276 | Predictive-warmup EWMA/decay replaces the raw `hincrby` accumulation — a storage-semantics change (M). |
| 278 / 279 / 280(helper) / 283 / 285 / 287 / 288 / 289 / 294 / 296 / 299 / 300 | Already implemented in prior waves (280 helper extended here for asymmetric margin). |
| 281(wiring) / 282(faster-terminate path) | Cap helper + shorter timeout landed; wiring the dollar cap needs a config field (see notes). |
| 284 | `offloadOnIdle` cost-surfacing in status = UI/status-shape change outside the owned server lifecycle files. |
| 286 | Standby tier `t.name` vs `provider` field check — current `buildGpuTiers` returns `name`, so the filter is correct; no fix needed. |
| 290 / 292 / 293 / 295 / 297 | Atomic INCR/DECR, LB split-brain single-source-of-truth, shared runaway state — require new `KvStore` atomic ops or cross-process shared state (interface changes, M-High). |
