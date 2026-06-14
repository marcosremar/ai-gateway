# Implementation Progress — toward all 1000 optimizations

> Living tracker for implementing the 1000 audited optimizations
> (see [`1000-OPTIMIZATIONS.md`](../1000-OPTIMIZATIONS.md) and
> [`optimizations/`](./)). Updated each wave. Every implemented item ships with
> a unit test under `__tests__/opt/` and must keep the build green
> (no new `tsc` errors vs. the documented baseline; full opt suite passing).

## How implementation is verified

- **Tests:** `bunx vitest run --config vitest.opt.config.ts` (deterministic
  harness; `__tests__/opt/**`).
- **Types:** `bun run typecheck` — gate is **no new errors** vs. the 22-error
  pre-existing baseline (the work so far reduced this to **11**, adding none).
- **Isolation:** each domain has a disjoint file-ownership set so parallel
  implementation agents never collide.
- **Honesty rule:** behavior-changing / cross-cutting items are implemented only
  where safe; otherwise recorded as **Deferred (with reason)** — never faked.

## Status snapshot

| Metric | Value |
|--------|-------|
| Distinct audit IDs implemented + tested | **273 / 1000** |
| Opt unit tests passing | **680** |
| Opt test files | 22 |
| Typecheck errors | 11 (baseline 22; **0 new**, 11 fixed) |
| Waves complete | Wave 1 (all 10 domains) · Wave 2 (all 10 domains) |

### Per-domain coverage (distinct IDs implemented & tested)

| Domain | Range | Done | Tests | Waves |
|--------|-------|-----:|------:|-------|
| 1 Core AI Pipeline | 1–100 | 27 | 19 | 1, 2 |
| 2 GPU Deployment | 101–200 | 26 | 28+ | 1, 2 |
| 3 Autoscaling | 201–300 | 37 | 31+ | 1, 2 |
| 4 Provider Routing | 301–400 | 38 | — | 1, 2 |
| 5 WebSocket/Realtime | 401–500 | 27 | 68 | 1, 2 |
| 6 Observability/Cost | 501–600 | 30 | 45 | 1, 2 |
| 7 Security/Auth | 601–700 | 21 | 67 | 1, 2 |
| 8 Storage/State | 701–800 | 28 | 49 | 1, 2 |
| 9 CLI/SDK/DX | 801–900 | 26 | 88 | 1, 2 |
| 10 Web/Build/Infra | 901–1000 | 13* | 68 | 1, 2 |

\* Domain 10's count is low because many of its items are config/Dockerfile/YAML/
Terraform changes that are validated by inspection (no unit test = not counted by
the ID-in-test scan), though the pure-TS logic is tested.

## Highlights implemented (with tests)

- **Cost (economia):** `maxCostUsd` enforcement, cloud per-token spend folded into
  the real daily budget gate (#528), atomic spend accounting (#552), idle-timeout
  floor, predictive-warmup moving average, snapshot model-hash reuse, shutdown
  flush of spend/cooldowns, GPU-cost-audit stopped-pod estimate.
- **Reliability:** ensemble STT AbortSignal + deterministic Jaccard consensus,
  head-start race fix, WebSocket backpressure + byte-accurate guards, `.unref()`
  on background timers, DB transaction for probe writes, profile-write mutex,
  EventBus O(1) ring buffer, pg-driver reconnect-retry.
- **Security:** guardrail SSRF blocklist + body cap, finite-number/filename/
  control-char validation, vault key validation + corruption detection, COOP/CORP
  headers, per-key-quota parsing (primitives correct + tested; live wiring deferred).
- **Observability:** real Prometheus summary quantiles, percentile-math fixes,
  metric cardinality caps, cost-anomaly detection (idle-GPU waste, realtime est.),
  SLO derivation from `DAILY_BUDGET_USD`.
- **DX:** bounded chat schema, SDK retry/timeout config + `waitForGpu`, exit-code
  classification, `--max-cost-usd`/`--json`/`--version`, structured error codes,
  Blackwell image-tag mapping, pinned GitHub Action SHAs, tolerant feature flags.

## Deferred-by-design (require explicit decisions, not silent fakes)

Tracked in each per-domain `implemented/*.md` "Deferred" section:

1. **`src/modules/` dedup (~80k-LOC mirror)** — large, risky, inherently sequential
   refactor; prerequisite for packaging/tree-shaking. Dedicated branch + review.
2. **Wiring dead security middleware into the live path** (RBAC, CSRF, per-key
   rate limiting, DLP enablement, Recall webhook registration) — behavior-changing,
   needs server-owner coordination. Primitives are correct + unit-tested.
3. **Packaging** (`package.json` `main`/`types`→`dist`, `@parle` naming, exports) —
   editing root build files mid-wave breaks other agents; maintainer pass.
4. **GPU-token / vault crypto-contract changes** — alter signed payloads / on-disk
   blob formats; need migration + pod-image coordination.
5. **Large streaming rewrites** (Node→Bun response adapter / chat SSE) and
   server hot-path metrics scrape — not safely additive; focused task.
6. **Cross-module cost-model reconciliation** and DB query-shape/schema/index
   rewrites — need an ADR + broad call-site edits.

## Plan to continue

- **Waves 3+:** each domain agent implements its next batch of safe, localized
  items with tests, in ~5-agent batches to stay under rate/session limits. Commit
  each wave; refresh this tracker.
- **Terminal state:** every audit ID is either (a) implemented with a passing
  test, or (b) listed as deferred-by-design with a reason — reconciling to 1000.

_Last updated: 2026-06-14, after Wave 2 (all 10 domains)._
