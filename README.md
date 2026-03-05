# @parle/ai-gateway

A comprehensive, modular TypeScript library for AI provider orchestration, GPU autoscaling, and real-time speech infrastructure. Built as a standalone workspace package with zero hard framework dependencies.

## Features

- **Multi-tier GPU Autoscaler** — Cascade through GPU providers (RunPod, TensorDock, Modal) with automatic failover, health checking, idle watchdog, and cost monitoring
- **AI Provider Abstraction** — Unified interface for 8+ providers (OpenAI, Groq, Fireworks, OpenRouter, Modal, self-hosted) across STT, TTS, LLM, Image, and Realtime modalities
- **Browser SDK** — Framework-agnostic `SpeechClient` with automatic transport negotiation (WebRTC → WebSocket → SSE)
- **Provider Fallback Chains** — Declarative, config-driven fallback with cooldown and credit exhaustion tracking
- **Predictive Warmup** — ML-based usage prediction to pre-boot GPUs before demand spikes
- **Spend Tracking** — Per-request cost estimation, budget alerts, and provider spend monitoring
- **Benchmarking** — Health checks, SSE/WebSocket/WebRTC latency benchmarks
- **Infrastructure Utilities** — SkyPilot CLI integration, SSH/SCP helpers

## Installation

```bash
# Workspace dependency (in monorepo)
bun add @parle/ai-gateway@workspace:*
```

## Quick Start

### Gateway (Recommended)

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

// GET autoscaler status
const status = await gateway.handleGet(userId);

// Trigger action (boot, stop, etc.)
const result = await gateway.handleAction(userId, 'boot', { tier: 0 });

// Get routing decision (returns endpoint + metrics)
const decision = await gateway.getDecision(userId);
```

### Browser SDK

```typescript
import { SpeechClient } from '@ai-gateway/browser';

const client = new SpeechClient({
  discoveryEndpoint: '/api/speech/health',
  // Auto-negotiates: WebRTC → WebSocket → SSE
});

client.on('transcript', (text) => console.log('STT:', text));
client.on('audio', (chunk) => playAudio(chunk));
client.on('metrics', (m) => console.log('Latency:', m.latencyMs));

await client.connect();
client.sendAudio(audioBlob);
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
| `@ai-gateway/browser` | Browser SDK — SpeechClient, transports         |
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
