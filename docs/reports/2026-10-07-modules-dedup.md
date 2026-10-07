# src/modules dedup — 2026-10-07

`src/modules/` is a byte-for-byte mirror of `src/` that arrived in one merge (272587a, PR #21, 223 files under
`src/modules/gateway` alone). Nothing in it has been edited since; every divergence below is the live tree
(`src/gateway`, which `serve.ts` runs) having moved on. The pull-time multiplier is the clearest case: `src/gateway`
changed `maxSeen * 2.0` → `* 1.2` in 7117c58 (2026-05-20), and `src/modules` still carries `2.0`.

## Method

`diff -rq src/modules/gateway src/gateway` → 164 identical, 57 divergent, 2 only in modules (the `zai` provider, moved
to `src/gateway/providers/cloud/zai` in step 1). Each divergent file was then compared with `diff -wB` (ignoring
whitespace and blank lines) and every modules-only (`<`) hunk was read and checked against the `src/gateway` version.

**Canonical side: `src/gateway` for all 57.** No fix exists only in `src/modules`; nothing was ported.

## Decision table

### Whitespace / blank-line only (22) — drop modules copy

| File | Note |
|---|---|
| autoscaler/index.ts | trailing spaces |
| providers/cloud/openai/models.ts | trailing spaces |
| providers/cloud/percentage-routing.ts | trailing spaces |
| providers/gpu/docker-manifest-examples.ts | trailing spaces |
| providers/gpu/runpod/{index,offers,volumes}.ts | trailing spaces |
| providers/gpu/vast/{index,instances,offers,templates,types,utils}.ts | trailing spaces |
| pipeline/streaming-overlap.ts | gateway adds 7 lines only |
| providers/cloud/fal/fal-image.ts | gateway adds 5 lines only |
| providers/cloud/ollama/index.ts | gateway adds 2 lines only |
| providers/cloud/openai/openai-stt.ts | gateway adds abort signal |
| providers/cloud/self-hosted/self-hosted-provider.ts | gateway adds 2 lines only |
| providers/gpu/types.ts | gateway adds 4 lines only |
| proxy/routes/images.ts | gateway adds 4 lines only |
| proxy/routes/status.ts | gateway adds 5 lines only (route itself unmounted, see step 4) |
| state/deploy-state.ts | gateway adds 7 lines only |

### Modules side is an older version of the same code (35) — drop modules copy

| File | Modules (old) | src/gateway (canonical) |
|---|---|---|
| autoscaler/circuit-breaker.ts | shorter comment | same logic, longer comment |
| autoscaler/load-balancer.ts | `tryConsume` fails OPEN on store error | fails CLOSED (rate-limit bypass fix) |
| autoscaler/runaway-detector.ts | comment only | same `>=` logic |
| deploy/state-machine.ts | snapshot drops `readyAt`/`failedAt` | keeps them |
| pipeline/fanout-orchestrator.ts | no dedupe/cap of targets | dedupe + `FANOUT_MAX=16` |
| pipeline/hybrid-stages.ts | accepts empty TTS audio | `assertValidAudio` |
| pipeline/translation-cache.ts | no `peek`, sweep timer keeps process alive | `peek` + `unref` |
| pipeline/tts-preview.ts | fewer engines/sources | superset |
| providers/cloud/circuit-breaker.ts | no `isOpen`/`releaseProbe`/`peek`/`resetWhere` | superset |
| providers/cloud/cloud-health.ts | OpenRouter probed via public `/models` | `/key` (rejects revoked key), base overrides, injectable fetch |
| providers/cloud/dlp.ts | phone regex matches any 7 digits, no ReDoS guard | fixed regex + ReDoS guard + scan cap |
| providers/cloud/fallback.ts | breakers/timeouts keyed by provider | keyed by `entryHealthKey`, `skipRetry` |
| providers/cloud/guardrails.ts | substring match (`kill` in `skillet`), custom keywords counted N× | word-boundary match, keywords once |
| providers/cloud/openai-compat/client-cache.ts | sha256 key hash, SDK retries on | numeric key label, `GATEWAY_SDK_MAX_RETRIES=0` |
| providers/cloud/openai-compat/openai-compat-llm.ts | key cached forever | key read per call (rotation), stream markers |
| providers/cloud/openai-compat/openai-compat-stt.ts | inline segment parsing, no abort | `applyWhisperSegments` (shared), abort signal |
| providers/cloud/openai-compat/openai-compat-tts.ts | key cached forever | per-call key, `passthroughVoices` |
| providers/cloud/openrouter/index.ts | LLM + image | + STT + TTS |
| providers/cloud/performance-ranker.ts | scored per provider | per `entryHealthKey` |
| providers/cloud/routing-image.ts | fal default only | superset routing |
| providers/cloud/types.ts | no `minimax` in `ProviderId` | superset |
| providers/gpu/deploy-settings.ts | one extra comment line | same code |
| providers/gpu/pull-time-estimator.ts | timeout `× 2.0` | `× 1.2` (deliberate change, 7117c58) |
| providers/gpu/runpod-client.ts | shorter log/comment | same logic |
| proxy/middleware/auth.ts | comment only | same loop |
| proxy/middleware/rate-limit.ts | IP from socket only | `TRUST_PROXY` aware `clientIp` |
| proxy/routes/audio-speech.ts | single provider map, 500 on error | routed targets, fallback, typed errors |
| proxy/routes/audio-transcriptions.ts | cache key without filter flag | filter-aware cache key, routing, 413 |
| proxy/routes/chat-completions.ts | provider-level chain + `withProviderFallback` | `chatRoutes`, `runTargets`, `redactSecrets`, stream markers |
| proxy/routes/models.ts | lists every mapped id | lists only configured (`isConfigured`) ids, dedup |
| proxy/server.ts | fixed per-user limit 20 | `concurrencyLimits` (default 150 + overrides), body-limit errors |
| proxy/types.ts | fewer route fields | superset |
| routing/analytics-service.ts | health score in [0,1] vs thresholds 60/80 | scaled to [0,100] |
| routing/provider-racer.ts | primary rejection during headstart rejects race | swallowed, falls through |
| state/cost-state.ts | comment only | same code |

### Only in modules (2)

| File | Decision |
|---|---|
| providers/cloud/zai/index.ts, models.ts | moved to `src/gateway/providers/cloud/zai` (step 1, 612b320); now built on the canonical `OpenAICompatLLMProvider` (per-call key read), covered by `__tests__/unit/zai-canonical-provider.test.ts` |

## Ported fixes

None. Every modules-only hunk is an older version of code that `src/gateway` has since fixed or extended.
