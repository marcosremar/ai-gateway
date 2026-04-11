# AI Providers & Fallback Chains

The gateway provides a unified interface over 8+ AI providers across four modalities: STT, LLM, TTS, and Image. Provider selection, failover, and cooldown are handled transparently.

## Supported Providers

| Provider | STT | LLM | TTS | Image |
|---|---|---|---|---|
| Groq | ✅ Whisper | ✅ Llama, Gemma | — | — |
| OpenAI | ✅ Whisper | ✅ GPT-4o | ✅ TTS-1 | ✅ DALL-E |
| Fireworks | ✅ | ✅ | — | ✅ |
| OpenRouter | — | ✅ (multi-model) | — | — |
| Modal | ✅ | ✅ | ✅ | — |
| Self-hosted GPU | ✅ Whisper | ✅ Gemma/Mistral | ✅ Kokoro | — |
| Fal.ai | — | — | — | ✅ FLUX |

## Fallback Chains

Chains define ordered provider lists with weights and cooldowns. When a provider fails, the next entry in the chain is tried automatically.

### Declarative (preferred)

```typescript
import { createGateway } from '@parle/ai-gateway';

const gateway = createGateway({
  storage,
  // Override default chains via settings store, or pass directly:
});

// Configure via API
await gw.setProviderConfig({
  pipelineStt: [
    { providerId: 'groq-whisper',  weight: 1.0 },
    { providerId: 'openai-whisper', weight: 0.5, cooldownMs: 30_000 },
  ],
  pipelineLlm: [
    { providerId: 'groq-llama',   weight: 1.0 },
    { providerId: 'openrouter',   weight: 0.5, cooldownMs: 60_000 },
    { providerId: 'gpu-self',     weight: 0.8 },  // self-hosted GPU
  ],
  pipelineTts: [
    { providerId: 'gpu-kokoro',  weight: 1.0 },
    { providerId: 'openai-tts',  weight: 0.5, cooldownMs: 30_000 },
  ],
});
```

### Programmatic

```typescript
import { withProviderFallback } from '@parle/ai-gateway/providers';

const result = await withProviderFallback(
  [groqLLM, openaiLLM, openrouterLLM],
  (provider) => provider.chat(messages),
  { maxRetries: 2, cooldownMs: 30_000 },
);
```

## Credit Exhaustion Tracking

The gateway tracks credit exhaustion per provider. When a provider returns a credit-exhaustion error (e.g. `429` with "insufficient credits"), it is automatically cooled down and the next provider in the chain is used.

```typescript
// Credit state is persisted in the state store
// Providers recover after cooldownMs (default: 5 minutes)
// You can inspect current state:
const config = await gw.getProviderConfig();
// config.pipelineStt[0].lastError, .cooldownUntil, ...
```

## GPU as a Provider

The self-hosted GPU is treated as a regular provider in the chain. The gateway handles GPU booting, health checking, and fallback to cloud automatically:

```typescript
// GPU is provider ID 'gpu-self' — gateway boots it on first use
// Falls back to cloud providers when GPU is booting or unavailable
const { text } = await gw.transcribe(audio);
// → tries GPU first, falls back to Groq/OpenAI if not ready
```

## Ensemble Mode (STT)

Race multiple STT providers and return the first successful result:

```typescript
const { text, provider } = await gw.transcribe(audio, {
  language: 'fr',
  ensemble: true,  // races Groq + OpenAI Whisper
});
```
