# Implemented — Web UI, Image Builder, Build & Infra/Cost (IDs 901-1000)

Source audit: [`docs/optimizations/10-web-build-infra-cost.md`](../10-web-build-infra-cost.md).
Tests: [`__tests__/opt/10-web-infra.test.ts`](../../../__tests__/opt/10-web-infra.test.ts)
(35 unit tests, run via `bunx vitest run --config vitest.opt.config.ts __tests__/opt/10-*.test.ts`).

The opt vitest config has **no jsdom / `document` global**, so all visibility and
WebSocket logic was extracted into framework-free modules and tested via pure
predicates/reducers (the `hidden` flag and incoming events are injected). React
hooks, `.tsx` components, YAML, Dockerfiles, `.dockerignore`, HCL, and Python are
**not unit-testable here** and are marked inspection-only.

## Changes

| ID | File:line | Change made | Test |
|----|-----------|-------------|------|
| 940 | `web/src/hooks/polling-logic.ts:19` (`shouldPoll`) | Pure predicate: skip a polling tick while `document.hidden`. Wired into all data hooks. | `shouldPoll` gates on hidden flag |
| 940 | `web/src/hooks/polling.ts:32` (`usePolling`) | Shared visibility-aware React hook replacing per-hook `setInterval`; pauses on `visibilitychange`, refreshes on re-show. | inspection-only (React hook; pure `shouldPoll` covered) |
| 940 | `web/src/hooks/useHealth.ts`, `useBotStatus.ts`, `useGpuList.ts` | Replaced bespoke `useEffect`+`setInterval` with `usePolling`. | inspection-only (React hooks) |
| 940 | `web/src/hooks/useGpuStatus.ts:22-35` | Tick now reads `document.hidden` via `shouldPoll`; cadence via `gpuPollInterval`; removed dead `prevStatusRef` (#954). | `gpuPollInterval` fast/steady; `shouldPoll` |
| 940/943 | `web/src/sections/profiles/GpuLiveStatus.tsx:201-214` | Poll skips while tab hidden; WS-connected keepalive slowed 15s→60s (data already pushed by WS). | inspection-only (`.tsx`) |
| 952 | `web/src/hooks/polling-logic.ts:30` (`effectivePollInterval`) | Pure: foreground cadence when visible; `null` (stop) or slow keepalive when hidden. | `effectivePollInterval` visible/hidden/keepalive |
| 952/954 | `web/src/hooks/polling-logic.ts:39-57` | `ACTIVE_GPU_STATUSES` + `FAST_GPU_INTERVAL_MS` + `gpuPollInterval` extracted from `useGpuStatus`. | `gpuPollInterval` over all active statuses |
| 942 | `web/src/hooks/gateway-ws-logic.ts` (new) | Framework-free `resolveGatewayWsUrl` + `reduceGatewayWsEvent` + `INITIAL_WS_STATE` (no React import → unit-testable). | `resolveGatewayWsUrl` x3; `reduceGatewayWsEvent` x6 |
| 942 | `web/src/hooks/useGatewayWs.ts:128-268` | Module-level `GatewayWsManager` singleton: one shared socket multiplexed to all subscribers via `subscribe`/ref-count; first subscriber opens, last tears down; reduces double event processing. Pure helpers (`resolveGatewayWsUrl`/`reduceGatewayWsEvent`) also exported here. | singleton class inspection-only; pure helpers covered via `gateway-ws-logic` |
| (flags) | `src/feature-flags/index.ts:60-64` | Numeric env override guarded with `Number.isFinite` — unparseable values (e.g. `"abc"`) fall back to the flag default instead of silently setting `NaN`. | numeric env: bad→default, valid override, unset→default |
| 972 | `src/compute/image-builder/github-repo.ts:135-176` | `assertBuildContextSize` (pure) + `maxBuildContextBytes` + `DEFAULT_MAX_BUILD_CONTEXT_BYTES` (25 MB, env-overridable); `collectFiles` accumulates bytes and throws before reading oversized contexts into memory. | `assertBuildContextSize` x4; `maxBuildContextBytes` x3 |
| 966 | `src/compute/image-builder/github-repo.ts:365-372` (`generateWorkflow`) | Generated workflow `cache-from` now falls back to `type=registry,ref=…:latest` after GHA cache, keeping the first post-eviction build warm. | `generateWorkflow` cache-from registry/:latest |
| 975 | `src/compute/image-builder/github-repo.ts:316-318` (`generateWorkflow`) | Generated workflow gains a `concurrency` group with `cancel-in-progress: true` so rapid rebuilds of the same ref don't run in parallel. `generateWorkflow` exported for tests. | `generateWorkflow` concurrency + cancel-in-progress |
| 968 | `src/compute/image-builder/image-build-service.ts:31-47` (`nextBuildPollDelayMs`) | Build-status polling backs off geometrically (1.5×, base 15s, cap 60s) instead of fixed 15s — roughly halves API calls on long builds. | `nextBuildPollDelayMs` base/growth/cap/bounds |
| 903 | `.github/workflows/ci.yml:32+` (6 jobs) | `actions/cache@v4` on `~/.bun/install/cache` keyed by `bun.lock` hash so deps aren't re-downloaded cold per job. | inspection-only (YAML) |
| 976/977/978/979/987 | `docker/babelcast-subtitle/Dockerfile`, `prebake.py` (new), `.dockerignore` | Build-time model pre-bake (`prebake.py`); `hf_xet` + `HF_XET_HIGH_PERFORMANCE` env (drops deprecated `HF_HUB_ENABLE_HF_TRANSFER`); single merged pip layer; exact version pins; HEALTHCHECK `start-period` 120s→30s; per-subproject `.dockerignore`. | inspection-only (Dockerfile / Python build script) |
| 993 | `terraform/main.tf:52-76` | New `cors_origins` var (default `[]`); `local.cors_origins` resolves to the explicit list, else `*` only outside production, else `""` (closed) in production. | inspection-only (HCL) |
| 997 | `load-testing/k6/config.js:6-16` | Removed hardcoded `gw_loadtest_2026` default; `GATEWAY_API_KEY` now required via `__ENV` and throws with guidance if missing. | inspection-only (k6/runtime guard) |

## Deferred (and why)

- **#993 CORS / #997 token guard** — implemented, but in HCL (`terraform/main.tf`) and
  a k6 runtime `throw` (`load-testing/k6/config.js`). Neither is importable pure TS;
  there is no TS CORS/env-token parser to unit-test, so these are inspection-only.
- **#942 socket singleton selection** — the ref-counting open/teardown lives in the
  `GatewayWsManager` class which holds real `WebSocket`/timer side effects (needs a DOM
  + socket mock, unavailable in the opt config). The *pure* parts it relies on
  (`resolveGatewayWsUrl`, `reduceGatewayWsEvent`) are fully tested; the class is
  inspection-only.
- **#940 React hooks (`usePolling`, `useGpuStatus`, `GpuLiveStatus`)** — exercising the
  effect requires jsdom + a `document` with `visibilitychange`, which the opt config
  deliberately omits. The extracted predicates (`shouldPoll`, `effectivePollInterval`,
  `gpuPollInterval`) carry the logic and are tested directly.
- **CI cache (#903), Dockerfile/pre-bake (#976-#987), `.dockerignore` (#986)** — YAML,
  Dockerfile, and a Python build script; not unit-testable. Verified by inspection of
  the diffs.
- **Larger items from the audit not implemented in this pass** (out of scope for the
  localized fixes): #901 `src/modules/` mirror deletion, #905 performance-budget triple
  build, #906 web CI build job, #955/#956 React Flow dead-code / dynamic import,
  #989-#992/#995-#996 Helm/Fly right-sizing, #1000 Grafana alert rules. These are
  structural/multi-file refactors tracked in the source audit doc.
