# AI Gateway — Claude Code Guidelines

## Domain model & design docs

Before implementing any feature, read:
- [`docs/domain-model.md`](docs/domain-model.md) — ubiquitous language, bounded contexts, states, events
- [`docs/sdd.md`](docs/sdd.md) — architectural decisions, module responsibilities, what NOT to do

Use the vocabulary from `domain-model.md` in all code and prompts. Respect the boundaries in `sdd.md`.

## What this is

Real-time multilingual speech-to-speech translation service. Pipeline: **STT → LLM → TTS**.
Transport (GPU vs cloud) is hidden from callers. `src/` is the publishable library; `server/` is the reference HTTP service.

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
