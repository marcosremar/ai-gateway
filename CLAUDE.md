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

**MANDATORY: All GPU operations MUST go through the ai-gateway API or SDK client** — NEVER use raw HTTP to RunPod (`rest.runpod.io`), Vast.ai (`console.vast.ai/api`), or any provider API directly. Direct calls bypass idle watchdog, logging, ghost detection, and cost tracking. This applies to deploy, stop, resume, terminate, and status checks.

**Idle behavior:** Pods auto-stop after 15 min idle (configurable via `IDLE_TIMEOUT_MIN` env). Auto-destroy 2h after stop if not resumed. Container-level watchdog works even without the gateway server running.

```typescript
import { GatewaySDK } from '@ai-gateway/sdk';
const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });

// ── Inference ────────────────────────────────────────────────────────

// STT: transcribe audio (with optional ensemble mode to race providers)
const { text, usedGpu } = await gw.transcribe(audioBuffer, 'fr');
const { text } = await gw.transcribe(audioBuffer, { language: 'fr', ensemble: true });

// LLM: chat completion
const { content, model, usage } = await gw.chat(
  [{ role: 'user', content: 'Hello' }],
  { temperature: 0.7, maxTokens: 512 },
);

// Translate text via GPU or cloud LLM
const { translatedText } = await gw.translate(text, 'fr', 'en');

// TTS: generate speech audio
const { audio } = await gw.generateAudio('Hello world', { speaker: 'Ryan' });

// TTS preview: test voice before using
const { audio } = await gw.ttsPreview('Test', { speaker: 'Ryan', speed: 0.9 });

// List available TTS voices
const { voices } = await gw.listVoices();

// Full pipeline: audio → STT → LLM → TTS
const result = await gw.pipeline(audioBuffer, { source: 'fr', target: 'en' });
// → { transcription, response, audioBase64, contentType, timing }

// Auto-detect language
const { language, confidence } = await gw.detectLanguage('Bonjour le monde');

// ── GPU Management ───────────────────────────────────────────────────

// Deploy (non-blocking — poll gpuStatus() or waitForGpu())
await gw.deployGpu({
  apiKey: process.env.RUNPOD_API_KEY,
  dockerImage: 'marcosremar/babelcast-subtitle:latest',
  gpuTypes: ['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 4090'],
});

// Poll status
const status = await gw.gpuStatus();
// → { status, podId, endpoint, gpuType, gpuHealthy, idleSec, ... }

// Wait until ready (blocks, throws on error/timeout)
const ready = await gw.waitForGpu(5000, 20 * 60_000);

// Stop (pause — preserves disk, no charges)
await gw.stopGpu();

// Resume a stopped pod
await gw.resumeGpu();           // resume last stopped pod
await gw.resumeGpu('podId');    // resume specific pod

// Terminate (delete permanently)
await gw.terminateGpu(process.env.RUNPOD_API_KEY);

// ── GPU Info ─────────────────────────────────────────────────────────

const offers = await gw.gpuOffers();       // available GPU offers by price
const types = await gw.gpuTypes();         // verified GPU types
const instances = await gw.gpuList();      // all active instances
const logs = await gw.gpuLogs();           // container stdout
const events = await gw.gpuEventLogs(100); // persistent event log (JSONL)
const catalog = await gw.gpuCatalog();     // Docker image catalog
const location = await gw.gpuMyLocation(); // gateway geolocation
const rep = await gw.gpuReputation();      // host reputation scores

// ── Config ───────────────────────────────────────────────────────────

const config = await gw.getProviderConfig();       // STT/LLM/TTS chains
await gw.setProviderConfig({ pipelineStt: [...] });

const keys = await gw.getApiKeys();                // API keys (masked)
await gw.setApiKeys({ GROQ_API_KEY: 'gsk_...' });

const flags = await gw.getLabsFlags();             // feature flags
await gw.setLabsFlags({ speculativeCache: true });

// ── Meeting Bot ──────────────────────────────────────────────────────

await gw.deployBot({ meetingUrl: 'https://meet.google.com/...' });
const botSt = await gw.botStatus();
await gw.botJoin('https://meet.google.com/...');
await gw.botLeave();
await gw.botTerminate();

// ── Diagnostics ──────────────────────────────────────────────────────

const isUp = await gw.health();                      // boolean
const detail = await gw.healthDetail();              // full provider state
const reqLog = await gw.requestLog(50);              // request history
const stats = await gw.serviceStats();               // service statistics
const prom = await gw.metrics();                     // Prometheus metrics
const inspect = await gw.dockerInspect('marcosremar/babelcast-subtitle');
```

```python
# Python SDK
from gateway_sdk import GatewaySDK, DeployOptions
gw = GatewaySDK(base_url="http://localhost:4000")

result = await gw.transcribe(audio_bytes, language="fr")
result = await gw.pipeline(audio_bytes, source="fr", target="en")
await gw.deploy_gpu(DeployOptions(api_key="rpa_...", docker_image="...", gpu_types=["..."]))
status = await gw.gpu_status()
await gw.terminate_gpu(api_key="rpa_...")
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

### Model Download Convention (MANDATORY for all ML Dockerfiles)

**Use `hf_hub_download` / `snapshot_download` with `HF_XET_HIGH_PERFORMANCE=1` and `HF_XET_FIXED_DOWNLOAD_CONCURRENCY=50` env vars.** This is the fastest method on datacenter GPU hosts by a validated 24% margin. `HF_HUB_ENABLE_HF_TRANSFER=1` is **deprecated** as of huggingface_hub 1.0 — the new default backend is `hf-xet` (chunked deduplication), and it requires different tuning.

**Validated benchmark (Vast.ai RTX 4090, 64GB RAM, 3 runs each, 770MB GGUF, 2026-04-07):**

| Rank | Method | Avg MB/s | Min | Max | Spread | vs production |
|---|---|---|---|---|---|---|
| 🏆 | `HF_XET_FIXED_DOWNLOAD_CONCURRENCY=100` | **410** | 369 | 453 | 20% | +29% |
| 2 | HP + `FIXED_DOWNLOAD_CONCURRENCY=50` | **394** | 365 | 410 | **11%** | **+24%** ← chosen |
| 3 | `FIXED_DOWNLOAD_CONCURRENCY=50` alone | 381 | 367 | 408 | 11% | +19% |
| 4 | `HF_XET_HIGH_PERFORMANCE=1` alone | 365 | 355 | 370 | **4%** | +14% |
| 5 | curl single-stream (reference) | 359 | 339 | 387 | 13% | +12% |
| 6 | Legacy `HF_HUB_ENABLE_HF_TRANSFER=1` | 319 | 285 | 336 | 16% | baseline |
| 7 | hf_xet default (adaptive) | **269** | 215 | 306 | **34%** | **-16%** ⚠ |

**Why `HF_XET_HIGH_PERFORMANCE=1` + `HF_XET_FIXED_DOWNLOAD_CONCURRENCY=50` is the production choice** (not the fastest `FIXED=100`):
- Only 4% slower than absolute fastest
- Half the variance spread (11% vs 20%) → more predictable cold boots
- `HIGH_PERFORMANCE` also bumps buffer sizes for large multi-file snapshots
- Requires ≥64GB RAM host — degrades on smaller hosts, so the `start.sh` in `ultravox-s2s` guards it with a RAM check

**⚠ Critical gotcha: hf-xet's default adaptive concurrency is BAD for short downloads.** The adaptive controller starts at 1 stream and only scales after round-trip time measurements, so for 2-4s downloads it never escalates. Pinning via `HF_XET_FIXED_DOWNLOAD_CONCURRENCY=50` bypasses the warmup entirely.

**⚠ Critical gotcha: aria2c multi-connection is SLOWER than single-stream on Vast.ai** — HF CDN already saturates 1 TCP connection at ~400 MB/s on datacenter hosts, and multi-conn setup overhead dominates. aria2c hit 198-232 MB/s in the same bench (worse than curl!). An earlier home-Wi-Fi benchmark showed aria2c_x8 was +29% faster, but that was a local-network bandwidth-per-connection artifact — never generalize home-network benchmarks to GPU datacenters.

**In every ML Dockerfile** (`ultravox-s2s`, `babelcast-subtitle`, `dit360`, `kokoro-tts`, `modal/*.py`, and any new image that downloads model weights):

```dockerfile
# 1. Install aria2 + zstd (kept only as fallback / manual debug tool)
RUN apt-get install -y --no-install-recommends ... aria2 zstd && ...

# 2. Copy the hf-download helper (lives at dockers/_common/hf-download, copied
#    into each image subdir for Docker build-context compatibility).
#    The helper tries hf_hub_download first, falls back to aria2c, then curl.
COPY hf-download /usr/local/bin/hf-download
RUN chmod +x /usr/local/bin/hf-download

# 3. Pin huggingface_hub >= 1.0 so hf_xet (new default backend) is auto-installed
RUN pip install --no-cache-dir "huggingface-hub>=1.0.0" "hf_xet>=1.4.0"

# 4. Set xet tuning env vars (validated as fastest — see bench table above)
ENV HF_XET_HIGH_PERFORMANCE=1 \
    HF_XET_FIXED_DOWNLOAD_CONCURRENCY=50

# 5. Pre-bake single files with hf_hub_download (lands in standard HF cache,
#    compatible with try_to_load_from_cache() at runtime)
RUN python3 -c "from huggingface_hub import hf_hub_download; \
    hf_hub_download('bullerwins/translategemma-4b-it-GGUF', 'translategemma-4b-it-Q8_0.gguf')"

# 6. Pre-bake multi-file snapshots with snapshot_download + max_workers=8
RUN python3 -c "from huggingface_hub import snapshot_download; \
    snapshot_download('org/repo', max_workers=8)"
```

**Never use** `HF_HUB_ENABLE_HF_TRANSFER=1` — it's deprecated. Never use `hf_transfer` as a pip dependency — replace with `hf_xet`.

**Runtime servers** (`server.py`) should use `hf_hub_download` with `try_to_load_from_cache` fast-path — see `dockers/babelcast-subtitle/server.py::_load_llm()` for the canonical pattern. The `hf-download` shell helper is available in PATH for manual/debug downloads or when Python/HF SDK is unavailable.

**Always pre-bake models at build time** when the total image size stays under ~20GB. Runtime model downloads cause Vast.ai cold boots of 1-2 min for small models and ~60s for the 24GB FLUX.1-dev at ~394 MB/s. The `babelcast-subtitle` image pre-bakes BOTH the GGUF LLM (~5GB) AND the Whisper STT (~3GB) for this reason.

**Benchmark script:** `scripts/model-download-bench/` has the tooling to validate download strategies on new hosts. Run `vast-benchmark.sh` to re-measure if HF CDN behavior changes. **Do not re-benchmark from scratch each time** — the conclusions above are current as of 2026-04-07 with 3-run validation on real Vast.ai hardware. The `dockers/_common/hf-download` helper implements the fallback chain.

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
