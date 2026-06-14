# Core AI Pipeline — Wave 5 Implemented

Continuation of waves 1-4. The safe, in-lane (owned + localized + back-compat)
pool is now nearly exhausted — most remaining items in
`docs/optimizations/01-core-ai-pipeline.md` are either (a) behaviour-changing on
the live dispatch path, (b) cross-file wiring through `server/ws-server.ts` /
streaming-stt, or (c) in modules OUTSIDE the strict ownership set
(`src/gateway/routing/provider-racer.ts`, `ewma-tracker.ts`, `src/modules/**`).
This wave lands **3** genuinely-safe items; everything left is deferred with a
one-line reason below. Quality over count, as instructed.

Every change is additive / opt-in: a new **optional** field (`PipelineOpts.minAudioMs`),
a new opt-in method (`SpeculativeCache.setRingSize`), or a new env-gated cap
(`STT_MAX_CANDIDATES`). **Default code paths are byte-for-byte unchanged** — the
new behaviour only activates when the caller opts in.

Unit tests: `__tests__/opt/01-core-pipeline-w5.test.ts` (16 tests, all passing).

Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/01-core-pipeline-w5.test.ts`

| ID | File:area | Change | Test |
|----|-----------|--------|------|
| #8 | server/pipeline-runner.ts | Cap on concurrent **paid** STT race candidates. STT can fan out to `gpu + modal-babelcast + cloud + ensemble-fallback` (4 paid calls) **every chunk**. Added pure `resolveMaxSttCandidates(opt → STT_MAX_CANDIDATES env → 0)` and `capSttCandidates(list, max)` (priority-order-preserving; always keeps ≥1), applied at the end of `buildSttCandidates`. **0 / unset = unlimited (legacy).** A cap of e.g. 2 keeps GPU + the next-best leg and drops the tail. | `#8 — resolveMaxSttCandidates…` (2), `#8 — …capSttCandidates` (2) |
| #36 | src/gateway/pipeline/speculative-cache.ts | Per-session **ring** of recent partials. Rapid 200 ms ASR partials previously **overwrote** the single per-session speculation, so a final that matched an *earlier* partial was discarded → guaranteed miss + wasted background LLM call. Added `setRingSize(n)`; with `n>1` the last N partials are retained and `resolve()` (via new private `selectEntry`) prefers the newest retained partial that is actually similar to the final. **Default ring size 1 = exact legacy overwrite behaviour** (ring map untouched, zero extra allocation). `clear()` / `evictExpired()` extended to the ring. | `#36 — …ring…` (6) |
| #64 | src/gateway/pipeline/pipeline-orchestrator.ts | **Audio-duration guard.** `audioDur` was computed for logging only, so sub-200 ms / silence-only buffers still fanned out to 3-4 paid STT providers to transcribe nothing. Added pure `estimateAudioSeconds()` / `isAudioTooShort()` (+ `PCM16_BYTES_PER_SEC`) and an opt-in `PipelineOpts.minAudioMs`: when set and the buffer is below threshold, the pipeline short-circuits to the same empty-result `onComplete` shape **before** any STT executor / pre-warm runs. **Unset / `<=0` disables the guard (legacy always-transcribe).** Also DRY'd the existing `audioDur` log to reuse `estimateAudioSeconds`. | `#64 — estimateAudioSeconds/isAudioTooShort` (4), `#64 — orchestrator short-circuits…` (2) |

## Notes / safety

- **All additive / opt-in.** New exports: `estimateAudioSeconds`, `isAudioTooShort`,
  `PCM16_BYTES_PER_SEC` (pipeline-orchestrator); `resolveMaxSttCandidates`,
  `capSttCandidates` (pipeline-runner). New optional field `PipelineOpts.minAudioMs`.
  New method `SpeculativeCache.setRingSize` (private `selectEntry`, parallel
  `rings` map only populated when ring > 1). No existing signature changed.
- **Back-compat verified:** waves 1-4 core-pipeline tests run green together
  (116 tests) alongside the new 16. No other `__tests__/opt/*` file imports any
  of the three modules changed here (`grep` confirmed), so the blast radius is
  the core-pipeline suite only.
- The #64 short-circuit reuses the *exact* timing/empty-result object shape of
  the pre-existing `!sttText.trim()` early-return, so downstream SSE/WS consumers
  see a familiar "empty transcription" completion, not a new event shape.
- `capSttCandidates` returns the **same array reference** when no cap applies, so
  the hot path allocates nothing when `STT_MAX_CANDIDATES` is unset.

## Deferred (and why)

**Behaviour-changing on the live dispatch path (want integration coverage):**
- **#6 / #7** — gate the STT/LLM *backup-GPU* candidate behind a head-start. The
  builders pass a single `headstartMs` to all candidates; per-candidate
  head-start needs `provider-racer.ts` support, which is OUT of ownership.
- **#42** — GPU streaming-LLM overlap path (overlap currently requires
  `!llmOnGpu`); adding a GPU stream path changes routing.
- **#46 / #47 / #48 / #49** — overlap TTS concurrency cap, chunk retry, cache
  reuse, client-disconnect abort: all alter live TTS back-pressure / billing.
- **#55** — recover partial translated text on a mid-stream LLM throw; changes
  the `processWithOverlap` error contract.
- **#67 / #69 / #71 / #73** — warmth-decay / cost-aware demotion / Modal-keepalive
  throttle in `pipeline-runner` routing: live routing-decision changes.
- **#78** — tie dub-fanout lifetime to the request (cancel on primary failure);
  changes the intentional fire-before-LLM concurrency.
- **#80** — streaming-STT provider failover on disconnect: live session change.

**Cross-file wiring / out of ownership:**
- **#15 / #16 / #26 / #28** — thread glossary/hotwords/auto-detect/domain-prompt
  into the *live* streaming STT: orchestrator stage wiring + handler plumbing.
- **#33 / #34** — in-flight coalescing map / wire `speculate()` from partials:
  needs `server/ws-server.ts` + streaming-stt changes (out of ownership). #36
  makes the speculation *survive* rapid partials, but the partials still aren't
  fed in from the WS handler.
- **#39** — schedule the incomplete-turn deferred re-prompt: handler-level
  behaviour (the `createStreamGate` capability already exists).
- **#40 / #41-prefix-caching** — provider prompt-caching: depends on
  `src/providers/*` client changes (out of ownership).
- **#57** — multi-output / batched dub translation: large fan-out redesign.
- **#60** — thread voice-clone refs into fan-out TTS: forces the hybrid GPU path
  (behaviour-changing live synth).
- **#75 / #76** — AbortSignal through `PipelineDeps` + handlers: large
  cross-cutting cancellation-token threading.
- **#88 / #90** — surface speculative/overlap stats and per-stage token counts on
  `/metrics`: the stat methods exist, but the endpoint lives in
  `server/ws-server.ts` (out of ownership) — primarily an observability-lane item.
- **#1 / #2 / #3 / #9-#14 / #86 / #87** — `provider-racer.ts` / `ewma-tracker.ts`
  in `src/gateway/routing/` — OUTSIDE the ownership set.
- **#96 / #97 / #98 / #99** — `src/modules/**` drift mirror (out of ownership) +
  routing dedup spanning pipeline-runner + dub-fanout + ai-handlers (cross-file).

**Already done in earlier waves (verified present in code during this pass):**
- **#38** (llm-context import hoisted), **#45** (LLM error latency from `llmReqTs`),
  **#43** (dub-fanout temp 0), **#66** (static chain indices), **#79** (STT
  pre-connect buffering), **#81** (streaming-STT `isFinal`), **#92** (style
  validation), **#95** (SSE `complete` echoes source/target) — no action needed.

> **Safe in-lane pool status: effectively exhausted.** What remains is
> behaviour-changing-on-the-live-path, cross-file wiring through out-of-ownership
> modules, or in `src/gateway/routing/` / `src/modules/**` (outside ownership).
> Future waves on this lane should expect to take integration-test risk or an
> ownership expansion rather than more drop-in localized wins.
