# Wave 4 — Web/Build/Infra & Cost (doc 10, IDs 901-1000)

Continuation of waves 1-3. This wave finishes the remaining **safe, localized**
pure-logic items in the web UI and monitoring config. The image builder
(#966-#975), most infra (#989-#993, #997), and the bulk of the shared-UI/polling
refactors were already landed in earlier waves; the remaining doc-10 items are
either already implemented, bundle/CSS/config changes that need the web toolchain
to validate, or infra YAML/HCL that is inspection-only.

Strict ownership respected — only edited under `web/src/`, `monitoring/`. No
changes to `src/modules/**`, `package.json`, `tsconfig*`, build configs, or
anything outside the allowed set.

## Implemented (code + unit tests)

| # | Title | Area | What changed | Files |
|---|-------|------|--------------|-------|
| 925 | `GpuLiveStatus` maintained a 40-entry `PHASE_META` separate from `phase-colors.ts` | Functionality | Collapsed the deploy-phase **color + label** data into one exported `DEPLOY_PHASE_META` registry in `lib/phase-colors` with `deployPhaseColor`/`deployPhaseLabel`/`deployPhaseMeta` accessors (gray + raw-phase-echo fallback). `GpuLiveStatus` now consumes the shared registry and keeps only a component-local lucide **icon** map (icons are React-specific). One source of truth → no color/label drift. | `web/src/lib/phase-colors.ts`, `web/src/sections/profiles/GpuLiveStatus.tsx` |
| 948 | `ReadinessSection` recreated its interval whenever `pollIntervalMs` flipped 10s↔2s | Reliability | Extracted the adaptive-cadence decision into a pure `readinessPollInterval(state)` (`hasActiveReadinessPhase`, fast/idle constants) in a new `readiness-logic.ts`. The section holds the desired cadence in a ref and uses a single **self-rescheduling timeout** that re-reads the ref each tick, so a phase change no longer tears down/rebuilds the effect. | `web/src/sections/readiness-logic.ts` (new), `web/src/sections/ReadinessSection.tsx` |
| 935 | Sidebar `divider` items carried a meaningless `icon: LayoutDashboard` | Usability | Added explicit `isNavSection`/`isNavLink`/`validRoutesFromNav` predicates to `lib/nav`. Removed the dead `icon` from the three divider `NAV_ITEMS`, made the Sidebar icon render-safe (spacer fallback when absent), and derived `VALID_ROUTES` via `validRoutesFromNav` instead of an ad-hoc `!divider` filter. | `web/src/lib/nav.ts`, `web/src/components/ui/Sidebar.tsx`, `web/src/app/page.tsx` |
| 1000 | Grafana dashboard "alerting configuration" was only panel thresholds | Reliability | The dashboard already ships real Prometheus-style alert rules (error-rate, p95 latency, GPU-down, budget, memory, failover → `#alerts-critical`/`#alerts-warning`). Added pure typed accessors (`getAlertRules`, `alertsBySeverity`, `alertNames`, `alertChannels`, `hasAlertForChannel`) so a channel router / `/health` summary can consume them and the SLO coverage is unit-testable. | `monitoring/grafana-dashboard.ts` |

### Tests

`__tests__/opt/10-web-infra-w4.test.ts` — 15 tests, all passing
(`bunx vitest run --config vitest.opt.config.ts __tests__/opt/10-web-infra-w4.test.ts`).
Pure logic only (opt config has no jsdom/`document`): deploy-phase registry
mapping + fallbacks, readiness cadence (active/idle/shadow/null-safe/overrides),
nav divider-vs-link predicates + route-set derivation, and Grafana alert-rule
accessors (severity filter, channel de-dup, SLO-coverage, `for`-window format).

Verified no regression in waves 1-3 web-infra suites (106 tests still pass).
Edited `.tsx`/`.ts` files are type-clean — a scoped `tsc -p web/tsconfig.json`
shows only pre-existing **environmental** errors (web `node_modules`/React types
not installed in this sandbox: `TS7006 'e'/'prev' implicitly any`, `TS2741
children missing`) that also appear in files this wave never touched
(`LabsSection.tsx`, etc.); none originate from these edits.

## Already implemented in earlier waves (no-op this wave)

Re-confirmed present in code, so skipped to avoid churn:

- **#903, #924, #926, #936, #940, #942, #943, #945, #946, #950, #951, #952, #961** — web build/UI/polling helpers (waves 2-3).
- **#954** — `prevStatusRef` is already gone from `useGpuStatus.ts` (cadence driven by `gpu?.status` in deps).
- **#960** — `experimental.optimizePackageImports: ['lucide-react', '@xyflow/react']` already set in `web/next.config.mjs`.
- **#963** — `web/src/app/[...slug]/page.tsx` already constrains the static export via `generateStaticParams`.
- **#966-#975** — image builder (GHA cache fallback, bounded-concurrency blob upload, backoff polling, SHA-pinned actions, run-status re-derive, Blackwell tag suffix, context-size guard, catalog retention, workflow-run picker, `concurrency` group).
- **#976-#979, #984-#987, #989-#993, #997** — Dockerfile/CI/Helm/k6 items (waves 2-3).

## Deferred / inspection-only (not changed this wave)

These remain valid but were intentionally **not** implemented now — either they
need the web/build toolchain to validate safely (cannot run `bun install`/`next
build`/full `tsc` per task constraints), are config/markup with no pure logic to
unit-test, or are infra YAML/HCL whose runtime can't be exercised here.

| # | Title | Why deferred |
|---|-------|--------------|
| 953 | Per-section SWR/React-Query client cache | Cross-cutting data-layer refactor across many `.tsx` sections; needs the React toolchain + e2e to verify navigation/cache behavior. Not localized/safe in this pass. |
| 955 | Delete dead `ProfileFlowDiagram` (1832 LOC) | `profiles/index.ts` still re-exports it; confirming it is truly unreferenced (and removing the barrel export) needs a web build + bundle check to prove nothing breaks. |
| 956 | Lazy-load `@xyflow/react` via `dynamic(..., {ssr:false})` | `next/dynamic` behavior must be verified with `next build`; markup change, no pure logic. |
| 957 | Drop one of `sortablejs` / `@dnd-kit/*` | Requires migrating `FallbackChainList` DnD + dependency removal (`package.json` out of scope) + web build. |
| 958 | Move `serve` out of web devDeps | `web/package.json` edit + dep-graph verification; out of the safe-localized scope. |
| 959 | Use `next/font/google` instead of blocking `<link>` | `layout.tsx`/font pipeline change; visual + build verification needed (no unit-testable logic). |
| 962 | Move Playground keyframes to `globals.css` | Pure CSS relocation; inspection-only, no TS logic. |
| 964 | Add `@next/bundle-analyzer` web size gate to CI | Needs a new CI job + web build wiring; CI YAML change best validated in CI. |
| 965 | `dynamic(..., {ssr:false})` for all sections | `next build` export behavior; markup/config, no pure logic. |
| 991 | Helm PDB / anti-affinity / topology spread / graceful drain | Kubernetes YAML; cannot exercise a cluster here. Inspection-only. |
| 994 | Verify all Terraform `var.*` are declared | HCL validation needs `terraform validate`; inspection-only. |
| 995 | Align Fly vs Helm/TF prod CPU/memory sizing | Cross-file infra policy decision; documentation/inspection-only. |
| 996 | Fly `min_machines_running` cold-start tradeoff | Single Fly setting / policy call; inspection-only. |
| 998 | k6 STT/TTS/`/v1/speech` load scenarios | New load scripts needing a live gateway to be meaningful; not unit-testable. |
| 999 | Docs deployed twice (Pages + Cloudflare) | CI workflow consolidation; best validated in CI. |
