# System Improvement Analysis — 2026-06-25

Scope: "can we make the system smarter, or refactor things to work better?"
Method: measured the actual import graph, diffed the trees, traced the
deploy/cost/routing subsystem (deep context from the GPU bughunt + warmpool work).

## TL;DR

The system is **already intelligent** — smart offer scoring (`autoSelectGpu`:
latency·0.6 + reputation·0.3 + session·0.1, with a reputation floor),
`rankOffers`, predictive warmup, per-stage circuit breakers, GPU↔cloud racing,
hedged deploys. The lever for "work better" is **not new features** — it is
removing duplicated complexity so the intelligence stays correct.

The single highest-value refactor: retire the **`src/modules/` shadow tree**.

---

## Executed 2026-06-26 — drift eliminated + root-cause bug fixed

Phase 1 of the migration (stop the bleeding) is **done**. All real drift between
`src/modules/` and the canonical `src/` trees is reconciled to **0 divergent
files** (down from 43 in the gateway subtree + 2 elsewhere), verified by a
30-file parallel classify→adversarially-verify workflow before any overwrite.

The published library (`src/index.ts`) thereby gained the fixes it was silently
missing — daily-spend reset (`rolloverDailySpendIfNewDay`), per-owner multi-tenant
deploy slots, fail-closed rate limiting on store error, empty-audio rejection,
fan-out dedupe+cap(16), Kokoro server reuse, the `/v1/search` route, and ~40
provider-client fixes (vast/runpod/deploy-orchestrator).

**Root-cause bug found and fixed while reconciling** `pull-time-estimator.ts`:
the canonical server impl used a *tight* `×1.2` (20%) pull-timeout margin in the
no-history / learning paths, contradicting its own comments ("use max of
calculated×2", "generous timeout to learn") and its test (`× 2.0 → ≥320s`). A
tight margin with no history is exactly what fires mid-pull on uncached images —
the **bughunt #24/#25 SSH-timeout death spiral**. Restored to `×2.0`; the
server runs this via the `src/gpu-providers/` re-export shim.

Gates: typecheck 0, library build 0, lint 0, modules/barrel tests 22 pass,
barrel 247 exports, pull-time unit + dependents 63 pass. The 590-file shadow is
now consistent; **deleting** it (repoint `src/index.ts`'s 151 imports → delete
`src/modules/`) remains the outward-facing follow-up below.

> Note: `pull-time-estimator.ts` exists in 4 locations — 2 real impls
> (`src/gateway/...`, `src/modules/gateway/...`) and 2 one-line re-export shims
> (`src/gpu-providers/...`, `src/modules/gpu-providers/...`). The shims are the
> *good* pattern (old path → canonical) and should be how the whole shadow tree
> is eventually collapsed.

---

## Finding 1 — P0 refactor: two drifting copies of the whole gateway

`src/modules/` is a **590-file, ~82,570-LOC parallel copy** of `src/`.

| | canonical `src/gateway` | shadow `src/modules/gateway` |
|---|---|---|
| files | 225 | 221 |
| imported by | **181** files (the server runtime) | `src/index.ts` (151 imports) + 2 `bin/` lines |
| last touched | 2026-06-10 09:42 | 2026-06-10 07:11 |

Of 219 shared-basename files: **176 are byte-identical** (pure duplication) and
**43 have silently diverged**. The divergence is the danger: a fix landed in one
tree never reaches the other. This is exactly how the daily-spend-reset bug
survived — `rolloverDailySpendIfNewDay` exists in `src/gateway/state/cost-state.ts`
but not in the `src/modules` copy.

The shadow also spans `client` (7/7), `providers` (57/56), `autoscaler` (32/32),
`adapters` (3/3) — it is nearly all of `src/` duplicated.

**Direction is unambiguous** (`docs/ddd-reorganization.md` plans *creating*
`src/gateway/`; 181 importers; newer): **`src/gateway` is canonical,
`src/modules` is legacy to retire.**

### 43 divergent hotspots (fix-once-miss-once risk)

```
state/          cost-state.ts  deploy-state.ts
providers/gpu/  vast-client.ts  runpod-client.ts  deploy-orchestrator.ts
                ssh-tunnel.ts  pull-time-estimator.ts  livenessProbe(ident)
                vast/{index,instances,offers,templates,types,utils}.ts
                runpod/{index,offers,volumes}.ts  docker-manifest-examples.ts
providers/cloud/ dlp.ts  guardrails.ts  percentage-routing.ts  routing-image.ts
                types.ts  openai/models.ts  openai-compat/{embedding,llm}.ts
autoscaler/     circuit-breaker.ts  load-balancer.ts  runaway-detector.ts  index.ts
pipeline/       chat-completions-service.ts  fanout-orchestrator.ts  hybrid-stages.ts
                streaming-overlap.ts  translation-cache.ts  tts-preview.ts
                local-kokoro.ts  index.ts
proxy/          server.ts  middleware/{auth,rate-limit}.ts
                routes/{chat-completions,audio-transcriptions,images}.ts
```

Security-sensitive divergence (`proxy/middleware/auth.ts`, `rate-limit.ts`,
`providers/cloud/dlp.ts`, `guardrails.ts`) is the most urgent to reconcile —
a hardened auth/DLP path in one tree does not protect the other.

### Staged, low-risk migration

1. **Repoint external dependents off the shadow.** `bin/` (2 imports) — **done
   in this change** (files were byte-identical, typecheck clean). Then
   `src/index.ts` (151 imports) one barrel at a time.
2. **Collapse the 176 identical files** to `export * from '../../gateway/…'`
   re-exports (mechanical, behavior-identical; verify tsup bundles per entry).
3. **Reconcile the 43 divergent files** — diff each, keep the `src/gateway`
   version unless a divergence is a deliberate library-only behavior; land
   security middleware first.
4. **Delete `src/modules/`** once `src/index.ts` no longer imports it.

Guardrail to prevent recurrence: a `quality:` check failing when a
`src/gateway/**` file has a same-named `src/modules/**` twin. (Better still:
no twin can exist after step 4.)

---

## Finding 2 — intelligence already exists; don't reinvent it

Before adding "smarter" logic, note what is already here and wired:

- `server/gpu-auto-select.ts` — multi-factor offer scoring + reputation floor (opt-in `autoSelectGpu`)
- `server/gpu-latency.ts` `rankOffers` + background latency probes
- `src/.../autoscaler/predictive-warmup.ts` — pre-boot before demand
- per-stage circuit breakers, cooldown tracking, runaway detector
- GPU↔cloud racing + hedged deploys + canary rollback

The "smarter" win is therefore **consolidation** (Finding 1), not a new model.

---

## Finding 3 — smarter, opt-in: self-healing warm pool

The warm pool (`server/gpu-warmpool.ts`) degrades toward empty: every failover
marks a worker `lost`, and nothing replenishes. Its <60s promise quietly dies
after a few GPU reclaims.

Recommendation: an **opt-in** (`WARMPOOL_AUTO_REPLENISH`, default off) background
tick that, when `aliveWorkers < config.size && !provisioning`, calls the existing
`provision(config)` (which already creates only the missing workers). Opt-in +
the existing budget gate keeps auto-spend safe. ~20 LOC, reuses provision, no new
abstraction. Left unimplemented here because it auto-spends money and belongs in
an operator-gated change, not an analysis pass.

---

## Minor, safe wins

- **`bin/` repointed off `src/modules`** — landed here (identical files).
- **Duplicate exports** (knip): `config-persistence.ts`, `config.ts`,
  `providers.ts`, `ensemble-stt.ts` export the same value under two names
  (`DEFAULT_APPS`/`DEFAULT_GPU_PROFILES`, etc.). Drop the alias once callers use
  one name.
- **Dead test helpers** flagged by knip in `__tests__/factories.ts`,
  `fixtures.ts`, `test-config.ts` — prune if genuinely unused.

---

## Recommended sequencing

1. Reconcile the 43 divergent files, security middleware first (correctness).
2. Collapse the 176 identical files to re-exports (complexity).
3. Repoint `src/index.ts`, delete `src/modules/` (the payoff: one tree).
4. Then, if warm pool sees real use, add opt-in auto-replenish.

Net: ~82k LOC and an entire drift surface removed before any new feature.
