# Análise de Cobertura de Testes — @ai-gateway

## Sumário Executivo

- **Total de arquivos fonte**: 87 arquivos `.ts` (excluindo `index.ts`)
- **Arquivos COM testes**: 51 arquivos
- **Arquivos SEM testes**: 36 arquivos
- **Taxa de cobertura**: ~59%

---

## GRUPO 1: Arquivos Puros (Sem Lógica a Testar)
*Apenas tipos, constantes e índices — não precisam de testes.*

### Arquivos Index/Barrel Exports
- `src/autoscaler/index.ts` — re-exporta públicos
- `src/benchmarking/index.ts` — re-exporta públicos
- `src/browser/index.ts` — re-exporta públicos
- `src/client/index.ts` — re-exporta públicos
- `src/gpu-providers/index.ts` — re-exporta públicos
- `src/handlers/index.ts` — re-exporta públicos
- `src/infra/index.ts` — re-exporta públicos
- `src/providers/index.ts` — re-exporta públicos
- `src/tracking/index.ts` — re-exporta públicos
- `src/adapters/index.ts` — re-exporta públicos
- `src/auth/index.ts` — re-exporta públicos
- `src/index.ts` — re-exporta públicos (~115 símbolos)
- `src/providers/openai-compat/index.ts` — re-exporta audio-utils + compat classes

### Tipos & Interfaces Puras
- `src/types.ts` (116 linhas) — **Puros tipos**
  - Exports: `AutoScaleRoute`, `GpuBootState`, `ScaleTrigger`, `GpuProvider`, `GpuTierConfig`, `AutoScalerConfig`, `IdleTierState`, `BootingTierState`, `ReadyTierState`, `GpuTierState`, `AutoScaleDecision`
  - Lógica: NENHUMA
  
- `src/deps.ts` (139 linhas) — **Puros tipos DI**
  - Exports: `SettingsStore`, `KvStore`, `ListStore`, `HashStore`, `StateStore`, `SessionResolver`, `Logger`, `CredentialStore`, `LifecycleLogStore`, `UserRoleResolver`, `BenchmarkStore`, `UsageLogStore`, `AutoscalerDeps`
  - Lógica: NENHUMA

- `src/storage.ts` (61 linhas) — **Pura interface**
  - Exports: `GatewayStorage`
  - Lógica: NENHUMA

- `src/gateway-api.ts` (120 linhas) — **Pura interface**
  - Exports: `Gateway` (interface de métodos)
  - Lógica: NENHUMA
  - Nota: Descreve métodos implementados por `gateway.ts`

- `src/browser/types.ts` (269 linhas) — **Puros tipos Browser SDK**
  - Exports: `ProcessingStage`, `ServiceStatus`, `ProtocolId`, `ModelLoadStatus`, `TimingInfo`, `SpeechMetrics`, `AdaptiveSpeed`, `SpeechResponse`, `Transport`, `WebSocketConfig`, `SSEConfig`, `WebRTCConfig`, `CircuitBreakerConfig`, `SpeechClientConfig`, `DiscoveryResponse`, `SDKMetrics`, `SpeechClientEventMap`
  - Lógica: NENHUMA

- `src/handlers/types.ts` — **Puro tipo**
  - Exports: `HandlerResult` type
  - Lógica: NENHUMA

- `src/gpu-providers/types.ts` — **Puros tipos GPU**
  - Exports: `ProviderCredentials`, `GpuInstanceSpec`, etc.
  - Lógica: NENHUMA

- `src/providers/types.ts` — **Puros tipos providers**
  - Exports: `ProviderId`, `STTProvider`, `LLMProvider`, `TTSProvider`, `ImageProvider`, etc.
  - Lógica: NENHUMA

### Model Catalogs (Apenas Constantes)
- `src/providers/openai/models.ts` (227 linhas) — **Puro catálogo**
  - Exports: `OPENAI_STT_MODELS`, `OPENAI_TTS_MODELS`, `OPENAI_LLM_MODELS`, `OPENAI_REALTIME_MODELS`, `OPENAI_OMNI_MODELS`, `OPENAI_VOICES`, `OPENAI_IMAGE_MODELS`
  - Lógica: NENHUMA

- `src/providers/groq/models.ts` (70 linhas) — **Puro catálogo**
  - Exports: `GROQ_STT_MODELS`, `GROQ_TTS_MODELS`, `GROQ_TTS_VOICES`, `GROQ_LLM_MODELS`
  - Lógica: NENHUMA

- `src/providers/fireworks/models.ts` (31 linhas) — **Puro catálogo**
  - Exports: `FIREWORKS_STT_MODELS`, `FIREWORKS_LLM_MODELS`, `FIREWORKS_IMAGE_MODELS`
  - Lógica: NENHUMA

- `src/providers/openrouter/models.ts` (45 linhas) — **Puro catálogo**
  - Exports: `OPENROUTER_IMAGE_MODELS`, `OPENROUTER_LLM_MODELS`
  - Lógica: NENHUMA

### Simples Utilitários (Sem Testes Necessários)
- `src/logger.ts` (7 linhas) — **Trivial**
  - Exports: `defaultLogger` (console delegado)
  - Lógica: NENHUMA (apenas console.log/warn/error)

---

## GRUPO 2: Pode Testar SEM API Real
*Lógica pura — mocks são suficientes.*

### Hooks & Emitter
**Arquivo**: `src/hooks.ts` (129 linhas)
- **Exports**: `emitHook()`, event type interfaces
- **Complexidade**: SIMPLES
- **O que testar**:
  - Hook disparo correto (emitHook chama a função)
  - Isolamento entre eventos
  - Erros em hooks não quebram o fluxo
  - Hooks assíncronos tratados corretamente

**Arquivo**: `src/browser/emitter.ts` (57 linhas)
- **Exports**: `TypedEmitter<EventMap>` class
- **Complexidade**: SIMPLES
- **O que testar**:
  - `on()` registra listener
  - `emit()` dispara para todos listeners
  - `off()` remove listener
  - Unsubscribe function
  - Erros em listener não quebram outros
  - `removeAllListeners()`

### Logger Browser
**Arquivo**: `src/browser/logger.ts` (90 linhas)
- **Exports**: `createLogger()`, `setLogLevel()`, `setLogHandler()`, `Logger` interface
- **Complexidade**: SIMPLES
- **O que testar**:
  - Log levels funciona (LEVEL_ORDER)
  - `setLogLevel()` controla globalmente
  - `setLogHandler()` customiza output
  - Namespaced logger com prefixos
  - Apenas níveis >= globalLevel são logged

### Errors Browser
**Arquivo**: `src/browser/errors.ts` (58 linhas)
- **Exports**: `SpeechSDKError` class, `SpeechErrorCode` type
- **Complexidade**: SIMPLES
- **O que testar**:
  - Construtor de error
  - `recoverable` flag baseado em code
  - Context preservation
  - Cause handling

### Provider Errors
**Arquivo**: `src/providers/errors.ts` (127 linhas)
- **Exports**: `buildProviderError()`, `CreditExhaustedError`, `PROVIDER_LABELS`, `BILLING_URLS`, `extractErrorStatus()`, `extractErrorMessage()`
- **Complexidade**: SIMPLES
- **O que testar**:
  - `buildProviderError()` mapeia status HTTP → mensagem amigável
  - 429 (quota) → URL de billing
  - 401 (auth) → instrução de verificar chave
  - 402 (payment) → URL de billing
  - timeout detection
  - network error detection
  - `CreditExhaustedError` construtor
  - `extractErrorStatus()` e `extractErrorMessage()`

### Factory Wrapper
**Arquivo**: `src/factory.ts` (300 linhas)
- **Exports**: `createAutoscaler()` factory function, `Autoscaler` interface
- **Complexidade**: MÉDIO
- **API Real necessária?**: NÃO (tudo é orquestração de classes já testadas)
- **O que testar**:
  - Factory instancia todas as dependências
  - Retorna interface `Autoscaler` com todos os métodos
  - Wiring correto (engine, registry, trackers)
  - `onInstancePersist` callback
  - Fallback para `loadAutoscalerConfig` padrão
  - Wrapped logger intercepta boot_ok events

### Browser Audio Utilities
**Arquivo**: `src/browser/audio.ts` (já tem teste ✅)

**Arquivo**: `src/browser/streaming-audio.ts` (318 linhas)
- **Exports**: `StreamingAudioPlayer` class
- **Complexidade**: MÉDIO
- **O que testar**:
  - `init()` cria AudioContext
  - `feedChunk()` decodifica WAV, agenda playback
  - `setVolume()` ajusta gain
  - `play()` e `stop()` controlam estado
  - `getMediaStream()` retorna stream
  - `destroy()` limpa resources
  - WAV format parsing (sample rate, channels, bps)
  - Seamless playback scheduling (nextStartTime)
  - onStarted/onEnded callbacks
  - Mocks: AudioContext, GainNode, MediaStreamAudioDestinationNode

### Browser Transport Factory
**Arquivo**: `src/browser/transport-webrtc.ts` (225 linhas)
- **Exports**: `WebRTCTransport` class
- **Complexidade**: MÉDIO
- **O que testar**:
  - Lazy-load @pipecat-ai/client-js (dynamic import)
  - Fallback gracioso se biblioteca não instalada
  - `connect()` cria RTCPeerConnection
  - Eventos de faixa de áudio (onTrack)
  - Data channel para meta (transcript, timing)
  - `getRemoteStream()` retorna media stream
  - Error handling (signalingUrl missing, timeout, etc.)
  - Logging via createLogger

### OpenAI-Compat Base Classes
**Arquivo**: `src/providers/openai-compat/openai-compat-llm.ts` (85 linhas)
- **Exports**: `OpenAICompatLLMProvider` class
- **Complexidade**: SIMPLES
- **O que testar**:
  - Constructor armazena config
  - `getClient()` lazy-inits OpenAI SDK com baseURL
  - `withApiKey()` cria nova instância
  - `withConfig()` cria com apiKey/baseURL
  - `isConfigured()` verifica env var
  - `chat()` chama client.chat.completions.create()
  - Temperatura e maxTokens passados corretamente

**Arquivo**: `src/providers/openai-compat/openai-compat-stt.ts` (83 linhas)
- **Exports**: `OpenAICompatSTTProvider` class
- **Complexidade**: SIMPLES
- **O que testar**:
  - Constructor
  - `getClient()` lazy-init
  - `withApiKey()`
  - `getModels()`, `isConfigured()`
  - `transcribe()` chama client.audio.transcriptions.create()
  - Language param passa para transcription
  - Response format handling (text vs verbose_json)
  - Word-level timing extraction

**Arquivo**: `src/providers/openai-compat/openai-compat-tts.ts` (109 linhas)
- **Exports**: `OpenAICompatTTSProvider` class
- **Complexidade**: SIMPLES
- **O que testar**:
  - Constructor
  - `withApiKey()`, `getModels()`, `getVoices()`
  - `synthesize()` mapeia `responseFormat` → OpenAI format
  - Voice resolution (fallback ao default)
  - Speed param
  - Content-Type detection (mp3, wav, etc.)

### OpenAI Providers (Sem API Real)
**Arquivo**: `src/providers/openai/openai-image.ts` (106 linhas)
- **Exports**: `OpenAIImageProvider` class
- **Complexidade**: SIMPLES
- **O que testar**:
  - `resolveSize()` mapeia width/height → OpenAI size string
  - Size ratio detection (landscape, portrait, square)
  - gpt-image vs dall-e model detection
  - Fetch builder (headers, body)
  - Mocks: fetch

**Arquivo**: `src/providers/openai/openai-omni.ts` (152 linhas)
- **Exports**: `OpenAIOmniProvider` class
- **Complexidade**: MÉDIO
- **O que testar**:
  - `getApiKey()` fallback para env var
  - `omniChat()` builds messages array
  - Audio format detection (Buffer vs Blob)
  - Audio base64 encoding
  - Message builder com instructions + history
  - Voice selection (default: coral)
  - Fetch builder para realtime/chat
  - Mocks: fetch

**Arquivo**: `src/providers/openai/openai-realtime.ts` (112 linhas)
- **Exports**: `OpenAIRealtimeProvider` class
- **Complexidade**: MÉDIO
- **O que testar**:
  - `createSession()` chama /v1/realtime/client_secrets
  - Session payload builder
  - Model/voice/format handling
  - turn_detection config
  - Response processing (client_secret extraction)
  - Mocks: fetch

### Benchmarking CLI Tools
**Arquivo**: `src/benchmarking/cli-bench.ts` (377 linhas)
- **Exports**: `runCliBench()`, `runWSBench()`, `runWebRTCBench()`, `buildTtfaTable()`
- **Complexidade**: MÉDIO
- **O que testar**:
  - `runCliBench()` orquestra health + sse/ws/webrtc
  - Protocol filtering (protocols param)
  - Temp file cleanup (audio_path, scriptPath)
  - `buildTtfaTable()` formata resultados em ASCII table
  - Python script injection sanitized
  - Timeout handling (60s execAsync)
  - JSON parsing from Python output
  - Error fallback messages
  - Mocks: fs, os, execAsync, makeTestWav

**Arquivo**: `src/benchmarking/ws-bench-client.ts` (103 linhas)
- **Exports**: `WS_CLIENT_PY` (string constant com Python script)
- **Complexidade**: SIMPLES
- **O que testar**:
  - Script é string válida (Python syntax)
  - Esperado ser executado por `runWSBench()`
  - Não é testado isoladamente (é um artefato de código gerado)

### Gateway Factory/Adapter
**Arquivo**: `src/create-gateway.ts` (já tem teste ✅)

**Arquivo**: `src/gateway.ts` (já tem teste ✅)

---

## GRUPO 3: Precisa de API Real
*Requer acesso a backends reais ou respostas muito específicas.*

### Core Browser SDK
**Arquivo**: `src/browser/speech-client.ts` (670 linhas)
- **Exports**: `SpeechClient` class
- **Complexidade**: COMPLEXO
- **API Real necessária?**: SIM
- **O que testar**:
  - Fallback chain orchestration (webrtc → ws → sse)
  - Discovery endpoint auto-config
  - Connection handling com cada transport
  - Reconnect logic com exponential backoff
  - Circuit breaker (N falhas → abrir)
  - Auth error detection + token refresh
  - Response timeout
  - Streaming audio chunks (onAudioChunk)
  - Metrics tracking
  - Browser API checks (AudioContext, getUserMedia, etc.)
  - Service status polling
  - Event emission (response, fallback, stage-change, error, auth-error)
  
  **Teste de integração requerido**: Um servidor mock com SSE/WS endpoints

### Core Autoscaler Engine
**Arquivo**: `src/autoscaler/engine.ts` (796 linhas)
- **Exports**: `AutoscalerEngine` class
- **Complexidade**: MUITO COMPLEXO
- **API Real necessária?**: SIM (integrações com GPU providers)
- **O que testar**:
  - Boot decision logic (quando ligar GPU)
  - Health polling + transition states (idle → booting → ready)
  - Boot timeout handling (MAX_BOOT_FAILURES, cooldown)
  - Latency-based scaling decisions
  - Session-based scaling
  - Load balancer selection (tier com menor latência)
  - State persistence e recovery
  - Concurrent request handling (decision locks)
  - Hook emission (onScaleUp, onScaleDown, etc.)
  - Instance discovery from provider
  
  **Teste de integração requerido**: Mock GPU providers + mock health checks

### GPU Provider Clients (Alguns com API Real)
Estes já têm testes, mas alguns precisam de API real:
- `src/gpu-providers/runpod-client.ts` ✅ tem testes
- `src/gpu-providers/tensordock-client.ts` ✅ tem testes
- `src/gpu-providers/vast-client.ts` ✅ tem testes
- `src/gpu-providers/modal-client.ts` ✅ tem testes
- `src/gpu-providers/tensordock-cloud-init.ts` ✅ tem testes
- `src/gpu-providers/abstract-provider.ts` ✅ tem testes

### GPU Backend Transport
**Arquivo**: `src/infra/gpu-backend.ts` (já tem teste ✅)

### AI Client
**Arquivo**: `src/client/gpu-transport.ts` (55 linhas)
- **Exports**: `GpuTransport` interface, `GpuPipelineResponse`, `GpuHealthResponse` types
- **Complexidade**: PURO TIPOS
- **API Real necessária?**: Sim (interface de comunicação)
- **Nota**: Apenas interface — implementações (DirectGpuTransport, SshGpuTransport) estão em `src/lib/` (app code)

---

## GRUPO 4: Resumo por Categoria

### Tipos Puros (NÃO Precisam Testes) — 7 arquivos
```
src/types.ts
src/deps.ts
src/storage.ts
src/gateway-api.ts
src/browser/types.ts
src/handlers/types.ts
src/gpu-providers/types.ts
src/providers/types.ts
```

### Index/Barrel Exports (NÃO Precisam Testes) — 13 arquivos
```
src/index.ts
src/autoscaler/index.ts
src/benchmarking/index.ts
src/browser/index.ts
src/client/index.ts
src/gpu-providers/index.ts
src/handlers/index.ts
src/infra/index.ts
src/providers/index.ts
src/tracking/index.ts
src/adapters/index.ts
src/auth/index.ts
src/providers/openai-compat/index.ts
```

### Model Catalogs (NÃO Precisam Testes) — 4 arquivos
```
src/providers/openai/models.ts
src/providers/groq/models.ts
src/providers/fireworks/models.ts
src/providers/openrouter/models.ts
```

### Trivial (NÃO Precisa Teste) — 1 arquivo
```
src/logger.ts (7 linhas, apenas console delegate)
```

### Pode Testar (Puro) — 14 arquivos
```
src/hooks.ts
src/browser/emitter.ts
src/browser/logger.ts
src/browser/errors.ts
src/providers/errors.ts
src/factory.ts
src/browser/streaming-audio.ts
src/browser/transport-webrtc.ts
src/providers/openai-compat/openai-compat-llm.ts
src/providers/openai-compat/openai-compat-stt.ts
src/providers/openai-compat/openai-compat-tts.ts
src/providers/openai/openai-image.ts
src/providers/openai/openai-omni.ts
src/providers/openai/openai-realtime.ts
src/benchmarking/cli-bench.ts
src/benchmarking/ws-bench-client.ts (script string, não testado isoladamente)
src/client/gpu-transport.ts (interface pura)
```

### Precisa de API Real / Integração — 2 arquivos
```
src/browser/speech-client.ts (670 linhas - muito grande)
src/autoscaler/engine.ts (796 linhas - muito complexo)
```

---

## RECOMENDAÇÕES

### Prioridade 1 (Impacto Alto, Esforço Baixo)
1. **src/browser/emitter.ts** (TypedEmitter) — 57 linhas, SIMPLES
2. **src/browser/logger.ts** — 90 linhas, SIMPLES
3. **src/browser/errors.ts** — 58 linhas, SIMPLES
4. **src/providers/errors.ts** — 127 linhas, SIMPLES
5. **src/hooks.ts** — 129 linhas, SIMPLES

### Prioridade 2 (Impacto Médio, Esforço Baixo)
6. **src/providers/openai-compat/openai-compat-llm.ts** — 85 linhas
7. **src/providers/openai-compat/openai-compat-stt.ts** — 83 linhas
8. **src/providers/openai-compat/openai-compat-tts.ts** — 109 linhas
9. **src/providers/openai/openai-image.ts** — 106 linhas
10. **src/browser/streaming-audio.ts** — 318 linhas, MÉDIO
11. **src/factory.ts** — 300 linhas, MÉDIO

### Prioridade 3 (Impacto Alto, Esforço Alto)
12. **src/browser/speech-client.ts** — 670 linhas, COMPLEXO, requer integração
13. **src/autoscaler/engine.ts** — 796 linhas, MUITO COMPLEXO, requer integração

### Baixa Prioridade (Não Precisa Testes)
- Todos os tipos puros (src/types.ts, src/deps.ts, etc.)
- Todos os index/exports
- Catálogos de modelos
- Logger trivial
- Interfaces puras

