# AI Gateway (`@parle/ai-gateway`) — Claude Code Guidelines

## Purpose

`@parle/ai-gateway` is the AI and GPU infrastructure layer of the Parle platform — a real-time multilingual speech-to-speech translation system. It is a **standalone workspace package** (zero hard framework dependencies) and the **single source of truth** for all GPU, AI provider, autoscaler, benchmarking, and infra code.

**Core use case:** a caller sends raw audio in one language and receives translated audio back. The pipeline is `STT → LLM → TTS`, and the transport (GPU vs cloud) is fully hidden from the caller.

**What this package owns:**
- **Speech pipeline** — `POST /v1/speech` handles the full STT→LLM→TTS flow in one HTTP call
- **Multi-tier GPU autoscaler** — cascades through RunPod → TensorDock → Vast.ai → Modal with health checks, idle watchdog, and cost monitoring
- **AI provider abstraction** — unified interface over 8+ providers (OpenAI, Groq, Fireworks, OpenRouter, Modal, self-hosted) for STT, TTS, LLM, and Image modalities
- **Provider fallback chains** — declarative, config-driven failover with cooldown and credit-exhaustion tracking
- **Predictive warmup** — ML-based usage prediction to pre-boot GPUs before demand spikes
- **Spend tracking** — per-request cost estimation and budget enforcement

Do not put AI/GPU logic in `gateway-server.ts` or host app code directly — it belongs here.

## Commands

```bash
bun install
bun run build        # tsup → dist/ (ESM + CJS + .d.ts for 12 entry points)
bun run test         # All tests (Vitest, sequential — no parallelism)
bun run test:watch   # Watch mode

# Provider integration tests (require live API keys in .env)
bun run test:groq
bun run test:openai
bun run test:fireworks
bun run test:openrouter
bun run test:modal
bun run test:cross           # Cross-provider fallback
bun run test:auth
bun run test:runpod-lifecycle
bun run test:vast-lifecycle
```

`SKIP_GPU_TESTS=1` skips real API calls (default in CI). Tests load vault credentials via `loadVaultCredentials()` in setup — use `describe.skipIf` to guard integration tests.

## Module Entry Points

12 independent entry points (tree-shakeable):

```typescript
import { createGateway } from '@parle/ai-gateway';                      // Full gateway API
import { AIProviderRegistry } from '@parle/ai-gateway/providers';        // AI providers only
import { createAutoscaler } from '@parle/ai-gateway/autoscaler';         // GPU autoscaler engine
import { GpuProviderRegistry } from '@parle/ai-gateway/gpu-providers';   // Cloud GPU clients
import { createAIClient } from '@parle/ai-gateway/client';               // Unified client
import { InMemoryStateAdapter, RedisStateAdapter } from '@parle/ai-gateway/adapters';
import { signGpuToken, verifyGpuToken } from '@parle/ai-gateway/auth';
// Also: /handlers, /tracking, /infra, /benchmarking, /vault, /observability, /alerting, /caching, /proxy
```

## API — How to call it

### HTTP (from Python or any client)

```bash
# Full STT → LLM → TTS pipeline (only supported audio endpoint)
POST /v1/speech?source=fr&target=en&speaker=Ryan  Content-Type: audio/wav
# → { transcription, response, audio_base64, content_type, timing: { total_ms, used_gpu } }

# OpenAI-compatible individual stages
POST /v1/audio/transcriptions   # STT (multipart/form-data)
POST /v1/chat/completions       # LLM (application/json)
POST /v1/audio/speech           # TTS (application/json)
```

SSE, WebSocket (`/ws/stream`), and WebRTC are **blocked** — return 410 Gone. Never write client code for them.

### TypeScript (programmatic)

```typescript
import { createAIClient } from '@ai-gateway/client';

const client = createAIClient({ registry, gpuRegistry, defaultProfile });

// Transport-transparent: tries GPU first, falls back to cloud
const result = await client.pipeline(audioBuffer, systemPrompt);
// { stt: { text }, chat: { content }, tts: { audio, contentType }, totalLatencyMs, usedGpu }

const stt = await client.transcribe(audioBuffer);
const chat = await client.chat(messages);
const tts = await client.synthesize(text);
```

## Architecture Rules

1. All GPU/AI/autoscaler/benchmarking code lives **here** — never in `src/lib/` or host app
2. No hard dependencies on Prisma, Redis, or Next.js — use DI interfaces (`AutoscalerDeps`)
3. App-specific wiring (Prisma adapters, Next.js routes) stays in host app as thin shims
4. New AI/GPU features go here first, then get wired via shims

## Dependency Injection Pattern

```typescript
interface AutoscalerDeps {
  settingsStore: SettingsStore;
  stateStore: StateStore;           // KV + list + hash ops
  sessionResolver: SessionResolver; // count active sessions
  logger?: Logger;
  credentialStore?: CredentialStore;
}

// Recommended factory
const gateway = createGateway({ storage, stateStore?, hooks? });
gateway.handleGet(userId);
gateway.handleAction(userId, action, body);
```

## Provider Fallback Pattern

Prefer declarative chains over programmatic for user-facing configs:

```typescript
// Declarative (config-driven, preferred)
const chains: FallbackChainConfig[] = [
  { stage: 'stt', entries: [
    { providerId: 'groq-whisper', weight: 1.0 },
    { providerId: 'openai-whisper', weight: 0.5, cooldownMs: 30_000 },
  ]},
];

// Programmatic (for custom orchestration logic)
await withProviderFallback([groqLLM, openaiLLM, openrouterLLM], (p) => p.chat(messages), {
  maxRetries: 2,
  cooldownMs: 30_000,
});
```

## GPU Machine Deployment

**MANDATORY: All GPU deploys MUST go through the SDK client** — never use raw HTTP, curl, or direct provider APIs. The SDK enforces the correct GPU name format, fallback chain, and monitoring.

```typescript
// TypeScript (Node SDK) — REQUIRED approach
import { GatewayHttpClient } from '@parle/ai-gateway/sdk/node';

const gw = new GatewayHttpClient({ baseUrl: 'http://localhost:4000' });

// Deploy (non-blocking — poll gpuStatus() until ready)
await gw.deployGpu({
  apiKey: process.env.RUNPOD_API_KEY,       // RunPod key (starts with rpa_)
  dockerImage: 'marcosremar/ultravox-s2s:blackwell',
  gpuTypes: ['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 4090'],
});

// Poll until ready
const status = await gw.gpuStatus();
// { status: 'ready'|'booting'|'error', endpoint, gpuType, step, ... }
```

```python
# Python SDK — alternative
from gateway_sdk import GatewaySDK, DeployOptions
gw = GatewaySDK(base_url="http://localhost:4000")
await gw.deploy_gpu(DeployOptions(
    api_key=os.environ["RUNPOD_API_KEY"],
    docker_image="marcosremar/ultravox-s2s:blackwell",
    gpu_types=["NVIDIA GeForce RTX 5090", "NVIDIA GeForce RTX 4090"],
))
```

**GPU type names for RunPod** (must be exact):
- `NVIDIA GeForce RTX 5090` — Blackwell, use `:blackwell` image (cu128)
- `NVIDIA GeForce RTX 4090` — Ada, use `:latest` image (cu124)
- `NVIDIA RTX A6000`, `NVIDIA L40S`, `NVIDIA RTX A5000`, `NVIDIA A40`

**ultravox-s2s images** (`marcosremar/ai-gateway-dockers`):
- `:latest` — CUDA 12.4, RTX 3090/4090 (Ada + Ampere)
- `:blackwell` — CUDA 12.8.1, RTX 5090/5080 (Blackwell). **Models pre-baked** (no runtime download). No HEALTHCHECK (avoids Vast.ai auto-destroy during model loading).

- Provider order: RunPod → Vast.ai → Modal (based on available credentials in `.env`)
- GPU type names must match allowlist exactly (see `PREFERRED_GPU_TYPES` in `server/config.ts`)
- Vast.ai key: `VAST_API_KEY` | TensorDock: `TENSORDOCK_API_KEY` + `TENSORDOCK_AUTH_ID`
- Docker Hub auth: `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` (avoids Vast.ai pull rate limits)
- Cooldowns persist in `~/.babelcast/cooldowns.json` — delete to clear stuck cooldowns

## Docker Images (`ai-gateway-dockers` repo)

Docker images are built and pushed via GitHub Actions in [marcosremar/ai-gateway-dockers](https://github.com/marcosremar/ai-gateway-dockers).

```bash
# Trigger build manually (or push to babelcast-subtitle/ directory)
gh workflow run build-babelcast-subtitle.yml --repo marcosremar/ai-gateway-dockers
```

| Image | Base | LLM | GPU Support |
|-------|------|-----|-------------|
| `babelcast-subtitle` | CUDA 12.8.1 | TranslateGemma 4B Q8 (llama.cpp, flash_attn) | Universal (Blackwell + Ada + Ampere) |
| `babelcast-mistral` | CUDA 12.4 | Mistral 7B | Standard only (has Blackwell variant) |

- **Universal images** (CUDA 12.8.1 base) run on ALL GPUs — no Blackwell swap needed
- Only `babelcast-mistral` still uses the `STANDARD_TO_BLACKWELL` mapping in `server/config.ts`
- Vast.ai `image_login` is injected automatically when `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` env vars are set

## Web UI Component Library (`web/src/components/ui/`)

**All new UI code MUST use these components.** Do not re-implement inline.

```typescript
// Always import from the barrel — never inline equivalent markup
import { IconBox, DropdownList, KV, StatusDot, Button, Toggle } from '@/components/ui';
import { FormInput, FormSelect, Card, CardHeader, CardBody } from '@/components/ui';
import { SectionHeader, SaveBar, ConfirmModal, Spinner, StatusBadge, TabNav, AlertBanner } from '@/components/ui';

// Provider icon registry (pipeline/service UIs)
import { PROVIDER_ICON } from '@/sections/FallbackChainList';
// { gpu: { icon: Cpu, color: '#f59e0b' }, groq: { icon: Zap, color: '#7ba896' }, ... }
```

Key rules:
- **Never** write a `div` with `color-mix` + icon — use `IconBox` (`icon`, `color`, `size`: xs/sm/md/lg)
- **Never** write inline colored dots — use `StatusDot` (`status`: ready/online/booting/warning/error/offline/idle)
- **Never** write inline flex label+value pairs — use `KV` (`label`, `value`, `mono?`)
- **Never** use native `<select>` for styled dropdowns — use `DropdownList`

## Key Gotchas

- **RunPod ports**: never expose same port as both HTTP and TCP — use `['8000/http', '22/tcp']`
- **RunPod storage**: `storageGb: 0` = no volume; `containerDiskInGb` minimum 10GB
- **Vast.ai**: use `VastClient` with `runtype: 'args'` and port env dict. Do NOT use SkyPilot for Vast.ai
- GPU type names in deploy requests must match allowlist exactly (e.g. `"NVIDIA GeForce RTX 5090"`)
