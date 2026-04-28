# AI Gateway — Claude Code Guidelines

## Domain model & design docs

Before implementing any feature, read:
- [`docs/domain-model.md`](docs/domain-model.md) — ubiquitous language, bounded contexts, states, events
- [`docs/sdd.md`](docs/sdd.md) — architectural decisions, module responsibilities, what NOT to do
- [`docs/adr/`](docs/adr/) — Architecture Decision Records (ADRs)

Use the vocabulary from `domain-model.md` in all code and prompts. Respect the boundaries in `sdd.md`.

## What this is

**AI Gateway** is a self-hosted, cost-efficient AI infrastructure platform that provides:

1. **Speech-to-Speech Translation** — Real-time multilingual audio translation via STT → LLM → TTS pipeline
2. **GPU Deployment & Management** — Multi-provider cascade deploy (RunPod → Vast.ai → TensorDock → Modal) with auto-scaling, idle management, and crash recovery
3. **AI Provider Abstraction** — Unified interface over Groq, OpenAI, Fireworks, OpenRouter, Ollama, Deepgram, and self-hosted GPUs
4. **Hybrid Routing** — Race GPU vs cloud, auto-select cheapest, latency-based demotion, canary deployments
5. **Observability** — Request logging, provider metrics, latency tracking, circuit breakers, Prometheus metrics

**Pipeline:** `Audio → STT → LLM (translation) → TTS → Audio`
**Transport hidden from callers** — callers don't know if GPU or cloud is used; gateway decides based on cost/latency/availability.
**`src/`** is the publishable library (tree-shakeable); **`server/`** is the reference HTTP service.

## Features

### 1. Core AI Pipeline (STT → LLM → TTS)

- **Speech-to-Speech Translation** — `POST /v1/speech`: audio in, JSON with transcription + translation + audio out
- **STT** (Speech-to-Text): Whisper via Groq, OpenAI, Deepgram, Fireworks, Ollama. Supports rolling prior-segment context, LLM-expanded domain prompts, glossary term injection, word timestamps
- **LLM** (Translation): Chat completion via Groq, Fireworks, OpenRouter, Ollama. Translation cache (LRU) for repeated phrases, adaptive max tokens
- **TTS** (Text-to-Speech): Audio synthesis via Groq, OpenAI, Modal (MOSS-TTS), Canopy Labs Orpheus, Kokoro. Voice clone support with reference audio + text conditioning
- **Hybrid Routing**: GPU vs cloud per-stage with request racing (GPU + cloud fire in parallel, fastest wins)
- **Streaming Overlap**: LLM tokens fed to TTS before full response completes (~100-200ms latency reduction)
- **Dub Fanout**: 1→N parallel translations + TTS for multiple target languages
- **Voice Cloning**: TTS conditioned by reference audio + text (forces hybrid GPU path)
- **Hallucination Filter**: STT output filtering via metadata (no-speech-prob, compression ratio, avg-logprob) and blocklist
- **Ensemble STT**: Parallel multi-provider STT race (Groq + OpenAI + Deepgram + Fireworks + Whisper)

### 2. GPU Deployment & Management

- **Multi-Provider Cascade**: Deploy across RunPod → Vast.ai → TensorDock → Modal in tier cascade (first success wins)
- **Race Deploy**: Fire N instances in parallel, use first ready, cancel others (reduces P99 cold start)
- **GPU Type Allowlist**: Only tested/approved GPUs permitted (RTX 5090, 4090, A6000, L40S, A5000, A40)
- **VRAM Validation**: Pre-deploy check GPU has enough VRAM for detected model size (200B, 70B, 32B, 13B, 7B, 3B classes)
- **Cost Estimation**: Pre-deploy estimate based on cheapest matching offer; runtime hours from balance
- **Balance Pre-Flight**: Check RunPod, TensorDock, Vast.ai balances before deploy; exclude providers with < $1 balance
- **Auto-Select Cheapest GPU**: Query available offers, rank by price/VRAM/latency, select optimal
- **Deploy Lock**: Prevents concurrent deploy operations
- **Idempotent Retries**: Identical deploy request within 5s returns existing deployId
- **Cancel-and-Redeploy**: Automatically cancels in-progress deploy before starting new one
- **Per-Deploy Cost Cap**: `maxCostUsd` param rejects deploy if estimated hourly cost exceeds threshold
- **Pod Lifecycle**: Start → deploying → booting → installing → ready | error | stopped → terminated
- **Stop/Resume/Terminate**: Full pod lifecycle management via HTTP endpoints
- **SSH Tunnel Support**: Vast.ai SSH proxy for providers without direct HTTP access
- **Network Volumes**: RunPod network volume attachment for persistent GGUF cache
- **Container Disk**: Configurable container disk size (0-100GB)
- **Onstart Command**: Custom Docker start command injection
- **Interruptible Instances**: Support for interruptible/low-cost spot instances
- **SnapGPU/CRIU**: Checkpoint/restore for fast boot (<30s snapshot restoration)
- **Auto-Snapshot**: Automatically capture checkpoint after first successful boot
- **GPU Readiness Benchmarking**: Shadow mode — GPU fires in background while cloud serves response; validates quality before production use
- **Canary Deployment**: Route small % of traffic to new deploy, auto-rollback if error rate exceeds threshold
- **Orphan Cleanup**: Sweep and terminate orphaned instances across all providers
- **Idle Auto-Stop**: Instances auto-stop after 15 min idle (`IDLE_TIMEOUT_MS`)
- **Idle Auto-Destroy**: Instances auto-destroyed 2h after auto-stop

### 3. Autoscaling

- **Tier Lifecycle State Machine**: idle → booting → ready per tier with health monitoring
- **Watchdog**: Background process that monitors health, stops idle instances after 15min
- **Auto-Recovery**: Replace failed instances automatically
- **Crash Loop Guard**: Tracks crash recovery attempts; NOT reset by `resetIdleState()`
- **Boot Timeout Handling**: Stage-specific timeouts with fallback to cloud on timeout
- **Circuit Breaker**: Opens after N consecutive failures per stage; prevents repeated GPU calls to unhealthy pods
- **Predictive Warmup**: ML-based usage prediction to pre-boot GPUs before demand spikes
- **Stage Timeout Configuration**: Per-stage adaptive timeouts (STT, LLM, TTS)
- **Health Checker**: Periodic probe loop with adaptive interval
- **Runaway Detector**: Detects and handles runaway GPU usage
- **Queue Depth Tracking**: Monitor queue depth for autoscaling decisions
- **Request Batching**: Batch concurrent requests for efficiency
- **Degradation Manager**: Handle degraded GPU performance
- **Load Balancer**: Health-aware load balancing across multiple instances
- **Latency Tracker**: EWMA-based latency tracking with P95 computation and breach counting
- **Cooldown Tracking**: Provider cooldowns after rate limits (429) or failures (30s default)
- **GPU Sweep**: Manually trigger sweep of idle pods across providers
- **Cost Monitor**: Track GPU spend, daily budget limits, waste detection

### 4. AI Provider Integrations

- **Cloud Providers** (via API):
  - Groq: STT (Whisper), TTS (PlayAI), LLM (LLaMA, Mixtral)
  - OpenAI: STT, TTS (TTS-1/HD), LLM (GPT-4o), Image (DALL-E 3), Realtime API, Embeddings
  - Fireworks: STT, LLM, Image (Stable Diffusion), Embeddings, Reranking
  - OpenRouter: LLM (200+ models), Image (Flux, DALL-E), Embeddings, Reranking
  - Ollama: Local LLM + STT
  - Deepgram: STT
  - Modal: TTS (MOSS-TTS)
- **GPU Providers** (self-hosted): RunPod, Vast.ai, TensorDock, Modal, SnapGPU
- **Provider Fallback Chains**: Declarative, config-driven fallback with cooldown and credit exhaustion tracking
- **Request Coalescing**: Deduplicate identical concurrent requests (share single upstream call)
- **Response Cache**: Cache responses for deterministic requests
- **Credit Block Tracking**: Track per-provider credit usage; block provider when exhausted
- **Percentage Routing**: A/B testing between providers
- **Content Guardrails**: Content moderation middleware
- **DLP (Data Loss Prevention)**: PII detection in prompts/responses
- **Provider Health Probes**: Periodic health checks for all cloud providers

### 5. WebSocket Capabilities

- **`/v1/speech/ws`**: Full speech pipeline over WebSocket (binary WAV in, JSON + audio out)
- **`/v1/stt/stream`**: Streaming STT with silence detection (configurable pauseMs)
- **`/ws/bot-audio`**: Bot audio streaming to connected clients
- **`/recall/audio`**: Recall.ai bot audio endpoint with token authentication
- **Bot Events Session**: Real-time status updates (gpu:status, provider:status, botStatus)
- **Broadcast System**: Publish to all connected clients by event type
- **Binary Frame Support**: metadata JSON + audio buffer
- **Subscription by Language**: Per-target-language dub subscriptions
- **Max WS Connections**: 200 total, 500 bot clients
- **Message Size Guard**: 5MB max payload, reject oversized with 1009
- **Idle Timeout**: 120 second WebSocket idle timeout

### 6. HTTP API Endpoints

**Speech Pipeline:**
- `POST /v1/speech` — Full pipeline (STT+LLM+TTS)
- `POST /v1/transcribe` — GPU-aware STT with request hedging
- `POST /v1/ensemble-transcribe` — Parallel multi-provider STT race
- `POST /v1/translate` — GPU-aware translation with caching
- `POST /v1/tts-preview` — TTS preview with voice clone support

**AI Proxy (OpenAI-compatible):**
- `POST /v1/chat/completions` — OpenAI-compatible chat completions proxy
- `POST /v1/audio/transcriptions` — STT endpoint
- `POST /v1/audio/speech` — TTS endpoint
- `POST /v1/images/generate` — Image generation
- `GET /v1/models` — List available models

**GPU Management:**
- `POST /v1/gpu/deploy` — Deploy GPU pod (async, poll status)
- `GET /v1/gpu/status` — Current GPU deployment status
- `POST /v1/gpu/stop` — Stop running pod
- `POST /v1/gpu/resume` — Resume stopped pod
- `POST /v1/gpu/terminate` — Permanently terminate pod
- `GET /v1/gpu/logs` — Pod logs
- `GET /v1/gpu/inspect` — Pod inspection
- `GET /v1/gpu/list` — List active pods across providers
- `GET /v1/gpu/offers` — Query GPU marketplace offers
- `POST /v1/gpu/preflight` — Pre-deploy validation checks
- `GET/POST/DELETE /v1/gpu/snapshot` — SnapGPU snapshot management
- `GET /v1/gpu/readiness/status` — GPU readiness benchmarking status
- `POST /v1/gpu/readiness/reset` — Reset readiness state
- `GET /v1/gpu/latency/hosts` — Host latency database
- `POST /v1/gpu/latency/probe` — Trigger latency probe cycle
- `GET /v1/canary/status` — Canary deployment status
- `GET /v1/gpu/sweep` — Trigger idle pod sweep

**Docker Image Builder:**
- `POST /v1/docker/auth` — GitHub OAuth device flow
- `POST /v1/docker/build` — Start Docker image build
- `GET /v1/docker/builds` — List all builds
- `GET /v1/docker/images` — List successfully built images

**Meeting Bots:**
- `POST /v1/bot/deploy` — Deploy meeting bot
- `POST /v1/bot/join` — Join meeting (Zoom/Teams/Meet)
- `POST /v1/bot/leave` — Leave meeting
- `GET /v1/bot/status` — Bot status

**Workloads:**
- `POST /v1/workloads` — Launch workloads (GPU, bot, db)
- `GET /v1/workloads` — List workloads

**Observability:**
- `GET /health` — Health check with provider status, balances, GPU status
- `GET /metrics` — Prometheus-format metrics
- `GET /v1/requests/log` — Request log history
- `GET /v1/analytics/system` — System analytics dashboard
- `GET /v1/performance` — Performance profiling stats

### 7. CLI Tools (`ai-gateway`)

```bash
# AI operations
ai-gateway chat "text"                    # Send chat message (streaming SSE)
ai-gateway transcribe <file>             # Transcribe audio file
ai-gateway tts "text" -o output.wav      # Synthesize speech
ai-gateway translate "text" --from fr --to en  # Translate text
ai-gateway detect-language "text"         # Detect language via LLM
ai-gateway models                         # List available models
ai-gateway image "prompt" -o output.jpg   # Generate image
ai-gateway voices                         # List available TTS voices
ai-gateway benchmark [--count N]          # Benchmark chat/STT/TTS endpoints

# GPU management
ai-gateway gpu status                     # GPU deployment status
ai-gateway gpu deploy                     # Deploy GPU with polling
ai-gateway gpu stop                       # Stop GPU
ai-gateway gpu terminate                  # Terminate GPU
ai-gateway gpu resume                     # Resume GPU
ai-gateway gpu list                       # List active instances
ai-gateway gpu offers                    # Query GPU offers
ai-gateway gpu logs                       # Fetch GPU logs
ai-gateway gpu latency hosts              # Show latency database
ai-gateway gpu latency probe              # Trigger probe cycle
ai-gateway gpu best                       # Score offers by latency*0.6 + reputation*0.3 + price*0.1

# Docker image builder
ai-gateway docker auth                   # GitHub OAuth for Docker image builder
ai-gateway docker build <dir> --name <name> --wait  # Build Docker image
ai-gateway docker list                   # List builds
ai-gateway docker images                  # List ready images

# System
ai-gateway services                       # Show all services status
ai-gateway apps                          # List configured apps/profiles
ai-gateway balance                       # Show provider balances and daily GPU spend
ai-gateway logs [--limit N]              # Show request logs
ai-gateway metrics                       # Fetch Prometheus metrics
ai-gateway config                        # Show gateway URL and API key
ai-gateway whoami                        # Show authenticated user
ai-gateway ping [count]                  # Latency ping test
ai-gateway server start/stop/status      # Manage local dev server
```

### 8. Admin/Web UI (Next.js)

- **Overview Section**: System status, connections, uptime
- **Pipeline Health Card**: STT/LLM/TTS component status
- **GPU Live Status**: Real-time GPU deployment status with warmth indicators
- **Fallback Chain List**: Visualize provider fallback chains
- **Service Forms**: Configure providers (Groq, OpenAI, etc.)
- **Stage List/Stage Row**: Per-stage configuration
- **React Flow Diagram**: Visual pipeline flow diagram
- **Latency Selector**: Per-stage latency target configuration
- **ApiKeys Section**: Manage API keys per provider
- **Bot Section**: Meeting bot management (deploy, join, leave)
- **Auto-Swap Section**: Automatic provider switching based on latency benchmarks
- **Reputation Section**: GPU host reputation scores
- **Standby Section**: Standby instance management
- **Playground Section**: Test pipeline with sample inputs
- **Labs Section**: Experimental features
- **Logs Section**: View gateway logs
- **Readiness Section**: GPU readiness benchmarking status

**Shared UI components** (always use, never re-implement):
`IconBox`, `StatusDot`, `KV`, `Button`, `Toggle`, `Card`, `SaveBar`, `ConfirmModal`, `DropdownList`, `TabNav`, `AlertBanner`, `CopyButton`, `FormInput`, `FormSelect`, `Spinner`, `Skeleton`, `Toast`, `StatusBadge`, `SectionHeader`, `CardSectionHeader`, `Sidebar`

### 9. Monitoring & Observability

- **Request Logging**: Per-request stage, provider, latency, success, input/output size, token counts
- **Provider Performance Metrics**: Per-provider requests, avg latency, error rate, token counts
- **Latency Ring Buffer**: In-memory circular buffer for percentile calculation (p50, p95, p99)
- **Circuit Breaker State**: Per-stage circuit state (closed/open), failure counts
- **Translation Cache Stats**: Cache hits/misses
- **Deploy History**: Deployment state machine transitions with timestamps
- **GPU Health Monitoring**: Periodic /health probe with response time tracking
- **GPU Warmth Tracking**: Per-stage model warmth (cold/warm per STT, LLM, TTS)
- **Daily Spend Tracking**: Atomic write, debounced 10s to `daily_spend.json`
- **Provider Balance Monitoring**: Balance per provider, low-balance warnings
- **Cost Anomaly Detection**: Detect abnormal spending patterns
- **Distributed Tracing**: Span-based request tracing across pipeline stages
- **Event Bus**: Typed event bus with last 1000 events history
- **Hooks System**: Fire-and-forget hooks (onRequestEnd, onScaleUp, onCostAlert, onHealthChange, onError)
- **Alert Channels**: Slack, Discord, generic webhook alerting
- **Langfuse Integration**: Observability platform integration
- **Prometheus Metrics**: `/metrics` endpoint for scraping
- **TTFAC Tracker**: Time-to-first-accessible-content tracking per provider

### 10. Security Features

- **API Key Authentication**: Bearer token auth on all endpoints (configurable)
- **Localhost Exemption**: No auth required for localhost when GATEWAY_API_KEY not set
- **HMAC-SHA256 GPU Tokens**: 60s TTL tokens for GPU pod authentication
- **Recall Webhook Auth**: Token validation for Recall.ai audio endpoint
- **Constant-Time String Compare**: Timing-safe comparison prevents timing attacks
- **WebSocket Auth**: Token passed via query param or Authorization header
- **AES-256-GCM Vault**: Encrypted secret storage
- **SSRF Protection**: Block private URL access in forwarded requests
- **Input Validation**: Zod schemas for request validation
- **Content Guardrails**: Content moderation before/after LLM calls
- **DLP Scanning**: PII detection in prompts and responses
- **Max WS Connections Limit**: 200 total, 500 bot clients
- **Message Size Limit**: 5MB WebSocket message size cap

### 11. Docker Image Builder

- **GitHub OAuth Device Flow**: Authenticate via GitHub without callback URL
- **Docker Build Trigger**: Trigger GH Actions workflow on `marcosremar/ai-gateway-dockers`
- **Build Status Polling**: Poll until build completes
- **Image Catalog**: Track built images in `image-catalog.json`
- **ghcr.io Registry**: Images pushed to GHCR (`ghcr.io/<user>/ai-gateway-img-<name>:latest`)
- **Pre-Baked Models**: Models downloaded at build time (not runtime) — validated +24% faster
- **hf-xet**: Use `hf_xet` for model downloads (NOT deprecated `HF_HUB_ENABLE_HF_TRANSFER`)
- **Blackwell Image Variants**: Auto-select `:blackwell` image for RTX 5090 (CUDA 12.8.1)

### 11b. GPU Finetune (`gpu finetune`)

Fireworks-style declarative finetune. ONE `train.yaml`; ai-gateway provisions GPU,
encodes data, trains, pushes weights + dataset to HF, tears down.

```bash
ai-gateway gpu finetune submit -f train.yaml      # full pipeline (smoke → encode → train → push)
ai-gateway gpu finetune presets                   # list bundled presets
ai-gateway gpu finetune logs                      # tail current run
ai-gateway gpu finetune status                    # detailed status (stage, GPU%, VRAM%, $/min)
ai-gateway gpu finetune cancel                    # graceful stop with final ckpt pull
```

- **Presets** (`finetune-presets/<name>/`): bundled trainer/prepare/tokenizer scripts
  + `manifest.json` declaring pipDeps/aptDeps/torchVersion. Built-in:
  `pocket-tts-finetune` (kyutai/pocket-tts flow-matching, LSD loss, Mimi codec frozen).
- **`type: <preset>`** in train.yaml = zero user training code; preset auto-loaded.
- **Auto-prep**: when preset declares `prepareScript`, ai-gateway runs it
  automatically against `/root/data/metadata.jsonl` (or `train.jsonl`) into
  `/root/data_paths.jsonl` before encode. Override via `prepare: skip` (skip
  prep, use pre-encoded data) or `prepare: <shell command>` in spec.yaml.
- **Pinned torch wheel**: manifest `torchVersion` + `torchCudaIndex` install BEFORE the
  generic `pip install` to avoid CUDA driver mismatch on host.
- **`quality: auto|safe|fast`** — smart defaults:
  - `auto` (default): torch.compile + plateau-stop (epochs ≥ 2)
  - `safe`: no auto-stop, no compile (debug runs)
  - `fast`: + pitch/speed augmentation (small dataset boost; doubles encode dataset)
- **GPU fallback ladder** (`gpuFallback: true`): 4090→3090→A5000→4080 if primary unavailable
- **Crash-survivable**: SIGINT pull, retry, relaunch, mid-run rsync (`--pull-every`),
  stall watchdog (`--stall-min`), budget cap (`--max-spend`)
- **2-repo HF output**: `<hfBase>` (weights) + `<hfBase>-dataset` (encoded.pt + train.yaml)
- **Generic base image**: `dockers/aigw-finetune-base/Dockerfile` (cuda 12.1 + torch 2.1.2 +
  hf-xet); per-preset pipDeps installed at job startup. Mount `/opt/cache` for persistent
  HF + torch.compile inductor cache across jobs.

### 12. Storage & Infrastructure

- **Storage Adapters**: S3-compatible storage (R2, B2, AWS, MinIO, DigitalOcean Spaces)
- **Database**: PostgreSQL via Prisma + Neon; raw SQL support
- **Latency DB**: PostgreSQL with RTT by host GPU; adaptive probe scheduling
- **Redis Adapter**: Optional Redis for production state management (vs InMemory for dev)
- **DI Interfaces**: StateStore, SettingsStore, SessionResolver — no hard Prisma/Redis dependencies
- **State Persistence**: Files in `~/.babelcast/` (provider-config, active_deploy, daily_spend, cooldowns, github_token)

## File map

```
src/                   Publishable library (tree-shakeable, 12 entry points)
  image-builder/       Docker image builder — GitHub OAuth + GHCR via Actions
  gpu-providers/       RunPod, Vast.ai, TensorDock, Modal, SnapGPU clients
  autoscaler/          Multi-tier GPU autoscaler (RunPod → TensorDock → Vast.ai → Modal)
  providers/           AI providers (Groq, OpenAI, Fireworks, OpenRouter, self-hosted)
  sdk/                 GatewaySDK HTTP client (TypeScript + Python mirror)
  adapters/            InMemoryStateAdapter, RedisStateAdapter
  deps.ts              AutoscalerDeps DI interface

server/                Reference service (imports from src/, never the reverse — CI enforced)
  ws-server.ts         Bun.serve() HTTP server + WebSocket, all route registration
  gpu-deploy.ts        Deploy orchestration (startDeployWithTiers, startDeployRace)
  gpu-handlers.ts      HTTP handlers for /v1/gpu/*
  ai-handlers.ts       HTTP handlers for /v1/transcribe, /v1/chat, /v1/speech, etc.
  bot-handlers.ts      Meeting bot lifecycle
  image-build-handlers.ts  Docker image builder HTTP handlers (/v1/docker/*)
  state.ts             Global state, budget tracking, deploy state machine
  config.ts            PREFERRED_GPU_TYPES allowlist, provider order
  config-persistence.ts    ~/.babelcast/provider-config.json read/write

web/src/               Next.js admin UI
  components/ui/       Shared component library — ALWAYS use, never re-implement
  sections/profiles/   GPU status, service forms, fallback chain UI

bin/ai-gateway.ts      CLI (manual switch/case, no framework)
dockers/               Docker image sources (babelcast-subtitle, ultravox-s2s, etc.)
scripts/               One-off tools (benchmarks, migration helpers)
```

## Commands

```bash
bun install
bun run build        # tsup → dist/ (ESM + CJS + .d.ts)
bun run test         # Vitest, sequential
bun run test:watch

# Integration tests (require live API keys in .env)
SKIP_GPU_TESTS=1 bun run test   # CI default — skips real API calls
bun run test:groq / test:openai / test:vast-lifecycle / test:runpod-lifecycle
```

## Hard rules

1. **`src/` never imports from `server/`** — CI enforces this. Break it and the build fails.
2. **All GPU ops go through the gateway API** — never call RunPod/Vast.ai/TensorDock directly. Bypasses watchdog, cost tracking, ghost detection.
3. **No Prisma/Redis/Next.js in `src/`** — use DI interfaces (`AutoscalerDeps`, `StateStore`, `SettingsStore`).
4. **All new UI uses `web/src/components/ui/`** — `IconBox`, `StatusDot`, `KV`, `DropdownList`, `Button`, `Toggle`, `Card`, `SaveBar`, `ConfirmModal`, etc. Never inline equivalents.

## Vibe Coding Guidelines

When using AI to generate code (vibe coding), follow these guidelines:

### Before Generating Code
1. **Check existing ADRs** — For any significant architectural decision, check [`docs/adr/`](docs/adr/) first
   - GPU cascade order? → ADR-001
   - Caching strategy? → ADR-002
   - Circuit breakers? → ADR-003
   - GPU vs cloud routing? → ADR-008
2. **Check [`docs/sdd.md`](docs/sdd.md)** — Understand module boundaries and what NOT to do
3. **Check [`CONTRIBUTING.md`](CONTRIBUTING.md)** — Code conventions, naming, error handling patterns

### While Generating Code
- **Stay within boundaries** — Don't suggest changes that violate the hard rules
- **Use the vocabulary** — Use terms from `docs/domain-model.md` (e.g., "tier", "warmth", "circuit breaker")
- **Follow conventions** — camelCase for functions, PascalCase for types, SCREAMING_SNAKE_CASE for constants

### After Generating Code
- **Create ADR for new decisions** — If the change introduces a new architectural pattern, create an ADR using [`docs/adr/TEMPLATE.md`](docs/adr/TEMPLATE.md)
- **Run tests** — Always run `bun test` after AI-generated changes
- **Architecture review** — For changes >500 lines, use [`docs/architecture-review-checklist.md`](docs/architecture-review-checklist.md)

### Quick ADR Lookup

| Concern | ADR |
|---------|-----|
| Provider cascade order | [ADR-001](docs/adr/ADR-001-gpu-cascade-order.md) |
| Translation caching | [ADR-002](docs/adr/ADR-002-lru-translation-cache.md) |
| Failure handling | [ADR-003](docs/adr/ADR-003-per-stage-circuit-breakers.md) |
| GPU+cloud race | [ADR-004](docs/adr/ADR-004-request-racing-gpu-cloud.md) |
| Fast boot (SnapGPU) | [ADR-005](docs/adr/ADR-005-snapgpu-criu-policy.md) |
| Warmth tracking | [ADR-006](docs/adr/ADR-006-per-stage-warmth-tracking.md) |
| Latency demotion | [ADR-007](docs/adr/ADR-007-p95-latency-demotion.md) |
| Hybrid routing | [ADR-008](docs/adr/ADR-008-hybrid-routing-gpu-cloud.md) |
| Provider cooldown | [ADR-009](docs/adr/ADR-009-provider-cooldown-tracking.md) |

## HTTP server pattern

Routes registered as flat object in `server/ws-server.ts`:
```typescript
handlers['POST /v1/gpu/deploy'] = gh.handleGpuDeploy;
// Dynamic routes handled separately before flat lookup (see workload + docker patterns)
```
Bun's native `fetch` handler — no Express/Hono/Fastify.

## State persistence

All runtime state in `~/.babelcast/`:
- `provider-config.json` — pipeline chains, GPU deploy config, app profiles
- `active_deploy.json` — active pod (survives restart)
- `daily_spend.json` — GPU spend counter (atomic write, debounced 10s)
- `cooldowns.json` — provider cooldowns
- `image-catalog.json` — built Docker images
- `github_token.json` — GitHub OAuth token (for image builder)

## DI pattern

```typescript
interface AutoscalerDeps {
  settingsStore: SettingsStore;   // user-level settings
  stateStore: StateStore;          // KV + List + Hash (Redis-like)
  sessionResolver: SessionResolver;
  logger?: Logger;
}
const gateway = createGateway({ storage, stateStore?, hooks? });
```

## GPU deployment

Provider cascade: **RunPod → Vast.ai → TensorDock → Modal** (based on available keys in `.env`).

```bash
# Env vars
RUNPOD_API_KEY / VAST_API_KEY / TENSORDOCK_API_KEY + TENSORDOCK_AUTH_ID
DOCKERHUB_USERNAME + DOCKERHUB_TOKEN   # avoids Vast.ai pull rate limits
AI_GATEWAY_GITHUB_CLIENT_ID            # Docker image builder OAuth
```

**GPU type names (must match `PREFERRED_GPU_TYPES` in `server/config.ts` exactly):**
- `NVIDIA GeForce RTX 5090` (Blackwell — use `:blackwell` image, CUDA 12.8.1)
- `NVIDIA GeForce RTX 4090` (Ada — use `:latest`, CUDA 12.4)
- `NVIDIA RTX A6000`, `NVIDIA L40S`, `NVIDIA RTX A5000`, `NVIDIA A40`

**Docker images** (`marcosremar/ai-gateway-dockers`):
- `babelcast-subtitle:latest` — CUDA 12.8.1, universal (all GPUs), Gemma 4B Q8 + Whisper pre-baked
- Trigger build: `gh workflow run build-babelcast-subtitle.yml --repo marcosremar/ai-gateway-dockers`

**Idle:** auto-stop after 15 min idle (`IDLE_TIMEOUT_MIN`). Auto-destroy 2h after stop.

## Docker image builder (`ai-gateway docker`)

```bash
ai-gateway docker auth          # GitHub OAuth device flow
ai-gateway docker build ./dir --name myapp --wait
ai-gateway docker list          # all builds
ai-gateway docker images        # ready images → use with gpu deploy
```
Requires `AI_GATEWAY_GITHUB_CLIENT_ID` env var. Built images land at `ghcr.io/<user>/ai-gateway-img-<name>:latest`.

## Model downloads (Dockerfiles)

Always use hf-xet (NOT the deprecated `HF_HUB_ENABLE_HF_TRANSFER`):
```dockerfile
ENV HF_XET_HIGH_PERFORMANCE=1 HF_XET_FIXED_DOWNLOAD_CONCURRENCY=50
RUN pip install "huggingface-hub>=1.0.0" "hf_xet>=1.4.0"
```
Pre-bake models at build time — do not lazy-download at runtime. Validated +24% vs legacy on Vast.ai RTX 4090 NVMe.

## Key gotchas

- **RunPod ports**: never same port as HTTP + TCP — use `['8000/http', '22/tcp']`
- **RunPod storage**: `storageGb: 0` = no volume; `containerDiskInGb` min 10GB
- **Vast.ai**: `runtype: 'args'`, port env dict. No SkyPilot.
- **Budget gate**: `canAffordDeploy()` in `state.ts` — checked in both `startDeployWithTiers` AND `startDeployRace`
- **Crash loop guard**: `monitorCrashRecoveryAttempts` is NOT reset by `resetIdleState()` — intentional
- **Network volumes**: only help if image lazy-downloads to `/workspace`. Pre-baked images get zero benefit.
- **`fastsafetensors` multi-shard**: broken for encoder-decoder models (Whisper, T5, BART) — use `coldstart.load_with_fastsafetensors()` which handles fallback
