# Wave 5 — Web/Build/Infra & Cost (doc 10, IDs 901-1000)

Continuation of waves 1-4. The safe, localized, pure-logic pool for doc 10 is now
**nearly exhausted** — most remaining items are structural multi-file refactors
(#901 `src/modules/` mirror), client-bundle/dependency surgery needing a Next
build (#955-#960, #964-#965), CI YAML jobs (#904-#906, #919-#920, #999), or
infra YAML/HCL that can't be exercised here (#991, #995, #996, #998). This wave
landed the few genuinely safe + extractable items left.

Strict ownership respected — only edited under `web/src/`,
`src/compute/image-builder/`. No changes to `src/modules/**`, `src/index.ts`,
`package.json`, `tsconfig*`, build/turbo/vitest config, or anything outside the
allowed set.

Run only this wave:

```bash
bunx vitest run --config vitest.opt.config.ts __tests__/opt/10-web-infra-w5.test.ts
```

The opt vitest config has **no jsdom / `document` global**, so all logic is kept
in framework-free modules and tested via pure functions (inputs injected). React
`.tsx` wiring, Next config, Dockerfiles, Helm/HCL are inspection-only.

## Implemented (code + unit tests)

| # | Title | Area | What changed | Files |
|---|-------|------|--------------|-------|
| 949 | `FallbackChainList` bypassed the typed `lib/gateway` client with a bare `fetch('/v1/...')` (no `credentials`, no error typing) | Reliability | Added a typed `getServiceStats()` to `lib/gateway.ts` that routes through the shared `gwJson` helper (consistent `credentials`/error handling) and a pure `normalizeServiceStats(raw)` payload-shaper in `service-stats.ts`. The shaper defends the latency-suffix render against partial/garbage responses — drops malformed stat entries (non-finite `avgMs`, non-object), rounds `avgMs`, defaults missing `samples` to 0, nulls an invalid `coldStart`, returns `null` only for non-object payloads. `FallbackChainList` now calls `getServiceStats()` and holds `ServiceStatsData` state (removed its redundant local `ServiceStats` interface). | `web/src/lib/service-stats.ts`, `web/src/lib/gateway.ts`, `web/src/sections/FallbackChainList.tsx` |
| 963 | `[...slug]` catch-all hand-maintained a static-export slug array inline; could drift / explode the export | Reliability | Extracted the bounded route list into a single `STATIC_EXPORT_ROUTES` allow-list + pure `staticSlugParams()` in `lib/nav` (each `a/b/c` route → `{ slug: ['a','b','c'] }`; empty/whitespace routes dropped so a stray entry can't emit `{ slug: [] }` and collide with the index route). `app/[...slug]/page.tsx`'s `generateStaticParams` now derives from it — one source of truth, unit-testable without a Next build. | `web/src/lib/nav.ts`, `web/src/app/[...slug]/page.tsx` |
| 970 | `pollBuildStatus` only reads the local catalog; on a process restart mid-build the CLI poller spins forever | Functionality | Added a pure `isResumableBuild(record)` predicate: a record is resumable iff **non-terminal AND** carries the `runId` already persisted at step 3 of `_runBuild` (then a caller can re-derive status via `getRunStatus(...)`); a non-terminal record *without* a `runId` is orphaned and should be failed out instead of polled indefinitely. Null-safe; agrees with `isTerminalBuildStatus`. (The actual restart re-derive call into the GitHub API stays network-bound — only the decision is pure.) | `src/compute/image-builder/image-build-service.ts` |

### Code fixes (inspection-only — real correctness/cleanup, no extractable pure logic)

| # | Title | Change made | File |
|---|-------|-------------|------|
| 932 | `LogsSection` put the React `key` on a Fragment-wrapped inner `<tr>` → duplicate-key warnings + reconciliation churn | Converted the `.map()`'s `<>…</>` to `<Fragment key={e.id}>` (imported `Fragment`) so the **list item** is keyed, and removed the now-redundant `key` on the inner expand `<tr>` (direct sibling, not an array item). | `web/src/sections/LogsSection.tsx` |
| 933 (family) | `ServicesSection` still imported the unused `STAGE_ACCENTS` (left over after the wave-3 shared-palette consolidation to `phase-colors`) | Dropped the dead import. `STAGE_ACCENTS` remains exported from `provider-types.ts` (no other importers; export left to keep the diff minimal). | `web/src/sections/ServicesSection.tsx` |

### Tests

`__tests__/opt/10-web-infra-w5.test.ts` — **17 tests, all passing**.
Pure logic only (opt config has no jsdom/`document`):

- **#949** `normalizeServiceStats` — well-formed pass-through (+ `avgMs` rounding),
  non-object → `null`, missing/garbage `stats` → `{}`, malformed-entry dropping,
  `samples` default, invalid `coldStart` → `null`, and a `latencySuffix` round-trip
  proving no `NaN`/`undefined` leaks into the render.
- **#963** `staticSlugParams` / `STATIC_EXPORT_ROUTES` — route→`{slug}` mapping,
  default derivation, source-route round-trip, empty/whitespace dropping, closed
  allow-list bound + de-dup, legacy-compat (`config/profiles`) coverage.
- **#970** `isResumableBuild` — resumable (non-terminal + `runId`), not-resumable
  when terminal, not-resumable when orphaned (no/zero/negative `runId`), null-safe.

Verified **no regression** across waves 1-5 web-infra suites:
`10-web-infra{,-w2,-w3,-w4,-w5}.test.ts` → **138 tests pass**.
Edited pure modules type-check clean under isolated strict `tsc`
(`web/src/lib/service-stats.ts`, `web/src/lib/nav.ts` → exit 0;
`src/compute/image-builder/image-build-service.ts` → only environmental
`fs`/`path`/`process` resolution noise, no logic errors). The `.tsx` edits carry
only the pre-existing environmental React-types errors that also appear in
untouched files (web `node_modules` not installed in this sandbox); none originate
from these edits.

## Inspection-only (verified, no change needed)

| # | Title | Finding |
|---|-------|---------|
| 994 | Verify all Terraform `var.*` are declared | **Already satisfied.** Every `var.*` referenced in `terraform/main.tf` (`region`, `environment`, `groq_api_key`, `gateway_api_keys`, `cors_origins`, `rate_limit_rpm`, `dockerhub_username`, `dockerhub_token`, `vast_api_key`, `runpod_api_key`) is declared — split across `variables.tf` and `main.tf` itself (valid HCL: variables may be declared in any `.tf` file). No undeclared vars; `terraform plan` would not fail on this. No edit made. |

## Deferred / not implemented this wave (with reasons)

These remain valid but were intentionally **not** implemented — they need the
web/build toolchain to validate safely (cannot run `bun install`/`next
build`/full `tsc`), are config/markup with no pure logic to unit-test, are infra
YAML/HCL whose runtime can't be exercised here, or are large structural/multi-file
refactors outside a localized-safe pass.

| # | Title | Why deferred |
|---|-------|--------------|
| 901 / 902 | Delete/collapse the `src/modules/` (and triple image-builder) duplicate tree | ~80k LOC structural deletion across out-of-scope `src/modules/**`; explicitly forbidden to edit. |
| 904 / 905 / 906 / 919 / 920 | CI artifact reuse, perf-budget triple build, web build job, turbo-wired quality chain, web lint glob | `.github/workflows/**` / `package.json` / `turbo.json` changes best validated in CI; several touch out-of-scope files. |
| 907 / 908 / 909 / 910 / 911 / 912 / 913 | `next.config` type/eslint gates, `workspace.json`, `turbo.json` web tasks, tsup dts/splitting/budget, tsconfig project refs | Build-tool/config changes needing the toolchain to validate; mostly out-of-scope files. |
| 914 / 915 / 917 / 918 | `.tsbuildinfo` gitignore, committed `test-results/`, drop `package-lock.json`, release sourcemaps | Repo-hygiene / `.gitignore` / lockfile / release-workflow changes; not pure logic and partly out of scope. |
| 916 | Consolidate three Playwright configs | e2e config consolidation needs the Playwright toolchain to verify. |
| 921-923 / 927-931 / 934 / 937-939 / 944 / 947 / 953 | Shared-UI reuse (`Card`/`StatusDot`/`IconBox`/`KV`/`Skeleton`/`StatusBadge`/`ConfirmModal`/`Toast`/`CopyButton`), `React.memo`, redundant dot, per-section SWR cache | React `.tsx`/JSX markup + hook behavior; need jsdom + render to verify. No extractable pure predicate. |
| 941 | Consolidate Overview's 6 pollers into one batched poller | React data-layer refactor across the section; needs render verification. |
| 955 / 956 / 957 / 958 / 959 / 960 / 962 / 964 / 965 | Delete dead `ProfileFlowDiagram`, lazy-load `@xyflow/react`, drop one DnD lib, move `serve`, `next/font`, lucide barrel guard, keyframes→css, web bundle-analyzer, `ssr:false` | Client-bundle/dependency/CSS/`next.config` changes that must be proven with a `next build`/bundle check; `web/package.json` partly out of scope. |
| 968 | Build-status webhook instead of polling | Backoff already landed (#968 wave 1); a repository webhook is a network/infra feature, not unit-testable. |
| 980 / 981 / 982 / 983 / 988 | `Dockerfile.worker`/root/production layer ordering, drop redundant `dist`/`node_modules`, JS healthcheck | Dockerfiles; need a real `docker build` to validate layer/size claims. Inspection-only. |
| 991 / 995 / 996 / 998 | Helm PDB/anti-affinity, Fly↔Helm↔TF sizing alignment, Fly `min_machines_running`, k6 STT/TTS scenarios | Kubernetes/Fly/Terraform/k6 — can't exercise a cluster or live gateway here; cross-file infra policy calls. |
| 999 | Docs double-deploy (Pages + Cloudflare) | Live-deploy CI decision (which host is canonical); best validated in CI. |

## Note

**Safe localized pure-logic pool for doc 10 is effectively exhausted.** After 5
waves, the remaining IDs are dominated by (a) the out-of-scope `src/modules/`
mirror (#901/#902), (b) client-bundle/dependency/CSS work that genuinely requires
a Next build + bundle analyzer to land safely (#955-#965), (c) CI/turbo/tsup
config (#904-#920) and (d) infra YAML/HCL/k6 (#980-#998) — none of which expose
new pure TS logic to unit-test under the opt config. Future waves here would need
the relaxed-constraints (build/CI) environment to make further safe progress.
