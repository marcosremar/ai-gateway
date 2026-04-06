# AI Gateway — 1000 Missing Tests Plan

> Generated from codebase audit. Each test is numbered, categorized by priority and module.
> Existing coverage: 3781 tests across 212 files. This plan adds 1000 more.

---

## 1. Server: AI Handlers (`server/ai-handlers.ts`) — 30 exports, 175 tests

### 1.1 handleTranscribe (POST /v1/transcribe)
| # | Test | Priority |
|---|------|----------|
| 001 | Returns 400 when body is empty | HIGH |
| 002 | Returns transcription for valid WAV audio | HIGH |
| 003 | Returns transcription for MP3 audio | HIGH |
| 004 | Returns transcription for OGG audio | MEDIUM |
| 005 | Respects language query parameter | HIGH |
| 006 | Auto-detects language when language param omitted | HIGH |
| 007 | Passes prompt parameter to STT provider | MEDIUM |
| 008 | Passes hotwords parameter to STT provider | MEDIUM |
| 009 | Returns word timestamps when word_timestamps=true | MEDIUM |
| 010 | Routes to GPU when GPU is ready and warm | HIGH |
| 011 | Falls back to cloud when GPU is not ready | HIGH |
| 012 | Falls back to cloud when GPU STT circuit is open | HIGH |
| 013 | Records latency in per-stage ring buffer | MEDIUM |
| 014 | Increments metricsCounters.byStage.stt | LOW |
| 015 | Sets X-Request-ID response header | LOW |
| 016 | Returns 408 on body read timeout | MEDIUM |
| 017 | Returns 413 on body exceeding MAX_BODY_BYTES | HIGH |
| 018 | Shadow mode fires GPU request in background | MEDIUM |
| 019 | Shadow mode does not affect response latency | MEDIUM |
| 020 | Handles concurrent requests without race conditions | HIGH |

### 1.2 handleEnsembleTranscribe (POST /v1/transcribe/ensemble)
| # | Test | Priority |
|---|------|----------|
| 021 | Races multiple STT providers and returns best | HIGH |
| 022 | Returns single provider result when only one configured | MEDIUM |
| 023 | Handles all providers failing with 500 | HIGH |
| 024 | Returns within timeout even if slow providers exist | HIGH |
| 025 | Includes provider name in response | LOW |

### 1.3 handleChatCompletions (POST /v1/chat/completions)
| # | Test | Priority |
|---|------|----------|
| 026 | Returns 400 when messages array missing | HIGH |
| 027 | Returns 400 when messages is not an array | HIGH |
| 028 | Returns 400 for invalid JSON body | HIGH |
| 029 | Routes to correct provider by model name | HIGH |
| 030 | Falls back to Groq when specified model not found | HIGH |
| 031 | Returns OpenAI-compatible response format | HIGH |
| 032 | Includes usage.prompt_tokens in response | MEDIUM |
| 033 | Includes usage.completion_tokens in response | MEDIUM |
| 034 | Respects temperature parameter | MEDIUM |
| 035 | Respects max_tokens parameter | MEDIUM |
| 036 | Handles empty messages array | MEDIUM |
| 037 | Handles system + user + assistant messages | MEDIUM |
| 038 | Returns 500 when all providers fail | HIGH |
| 039 | Does not leak API keys in error response | HIGH |
| 040 | Does not leak internal paths in error response | HIGH |

### 1.4 handleTranslate (POST /v1/translate)
| # | Test | Priority |
|---|------|----------|
| 041 | Translates text from French to English | HIGH |
| 042 | Returns 400 when text is empty | MEDIUM |
| 043 | Supports source_lang and target_lang params | HIGH |
| 044 | Uses GPU LLM when available | HIGH |
| 045 | Falls back to cloud LLM | HIGH |
| 046 | Handles glossary parameter | MEDIUM |
| 047 | Returns used_gpu flag correctly | MEDIUM |
| 048 | Returns translated_text field | HIGH |

### 1.5 handlePipeline (POST /v1/speech)
| # | Test | Priority |
|---|------|----------|
| 049 | Full pipeline: audio in → text → translation → audio out | HIGH |
| 050 | Returns transcription, response, audio_base64, timing | HIGH |
| 051 | Respects source and target query params | HIGH |
| 052 | Respects speaker query param | MEDIUM |
| 053 | Returns 400 for empty audio | MEDIUM |
| 054 | Returns timing.total_ms | HIGH |
| 055 | Returns timing.stt_ms, llm_ms, tts_ms | MEDIUM |
| 056 | GPU pipeline when all stages warm | HIGH |
| 057 | Mixed GPU/cloud pipeline (GPU STT, cloud LLM) | HIGH |
| 058 | Full cloud pipeline when GPU offline | HIGH |

### 1.6 handleTtsPreview (POST /v1/tts/preview)
| # | Test | Priority |
|---|------|----------|
| 059 | Returns WAV audio for text input | HIGH |
| 060 | Respects speaker parameter | MEDIUM |
| 061 | Respects speed parameter | MEDIUM |
| 062 | Returns 400 for empty text | MEDIUM |
| 063 | Returns Content-Type audio/wav | MEDIUM |

### 1.7 handleDetectLanguage (POST /v1/detect-language)
| # | Test | Priority |
|---|------|----------|
| 064 | Detects French text | HIGH |
| 065 | Detects English text | HIGH |
| 066 | Detects Spanish text | MEDIUM |
| 067 | Returns confidence score | MEDIUM |
| 068 | Returns 400 for empty text | MEDIUM |

### 1.8 handleAutoSwap
| # | Test | Priority |
|---|------|----------|
| 069 | GET /v1/auto-swap/status returns current state | MEDIUM |
| 070 | POST /v1/auto-swap/toggle enables/disables | MEDIUM |
| 071 | POST /v1/auto-swap/benchmark triggers benchmark | LOW |

### 1.9 Error handling across all handlers
| # | Test | Priority |
|---|------|----------|
| 072 | All handlers set X-Request-ID header | LOW |
| 073 | All POST handlers reject GET requests | MEDIUM |
| 074 | All handlers return JSON Content-Type | MEDIUM |
| 075 | No handler leaks stack traces in response | HIGH |
| 076 | No handler leaks file paths in response | HIGH |
| 077 | All handlers call touchRequest() | MEDIUM |
| 078 | Model request handlers call touchModelRequest() | MEDIUM |

---

## 2. Server: GPU Handlers (`server/gpu-handlers.ts`) — 29 exports, 220 tests

### 2.1 handleGpuDeploy (POST /v1/gpu/deploy)
| # | Test | Priority |
|---|------|----------|
| 079 | Returns 202 for valid deploy request | HIGH |
| 080 | Returns 409 when deploy already in progress | HIGH |
| 081 | Cancels existing deploy before starting new one | HIGH |
| 082 | Validates apiKey presence | HIGH |
| 083 | Validates gpuTypes array | MEDIUM |
| 084 | Validates dockerImage string | MEDIUM |
| 085 | Sets deploy lock before starting | HIGH |
| 086 | Releases deploy lock on completion | HIGH |
| 087 | Releases deploy lock on error | HIGH |
| 088 | Resets deployCancelled flag | HIGH |
| 089 | Builds correct tier order from PROVIDER_CHAIN | HIGH |
| 090 | Excludes providers with insufficient balance | HIGH |
| 091 | Starts race deploy when raceCount > 1 | MEDIUM |
| 092 | Starts sequential deploy when raceCount = 1 | MEDIUM |
| 093 | Returns balance warnings in response | MEDIUM |
| 094 | Handles missing API keys gracefully | HIGH |
| 095 | Auto-selects cheapest GPU when autoSelectGpu=true | MEDIUM |
| 096 | Respects region filter | MEDIUM |
| 097 | Respects minVramGb filter | MEDIUM |

### 2.2 handleGpuStatus (GET /v1/gpu/status)
| # | Test | Priority |
|---|------|----------|
| 098 | Returns idle status when no deploy active | HIGH |
| 099 | Returns creating status during deploy | HIGH |
| 100 | Returns ready status when GPU is ready | HIGH |
| 101 | Returns error status on deploy failure | HIGH |
| 102 | Includes gpuHealthy flag | HIGH |
| 103 | Includes activeTier (gpu/cloud) | HIGH |
| 104 | Includes idleSec | MEDIUM |
| 105 | Includes idleTimeoutSec | MEDIUM |
| 106 | Includes costPerHr | MEDIUM |
| 107 | Includes provider name | MEDIUM |
| 108 | Includes gpuType | MEDIUM |
| 109 | Includes endpoint URL | HIGH |
| 110 | Includes podId | MEDIUM |
| 111 | Includes elapsedSec since deploy start | MEDIUM |
| 112 | Includes transitions array | LOW |
| 113 | Omits lastLogs from status (privacy) | MEDIUM |
| 114 | Includes IP geolocation when available | LOW |
| 115 | Includes provider balance when available | MEDIUM |
| 116 | Includes cooldown state | MEDIUM |

### 2.3 handleGpuStop (POST /v1/gpu/stop)
| # | Test | Priority |
|---|------|----------|
| 117 | Returns 400 when no active pod | HIGH |
| 118 | Stops RunPod pod successfully | HIGH |
| 119 | Stops Vast.ai instance successfully | HIGH |
| 120 | Stops TensorDock instance successfully | MEDIUM |
| 121 | Preserves podId in state for resume | HIGH |
| 122 | Stops GPU monitoring | HIGH |
| 123 | Updates deploy state to idle | HIGH |
| 124 | Returns 400 when no credentials for provider | MEDIUM |

### 2.4 handleGpuResume (POST /v1/gpu/resume)
| # | Test | Priority |
|---|------|----------|
| 125 | Resumes last stopped pod | HIGH |
| 126 | Resumes specific pod by podId in body | MEDIUM |
| 127 | Returns 400 when no pod to resume | HIGH |
| 128 | Starts health monitoring after resume | HIGH |
| 129 | Updates deploy state to booting | HIGH |

### 2.5 handleGpuTerminate (POST /v1/gpu/terminate)
| # | Test | Priority |
|---|------|----------|
| 130 | Terminates RunPod pods | HIGH |
| 131 | Terminates Vast.ai instances | HIGH |
| 132 | Terminates TensorDock instances | HIGH |
| 133 | Terminates Modal apps | MEDIUM |
| 134 | Cleans up ALL providers (not just active) | HIGH |
| 135 | Resets deploy state | HIGH |
| 136 | Stops monitoring | HIGH |
| 137 | Releases deploy lock | HIGH |
| 138 | Records host reputation on graceful terminate | MEDIUM |
| 139 | Logs termination event | MEDIUM |

### 2.6 handleGpuOffers (GET /v1/gpu/offers)
| # | Test | Priority |
|---|------|----------|
| 140 | Returns offers from RunPod | MEDIUM |
| 141 | Returns offers from Vast.ai | MEDIUM |
| 142 | Returns offers sorted by price | MEDIUM |
| 143 | Filters by GPU type when specified | MEDIUM |
| 144 | Includes probe latency when available | LOW |
| 145 | Returns empty array when no offers | MEDIUM |

### 2.7 handleGpuTypes (GET /v1/gpu/types)
| # | Test | Priority |
|---|------|----------|
| 146 | Returns verified GPU types from cache | MEDIUM |
| 147 | Returns empty when cache not populated | MEDIUM |

### 2.8 handleGpuLogs / handleGpuEventLogs
| # | Test | Priority |
|---|------|----------|
| 148 | Returns remote GPU container logs | MEDIUM |
| 149 | Returns event log entries | MEDIUM |
| 150 | Respects lines query parameter | LOW |
| 151 | Returns empty when no logs | MEDIUM |

### 2.9 handleHealth (GET /health)
| # | Test | Priority |
|---|------|----------|
| 152 | Returns { status: "ok" } when healthy | HIGH |
| 153 | Includes uptime_sec | HIGH |
| 154 | Includes component statuses (stt, llm, tts, gpu) | HIGH |
| 155 | Includes provider info per component | MEDIUM |
| 156 | Includes latency percentiles | MEDIUM |
| 157 | Includes budget info | MEDIUM |
| 158 | Includes circuit breaker states | MEDIUM |
| 159 | Includes provider balances | MEDIUM |

### 2.10 GPU Readiness endpoints
| # | Test | Priority |
|---|------|----------|
| 160 | GET /v1/gpu/readiness/status returns state | MEDIUM |
| 161 | GET /v1/gpu/readiness/history returns transitions | LOW |
| 162 | POST /v1/gpu/readiness/reset clears benchmarks | MEDIUM |

### 2.11 Latency endpoints
| # | Test | Priority |
|---|------|----------|
| 163 | GET /v1/gpu/latency/settings returns config | MEDIUM |
| 164 | PATCH /v1/gpu/latency/settings updates config | MEDIUM |
| 165 | POST /v1/gpu/latency/run triggers probes | LOW |
| 166 | GET /v1/gpu/latency/hosts returns host data | LOW |

---

## 3. Server: GPU Deploy (`server/gpu-deploy.ts`) — 26 exports, 150 tests

### 3.1 Deploy loop
| # | Test | Priority |
|---|------|----------|
| 167 | startDeployLoop creates instance on first provider | HIGH |
| 168 | Falls to next tier when first fails | HIGH |
| 169 | Retries on transient errors | HIGH |
| 170 | Does not retry on billing errors | HIGH |
| 171 | Does not retry on auth errors | HIGH |
| 172 | Does not retry on docker image errors | HIGH |
| 173 | Respects MAX_DEPLOY_RETRIES | MEDIUM |
| 174 | Respects deploy timeout | HIGH |
| 175 | Cancellation stops the loop immediately | HIGH |
| 176 | Resets deployCancelled at start | HIGH |
| 177 | Cleans up instance after health poll failure | HIGH |
| 178 | Stops deploy if instance cleanup fails | HIGH |
| 179 | Persists active deploy to disk | MEDIUM |
| 180 | Restores active deploy from disk on restart | MEDIUM |

### 3.2 Health monitoring
| # | Test | Priority |
|---|------|----------|
| 181 | startGpuMonitoring resets idle clock | HIGH |
| 182 | Monitor probes /health every 30s | HIGH |
| 183 | Monitor detects unhealthy GPU (5 consecutive fails) | HIGH |
| 184 | Monitor auto-restarts EXITED RunPod pods | HIGH |
| 185 | Monitor detects orphaned pods (error + podId) | HIGH |
| 186 | Monitor reschedules in finally block | HIGH |
| 187 | Monitor back-off on consecutive failures | MEDIUM |
| 188 | Monitor resets back-off on success | MEDIUM |
| 189 | stopGpuMonitoring clears timer | HIGH |

### 3.3 Idle watchdog
| # | Test | Priority |
|---|------|----------|
| 190 | Auto-stops after IDLE_TIMEOUT_MS of no model requests | HIGH |
| 191 | Status polls do NOT reset idle timer | HIGH |
| 192 | STT/LLM/TTS requests DO reset idle timer | HIGH |
| 193 | Warns at 75% of idle timeout | MEDIUM |
| 194 | Adaptive monitor frequency during idle | LOW |
| 195 | Auto-destroy after IDLE_DESTROY_MS | HIGH |

### 3.4 Race deploy
| # | Test | Priority |
|---|------|----------|
| 196 | Creates N instances in parallel | HIGH |
| 197 | First healthy instance wins | HIGH |
| 198 | Losers are terminated after winner found | HIGH |
| 199 | All instances terminated if all fail | HIGH |
| 200 | Promise.all exception triggers force cleanup | HIGH |
| 201 | activeRaceInstanceIds cleared in finally | HIGH |
| 202 | Wasted cost tracked for losers | MEDIUM |
| 203 | Race summary logged | LOW |

### 3.5 Orphan sweep
| # | Test | Priority |
|---|------|----------|
| 204 | Sweeps RunPod orphans by prefix | HIGH |
| 205 | Sweeps Vast.ai orphans | HIGH |
| 206 | Does not terminate active race instances | HIGH |
| 207 | Runs every ORPHAN_SWEEP_INTERVAL_MS | MEDIUM |
| 208 | Initial sweep after 15s delay | MEDIUM |
| 209 | stopOrphanSweep clears both timers | HIGH |

### 3.6 Budget tracking
| # | Test | Priority |
|---|------|----------|
| 210 | Accumulates daily spend using actual elapsed time | HIGH |
| 211 | Resets daily spend at UTC midnight | HIGH |
| 212 | Hard limit auto-terminates GPU | HIGH |
| 213 | Soft limit warns at 80% | MEDIUM |

### 3.7 Cooldown tracker
| # | Test | Priority |
|---|------|----------|
| 214 | Records failure and enters cooldown | HIGH |
| 215 | Cooldown expires after configured duration | HIGH |
| 216 | Success clears cooldown | HIGH |
| 217 | All-cooled-down bypass mode works | HIGH |
| 218 | Bypass mode does NOT record failures | HIGH |
| 219 | Cooldown persists to disk | MEDIUM |
| 220 | Cooldown loads from disk on restart | MEDIUM |

---

## 4. Server: Bot Handlers (`server/bot-handlers.ts`) — 14 exports, 80 tests

| # | Test | Priority |
|---|------|----------|
| 221 | handleBotDeploy returns 409 when lock held | HIGH |
| 222 | handleBotDeploy creates Fly.io machine | HIGH |
| 223 | handleBotDeploy falls back to RunPod | HIGH |
| 224 | handleBotDeploy falls back to CPU pod | HIGH |
| 225 | handleBotDeploy releases lock on error | HIGH |
| 226 | handleBotDeploy releases lock on success | HIGH |
| 227 | handleBotDeploy local Docker mode | MEDIUM |
| 228 | handleBotStatus returns current state | HIGH |
| 229 | handleBotStatus includes elapsed time | MEDIUM |
| 230 | handleBotJoin validates meetingUrl | HIGH |
| 231 | handleBotJoin rejects private URLs (SSRF) | HIGH |
| 232 | handleBotJoin starts audio relay | MEDIUM |
| 233 | handleBotLeave stops audio relay | MEDIUM |
| 234 | handleBotTerminate cleans up RunPod | HIGH |
| 235 | handleBotTerminate cleans up Fly.io | HIGH |
| 236 | handleBotTerminate cleans up Scaleway | HIGH |
| 237 | handleBotTerminate resets bot state | HIGH |
| 238 | handleBotTerminate releases deploy lock | HIGH |
| 239 | cleanupBotPods removes all RunPod bots | HIGH |
| 240 | cleanupBotPods removes all Fly.io bots | HIGH |
| 241 | cleanupBotPods removes all Scaleway bots | HIGH |
| 242 | Audio relay broadcasts to all WS clients | MEDIUM |
| 243 | Audio relay uses collect-then-delete pattern | MEDIUM |
| 244 | Audio relay auto-reconnects on disconnect | MEDIUM |
| 245 | Meeting URL is redacted in logs | HIGH |

---

## 5. Server: Pipeline Runner (`server/pipeline-runner.ts`) — 40 tests

| # | Test | Priority |
|---|------|----------|
| 246 | Full pipeline STT → LLM → TTS produces audio | HIGH |
| 247 | Pipeline with GPU STT, cloud LLM, cloud TTS | HIGH |
| 248 | Pipeline with all cloud providers | HIGH |
| 249 | Pipeline with all GPU stages | HIGH |
| 250 | Pipeline returns null when no LLM configured | HIGH |
| 251 | Pipeline callbacks fire onStageStart for each stage | MEDIUM |
| 252 | Pipeline callbacks fire onStageDone with results | MEDIUM |
| 253 | Pipeline callbacks fire onAudioChunk for TTS | MEDIUM |
| 254 | Pipeline callbacks fire onComplete with timing | MEDIUM |
| 255 | Pipeline callbacks fire onError on failure | HIGH |
| 256 | Speculative cache used when available | MEDIUM |
| 257 | Voice cloning route when clone reference set | LOW |
| 258 | Speaker resolved from profile voice map | MEDIUM |
| 259 | Empty TTS audio handled gracefully | HIGH |
| 260 | Pipeline respects stage circuit breakers | HIGH |

---

## 6. Server: Config (`server/config-persistence.ts`, `server/config-handlers.ts`) — 45 tests

| # | Test | Priority |
|---|------|----------|
| 261 | loadProviderConfig returns default on first run | HIGH |
| 262 | loadProviderConfig reads from disk | HIGH |
| 263 | loadProviderConfig uses cache within TTL | MEDIUM |
| 264 | loadProviderConfig handles corrupt JSON | HIGH |
| 265 | saveProviderConfig writes atomically (tmp + rename) | HIGH |
| 266 | saveProviderConfig updates in-memory cache | MEDIUM |
| 267 | Concurrent saves don't corrupt file | HIGH |
| 268 | GET /v1/config/providers returns current config | HIGH |
| 269 | POST /v1/config/providers updates config | HIGH |
| 270 | GET /v1/config/api-keys returns masked keys | HIGH |
| 271 | POST /v1/config/api-keys updates keys | HIGH |
| 272 | API keys not exposed in full in response | HIGH |
| 273 | POST /v1/config/profiles creates new profile | MEDIUM |
| 274 | DELETE /v1/config/profiles removes profile | MEDIUM |
| 275 | POST /v1/config/profiles/activate switches profile | MEDIUM |
| 276 | Profile activation updates runtime state atomically | HIGH |
| 277 | GET /v1/config/labs returns feature flags | MEDIUM |
| 278 | POST /v1/config/labs updates feature flags | MEDIUM |
| 279 | Labs flags validated (numeric ranges) | MEDIUM |
| 280 | Default GPU profiles are well-formed | MEDIUM |

---

## 7. Server: Workload Handlers (`server/workload-handlers.ts`) — 30 tests

| # | Test | Priority |
|---|------|----------|
| 281 | GET /v1/workloads returns empty list | HIGH |
| 282 | GET /v1/workloads?type=gpu filters by type | HIGH |
| 283 | POST /v1/workloads deploys GPU workload | HIGH |
| 284 | POST /v1/workloads deploys bot workload | HIGH |
| 285 | POST /v1/workloads deploys db workload | HIGH |
| 286 | POST /v1/workloads returns 400 for missing name | HIGH |
| 287 | POST /v1/workloads returns 400 for invalid type | HIGH |
| 288 | POST /v1/workloads returns 409 for duplicate name | HIGH |
| 289 | GET /v1/workloads/:id returns workload status | HIGH |
| 290 | GET /v1/workloads/:id returns 404 for unknown | HIGH |
| 291 | POST /v1/workloads/:id/stop stops workload | HIGH |
| 292 | POST /v1/workloads/:id/start resumes workload | HIGH |
| 293 | DELETE /v1/workloads/:id terminates workload | HIGH |
| 294 | WorkloadRegistry.list returns all workloads | HIGH |
| 295 | WorkloadRegistry.getByName finds by name | HIGH |
| 296 | WorkloadRegistry.listByType filters correctly | HIGH |
| 297 | WorkloadRegistry emits created event | MEDIUM |
| 298 | WorkloadRegistry emits status_changed event | MEDIUM |
| 299 | WorkloadRegistry emits terminated event | MEDIUM |
| 300 | GpuWorkloadDriver.deploy kicks off deploy | HIGH |
| 301 | GpuWorkloadDriver.stop calls provider stop | HIGH |
| 302 | GpuWorkloadDriver.start calls provider start | HIGH |
| 303 | GpuWorkloadDriver.terminate cleans up all | HIGH |
| 304 | GpuWorkloadDriver.status maps deploy state | HIGH |
| 305 | BotWorkloadDriver.deploy creates bot pod | HIGH |
| 306 | BotWorkloadDriver.terminate cleans up bot | HIGH |
| 307 | BotWorkloadDriver.status maps bot state | HIGH |
| 308 | DbWorkloadDriver.deploy connects to Neon | HIGH |
| 309 | DbWorkloadDriver.status queries Neon API | HIGH |
| 310 | DbWorkloadDriver.terminate doesn't delete project | HIGH |

---

## 8. Server: Metrics (`server/metrics.ts`) — 25 tests

| # | Test | Priority |
|---|------|----------|
| 311 | logRequest records to latency ring buffer | HIGH |
| 312 | Latency ring wraps at LATENCY_RING_SIZE | HIGH |
| 313 | computePercentile returns correct P50 | HIGH |
| 314 | computePercentile returns correct P95 | HIGH |
| 315 | computePercentile returns correct P99 | MEDIUM |
| 316 | computePercentile handles empty array | MEDIUM |
| 317 | logGpuEvent writes to JSONL file | MEDIUM |
| 318 | updateDeploySession creates DB session | MEDIUM |
| 319 | upsertHostReputation tracks success/failure | MEDIUM |
| 320 | getAllReputations returns sorted list | LOW |
| 321 | handleRequestLog returns recent requests | MEDIUM |
| 322 | handleRequestLog respects limit param | MEDIUM |
| 323 | handleServiceStats returns uptime and counters | MEDIUM |
| 324 | handleMetrics returns Prometheus format | MEDIUM |
| 325 | Request log doesn't exceed max entries | MEDIUM |

---

## 9. Server: Standby (`server/gpu-standby.ts`) — 20 tests

| # | Test | Priority |
|---|------|----------|
| 326 | triggerStandbyDeploy starts secondary GPU | HIGH |
| 327 | Standby timer leak tracked and cleared | HIGH |
| 328 | initiateHandover drains primary traffic | HIGH |
| 329 | initiateHandover promotes standby endpoint | HIGH |
| 330 | Old pod terminated with retry on failure | HIGH |
| 331 | Handover resets readiness state | MEDIUM |
| 332 | Standby monitor checks trigger conditions | MEDIUM |
| 333 | cancelStandby cleans up standby pod | HIGH |
| 334 | Standby deploy respects deploy lock | HIGH |
| 335 | Standby error resets to idle after 30s | MEDIUM |

---

## 10. Server: Misc modules — 80 tests

### 10.1 SSH Tunnel (`server/ssh-tunnel.ts`)
| # | Test | Priority |
|---|------|----------|
| 336 | SshTunnel.open spawns SSH process | HIGH |
| 337 | SshTunnel.open returns false on timeout | HIGH |
| 338 | SshTunnel.close sends SIGTERM then SIGKILL | HIGH |
| 339 | closeAllTunnels cleans all active tunnels | HIGH |
| 340 | getOrCreateTunnel reuses existing open tunnel | MEDIUM |
| 341 | Local port wraps at 19999 | LOW |

### 10.2 Speculative Cache (`server/speculative-cache.ts`)
| # | Test | Priority |
|---|------|----------|
| 342 | speculate stores pending translation | HIGH |
| 343 | resolve returns cached result | HIGH |
| 344 | resolve returns null for unknown key | HIGH |
| 345 | Expired entries evicted on speculate | MEDIUM |
| 346 | Max speculations enforced | MEDIUM |

### 10.3 IP Location (`server/ip-location.ts`)
| # | Test | Priority |
|---|------|----------|
| 347 | fetchIpLocation returns location for public IP | MEDIUM |
| 348 | fetchIpLocation returns null for private IP | HIGH |
| 349 | fetchIpLocation caches results | MEDIUM |
| 350 | Cache bounded at IP_CACHE_MAX | HIGH |
| 351 | extractIp extracts from provider metadata | MEDIUM |

### 10.4 File Logger (`server/file-logger.ts`)
| # | Test | Priority |
|---|------|----------|
| 352 | readRecentEvents caps at MAX_READ_LINES | HIGH |
| 353 | readTailLines reads from end for large files | HIGH |
| 354 | readTailLines handles missing file | HIGH |
| 355 | Log rotation at max file size | MEDIUM |

### 10.5 Race Providers (`server/race-providers.ts`)
| # | Test | Priority |
|---|------|----------|
| 356 | raceProviders returns first successful result | HIGH |
| 357 | Losers are aborted via AbortController | HIGH |
| 358 | All timeouts cleaned in finally block | HIGH |
| 359 | Head start gives primary provider advantage | MEDIUM |
| 360 | AggregateError logged when all fail | MEDIUM |

### 10.6 Labs Settings (`server/labs-settings.ts`)
| # | Test | Priority |
|---|------|----------|
| 361 | getLabsFlags returns current flags | MEDIUM |
| 362 | setLabsFlags validates and clamps values | MEDIUM |
| 363 | Flags persist to disk | MEDIUM |
| 364 | Invalid flag types fall back to defaults | MEDIUM |

### 10.7 Deployment State Machine (`server/deployment-state-machine.ts`)
| # | Test | Priority |
|---|------|----------|
| 365 | Transitions idle → deploying → booting → ready | HIGH |
| 366 | markError transitions to error from any state | HIGH |
| 367 | reset transitions to idle | HIGH |
| 368 | Invalid transitions logged as warnings | MEDIUM |
| 369 | onTransition handlers fire on each change | MEDIUM |
| 370 | toJSON serializes current state | MEDIUM |

### 10.8 WS Server (`server/ws-server.ts`)
| # | Test | Priority |
|---|------|----------|
| 371 | WebSocket connection assigns unique ID | HIGH |
| 372 | WebSocket disconnect removes from wsClients | HIGH |
| 373 | Malformed WS messages don't crash server | HIGH |
| 374 | STT streaming session created on stt:start | HIGH |
| 375 | STT streaming session cleaned on disconnect | HIGH |
| 376 | Stale STT session cleanup runs every 60s | HIGH |
| 377 | pauseMs clamped to 50-30000ms | HIGH |
| 378 | Binary audio body transfer via arrayBuffer | HIGH |
| 379 | HTTP status codes propagated correctly | HIGH |
| 380 | CORS headers set on all responses | MEDIUM |

### 10.9 Provider Warmup (`server/provider-warmup.ts`)
| # | Test | Priority |
|---|------|----------|
| 381 | warmupAllGpuModels sends probe requests | MEDIUM |
| 382 | Cloud probe results cached | MEDIUM |
| 383 | Warmup cycle runs every 60s | LOW |

### 10.10 GPU Latency (`server/gpu-latency.ts`)
| # | Test | Priority |
|---|------|----------|
| 384 | probeTcp measures TCP round-trip time | MEDIUM |
| 385 | probeHostFull runs TCP + HTTP probes | MEDIUM |
| 386 | _probing dedup set prevents concurrent probes | HIGH |
| 387 | Probe timeout prevents orphaned dedup entries | HIGH |
| 388 | rankOffers sorts by latency | MEDIUM |

---

## 11. Providers (`src/providers/`) — 150 tests

### 11.1 Groq Provider
| # | Test | Priority |
|---|------|----------|
| 389 | groqSTT.transcribe returns text | HIGH |
| 390 | groqSTT handles 429 rate limit | HIGH |
| 391 | groqSTT handles 500 server error | HIGH |
| 392 | groqSTT handles timeout | HIGH |
| 393 | groqSTT handles empty audio | HIGH |
| 394 | groqLLM.chat returns content | HIGH |
| 395 | groqLLM handles rate limit | HIGH |
| 396 | groqTTS.synthesize returns audio | HIGH |
| 397 | groqTTS handles invalid voice | MEDIUM |
| 398 | Groq models list is accurate | LOW |

### 11.2 OpenAI Provider
| # | Test | Priority |
|---|------|----------|
| 399 | openaiSTT.transcribe with gpt-4o-transcribe | HIGH |
| 400 | openaiSTT handles empty audio gracefully | HIGH |
| 401 | openaiTTS.synthesize returns audio | HIGH |
| 402 | openaiLLM.chat with gpt-4o-mini | HIGH |
| 403 | OpenAI handles 401 unauthorized | HIGH |
| 404 | OpenAI handles 429 rate limit | HIGH |

### 11.3 Fireworks Provider
| # | Test | Priority |
|---|------|----------|
| 405 | fireworksSTT transcribes with whisper-v3 | HIGH |
| 406 | fireworksLLM chat completion | HIGH |
| 407 | Fireworks handles timeout | HIGH |
| 408 | Word timestamps supported | MEDIUM |

### 11.4 OpenRouter Provider
| # | Test | Priority |
|---|------|----------|
| 409 | openrouterLLM.chat routes to model | HIGH |
| 410 | OpenRouter handles model not found | MEDIUM |

### 11.5 Ollama Provider
| # | Test | Priority |
|---|------|----------|
| 411 | ollamaSTT transcribes locally | MEDIUM |
| 412 | ollamaLLM chat completion locally | MEDIUM |
| 413 | Ollama handles connection refused | HIGH |

### 11.6 Modal Providers
| # | Test | Priority |
|---|------|----------|
| 414 | modalTTS synthesize with Qwen3-TTS | HIGH |
| 415 | modalSeamless STT + translation | MEDIUM |
| 416 | modalQwen3ASR pipeline | MEDIUM |
| 417 | modalVoxtral STT | MEDIUM |
| 418 | Modal handles serverless cold start timeout | HIGH |

### 11.7 ElevenLabs Provider
| # | Test | Priority |
|---|------|----------|
| 419 | elevenlabsSTT transcribes with Scribe | MEDIUM |
| 420 | ElevenLabs handles quota exceeded | MEDIUM |

### 11.8 Deepgram Provider
| # | Test | Priority |
|---|------|----------|
| 421 | deepgramSTT transcribes with nova-3 | MEDIUM |
| 422 | Deepgram word timestamps | MEDIUM |

### 11.9 Provider Fallback Chain
| # | Test | Priority |
|---|------|----------|
| 423 | withProviderFallback tries providers in order | HIGH |
| 424 | Skips providers in cooldown | HIGH |
| 425 | Does not record failures in allCooledDown mode | HIGH |
| 426 | Records 402 in credit block tracker | HIGH |
| 427 | Context window fallback inserts upgrade model | MEDIUM |
| 428 | Adaptive timeout adjusts per provider | MEDIUM |
| 429 | Retries per provider with exponential backoff | HIGH |
| 430 | Non-retryable errors (401, 403) skip retries | HIGH |
| 431 | Timeout errors skip retries but count as failure | HIGH |
| 432 | Returns first successful result | HIGH |
| 433 | Throws last error when all providers fail | HIGH |

### 11.10 OpenAI-Compat STT
| # | Test | Priority |
|---|------|----------|
| 434 | Detects WAV audio format | HIGH |
| 435 | Detects MP3 audio format | MEDIUM |
| 436 | Detects OGG audio format | MEDIUM |
| 437 | Returns empty text for empty audio buffer | HIGH |
| 438 | Handles provider API error gracefully | HIGH |

---

## 12. GPU Providers (`src/gpu-providers/`) — 100 tests

### 12.1 RunPod Client
| # | Test | Priority |
|---|------|----------|
| 439 | createInstance creates GPU pod | HIGH |
| 440 | createInstance creates CPU pod | HIGH |
| 441 | createInstance ghost detection (3 retries × 10s) | HIGH |
| 442 | createInstance CPU pod uses 10GB disk max | HIGH |
| 443 | createInstance GPU pod uses 20GB disk min | HIGH |
| 444 | deleteInstance removes pod | HIGH |
| 445 | stopInstance pauses pod | HIGH |
| 446 | startInstance resumes pod | HIGH |
| 447 | listInstances returns all pods | HIGH |
| 448 | resolveEndpoint validates port types | HIGH |
| 449 | resolveEndpoint falls back to proxy URL | HIGH |
| 450 | discoverInstance finds running pod | HIGH |
| 451 | listOffers fetches GPU types via GraphQL | MEDIUM |
| 452 | GPU type whitelist filtering | HIGH |
| 453 | RUNPOD_GPU_TYPE_MAP maps short names correctly | HIGH |
| 454 | Retry logic on transient network errors | HIGH |
| 455 | onInstancePersist callback fires | MEDIUM |

### 12.2 Vast.ai Client
| # | Test | Priority |
|---|------|----------|
| 456 | createInstance creates Vast instance | HIGH |
| 457 | createInstance selects best offer by price | HIGH |
| 458 | createInstance injects Docker Hub credentials | HIGH |
| 459 | deleteInstance terminates instance | HIGH |
| 460 | listInstances returns all instances | HIGH |
| 461 | resolveInstanceEndpoint extracts port mapping | HIGH |
| 462 | Rate limit 429 throws after max retries | HIGH |
| 463 | Rate limit backoff timing correct | MEDIUM |
| 464 | SSH runtype used for all instances | MEDIUM |
| 465 | Region filter applied to offers | MEDIUM |

### 12.3 TensorDock Client
| # | Test | Priority |
|---|------|----------|
| 466 | createInstance creates TensorDock server | MEDIUM |
| 467 | deleteInstance terminates server | MEDIUM |
| 468 | stopInstance pauses server | MEDIUM |
| 469 | startInstance resumes server | MEDIUM |
| 470 | checkBalance returns balance info | MEDIUM |
| 471 | Cloud-init script injects SSH key | MEDIUM |

### 12.4 Deploy Orchestrator
| # | Test | Priority |
|---|------|----------|
| 472 | filterTiers removes providers without keys | HIGH |
| 473 | Tier order respects PROVIDER_CHAIN config | HIGH |
| 474 | buildGpuTiers builds correct tier list | HIGH |

---

## 13. Autoscaler (`src/autoscaler/`) — 80 tests

### 13.1 Engine
| # | Test | Priority |
|---|------|----------|
| 475 | getAutoScaleDecision returns correct action | HIGH |
| 476 | Triggers boot when sessions > threshold | HIGH |
| 477 | Does not boot when already booting | HIGH |
| 478 | Triggers shutdown when sessions = 0 | HIGH |
| 479 | Decision locks serialize per-user calls | HIGH |
| 480 | Stale states reverted on restart | MEDIUM |
| 481 | State persisted after each decision | MEDIUM |

### 13.2 Boot Orchestrator
| # | Test | Priority |
|---|------|----------|
| 482 | startBootHealthPoller polls until healthy | HIGH |
| 483 | Boot timeout resets tier to idle | HIGH |
| 484 | Endpoint resolution during polling | HIGH |
| 485 | cancelBootPollersByPrefix stops all pollers | HIGH |
| 486 | destroyAllPollers cleans up on shutdown | HIGH |
| 487 | Poller map doesn't grow unbounded | HIGH |

### 13.3 Load Balancer
| # | Test | Priority |
|---|------|----------|
| 488 | incrementConnections uses atomic counter | HIGH |
| 489 | decrementConnections never goes below 0 | HIGH |
| 490 | selectTier returns least-loaded tier | HIGH |
| 491 | Weighted random respects weights | MEDIUM |
| 492 | Sticky sessions hash to consistent tier | MEDIUM |
| 493 | reportTierLatency updates EMA | MEDIUM |
| 494 | Token bucket rate limiting | MEDIUM |
| 495 | Priority queue ordering | LOW |

### 13.4 Session Tracker
| # | Test | Priority |
|---|------|----------|
| 496 | reportSessionHeartbeat stores in hash | HIGH |
| 497 | removeSessionHeartbeat removes entry | HIGH |
| 498 | countActiveSessions counts within window | HIGH |
| 499 | Teacher-student aggregation works | MEDIUM |
| 500 | Teacher cache bounded at 10k entries | HIGH |
| 501 | Expired cache entries evicted | HIGH |

### 13.5 Tier Selector
| # | Test | Priority |
|---|------|----------|
| 502 | selectBestTier picks cheapest available | HIGH |
| 503 | Respects region preferences | MEDIUM |
| 504 | Excludes tiers in cooldown | HIGH |
| 505 | Handles empty tier list | MEDIUM |

---

## 14. Tracking (`src/tracking/`) — 30 tests

| # | Test | Priority |
|---|------|----------|
| 506 | SpendTracker.record stores event | HIGH |
| 507 | SpendTracker.record rejects negative costs | HIGH |
| 508 | SpendTracker.record writes to list (rpush) | HIGH |
| 509 | SpendTracker.record updates hash totals | HIGH |
| 510 | SpendTracker.getDailySummary aggregates correctly | HIGH |
| 511 | SpendTracker.getDailySummary groups by provider | HIGH |
| 512 | SpendTracker.getDailySummary groups by stage | HIGH |
| 513 | SpendTracker.checkBudget reports under budget | HIGH |
| 514 | SpendTracker.checkBudget reports over budget | HIGH |
| 515 | SpendTracker.estimateCost uses pricing table | MEDIUM |
| 516 | LatencyTracker records per-stage latency | HIGH |
| 517 | LatencyTracker computes P95 correctly | HIGH |
| 518 | Per-stage ring buffer wraps correctly | HIGH |
| 519 | Stage circuit breaker opens after N violations | HIGH |
| 520 | Stage circuit breaker closes after success | HIGH |

---

## 15. Caching (`src/caching/`) — 20 tests

| # | Test | Priority |
|---|------|----------|
| 521 | ResponseCache.set stores entry | HIGH |
| 522 | ResponseCache.get returns cached value | HIGH |
| 523 | ResponseCache.get returns null for expired | HIGH |
| 524 | ResponseCache.get returns null for unknown key | HIGH |
| 525 | buildKey produces deterministic hash | HIGH |
| 526 | buildKey handles JSON.stringify failure | HIGH |
| 527 | buildKey different for different messages | HIGH |
| 528 | Cache evicts entries past maxSize | HIGH |
| 529 | Cache TTL enforcement | HIGH |
| 530 | Similarity threshold for near-miss hits | MEDIUM |

---

## 16. Auth (`src/auth/`) — 15 tests

| # | Test | Priority |
|---|------|----------|
| 531 | signGpuToken creates valid JWT | HIGH |
| 532 | verifyGpuToken accepts valid token | HIGH |
| 533 | verifyGpuToken rejects expired token | HIGH |
| 534 | verifyGpuToken rejects tampered token | HIGH |
| 535 | verifyGpuToken rejects wrong secret | HIGH |
| 536 | Token has 60s TTL by default | MEDIUM |
| 537 | Token includes custom claims | MEDIUM |

---

## 17. Vault (`src/vault/`) — 20 tests

| # | Test | Priority |
|---|------|----------|
| 538 | Vault.store encrypts secret | HIGH |
| 539 | Vault.retrieve decrypts secret | HIGH |
| 540 | Vault.retrieve returns null for unknown | HIGH |
| 541 | Vault.delete removes secret | HIGH |
| 542 | Vault.list returns all names | HIGH |
| 543 | rotateKey re-encrypts all secrets | HIGH |
| 544 | rotateKey rollback uses proper decryption | HIGH |
| 545 | AES-256-GCM encryption verified | MEDIUM |
| 546 | Different IVs for same plaintext | MEDIUM |
| 547 | Auth tag verified during decryption | HIGH |
| 548 | Tampered ciphertext throws error | HIGH |

---

## 18. Proxy (`src/proxy/`) — 25 tests

| # | Test | Priority |
|---|------|----------|
| 549 | startProxy starts Bun HTTP server | HIGH |
| 550 | Routes /v1/chat/completions to LLM provider | HIGH |
| 551 | Routes /v1/audio/transcriptions to STT provider | HIGH |
| 552 | Routes /health to health check | HIGH |
| 553 | Returns 401 for missing API key when configured | HIGH |
| 554 | Returns 401 for invalid API key | HIGH |
| 555 | Accepts request with valid API key | HIGH |
| 556 | Rate limiting returns 429 | HIGH |
| 557 | Rate limiting allows requests under limit | HIGH |
| 558 | Request coalescing deduplicates identical requests | MEDIUM |
| 559 | Semaphore limits concurrent requests | MEDIUM |
| 560 | Proxy passes through provider response format | HIGH |
| 561 | Proxy handles provider timeout | HIGH |
| 562 | Proxy handles provider 500 | HIGH |
| 563 | CORS headers set correctly | MEDIUM |

---

## 19. Database (`src/database/`) — 25 tests

| # | Test | Priority |
|---|------|----------|
| 564 | NeonManagement.getProject returns project info | HIGH |
| 565 | NeonManagement.listBranches returns branches | HIGH |
| 566 | NeonManagement.createBranch creates new branch | HIGH |
| 567 | NeonManagement.deleteBranch removes branch | HIGH |
| 568 | NeonManagement.listEndpoints returns endpoints | HIGH |
| 569 | NeonManagement.getBranchConnectionUri returns URI | HIGH |
| 570 | NeonManagement.listDatabases returns databases | MEDIUM |
| 571 | NeonManagement.createDatabase creates DB | MEDIUM |
| 572 | NeonManagement handles API errors | HIGH |
| 573 | NeonManagement handles auth errors | HIGH |
| 574 | PgDriver.query executes parameterized SQL | HIGH |
| 575 | PgDriver.query handles connection errors | HIGH |
| 576 | DatabaseError has correct code | MEDIUM |

---

## 20. SDK (`src/sdk/client.ts`, `sdk/node/`) — 60 tests

### 20.1 GatewaySDK (TypeScript)
| # | Test | Priority |
|---|------|----------|
| 577 | transcribe sends audio and returns text | HIGH |
| 578 | transcribe falls back to Groq on network error | HIGH |
| 579 | transcribe does NOT fallback when groqApiKey empty | HIGH |
| 580 | chat sends messages and returns content | HIGH |
| 581 | chat falls back to Groq on network error | HIGH |
| 582 | translate sends text and returns translation | HIGH |
| 583 | pipeline sends audio and returns full result | HIGH |
| 584 | generateAudio sends text and returns WAV | HIGH |
| 585 | deployGpu sends deploy request | HIGH |
| 586 | gpuStatus returns current status | HIGH |
| 587 | terminateGpu sends terminate request | HIGH |
| 588 | waitForGpu polls until ready | HIGH |
| 589 | waitForGpu throws on error status | HIGH |
| 590 | waitForGpu throws on timeout | HIGH |
| 591 | stopGpu sends stop request | MEDIUM |
| 592 | resumeGpu sends resume request | MEDIUM |
| 593 | listWorkloads returns workload list | HIGH |
| 594 | deployWorkload creates new workload | HIGH |
| 595 | workloadStatus returns status | HIGH |
| 596 | stopWorkload stops workload | HIGH |
| 597 | startWorkload resumes workload | HIGH |
| 598 | terminateWorkload deletes workload | HIGH |
| 599 | Retry on network error (4 retries) | HIGH |
| 600 | No retry on HTTP 4xx errors | HIGH |
| 601 | No retry on timeout errors | HIGH |
| 602 | GatewayError includes statusCode and endpoint | MEDIUM |

### 20.2 GatewayHttpClient (Node SDK)
| # | Test | Priority |
|---|------|----------|
| 603 | health returns healthy status | HIGH |
| 604 | health returns unhealthy on error | HIGH |
| 605 | transcribe returns text | HIGH |
| 606 | chat returns content | HIGH |
| 607 | translate returns translatedText | HIGH |
| 608 | Circuit breaker opens after N failures | HIGH |
| 609 | Circuit breaker recovers in half_open | HIGH |
| 610 | Circuit breaker resets after successes | HIGH |
| 611 | Request ID header sent | MEDIUM |
| 612 | close() prevents further requests | MEDIUM |

---

## 21. Ensemble STT (`src/ensemble-stt.ts`) — 15 tests

| # | Test | Priority |
|---|------|----------|
| 613 | Races multiple providers, returns first success | HIGH |
| 614 | Returns error when all providers fail | HIGH |
| 615 | Deadline timers cleaned after race | HIGH |
| 616 | Provider with no models is rejected | MEDIUM |
| 617 | Empty response triggers provider error | MEDIUM |
| 618 | Winning provider latency logged | LOW |
| 619 | Timeout configured per-provider | MEDIUM |

---

## 22. Streaming STT (`src/streaming-stt.ts`) — 15 tests

| # | Test | Priority |
|---|------|----------|
| 620 | StreamingSTTRouter.createBackend returns backend | HIGH |
| 621 | Excludes providers in excludeProviders set | HIGH |
| 622 | Returns null when no providers available | HIGH |
| 623 | Backend connects via WebSocket | HIGH |
| 624 | Backend fires onTranscript callback | HIGH |
| 625 | Backend fires onDisconnected callback | HIGH |
| 626 | Backend.close cleans up WebSocket | HIGH |
| 627 | Provider order respects config | MEDIUM |

---

## 23. Language Detection (`src/language-detect.ts`) — 10 tests

| # | Test | Priority |
|---|------|----------|
| 628 | Detects French | HIGH |
| 629 | Detects English | HIGH |
| 630 | Detects Portuguese | HIGH |
| 631 | Detects Spanish | MEDIUM |
| 632 | Returns confidence score | MEDIUM |
| 633 | Handles empty string | MEDIUM |
| 634 | Handles very short text | MEDIUM |

---

## 24. State Management (`server/state.ts`) — 25 tests

| # | Test | Priority |
|---|------|----------|
| 635 | setDeployState updates deploy state | HIGH |
| 636 | setDeployState broadcasts to WS clients | HIGH |
| 637 | setDeployState tracks transitions | HIGH |
| 638 | Transitions array capped at 30 (splice) | HIGH |
| 639 | resetDeployState clears all state | HIGH |
| 640 | resetDeployState sets deployCancelled=true | HIGH |
| 641 | resetDeployState resets TTS warmth | MEDIUM |
| 642 | resetDeployState resets GPU readiness | MEDIUM |
| 643 | isGpuAvailable returns true when ready+healthy | HIGH |
| 644 | Active deploy persisted to disk | MEDIUM |
| 645 | Persisted deploy restored on startup | MEDIUM |
| 646 | noopPrisma returns empty results | MEDIUM |
| 647 | Budget tracking resets at midnight UTC | HIGH |

---

## 25. SSE Streaming (`server/ai-handlers-stream.ts`) — 15 tests

| # | Test | Priority |
|---|------|----------|
| 648 | handlePipelineSSE returns SSE headers | HIGH |
| 649 | SSE events fire for each pipeline stage | HIGH |
| 650 | SSE complete event includes timing | HIGH |
| 651 | SSE error event includes stage and message | HIGH |
| 652 | Client disconnect stops pipeline (clientClosed) | HIGH |
| 653 | safeSseWrite does not throw on closed response | HIGH |
| 654 | FormData multipart parsing extracts audio | MEDIUM |

---

## 26. Integration: Full Pipeline E2E — 40 tests

| # | Test | Priority |
|---|------|----------|
| 655 | E2E: French audio → English text + audio (cloud) | HIGH |
| 656 | E2E: English audio → Portuguese text + audio (cloud) | HIGH |
| 657 | E2E: Pipeline with GPU STT only | HIGH |
| 658 | E2E: Pipeline with GPU all stages | HIGH |
| 659 | E2E: Pipeline falls back to cloud on GPU error | HIGH |
| 660 | E2E: 10 concurrent pipeline requests | HIGH |
| 661 | E2E: Pipeline with speculative cache hit | MEDIUM |
| 662 | E2E: Pipeline SSE streaming | HIGH |
| 663 | E2E: Deploy GPU → wait ready → pipeline → terminate | HIGH |
| 664 | E2E: Deploy bot → join meeting → leave → terminate | MEDIUM |
| 665 | E2E: Deploy workload → status → stop → start → terminate | HIGH |
| 666 | E2E: Config profile switch → pipeline uses new profile | MEDIUM |
| 667 | E2E: API key rotation → requests still work | MEDIUM |
| 668 | E2E: Budget limit reached → GPU auto-terminated | HIGH |
| 669 | E2E: Idle timeout → GPU auto-stopped | HIGH |
| 670 | E2E: Auto-destroy after idle stop | HIGH |

---

## 27. Security Tests — 40 tests

| # | Test | Priority |
|---|------|----------|
| 671 | JSON body limited to 2MB | HIGH |
| 672 | Audio body limited to 50MB | HIGH |
| 673 | SSRF: private IP rejected in bot meetingUrl | HIGH |
| 674 | SSRF: localhost rejected | HIGH |
| 675 | SSRF: 127.0.0.1 rejected | HIGH |
| 676 | SSRF: 10.x.x.x rejected | HIGH |
| 677 | SSRF: 192.168.x.x rejected | HIGH |
| 678 | Host header not used in URL parsing | HIGH |
| 679 | API keys masked in /v1/config/api-keys response | HIGH |
| 680 | API keys not in error messages | HIGH |
| 681 | API keys not in server logs | HIGH |
| 682 | Vault encryption uses random IV per secret | HIGH |
| 683 | Vault auth tag verified on decrypt | HIGH |
| 684 | Vault rollback uses proper decryption | HIGH |
| 685 | Token expiry enforced | HIGH |
| 686 | Token tampering detected | HIGH |
| 687 | Rate limiting enforced per client | HIGH |
| 688 | No SQL injection via provider names | MEDIUM |
| 689 | No command injection via GPU type names | MEDIUM |
| 690 | No path traversal in config file paths | MEDIUM |

---

## 28. Resilience Tests — 40 tests

| # | Test | Priority |
|---|------|----------|
| 691 | Server handles 1000 concurrent requests | HIGH |
| 692 | Server recovers from OOM allocation failure | MEDIUM |
| 693 | Deploy continues after Groq 429 | HIGH |
| 694 | Deploy continues after OpenAI 500 | HIGH |
| 695 | Deploy falls back after RunPod ghost machine | HIGH |
| 696 | Deploy falls back after Vast.ai 429 exhaustion | HIGH |
| 697 | Monitor recovers after 5 consecutive failures | HIGH |
| 698 | Circuit breaker opens and recovers | HIGH |
| 699 | Provider cooldown expires correctly | HIGH |
| 700 | SSH tunnel reconnects on failure | MEDIUM |
| 701 | Bot audio relay reconnects on disconnect | MEDIUM |
| 702 | Config persists after crash (atomic write) | HIGH |
| 703 | Deploy state persists after crash | MEDIUM |
| 704 | Orphan sweep cleans pods after crash | HIGH |
| 705 | Budget enforcement survives restart | HIGH |
| 706 | WebSocket broadcast handles slow clients | HIGH |
| 707 | STT session cleanup removes stale entries | HIGH |
| 708 | Multiple rapid deploys don't deadlock | HIGH |
| 709 | Cancel during deploy doesn't leave orphans | HIGH |
| 710 | Standby handover doesn't cause dual billing | HIGH |

---

## 29. Performance Tests — 30 tests

| # | Test | Priority |
|---|------|----------|
| 711 | Health endpoint responds in <50ms | HIGH |
| 712 | Chat completion P50 <500ms | HIGH |
| 713 | Chat completion P95 <2000ms | HIGH |
| 714 | STT transcription P50 <1000ms | HIGH |
| 715 | Pipeline P50 <3000ms | HIGH |
| 716 | 100 concurrent chat requests <5s total | HIGH |
| 717 | 100 concurrent STT requests <10s total | HIGH |
| 718 | Memory stable under sustained 100 VU load | MEDIUM |
| 719 | No memory growth over 1000 sequential requests | MEDIUM |
| 720 | Speculative cache hit rate >80% for repeated | MEDIUM |
| 721 | Provider warmup reduces cold start latency | MEDIUM |
| 722 | GPU readiness benchmark completes <30s | MEDIUM |
| 723 | Latency ring buffer O(1) insert and read | LOW |
| 724 | Config load uses cache within TTL | MEDIUM |

---

## 30. Edge Cases — 60 tests

| # | Test | Priority |
|---|------|----------|
| 725 | Empty audio file (0 bytes) handled | HIGH |
| 726 | Extremely large audio file (100MB) rejected | HIGH |
| 727 | UTF-8 text with emojis in chat | MEDIUM |
| 728 | Unicode text in translation | MEDIUM |
| 729 | Very long text (>50KB) in chat | MEDIUM |
| 730 | Empty messages array in chat | HIGH |
| 731 | Messages with only system role | MEDIUM |
| 732 | Messages with 100+ entries | MEDIUM |
| 733 | GPU deploy with invalid GPU type name | HIGH |
| 734 | GPU deploy with empty gpuTypes array | HIGH |
| 735 | GPU deploy with Docker image that doesn't exist | HIGH |
| 736 | GPU status when no deploy ever started | HIGH |
| 737 | GPU terminate when no pod exists | HIGH |
| 738 | Bot deploy without meeting URL | HIGH |
| 739 | Bot join with malformed URL | HIGH |
| 740 | Config save with very large profile | MEDIUM |
| 741 | Config save with special characters in keys | MEDIUM |
| 742 | Workload deploy with empty config | HIGH |
| 743 | Workload deploy with type 'unknown' | HIGH |
| 744 | SDK retry with rapidly alternating success/fail | MEDIUM |
| 745 | SDK handles 0-byte response body | MEDIUM |
| 746 | SDK handles non-JSON response | MEDIUM |
| 747 | Deploy during another deploy's cleanup | HIGH |
| 748 | Terminate during active health probe | HIGH |
| 749 | Resume a pod that was auto-destroyed | HIGH |
| 750 | Two simultaneous pipeline requests same audio | MEDIUM |

---

## 31. Provider-Specific Edge Cases — 50 tests

| # | Test | Priority |
|---|------|----------|
| 751 | RunPod: pod name collision prevention | MEDIUM |
| 752 | RunPod: COMMUNITY vs SECURE cloud type | HIGH |
| 753 | RunPod: interruptible spot instance handling | MEDIUM |
| 754 | RunPod: pod EXITED auto-restart | HIGH |
| 755 | RunPod: balance check before deploy | HIGH |
| 756 | Vast.ai: offer selection prefers reliability | MEDIUM |
| 757 | Vast.ai: SSH tunnel failure during boot | HIGH |
| 758 | Vast.ai: Docker Hub auth injected | HIGH |
| 759 | Vast.ai: port mapping extraction | HIGH |
| 760 | Vast.ai: instance vanished during startup | HIGH |
| 761 | TensorDock: balance below $1 excluded | HIGH |
| 762 | TensorDock: cloud-init SSH key injection | MEDIUM |
| 763 | Modal: serverless cold start handling | HIGH |
| 764 | Modal: app cleanup on terminate | HIGH |
| 765 | Fly.io: machine auto-stop/auto-start | MEDIUM |
| 766 | Fly.io: instance targeting via headers | MEDIUM |
| 767 | Groq: credit exhaustion (402) handling | HIGH |
| 768 | Groq: model not found error | MEDIUM |
| 769 | OpenAI: quota exceeded handling | HIGH |
| 770 | Fireworks: timeout on large audio | MEDIUM |

---

## 32. Config Profile Tests — 30 tests

| # | Test | Priority |
|---|------|----------|
| 771 | Default profiles are well-formed | HIGH |
| 772 | realtime-translation-dubbing profile has STT+LLM+TTS | HIGH |
| 773 | subtitles-only profile has STT+LLM but no TTS | HIGH |
| 774 | cloud-only profile has no GPU deploy config | HIGH |
| 775 | Profile activation changes runtime providers | HIGH |
| 776 | Profile deactivation reverts to defaults | HIGH |
| 777 | Profile creation persists to disk | HIGH |
| 778 | Profile deletion removes from disk | HIGH |
| 779 | Cannot delete active profile | MEDIUM |
| 780 | Profile with custom docker image | MEDIUM |
| 781 | Profile with custom GPU types | MEDIUM |
| 782 | Profile with custom voice mapping | MEDIUM |

---

## 33. WebSocket Tests — 30 tests

| # | Test | Priority |
|---|------|----------|
| 783 | WS connect assigns unique ID | HIGH |
| 784 | WS receives gpu:status on connect | HIGH |
| 785 | WS receives gpu:transition on state change | HIGH |
| 786 | WS receives provider:status on change | MEDIUM |
| 787 | WS receives gpu:idle warning | MEDIUM |
| 788 | WS receives bot:status updates | MEDIUM |
| 789 | WS disconnect removes from clients set | HIGH |
| 790 | WS broadcast doesn't mutate set during iteration | HIGH |
| 791 | WS stt:start creates streaming backend | HIGH |
| 792 | WS stt:stop closes streaming backend | HIGH |
| 793 | WS stt:data sends audio to backend | HIGH |
| 794 | WS handles binary audio messages | HIGH |
| 795 | WS handles malformed JSON messages | HIGH |
| 796 | WS timeout on inactive connections | MEDIUM |

---

## 34. Docker Image Tests — 20 tests

| # | Test | Priority |
|---|------|----------|
| 797 | babelcast-subtitle image name in catalog | MEDIUM |
| 798 | babelcast-translategemma image name in catalog | MEDIUM |
| 799 | babelcast-mistral image name in catalog | MEDIUM |
| 800 | babelcast-qwen3-tts image name in catalog | MEDIUM |
| 801 | Image name resolves for RTX 5090 (Blackwell) | HIGH |
| 802 | Image name resolves for RTX 4090 (Ada) | HIGH |
| 803 | Image name resolves for RTX 3090 (Ampere) | HIGH |
| 804 | Docker inspect returns image metadata | MEDIUM |
| 805 | Catalog endpoint returns all images | MEDIUM |

---

## 35. Deployment State Machine Tests — 15 tests

| # | Test | Priority |
|---|------|----------|
| 806 | idle → deploying transition | HIGH |
| 807 | deploying → booting transition | HIGH |
| 808 | booting → ready transition | HIGH |
| 809 | Any → error transition | HIGH |
| 810 | error → idle (reset) | HIGH |
| 811 | ready → idle (reset) | HIGH |
| 812 | Invalid transition logged | MEDIUM |
| 813 | Transition handlers fire | MEDIUM |
| 814 | toJSON includes all fields per phase | MEDIUM |
| 815 | Singleton instance shared across modules | MEDIUM |

---

## 36-40. Remaining Tests (816-1000) — Stress, Regression, Smoke

### 36. Stress Tests
| # | Test | Priority |
|---|------|----------|
| 816 | 500 concurrent chat requests | MEDIUM |
| 817 | 200 concurrent STT uploads | MEDIUM |
| 818 | 50 concurrent pipeline requests | MEDIUM |
| 819 | 1000 sequential health checks | LOW |
| 820 | 100 rapid deploy/terminate cycles | MEDIUM |
| 821 | 100 profile switch cycles | LOW |
| 822 | 1000 WS connect/disconnect cycles | MEDIUM |
| 823 | Memory stable after 10000 requests | MEDIUM |
| 824 | No file descriptor leak after 1000 SSE streams | MEDIUM |
| 825 | Latency stable under sustained 50 VU | MEDIUM |

### 37. Regression Tests (previously fixed bugs)
| # | Test | Priority |
|---|------|----------|
| 826 | Binary audio not corrupted by req.text() | HIGH |
| 827 | HTTP 400 not returned as 200 | HIGH |
| 828 | deployCancelled reset between deploys | HIGH |
| 829 | Monitor reschedules in finally | HIGH |
| 830 | Warmth monitor uses stopWarmthMonitor() | HIGH |
| 831 | Budget uses actual elapsed, not monitorDelayMs | HIGH |
| 832 | Orphan sweep initial timer tracked | HIGH |
| 833 | broadcastWs collect-then-delete | HIGH |
| 834 | SSH tunnel SIGKILL fallback | HIGH |
| 835 | closeAllTunnels called on terminate | HIGH |
| 836 | STT sessions cleaned periodically | HIGH |
| 837 | Race deploy try/finally cleanup | HIGH |
| 838 | Negative spend rejected | HIGH |
| 839 | Connection count atomic | HIGH |
| 840 | Boot timeout resets to idle | HIGH |
| 841 | Cooldown bypass skips recordFailure | HIGH |
| 842 | Teacher cache bounded | HIGH |
| 843 | Config atomic write (tmp+rename) | HIGH |
| 844 | Latency ring no off-by-one | HIGH |
| 845 | Vast 429 throws, not returns | HIGH |
| 846 | Pipeline null guard on baseProfile | HIGH |
| 847 | RunPod port type validation | HIGH |
| 848 | Standby timer tracked and cleared | HIGH |
| 849 | Standby old pod terminate with retry | HIGH |
| 850 | Empty audio returns empty text | HIGH |
| 851 | IP cache bounded at 5k | HIGH |
| 852 | Probe dedup timeout in finally | HIGH |
| 853 | Ensemble deadline timers cleared | HIGH |
| 854 | SSE stream aborted on client close | HIGH |
| 855 | Error messages sanitized (no internal details) | HIGH |
| 856 | pauseMs clamped 50-30000 | HIGH |
| 857 | Deploy cleanup failure stops deploy | HIGH |
| 858 | JSON body 2MB limit enforced | HIGH |
| 859 | Host header not used in URL parsing | HIGH |
| 860 | Vault rollback decrypts properly | HIGH |
| 861 | File logger caps lines and bytes | HIGH |
| 862 | Bot cleanup includes Scaleway | HIGH |
| 863 | Bot audio relay collect-then-delete | HIGH |
| 864 | Spend tracker rpush+ltrim preserved | HIGH |

### 38. Smoke Tests (quick validation)
| # | Test | Priority |
|---|------|----------|
| 865 | Server starts without errors | HIGH |
| 866 | Health endpoint responds | HIGH |
| 867 | Chat endpoint responds | HIGH |
| 868 | STT endpoint responds | HIGH |
| 869 | GPU status endpoint responds | HIGH |
| 870 | Workloads endpoint responds | HIGH |
| 871 | Config endpoints respond | HIGH |
| 872 | Bot status endpoint responds | HIGH |
| 873 | Metrics endpoint responds | MEDIUM |
| 874 | All WS commands accepted | MEDIUM |

### 39. Cross-Provider Tests
| # | Test | Priority |
|---|------|----------|
| 875 | STT fallback: Groq → OpenAI → Fireworks | HIGH |
| 876 | LLM fallback: Groq → Fireworks → OpenRouter | HIGH |
| 877 | TTS fallback: Modal → Groq → OpenAI | HIGH |
| 878 | Mixed pipeline: Groq STT + Fireworks LLM + Modal TTS | HIGH |
| 879 | Credit exhaustion triggers next provider | HIGH |
| 880 | Rate limit triggers next provider | HIGH |
| 881 | All providers fail returns correct error | HIGH |
| 882 | Provider metrics tracked per-provider | MEDIUM |
| 883 | Provider latency recorded per-stage | MEDIUM |
| 884 | Adaptive timeout adjusts from latency history | MEDIUM |

### 40. Multi-User / Concurrency Tests
| # | Test | Priority |
|---|------|----------|
| 885 | Two users deploy GPUs simultaneously | HIGH |
| 886 | User A's terminate doesn't affect User B | HIGH |
| 887 | Concurrent config updates don't corrupt | HIGH |
| 888 | Per-user session tracking independent | MEDIUM |
| 889 | Per-user budget enforcement independent | HIGH |
| 890 | Rate limiting per-API-key | HIGH |
| 891 | Concurrent workload operations on same name | HIGH |
| 892 | Concurrent bot deploys blocked by lock | HIGH |
| 893 | Concurrent pipeline requests share GPU | MEDIUM |
| 894 | WebSocket broadcasts reach all clients | MEDIUM |

### 41. Database Integration Tests
| # | Test | Priority |
|---|------|----------|
| 895 | Connect to Neon database | HIGH |
| 896 | Create and list branches | HIGH |
| 897 | Create and list databases | HIGH |
| 898 | Get connection URI | HIGH |
| 899 | Backup via branch snapshot | MEDIUM |
| 900 | Restore from branch | MEDIUM |
| 901 | Handle Neon API errors | HIGH |
| 902 | Handle network timeout to Neon | HIGH |
| 903 | Gateway works without database (noop proxy) | HIGH |
| 904 | GPU event logging to database | MEDIUM |

### 42. Fly.io Deployment Tests
| # | Test | Priority |
|---|------|----------|
| 905 | Cold start from auto_stop | HIGH |
| 906 | Health check passes after cold start | HIGH |
| 907 | Rolling deploy maintains availability | HIGH |
| 908 | Zero-downtime deploy <20% error rate | HIGH |
| 909 | Machine auto-stop after idle | MEDIUM |
| 910 | Machine auto-start on request | MEDIUM |

### 43. GPU Image Compatibility Tests
| # | Test | Priority |
|---|------|----------|
| 911 | babelcast-subtitle on RTX 4090 | HIGH |
| 912 | babelcast-translategemma on RTX 4090 | HIGH |
| 913 | babelcast-mistral on RTX 4090 | HIGH |
| 914 | GPU image /health returns services status | HIGH |
| 915 | GPU image STT endpoint works | HIGH |
| 916 | GPU image LLM endpoint works | HIGH |
| 917 | GPU image TTS endpoint works | HIGH |
| 918 | GPU image model loading within 5min | HIGH |

### 44. SDK Python Compatibility Tests
| # | Test | Priority |
|---|------|----------|
| 919 | Python SDK health check | MEDIUM |
| 920 | Python SDK transcribe | MEDIUM |
| 921 | Python SDK translate | MEDIUM |
| 922 | Python SDK pipeline | MEDIUM |
| 923 | Python SDK deploy/terminate GPU | MEDIUM |
| 924 | Python SDK response format matches TypeScript | MEDIUM |

### 45. Observability Tests
| # | Test | Priority |
|---|------|----------|
| 925 | Prometheus metrics include request count | MEDIUM |
| 926 | Prometheus metrics include latency histogram | MEDIUM |
| 927 | Prometheus metrics include error rate | MEDIUM |
| 928 | Distributed tracing context propagated | LOW |
| 929 | Request log includes all required fields | MEDIUM |
| 930 | Service stats include uptime and counters | MEDIUM |

### 46. Error Recovery Tests
| # | Test | Priority |
|---|------|----------|
| 931 | Server recovers from uncaught exception | HIGH |
| 932 | Server logs unhandled rejection | HIGH |
| 933 | GPU monitor restarts after crash | HIGH |
| 934 | Config reload after corrupt file | HIGH |
| 935 | Provider re-initializes after key rotation | MEDIUM |
| 936 | Database reconnect after connection drop | MEDIUM |
| 937 | WebSocket server handles client flood | MEDIUM |
| 938 | File logger handles full disk | MEDIUM |
| 939 | SSH tunnel recovers from network change | MEDIUM |
| 940 | Cooldown file handles corruption | MEDIUM |

### 47. API Contract Tests
| # | Test | Priority |
|---|------|----------|
| 941 | /v1/chat/completions matches OpenAI spec | HIGH |
| 942 | /v1/audio/transcriptions matches OpenAI spec | HIGH |
| 943 | /health response schema stable | HIGH |
| 944 | /v1/gpu/status response schema stable | HIGH |
| 945 | /v1/workloads response schema stable | HIGH |
| 946 | Error response format consistent | HIGH |
| 947 | All endpoints return JSON Content-Type | HIGH |
| 948 | All endpoints support CORS | MEDIUM |
| 949 | All POST endpoints reject wrong Content-Type | MEDIUM |
| 950 | All endpoints include X-Request-ID | LOW |

### 48. Browser/Client Tests
| # | Test | Priority |
|---|------|----------|
| 951 | Browser speech client connects | MEDIUM |
| 952 | WebRTC offer/answer exchange | MEDIUM |
| 953 | Audio capture and send | MEDIUM |
| 954 | Transcript received via callback | MEDIUM |
| 955 | Translation received via callback | MEDIUM |
| 956 | Audio playback via callback | MEDIUM |
| 957 | Client reconnects on disconnect | MEDIUM |
| 958 | Client handles server restart | MEDIUM |

### 49. Migration / Upgrade Tests
| # | Test | Priority |
|---|------|----------|
| 959 | Old config format migrated to new | MEDIUM |
| 960 | Old cooldown file format handled | MEDIUM |
| 961 | Old deploy persist format handled | MEDIUM |
| 962 | SDK backward compatible with older gateway | MEDIUM |
| 963 | Gateway backward compatible with older SDK | MEDIUM |

### 50. Final Coverage Tests (964-1000)
| # | Test | Priority |
|---|------|----------|
| 964 | Every exported function has at least one test | MEDIUM |
| 965 | Every error path has at least one test | HIGH |
| 966 | Every provider has success + error tests | HIGH |
| 967 | Every GPU provider has CRUD tests | HIGH |
| 968 | Every handler validates required params | HIGH |
| 969 | Every handler returns correct status codes | HIGH |
| 970 | Every handler sanitizes error messages | HIGH |
| 971 | Every timer is properly tracked and cleaned | HIGH |
| 972 | Every Map/Set has bounded growth | HIGH |
| 973 | Every file write is atomic | HIGH |
| 974 | Every cache has TTL or max size | HIGH |
| 975 | Every WebSocket broadcast is safe | HIGH |
| 976 | Every Promise has error handling | HIGH |
| 977 | Every external API call has timeout | HIGH |
| 978 | Every user input is validated | HIGH |
| 979 | Every secret is masked in logs | HIGH |
| 980 | Every cleanup path is exercised | HIGH |
| 981 | Resource lifecycle test: all 37 assertions pass | HIGH |
| 982 | Default test suite: 0 failures | HIGH |
| 983 | Live test suite (local): 0 failures | HIGH |
| 984 | Live test suite (Fly.io): 0 failures | HIGH |
| 985 | Load test: 100 concurrent requests pass | HIGH |
| 986 | Network stress: all edge cases handled | HIGH |
| 987 | RunPod lifecycle: CPU pod create/delete | HIGH |
| 988 | Vast.ai deploy: full lifecycle | HIGH |
| 989 | Config: save/load roundtrip | HIGH |
| 990 | Vault: encrypt/decrypt roundtrip | HIGH |
| 991 | Auth: sign/verify roundtrip | HIGH |
| 992 | Cache: set/get/evict cycle | HIGH |
| 993 | Spend: record/summarize/budget cycle | HIGH |
| 994 | Pipeline: audio → text → audio roundtrip | HIGH |
| 995 | Workload: deploy → status → stop → start → terminate | HIGH |
| 996 | Bot: deploy → join → leave → terminate | HIGH |
| 997 | GPU: deploy → ready → idle → stop → resume → terminate | HIGH |
| 998 | Fallback: primary fail → secondary succeed | HIGH |
| 999 | Ensemble: race 3 providers → best wins | HIGH |
| 1000 | Full system: startup → requests → shutdown clean | HIGH |

---

## Summary

| Priority | Count |
|----------|-------|
| HIGH | 612 |
| MEDIUM | 298 |
| LOW | 90 |
| **Total** | **1000** |

| Category | Tests |
|----------|-------|
| Server handlers | 310 |
| GPU deploy & lifecycle | 150 |
| Providers (AI + GPU) | 200 |
| Autoscaler & tracking | 110 |
| SDK & client | 60 |
| Security | 40 |
| Resilience | 40 |
| Performance | 30 |
| Edge cases | 60 |
| **Total** | **1000** |
