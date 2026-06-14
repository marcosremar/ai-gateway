# 09 — CLI / SDK / DX — Wave 3 (implemented)

Continuation of waves 1–2. Third batch of **localized, low-risk, unit-tested**
fixes from [`docs/optimizations/09-cli-sdk-dx.md`](../09-cli-sdk-dx.md), all
backed by pure helpers so they test without importing `bin/ai-gateway.ts` (which
runs `main()` at module load).

**Test:** `__tests__/opt/09-cli-sdk-w3.test.ts` — 40 tests, all passing.
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/09-cli-sdk-w3.test.ts`

**Strict ownership respected** — only edited: `cli/cli-helpers.ts`,
`src/sdk/client.ts`, `src/sdk/types.ts`, `src/sdk/index.ts`. No packaging /
`package.json` / `src/index.ts` / `src/modules/**` changes.

## Implemented

| ID | Optimization | Where | New symbol(s) | Notes |
|----|--------------|-------|---------------|-------|
| #801 | Global `--json` for read commands | `cli/cli-helpers.ts` | `hasJsonFlag`, `jsonOutput` | Flag detection (position-independent) + stable 2-space JSON; top-level `undefined`→`null`. Commands opt in by checking `hasJsonFlag(args)`. |
| #803 | `-h`/`--help` on every subcommand | `cli/cli-helpers.ts` | `hasHelpFlag` | Lets commands with no `HELP` map entry (`balance`, `config`, `whoami`, `ping`, `voices`) detect a help request before executing. |
| #811 | Group `gpu` subcommands by lifecycle | `cli/cli-helpers.ts` | `groupGpuSubcommands`, `GpuSubcommandGroups` | Pure classifier → Lifecycle / Cost / Dev / Advanced; unknown commands fall into Advanced (nothing dropped). |
| #846 | `gpu offers` flag spot/interruptible savings | `cli/cli-helpers.ts` | `computeSpotSavings` | `%` savings of `spotPricePerHr` vs on-demand; `null` when spot missing/zero/not-cheaper. |
| #847 | Per-request cost in `chat`/`benchmark` | `cli/cli-helpers.ts` | `estimateChatCostUsd` | Token usage × caller-supplied per-1M pricing; self-contained (no `src/modules/**` import). Counts only sides with a known rate. |
| #855 | `--json` for `config`/`whoami` | `cli/cli-helpers.ts` | `buildConfigJson` | `{url, urlSource, keySource, key, connected, userId?}` payload; omits `userId` when absent. |
| #856 | Reduce gateway-URL env sprawl + provenance | `cli/cli-helpers.ts` | `resolveGatewayUrlFromEnv`, `URL_ENV_PRECEDENCE` | Mirrors `getConfig()` precedence (`AI_GATEWAY_URL` > `GATEWAY_URL` > `PORT`) and reports which source won. |
| #859 | Document `.env` walk-up discovery | `cli/cli-helpers.ts` | `describeEnvDiscovery`, `ENV_WALK_UP_LEVELS` | Human string for help / `config` output (names found path or states 6-level depth). |
| #860 | Warn when no key but gateway needs one | `cli/cli-helpers.ts` | `needsApiKeyWarning`, `isLocalGatewayUrl` | Warn on remote gateway + empty key; localhost exempt. IPv6 bracket-host normalised (fixes `[::1]`). |
| #824 | Default SDK `baseUrl` to env discovery | `src/sdk/client.ts` | `GatewaySDK.fromEnv`, `resolveBaseUrlFromEnv` | Zero-config parity with the CLI; explicit override wins. Verified via mocked-fetch URL assertion. |
| #828 | Align `PipelineTiming` across SDKs | `src/sdk/types.ts`, `client.ts` | `PipelineTiming` (now named) + `sttMs`/`llmMs`/`ttsMs` | `pipeline()` surfaces per-stage timings when present; left `undefined` when the gateway omits them. |
| #830 | Make `close()` consistent / awaitable | `src/sdk/client.ts` | `close()`→`async`, `isClosed()` | Matches Python / `sdk/node` contract; idempotent marker (no persistent connections yet). |
| #837 | Expose `requestId` from the SDK | `src/sdk/client.ts`, `types.ts` | `generateRequestId`, `lastRequestId()`, `requestId` config | Emits `X-Request-ID` per logical request (reused across retries); disable via `requestId:false`. |
| #838 | Parse Prometheus metrics → typed JSON | `src/sdk/client.ts` | `parseMetrics`, `metricsJson()`, `PrometheusSample` | Handles labelled/bare samples, `+Inf`/`NaN`, skips comments/garbage; no regex burden on callers. |
| #885 | Align retryable-error detection | `src/sdk/client.ts` | `isRetryableNetworkError` | Public wrapper over internal `isRetryableError` so SDKs can share one policy; exported from index. |

`src/sdk/index.ts` now re-exports the new pure helpers + `PipelineTiming`,
`PrometheusSample`, `PollOptions`, `parseGatewayErrorBody`, `validatePollOptions`,
`classifyGpuPollState` for standalone use.

## Verification

- `bunx vitest run --config vitest.opt.config.ts __tests__/opt/09-cli-sdk-w3.test.ts` → **40 passed**.
- Re-ran waves 1–2 (`09-cli-sdk.test.ts`, `09-cli-sdk-w2.test.ts`) → **88 passed** (no regressions from the SDK constructor / `fetch` / `close()` changes).
- `tsc --noEmit --strict` on the four edited files → clean (exit 0).

## Deferred (out of scope / risky / cross-file / needs forbidden files)

| ID | Reason |
|----|--------|
| #810 | Shell completion generation — large, needs real `bin/ai-gateway.ts` command/flag introspection (effort L). |
| #813, #814 | `voices`/`detect-language` hit live endpoints — behavioural change to bin commands, needs network-path edits in `bin/ai-gateway.ts`. |
| #821, #822, #825, #831, #834, #840 | Consolidate/align the three SDK clients, streaming chat, circuit breaker, `AbortSignal` threading — cross-file (`sdk/node`, `sdk/python`) or large refactors. |
| #835 | Type `Record<string,unknown>` returns — broad, touches many methods; low isolation. |
| #844, #850, #861, #862 | New top-level commands (`cost`, `init`/`login`, CLI config file) — substantial new bin command surface. |
| #864–#874 | Packaging / tree-shaking / `package.json` — explicitly forbidden (`package.json`, `tsup`, `src/index.ts`). |
| #875–#884 | TS↔Python parity (N-way race, ensemble `llm_correct`, sync TS client, codegen) — require `sdk/python` / `sdk/node` edits (out of ownership) or large effort. |
| #886–#895 | Examples/docs onboarding — useful but doc-heavy; deferred to a docs-focused pass. |
| #899, #900 | SIGINT handling + deploy-poller timeout reporting in `bin/ai-gateway.ts` — touch live streaming/polling loops (effort M, lower isolation). |
