# Implemented — Provider Routing & Caching, WAVE 2 (IDs 301-400)

Second batch of localized, low-risk fixes from
`docs/optimizations/04-provider-routing-caching.md`. All changes are minimal
diffs within the owned file set (`src/providers`, `src/proxy`, `src/lazy-provider`,
`src/caching`, `src/caching-layer`, `src/gateway/providers`, `src/gateway/routing`,
`src/gateway/proxy`, `server/providers.ts`, `server/race-providers.ts`,
`server/provider-warmup.ts`) — `src/providers/dlp.ts` and `guardrails.ts` were
NOT touched. Wave-1 items (#1, #326, #328, #332, #334, #347, #348, #364, #379,
#365, #366) were left untouched.

Tests live in `__tests__/opt/04-provider-routing-w2.test.ts` (separate from the
wave-1 file). Run:
`bunx vitest run --config vitest.opt.config.ts __tests__/opt/04-provider-routing-w2.test.ts`
→ **44 passed**. Wave-1 suite still **24 passed**; existing batch-detector
tests still pass.

The dominant theme remains **cost (economia)** and **reliability**: credit
blocks now apply to hash-less providers (no more guaranteed-fail 402 calls),
the chain diversifier's cross-family STT backup actually works, cold routing
breaks ties by price, OpenAI STT defaults to the cheaper mini model, Deepgram
stops forcing smart-format rewrites, the LRU cache stops evicting fresh entries,
and the circuit breaker no longer gets stuck blocking all probes.

| ID | Lens / Impact | File:area | Change made | Test |
|----|---------------|-----------|-------------|------|
| #358 | Reliability/Med | percentage-routing.ts | New `normalizeRouteWeights()` scales weights to a 100 total; `selectPercentageRoute` normalizes before bucketing so a partial/over allocation no longer biases the last (or unreachable) route. | normalize up/down/zero (3) |
| #359 | Reliability/Low | percentage-routing.ts | Sticky hash now uses 4 bytes (32-bit, ~1e-7 granularity) instead of 2 (1/65535) for smooth fine-grained splits. | deterministic + both buckets reachable |
| #360 | Cost/Med | percentage-routing.ts | New `isAvailable` filter excludes credit-blocked/cooling providers before sticky AND random selection; returns null when all filtered out. | sticky filter, all-filtered null, non-sticky filter |
| #361 | Functionality/Low | percentage-routing.ts | `buildPercentageRoutes` preserves `endpoint` + `metadata` so distributed-profile A/B tests can target pods. | endpoint/metadata preserved |
| #397 / #312 | Functionality/High | classification.ts | Widened `cloud` set to include deepgram/elevenlabs/minimax/fal/zai. Unblocks `buildFallbackChain.addEntry` and the chain diversifier (a deepgram STT stage / cross-family backup was silently dropped). | isCloud widening + deepgram STT stage survives `buildFallbackChain` |
| #301 | Reliability/Med | fallback.ts | Reconciled `DEFAULT_COOLDOWN_MS` (15s) with the JSDoc (was "60_000") and documented the rationale. | omitted cooldownMs → 15s applied |
| #304 | Functionality/Low | fallback.ts | 5xx branch now reuses the already-extracted `moveOnStatus` instead of re-parsing via `is5xxError()` (401/402/403/429 already handled upstream). | 5xx retried in-provider; 429 moves on |
| #305 | Cost/Med | fallback.ts | Credit-block pre-filter + 402 record now use a provider-level sentinel hash (`__provider__`) when no key hash is configured, so hash-less providers are still blocked instead of burning a doomed call. | hash-less 402 blocks + skips on next run |
| #307 | Functionality/Low | fallback.ts | Context-window upgrade is skipped if that provider/model is already later in the chain (no double attempt). | groq/big attempted once, not twice |
| #309 | Usability/Low | fallback.ts | Final tried-vs-skipped log reports credit-blocked entries as skipped (was iterating original chain, mislabeling them "tried"). | covered via #305 skip assertion |
| #311 | Cost/Low | credit-block.ts | `CreditBlockTracker` accepts per-provider TTL overrides (e.g. transient 429-as-402 recovers in 30s vs flat 5min). | per-provider TTL + default-for-others |
| #315 | Reliability/Low | credit-block.ts | `isBlocked` now sweeps expired entries on reads (not only on `recordBlock`), so low-402-volume processes don't leak stale entries / `size`. | size drops to 0 after read sweep |
| #343 | Reliability/Med | circuit-breaker.ts | Added `probeTimeoutMs` deadline: an abandoned HALF_OPEN probe (no record) no longer wedges the breaker — a fresh probe is allowed after the deadline. | abandoned probe → fresh probe after deadline; success closes |
| #345 | Cost/Low | adaptive-timeout.ts | `getTimeout` memoizes the computed p95 timeout keyed on buffer length + 1s TTL; `record`/`clear` invalidate it. Avoids re-sorting the buffer on every per-request read. | stable timeout, recompute after new sample |
| #350 | Reliability/Med | ttfac-tracker.ts | `TtfacSample.success` flag (default true); `getStats` computes percentiles + `sampleCount` over successful samples only, so a fast failure can't rank a broken provider first. | failure excluded from p50/sampleCount |
| #351 | Functionality/Med | ttfac-tracker.ts | `rankByTtfac` front-loads scored (proven-fast) entries ahead of unscored ones (was pinning scored entries to their original slots, so a fast provider couldn't overtake a high-priority cold entry at index 0). | fast promoted past cold; all-failure provider stays back |
| #353 | Usability/Low | performance-ranker.ts | `neutralScoreMs` config option (default 500) so STT/TTS chains can set a sub-300ms stale-decay anchor instead of the hardcoded 500ms. | accepts anchor; fresh fast still ranked first |
| #355 | Reliability/Low | ewma-tracker.ts | `pickBest` accepts an optional `costOf` lookup to tie-break all-cold candidates by cheapest provider instead of array position. | cheapest cold wins; warm beats cold; no-cost keeps order |
| #336 | Reliability/Med | caching-layer/index.ts | `evictOne` now drops an expired entry first, else the true LRU (oldest `lastAccess`) — was LFU-on-accessCount, evicting just-inserted entries before older heavily-used ones. | LRU eviction + expired-first |
| #337 | Cost/Low | caching-layer/index.ts | Added idempotent `startSweep`/`stopSweep` (unref'd interval) to run `evictExpired()` periodically. | sweep clears expired key; idempotent |
| #338 | Reliability/Low | caching-layer/index.ts | `memoize` evicts a rejected async result (`.catch`) and skips caching sync null/undefined — no more replaying a transient failure for the whole TTL. | rejection re-invokes; success cached once; null not cached |
| #367 | Cost/Med | openai/openai-stt.ts | Default STT model → `gpt-4o-mini-transcribe` (was the priciest `gpt-4o-transcribe`). Extracted `resolveOpenAISttModel()` pure helper. | default mini, explicit override honored |
| #368 | Functionality/Med | deepgram/index.ts | Word-timestamps no longer toggle the unrelated `punctuate` knob (Nova returns words natively). Extracted `buildDeepgramParams()` pure helper. | punctuate not set on wordTimestamps |
| #369 | Functionality/Low | deepgram/index.ts | `smart_format` is opt-in via `STTRequest.smartFormat` (was forced on, rewriting numbers/dates and breaking term matching). | off by default, on when opted-in |
| #375 | Usability/Low | openai/openai-tts.ts | Unknown voice now warns + flags `wasRemapped` instead of silently substituting. Extracted `resolveOpenAIVoice()` pure helper. | remap flag set for unknown, clear for known/unset |
| #387 | Reliability/Low | batch-detector.ts | Replaced module-global array with a per-tenant `BatchDetector` class (bounded window, no hot-path `console.log`); kept backward-compatible function API. | per-tenant isolation + aggregate total |
| #388 | Cost/Low | cloud-health.ts | Deepgram health probe → `/v1/auth/token` (lighter than `/v1/projects`). | (config change; verified by source + #389 test path) |
| #389 | Usability/Low | cloud-health.ts | Added elevenlabs/minimax/fal health endpoints + their auth-header formats so configured providers aren't permanently "unknown". | covered by type-check + source |
| #390 | Cost/Med | hybrid-router.ts | Non-speech Groq default model → `llama-3.3-70b-versatile` (was decommissioned `mixtral-8x7b-32768`). | source assertion (no decommissioned default) |

## Test strategy

Provider clients (`openai-stt`, `openai-tts`, `deepgram`) construct an OpenAI
SDK client or do a live `fetch` at call time, so they are not driven directly.
Instead the behavior changes were extracted into **pure, side-effect-free,
exported helpers** (`resolveOpenAISttModel`, `resolveOpenAIVoice`,
`buildDeepgramParams`) that are unit-tested without any network. Everything else
(`fallback`, `credit-block`, `circuit-breaker`, `adaptive-timeout`,
`ttfac-tracker`, `performance-ranker`, `ewma-tracker`, `percentage-routing`,
`caching-layer`, `batch-detector`, `chain-builder`/`classification`) is a pure
class or function tested directly with injected test doubles and fake timers —
no Redis/Prisma/HTTP. The hybrid-router default-model fix (#390) is asserted by
reading the source (the routing path can't be exercised without its DI deps).

`withProviderFallback` tests inject fresh `CooldownTracker`/`CreditBlockTracker`
instances and a silent logger so they never touch module-level state or the
console. All edited source files + the test file pass `tsc --noEmit --strict`.

## Deferred (and why)

- **#302 / #303 / #306 (allCooledDown viability filter, sub-second 429 in-provider
  wait, ranking starvation)** — DEFERRED. These change live fallback *behavior*
  (when to retry vs escalate) with broad blast radius on real-time routing; the
  brief calls out behavior-changing routing work as skip-and-defer. The
  primitives they build on (credit-block, cooldown) were hardened here instead.
- **#310 / #316 / #317 / #318 / #319 / #325 (cross-provider fallback for
  STT/TTS/embeddings, streaming fallback, per-attempt semaphore, stream/STT
  coalescing)** — DEFERRED. All require re-architecting the proxy route handlers
  (`retry.ts`, `chat-completions.ts`, `audio-*`) and are not unit-testable
  without booting the Node proxy + a streaming upstream. Wiring intelligence into
  the live proxy path is explicitly out of scope for a minimal diff.
- **#327 / #329 / #330 / #331 / #339 / #340 (LLM/STT/TTS/image/embedding cache
  keying + dynamic-model cache)** — DEFERRED. These live in the proxy route
  handlers (`audio-transcriptions.ts`, `images.ts`, `embeddings.ts`,
  `models.ts`) which the proxy boots a listener for; the cache *primitives*
  (`ResponseCache`, `withCache`, TTS LRU) were already covered in wave 1.
- **#335 / #341 (Map-based O(1) LRU for `ResponseCache`, key-meta lifetime)** —
  DEFERRED. Reworking `ResponseCache.accessOrder` to an insertion-order Map is a
  larger structural change to a hot path with subtle invalidation interplay;
  left for a dedicated, separately-reviewed change.
- **#334 stable-stringify for `ResponseCache.buildKey`** — DEFERRED. Wave 1
  already claims #334 coverage (deterministic key for identical params); swapping
  `JSON.stringify` for a stable stringifier is a behavior change to the shared
  cache key that risks invalidating wave-1's existing entries — out of scope here.
- **#342 / #352 / #354 / #356 / #380 / #381 / #382 / #383 / #384 / #385 / #386 /
  #391 (proxy/server wiring of circuit-breaker/TTFAC/ranker, warmup, batching,
  analytics economics)** — DEFERRED. All touch `server/providers.ts` /
  `server/provider-warmup.ts` wiring with broad blast radius (parallel-latency-
  system concerns, #354) and aren't unit-testable without the server. The
  brief flags "wiring intelligence into live proxy" as skip-and-defer. The
  underlying primitives (cost ranking, neutral anchor, probe deadline) landed
  verified here so the wiring can follow safely.
- **#344 / #346 (adaptive-timeout: penalize timeout sample, exclude failures from
  percentile)** — DEFERRED. The fallback already records `elapsed` (not the
  ceiling) for non-timeout failures and `PerformanceRanker` already excludes
  failures; tightening the *adaptive-timeout* percentile to exclude failure
  samples requires threading a success flag through its `record()` (used on both
  success and failure paths in `fallback.ts`) — a cross-file behavior change left
  for a focused diff.
- **#349 (TTFAC real time-to-first-chunk)** — DEFERRED. `ai-client.ts` is outside
  the owned file set; the tracker side (#350/#351) was fixed here so it's ready
  when the caller starts passing a real TTFAC sample.
- **#357 / #363 (wire percentage routing + canary feedback into request paths)** —
  DEFERRED. Requires proxy/pipeline integration; the routing helpers were
  hardened (#358-#361) so integration can land on a correct base.
- **#362 / #392 / #393 (`src/modules/` 590-file mirror drift)** — DEFERRED.
  Deleting/regenerating the ~80k-LOC mirror is an L-effort structural change and
  `src/modules/**` is explicitly outside the owned file set; the canonical `src/`
  copies were edited here.
- **#370 / #371 / #372 / #373 / #376 / #377 / #378 (real TTS streaming, error
  `.status` normalization, inner-timeout marking, client-cache reuse, image
  retry, usage fallback, self-hosted STT format)** — DEFERRED. Each is a
  per-client behavior change that needs the real provider client (network /
  OpenAI SDK) to verify meaningfully; not unit-testable under the no-network
  constraint without deep client mocks.
- **#394 / #395 / #396 / #398 / #399 / #400 (lazy provider registry, registry
  unregister, breaker consolidation, per-model listing, shared route trackers)** —
  DEFERRED. These are server-wiring / registry-lifecycle changes (`server/
  providers.ts`, proxy route singletons) with broad blast radius and no isolated
  unit surface.
- **#374 (gate Groq English-only TTS fallback on `language==='en'`)** — DEFERRED.
  The fallback chain is assembled in `server/providers.ts`; `TTSRequest` carries
  no `language` field, so the gate belongs at the chain-assembly layer (server
  wiring) rather than the client — out of scope for a minimal client-level diff.
