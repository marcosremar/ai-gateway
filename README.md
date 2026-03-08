# @parle/ai-gateway

A comprehensive, modular TypeScript library for AI provider orchestration, GPU autoscaling, and real-time speech infrastructure. Built as a standalone workspace package with zero hard framework dependencies.

## Features

- **Transparent Speech API** — Single `POST /v1/speech` endpoint handles STT → LLM → TTS. Transport (GPU vs cloud) is hidden from the caller. No SSE/WebSocket/WebRTC in client code.
- **Multi-tier GPU Autoscaler** — Cascade through GPU providers (RunPod, TensorDock, Modal) with automatic failover, health checking, idle watchdog, and cost monitoring
- **AI Provider Abstraction** — Unified interface for 8+ providers (OpenAI, Groq, Fireworks, OpenRouter, Modal, self-hosted) across STT, TTS, LLM, Image, and Realtime modalities
- **Provider Fallback Chains** — Declarative, config-driven fallback with cooldown and credit exhaustion tracking
- **Predictive Warmup** — ML-based usage prediction to pre-boot GPUs before demand spikes
- **Spend Tracking** — Per-request cost estimation, budget alerts, and provider spend monitoring
- **Infrastructure Utilities** — SkyPilot CLI integration, SSH/SCP helpers

## Installation

```bash
# Workspace dependency (in monorepo)
bun add @parle/ai-gateway@workspace:*
```

## Quick Start

### Pipeline API (Recommended)

Send audio, get back transcription + translation + TTS audio in one JSON response. The gateway handles GPU vs cloud routing transparently.

```bash
# Full pipeline: audio in → JSON out
curl -X POST "http://localhost:4000/v1/speech?source=fr&target=en&speaker=Ryan" \
  --data-binary @audio.wav -H "Content-Type: audio/wav"

# Response:
# {
#   "transcription": "Bonjour le monde",
#   "response": "Hello world",
#   "audio_base64": "UklGR...",
#   "content_type": "audio/wav",
#   "timing": { "total_ms": 1234, "used_gpu": true }
# }
```

### AIClient (TypeScript)

```typescript
import { createAIClient } from '@ai-gateway/client';

const client = createAIClient({ registry, defaultProfile });

// Full pipeline — tries GPU first, falls back to cloud automatically
const result = await client.pipeline(audioBuffer, systemPrompt);
// result.stt.text       → "Bonjour le monde"
// result.chat.content   → "Hello world"
// result.tts.audio      → Buffer (WAV)
// result.usedGpu        → true/false
// result.totalLatencyMs → 1234

// Individual stages (also transport-transparent)
const stt  = await client.transcribe(audioBuffer);   // { text, latencyMs }
const chat = await client.chat(messages);             // { content, latencyMs }
const tts  = await client.synthesize(text);           // { audio, contentType }
```

### Transport Policy

**SSE, WebSocket, and WebRTC are blocked at the proxy level** (return `410 Gone`). All client code uses the JSON pipeline endpoint or the AIClient API. This keeps transport concerns inside the gateway — callers never parse SSE events, manage WebSocket frames, or negotiate WebRTC.

### Gateway Factory (Autoscaler)

```typescript
import { createGateway } from '@ai-gateway';

const gateway = createGateway({
  storage: myStorageAdapter,  // implements GatewayStorage
  stateStore: redisAdapter,   // optional, falls back to in-memory
  hooks: {                    // optional observability
    onScaleUp: (e) => console.log('GPU booting:', e),
    onCostAlert: (e) => console.log('Budget alert:', e),
  },
});

const status = await gateway.handleGet(userId);
const result = await gateway.handleAction(userId, 'boot', { tier: 0 });
```

### AI Providers

```typescript
import { groqLLM, openaiSTT, openaiTTS } from '@ai-gateway/providers';

// Individual providers
const stt = openaiSTT({ apiKey: '...' });
const llm = groqLLM({ apiKey: '...' });
const tts = openaiTTS({ apiKey: '...' });

const transcript = await stt.transcribe({ audio: audioBuffer });
const response = await llm.chat({ messages: [{ role: 'user', content: transcript.text }] });
const audio = await tts.synthesize({ text: response.text, voice: 'alloy' });
```

### Provider Fallback

```typescript
import { withProviderFallback } from '@ai-gateway/providers';

const result = await withProviderFallback(
  [groqLLM({ apiKey: '...' }), openaiLLM({ apiKey: '...' })],
  (provider) => provider.chat({ messages }),
  { maxRetries: 2, cooldownMs: 30_000 }
);
```

### GPU Provider Clients

```typescript
import { RunPodClient, TensorDockClient } from '@ai-gateway/gpu-providers';

const runpod = new RunPodClient({ apiKey: '...' });
const pod = await runpod.boot({
  gpuType: 'RTX A5000',
  dockerImage: 'marcosremar/parle-s2s:latest',
  ports: ['8000/http', '22/tcp'],
});

await runpod.waitForReady(pod.id);
await runpod.terminate(pod.id);
```

## Module Exports

| Import Path            | Description                                    |
|------------------------|------------------------------------------------|
| `@ai-gateway`         | Full API (all modules re-exported)             |
| `@ai-gateway/browser` | Browser SDK — SpeechClient (legacy, see transport policy) |
| `@ai-gateway/providers` | AI providers — OpenAI, Groq, Fireworks, etc. |
| `@ai-gateway/autoscaler` | GPU autoscaling engine                      |
| `@ai-gateway/gpu-providers` | Cloud GPU clients — RunPod, TensorDock, Modal |
| `@ai-gateway/handlers` | Next.js route handler utilities               |
| `@ai-gateway/client`  | AIClient — profile-based unified API           |
| `@ai-gateway/tracking` | Benchmark & spend tracking                    |
| `@ai-gateway/adapters` | State persistence — InMemory, Redis           |
| `@ai-gateway/auth`    | GPU token signing/verification (HMAC)          |
| `@ai-gateway/infra`   | SkyPilot CLI, SSH/SCP utilities                |
| `@ai-gateway/benchmarking` | Health checks, latency benchmarks         |

## Architecture

```
                    ┌─────────────────┐
                    │  createGateway  │  ← Single entry point
                    └────────┬────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
    ┌───────▼──────┐  ┌─────▼─────┐  ┌───────▼──────┐
    │  Autoscaler  │  │ Providers │  │   Handlers   │
    │   Engine     │  │  Registry │  │  (Next.js)   │
    └───────┬──────┘  └─────┬─────┘  └──────────────┘
            │               │
   ┌────────┼────────┐     │
   │        │        │     │
┌──▼──┐ ┌──▼──┐ ┌───▼─┐  ┌▼────────────┐
│RunPod│ │TD   │ │Modal│  │OpenAI, Groq,│
│      │ │     │ │     │  │Fireworks,...│
└──────┘ └─────┘ └─────┘  └─────────────┘
```

### Design Principles

- **Framework-agnostic** — No hard dependencies on Prisma, Redis, or Next.js. All external dependencies injected via interfaces.
- **Modular** — Each subpath is independently importable. Browser SDK has zero Node.js dependencies.
- **Tier cascade** — GPU autoscaler walks through tiers (cheapest first) with automatic failover to the next tier on failure.
- **Provider fallback** — AI providers fail over automatically with cooldown tracking and credit exhaustion detection.

## Supported Providers

### AI Providers

| Provider    | STT | TTS | LLM | Image | Realtime |
|-------------|-----|-----|-----|-------|----------|
| OpenAI      | Whisper | TTS-1/HD | GPT-4o | DALL-E 3 | Realtime API |
| Groq        | Whisper | PlayAI | LLaMA, Mixtral | - | - |
| Fireworks   | Whisper | - | LLaMA, Mixtral | Stable Diffusion | - |
| OpenRouter  | - | - | 200+ models | Flux, DALL-E | - |
| Modal       | - | MOSS-TTS | - | - | - |
| Self-hosted | Generic | Generic | Generic | - | - |

### GPU Cloud Providers

| Provider   | Status   | Notes                                      |
|------------|----------|--------------------------------------------|
| RunPod     | Working  | Primary. ~31s boot. Use HTTP+TCP ports.    |
| TensorDock | Working  | RTX 3090 inference backend.                |
| Modal      | Working  | Serverless, auto-scales to zero.           |
| Vast.ai    | Limited  | HTTP access not viable (SSH proxy only).   |
| SkyPilot   | Working  | Multi-cloud orchestration.                 |

## Build

```bash
bun run build   # tsup → dist/ (ESM + CJS + declarations + sourcemaps)
```

## Tech Stack

- **TypeScript** — Strict mode, ES2017 target
- **Zod** — Runtime config validation
- **tsup** — Bundler (ESM + CJS dual output)
- **OpenAI SDK** — Base client for OpenAI-compatible APIs

## License

Private — Part of the Parle ecosystem.
