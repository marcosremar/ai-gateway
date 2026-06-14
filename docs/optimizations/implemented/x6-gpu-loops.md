# Implemented — GPU loops / idle / cost cluster (cross-ownership harvest x6)

Cross-ownership harvest wave. Implemented SAFE, LOCALIZED items from the
GPU-deployment (02), autoscaling-reliability (03), and observability-cost (06)
audit docs whose `Location` points into this file cluster, each as a PURE helper
wired at the call site with a unit test. These were deferred by earlier agents
as out-of-ownership.

**Cluster (only files edited):** `server/gpu-cost-audit.ts`,
`server/gpu-orphan-cleanup.ts`, `server/gpu-resume-manager.ts`,
`server/gpu-idle-manager.ts`, `server/gpu-monitor-loop.ts`.

**Tests:** `__tests__/opt/x6-gpu-loops.test.ts` — 29 unit tests, all passing.
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/x6-gpu-loops.test.ts`

## Implemented

| ID | Doc | File | Helper(s) added | Change |
|----|-----|------|-----------------|--------|
| #110 | 02:110 | gpu-cost-audit.ts | `resolveAuditApiKey` | Resolve RunPod/Vast/TD/HS keys for the audit: prefer a live deploy key only when set, else always fall back to env so an *idle* gateway still audits (and a stale deploy key can't shadow env). Wired into all four provider blocks. |
| #535 | 06:535 | gpu-cost-audit.ts | `isVolumeTracked` | Volume "tracked" decision now trusts provider attachment metadata (`attachedPodIds` / `inUse`) when present, falling back to the name-substring heuristic only when no attachment info exists — stops image-named volumes from being mis-flagged as orphans (and possibly auto-deleted). Wired into the RunPod volume loop. |
| #536 / #109 | 06:536, 02:109 | gpu-cost-audit.ts | `isStoppedPodStatus`, `instanceDiskGb` | Extend `auditGpuCosts` beyond RunPod volumes + Vast stopped pods to also audit **TensorDock** and **Hyperstack** stopped/hibernated instances. Normalized stopped-status set (exited/stopped/shutoff/hibernated/paused/suspended) and a robust disk-size extractor (top-level or `providerMeta`-nested). `StoppedPodAudit.provider` widened to the 4-provider union. |
| #165 | 02:165 | gpu-orphan-cleanup.ts | `matchesGatewayPrefix` | `cleanupAllPods` now filters RunPod instances by the full `GATEWAY_NAME_PREFIXES` list (`parle-autoscale-` **and** `ai-gateway-`) instead of the legacy single prefix, so newer-prefixed pods are reaped on terminate. |
| #273 | 03:273 | gpu-orphan-cleanup.ts | `extractInstanceIds` | `collectTrackedInstanceIds` no longer scrapes arbitrary 8-char lowercase words from transition text (the old `\b[a-z0-9]{8,}\b` falsely "tracked" words like `marcosremar`/`completed`). Matches only concrete provider id shapes: `inst-<n>`, `ap-<id>`, and ≥24-char hex ids. Dedupes. |
| #162 | 02:162 | gpu-resume-manager.ts | `resolveFallbackImage` | Resume→fresh-deploy fallback no longer silently substitutes `marcosremar/babelcast-subtitle:latest` when the original `dockerImage` was cleared from state (would deploy the wrong app). Returns the original image or throws loudly. |
| #111 | 02:111, 03:211-adjacent | gpu-idle-manager.ts | `shouldDefaultHibernate` | Hyperstack idle stops now default to **hibernate** (plain SHUTOFF still bills 100%; hibernate drops to ~10–15%) even without an explicit caller flag — opt-out via `HYPERSTACK_HIBERNATE_ON_IDLE=0`. Other providers keep the caller's explicit choice. Wired into `autoStopGpu`. |
| #539 | 06:539 | gpu-monitor-loop.ts | `budgetDayHoursRemaining`, `resolveBudgetResetHourUtc` | Budget EOD forecast honors a configurable budget-day reset hour (`BUDGET_DAY_RESET_HOUR_UTC`, default midnight UTC = old behavior) instead of hardcoding UTC midnight. `computeBudgetForecast` extended with an optional `resetHourUtc` param (back-compat: default 0). Wired into the forecast call. |
| #549 | 06:549 | gpu-monitor-loop.ts | `budgetHardLimitRatio` | Hard-limit auto-terminate now triggers at a configurable headroom ratio (`BUDGET_HARD_LIMIT_RATIO`, default **0.95**) so a pricey pod can't overspend the cap by a full monitor tick before termination. Clamps to (0,1]; garbage falls back to 1.0 (old behavior). Wired into the `pct >=` hard-kill condition + log line. |
| #546 | 06:546 | gpu-monitor-loop.ts | `shouldFireBudgetThreshold` | Sticky per-threshold-per-day budget-alert decision (`<date>:<ratio>` key) so an alert can re-arm if spend dips below then re-crosses a threshold the same day (e.g. after a manual reset). Pure helper added + tested (kept non-invasive — the existing boolean flags remain; helper is available for the next pass to replace them). |

## Deferred (with reasons)

| ID | Doc | Reason |
|----|-----|--------|
| #101 | 02:101 | `maxCostUsd` runtime enforcement requires threading a new field through `DeployExtra` + `deployState` (cross-file, stateful) — not a localized pure helper. |
| #102 / #201 / #203 / #204 | 02:102, 03:201/203/204 | Lowering the 4h `MIN_IDLE_TIMEOUT_MS` floor / 8h ceiling / per-image-floor interaction is a **behavioral** change to long-running-workload protection (MuseTalk 3h+ bypass jobs depend on it). `resolveEffectiveIdleTimeout` already lets an operator cap it; changing the floor risks killing real workloads. Needs product decision. |
| #103 | 02:103 | The `IDLE_TIMEOUT_MS` constant is already env-seeded (#202, shipped). Remaining work is doc/log-string wording alignment across files (CLAUDE.md etc.) — outside the cluster and not a helper. |
| #108 | 02:108 | Scheduling `auditGpuCosts` periodically means starting a real timer/interval — stateful, and the call site (`startOrphanSweep`/server boot) wiring touches timer lifecycle better tested in an integration suite. |
| #112 / #538 | 02:112, 06:538 | Daily-spend double-count on restart requires reconciling the persisted `daily_spend.json` timestamp against `startedAt` (cross-module state in `cost-state.ts`, outside cluster). Behavioral. |
| #120 / #215 | 02:120, 03:215 | Shortening the destroy timer when balance is low needs a live balance value at the `autoStopGpu`/`scheduleAutoDestroy` call site (network probe) — no balance field exists in `deployState`, so a pure helper can't be wired without adding I/O. |
| #211 | 03:211 | Gating Modal idle-stop on name prefix by default flips a default-on cost guard (`modalStopsUntrackedByDefault`); behavioral and risky for shared accounts. |
| #246 / #255 / #298 / #248 / #299 / #242 / #239 / #240 / #208 / #210 / #207 / #213 / #214 / #205 / #212 / #534 / #537 / #261 / #153 / #168 | — | Already implemented and covered by existing opt tests (verified via the `#NNN` grep) — skipped per the harvest rule. |
| #272 | 03:272 | Parallelizing the orphan sweep (`Promise.allSettled` over providers) is a control-flow rewrite of `sweepOrphanInstances`, not a pure helper; risk of racing an active deploy. |
| #506 | 06:506 | Location is `src/gateway/state/readiness-state.ts` — outside the cluster. |
| #547 / #550 | 06:547, 06:550 | Routing monitor-loop spend through `CostWatcher` / reconciling estimated spend vs observed balance deltas are larger cross-module refactors (alerting + provider balance polling). |
