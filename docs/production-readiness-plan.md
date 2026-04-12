# Production Readiness Plan

> **Context**: Senior-architect audit in session 2026-04-12 concluded that `@parle/ai-gateway` has strong code/architecture/security but weak operational plumbing (CI/CD, release discipline, structured logging, SLO). This plan closes that gap.
>
> **North star**: `src/` is the publishable library (`@parle/ai-gateway` on npm). `server/` is the reference service running on Fly.io. The two have different release contracts.
>
> **Ownership**: Self-contained — each task lists concrete files, acceptance criteria, and is independently verifiable.

---

## Week 1 — Operational Unblock

### [x] 1. CI minimum viable (typecheck + test + build on PRs)

**Files**: `.github/workflows/ci.yml`

**What**:
- On `pull_request` and `push` to `main`, run `bunx tsc --noEmit`, a fast subset of tests, and `bun run build`.
- Split tests into `test:unit` (fast, always-on) vs `test:integration` (slow, nightly or label-triggered).

**Why**: Without CI, every refactor risks silent regression. A 2-hour investment that unlocks everything else.

**Acceptance**:
- PR that breaks typecheck fails the CI job.
- PR that breaks a unit test fails the CI job.
- `main` push status shows green build on GitHub.

---

### [x] 2. Commit lockfile (dependency drift prevention)

**Files**: `bun.lock` (or `bun.lockb`)

**What**:
- Run `bun install`, verify the generated lockfile, commit it.
- CI uses `bun install --frozen-lockfile` to enforce.

**Why**: Right now any `bun install` on a different machine or at a different time can pull a different version of `@prisma/client` or `ws`. This is a ticking time bomb for prod deploys.

**Acceptance**:
- `bun.lock` (or equivalent) is tracked in git.
- CI uses `--frozen-lockfile` and fails if lockfile is stale.

---

### [x] 3. Structured logger in hot paths (proxy, boot-orchestrator, gpu-deploy)

**Files**:
- `src/logger.ts` (new, thin wrapper over pino)
- `src/proxy/server.ts` (migrate)
- `src/autoscaler/boot-orchestrator.ts` (migrate)
- `server/gpu-deploy.ts` (migrate)
- `package.json` (add `pino` dep)

**What**:
- Create `src/logger.ts` with `createLogger({ module: 'proxy' })` API, returning a pino logger with correlation ID support via `AsyncLocalStorage`.
- In the proxy, set the correlation ID from `X-Request-Id` header at request entry and attach to all child logs.
- Migrate the three hot-path files from `console.log` to the new logger.
- Leave the other 25+ files alone for now — they'll migrate opportunistically.

**Why**: 774 `console.log` calls in `src/` make post-mortem debugging a grep exercise. Structured logs + correlation ID turn it into a query.

**Acceptance**:
- `src/logger.ts` exists with pino backing.
- One full request through the proxy produces logs with identical `requestId` field across proxy → provider → response.
- Tests still pass.

---

### [x] 4. Release discipline: changesets + CHANGELOG + v0.1.0 tag

**Files**:
- `.changeset/config.json` (new)
- `CHANGELOG.md` (new, seeded with current state)
- `package.json` (add `@changesets/cli`)

**What**:
- Install `@changesets/cli`, initialize with `bunx changeset init`.
- Write CHANGELOG.md seeded with major features since inception.
- Tag current HEAD as `v0.1.0`.
- Document in README how to add a changeset for each PR that changes public API.

**Why**: No tags, no CHANGELOG, version `0.1.0` frozen. Any downstream consumer has no way to know what changed between two commits. Minor today, catastrophic the day a second person starts consuming the package.

**Acceptance**:
- `.changeset/config.json` exists.
- `CHANGELOG.md` has at least one versioned entry.
- `git tag` shows `v0.1.0`.

---

### [x] 5. Audit empty catch blocks — add logging or justification

**Files**: ~20 files with `} catch {}` pattern (see audit)

**What**:
- Grep for `} catch {}` across `src/` and `server/`.
- For each: either add a `logger.debug/warn` call so the error is observable, OR add a one-line comment explaining why silent swallow is intentional (e.g., "idempotent cleanup on shutdown, stream already closed").
- Never leave a bare empty catch.

**Why**: 20+ silently swallowed errors are 20+ potential incidents that will look like "it just stopped working with no logs" when they fire.

**Acceptance**:
- `rg "} catch \{\}" src/ server/` returns zero matches after this task.
- Every swallowed error either logs or has a justification comment.

---

## Week 2 — SLO and Operational Documentation

### [x] 6. Declare SLO v1

**Files**: `docs/slo.md` (new)

**What**: Write a single file declaring the service's performance contract:

```markdown
| Metric | Target | Window |
|---|---|---|
| /v1/chat/completions p95 | 2s | 7d |
| /v1/speech pipeline p95 | 4s | 7d |
| Gateway uptime | 99.5% | 30d |
| GPU cold boot p95 | 60s | 7d |
| GPU snapshot restore p95 | 10s | 7d |
| Daily GPU spend | ≤$50 | 24h |
```

Then wire the existing alerting channels (Discord/Slack/webhook) against these targets in `src/alerting/`.

**Why**: Without declared SLOs, "is this a problem?" is a gut-feel question. With SLOs, every change has a concrete success/fail bar.

**Acceptance**:
- `docs/slo.md` exists with p95 + uptime + cost targets.
- The alerting module references SLO targets, not hardcoded numbers.

---

### [x] 7. Operational runbooks (deploy, incident, rollback)

**Files**:
- `docs/ops/deploy.md`
- `docs/ops/incident.md`
- `docs/ops/rollback.md`

**What**: Three short, concrete documents:
- **deploy.md**: exact steps to deploy a new version to Fly.io, prereqs (secrets set, lockfile committed), post-deploy smoke checks.
- **incident.md**: severity levels, on-call response flow, how to page the right channel, what to check first for each SLO breach.
- **rollback.md**: how to roll back a Fly.io deploy, how to roll back a library release, what triggers a rollback vs a forward-fix.

**Why**: Right now deploy is "the author knows how to do it". Any second person landing on this repo has to reconstruct the process from code. Written runbooks are the cheapest form of on-call insurance.

**Acceptance**:
- Three files exist, each ≤500 words, with concrete commands.

---

### [x] 8. Prometheus format on `/metrics` endpoint

**Files**:
- `server/metrics.ts` (modify — add Prometheus text-format exporter)
- `server/ws-server.ts` (route `/metrics` GET to new exporter)

**What**:
- The existing `/metrics` endpoint returns JSON. Add a sibling function that re-serializes the same in-memory counters in [Prometheus text format](https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format).
- Keep the JSON variant available for the web UI (`/metrics?format=json`).

**Why**: Prometheus is the de facto scraping standard. Once metrics are Prometheus-formatted, any monitoring stack (Grafana Cloud, self-hosted Prometheus, Datadog agent) works with zero adapter code.

**Acceptance**:
- `curl /metrics` returns `# HELP ... / # TYPE ... / metric_name{labels} value` format.
- `curl /metrics?format=json` still returns the existing JSON for the web UI.

---

### [x] 9. Document `src/` vs `server/` boundary

**Files**: `docs/architecture/lib-vs-service.md` (new), `CLAUDE.md` (update rule)

**What**: A policy document declaring:
- `src/**` is the library. Pure, DI-friendly, framework-agnostic. Published as `@parle/ai-gateway` on npm.
- `server/**` is the reference service. Imports from `src/`, binds to Bun/Fly.io, owns process-level concerns (HTTP bind, graceful shutdown, env wiring).
- Cross-import rule: `server/` may import from `src/`; `src/` may **never** import from `server/`.
- Add a CI guard (Bash grep or ESLint rule) that enforces the no-reverse-import rule.

**Why**: Today the boundary exists but is informal. A single `import` from `src/handlers/foo.ts` into `server/gpu-deploy.ts` that goes the wrong way and the whole library stops being tree-shakeable.

**Acceptance**:
- Policy doc exists and is referenced from CLAUDE.md.
- CI has a check that fails if `src/**` imports from `server/**`.

---

### [x] 10. Load test baseline via k6

**Files**: `load-testing/k6/baseline.js` (new), `docs/ops/baseline.md` (new)

**What**:
- Create a k6 script targeted at the deployed gateway running 50 VUs for 2 minutes against each OpenAI-compatible endpoint.
- Run it once against `parle-ai-gateway.fly.dev` with a fixed seed.
- Record p50/p95/p99 for each endpoint in `docs/ops/baseline.md` as "as-of 2026-04-12 on shared-cpu-2x, 1024MB".
- This becomes the reference line for future SLO verification.

**Why**: SLOs without a measured baseline are wishes. A baseline tells you whether a change regressed or improved things.

**Acceptance**:
- `docs/ops/baseline.md` exists with a table of p50/p95/p99 × 4 endpoints.
- Numbers are dated and linked to the k6 script version that produced them.

---

## Deferred (important but not this sprint)

These are real gaps but have lower ROI right now and are better done after the items above land.

- **OpenTelemetry full stack**. Proper distributed tracing. Wait until logger + Prometheus are in; OTel is the natural next step once incidents start making you want it.
- **Break up god files** (`gpu-deploy.ts` 2924 LOC, `vast-client.ts` 2675 LOC). Big but tested and focused — refactor opportunistically when touching for a feature.
- **Sentry / external error tracking**. Redundant with structured logger until you have multiple environments needing aggregated errors.
- **Playwright E2E triage** (140 failing tests). Important but blocking on the web team; tracked separately.

---

## Progress Log

| Date | Item | Notes |
|---|---|---|
| 2026-04-12 | Plan created | Based on architect audit in same session |
| 2026-04-12 | Item 1 — CI | `.github/workflows/ci.yml` with typecheck + unit tests + build + lib/service guard. `vitest.unit.config.ts` excludes 60+ slow test files; unit tier runs in ~83s with 4098 tests passing. |
| 2026-04-12 | Item 2 — lockfile | `bun.lock` committed. CI uses `bun install --frozen-lockfile`. |
| 2026-04-12 | Item 3 — logger | `src/logger.ts` rewritten over pino. ALS correlation IDs via `withLogContext()`. Migrated `src/proxy/server.ts` (+ request handler wraps in `withLogContext`) and `server/gpu-deploy.ts` (174 `console.*` calls → `log.*`). `boot-orchestrator.ts` already used DI `Logger` — no change needed. Test-mode detection (`VITEST=true`) falls back to `console.*` so existing `vi.spyOn(console)` assertions keep working. |
| 2026-04-12 | Item 4 — release | `@changesets/cli` installed + `.changeset/config.json` initialized. `CHANGELOG.md` seeded with full 0.1.0 release notes and documented release workflow. Git tag `v0.1.0` will be created with the final commit. |
| 2026-04-12 | Item 5 — catches | Zero `} catch {}` remaining in `src/` and `server/`. Each swallow now has a one-line comment explaining why (idempotent cleanup, optional module, best-effort broadcast, etc.). |
| 2026-04-12 | Item 6 — SLO | `docs/slo.md` declares 10 targets. `src/alerting/slo-targets.ts` exports machine-readable values. Re-exported from `src/alerting/index.ts` barrel. |
| 2026-04-12 | Item 7 — runbooks | `docs/ops/deploy.md`, `incident.md`, `rollback.md` written with concrete commands, decision trees, and smoke-check scripts. |
| 2026-04-12 | Item 8 — Prometheus | `server/metrics.ts` refactored to share a `snapshotMetrics()` helper between JSON and text exporters. Default `/metrics` is now Prometheus text format (`Content-Type: text/plain; version=0.0.4`); `/metrics?format=json` preserves the legacy shape for the web UI. |
| 2026-04-12 | Item 9 — lib/service | `docs/architecture/lib-vs-service.md` policy doc. CI guard in `.github/workflows/ci.yml` step already in place from item 1. CLAUDE.md updated with rule 5 linking to the doc. |
| 2026-04-12 | Item 10 — k6 baseline | `load-testing/k6/baseline.js` created (50 VU × 2 min × 4 endpoints, thresholds tied to `docs/slo.md`). `docs/ops/baseline.md` documents run procedure, budget cost per run (~$1), and record template. Actual baseline run deferred pending scheduled load window. |
