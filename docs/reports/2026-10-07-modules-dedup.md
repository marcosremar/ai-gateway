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

## Follow-up steps (same branch)

| Step | Commit | Effect |
|---|---|---|
| 1 | 612b320 | `zai` moved to `src/gateway/providers/cloud/zai`; serve.ts imports it from there |
| 2 | e9149a2 | this decision table |
| 3 | a54bf31 | `src/modules` deleted (595 files / 79.6k lines). Moved because still live: `gpu-finetune` (bin), `gpu-providers/{strategies,reservations,provider-readiness,deploy-extra}` (server/gpu-deploy-*), `safe-catch.ts`. `src/index.ts`, `bin/ai-gateway.ts` and 13 tests repointed |
| 4 | 32ab470 | `@deprecated` on GatewayHttpClient, GatewaySDK, AIClient, SpeechClient/UnifiedSpeechClient; `docs/api/sdk.md` marked legacy; egg-info and the unmounted `proxy/routes/status.ts` removed |
| 5 | 9cf2478 | `server/` 147 → 4 files (38.9k → 0.7k lines); 154 test files deleted, 31 mixed test files pruned |
| exports | 92817a9 | `./client` = `sdk/node` in package.json and tsup; `./*` wildcard removed |

### server/ after step 5

Still referenced, kept:

| File | Why |
|---|---|
| `server/orphan-sweep-vast.ts` (+ its test) | `bin/ai-gateway-cost-audit.ts` |
| `server/workload-handlers.ts`, `server/http-utils.ts` | `serve.ts` still `require`s them for `/v1/workloads`; delete them when the workloads mount is removed |

Nothing else in `serve.ts`, `src/`, `sdk/`, `bin/` or the package scripts reached `server/` (dependency-cruiser graph,
plus a grep for dynamic `require`/`import`). `scripts/dev.ts`, `start-ws-server.sh`, `sync-pod.sh` and
`run-all-tests.sh` started the removed `server/ws-server.ts`; they now start `serve.ts`.

### What parle uses (must stay)

parle (`babylon-cinema`) never imports the package by name; it reaches `vendor/ai-gateway/src/...` by path:

- `backend/compute/ai-gateway-backend.ts` (`VENDOR_CLIENTS`, loaded dynamically): `src/gpu-providers/vast-client.ts`,
  `src/gpu-providers/runpod-client.ts`, `src/gpu-providers/hyperstack.ts`, `src/gpu-providers/tensordock-client.ts`,
  `src/cpu-providers/scaleway-client.ts`, `src/gateway/providers/gpu/instance-status.ts`, `src/gpu-providers/types.ts`
- `backend/compute/replica-failover.ts`: `src/gateway/routing/hedged-replicas.ts`, `src/gateway/providers/cloud/fallback.ts`,
  `src/gateway/providers/cloud/performance-ranker.ts`
- `palco/hub/hub-compute.ts`, `tools/vm/{runpod-api,vast-api,vast-voice}.ts`: `src/gateway/providers/gpu/runpod/rest.ts`,
  `src/gateway/providers/gpu/vast/marketplace.ts`
- tests: `src/gateway/providers/gpu/vast/offer-policy.ts`, `src/compute/run-gpu-job.ts`,
  `src/gateway/providers/cloud/entry-key.ts`; `package.json` (dependencies read by `test/palco/stage.spec.ts`)
- Railway image copies all of `vendor/ai-gateway/src`.

None of these lived in `src/modules` or `server/`; all still exist.
