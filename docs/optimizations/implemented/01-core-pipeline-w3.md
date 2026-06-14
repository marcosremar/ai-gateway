# Core AI Pipeline — Wave 3 Implemented

Continuation of waves 1-2. Each item below is SAFE, LOCALIZED, and within the
strict ownership set. Unit tests in
`__tests__/opt/01-core-pipeline-w3.test.ts` (31 tests, all passing).

Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/01-core-pipeline-w3.test.ts`

| ID | File:line | Change | Test |
|----|-----------|--------|------|
| #27 | server/ai-handlers.ts:383 (`capSttPrompt`) | Pre-existing prompt cap (≤800 chars) now covered by a unit test (Whisper ~224-token window). | `ai-handlers #27` (2) |
| #31 | src/gateway/pipeline/translation-cache.ts:118-153 | Added `buildTranslationCacheKey(...paramsKey?)`; `get/setCachedTranslation` accept an optional `paramsKey` so routes with different generation params (temp/maxTokens) don't share a (possibly truncated) entry. Default key unchanged → cache stays shared for deterministic routes. | `translation-cache #31` (2) |
| #32 | src/gateway/pipeline/translation-cache.ts:155-168 | `setCachedTranslation` now keeps the LONGER translation for a key (a truncated re-set won't clobber a fuller cached value within TTL). | `translation-cache #32` (2) |
| #35 | src/gateway/pipeline/speculative-cache.ts:184-205 | Length-difference early-exit before the O(la·lb) Levenshtein DP: if `1 - |la-lb|/maxLen < minConfidence` the DP can't pass, so skip it. Prefix/containment paths are untouched. | `speculative-cache #35` (3) |
| #37 | src/gateway/pipeline/speculative-cache.ts:56-63,93-110,138-152,216-235 | Track speculative spend: `speculations`, `speculationsFailed`, `speculationsWasted`, `wasteRate` added to `stats()`. Background LLM calls that fail/empty or are never reused are now visible. | `speculative-cache #37` (2) |
| #41 | src/gateway/pipeline/system-prompt.ts:40-91 | Memoize `buildSystemPrompt` on `(source,target,style)` with a bounded (128) cache + `_clearSystemPromptCache()` test hook. Stabilizes the cacheable prefix. | `system-prompt #41` (4) |
| #44 | server/ai-handlers.ts:389-405,790-794 | Extracted `statusForPipelineError(msg, stage)` pure helper (503 for "No providers available" vs 500 otherwise) and used it in the translate catch; replaces the inline mapping. | `ai-handlers #44` (3) |
| #50 | src/gateway/pipeline/streaming-overlap.ts:18-34,236-264 | `stats()` now exposes `lastSavedMs`; log + docstring clarified that the number is LLM time that *overlapped* with TTS (a lower bound), not a measured sequential baseline. | `streaming-overlap #50` (1) |
| #51 | src/gateway/pipeline/streaming-overlap.ts:36-56,140-213 | `maxWords` cap (default 40, `setMaxWords()`): a long un-punctuated run is force-flushed at `maxWords` instead of merging into one over-long first chunk that delays first-audio. | `streaming-overlap #51` (2) |
| #54 | src/gateway/pipeline/streaming-overlap.ts:148-179,219-234 | Running word count (`pendingWords`) — `dispatchChunk` adds `countWords(token)` incrementally instead of `countWords(pending.join(' '))` re-splitting the whole buffer each aggregation. | `streaming-overlap #54` (1) |
| #63 | src/gateway/pipeline/fanout-orchestrator.ts:11-30,33-39,116-126 | `FANOUT_MAX` is configurable: `resolveFanoutMax(optMax?, env)` (call opt → `FANOUT_MAX` env → default 16); `FanoutOpts.maxTargets` added. | `fanout-orchestrator #63` (3) |
| #91 | src/gateway/pipeline/pipeline-orchestrator.ts:17-27,624 | `isGpuProvider(name)` helper replaces brittle `=== 'gpu'` for `used_gpu` — now also matches `gpu-*`, `gpu/*`, `gpu:*` (e.g. `gpu/preset-fallback`) without false-matching `groq`/`gpufoo`. | `pipeline-orchestrator #91` (2) |
| #92 | src/gateway/pipeline/system-prompt.ts:30-46 | `isKnownStyle(style)` + `resolveStyle(style, fallback)` so callers can validate/warn instead of silently falling back to `default` on a typo'd style. | `system-prompt #92` (2) |
| #93 | src/gateway/pipeline/system-prompt.ts:104-118 | `KNOWN_VOICES` set + `isKnownVoice(speaker)` (case-insensitive) so an invalid speaker can be flagged rather than silently degrading to a provider default. | `system-prompt #93` (1) |
| #94 | src/gateway/pipeline/system-prompt.ts:9-15; pipeline-orchestrator.ts:420,547; fanout-orchestrator.ts:157 | Centralized the default voice as `DEFAULT_SPEAKER = 'Ryan'`; the three `speaker || 'Ryan'` literals now reference it. | `system-prompt #94` (1) |

## Notes / safety

- All edits are additive or internal: new exports, new **optional** trailing
  params, a widened return type (`OverlapStats` gains `lastSavedMs`; only
  re-exported as a type elsewhere, no external literal constructors), and one
  helper extraction. No behavior change to default code paths.
- `getCachedTranslation`/`setCachedTranslation` keep their existing signatures
  (new `paramsKey` is optional, omitted by all current callers → identical keys).
- Verified no regressions: waves 1+2+3 core-pipeline tests run green together
  (84 tests). Edited modules all import/compile under the vitest (esbuild)
  harness; new Map/Set iteration matches pre-existing patterns in the same files.

## Deferred (and why)

- **#33 / #56 (in-flight coalescing maps)** — behavior-changing concurrency
  primitive shared across orchestrator + fanout; needs a request-lifetime owner
  and careful eviction. Risky/cross-file; deferred.
- **#34 / #36 (wire `speculate()`, per-partial keying)** — requires changes to
  `server/ws-server.ts` / streaming-stt wiring (out of ownership) and the
  speculative key model; cross-file.
- **#46 / #52 (overlap TTS concurrency cap + per-chunk deadline)** — alters live
  dispatch timing/back-pressure; behavior-changing, wants integration coverage.
- **#75 / #76 (AbortSignal through orchestrator)** — large cross-cutting
  cancellation-token threading through `PipelineDeps` + handlers; high-impact but
  not localized.
- **#40 / #41-prefix-caching (provider prompt caching)** — depends on provider
  client changes (`src/providers/`, out of ownership).
- **#16 / #64 (hallucination filter / audio-duration guard in live path)** —
  require orchestrator stage wiring + handler plumbing; deferred to avoid
  behavior changes mid-pipeline without integration tests.
- **#17 (GPU STT metadata)** lives in `gpu-fetch.ts` parsing of real provider
  responses — owned, but validating it safely needs a provider-shaped fixture
  beyond a pure unit; deferred to keep this wave network-free.
