# Provider Routing & Caching — Wave 5 (implemented)

Continuation of waves 1-4. Waves 1-4 already implemented the large majority of
the safe/localized findings in `docs/optimizations/04-provider-routing-caching.md`
(IDs 301-400). This wave picks up the remaining **safe, localized** items that
had not yet been done and adds a unit test for each.

Tests live in `__tests__/opt/04-provider-routing-w5.test.ts` (unit only — mocks
no network; pure exported helpers). Run:

```
bunx vitest run --config vitest.opt.config.ts __tests__/opt/04-provider-routing-w5.test.ts
```

Result: **5 fixes, 20 tests, all passing.**

## Implemented

| ID | Optimization | Lens | Location | What changed |
|----|--------------|------|----------|--------------|
| 302 | `allCooledDown` bypass ignores credit-block / circuit state | Reliability | `src/gateway/providers/cloud/fallback.ts` | New pure helper `computeAllCooledDown(chain, isCoolingDown, isViable)`. The "all providers cooling down → retry them anyway" bypass now only fires when ≥1 cooled-down provider is genuinely viable (not credit-blocked, not circuit-OPEN). `withProviderFallback` passes credit-block + non-mutating `getStats().state==='open'` as the viability predicate, so it no longer loops over guaranteed-fail providers. |
| 372 | openai-compat timeout AbortError rewrapped without status/marker | Reliability | `src/gateway/providers/cloud/openai-compat/openai-compat-llm.ts` | New exported `markTimeout(err)` tags the error with the shared `Symbol.for('__parle_fallback_timeout')` marker (matches `fallback.ts`) and sets `status = 408`. Both `chat()` and `chatStream()` timeouts are now marked, so `isTimeoutError()`/status classification treats them as move-on-immediately timeouts instead of opaque errors. |
| 373 | OpenAI STT/TTS construct fresh clients instead of client-cache | Cost | `src/gateway/providers/cloud/openai/openai-stt.ts`, `.../openai/openai-tts.ts` | `getClient()` and `withApiKey()` now route through the shared `getOrCreateClient(OPENAI_BASE_URL, key)`. OpenAI STT + TTS (+ embeddings) sharing a key now reuse one OpenAI client / connection pool instead of each opening its own (extra TLS handshakes on cold start). |
| 374 | Groq default TTS model is English-only in a multilingual pipeline | Functionality | `src/gateway/providers/cloud/groq/index.ts` | New pure predicate `isGroqTtsLanguageCompatible(language, model)`. The English-only `canopylabs/orpheus-v1-english` family is flagged incompatible for non-English targets so a fallback to Groq TTS in a `language:'fr'` chain can be skipped (avoids wrong-language audio). English code/region/name forms and non-English-only models pass. |
| 377 | openai-compat reports zero tokens when provider omits `usage` | Cost | `src/gateway/providers/cloud/openai-compat/openai-compat-llm.ts` | New `estimateTokensFromChars()` (~4 chars/token) + `estimateUsage(messages, completion)` (flattens multimodal text). `chat()` now backfills an estimated usage block when the provider returns none, so cost accounting / budget tracking isn't silently zeroed. |

## Deferred (with reasons)

The **safe pool is effectively exhausted.** Almost every remaining ID is either
(a) already implemented in waves 1-4, or (b) not safe/localized under the
minimal-diff + strict-ownership constraints. Audit summary:

**Already implemented in waves 1-4** (verified present in source, not re-done):
301, 304, 305, 307, 308, 309, 311, 312, 313, 314, 315, 320, 324, 326, 328, 329,
330, 331, 332, 333, 334, 335, 336, 337, 338, 340, 343, 344, 345, 346, 347, 348,
350, 351, 353, 355, 358, 359, 360, 361, 363, 364, 367, 368, 369, 370, 371, 375,
376, 378, 382, 383, 386, 387, 388, 389, 390 (model), 391, 394, 395, 397, 398, 399.

**Deferred — not safe / not localized:**

| ID | Reason deferred |
|----|-----------------|
| 303 | 429 sub-second `Retry-After` in-provider wait — changes hot-path retry timing/latency behavior of `withProviderFallback`; risks regressing existing fallback tests that assert "429 → next provider immediately". Behavioral, not localized. |
| 306 | Performance-ranked chain starving a 100%-success provider — requires reworking `rankChain` scoring semantics; touches ranking that many tests depend on. Not minimal. |
| 310 | Single-provider chain for STT/TTS/embeddings/images — requires threading a real cross-provider chain through `withProxyRetry` and every route signature. Multi-file, signature-changing. |
| 316 / 318 / 319 / 322 | Streaming fallback / streaming coalescing / per-attempt semaphore / per-key fairness — all reshape the chat-completions streaming + concurrency control flow. Large, cross-cutting, high regression risk. |
| 317 / 321 / 327 / 400 | Coalescing/cache keying on "logical request" vs primary provider, hoisting shared trackers — entangled with the chat-completions request lifecycle; partial fixes here would diverge from coalescer/cache invariants. |
| 323 | Semaphore double-count under abort — concurrency-primitive change in `semaphore.ts` with subtle correctness implications; needs dedicated abort-path testing. |
| 325 | STT in-flight coalescing — new coalescer wiring into the audio-transcriptions hot path; behavioral, not a localized helper. |
| 339 | STT cache eviction O(n) scan — current impl already does insertion-order fallback eviction (waves 1-4); remaining "lazy TTL heap" is a perf micro-opt with no functional gain and added complexity. |
| 341 | `_keyMeta` lifetime tie to entry lifetime — already bounded by `maxSize` (waves 1-4); deeper fix needs store-coordinated lifecycle, not localized. |
| 342 / 352 / 380 | Wire circuit breaker / TTFAC tracker into the proxy/pipeline `FallbackOptions` — the *infrastructure* (registry, tracker, fallback support) already exists; wiring requires editing `src/client/ai-client.ts` (outside ownership) and the proxy opts plumbing. Out of scope / not isolated. |
| 349 | TTFAC records total latency as TTFAC — root fix needs real time-to-first-chunk measured in `src/client/ai-client.ts` (outside ownership). |
| 354 / 356 / 396 | Consolidate parallel latency/breaker systems in `server/providers.ts` — large server-side refactor across two abstractions; high blast radius. |
| 365 / 366 | Self-hosted / Ollama `chat()` timeout — already implemented in waves 1-4 (AbortController wired). |
| 373 (embeddings) | OpenAI embeddings client-cache — the dedicated OpenAI embedding provider was not in the touched set this wave; STT+TTS covered, embeddings already use openai-compat base (cached). No additional change needed. |
| 379 | Proxy route matching on full `url` w/ query string — lives in `src/gateway/proxy/server.ts` route table; behavioral routing change better verified with the proxy server harness, not a pure helper. |
| 381 / 384 / 385 | `server/providers.ts` chain registration / reload symmetry / TTFAC `minSamples` — server-wiring changes entangled with startup + reload logic; not minimal/localized. |
| 390 (cost) / 393 | hybrid-router static `estimateCost` constants; src/modules drift audit — pricing-table sourcing is non-trivial and `estimateCost` constants are used by routing tests; modules-drift is an L-effort dedupe (explicitly out of scope). |
| 392 | Delete the 590-file `src/modules/` mirror — L-effort, repo-wide, explicitly excluded by ownership (`src/modules/**`). |

Net: this wave intentionally did **fewer** items (5) at higher confidence, per the
brief — the remaining findings are either done or carry too much blast radius for
the minimal-diff / strict-ownership constraints.
