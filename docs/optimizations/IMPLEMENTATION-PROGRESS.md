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
  pre-existing baseline (wave 1 actually reduced this to 11).
- **Isolation:** each domain has a disjoint file-ownership set so parallel
  implementation agents never collide.

## Wave 1 — complete (committed)

8 domains committed with tests; 2 domains (4, 10) finishing tests.

| Domain | Tests | Sample audit IDs implemented | Status |
|--------|------:|------------------------------|--------|
| 01 Core pipeline (STT→LLM→TTS) | 19 | #4 ensemble AbortSignal, #5 Jaccard consensus fold, #29 adaptive max-tokens, #19-24 hallucination filter, #81/#85 | ✅ committed |
| 02 GPU deployment | 28 | #105 maxCostUsd, #122, #137/#138, #181 SSH port, #186, #190, #196 | ✅ committed |
| 03 Autoscaling | 31 | #201 idle floor, #239 crash-recovery `>=`, #261-267, #266 setTimeout restore, #280 | ✅ committed |
| 04 Provider routing | _adding tests_ | #1 race fix, #328 TTS cache, #347/#348, #364 chat params, #379 | ⏳ in progress |
| 05 WebSocket/realtime | 23 | #418-421 backpressure, #432/#433, #469 SSRF test, #475 ingress guard | ✅ committed |
| 06 Observability/cost | 24 | #513/#514/#515 percentiles, #528 cloud→budget gate, #552 atomic spend, #590 Prom quantiles, #580/#582 | ✅ committed |
| 07 Security/auth | 38 | #648 vault key, #651 guardrail SSRF, #667/#670 validation, #684, #699 COOP/CORP | ✅ committed |
| 08 Storage/state | 21 | #701/#702/#705, #711/#712 shutdown flush, #717-719, #721 txn, #770/#771 mutex | ✅ committed |
| 09 CLI/SDK/DX | 31 | #662-664 bounded schema, #805/#807/#808 exit codes, #827/#833 SDK retry, #842 --max-cost-usd | ✅ committed |
| 10 Web/build/infra | _adding tests_ | #940 hidden-tab polling, #942 shared WS, #976/#977 hf_xet+prebake, #993 token, CORS | ⏳ in progress |

**Wave 1 tally:** 216 opt tests passing · typecheck 11 errors (−11 vs baseline, 0 new) · ~100 audit items implemented with tests.

## Deferred-by-design (require explicit decisions, not silent fakes)

These recur across the audit and are **not** safe to land via parallel agents;
each is tracked in the per-domain `implemented/*.md` "Deferred" sections:

1. **`src/modules/` dedup (~80k LOC mirror).** Large, risky, inherently
   sequential refactor; prerequisite for packaging/tree-shaking fixes. Needs a
   dedicated branch + review.
2. **Wiring dead security middleware into the live request path** (RBAC, CSRF,
   per-key rate limiting, DLP enablement, Recall webhook registration).
   Behavior-changing; needs server-owner coordination. Primitives are now
   correct + unit-tested; only the wiring is deferred.
3. **Packaging** (`package.json` `main`/`types`→`dist`, `@parle` vs `@ai-gateway`,
   exports conditions) — editing root build files mid-wave breaks other agents;
   reserved for a maintainer pass.
4. **GPU-token / vault crypto-contract changes** — change signed payloads /
   on-disk blob formats; need migration + coordination with the pod image.
5. **Large streaming rewrites** (Node→Bun response-adapter / chat SSE) — not
   safely additive; scheduled as a focused task.

## Plan to continue

- **Waves 2+:** each domain agent implements its next batch of safe, localized
  High/Med-impact items with tests, run in smaller concurrent batches (~5
  agents) to stay under the rate limit. Commit each wave; update this tracker.
- **Terminal state:** every audit ID is either (a) implemented with a passing
  test, or (b) listed here as deferred-by-design with a reason. Reconciles to
  1000.
