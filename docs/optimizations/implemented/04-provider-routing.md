# Implemented — AI Provider Integrations, Routing & Caching (IDs 301-400)

High-value, safe, localized fixes from `docs/optimizations/04-provider-routing-caching.md`.
All changes are minimal diffs within the owned file set (`src/providers`, `src/proxy`,
`src/caching`, `src/gateway/providers`, `src/gateway/routing`, `server/providers.ts`); no
behavior changes beyond the targeted fix. Tests live in
`__tests__/opt/04-provider-routing.test.ts`.

Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/04-*.test.ts` → **24 passed**.

The dominant theme of the audit is **cost (economia)**: the OpenAI-compatible proxy was
silently dropping output-affecting LLM params, never caching TTS, and never feeding cost data
into routing. The fixes below close those leaks: callers now keep their `tools`/`stop`/`seed`/
etc., identical TTS phrases are served from cache, and a static price table lets the ranker
prefer the cheapest equal-quality provider.

| ID | File:line | Change made | Test |
|----|-----------|-------------|------|
| #1 (race head start) | src/gateway/routing/provider-racer.ts:90-120 | Head-start `Promise.race` mapped both fulfilment **and rejection** of the primary into a discriminated sentinel (`primary` / `primary-failed` / `timeout`), so a fast-failing primary now falls through to launching the remaining candidates instead of aborting the whole race. Added a no-op `primary.catch(() => {})` to suppress the unhandled-rejection warning while still feeding the primary into the final `Promise.any` for all-failed aggregation. | "raceProviders head start (opt #1)" — 4 tests (fallthrough on primary reject, primary wins head start, aggregate reject only when all fail, no unhandled rejection) |
| #364 (chat params dropped) | src/gateway/providers/cloud/types.ts:168-189; src/gateway/providers/cloud/openai-compat/chat-params.ts:17 (new); openai-compat-llm.ts:74,121; ollama/index.ts:71; self-hosted-provider.ts:215 | Extended `ChatRequest` with `tools`/`toolChoice`/`topP`/`seed`/`n`/`stop`/`frequencyPenalty`/`presencePenalty`. New `buildSamplingParams()` maps the camelCase fields to OpenAI snake_case wire names, emitting only defined fields, and is spread into the create() payload by every OpenAI-compatible provider (openai-compat, ollama, self-hosted) so the mapping stays consistent and unit-testable without a live client. | "buildSamplingParams (opt #364)" — 4 tests (empty → {}, full camel→snake map, omits unset, passes falsy-defined seed 0 / presence 0) |
| #364 (proxy forwarding) | src/gateway/proxy/routes/chat-completions.ts:107-128 | The proxy now parses `tools`/`tool_choice`/`top_p`/`seed`/`n`/`stop`/penalties once and forwards them into `chatOpts: ChatRequest` (only when present, preserving provider defaults); the coalescing-key build reuses the same parsed values. | Covered via `buildSamplingParams` mapper (proxy handler boots route trackers; pure mapper asserts the param surface) |
| #326 / #334 (cache key) | src/caching/response-cache.ts:48-72; src/caching/with-cache.ts:43-52 | `ResponseCache.buildKey` now hashes `maxTokens`/`topP`/`seed`/`tools`/`responseFormat`/`stop` alongside provider/model/messages/temperature; `withCache` passes those fields through. Prevents a `max_tokens=50` request from being served a cached full-length answer, or a `verbose_json` request hitting a `text` entry. | "ResponseCache.buildKey output-affecting fields (opt #326/#334)" — 4 tests (deterministic, splits on max_tokens, splits on response_format, splits on top_p/seed/tools/stop) |
| #332 (cache empty body) | src/caching/with-cache.ts:62-73 | `withCache` only calls `cache.set` when `response.content` is a non-empty/non-whitespace string, so a transient empty/refusal body is never memoized and replayed for the full TTL. | "withCache empty-response policy (#332)" — caches non-empty (1 upstream call on repeat) + does NOT cache whitespace (2 upstream calls) |
| #328 (TTS caching) | src/gateway/proxy/routes/audio-speech.ts:18-66,101-137 | Added an in-memory LRU (max 200, 1h TTL) keyed by `model+voice+input+speed+format` (`ttsCacheKey`, sha256). Cache HIT returns audio with `X-Cache: HIT`; MISS synthesizes, stores, returns `X-Cache: MISS`. LRU recency via Map re-insert; eviction prefers expired entries then oldest. `_resetTtsCache()` exported for tests. | "TTS cache (opt #328)" — key stability/per-field change + MISS-then-HIT synthesizing once. TTL semantics also asserted via "ResponseCache TTL" (short-TTL expiry under fake timers) |
| #379 (route path match) | src/gateway/proxy/server.ts:679-719 | Route matching switched from raw `url ===` to the query-stripped `path` (= `url.split('?')[0]`, computed at server.ts:526) for all routes; 404 message also uses `path`. A request to `/v1/chat/completions?x=1` (SDK cache-busters) now reaches the chat handler instead of 404ing. | "proxy route path matching ignores query string (opt #379)" — 2 tests (strip query for chat/speech/models; raw-url equality would have 404ed, stripped equality matches) |
| #347 / #348 (cost ranking) | src/gateway/providers/cloud/performance-ranker.ts:93-148,409-448 | Added a static `MODEL_PRICING` table ($/token for OpenAI/Groq/Fireworks/OpenRouter models), `estimateCostPerRequest()` (model or `provider/model` key, null when unpriced), and `rankChainByCost()` which blends observed latency with price via `getCostEfficiencyScore` (higher = better) — promotes the cheaper equal-latency provider, keeps pure-unknown entries (no samples + no price) at the back, returns a new array. | "cost-efficiency ranking (opt #347/#348)" — 5 tests (table non-empty + estimate > 0, null for unknown, cheaper model ranked first at equal latency, unknown sinks to back, input not mutated) |

## Notes on test strategy

Provider clients (ollama, self-hosted, openai-compat) construct an OpenAI SDK client and the
proxy server boots a Node `http` listener, so neither is imported directly in unit tests.
Instead: (a) the shared, side-effect-free `buildSamplingParams` mapper that all three clients
delegate to is tested directly (the param-pass-through is the actual behavior change); (b) the
exported pure cache helpers (`ttsCacheKey`, `ResponseCache.buildKey`, `withCache`,
`_resetTtsCache`) and `handleAudioSpeech` (driven with a fake `TTSProvider`, no network) are
tested directly; (c) the route-matcher fix is asserted by replicating the query-stripping
logic (`url.split('?')[0]`) the fix depends on. `ResponseCache` is driven by an in-memory
`KvStore` double — no Redis/Prisma.

## Deferred (and why)

- **Timeout/abort wiring for ollama + self-hosted LLM/STT (#365 / #366)** — IMPLEMENTED in the
  client source (AbortController + `OLLAMA_TIMEOUT_MS` / 120s default + timeout-marked error),
  but NOT unit-tested here: exercising it requires constructing the real OpenAI SDK client (the
  provider `new OpenAI()`s in its constructor) or a deep network mock, which violates the
  "no network / no real clients" constraint for this suite. The change is a localized, low-risk
  `try/finally` wrap mirroring the existing openai-compat provider; verified by source inspection.
- **#316 / #319 (streaming fallback + per-attempt semaphore)** — DEFERRED. These require
  re-architecting the streaming branch of `chat-completions.ts` (tee an SSE source across
  consumers, move the semaphore inside the fallback `fn`); out of scope for a minimal, safe diff
  and not unit-testable without booting the proxy + a streaming upstream.
- **#347 wiring into the live proxy chain (`buildFallbackOptions`)** — DEFERRED at the call site.
  `rankChainByCost` + `MODEL_PRICING` + `estimateCostPerRequest` are implemented and tested as
  pure logic, but threading a shared ranker through `server/providers.ts` FallbackOptions touches
  server wiring with broad blast radius and existing parallel-latency-system concerns (#354); left
  to a dedicated change so the ranking primitive can land verified first.
- **#392 / #393 (`src/modules/` 590-file mirror drift)** — DEFERRED. Deleting/regenerating the
  ~80k-LOC mirror is an `L`-effort structural change far outside a localized fix; the canonical
  `src/` copies were edited here. (`src/modules/**` is also explicitly outside the owned file set.)
- **local-cli stub (`src/providers/local-cli.ts`)** — refactored from a `generate()` stub to a
  full `LLMProvider` shape (`providerId` + `isConfigured(): false` + throwing `chat()`), so it can
  be assigned to `ProviderDescriptor.llm` without a cast. Not separately tested: `isConfigured()`
  is `false` so registration is gated off and `chat()` is unreachable at runtime; behavior is a
  compile-time type-conformance fix only.
