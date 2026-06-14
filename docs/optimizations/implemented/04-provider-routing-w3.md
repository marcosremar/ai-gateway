# Provider Routing & Caching — Wave 3 (implemented)

Continuation of waves 1–2. All changes are SAFE, LOCALIZED, additive (new
options/methods/helpers; existing call sites and signatures stay
backward-compatible). Strictly within owned scope (`src/providers/*` excluding
dlp/guardrails, `src/proxy/`, `src/lazy-provider/`, `src/caching/`,
`src/caching-layer/`, `src/gateway/providers/`, `src/gateway/routing/`,
`src/gateway/proxy/`, `server/providers.ts`, `server/race-providers.ts`,
`server/provider-warmup.ts`). No `src/modules/**`, no `src/index.ts`, no config.

Tests: `__tests__/opt/04-provider-routing-w3.test.ts` (41 tests, all pass).
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/04-provider-routing-w3.test.ts`

## Implemented (14 findings)

| ID | Finding | File | Change |
|----|---------|------|--------|
| 308 | Cooldown key omits endpoint for distributed profiles | `src/gateway/providers/cloud/fallback.ts` | `cooldownKey` now exported and appends `@<endpoint>` when set, so one dead pod no longer cools down the healthy pod sharing the same provider/model. Backward compatible (no endpoint → `provider:model`). |
| 313 | Diversifier only appends to the tail | `src/gateway/providers/cloud/chain-diversifier.ts` | New `insertPosition: 'tail' \| 'early'` option. `'early'` inserts cross-family backup at index 1 so true family diversity is reached after the primary, not worst-case last. Default unchanged (`tail`). |
| 320 | Standalone `coalesce()` keeps failed promise visible until finally | `src/gateway/proxy/middleware/request-coalescer.ts` | Switched from `.finally` to eager `.then/.catch` release with a settled-guard, so a rejecting promise frees its map slot immediately instead of holding late callers on a dying promise. |
| 324 | Coalescing disabled for any non-zero temperature, even deterministic seeds | `src/gateway/proxy/middleware/request-coalescer.ts` | `buildKey` now coalesces `temperature>0` when a fixed `seed` is present (deterministic providers), while still refusing `n>1`. |
| 333 | `withCache` default condition only caches temperature 0 | `src/caching/with-cache.ts` | New exported `deterministicEnoughCondition(maxTemperature=0.3)` factory so high-hit-rate low-temp routes can opt into caching via `WithCacheOptions.condition`. |
| 335 | LRU `accessOrder` array is O(n) per get/set | `src/caching/response-cache.ts` | Replaced the `string[]` + `indexOf`/`splice` recency list with an insertion-ordered `Map` (`_touch` = O(1) delete+set; LRU key = `keys().next().value`). Eviction, overwrite size-accounting, and invalidation all preserved. |
| 344 | Adaptive timeout records timeout-ceiling as the latency sample | `src/gateway/providers/cloud/adaptive-timeout.ts` + `fallback.ts` | New `recordTimeout()` records a penalized (0.75× cap) **failure** sample instead of the ceiling, so timeouts no longer ratchet future timeouts upward. Wired into fallback's timeout branch. |
| 346 | No success-rate floor in adaptive timeout | `src/gateway/providers/cloud/adaptive-timeout.ts` + `fallback.ts` | `record()` gains an optional `success` flag; `getTimeout` computes p95 over successful samples only (falls back to all samples below `minSamples`). Fallback now records failures with `success=false`. Default `true` keeps existing callers working. |
| 363 | Canary success/error feedback loop absent | `src/gateway/providers/cloud/percentage-routing.ts` | New pure `applyCanaryFeedback(routes, errorRateOf, {tolerance, killThreshold})` linearly shrinks a route's weight as its error rate rises and zeroes it past the kill threshold; no-data routes untouched. |
| 371 | Provider error normalization inconsistent (status vs message-embedded) | `src/gateway/providers/cloud/provider-error.ts` (new) + `deepgram/index.ts` | New `makeProviderError`/`normalizeProviderError`/`extractStatus`/`hasStatus` give every REST provider a real numeric `.status`. Deepgram's `throw new Error("HTTP …")` replaced with `makeProviderError('deepgram', status, …)`. |
| 386 | Batch detector only logs opportunities, never batches | `src/gateway/providers/cloud/batch-detector.ts` | New `drainBatchableGroups(tenant)` returns language-grouped batches at/above threshold and removes them from the window (per-tenant); plus pure `groupByLanguage` helper. |
| 391 | Analytics economics figures are hardcoded placeholders | `src/gateway/routing/analytics-service.ts` | New `computeEconomics(input)` derives `openaiSavings`/efficiency from real `gpuCostHour`/`competitorCostHour`/`selfHostedShare`; `buildSystemAnalytics` accepts optional `economics`. Falls back to demo constants when no data supplied. |
| 395 | `lazy-provider` uses `factory.name` (minified/anonymous = blank) | `src/lazy-provider/index.ts` | `createLazyProvider(factory, name?)` and `register(name, factory)` now log an explicit label (`name → factory.name → 'anonymous'`), eliminating "Lazy-loading provider undefined". |
| 399 | `AIProviderRegistry` has no `unregister` | `src/gateway/providers/cloud/registry.ts` | New `unregister(id)` removes the id from descriptor, embedding, and rerank maps so calls are skipped (not failed at runtime) after a key is removed. |

## Deferred (and why)

| ID | Finding | Reason deferred |
|----|---------|-----------------|
| 302 | `allCooledDown` bypass ignores credit-block/circuit state | Touches the hot iteration path in `fallback.ts` runWithFallback; needs careful interaction with the existing `availableChain`/`creditBlockedProviders` filtering — risk of changing live routing behaviour. |
| 303 | 429 never retries even when `Retry-After` sub-second | Adds in-provider waiting to the fallback loop (timing/async behaviour) — not safely unit-testable without faking timers across the whole loop. |
| 306 | Performance-ranked chain can starve a 100%-success provider | Requires reworking `rankChain` scoring weights; behavioural, higher risk. |
| 310/314/316 | Cross-provider fallback / status passthrough in proxy routes | Live proxy route wiring (`chat-completions.ts`, `retry.ts`) — broader than localized, integration-shaped. |
| 317/318/319/321/322/323/325 | Coalescing/semaphore correctness & streaming tee | Deep changes to the proxy concurrency path; risky and integration-level. |
| 327/329/330/331/339/340 | Per-route cache keying / image+STT caching / models cache | Live route handlers (`audio-transcriptions`, `images`, `embeddings`, `models`) — integration wiring. |
| 334/335-Map-for-caching-layer | Stable stringify; further LRU work | `#334` stable stringify is a correctness change to key generation already partially mitigated; deferred to avoid cache-key churn. |
| 341 | keyMeta lifetime tied to entry lifetime | Already bounded in wave-1/2; deeper coupling deferred. |
| 342/347/348/352/354/356/380 | Wire circuit-breaker / cost-ranker / TTFAC / persistence into proxy & server | Server/proxy wiring across modules — out of "localized" remit. |
| 349/385 | Real TTFAC measurement | Needs stream-level instrumentation in `ai-client.ts` (out of owned scope). |
| 357/360-followup | Wire percentage routing into request paths | Live route integration. |
| 362/392/393 | `src/modules/` duplication / drift | Explicitly out of scope (`src/modules/**` forbidden). |
| 364/365/366/370/372/373/374/376/377/378 | Provider client param passthrough / timeouts / streaming | Each touches a specific provider SDK call path; several need live-call behaviour. Deferred batch for a focused wave. |
| 379/381/382/383/384 | Proxy path matching / chain registration / warmup | `server/` route + warmup wiring, integration-shaped. |
| 386-actual-provider-batch | Issue real provider batch API calls | Detector now drains groups (`#386` detection→grouping done); the actual upstream batch call is provider-integration work. |
| 394/396/398/400 | Lazy registration wiring / breaker consolidation / per-model `/v1/models` / shared trackers | Server wiring or type-shape changes (`LLMProvider` lacks `getModels`), higher risk. |
