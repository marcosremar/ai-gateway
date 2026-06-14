# GPU Providers & Deployment — Wave 3 (implemented)

Continuation of `docs/optimizations/02-gpu-deployment.md` (IDs 101-200).
Waves 1-2 live in `docs/optimizations/implemented/02-gpu-deployment*.md` and
`__tests__/opt/02-gpu-deployment{,-w2}.test.ts`. This wave picks the **next**
batch of safe, localized, high-value items. All edits stay within the assigned
ownership set (`src/gpu-providers/`, `src/gpu-compat/`, `src/preflight-checks/`,
`src/gateway/deploy/`, `server/gpu-deploy*.ts`, `server/gpu-handlers*.ts`,
`server/pod-provisioner*.ts`, `server/gpu-auto-select.ts`, `server/gpu-snapshot.ts`,
`server/ssh-tunnel.ts`, `server/gpu-type-cache.ts`, `server/tier-ranking.ts`,
`server/deploy-diagnostics.ts`, `server/deployment-state-machine.ts`,
`server/config.ts`). Nothing in `src/modules/**`, `src/index.ts`, or build config
was touched.

Tests: `__tests__/opt/02-gpu-deployment-w3.test.ts` (55 tests, all pass).
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/02-gpu-deployment-w3.test.ts`
Prior GPU opt files re-verified green (98 tests across wave-1 + wave-2) — no regression.

## Implemented

| ID | File:line | Change | Test |
|----|-----------|--------|------|
| #107 | server/gpu-deploy-loop.ts:90-104 (helper), 355-371 (wired) | `actualCostExceedsCap(actualCostPerHr, maxCostUsd)` — re-check the **real selected-host** price against `maxCostUsd` after `createInstance` (handler only gated on the cheapest matching offer). Over-cap host is torn down immediately + `deploy_rejected` event so a pricier-than-quoted loser doesn't bill during boot. Returns false on missing cap / unknown (0) cost. | `#107 actualCostExceedsCap` (4) |
| #113 | server/gpu-deploy-race.ts:162-177 (helper), 432 (wired) | `defaultRaceInterruptible(explicit, raceN)` — default `interruptible`/spot to true for a real multi-slot race (raceN>1, throwaway losers) when the caller didn't set it; single-instance deploys keep on-demand; explicit value always wins. Cuts per-hour cost on throwaway boots. | `#113 defaultRaceInterruptible` (3) |
| #123/#131 | server/gpu-handlers.ts:1110-1121 (helper), 1316 (wired) | `idempotentResponseStatus(currentStatus)` — the 200 idempotent response now echoes the **real** `deployState.status` instead of a hardcoded `'creating'`; a deploy that already failed/booted/readied within the 5s window no longer masquerades as in-progress. Only the resting `idle` maps to `creating`. | `#123/#131 idempotentResponseStatus` (2) |
| #139 | server/gpu-handlers.ts:1138-1153 (helper), 1058-1063 (wired) | `resolvedTiersError(tierCount, excluded)` — fail fast (402 if balance-excluded, else 400) when tier selection collapses to an empty list (balance exclusions + modal-drop with Modal unusable) instead of proceeding to an empty cascade that fails late. | `#139 resolvedTiersError` (3) |
| #141 | server/tier-ranking.ts:171-194 (helper); server/gpu-deploy-with-tiers.ts:222-231 (wired) | `pickCheapestTierName(names, priors?)` — when every tier is cooling down and none has a `CooldownEntry` (`pickEarliestExpiry → null`), force the **cheapest** tier (cost prior) rather than `tiers[0]` (configured order), so an expensive provider (e.g. Modal, 2.50) isn't forced just because it's first. | `#141 pickCheapestTierName` (5) |
| #149 | server/gpu-deploy-race.ts:186-192 (helper, pre-existing); 561-570 (newly wired) | `resolutionDeadlineExceeded(startedAt, now, budgetMs)` — bound the **cumulative** Vast endpoint re-resolution budget to the slot deadline so a hung resolver can't let a slot overrun the race (the per-call 30s timeout remains). | `#149 resolutionDeadlineExceeded` (2) |
| #155 | server/gpu-deploy-race.ts:208-233 (helper, pre-existing); 593 (newly wired) | `combineHealthSignal(raceSignal, timeoutMs)` — every loser `/health` fetch is now wired through the helper, which **always** pairs the race-abort signal with a per-fetch 8s timeout (even on runtimes without `AbortSignal.any`), so a hung `/health` never blocks until the whole race times out. | `#155 combineHealthSignal` (3) |
| #168 | server/gpu-deploy-race.ts:184-194 (helper), 572-579 (wired) | `normalizeResolvedEndpoint(resolved)` — providers return `string` \| `{ endpoint }` inconsistently; the race loop's `as any` is replaced with a pure normalizer yielding `string \| null`. | `#168 normalizeResolvedEndpoint` (3) |
| #178 | server/gpu-snapshot.ts:146-185 (fingerprint + reload), 220-223 (reset) | `snapshotStoreFingerprint(env)` — the process-singleton snapshot store now rebuilds when `R2_SNAPSHOTS_*` / `HYPERSTACK_SNAPSHOTS_*` change at runtime (compared via a fingerprint; secret material is length-hashed, not echoed) instead of requiring a restart. | `#178 snapshotStoreFingerprint` (3) |
| #179 | server/gpu-deploy-loop.ts:106-125 | `networkVolumeIsWasted(volumeId, imageIsPreBaked)` — pure predicate flagging the case (per CLAUDE.md) where a network volume is attached to a pre-baked image (zero benefit, still pays volume cost) so the deploy path can warn. | `#179 networkVolumeIsWasted` (3) |
| #187 | server/pod-provisioner.ts:106-131 (helper + `partial` field), 285-298 (wired) | `isPartialInstallFailure({code, stderr})` — distinguish an `install.sh` **timeout** (code null + `[provisioner] timeout` marker → half-provisioned, idempotently retryable) from a genuine non-zero exit. `ProvisionResult.partial` lets the caller retry instead of treating a timeout as a hard failure. | `#187 isPartialInstallFailure` (3) |
| #188 | server/gpu-type-cache.ts:13-59 (helper), 61-66 (wired) | `buildGpuCacheProviderQueries(env, clients)` — the GPU-type cache refresh now queries **Hyperstack** (own key) and **Vast-VM** (shares the Vast key) in addition to runpod/vast/tensordock/modal, so `validateGpuTypesFromCache` covers every configured provider instead of silently passing their GPU names. | `#188 buildGpuCacheProviderQueries` (6) |
| #197 | src/preflight-checks/index.ts:478-525 (helper), 527-533 (wired) | `evaluateCostValidation(quoted, current?, opts?)` — cost validation now folds in both an absolute reasonableness cap **and** (when a live `currentPricePerHr` is supplied) a relative >20% spike check, instead of only warning above a hardcoded $5/hr. Policy is a pure helper so the thin live re-query can attach later. | `#197 evaluateCostValidation` (6) |
| #198 | src/preflight-checks/index.ts:544-563 (helper), 565-600 (wired) | `classifyTemplateCheck(id, {reachable, found})` — a **confirmed-missing** Vast template (API reachable, not found) is now a hard error rather than a warning that proceeds to a silent boot failure; an unreachable API stays a warning ("couldn't check" ≠ "confirmed missing"). | `#198 classifyTemplateCheck` (3) |
| #199 | src/preflight-checks/index.ts:159-225 (helpers), 295-320 (wired) | `parseImageRegistry` / `isGhcrRegistry` / `registryVerifiable` — non-Docker-Hub registries are no longer blanket-skipped: a `ghcr.io` image is verified via a token HEAD-manifest check (token from `GHCR_TOKEN`/`GITHUB_TOKEN`), so a typo'd ghcr ref fails pre-deploy instead of after the billed instance is created. Other private registries still warn (no creds). | `#199 registry verification policy` (6) |

## Notes / design choices

- **Pure-helper first.** Every item extracts the decision into an exported pure
  function (no network/FS/global state) and wires it into the live path with a
  minimal diff. The unit tests target the helpers, matching the wave-1/2 pattern
  and the harness's "no real provider calls" rule.
- **#149 / #155** helpers were *added* in wave 2 but never wired into the race
  loop; this wave wires them (resolution-budget bound at the re-resolve site,
  `combineHealthSignal` at the `/health` probe) and adds the missing tests.
- **#178** length-hashes only the `*_ACCESS_KEY` / `*_SECRET_KEY` values so a
  rotation still changes the fingerprint (forcing a client rebuild) without
  leaking the secret into a log line.
- **#188** keeps the static `runpod/vast/tensordock/modal` imports and adds a
  narrow dynamic `import('./providers')` for `vastVm`/`hyperstack` so the pure
  helper stays import-free and testable; the clients map is injected.
- **#197** intentionally does **not** add the live provider-offer re-query here —
  `src/preflight-checks` has no offer access by design. The pure policy accepts a
  `currentPricePerHr` second arg so a caller that *does* have offers can activate
  the spike check with zero further changes (the recommendation's "doesn't
  re-query" gap is now a wiring decision, not a logic gap).
- **Backward-compat:** all new struct fields (`ProvisionResult.partial`) are
  optional/additive; all new exports are additive. Re-ran the prior GPU opt
  suites (98 tests) — green, no behavioral change to wave-1/2.

## Deferred (with reason)

- **#101/#104/#112/#167 (maxCostUsd → monitor auto-stop, daily-spend
  double-count)** — `server/gpu-monitor-loop.ts` and `server/gpu-idle-*.ts` are
  **outside** this wave's ownership set; the `maxCostUsd` threading into
  `DeployExtra` is done (#107 uses it), but the monitor-loop auto-stop is left to
  the owner of those files.
- **#102/#103 (4h idle floor vs 15-min doc)** — same out-of-ownership files
  (`gpu-idle-logic.ts`, `gpu-monitor-loop.ts`); also a behavior/policy decision
  that needs a product call, not a silent constant flip.
- **#108/#109/#110 (scheduled + extended cost audit)** — `server/gpu-cost-audit.ts`
  is outside ownership; partially addressed in wave 2's observability batch.
- **#118/#142/#143/#200 (deploy-settings: minInetDownMbps default, `getGpuFallbacks`
  ladder, `checkDeployWarnings`, per-provider deploy timeout)** — the canonical
  source is `src/gateway/providers/gpu/deploy-settings.ts`, which is **not** in
  this ownership set (`src/gpu-providers/deploy-settings.ts` is only a re-export
  shim). `#200`'s per-provider timeout floor already has a localized
  implementation + test in `gpu-deploy-loop.ts` (wave 2).
- **#157/#158/#159/#160 (terminate: parallel cleanup, delete-before-reset, partial
  failure, stop canary)** — these are larger lifecycle/teardown rewrites touching
  `gpu-orphan-cleanup.ts` (out of ownership) and global teardown ordering; risky,
  not safely additive, deferred to a focused task.
- **#161/#162/#163/#164 (resume manager)** — `server/gpu-resume-manager.ts` is
  outside this ownership set.
- **#165 (cleanupAllPods prefix)** — `server/gpu-orphan-cleanup.ts` outside ownership.
- **#169/#170 (base64 snapshot streaming)** — large (L-effort) capture/restore
  rewrite (stream via scp/rsync / in-pod uploader); behavior-changing, needs
  pod-image coordination.
- **#191/#192/#193 (dedupe VRAM maps / collapse triplicated provider trees /
  unify `DeployExtra`)** — cross-tree refactors that touch `src/modules/**`
  (explicitly excluded) and multiple handler trees; inherently sequential,
  dedicated branch.
