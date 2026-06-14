# Implemented — Autoscaling, Reliability & Resilience (IDs 201-300)

High-value, safe, localized fixes from `docs/optimizations/03-autoscaling-reliability.md`.
All changes are minimal diffs within the owned file set; no behavior changes beyond the
targeted fix. Tests live in `__tests__/opt/03-autoscaling.test.ts` and
`__tests__/opt/03-idle-logic.test.ts`.

Run: `bunx vitest run --config vitest.opt.config.ts 03-` → **31 passed**.

| ID | File:line | Change | Test |
|----|-----------|--------|------|
| 239 | server/gpu-monitor-loop.ts:326 | Crash-recovery redeploy `monitorConsecFails === 10` → `>= 10` + one-shot `crashRedeployTriggeredForCurrentDeploy` flag, so recovery fires reliably even if the fail counter skips the exact threshold and still fires once per crash. | `03-autoscaling.test.ts` — "crash-recovery redeploy uses `>= 10`…" |
| 240 | server/gpu-monitor-loop.ts:256 | App-level SSH recovery `monitorConsecFails === 3` → `>= 3` + one-shot `sshRecoveryAttemptedForCurrentDeploy` flag (reset on successful SSH recovery so a fresh failure climb can retry the cheap path). | `03-autoscaling.test.ts` — "SSH app-level recovery uses `>= 3`…" |
| 243 | server/gpu-monitor-loop.ts:127 | Added regression guard: the new one-shot flags + `monitorCrashRecoveryAttempts` are reset only in `startGpuMonitoring()` (fresh deploy), never in `resetIdleState()`, preserving crash-loop protection. | `03-autoscaling.test.ts` — "resetIdleState still leaves monitorCrashRecoveryAttempts untouched" |
| 205 | server/gpu-destroy-timer.ts:67,108 | `.unref()` both `destroyTimer` setTimeout sites (`scheduleAutoDestroy` + `recoverPersistedDestroyTimer`) so an idle process is never kept alive purely by the destroy countdown (deadline is persisted + re-armed on boot). | `03-autoscaling.test.ts` — "destroy timer unref on both schedule + recovery paths" |
| 209 | server/gpu-health-metrics.ts:55 | Zero-util warning `consecutiveZeroUtilProbes === THRESHOLD` → `>= THRESHOLD` + one-shot `zeroUtilWarned` flag; reset when util resumes so a later idle window re-warns. Fires reliably even if the counter jumps. | `03-autoscaling.test.ts` — "zero-util warning…" (2 tests) |
| 261 | server/gpu-orphan-cleanup.ts:698,706 | `.unref()` on `orphanSweepTimer` (10-min periodic) and `orphanSweepInitialTimer` (only `modalIdleSweepTimer` was unref'd before) so the sweep loop never pins the process on shutdown. | `03-autoscaling.test.ts` — "orphan-sweep periodic + initial timers unref" |
| 262 | server/standby-pool.ts:181 | `.unref()` on the standby-pool monitor `tickTimer`. | `03-autoscaling.test.ts` — "standby-pool tick timer unref" |
| 263 | server/gpu-standby.ts:45,53 | `.unref()` on the 60s `standbyMonitorTimer`; also clear the pending `_standbyErrorResetTimer` in `stopStandbyMonitor()` so a stale 30s timer can't pin shutdown or flip a now-deploying standby state (#275 hardened on the stop path). | `03-autoscaling.test.ts` — "standby (handover) monitor timer unref + error-reset timer cleared" |
| 264 | server/latency-scheduler.ts:89-92 | `.unref()` on the startup `setTimeout` and the 30-min discovery `setInterval`. | `03-autoscaling.test.ts` — "latency-scheduler startup + interval timers unref" |
| 265 | src/gateway/autoscaler/predictive-warmer.ts:110 | `.unref()` on the warmer tick `setInterval` (matches `predictive-warmup.ts` which already unref'd). | `03-autoscaling.test.ts` — "startPredictiveWarmer calls unref()…" (behavioural) + EWMA forecast sanity |
| 266 | src/memory-watcher/index.ts:172 | `startMemoryWatcher().stop()` now restores the original `global.setTimeout` (previously the activity-tracking monkey-patch was permanent and stacked across starts). Guarded so it won't clobber a newer patch installed on top. | `03-autoscaling.test.ts` — "stop() restores the original global.setTimeout" + "does NOT clobber a newer patch" |
| 267 | src/memory-watcher/index.ts:137 | Idle-GC check now reads the `lastActivity` timestamp written by the setTimeout patch (it previously read a dead `lastRequestTime` that nothing updated, so idle GC never fired). Consolidated to one tracked timestamp. | `03-autoscaling.test.ts` — "idle GC reads the activity timestamp updated by the patch" |

Pure-helper coverage (mitigation of #201 / general idle logic) — `03-idle-logic.test.ts`:
`resolveEffectiveIdleTimeout` (operator-configured timeout caps the 4h adaptive floor — the
existing mechanism that prevents the floor from widening a cost cap), `computeAdaptiveIdleTimeout`,
`checkIdleAction`, `computeIdleMs`, `adaptiveMonitorDelay`.

## Deferred (and why)

- **#201 (lower the 4h `MIN_IDLE_TIMEOUT_MS` floor)** — DEFERRED. The 4h floor is a
  *deliberate, test-locked* decision: `__tests__/gpu-idle-autostop.test.ts` has ~10 cases
  asserting `MIN_IDLE_TIMEOUT_MS = 240 * 60_000` (4h) / `MAX = 8h`, with documented rationale
  (3h+ MuseTalk frame-by-frame bypass workloads that hit the pod directly and aren't tracked by
  the gateway's request-based idle logic). The risk it cites is already mitigated:
  `resolveEffectiveIdleTimeout()` caps the adaptive window by the operator-configured
  `IDLE_TIMEOUT_MS` (default 5 min), so the 4h floor only applies when an operator explicitly
  disables the configured timeout (`<= 0`). Changing the floor would break the existing suite
  and contradict a documented design — not safe/localized. (Added explicit `resolveEffectiveIdleTimeout`
  cap tests instead.)
- **#202 (seed `IDLE_TIMEOUT_MS` from env at module load)** — DEFERRED. `export let IDLE_TIMEOUT_MS = 5 * 60_000`
  is asserted verbatim by multiple suites (`idle-stop-not-terminate`, `gpu-idle-autostop`,
  `gpu-deploy-unit`, `gpu-deploy-core`). Env seeding can be layered without changing that literal,
  but the runtime seeding path needs care around the existing setter/`startGpuMonitoring` reset and
  is not purely localized; deferred to avoid touching the startup ordering under a no-full-build/no-suite
  constraint.
- **#276 (predictive-warmup EWMA decay instead of raw `hincrby`)** — DEFERRED. High-value but a
  behavioral redesign of the storage semantics, and `__tests__/autoscaler-predictive-warmup.test.ts`
  locks the raw-counter behavior (e.g. `5 → 6`, first write `=== 1`) with a fake store that only
  implements `hincrby`/`hgetall`. Decay-on-write breaks those tests — not a localized fix.
- **#213 (resume-poll exponential backoff)** — DEFERRED (Low impact). The poll loop is inline in
  `gpu-resume-manager.ts` (not a pure helper) and adding backoff interacts with the resume-timeout
  window; low ROI vs. regression risk.
- **Pod-restart `=== 5` (part of #239's family)** — KEPT AS `=== 5` intentionally. Two suites assert
  `fnBody.toContain('monitorConsecFails === 5')`. After a restart the counter resets to 0 and naturally
  re-arms at 5, so exact equality is acceptable here; converting it would break the source-text tests.
  The genuinely-skippable thresholds (SSH `=== 3`, crash-recovery `=== 10`, zero-util) were converted.
