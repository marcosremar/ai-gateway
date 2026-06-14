# Implemented — CLI, SDK & Developer Experience (IDs 801–900)

High/Med-impact + S/M-effort fixes that are safe and localized to the owned surface
(`bin/`, `cli/`, `src/sdk/`, `src/contracts/`). All changes keep their files compiling
(verified via `bun build` bundling of `bin/ai-gateway.ts`, `src/sdk/index.ts`,
`src/contracts/index.ts`) and are covered by `__tests__/opt/09-cli-sdk.test.ts`.

| ID | File:line | Change | Test |
|----|-----------|--------|------|
| 662 | src/contracts/index.ts:73,82 | Bound `ChatMessageSchema.content` to `MAX_CHAT_CONTENT_CHARS` (256 KB) — rejects runaway payloads before they reach (and bill) an upstream provider. | `ChatMessageSchema content bound` — accepts at limit, rejects limit+1 |
| 663 | src/contracts/index.ts:75,88 | Bound `ChatCompletionRequestSchema.messages` to `.min(1).max(MAX_CHAT_MESSAGES)` (256). Empty array now rejected (always invalid for chat completion). | `messages array bound` — rejects empty + over-cap, accepts normal |
| 664 | src/contracts/index.ts:78,90 | Cap `max_tokens` at `MAX_COMPLETION_TOKENS` (131072) on top of the existing positive-int check — guards spend on a fat-fingered value. | `max_tokens bound` — accepts at limit, rejects over-limit & non-positive |
| 827 | src/sdk/types.ts:121-125, src/sdk/client.ts:275-289 | Add `maxCostUsd` / `containerDiskInGb` / `interruptible` / `region` to `DeployOptions`; `deployGpu` validates `maxCostUsd > 0` and passes set fields through to the deploy request body. Canonical SDK can now cap deploy spend. | `deployGpu maxCostUsd passthrough` — body carries fields, omits when absent, rejects bad value before fetch |
| 833 | src/sdk/types.ts:29-32, src/sdk/client.ts:63-64,98-110,944-945 | Promote retry/backoff from module constants to per-instance `GatewayConfig.maxRetries` / `retryBackoffMs` (defaults preserved; bad input clamps to defaults). | `GatewaySDK retry config` — retries to default, `maxRetries:0` disables, custom cap, no-retry on HTTP 4xx, default-fallback on bad config |
| 805 | bin/ai-gateway.ts:7720-7735 | `ping`/`benchmark` now validate `-n`/`--count` via `validateNumericFlag` instead of unchecked `parseInt` (silent `NaN`); bad number → `UsageError` → exit 2. | `validateNumericFlag` unit cases (non-numeric/empty/integer/min/max) |
| 807 | bin/ai-gateway.ts:7751, cli/cli-helpers.ts:11-13,91-104 | Top-level catch routes through `classifyExitCode`: usage errors (`UsageError`) exit **2**, runtime/HTTP/network errors exit **1** — mirrors the cost-audit binary's scheme. | `classifyExitCode` — UsageError→2, others→1 |
| 808 | cli/cli-helpers.ts:66-72 | `getArgSafe` rejects a flag value that is itself a flag (`chat -m --no-stream` no longer swallows `--no-stream`). Exported helper, available for adoption by valued-flag parsing. | `getArgSafe` — value, flag-as-value→undefined, trailing/absent |
| 842 | bin/ai-gateway.ts:807-810,6047,7025-7048, cli/cli-helpers.ts:80-82 | Add `--max-cost-usd <usd>` to `gpu deploy`: parsed/validated by `parseMaxCostUsd`, passed through to the deploy body as `maxCostUsd`; bad value exits 2. Help text documents it. | `parseMaxCostUsd` + `deployGpu` body assertions |

New pure helper module: **`cli/cli-helpers.ts`** — `validateNumericFlag`, `getArgSafe`,
`parseMaxCostUsd`, `classifyExitCode`, `UsageError`, `EXIT_USAGE`/`EXIT_RUNTIME`. Extracted
so CLI parsing/validation is unit-testable without importing `bin/ai-gateway.ts` (which runs
`main()` at module load). Dependency-free; no `process.exit`/console — callers decide output.

Test file: `__tests__/opt/09-cli-sdk.test.ts` — 31 unit tests, no network (global `fetch`
mocked via `vi.stubGlobal`, tiny retry backoff to stay fast). Run:
`bunx vitest run --config vitest.opt.config.ts __tests__/opt/09-*.test.ts`.

## Deferred (and why)

**Packaging / public-surface items — explicitly deferred to the maintainer** (changing them
mid-flight breaks other agents' in-progress imports; out of scope per task brief):
- **#866 / #867** — point `package.json` `main`/`types` (and `exports` conditions) at built
  `dist/*.js`/`.d.ts` instead of raw `src/*.ts`. Requires editing `package.json` (forbidden).
- **#864 / #865** — collapse the duplicate `src/` vs `src/modules/` tree and reconcile
  `tsup.config.ts` entries with `package.json` exports. Touches `src/index.ts`,
  `src/modules/**`, `tsup.config.ts`, `package.json` — all forbidden; large/risky.
- **#868 / #872 / #873** — restrict the `./*` wildcard export, slim the root barrel, add
  `engines`/`packageManager`. All `package.json`/`tsup`/`src/index.ts` edits — forbidden.
- **@parle naming (README/#866 family)** — README/migration-guide import-path fixes live
  outside the owned code surface (docs only) and depend on the package-name decision above.

**Large / cross-SDK consolidation — too big for a localized, low-risk change:**
- **#821 / #822 / #825** — consolidate the three divergent SDK clients and unify the three
  `GatewayError` classes. Spans `sdk/node/**` and `sdk/python/**` (outside ownership) and is
  an L-effort breaking change; needs an ADR.
- **#831 / #840 / #834 / #838** — `chatStream()` async-iterator, public `AbortSignal`
  threading, port the `sdk/node` circuit breaker, typed Prometheus parsing. M/L effort with
  broader surface change; deferred to keep this batch minimal.
- **#875–#885 (TS↔Python parity)** — touch `sdk/python/**` and `sdk/node/**`, outside the
  owned paths.

**Server-side dependency — out of owned surface:**
- **#841 / #848 / #853** — preflight cost estimate + confirmation, idle-policy reminder, and
  `--dry-run` on `gpu deploy`. These need `/v1/gpu/preflight` orchestration and deploy-flow
  changes in `server/` (forbidden). The `--max-cost-usd` ceiling (#842) is the safe,
  client-only slice of this cluster and was implemented.

### Note on a behavioral tightening
`ChatCompletionRequestSchema.messages` gained `.min(1)`: a previously-accepted empty array
is now a 400. This is intentional (an empty `messages` is never valid for chat completion and
matches audit #663), but is the one change with a (negligible) behavioral surface beyond pure
upper-bounding.
