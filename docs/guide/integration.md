# Integration Patterns

There are three ways to integrate the AI Gateway. The right choice depends on your stack, latency requirements, and deployment topology.

## Pattern 1 — Direct TypeScript (same process)

**Best for:** TypeScript/Bun monorepo, Next.js app router, zero-latency requirement.

Import `createGateway` directly. Your existing Prisma/Redis adapters plug in via dependency injection — no network hop, no sidecar.

```typescript
import { createGateway } from '@parle/ai-gateway';
import { PrismaSettingsStore, RedisStateStore } from './adapters'; // your thin shims

const gateway = createGateway({
  storage: new PrismaSettingsStore(prisma),
  stateStore: new RedisStateStore(redis),
  hooks: {
    onScaleUp: (e) => logger.info('GPU booting', e),
    onCostAlert: (e) => alerts.send(e),
  },
});

// Handle GET /api/gpu — returns current GPU status
app.get('/api/gpu', (req) => gateway.handleGet(req.userId));

// Handle POST /api/gpu — deploy, stop, resume, terminate
app.post('/api/gpu', (req) => gateway.handleAction(req.userId, req.body.action, req.body));
```

**DI interfaces** — implement these to plug in your storage layer:

```typescript
interface AutoscalerDeps {
  settingsStore: SettingsStore;   // read/write GPU config
  stateStore: StateStore;         // KV + list + hash ops (Redis, upstash, in-memory)
  sessionResolver: SessionResolver; // count active sessions for idle detection
  logger?: Logger;
  credentialStore?: CredentialStore;
}
```

::: tip When to use
Latency-sensitive path (calls from the same server that handles user requests). Avoids serialization and network round-trips entirely.
:::

---

## Pattern 2 — HTTP Sidecar (language-agnostic)

**Best for:** Python ML pipelines, mixed-language stacks, quick integration without TypeScript.

Run the gateway server as a local sidecar on `:4000`. Call it over localhost HTTP from any language.

```bash
# Terminal 1 — start the gateway
bun serve.ts
```

```python
# Python caller
import httpx, base64

# Full STT → LLM → TTS in one call
with open("audio.wav", "rb") as f:
    r = httpx.post(
        "http://localhost:4000/v1/speech",
        params={"source": "fr", "target": "en", "speaker": "Ryan"},
        content=f.read(),
        headers={"Content-Type": "audio/wav"},
    )

data = r.json()
print(data["transcription"])   # "Bonjour le monde"
print(data["response"])        # "Hello world"
audio = base64.b64decode(data["audio_base64"])
```

```ruby
# Ruby caller
require 'net/http'

uri = URI('http://localhost:4000/v1/speech?source=fr&target=en')
req = Net::HTTP::Post.new(uri)
req['Content-Type'] = 'audio/wav'
req.body = File.binread('audio.wav')
res = Net::HTTP.start(uri.hostname, uri.port) { |h| h.request(req) }
puts JSON.parse(res.body)['transcription']
```

::: tip When to use
When your main app is not TypeScript, or when you want to keep the gateway isolated in its own process for memory/CPU accounting.
:::

---

## Pattern 3 — Remote Service (microservices)

**Best for:** Multi-team setups, separate deployments, TypeScript frontend + remote gateway.

Deploy the gateway as a standalone service. Use `GatewaySDK` for a typed client, or plain HTTP if cross-language.

```typescript
import { GatewaySDK } from '@parle/ai-gateway/sdk';

const gw = new GatewaySDK({ baseUrl: 'https://gateway.your-domain.com' });

// Inference
const { text }    = await gw.transcribe(audioBuffer, 'fr');
const { content } = await gw.chat([{ role: 'user', content: 'Hello' }]);
const { audio }   = await gw.generateAudio('Hello world', { speaker: 'Ryan' });

// GPU lifecycle
await gw.deployGpu({ dockerImage: 'marcosremar/babelcast-subtitle:latest' });
const status = await gw.gpuStatus();   // { status, endpoint, gpuType, idleSec, ... }
await gw.waitForGpu(5000, 20 * 60_000);
await gw.stopGpu();
```

**Docker deploy:**

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
EXPOSE 4000
CMD ["bun", "serve.ts"]
```

```yaml
# docker-compose.yml
services:
  ai-gateway:
    build: .
    ports: ["4000:4000"]
    env_file: .env
    restart: unless-stopped
```

::: tip When to use
When the gateway is shared across multiple apps or teams, or when you want independent scaling and deployment of the gateway.
:::

---

## Comparison

| | Pattern 1 — Direct TS | Pattern 2 — HTTP Sidecar | Pattern 3 — Remote |
|---|---|---|---|
| **Latency** | Zero (in-process) | ~0.1ms (localhost) | Network RTT |
| **Language** | TypeScript only | Any | Any (typed TS client) |
| **Deployment** | Same process | Same host | Separate service |
| **DI adapters needed** | Yes | No | No |
| **Best for** | Monorepo, Next.js | Python, mixed stack | Microservices |

---

## GPU Operations — Always via Gateway

::: warning
**Never call RunPod, Vast.ai, or any GPU provider API directly.** Direct calls bypass idle watchdog, logging, ghost detection, and cost tracking.

Always use the gateway API or SDK:
```typescript
// ✅ Correct
await gw.deployGpu({ ... });
await gw.stopGpu();

// ❌ Never
await fetch('https://rest.runpod.io/v2/pods', { method: 'POST', ... });
await fetch('https://console.vast.ai/api/v0/asks/...', { ... });
```
:::

## Available Endpoints

```
POST /v1/speech               Full STT → LLM → TTS pipeline
POST /v1/audio/transcriptions STT only (multipart/form-data)
POST /v1/chat/completions     LLM only (OpenAI-compatible)
POST /v1/audio/speech         TTS only

GET  /v1/gpu/status           GPU instance status
POST /v1/gpu/deploy           Deploy a new GPU instance
POST /v1/gpu/stop             Stop (pause) current instance
POST /v1/gpu/resume           Resume a stopped instance
POST /v1/gpu/terminate        Permanently delete instance
GET  /v1/gpu/offers           Available GPU offers by price
GET  /v1/gpu/logs             Container stdout logs

GET  /health                  Health check (all providers)
GET  /metrics                 Prometheus metrics
```
