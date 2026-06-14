# Implemented — CLI, SDK & Developer Experience (IDs 801–900) — WAVE 2

Continuation of [`09-cli-sdk.md`](./09-cli-sdk.md). A second batch of SAFE, LOCALIZED
fixes from [`../09-cli-sdk-dx.md`](../09-cli-sdk-dx.md) not covered in wave 1, each backed
by a **pure, unit-testable helper** in `cli/cli-helpers.ts` or `src/sdk/` and wired into
`bin/ai-gateway.ts` / `src/sdk/client.ts` with minimal diffs.

All edits stayed inside the owned surface (`bin/`, `cli/`, `src/sdk/`). Verified:
- `cli/cli-helpers.ts`, `src/sdk/client.ts`, `src/sdk/types.ts` pass `tsc --noEmit --strict`.
- `bin/ai-gateway.ts`, `src/sdk/index.ts`, `src/contracts/index.ts` bundle cleanly via `bun build`.
- Covered by `__tests__/opt/09-cli-sdk-w2.test.ts` (**57 tests, all pass**); wave-1 suite
  (`09-cli-sdk.test.ts`, 31 tests) still green.

Run:
`bunx vitest run --config vitest.opt.config.ts __tests__/opt/09-cli-sdk-w2.test.ts`

| ID | File:area | Change | Test |
|----|-----------|--------|------|
| 804 | cli/cli-helpers.ts `parseTopLevelFlag`; bin/ai-gateway.ts (help dispatch) | Recognize top-level `--version`/`-v`/`-V` and `--help`/`-h` before per-command dispatch. `-v` is only version as the **first** token, so the `tts -v <voice>` shorthand is unaffected. | `parseTopLevelFlag` — version/help flags, `tts -v` not version, empty argv |
| 806 | cli/cli-helpers.ts `detectUnknownFlags` | Collect unrecognized `--flags`/`-x` for a command and suggest the closest known flag (edit-distance ≤ 2). Skips negative numbers, lone `-`/`--`, strips inline `=value`. Exported for adoption per-command. | `detectUnknownFlags` — none/unknown+suggestion, negatives ignored, `=value` stripped, separators ignored |
| 809 / 852 | cli/cli-helpers.ts `parseOffersSort`,`sortOffers`; bin `cmdGpuOffers` + offers dispatch | Add `gpu offers --sort price\|vram\|score` (default cheapest-first, documented in the header). `sortOffers` is pure and non-mutating. | `parseOffersSort + sortOffers` — default, case-insensitive, reject unknown, price asc / vram desc / score desc + no-mutate |
| 843 | cli/cli-helpers.ts `sumBurnRate`; bin `cmdGpuList` footer | Sum `costPerHr` across instances and print a `Total burn: $X.XX/hr across N instance(s)` footer so operators see combined spend at a glance. | `sumBurnRate` — sums valid, ignores missing/zero/invalid, empty list |
| 854 / 863 | cli/cli-helpers.ts `resolveKeySource`,`maskKey`,`KEY_ENV_PRECEDENCE` | Pure resolution of **which** env var supplied the API key (precedence: `AIGW_APP_KEY` → `AI_GATEWAY_KEY` → `GATEWAY_API_KEY` → first of `GATEWAY_API_KEYS`), so `config` can show provenance. `maskKey` for safe display. | `resolveKeySource` — precedence, multi-key first, `none`; `maskKey` — long mask + `(not set)` |
| 857 | cli/cli-helpers.ts `parseUserIdentity` | Pure version of `cmdWhoami`'s `key:user[:label]` parsing — extracts user/label/key-hint without printing/`process.exit`. | `parseUserIdentity` — `key:user:label`, default when no colon |
| 858 | cli/cli-helpers.ts `validateGatewayUrl` | Validate a resolved gateway URL early (mirrors the SDK's constructor check); returns normalized (trailing-slash-stripped) URL or a usage error. | `validateGatewayUrl` — valid+trim, reject non-http/malformed, reject empty |
| 898 / 826 | cli/cli-helpers.ts `parseHttpError`,`formatHttpError`; bin `fetchJSON` | Parse non-OK bodies (`ErrorResponseSchema`) and surface the structured `code`/`retryable` (e.g. `CREDIT_EXHAUSTED: … (not retryable)`) instead of a bare status; tolerant of flat + nested + non-JSON. | `parseHttpError + formatHttpError` — flat, nested `{error:{…}}`, non-JSON fallback |
| 816 | cli/cli-helpers.ts `overwriteDecision` | Decide `ok`/`warn`/`block` before clobbering an output file: block a default path without `--force`, warn for a user path or `--force`. | `overwriteDecision` — ok when absent, block default no-force, warn user-path/force |
| 817 | cli/cli-helpers.ts `validateUploadSize`,`MAX_AUDIO_UPLOAD_BYTES` | Client-side file-size cap (default 25 MB) so a multi-MB file fails fast locally before a wasted upload + provider charge. | `validateUploadSize` — within limit, empty rejected, over-cap rejected |
| 896 | cli/cli-helpers.ts `chatMessageArgsWithSeparator` | Support a `--` separator that terminates flag parsing so `chat -- -5 degrees` is preserved verbatim (leading-dash words no longer dropped). | `chatMessageArgsWithSeparator` — drops flags pre-`--`, verbatim post-`--`, combined |
| 845 | cli/cli-helpers.ts `resolveLowBalanceThreshold`,`DEFAULT_LOW_BALANCE_USD`; bin low-balance banner | Make the `<$5` threshold configurable via `AIGW_LOW_BALANCE_USD` (non-numeric/≤0 ignored); banner text reflects the resolved value. | `resolveLowBalanceThreshold` — default, override, ignore bad |
| 815 | cli/cli-helpers.ts `isStdoutTarget` | Detect `-o -` → stdout target (helper ready for tts/image/speech to stream bytes to a pipe). | `isStdoutTarget` — `-` true, path/undefined false |
| 802 / 818 | cli/cli-helpers.ts `shouldSuppressDecorative` | Single predicate for suppressing decorative output (spinners, "saved" lines, low-balance banner): true on `--quiet`/`-q`, `NO_COLOR`, or non-TTY. | `shouldSuppressDecorative` — suppress on quiet/NO_COLOR/non-TTY, keep on TTY |
| 826 | src/sdk/types.ts `GatewayError`; src/sdk/client.ts `parseGatewayErrorBody` + `fetch` error path | Add optional `code`/`retryable` to the SDK `GatewayError` (backward-compatible ctor) and populate them from the gateway error body so callers branch on `CREDIT_EXHAUSTED` vs `PROVIDER_TIMEOUT` instead of HTTP status. | `parseGatewayErrorBody` (pure) + live `GatewaySDK` HTTP-402 attaches `code='CREDIT_EXHAUSTED'`, `retryable=false` |
| 836 | src/sdk/client.ts `validatePollOptions`; `waitForGpu` | Validate/normalize `waitForGpu(pollIntervalMs, timeoutMs)` — a `0` interval no longer busy-loops; non-finite timeout clamps to default. | `validatePollOptions` — passthrough, clamp 0/negative interval, clamp NaN/Infinity timeout |
| 829 | src/sdk/client.ts `classifyGpuPollState`; `waitForGpu` | Apply a grace window to an early `idle` status (mirrors the CLI's `i>2`): transient for the first 2 polls, only "cancelled" if it persists. Other in-progress statuses keep waiting. | `classifyGpuPollState` — ready/error immediate, early-idle wait, persistent-idle cancelled, in-progress wait |

## New / changed pure helpers

**`cli/cli-helpers.ts`** (extended): `parseTopLevelFlag`, `detectUnknownFlags`,
`parseOffersSort`, `sortOffers`, `sumBurnRate`, `resolveKeySource`, `maskKey`,
`KEY_ENV_PRECEDENCE`, `parseUserIdentity`, `validateGatewayUrl`, `parseHttpError`,
`formatHttpError`, `overwriteDecision`, `validateUploadSize`,
`chatMessageArgsWithSeparator`, `resolveLowBalanceThreshold`, `isStdoutTarget`,
`shouldSuppressDecorative` (+ `MAX_AUDIO_UPLOAD_BYTES`, `DEFAULT_LOW_BALANCE_USD`).
All dependency-free, no `process.exit`/console — callers decide output/exit.

**`src/sdk/client.ts`** (new exports): `parseGatewayErrorBody`, `validatePollOptions`,
`classifyGpuPollState` — exported so they're testable without instantiating the client
or hitting the network.

## Wiring summary (bin/ai-gateway.ts)

- Top-level `--version`/`-v`/`-h` dispatch added before per-command help (#804).
- `cmdGpuList` prints the aggregate burn footer (#843).
- Low-balance banner reads `AIGW_LOW_BALANCE_USD` (#845).
- `cmdGpuOffers` accepts `--sort` and uses `sortOffers` (#852).
- `fetchJSON` surfaces structured `code`/`retryable` via `parseHttpError`/`formatHttpError` (#898/#826).

The remaining new helpers (`detectUnknownFlags`, `resolveKeySource`/`maskKey`,
`parseUserIdentity`, `validateGatewayUrl`, `overwriteDecision`, `validateUploadSize`,
`chatMessageArgsWithSeparator`, `isStdoutTarget`, `shouldSuppressDecorative`) are
exported and unit-tested; they are ready for per-command adoption but were left
un-wired in this pass to keep the `bin` diff minimal and low-risk (each requires
touching multiple command sites and their `console`/`process.exit` flow). They are
the safe, tested building blocks for that follow-up.

## Deferred (and why)

**Packaging / public surface — require forbidden files** (`package.json`, `tsup.config.ts`,
`src/index.ts`, `src/modules/**`):
- **#866 / #867** — point `main`/`types`/`exports` at built `dist` instead of raw `src`.
  Needs `package.json`. **Recorded as deferred per task brief.**
- **#864 / #865 / #868 / #872 / #873 / #870** — collapse `src/` vs `src/modules/`, restrict
  the `./*` wildcard, slim the root barrel, add `engines`/`packageManager`, stable `/sdk`
  subpath. All touch forbidden packaging files.

**Cross-SDK consolidation — out of owned paths / L-effort breaking change** (`sdk/node/**`,
`sdk/python/**`):
- **#821 / #822 / #825** — unify the three SDK clients + three `GatewayError` classes (needs ADR).
- **#828 / #875–#885** — TS↔Python parity (PipelineTiming per-stage fields, N-way race, ensemble
  `llm_correct`, sync client, shared DTO generation). Touch `sdk/node/**` / `sdk/python/**`.

**SDK feature work — broader surface, deferred to keep batch minimal:**
- **#831 / #840 / #834 / #838 / #832 / #835 / #837** — `chatStream()` async-iterator, public
  `AbortSignal` threading, circuit breaker, typed Prometheus parsing, pagination iterators,
  typed `Record<string,unknown>` returns, `requestId`. M/L effort.

**Server-side dependency — out of owned surface** (`server/**`):
- **#841 / #848 / #853** — preflight cost estimate + confirmation, idle-policy reminder,
  `--dry-run` on `gpu deploy`. Need `/v1/gpu/preflight` orchestration in `server/`. The
  client-side cost cap (#842) shipped in wave 1.
- **#813 / #844 / #850 / #851** — live `voices` fetch, dedicated `cost` command, registering /
  generalizing the cost-audit binary across providers. Span server/orphan-sweep + `package.json`.

### Note on backward compatibility
`GatewayError`'s constructor gained two **optional trailing** params (`code`, `retryable`);
all existing call sites (4-arg) are unaffected. `waitForGpu`'s public signature is unchanged —
only its internal handling of poll params and early `idle` tightened (a deploy briefly reporting
`idle` at the start is now tolerated for 2 polls instead of throwing "Deploy cancelled").
