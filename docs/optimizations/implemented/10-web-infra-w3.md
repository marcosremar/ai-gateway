# Implemented — Web UI, Image Builder, Build & Infra/Cost (IDs 901-1000) — WAVE 3

Source audit: [`docs/optimizations/10-web-build-infra-cost.md`](../10-web-build-infra-cost.md).
Prior waves: [`10-web-infra.md`](./10-web-infra.md) (wave 1, `__tests__/opt/10-web-infra.test.ts`),
[`10-web-infra-w2.md`](./10-web-infra-w2.md) (wave 2, `__tests__/opt/10-web-infra-w2.test.ts`).
Tests (this wave): [`__tests__/opt/10-web-infra-w3.test.ts`](../../../__tests__/opt/10-web-infra-w3.test.ts)
— **37 unit tests, all passing**.

Run only this wave:

```bash
bunx vitest run --config vitest.opt.config.ts __tests__/opt/10-web-infra-w3.test.ts
```

The opt vitest config has **no jsdom / `document` global**, so all logic was kept
in framework-free modules and tested via pure functions (inputs injected). React
`.tsx`/hooks, YAML (Helm, docker-security), HCL, Dockerfiles, and `next.config.mjs`
are **not unit-testable here** and are marked inspection-only.

Ownership respected: only `web/src/**`, `src/compute/image-builder/**`, `helm/**`,
and `.github/workflows/**` were touched. No edits to `src/modules/**`, `src/index.ts`,
`package.json`, `tsconfig*`, build/turbo/vitest config, or anything outside the set.

## Changes (this wave)

| ID | File:line | Change made | Test |
|----|-----------|-------------|------|
| 926 | `web/src/lib/phase-colors.ts:67-104` (new `stageColor`/`stageLabel`/`stageBadgeVariant` + `STAGE_ACCENT_MAP`) | Single source of truth for STT/LLM/TTS (+ image/pipeline) accent colors, short labels, and badge variants. Replaces three divergent palettes (`LogsSection` `#38bdf8/#a78bfa/#fbbf24`, `ServicesSection` `#0ea5e9/#8b5cf6/#f59e0b`). `LogsSection.tsx` (`stageBgColor`/`stageRowTint`) and `ServicesSection.tsx` (`StageBadge`) now consume the shared helpers. | `stageColor` x3; non-pipeline accent; muted fallback; `stageLabel` x4; `stageBadgeVariant` x6 |
| 933 | `web/src/sections/LogsSection.tsx:351-389` | Removed the dead `stageColor()` variant helper (defined, never used — `StageBadge` used `stageBgColor`). `stageBgColor`/`stageRowTint` collapsed to delegate to the shared `stageColor` (color-mix derived). | covered via #926 (`stageColor`) |
| 924 | `web/src/lib/phase-colors.ts:106-138` (new `providerPhaseColor`/`providerPhaseLabel` + `ProviderPhase`) | `PipelineHealthCard`'s local `dotColor`/`phaseLabel` (a second `ProviderPhase`→color/label map that could drift) replaced by centralized pure helpers; `PipelineHealthCard.tsx:28-29` now aliases them. | `providerPhaseColor` x3 groups + fallback; `providerPhaseLabel` x2 + fallback |
| 936 | `web/src/lib/nav.ts` (new) + `app/page.tsx:99,139`, `PipelineHealthCard.tsx` | Framework-free `resolveRoute` (path/hash → route, redirects, nested prefix), `routeToPath`, `navigateToPath`, `normalizeHash`/`normalizePathname`, `ROUTE_REDIRECTS`. `getRouteFromPath` is now a thin window adapter; the duplicated `pushState + new PopStateEvent('popstate')` in `PipelineHealthCard` (2 sites) replaced by `navigateToPath`. | `resolveRoute` x7; `routeToPath`/normalizers x4 |
| 961 | `web/src/lib/nav.ts` (`routeToPath`) + `app/page.tsx:139` | URL building for navigation centralized (`overview`→`/`); removes the inline `id === 'overview' ? '/' : …` from the React layer. (Root-route SSR redirect itself left inspection-only.) | `routeToPath` + path→resolve round-trip |
| 950 | `web/src/lib/service-stats.ts` (new) + `FallbackChainList.tsx:99,217` | `latencySuffix(stage, provider, stats)` extracted as pure; the `serviceOptions` `useMemo` now calls it directly (with `stage` added to deps), removing the stale-closure footgun where the memo listed `serviceStats` but called the non-memoized `getLatencySuffix`. | `latencySuffix` x5 (none/known/gpu-cold/serverless/unknown) |
| 951 | `web/src/lib/object-urls.ts` (new) + `PlaygroundSection.tsx:197-200,387` | `collectObjectUrls`/`revokeObjectUrls` (pure, de-duped, throw-safe, injectable revoker). `handleClear` now revokes per-message blob `audioUrl`s before `setMessages([])`, and an unmount effect frees outstanding URLs — fixes the long-session blob leak. | `collectObjectUrls` x2; `revokeObjectUrls` once-each + throw-safe |
| 967 | `src/compute/image-builder/github-repo.ts:190-216` (new `partitionForConcurrency` + `DEFAULT_BLOB_UPLOAD_CONCURRENCY`) + `pushTree:283-292` | Binary blob uploads were serial (`POST /git/blobs` one-at-a-time). Files are now batched and each batch `Promise.all`'d with a bounded concurrency (6), preserving tree order via index slots. Pure batching helper is exported + tested. | `partitionForConcurrency` x4 + default-concurrency sanity |
| 970 | `src/compute/image-builder/image-build-service.ts:88-104` (new `isTerminalBuildStatus` + `TERMINAL_BUILD_STATUSES`) + `pollBuildStatus:306` | Terminal-status check (`success/failed/cancelled`) centralized so the poller's loop-exit can't drift from record updates; `pollBuildStatus` now uses it. (Full runId re-derive from GitHub on process restart remains network-bound — deferred.) | `isTerminalBuildStatus` terminal/in-flight + set membership |

### Inspection-only (config / YAML — verified by diff)

| ID | File | Change made |
|----|------|-------------|
| 989 | `helm/ai-gateway/values.yaml:4-10` | `pullPolicy: IfNotPresent` → `Always` (so mutable `:latest` is re-pulled, not run stale across nodes); comment recommends pinning an immutable tag/digest for prod. |
| 990 | `helm/ai-gateway/values.yaml:28-36` | Pod `requests` lowered `500m/1Gi` → `250m/512Mi` for the I/O-bound gateway so the scheduler bin-packs cheaper; limits unchanged (bursts still allowed). |
| 992 | `helm/ai-gateway/values.yaml` (serviceMonitor) | `interval: 15s` → `30s` to cut TSDB ingest/storage on the high-cardinality `/metrics` endpoint. |
| 993 | `helm/ai-gateway/values.yaml` (env) | `CORS_ORIGINS: "*"` → `""` (closed by default); comment requires an explicit per-env allow-list, mirroring the wave-1 Terraform/Fly closure. |
| 984 | `.github/workflows/docker-security.yml:36-76` | `trivy-main` now detects which specific Dockerfile changed (PR base / push `before` diff; schedule always scans all) and skips build+scan+upload for unchanged entries — editing `Dockerfile.worker` no longer rebuilds `Dockerfile` + `Dockerfile.production`. |
| 985 | `.github/workflows/docker-security.yml:79-101` | `trivy-subprojects` switched from bare `docker build` to `docker/build-push-action` (pinned SHA) with `setup-buildx` + `cache-from/to: type=gha,scope=trivy-<name>` and `load: true`, so the 12 weekly CUDA image builds restore unchanged layers instead of recompiling. |

## Deferred (and why)

- **#924/#926/#933/#936/#950/#951 React wiring** — the `.tsx` consumers
  (`LogsSection`, `ServicesSection`, `PipelineHealthCard`, `page.tsx`,
  `FallbackChainList`, `PlaygroundSection`) need jsdom + React render to exercise,
  which the opt config omits. The pure modules they delegate to (`phase-colors`
  stage/provider helpers, `nav`, `service-stats`, `object-urls`) are fully tested;
  the components are inspection-only. All edited pure modules compile clean under
  `tsc --noEmit --strict` (web modules verified via a scoped tsconfig with the
  `@/*` alias; the only residual tsc errors were environmental — missing `react` /
  `@types/node` in the throwaway config — not logic errors).
- **#967 actual upload fan-out** — the `Promise.all`-over-batches wiring in
  `pushTree` holds real `fetch` side effects (needs a GitHub API mock); the *pure*
  batching decision (`partitionForConcurrency`) is fully tested and order-preserving.
- **#970 restart-safe re-derive** — re-deriving build status from the GitHub Actions
  API when the process restarts mid-build is network-bound (persist `runId`, call
  `getRunStatus`); only the terminal-status predicate was extractable as pure logic.
- **#989-#993 Helm / #984-#985 docker-security** — YAML; not importable as pure TS.
  Verified by diff inspection. (Helm CORS/requests/scrape and the docker-security
  change-detection / buildx-cache steps are behavior changes to CI/infra, not code.)
- **#961 root redirect** — switching the client `window.location.replace('/dashboard')`
  to a Next `redirect()` / `next.config` redirect touches `next.config.mjs` / routing
  semantics under `output:'export'`; risk of changing the export graph, deferred.
  The pure URL-building half (`routeToPath`) is done + tested.
- **#999 docs double-deploy** — disabling one of `docs.yml` / `docs-cf.yml` is a
  live-deploy decision (which host is canonical?); not changed to avoid breaking a
  publish path. Inspection-only.
- **#1000 Grafana alert rules** — confirmed in wave 2: `monitoring/grafana-dashboard.ts`
  is a static const (no pure functions to test) and `monitoring/grafana/gateway-dashboard.json`
  still carries no alert rules. Adding schema-sensitive alerting blocks is a sizeable
  change deferred to avoid risk.
- **Structural items still out of scope for localized fixes** — #901 `src/modules/`
  mirror, #905 perf-budget triple build, #906 web CI build job, #955/#956 React Flow
  dead-code / dynamic import, #957/#958 dep dedupe, #959 `next/font`, #991/#995/#996
  Helm PDB / Fly sizing, #976-#988 Dockerfile (wave-1 already did babelcast pre-bake).
  Tracked in the source audit.

## Notes

- 37 tests pass in ~330ms; no network, no DOM, no live keys.
- New pure modules: `web/src/lib/nav.ts`, `web/src/lib/service-stats.ts`,
  `web/src/lib/object-urls.ts`, plus `phase-colors.ts` stage/provider extensions
  and the two image-builder helpers (`partitionForConcurrency`,
  `isTerminalBuildStatus`).
- Pre-existing condition left untouched: `ServicesSection` still imports
  `STAGE_ACCENTS` (already unused before this wave); not removed to keep the diff
  minimal and avoid touching unrelated code.
