# GPU Providers & Deployment — Wave 5 (implemented)

Continuation of `docs/optimizations/02-gpu-deployment.md` (IDs 101-200).
Waves 1-4 live in `docs/optimizations/implemented/02-gpu-deployment*.md` and
`__tests__/opt/02-gpu-deployment{,-w2,-w3,-w4}.test.ts`. This wave picks the
**next** batch of safe, localized, high-value items still inside the assigned
ownership set (`src/gpu-providers/`, `src/gpu-compat/`, `src/preflight-checks/`,
`src/gateway/deploy/`, `server/gpu-deploy*.ts`, `server/gpu-handlers*.ts`,
`server/pod-provisioner*.ts`, `server/gpu-auto-select.ts`, `server/gpu-snapshot.ts`,
`server/ssh-tunnel.ts`, `server/gpu-type-cache.ts`, `server/tier-ranking.ts`,
`server/deploy-diagnostics.ts`, `server/deployment-state-machine.ts`,
`server/config.ts`). Nothing in `src/modules/**`, `src/index.ts`, or build config
was touched.

The safe in-lane pool is nearly exhausted after four waves — most remaining IDs
either live in out-of-ownership files (`gpu-monitor-loop.ts`, `gpu-idle-*.ts`,
`gpu-resume-manager.ts`, `gpu-orphan-cleanup.ts`, `gpu-cost-audit.ts`,
`server/handlers/gpu/vram.ts`, `src/gateway/providers/gpu/*`) or are large
behavior-changing rewrites (base64 snapshot streaming, triplicated-tree
collapse). This wave intentionally lands **5 high-confidence items** (two of them
real billing/correctness bugs) rather than padding the count.

Tests: `__tests__/opt/02-gpu-deployment-w5.test.ts` (17 tests, all pass).
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/02-gpu-deployment-w5.test.ts`
Prior GPU opt suites re-verified green (187 tests across wave-1 + wave-2 +
wave-3 + wave-4) — no regression.

## Implemented

| ID | File:line | Change | Test |
|----|-----------|--------|------|
| #148 | server/gpu-deploy-loop.ts:114-130 (helper), 283/291/323/329/535 (wired) | **Billing bug.** Five in-loop cleanup `deleteInstance` calls (cancelled-resume, unhealthy-resume, cancelled-running, unhealthy-running, cancelled-create) passed `{ apiKey }` only, dropping the TensorDock `authId`. A TensorDock delete without `authId` **fails**, so the just-created/just-resumed instance keeps billing until the orphan sweep. New pure `cleanupCredentials(creds)` returns the full `{ apiKey, authId }` (omits an absent `authId` so non-TensorDock providers are unchanged); all five sites now use it. | `#148 cleanupCredentials preserves authId` (4) |
| #151 | server/gpu-deploy-race.ts:250-271 (helper, pre-existing) now wired at 388/396-417; server/gpu-deploy-loop.ts:179-186 (`DeployExtra.estimatedCostPerHr`); server/gpu-handlers.ts:1247-1249 (thread) | The race budget gate + cost-cap used a flat `$2/instance` prior (`RACE_EST_PER_INSTANCE_HR`), which over-rejects cheap 4090s and under-protects expensive A100s. The handler already resolves the cheapest matching offer price; thread it through `extra.estimatedCostPerHr` and size both the maxCostUsd trim and the budget gate via the (previously dead) `estimateRaceCostPerInstance`. Falls back to the flat prior when no price is known. | `#151 estimateRaceCostPerInstance` (4) |
| #154 | server/gpu-deploy-race.ts:25 (import), 262-271 (helper), 384-396 (wired) | The race path ran **zero** pre-flight, so a malformed/typo'd image failed (and billed) all N slots simultaneously instead of failing fast once. New pure `racePreflightImageError(image, tierNames)` validates the image reference once before slots spawn (allowing a Modal `*.py` deploy-script only when `modal` is a participating tier); a bad image now aborts the race up front with a `preflight_failed` event. | `#154 racePreflightImageError` (4) |
| #160 | server/gpu-deploy-canary.ts:68-73 (`stopCanary`, pre-existing); server/gpu-handlers.ts:30 (import), 1817-1820 (terminate), 2017-2020 (stop) | **Resource leak.** Neither `handleGpuTerminate` nor `handleGpuStop` called `stopCanary()`, so the 60s canary eval interval kept firing promote/rollback against a dead/paused endpoint after the pod was gone. Both lifecycle paths now call `stopCanary()` right after `stopGpuMonitoring()`. | `#160 stopCanary clears the eval interval` (2) |
| #130 | server/gpu-handlers.ts:64-82 (helper), 1428/1539/1650/2092 (wired) | The deploy/autoboot/terminate/resume handlers hand-rolled `if (deployLock) {reject} setDeployLock(true)`; the atomicity depends on no `await` between the two lines — fragile to a future edit. New `tryAcquireDeployLock()` encapsulates the check-then-set in one `await`-free function so the invariant can't be split. (The autoboot site previously had **three** statements between its check and set — a latent gap this consolidation closes.) | `#130 tryAcquireDeployLock` (3) |

## Notes / design choices

- **Bug-first.** #148 and #160 are genuine billing/leak defects (TensorDock
  delete failures; an orphaned canary interval), not merely cleanups. Both fixes
  are minimal and reuse existing in-scope plumbing (`credentials` already carried
  `authId`; `stopCanary` already existed).
- **Pure-helper pattern, continued.** #148/#151/#154/#130 each extract the
  decision into an exported pure function and wire it with a minimal diff; the
  unit tests target the helpers (no real provider calls), matching wave-1..4 and
  the harness's no-network rule.
- **#151 closes a wave-3 wiring gap.** `estimateRaceCostPerInstance` was added in
  wave 3 but never wired (no offer price reached the race path). Wave 5 threads
  the handler's already-resolved cheapest-offer price through a new optional
  `DeployExtra.estimatedCostPerHr` and feeds it to both the cost-cap trim and the
  budget gate. Additive field; the flat-prior fallback preserves old behavior
  when no price is known.
- **#160 testability.** `stopCanary` mutates module state (`deployState.canaryEvalTimer`);
  the test sets a long-period `setInterval`, calls `stopCanary`, and asserts the
  field is nulled, with an `afterEach` that clears any stray timer so nothing
  leaks into other suites.
- **#130 live binding.** `tryAcquireDeployLock` reads the `deployLock` ESM live
  binding imported from `./state` and sets it via `setDeployLock`, so the
  single-source check-then-set is correct across the four call sites. All 18
  `setDeployLock(false)` release sites are unchanged.
- **Backward-compat:** every new export is additive and the one new struct field
  (`DeployExtra.estimatedCostPerHr`) is optional. Re-ran the prior GPU opt suites
  (187 tests) — green, no behavioral change to wave-1..4.

## Deferred (with reason)

- **#101/#102/#103/#104/#108/#109/#110/#111/#112/#120/#167-monitor** (idle floor,
  monitor auto-stop, scheduled/extended cost audit, hibernate-default,
  daily-spend double-count) — live in `server/gpu-monitor-loop.ts`,
  `server/gpu-idle-*.ts`, `server/gpu-cost-audit.ts`, all **outside** this
  ownership set; several also need a product/policy call rather than a silent
  constant flip.
- **#117 (scope pre-deploy cleanup to the previously-active provider)** — the
  deploy-time cleanup also reaps gateway-owned orphan strays across providers;
  scoping risks leaking billable orphans on other providers between sweeps.
  Behavior change with cost/orphan risk; needs coordination with
  `gpu-orphan-cleanup.ts` (out of ownership).
- **#118/#142/#143/#200 (deploy-settings: `minInetDownMbps` default,
  `getGpuFallbacks` ladder, `checkDeployWarnings`, per-provider timeout)** — the
  canonical source is `src/gateway/providers/gpu/deploy-settings.ts`, **not** in
  this set (`src/gpu-providers/deploy-settings.ts` is a re-export shim). `#200`'s
  per-provider timeout floor already has a localized impl + test in
  `gpu-deploy-loop.ts` (wave 2).
- **#121/#124/#125/#126/#127/#132 (deploy-lock / idempotency / cancel-redeploy
  ownership)** — these are multi-step concurrency-correctness rewrites of the
  deploy handler's lock/idempotency lifecycle (await-a-definitive-cancel-ack,
  deployId-fenced guards, TTL-bound `finetuneDeployActive`). Higher-risk than a
  safe additive helper; #130 lands the safe encapsulation that several of them
  build on, the rest deferred to a focused concurrency task.
- **#133/#152 (noTierCascade wiring)** — already done: `#152` is wired
  (`tiersForRace`, wave 4) and the cascade single-tier honoring is covered by
  prior waves.
- **#157/#158/#159 (terminate: parallel cleanup, delete-before-reset, partial
  failure)** — larger teardown rewrites touching `gpu-orphan-cleanup.ts` (out of
  ownership) and global teardown ordering; risky, not safely additive. (#160, the
  one safely-additive terminate item, **is** implemented this wave.)
- **#161/#162/#163/#164/#168-resume (resume manager)** — `server/gpu-resume-manager.ts`
  is outside this ownership set.
- **#165 (cleanupAllPods prefix)** — `server/gpu-orphan-cleanup.ts` out of
  ownership.
- **#169/#170 (base64 snapshot streaming)** — large (L-effort) capture/restore
  rewrite (stream via scp/rsync / in-pod uploader); behavior-changing, needs
  pod-image coordination.
- **#181/#182/#183/#184 (SSH tunnel)** — `server/ssh-tunnel.ts` in this set is a
  re-export shim; the implementation lives in
  `src/gateway/providers/gpu/ssh-tunnel.ts`, **not** in the set.
- **#191/#192/#193 (dedupe VRAM maps / collapse triplicated provider trees /
  unify `DeployExtra`)** — cross-tree refactors touching `src/modules/**`
  (excluded), `server/handlers/gpu/vram.ts` (out of ownership), and multiple
  handler trees; inherently sequential, dedicated branch.

**Safe in-lane pool note:** after five waves the remaining ownership-internal,
additive, behavior-safe items are essentially exhausted — what's left is either
out-of-ownership or a structural/concurrency rewrite that should not be landed as
a quiet helper. Future GPU-deployment work here should expand the ownership set
(monitor/idle/resume/orphan files, `deploy-settings.ts`) or take a dedicated
refactor branch.
