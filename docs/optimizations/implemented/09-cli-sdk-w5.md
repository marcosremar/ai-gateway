# 09 — CLI / SDK / DX — Wave 5 (implemented)

Continuation of waves 1-4. The safe pool is now nearly exhausted; this wave
lands a small focused set (one SDK behaviour change + three pure CLI helpers).
All items are localized + low-risk: the CLI helpers live in `cli/cli-helpers.ts`
(testable without importing `bin/ai-gateway.ts`, which runs `main()` at load),
and the SDK change is exercised with a mocked `fetch`.

Tests: `__tests__/opt/09-cli-sdk-w5.test.ts` — **19 tests, all passing**.
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/09-cli-sdk-w5.test.ts`

## Implemented

| ID | Optimization | Where | Helper / method | Notes |
|----|--------------|-------|-----------------|-------|
| 839 | Gate the Groq-fallback side effect behind an explicit flag | `src/sdk/client.ts`, `src/sdk/types.ts` | `shouldFallbackToGroq`, `GatewayConfig.fallbackToGroq` | Direct-Groq fallback is now **OFF by default** — it billed Groq and bypassed gateway routing/cost tracking whenever `GROQ_API_KEY` was present. Now requires `fallbackToGroq: true` **and** a key **and** a genuine network error (a 5xx/4xx is a real answer, never silently re-routed). Pure gate threaded into `chat`/`transcribe`. |
| 812 | Surface the auto-start-server behaviour | `cli/cli-helpers.ts` | `autoStartNote` | One-liner stating the port, why it spawned (localhost + nothing listening), and the escape hatch (`AI_GATEWAY_URL` to point remote, `ai-gateway server stop` to kill). |
| 853 | Dry-run / estimate-only `gpu deploy` | `cli/cli-helpers.ts` | `parseDeployDryRun`, `describeDeployDryRun`, `DEPLOY_DRY_RUN_FLAGS` | Detects `--dry-run`/`--estimate-only`/`--preflight-only` (mirrors `gpu finetune`) and formats a "no GPU provisioned" estimate line so the caller can print + exit 0 without calling `/v1/gpu/deploy`. |
| 814 | `detect-language` via the dedicated endpoint | `cli/cli-helpers.ts` | `buildDetectLanguageRequest`, `parseDetectLanguageResponse` | Builds a request for `/v1/detect-language` (vs the CLI's hand-rolled chat-completion prompt — costlier, inconsistent with the SDK's `detectLanguage()`); response parser tolerates legacy chat-derived payloads (bare string / `detected_language` / `lang`). |

New export added to `src/sdk/index.ts`: `shouldFallbackToGroq`.
The existing `examples/gateway_sdk_quickstart.ts` gained a short note documenting
the #839 opt-in (`GatewaySDK.fromEnv({ fallbackToGroq: true })`).

### #839 — behaviour change (intentional)

Previously: any unreachable-gateway error would transparently call Groq directly
if `GROQ_API_KEY` was set in the environment, billing Groq and bypassing the
gateway's routing + cost tracking — a silent surprise. Now the fallback only
fires when the caller explicitly opts in (`fallbackToGroq: true`). Existing
callers that *relied* on the implicit behaviour must add the flag; this is called
out in the SDK quickstart example and the method JSDoc. Verified by mocked-fetch
tests: gateway-down + no opt-in → throws `GatewayError` and Groq is never hit;
opt-in → Groq is called; a real 503 → surfaced (never routed to Groq) even when
opted in.

## Deferred (out of scope / not safe-localized this wave)

| ID | Reason |
|----|--------|
| 801-811, 813, 815-820, 824-833, 836-838, 840, 842-850, 852, 854-860, 863, 877, 885, 891, 896, 898-900 | Already implemented in waves 1-4 (see those `implemented/` docs). |
| 821, 822, 823 | "Consolidate / reconcile the three SDK clients" — cross-cutting refactor spanning `sdk/node` + Python; needs an ADR, not a localized helper. |
| 834 | Port `sdk/node`'s `CircuitBreaker` into `src/sdk` — non-trivial; better as a deliberate unify-on-one-client task. |
| 835 | Typed return interfaces for `gpuCatalog`/`gpuMyLocation`/`gpuReputation`/`serviceStats`/etc. — wide type-surface change across many methods; type-only, weakly unit-testable. Defer to a typing-focused pass. |
| 841 | `gpu deploy` preflight + cost estimate + confirmation prompt — needs live `cmdGpuDeploy` rewiring in `bin/ai-gateway.ts` (the load-runs-`main` file) + interactive confirm; behavioural. (#853's pure dry-run helper lands the parsing/formatting half.) |
| 851 | Generalize `cost-audit` sweep beyond Vast — would add RunPod/TensorDock sweep logic importing from `server/` (out of ownership) and make real API calls; defer. |
| 861, 862 | `login`/`init` + `~/.babelcast/cli-config.json` — new stateful command + file I/O; behavioural. |
| 864-874 | Packaging / tree-shaking / `package.json` exports — **explicitly out of ownership** (package.json/tsup/tsconfig forbidden). |
| 875, 876, 878-884 | TS↔Python parity (N-way race port, `deployGpu` option coverage, DTO codegen, sync client) — large, cross-language. |
| 887-890, 892-895 | Docs under `docs/` (QUICKSTART/onboarding/error-codes/migration/cli.md) — outside the owned paths; #886 already covered via `examples/`, #891 already via a testable contract helper (wave 4). |
| 897 | `fetchJSON` should throw instead of `process.exit` — lives in `bin/ai-gateway.ts`; the throw-based pattern is already modelled by `parseHttpError` + `classifyExitCode`, but wiring it into the binary is behavioural. |

**Safe pool status: effectively exhausted.** The remaining 800-range items are
either already done (waves 1-4), out of ownership (packaging), behavioural
rewires of `bin/ai-gateway.ts`'s live command bodies, cross-language SDK parity
refactors needing an ADR, or wide type-only surface changes. Future waves should
either accept editing the load-runs-`main` binary (with care) or take on one of
the larger consolidation efforts as a deliberate, ADR-backed task.
