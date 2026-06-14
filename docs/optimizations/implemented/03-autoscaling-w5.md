# Implemented — Autoscaling, Reliability & Resilience — WAVE 5 (IDs 201-300)

Continuation (wave 5) of `docs/optimizations/03-autoscaling-reliability.md`. SAFE,
LOCALIZED fixes within the owned file set that were NOT already implemented in waves 1-4.
Each change is a minimal diff: a pure, unit-testable helper plus (where safe) a wiring at
the real call site, without altering tested public contracts or source-text assertions
relied on by the existing suites.

The safe pool is largely exhausted — waves 1-4 covered ~67 of the 100 IDs. This wave lands
**6 high-quality, genuinely-new items** and defers the remainder (all either already done,
stateful/multi-file flows, or blocked by out-of-scope type/interface changes — see below).

Tests: `__tests__/opt/03-autoscaling-w5.test.ts`
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/03-autoscaling-w5.test.ts`
→ **19 passed** (19 unit tests).

Regression check (re-run green, no changes needed):
- Wave-1/2/3/4 autoscaling opt suites + idle-logic: **156 passed**
  (`03-autoscaling.test.ts`, `03-autoscaling-w2/w3/w4.test.ts`, `03-idle-logic.test.ts`).
- GPU-deployment opt suites (import the same `server/gpu-*` + autoscaler modules): **159 passed**
  (`02-gpu-deployment-w2/w3/w4.test.ts`).

| ID | File | Change | Test(s) |
|----|------|--------|---------|
| 216 | src/gateway/autoscaler/watchdog.ts | **Wired.** The stuck-booting cleanup now routes through `handleBootTimeout(...)` instead of hand-building an `IdleTierState`. Previously it set `unhealthy:true` but **never** `cooldownUntil`, so a flapping tier was immediately retriable (inconsistent with the engine's boot-timeout path). The shared handler applies the same exponential cooldown semantics. | "handleBootTimeout sets cooldownUntil", "watchdog routes through handleBootTimeout" |
| 224 | src/gateway/autoscaler/watchdog.ts | **Wired** (same change as #216). `handleBootTimeout` returns a `cleanupConfig` whose `instanceId` is the runtime-`discoveredInstanceId` when present, so a pod created mid-boot (before discovery was reflected in the static config) is cleaned up instead of leaked. The watchdog now passes `cleanupConfig` to `cleanupProviderInstance`. | "cleanupConfig carries the discovered instance id" |
| 222 | src/gateway/autoscaler/boot-orchestrator.ts | `bootPathKey(userId, tierIndex, bootTriggeredAt?)` pure helper, **wired** into the `bootPathByTier` set (in `triggerGpuBoot`, reading the in-flight booting state's `bootTriggeredAt`) and the consume/delete (in the health poller, using its `bootTimestamp`). The map was keyed `${userId}:${tierIndex}` only, so a newer boot could overwrite an older attempt's entry before its poller consumed it — misattributing SnapGPU cold/restore metrics. The timestamped key makes each attempt unique; a non-positive/absent timestamp falls back to the legacy 2-part key (read path also checks the legacy key) for back-compat. | "includes the timestamp", "two boots → distinct keys", "legacy fallback", "source wires set+consume" |
| 225 | src/gateway/autoscaler/engine.ts | `forceReadyVerificationAction(probeOk)` pure helper + `_verifyForceReady` **wired** into `forceTierReady`. A forced-ready tier was flipped to `ready` with **no** health probe, so a dead endpoint served traffic until the next periodic probe. `forceTierReady` now fires ONE background verification probe (non-blocking — stays synchronous for back-compat) and demotes the tier to `idle{unhealthy:true}` if it fails (guarded so a later legitimate transition isn't clobbered). New optional `verify` arg (default `true`) preserves the old probe-free behaviour when needed. | "action maps probe result", "keeps healthy ready", "demotes dead endpoint", "verify=false skips probe" |
| 228 | src/gateway/autoscaler/engine.ts | `isReadyEndpointFresh(lastHealthyAt, now, maxStaleMs)` pure helper + `getVerifiedReadyEndpoints(userId, now?, maxStaleMs?)` method (default window `READY_ENDPOINT_FRESH_MS=90s`). After a restart, persisted `ready` tiers are returned by `getReadyEndpoints` before the next probe confirms liveness, so callers can route to a dead GPU. The new method filters to tiers whose `lastHealthyAt` is recent (a never-verified `0`/`NaN` is always stale); existing `getReadyEndpoints` is unchanged. | "isReadyEndpointFresh window+invalid", "boundary strict <", "excludes stale restored tier" |
| 230 | src/gateway/autoscaler/cleanup.ts | `resolveCleanupInstanceId(tierConfig, resolvedInstanceId?)` pure helper + new optional `resolvedInstanceId` param on `cleanupProviderInstance`. It previously early-returned unless the **static** `tierConfig.instanceId` was set, so an auto-provisioned tier carrying only a runtime-discovered id was never cleaned and leaked. The resolved id is preferred, config id is the fallback; blank strings count as absent. | "prefers resolved id", "cleans tier with only discovered id", "no-op without id/key", "static path unchanged" |

## Notes on wiring vs. helper-only

All six items are **wired at a real call site** (216/224 via the shared handler; 222 at set+consume;
225 via the background verify probe; 228 as a new method callers can opt into; 230 via the new param).
Each also ships a pure exported helper tested in isolation, matching the waves 1-4 convention.

`forceTierReady`'s verification probe self-corrects but does not change the method's synchronous
return — callers that already treated force-ready as "trust until next probe" keep working, and the
new `verify=false` arg restores the exact old behaviour for any caller that wants it.

## Deferred (this wave)

Items intentionally NOT taken — already implemented in a prior wave, too broad / not localized /
risk to existing contracts, or blocked by interface/state/type changes outside the safe envelope.

| ID | Why deferred |
|----|--------------|
| 201 / 202 / 205 / 207–214 / 217 / 219 / 220 | Already implemented in waves 1-4. |
| 203 / 204 | Lowering the 8h idle ceiling / catch-all 250s override changes the `MIN/MAX_IDLE_TIMEOUT_MS` constants in `gpu-idle-logic.ts` whose behaviour wave-1 tests assert; the doc itself wants an explicit operator-override design. |
| 206 | Per-pod persisted destroy deadlines = a file-format + multi-pod recovery-flow change, not a localized helper. |
| 211 | Modal default-on idle-stop gating touches the broad `isModalIdleCandidate` + env-default semantics across the kill path; risk of stopping legit deployed apps without a careful name-prefix design. |
| 215 | Provider-aware (storage-billing) destroy-window shortening needs per-provider billing metadata not modeled here. |
| 218 | `evictIdleUsers` ordering vs sweep is a stateful watchdog-flow change with in-flight-decision tracking — not a pure helper. |
| 221 / 223 / 226 / 227 | Engine/tier-lifecycle boot-state-machine items (reattach poller on restart, schedule orphan cleanup, create-then-swap, per-decision timeout) — stateful, multi-file flows with restart/discovery semantics. |
| 222(set-site timestamp source) | Done defensively here by reading the booting state at set time; threading `bootTriggeredAt` through the `triggerGpuBoot` signature from the engine remains a larger cross-boundary change if perfect attribution before the booting transition is ever required. |
| 229 | "Delete (not stop) spot/interruptible tiers" needs an `interruptible`/`spot` field on `GpuTierConfig` — that type lives in `src/types.ts`, **out of the owned scope**. (#230, the localizable half, was taken.) |
| 231 | Persisting circuit-breaker `performanceHistory` is a KV-format + recompute design (M effort). |
| 225/228(typed `verified` field) | A first-class `verified?:boolean` on `ReadyTierState` would be cleaner but requires editing `src/types.ts` (out of scope); implemented via probe-on-force-ready + `lastHealthyAt` freshness instead, which needs no type change. |
| 232–249 (except 246/298 helpers from w4) | Already implemented in prior waves (circuit-breaker stats/threshold/half-open/max-open, monitor-loop `>=` crash recovery, SSH recovery, retry policy, `classifyHealthStatus`, etc.). |
| 246 / 298 | Helpers landed in wave 4; threading them into the live monitor-loop demotion/budget blocks touches broadcast + state-machine side effects covered by other suites — behavioral switch still deferred. |
| 250 | SSH control-master/connection reuse = infra change in `health.ts`, not a localized helper. |
| 251–271 | Already implemented in prior waves (EWMA peak/stale penalty, latency window, warmth escalation+clear, cost-monitor doc/defaults, health-check timeout clear, all timer `unref`s, memory-watcher, TimerManager sweep, request-batcher). |
| 272 | Parallelizing the orphan sweep restructures the live kill-path loop with race-with-active-deploy safety checks — deferred to avoid touching the terminate path. |
| 273 | Replacing the `collectTrackedInstanceIds` regex with a structured instance-ID field is a cross-module tracking change (High effort). |
| 274 / 275 | Already implemented (w4 modal branch; success-path timer clear was already present). |
| 276 | Predictive-warmup EWMA/decay replaces the raw `hincrby` accumulation — a storage-semantics change (M). |
| 277–283 / 285 / 287–289 / 291 / 294 / 296 / 298 / 299 | Already implemented in prior waves. |
| 284 | `offloadOnIdle` cost-surfacing in status = UI/status-shape change outside the owned server lifecycle files. |
| 286 | Verified **no fix needed**: `buildGpuTiers` (`gpu-deploy-tiers.ts`) returns tier objects keyed `name`, so `gpu-standby.ts`'s `t.name === primaryProvider` filter is correct. |
| 290 / 292 / 293 / 295 / 297 / 300 | Atomic INCR/DECR, LB split-brain single-source-of-truth, shared/persisted runaway state, sticky canary session hashing — require new `KvStore` atomic ops, cross-process shared state, or session-affinity plumbing (interface changes, M-High); several also live outside the owned set (`src/canary`). |

**Safe pool note:** with this wave the localizable, in-scope, not-already-done items are effectively
exhausted. What remains needs either out-of-scope type/interface edits (`src/types.ts`, `KvStore`,
`src/canary`), new cross-process shared state, or rewrites of stateful kill/boot/decision flows whose
contracts other suites assert — none of which fit the "minimal diff + pure helper + unit test" envelope.
