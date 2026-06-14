# Implemented — Web UI, Image Builder, Build & Infra/Cost (IDs 901-1000) — WAVE 2

Source audit: [`docs/optimizations/10-web-build-infra-cost.md`](../10-web-build-infra-cost.md).
Wave 1: [`10-web-infra.md`](./10-web-infra.md) (tests `__tests__/opt/10-web-infra.test.ts`).
Tests (this wave): [`__tests__/opt/10-web-infra-w2.test.ts`](../../../__tests__/opt/10-web-infra-w2.test.ts)
— **34 unit tests, all passing**.

Run only this wave:

```bash
bunx vitest run --config vitest.opt.config.ts __tests__/opt/10-web-infra-w2.test.ts
```

The opt vitest config has **no jsdom / `document` global**, so all logic was kept
in framework-free modules and tested via pure functions (inputs injected). React
`.tsx`/hooks, YAML, HCL, Dockerfiles, `next.config.mjs`, and the Grafana JSON are
**not unit-testable here** and are marked inspection-only.

## Changes (this wave)

| ID | File:line | Change made | Test |
|----|-----------|-------------|------|
| 971 | `src/compute/image-builder/image-build-service.ts:51-105` | New pure `tagSuffixForPlatforms` + `resolveImageTag`: a Blackwell-targeted build (`+blackwell` / `sm_120` marker) now resolves `latest`→`blackwell` and `<tag>`→`<tag>-blackwell` (idempotent). Wired into `startBuild` so the published image is selectable for RTX 5090 per CLAUDE.md. | `tagSuffixForPlatforms` x2; `resolveImageTag` x3 |
| 974 | `src/compute/image-builder/github-repo.ts:434-471` | New pure `pickWorkflowRun` + `BUILD_WORKFLOW_NAME`: pick the run matching our generated build (by workflow name or `…/docker-build.yml` path) instead of `workflow_runs[0]`, which could attach to an unrelated push-triggered run. `findRunForCommit` now uses it (and fetches `per_page=10`). | `pickWorkflowRun` x4 |
| 973 | `src/compute/image-builder/image-catalog.ts:35-90` | New pure `pruneCatalogRecords` (+ `DEFAULT_MAX_CATALOG_RECORDS`/`DEFAULT_CATALOG_TTL_MS`): TTL-evicts terminal records (>90d) and hard-caps to N (env `AI_GATEWAY_MAX_CATALOG_RECORDS`); in-flight builds are never TTL-pruned. Replaces the bare `slice(0,100)` in `addBuildRecord`. | `pruneCatalogRecords` x4 |
| 969 | `src/compute/image-builder/github-repo.ts:304-323` + workflow body | New `PINNED_ACTIONS` map (full 40-hex SHAs + version comment); `generateWorkflow` now pins `checkout`/`setup-qemu`/`setup-buildx`/`login`/`metadata`/`build-push` to SHAs instead of floating `@v4`/`@v5`, matching the repo's own CI supply-chain posture. | `generateWorkflow` no-floating-tags + SHAs x2 |
| 945 | `web/src/lib/metrics.ts` (new) + `OverviewSection.tsx` | `computeStageLatencies` + `computeProviderTrends` extracted into a pure, import-free module; `OverviewSection` now stores raw log entries and derives both via `useMemo` keyed on entries (O(n log n) sort no longer re-runs on unrelated re-renders/polls). | `computeStageLatencies` x3; `computeProviderTrends` x2 |
| 946 | `web/src/lib/metrics.ts` (`sparklinePoints`) + `OverviewSection.tsx:188-194` | `sparklinePoints` computes `Math.max(trend)` once (was recomputed per point inside the `.map`) and returns `''` for <2 points; `ProviderBar` calls it. | `sparklinePoints` x3 |
| (flags) | `src/feature-flags/index.ts:41-90` | New pure `parseEnvFlagValue`: tolerant boolean tokens (`true/1/yes/on` & `false/0/no/off`, case-insensitive + trimmed) with default-fallback for unknown tokens, NaN-guarded numbers, verbatim strings. Fixes the `=== 'true' || === '1'` footgun where `"TRUE"`/`" true "` read as `false`. `define()` now delegates to it. | `parseEnvFlagValue` x5; `define` honors `TRUE`/`off` x2 |
| (browser) | `src/browser/cdn-config.ts:30-66` | New pure `joinCdnUrl` + `normalizeCdnBase`: join base+path without a double slash at the seam (scheme `//` preserved), trim all trailing slashes + whitespace. `cdnUrl`/`setCDNBase` now use them. | `joinCdnUrl` x3; `normalizeCdnBase` x1 |
| 960 | `web/next.config.mjs:9-13` | Added `experimental.optimizePackageImports: ['lucide-react','@xyflow/react']` so the large named-import lists tree-shake. | inspection-only (next.config) |

## Inspection-only (config / non-TS) — verified by diff

- **#969 generated workflow** — the SHA constants are unit-tested via
  `generateWorkflow` output, but the emitted YAML itself is validated by inspection.
- **#960 `optimizePackageImports`** — `next.config.mjs` ESM config; not importable in
  the opt suite (no Next runtime). Verified by inspection.

## Deferred (and why)

- **#945/#946 React wiring** — the `useMemo` in `OverviewSection.tsx` and the
  `<polyline>` markup need jsdom + React render to exercise, which the opt config
  omits. The pure functions they call (`computeStageLatencies`,
  `computeProviderTrends`, `sparklinePoints`) are fully tested; the `.tsx` is
  inspection-only. `OverviewSection.tsx` was not standalone type-checked (it uses
  the `@/` alias resolved only by the web tsconfig); the extracted module compiles
  clean under `tsc --noEmit`.
- **#947 `React.memo` on sub-components** — pure render optimization with no
  extractable predicate; deferred (would need render-count assertions in jsdom).
- **#967 batched blob uploads / #970 restart-safe poller / #968 webhook** —
  network-bound (`Promise.all` over GitHub blob POSTs / runId persistence);
  no pure decision to unit-test in isolation. Deferred.
- **#971 deploy-side variant selection** — the *builder* now emits the `blackwell`
  tag; the deploy path that *chooses* `:blackwell` for an RTX 5090 lives in
  `server/` (out of ownership) and is deferred.
- **#1000 Grafana alert rules** — `monitoring/grafana-dashboard.ts` already carries
  an `alerts:` array (6 rules → channels); however `monitoring/grafana/gateway-dashboard.json`
  has **no** alert rules (confirmed: 0 matches). Adding alerting blocks to the JSON
  is a sizeable, schema-sensitive change deferred to avoid risk; noted here.
- **Structural items not in scope for localized fixes** — #901 `src/modules/` mirror,
  #905 perf-budget triple build, #906 web CI build job, #955/#956 React Flow dead-code /
  dynamic import, #957/#958 dep dedupe, #959 `next/font`, #989-#996 Helm/Fly/TF
  right-sizing. Tracked in the source audit.

## Notes

- All six edited `.ts`/`.tsx`-adjacent pure modules compile clean:
  `tsc --noEmit --skipLibCheck` over `image-build-service.ts`, `github-repo.ts`,
  `image-catalog.ts`, `feature-flags/index.ts`, `cdn-config.ts`, `web/src/lib/metrics.ts`
  → exit 0.
- No changes outside the allowed ownership set; no edits to `src/modules/**`,
  `src/index.ts`, `package.json`, `tsconfig*`, build/turbo/vitest config.
