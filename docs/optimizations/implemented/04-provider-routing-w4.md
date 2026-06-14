# Wave 4 — Provider Routing & Caching Optimizations (implemented)

Continuation of waves 1–3 from [`docs/optimizations/04-provider-routing-caching.md`](../04-provider-routing-caching.md).
All changes are SAFE, LOCALIZED, and unit-tested (no network / real API / GPU).

Tests: [`__tests__/opt/04-provider-routing-w4.test.ts`](../../../__tests__/opt/04-provider-routing-w4.test.ts)
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/04-provider-routing-w4.test.ts`
Result: **35 tests, all passing.** Waves 1–3 area-04 tests (109) still green.

## Implemented

| ID | Optimization | Lens | File(s) | Approach |
|----|--------------|------|---------|----------|
| 314 | Image route swallows provider 4xx into 500 | Usability | `src/gateway/proxy/routes/images.ts` | Preserve the original `err.status` (4xx/5xx) on the response instead of defaulting to 500 so clients can fix bad requests. |
| 329 | Image generation has zero caching | Cost | `src/gateway/proxy/routes/images.ts` | LRU cache (1h TTL, 100 entries) keyed on `prompt+model+size+steps+seed`; only **seeded** (deterministic) requests are cached. Pure `imageCacheKey` / `isImageCacheable` helpers. |
| 330 | STT cache drops verbose_json payload | Functionality | `src/gateway/proxy/routes/audio-transcriptions.ts` | Cache the **full** `STTResponse` (not just `text`); new pure `buildTranscriptionBody` returns segments/words/language/duration for `verbose_json` hits. |
| 331 | Embedding cache keyed on whole array / caches partial | Cost | `src/gateway/proxy/routes/embeddings.ts` | Per-input caching: look up each string individually, embed only the miss subset, merge back. `assembleEmbeddings` throws on a truncated provider response (never caches a partial). |
| 334 | `ResponseCache.buildKey` non-deterministic for nested objects | Functionality | `src/caching/response-cache.ts` | New `stableStringify` recursively sorts object keys at every depth (arrays keep order); equivalent requests (e.g. reordered tool-schema keys) now share a cache entry. |
| 340 | Dynamic model catalog fetched every `/v1/models` call | Cost | `src/gateway/proxy/routes/models.ts` | New `ModelCatalogCache` (5-min TTL memo per provider) with stale-on-error fallback; injected default + optional override. |
| 370 | Minimax / self-hosted "stream" methods don't stream | Cost | `src/gateway/providers/cloud/minimax/index.ts`, `.../self-hosted/self-hosted-provider.ts` | `chunkAudioBuffer` / `bufferToChunkedStream` emit a fully-buffered payload in 16KB chunks for real incremental delivery instead of one giant chunk. |
| 376 | Image route bypasses retry/fallback | Reliability | `src/gateway/proxy/routes/images.ts` | Wrap `provider.generate` in `withProxyRetry` so transient 5xx are retried with backoff + cooldown like other proxy routes. |
| 378 | Self-hosted STT hardcodes `verbose_json` | Functionality | `.../self-hosted/self-hosted-provider.ts` | New pure `resolveSelfHostedSttFormat` honors requested `srt`/`vtt`/`json`/`text`, defaulting to `verbose_json` only when unset/unknown. |
| 382 | Provider warmup probes only Groq + OpenAI | Cost | `src/gateway/providers/cloud/warmup-keys.ts`, `server/provider-warmup.ts` | `buildWarmupKeys` includes every configured cloud provider (Fireworks/OpenRouter/Deepgram/ElevenLabs) so first-fallback requests don't pay a cold handshake. |
| 383 | Warmup fires every 60s regardless of traffic | Cost | `src/gateway/providers/cloud/warmup-keys.ts`, `server/provider-warmup.ts` | `shouldRunWarmupCycle` skips cycles after an idle backoff window (default 10 min) on a dormant gateway, but always probes a deployed GPU pod. |
| 398 | `registry.getAllModels` reports LLM as single pseudo-model | Usability | `src/gateway/providers/cloud/registry.ts`, `.../types.ts` | Optional additive `ProviderDescriptor.llmModels` catalog; `getAllModels('llm')` enumerates it when present, else falls back to the legacy one-entry-per-provider behavior. |

12 findings implemented.

## Notes

- **#382/#383**: the pure helpers live in a new `src/gateway/providers/cloud/warmup-keys.ts` so they are unit-testable without importing `server/provider-warmup.ts`'s heavy module graph (GPU clients, state, registries). `server/provider-warmup.ts` imports + re-exports them and wires them to its runtime singletons.
- **#370**: `bufferToChunkedStream` is shared — `minimax` defines it and `self-hosted` imports it (no circular dependency; minimax imports only `../types`).
- **#398**: `llmModels` is optional and additive, so existing descriptors that don't set it keep the previous single-pseudo-model behavior (backward compatible). Wiring the actual catalogs into `server/providers.ts` registration is deferred (outside the localized scope and the LLM-model catalogs already exist per provider).

## Deferred

Higher-blast-radius or already-handled items intentionally left for a later wave:

| ID | Reason deferred |
|----|------------------|
| 302 | `allCooledDown` already excludes credit-blocked (pre-filtered out of `iterChain`) and circuit-OPEN is checked independently of the cooldown bypass; remaining risk is marginal and would need careful re-ordering of the executor. |
| 303 | Sub-second `Retry-After` in-provider wait requires changing the 429 move-on control flow in `withProviderFallback` — higher blast radius across the hot path. |
| 306 | Success-rate floor in `rankChain` touches core ranking math used by every fallback; needs broader validation. |
| 310 | Real cross-provider chains for STT/TTS/embeddings/images require threading the provider chain through every proxy route + server wiring (signature changes). |
| 316, 317, 318, 319, 321, 322, 323, 325 | Streaming fallback / coalescing / per-attempt semaphore changes in `chat-completions.ts` are stateful and concurrency-sensitive — not localized. |
| 327 | Cache-key-on-requested-model vs store-usedModel in chat-completions touches the streaming/non-streaming cache flow. |
| 339, 341 | STT-cache eviction structure / `_keyMeta` lifetime tie — low impact; current eviction already prefers expired entries. |
| 342, 349, 352, 354, 356 | Wiring circuit breaker / real TTFAC / consolidating latency systems into `ai-client.ts` + `server/providers.ts` is cross-module and stateful. |
| 357, 362 | Integrating percentage routing + canary feedback into live request paths needs config + route wiring. |
| 364, 365, 366, 367, 368, 369, 371, 375, 390, 397 | Already implemented in waves 1–3. |
| 372, 373, 374, 377 | Provider-client timeout marking / client-cache reuse / Groq TTS language gate touch live provider call paths; deferred for a focused provider-client wave. |
| 379, 380, 381, 384, 385 | Server-side proxy route matching, fallback-module injection, and chain registration require `server/ws-server.ts` / deeper `server/providers.ts` changes (outside this localized batch). |
| 386–389, 391, 395, 399 | Already implemented in waves 1–3. |
| 392, 393, 394, 396, 400 | Large structural refactors (`src/modules/` de-dup, lazy registry adoption, breaker consolidation, hoisting shared trackers) — out of scope for a safe/localized wave. |
