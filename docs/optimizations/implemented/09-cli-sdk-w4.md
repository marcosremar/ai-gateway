# 09 — CLI / SDK / DX — Wave 4 (implemented)

Continuation of waves 1-3. All items are localized + low-risk, backed by pure
helpers (testable without importing `bin/ai-gateway.ts`, which runs `main()` at
load) or SDK methods exercised with a mocked `fetch`.

Tests: `__tests__/opt/09-cli-sdk-w4.test.ts` — **40 tests, all passing**.
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/09-cli-sdk-w4.test.ts`

## Implemented

| ID | Optimization | Where | Helper / method | Notes |
|----|--------------|-------|-----------------|-------|
| 810 | Shell completion generation | `cli/cli-helpers.ts` | `parseCompletionShell`, `generateCompletionScript` | Emits bash/zsh/fish completion scripts for the ~30-command CLI; pure string builders. |
| 813 | `voices` from live data, not hardcoded | `cli/cli-helpers.ts` | `normalizeVoices` | Normalises a `/v1/tts/voices` payload (objects or bare strings), de-dupes by id; `[]` on garbage so caller can fall back to the static list. |
| 819 | `media test` `--json` + summary exit code | `cli/cli-helpers.ts` | `buildMediaTestSummary` | `{image,audio,ok}` + exit 0/1 for CI gating. |
| 820 | Native silence WAV (drop python3 subprocess) | `cli/cli-helpers.ts` | `makeSilenceWav` | Pure-TS 16-bit PCM mono WAV; benchmark no longer crashes on a host without python3. |
| 844 | Dedicated `cost`/`spend` summary | `cli/cli-helpers.ts` | `buildCostSummary` | Combined hourly burn + projected daily/monthly + total balance from `gpu list`/`balance` numbers. |
| 848 | Idle/auto-stop reassurance on deploy | `cli/cli-helpers.ts` | `idleStopNote`, `DEFAULT_IDLE_STOP_MIN`, `DEFAULT_AUTO_DESTROY_HOURS` | One-liner "auto-stops after 15m idle, auto-destroys 2h later". |
| 849 | Zombie-pod cost impact annotation | `cli/cli-helpers.ts` | `annotateZombieCost` | Per-hour + daily burn + warning for a `running`-but-unreachable pod; `null` when cost unknown. |
| 850 | Make `cost-audit` discoverable from main CLI | `cli/cli-helpers.ts` | `listSiblingBinaries` | Metadata for a "See also" help section. |
| 891 | Document exit codes + `--json` contract | `cli/cli-helpers.ts` | `describeScriptingContract` | Exit-code scheme (0/1/2/130) + sorted json-capable command list. |
| 899 | Clean Ctrl-C during streaming/polling | `cli/cli-helpers.ts` | `buildInterruptExit`, `EXIT_SIGINT` | Flush newline + optional summary + exit 130. |
| 900 | Deploy poller: timeout vs completion | `cli/cli-helpers.ts` | `classifyDeployPollOutcome` | Exhausted loop → explicit `timeout` outcome + non-zero exit (was silent exit 0). |
| 825 | Unify the three divergent `GatewayError`s | `src/sdk/client.ts` | `normalizeGatewayError`, `NormalizedGatewayError` | Reduces any error class to one `{message,statusCode,endpoint,code,retryable,isNetworkError}` shape for cross-SDK catch blocks. |
| 831 | Streaming chat in the SDK | `src/sdk/client.ts`, `types.ts` | `chatStream()` (async-iterator), `parseSSEChunk`, `ChatStreamChunk` | Token-by-token SSE parity with the CLI; degrades to a single chunk if the gateway returns buffered JSON. |
| 832 | Pagination auto-iteration for list endpoints | `src/sdk/client.ts` | `listAllWorkloads()` (async-iterator) | Walks pages until `total` covered / short page; 10k-iteration guard against a bad `total`. |
| 840 | `AbortSignal` support on SDK methods | `src/sdk/client.ts` | `pipeline`/`chat`/`chatStream`/`transcribeEnsemble` `signal` opt | Threads an optional `signal` (the internal `fetch` already accepted one). |
| 877 | Rich ensemble transcription in TS | `src/sdk/client.ts`, `types.ts` | `transcribeEnsemble()`, `EnsembleTranscribeResponse`, `EnsembleProviderResult` | Consensus + per-provider results + optional `llmCorrect`; mirrors the Python SDK's `transcribe_ensemble`. |
| 886 | Real GatewaySDK example (TS) | `examples/gateway_sdk_quickstart.ts` | — | Minimal transcribe → translate → tts (+ streaming chat) using `GatewaySDK.fromEnv()`. Compiles under strict tsc. |

New exports added to `src/sdk/index.ts`: `parseSSEChunk`, `normalizeGatewayError`,
`NormalizedGatewayError`, `ChatStreamChunk`, `EnsembleTranscribeResponse`,
`EnsembleProviderResult`.

## Deferred (out of scope / not safe-localized this wave)

| ID | Reason |
|----|--------|
| 801-809, 811, 815-818, 824, 826-830, 833, 836-838, 842-843, 845-847, 852, 854-860, 863, 885, 896, 898 | Already implemented in waves 1-3. |
| 812, 814 | Touch live CLI command bodies (`cmdHelp`/auto-start banner, `detect-language` endpoint switch) in `bin/ai-gateway.ts` — larger, behavioural; defer to a wiring wave. |
| 821, 822, 823, 830-dup, 839 | "Consolidate / reconcile the three SDK clients" — cross-cutting refactor spanning `sdk/node` + Python; needs an ADR, not a localized helper. |
| 834 | Port `sdk/node`'s CircuitBreaker into `src/sdk` — non-trivial; better as a deliberate unify-on-one-client task. |
| 835 | Typed return interfaces for `gpuCatalog`/`serviceStats`/etc. — wide type-surface change across many methods. |
| 841, 853 | `gpu deploy` preflight + estimate / `--dry-run` — needs live `cmdGpuDeploy` rewiring (`bin/ai-gateway.ts`), confirmation prompts. |
| 851 | Generalize `cost-audit` sweep beyond Vast — edits `bin/ai-gateway-cost-audit.ts` provider logic (real API calls); defer. |
| 861, 862 | `login`/`init` + `~/.babelcast/cli-config.json` — new stateful command + file I/O; behavioural. |
| 864-874 | Packaging / tree-shaking / `package.json` exports — **explicitly out of ownership** (package.json/tsup/tsconfig forbidden). |
| 875, 876, 878-884 | TS↔Python parity (N-way race port, deployGpu option coverage, DTO codegen, sync client) — large, cross-language. |
| 887-890, 892-895 | Docs under `docs/` (QUICKSTART/onboarding/error-codes/migration/cli.md) — outside the owned `docs/optimizations/implemented/` path; #886 covered via `examples/`, #891 via a testable contract helper. |
| 897 | `fetchJSON` should throw instead of `process.exit` — lives in `bin/ai-gateway.ts` (the load-runs-main file); the throw-based pattern is already modelled by `parseHttpError` (w3) + `classifyExitCode`, but wiring it into the binary is behavioural. |
