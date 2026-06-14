# GPU Providers & Deployment — Wave 4 (implemented)

Continuation of `docs/optimizations/02-gpu-deployment.md` (IDs 101-200).
Waves 1-3 live in `docs/optimizations/implemented/02-gpu-deployment*.md` and
`__tests__/opt/02-gpu-deployment{,-w2,-w3}.test.ts`. This wave picks the **next**
batch of safe, localized, high-value items. All edits stay within the assigned
ownership set (`src/gpu-providers/`, `src/gpu-compat/`, `src/preflight-checks/`,
`src/gateway/deploy/`, `server/gpu-deploy*.ts`, `server/gpu-handlers*.ts`,
`server/pod-provisioner*.ts`, `server/gpu-auto-select.ts`, `server/gpu-snapshot.ts`,
`server/ssh-tunnel.ts`, `server/gpu-type-cache.ts`, `server/tier-ranking.ts`,
`server/deploy-diagnostics.ts`, `server/deployment-state-machine.ts`,
`server/config.ts`). Nothing in `src/modules/**`, `src/index.ts`, or build config
was touched.

Tests: `__tests__/opt/02-gpu-deployment-w4.test.ts` (34 tests, all pass).
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/02-gpu-deployment-w4.test.ts`
Prior GPU opt suites re-verified green (153 tests across wave-1 + wave-2 + wave-3) — no regression.

## Implemented

| ID | File:line | Change | Test |
|----|-----------|--------|------|
| #116 | server/gpu-snapshot.ts:90-143 (helpers); server/gpu-handlers.ts:46 (import), 916-925 (wired) | `snapshotProviderEligible` / `shouldWarnSnapshotIneligible` — `autoSnapshot` defaults true but capture only works on `vast-vm`/`hyperstack`; warn at deploy when no resolved tier in the cascade can actually snapshot, so users don't assume fast boots they won't get. | `#116 snapshot provider eligibility` (4) |
| #128 | server/gpu-deploy-with-tiers.ts:38-50 (helper), 113-115 (wired) | `canonicalDeployId(stateDeployId)` — `startDeployWithTiers` overwrote the handler-assigned `deploy-{base36}-{rand}` id with a profiling-only `deploy-${Date.now()}`, so logs/events referenced two ids for one deploy; reuse the handler id when present, synthesize only as a fallback. | `#128 canonicalDeployId` (2) |
| #136 | server/gpu-deploy-with-tiers.ts:28 (import), 257-271 (wired) | Cascade now drops credential-less providers via `filterUsableTiers` exactly like the race path (it previously filtered only by cooldown), so a tier with an empty/invalid key no longer wastes a full attempt + cooldown. SAFE: the filter never empties the list (falls back to the original set untouched). | `#136 cascade credential filter contract` (1) |
| #140 | server/gpu-deploy-with-tiers.ts:51-78 (helper), 271-285 (wired) | `summarizeTierProbes(probes)` — the parallel provider probe logged offer availability then discarded it; this summarizes per-tier availability and emits a `gpu.tier_probe` event so operators/UI can see which providers had stock before the cascade started. | `#140 summarizeTierProbes` (4) |
| #150 | server/gpu-deploy-race.ts:147-162 (helper), 689 (wired) | `countOutstandingLoserDeletes(candidates, winner)` — the winner returns while loser teardown runs in other branches; the winner log line now reports how many losers are still pending teardown (observability) without changing timing. | `#150 countOutstandingLoserDeletes` (3) |
| #153 | server/gpu-deploy-race.ts:164-191 (helper), 698-732 (wired) | `loserDeleteRetryPlan()` — a failed loser `deleteInstance` previously only logged and waited for the orphan sweep (45-min grace ≫ 10-min interval, so a stray loser bills up to 45 min); retry the delete with a bounded backoff schedule before giving up. | `#153 loserDeleteRetryPlan` (2) |
| #171 | server/gpu-deploy-loop.ts:114-148 (helper + consts), 429-465 (wired) | `restoreProbePlan()` — after a "restored" snapshot a single 5s `/health` probe decided success; a slow VRAM re-materialization was treated as failure and fell to the (slow) cold path, wasting the restore. Retry the probe on a short schedule before abandoning. | `#171 restoreProbePlan` (2) |
| #172 | server/gpu-snapshot.ts:122-143 (helper), 800-840 (wired); server/gpu-deploy-with-tiers.ts:396-398 + server/gpu-deploy-race.ts:702-703 (emit autoSnapshot) | `shouldCaptureOnDeployed(provider, autoSnapshot)` — the `gpu.deployed` hook captured on every eligible deploy regardless of the deploy's `autoSnapshot` flag, burning CRIU time + storage on opt-outs; gate capture on eligibility AND `autoSnapshot !== false`. Both deploy paths now propagate the opt-out on the event. | `#172 shouldCaptureOnDeployed` (4) |
| #173 | server/gpu-snapshot.ts:145-175 (lock helpers), 818-840 (wired) | `captureLockKey` / `acquireCaptureLock` / `releaseCaptureLock` — a redeploy firing `gpu.deployed` while a prior `criu dump` is still running would dump the same pod twice; a per-pod in-flight lock skips the duplicate (distinct pods still capture concurrently). | `#173 capture concurrency lock` (3) |
| #174 | server/gpu-snapshot.ts:177-191 (helper), 400-403 (wired into `hashModels`) | `canonicalizeModelList(models)` — `modelsFromDeployState()` is best-effort and order-dependent on warmth status, so capture and restore could feed differently-ordered/duplicated lists into `hashModels` and produce mismatched hashes (silently defeating reuse). `hashModels` now canonicalizes (trim/dedupe/drop-empty/sort) so both sides agree. | `#174 canonicalizeModelList` (4) |
| #180 | server/gpu-snapshot.ts:560-612 (helpers + rewired `snapshotPreCheck`) | `snapshotPreCheckCommand()` / `parseSnapshotPreCheckOutput()` — `snapshotPreCheck` did two serial SSH round-trips (`nvidia-smi`, then `capsh`) on the hot path before every capture/restore; combine into one round-trip with a labelled, unit-testable parser, halving the connection latency. | `#180 snapshot pre-check command + parser` (5) |

## Notes / design choices

- **Pure-helper first.** Every item extracts the decision into an exported pure
  function (no network/FS/global state where possible) and wires it into the live
  path with a minimal diff. Tests target the helpers, matching the wave-1/2/3
  pattern and the harness's "no real provider calls" rule. (`acquireCaptureLock`
  guards a module-local `Set`; its behavior is still deterministically testable.)
- **#172 propagation.** The capture hook reads `autoSnapshot` off the
  `gpu.deployed` event payload; both emitters (`startDeployWithTiers`,
  `startDeployRace`) now forward `extra.snapgpuAutoSnapshot`. When the flag is
  absent (`undefined`) the hook keeps the historical default-on capture for
  eligible providers, so no existing eligible deploy loses its snapshot.
- **#136 safety.** `filterUsableTiers` is the same readiness filter the race path
  already trusts; by contract it never returns an empty `usable` list (it falls
  back to the original tiers + `fellBack=true`), so the cascade can't be starved
  by the new filter.
- **#180 backward-safe parse.** `snapshotPreCheck` still treats a hard SSH
  failure (non-zero rc with no `DRIVER:` marker) as a failure; only the two
  serial round-trips were collapsed, the eligibility/driver/cap verdicts are
  unchanged.
- **#140 transport.** The probe summary is emitted via the existing event bus
  (`(string & {})` event-name escape hatch) rather than `updateDeploySession`,
  which is a closed Prisma-backed patch type — avoids pushing unknown columns to
  the DB while still surfacing the data the recommendation asked for.
- **Backward-compat:** all new exports are additive; no struct field was removed
  or made required. Re-ran the prior GPU opt suites (153 tests) — green, no
  behavioral change to wave-1/2/3.

## Deferred (with reason)

- **#117 (scope pre-deploy cleanup to the previously-active provider)** — the
  deploy-time cleanup also reaps **gateway-owned orphan strays** across providers,
  not just the tracked pod; scoping it to one provider risks leaking billable
  orphans on the other providers between the timer-based orphan sweeps. A
  behavior change with cost/orphan risk, not a safe additive helper — deferred to
  a focused task that can coordinate with `gpu-orphan-cleanup.ts` (out of
  ownership).
- **#137/#138 (unify balance threshold / fix "$1" hint)** — already implemented:
  RunPod/TensorDock/Vast all gate on `LOW_BALANCE_THRESHOLD_USD` via
  `isBalanceTooLow` and the exclusion message interpolates the actual threshold
  (`server/gpu-handlers.ts:798-862`).
- **#142/#143/#118/#200 (deploy-settings: `getGpuFallbacks` ladder,
  `checkDeployWarnings`, `minInetDownMbps` default, per-provider timeout)** — the
  canonical source is `src/gateway/providers/gpu/deploy-settings.ts`, which is
  **not** in this ownership set (`src/gpu-providers/deploy-settings.ts` is only a
  re-export shim).
- **#157/#158/#159/#160 (terminate: parallel cleanup, delete-before-reset, partial
  failure, stop canary)** — larger lifecycle/teardown rewrites touching
  `gpu-orphan-cleanup.ts` (out of ownership) and global teardown ordering; risky,
  not safely additive.
- **#161/#162/#163/#164 (resume manager)** — `server/gpu-resume-manager.ts` is
  outside this ownership set.
- **#165 (cleanupAllPods prefix)** — `server/gpu-orphan-cleanup.ts` out of
  ownership.
- **#169/#170 (base64 snapshot streaming)** — large (L-effort) capture/restore
  rewrite (stream via scp/rsync / in-pod uploader); behavior-changing, needs
  pod-image coordination.
- **#181/#182/#183/#184 (SSH tunnel)** — `server/ssh-tunnel.ts` in this ownership
  set is only a re-export shim; the implementation lives in
  `src/gateway/providers/gpu/ssh-tunnel.ts`, which is **not** in the set (#181 is
  already implemented there in a prior wave).
- **#191/#192/#193 (dedupe VRAM maps / collapse triplicated provider trees /
  unify `DeployExtra`)** — cross-tree refactors that touch `src/modules/**`
  (explicitly excluded), `server/handlers/gpu/vram.ts` (out of ownership), and
  multiple handler trees; inherently sequential, dedicated branch.
- **#175 (restore-side `models: []` vs capture)** — already fixed in a prior
  wave (`server/gpu-deploy-loop.ts:427` now passes `modelsFromDeployState()`);
  #174 hardens the hashing so any residual ordering/dedup difference can't
  re-introduce a mismatch.
