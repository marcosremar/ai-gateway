# Getting Started

`@parle/ai-gateway` is the AI and GPU infrastructure layer of the Parle platform. It handles the full `STT → LLM → TTS` pipeline, GPU autoscaling across multiple cloud providers, and provider fallback — all behind a single HTTP endpoint or TypeScript API.

## Installation

### Workspace (monorepo)

```bash
bun add @parle/ai-gateway@workspace:*
```

### Standalone

```bash
bun install
bun run build   # tsup → dist/ (ESM + CJS + .d.ts)
```

## Quick Start

### 1. HTTP — Full pipeline in one call

Send audio in, get transcription + translated text + TTS audio back:

```bash
curl -X POST "http://localhost:4000/v1/speech?source=fr&target=en&speaker=Ryan" \
  --data-binary @audio.wav \
  -H "Content-Type: audio/wav"
```

```json
{
  "transcription": "Bonjour le monde",
  "response": "Hello world",
  "audio_base64": "UklGR...",
  "content_type": "audio/wav",
  "timing": { "total_ms": 1234, "used_gpu": true }
}
```

### 2. TypeScript SDK

```typescript
import { GatewaySDK } from '@parle/ai-gateway/sdk';

const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });

// Full pipeline
const result = await gw.pipeline(audioBuffer, { source: 'fr', target: 'en' });

// Individual stages
const { text }  = await gw.transcribe(audioBuffer, 'fr');
const { content } = await gw.chat([{ role: 'user', content: 'Hello' }]);
const { audio } = await gw.generateAudio('Hello world', { speaker: 'Ryan' });
```

### 3. Start the server

```bash
# With environment variables in .env
bun serve.ts
# Listening on :4000
```

## Environment Variables

```bash
# AI Providers
GROQ_API_KEY=gsk_...
OPENAI_API_KEY=sk-...
FIREWORKS_API_KEY=fw_...

# GPU Providers (at least one required for GPU autoscaling)
RUNPOD_API_KEY=rpa_...
VAST_API_KEY=...

# SnapGPU S3 (optional — enables cross-host CRIU snapshot persistence)
SNAPGPU_S3_ENDPOINT=https://s3.us-east-005.backblazeb2.com
SNAPGPU_S3_BUCKET=snapgpu-snapshots
SNAPGPU_S3_ACCESS_KEY=...
SNAPGPU_S3_SECRET_KEY=...
```

## What's Blocked

SSE, WebSocket (`/ws/stream`), and WebRTC are **disabled at the proxy level** (return `410 Gone`). All client code uses the JSON pipeline endpoint or the TypeScript SDK. Transport concerns stay inside the gateway.

## Next Steps

- **[Integration Patterns](./integration)** — pick the right integration style for your stack
- **[GPU Management](./gpu)** — deploy, autoscale, and monitor GPU instances
- **[SnapGPU](./snapgpu)** — configure cold-start optimization
- **[SDK Reference](../api/sdk)** — full TypeScript SDK method list
