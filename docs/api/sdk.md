# TypeScript SDK Reference

Full method list for `GatewaySDK` — the typed HTTP client for the AI Gateway.

```typescript
import { GatewaySDK } from '@parle/ai-gateway/sdk';

const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
```

## Inference

### `transcribe(audio, options?)`

Speech-to-text. Tries GPU first, falls back to cloud.

```typescript
const { text, usedGpu } = await gw.transcribe(audioBuffer, 'fr');

// With ensemble mode (races multiple providers)
const { text } = await gw.transcribe(audioBuffer, { language: 'fr', ensemble: true });
```

### `chat(messages, options?)`

LLM chat completion (OpenAI-compatible).

```typescript
const { content, model, usage } = await gw.chat(
  [{ role: 'user', content: 'Hello' }],
  { temperature: 0.7, maxTokens: 512 },
);
```

### `translate(text, from, to)`

Text translation via GPU or cloud LLM.

```typescript
const { translatedText } = await gw.translate(text, 'fr', 'en');
```

### `generateAudio(text, options?)`

TTS — generate speech audio.

```typescript
const { audio } = await gw.generateAudio('Hello world', { speaker: 'Ryan' });
// audio → Buffer (WAV)
```

### `ttsPreview(text, options?)`

Test a voice before using it in production.

```typescript
const { audio } = await gw.ttsPreview('Test sentence', { speaker: 'Ryan', speed: 0.9 });
```

### `listVoices()`

List available TTS voices.

```typescript
const { voices } = await gw.listVoices();
// [{ id: 'Ryan', language: 'en', gender: 'male' }, ...]
```

### `pipeline(audio, options?)`

Full STT → LLM → TTS pipeline in one call.

```typescript
const result = await gw.pipeline(audioBuffer, { source: 'fr', target: 'en' });
// {
//   transcription: 'Bonjour le monde',
//   response: 'Hello world',
//   audioBase64: 'UklGR...',
//   contentType: 'audio/wav',
//   timing: { total_ms: 1234, used_gpu: true },
// }
```

### `detectLanguage(text)`

Auto-detect language of text.

```typescript
const { language, confidence } = await gw.detectLanguage('Bonjour le monde');
// { language: 'fr', confidence: 0.99 }
```

---

## GPU Management

### `deployGpu(options)`

Deploy a GPU instance (non-blocking — returns immediately after scheduling).

```typescript
await gw.deployGpu({
  dockerImage: 'marcosremar/babelcast-subtitle:latest',
  gpuTypes: ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 5090'],
  apiKey: process.env.RUNPOD_API_KEY,  // optional, uses env by default
});
```

### `gpuStatus()`

Get current GPU instance status.

```typescript
const status = await gw.gpuStatus();
// {
//   status: 'RUNNING' | 'STOPPED' | 'BOOTING' | 'NONE',
//   podId, endpoint, gpuType, gpuHealthy, idleSec,
//   provider: 'runpod' | 'vast' | 'modal',
// }
```

### `waitForGpu(pollMs?, timeoutMs?)`

Block until GPU is ready (health check passes). Throws on error or timeout.

```typescript
await gw.waitForGpu(5_000, 20 * 60_000);
// pollMs=5000 (poll interval), timeoutMs=1200000 (20 min max)
```

### `stopGpu()`

Pause the GPU instance (billing stops, disk preserved).

```typescript
await gw.stopGpu();
```

### `resumeGpu(podId?)`

Resume a stopped instance.

```typescript
await gw.resumeGpu();           // resume last stopped
await gw.resumeGpu('podId');    // resume specific pod
```

### `terminateGpu(apiKey?)`

Permanently delete the GPU instance. **Data is unrecoverable.**

```typescript
await gw.terminateGpu(process.env.RUNPOD_API_KEY);
```

---

## GPU Info

```typescript
const offers    = await gw.gpuOffers();       // available GPU offers by price
const types     = await gw.gpuTypes();        // verified GPU types
const instances = await gw.gpuList();         // all active instances
const logs      = await gw.gpuLogs();         // container stdout
const events    = await gw.gpuEventLogs(100); // persistent event log (JSONL)
const catalog   = await gw.gpuCatalog();      // Docker image catalog
const location  = await gw.gpuMyLocation();   // gateway geolocation
const rep       = await gw.gpuReputation();   // host reputation scores
```

---

## Configuration

```typescript
// Provider chains
const config = await gw.getProviderConfig();
await gw.setProviderConfig({ pipelineStt: [...], pipelineLlm: [...] });

// API keys
const keys = await gw.getApiKeys();           // masked
await gw.setApiKeys({ GROQ_API_KEY: 'gsk_...' });

// Feature flags
const flags = await gw.getLabsFlags();
await gw.setLabsFlags({ speculativeCache: true });
```

---

## Diagnostics

```typescript
const isUp    = await gw.health();           // boolean
const detail  = await gw.healthDetail();     // full provider state
const reqLog  = await gw.requestLog(50);     // last N requests
const stats   = await gw.serviceStats();     // spend, latency stats
const prom    = await gw.metrics();          // Prometheus metrics text
const inspect = await gw.dockerInspect('marcosremar/babelcast-subtitle');
```

---

## Meeting Bot

```typescript
await gw.deployBot({ meetingUrl: 'https://meet.google.com/...' });
const botStatus = await gw.botStatus();
await gw.botJoin('https://meet.google.com/...');
await gw.botLeave();
await gw.botTerminate();
```
