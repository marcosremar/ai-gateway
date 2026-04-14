# Domain Model — AI Gateway

> Vocabulário compartilhado entre desenvolvedores e o AI. Todo prompt deve usar estes termos.
> A visão do sistema é ser um **Firebase for AI** — Backend-as-a-Service para aplicações de inteligência artificial.

---

## Core Domain: AI Gateway

O core é **fornecer acesso unificado a inteligência artificial**, independente de onde ela roda.

Cloud API (Groq, OpenAI, Fireworks) e GPU self-hosted (RunPod, Vast.ai, TensorDock) são **variantes do mesmo conceito** — um Provider que executa inferência. O gateway abstrai isso.

O pipeline speech-to-speech é a feature de maior valor construída sobre esse core, mas o core é o acesso.

---

## Ubiquitous Language

| Termo | Definição |
|-------|-----------|
| **Gateway** | O sistema como um todo — ponto de acesso unificado a IA |
| **Provider** | Qualquer fonte de inferência: cloud API (Groq) ou GPU (RunPod). Mesmo conceito, transports diferentes |
| **Cloud Provider** | Provider acessado via API HTTP pública (Groq, OpenAI, Fireworks, OpenRouter, Deepgram, ElevenLabs) |
| **GPU Provider** | Provider acessado via GPU self-hosted (RunPod, Vast.ai, TensorDock, Modal, SnapGPU) |
| **Chain** | Sequência ordenada de providers para uma capability. Fallback automático |
| **Race** | N providers disparados em paralelo; primeiro a responder vence, outros cancelados |
| **EWMA** | Exponential Weighted Moving Average — latência adaptativa por provider para decidir headstart |
| **Headstart** | Vantagem de tempo para o provider com menor EWMA no race |
| **Cooldown** | Bloqueio temporário de um provider após rate limit (429) ou falha |
| **Coalescing** | Requests idênticos concorrentes compartilham uma única chamada upstream |
| **Pipeline** | Execução STT → LLM → TTS por turno de fala |
| **Stage** | Etapa do pipeline: `stt`, `llm`, `tts` |
| **Overlap** | TTS começa em tokens parciais do LLM (não espera resposta completa) |
| **Fanout** | 1 transcrição → N traduções + TTS em paralelo para múltiplos idiomas |
| **Dub** | Saída de áudio dublado para um idioma-alvo |
| **Voice Clone** | TTS condicionado por áudio de referência + texto |
| **Speculative Translation** | Cache de traduções previstas na sessão |
| **Warmth** | Estado de instância GPU: `cold` (primeiro request) ou `warm` (modelo carregado) |
| **Deploy** | Provisionar uma instância GPU num provider |
| **Tier** | Uma configuração de GPU numa cascade |
| **Tier Cascade** | Sequência de tiers tentados em ordem até um funcionar |
| **Instance** | Máquina GPU provisionada (pod, machine, container) |
| **Snapshot** | Checkpoint de modelo para boot rápido (<30s) |
| **Offer** | GPU disponível no mercado (tipo, preço, região, VRAM) |
| **Probe** | Health check — HTTP GET /health |
| **Watchdog** | Processo background que monitora saúde e para instâncias idle |
| **Orphan** | Instância ativa no provider sem referência no estado local |
| **Budget Gate** | `canAffordDeploy()` — verificação de saldo antes de deploy |
| **Workload** | Unidade deployável pelo usuário: `gpu`, `bot`, ou `db` |
| **Bot** | Meeting bot (Recall.ai) em Zoom / Teams / Meet |
| **Relay** | Media server Scaleway para HLS streaming |
| **App / Profile** | Configuração salva: chain de providers, GPU settings, targets de latência |
| **Session** | Conexão ativa usando o gateway (WebSocket ou REST) |
| **Latency DB** | PostgreSQL com histórico de RTT por host GPU |

---

## Bounded Contexts

### 1. Gateway (Core)

**Responsabilidade:** fornecer acesso inteligente a IA via cloud ou GPU.

**Sub-módulos:**

**Providers** — acesso a modelos de IA
- Cloud providers: Groq, OpenAI, Fireworks, OpenRouter, Ollama, Deepgram, ElevenLabs, Modal
- GPU providers: RunPod, Vast.ai, TensorDock, Modal, SnapGPU
- Registry unificado por capability (STT, LLM, TTS, Embeddings, Images, Reranking)

**Routing** — decisão de qual provider usar
- FallbackChain: tenta em ordem, pula cooldowns
- ProviderRacer: hedged requests com EWMA
- RequestCoalescer: dedup de requests idênticos em voo
- ResponseCache: cache de respostas determinísticas
- CircuitBreaker: abre após N falhas consecutivas

**Pipeline** — STT→LLM→TTS em tempo real
- PipelineRunner: orquestra 3 stages com streaming overlap
- DubFanout: 1→N idiomas paralelos
- SpeculativeCache: predição de traduções
- VoiceClone: conditioning de TTS por referência
- StreamingSTT: transcrição contínua

**Deploy** — provisioning de GPUs para o gateway
- DeployOrchestrator: tier cascade + deploy race
- DeployStateMachine: `idle → deploying → booting → ready | error | stopped`
- HealthMonitor: probes periódicos
- AutoRecovery: replace de instância falhada
- OrphanCleanup: sweep de instâncias órfãs

**Proxy** — API OpenAI-compatível
- Drop-in replacement para OpenAI API
- Rate limit, auth, CORS, concurrency limit

**Invariantes do Gateway:**
- Budget Gate verificado antes de qualquer deploy
- Tier só vira `ready` após Probe retornar 200
- Cooldown impede retry imediato no mesmo provider
- Coalescing garante 1 chamada upstream por hash de request
- Race cancela perdedores via AbortController
- Pipeline overlap inicia TTS antes do LLM terminar

---

### 2. Compute (Supporting)

**Responsabilidade:** deploy de workloads do usuário em infra remota.

**Tipos de workload:**
- `gpu` — inference pods (RunPod, Vast.ai, etc.)
- `bot` — meeting bots (Fly.io, RunPod)
- `db` — managed PostgreSQL (Neon)

**Ciclo de vida:** `idle → deploying → running → stopped → terminated`

**Meeting Bots (sub-módulo):**
- RecallAdapter: ACL para Recall.ai
- BotLifecycle: join, leave, monitor
- AudioBridge: stream áudio do bot para o pipeline

---

### 3. Database (Supporting)

**Responsabilidade:** persistência e queries.

- DatabaseService: Prisma + raw SQL + Neon management
- LatencyDB: RTT por host GPU com probe scheduling adaptativo
- Backup/restore: Neon snapshots ou pg_dump

---

### 4. Storage (Supporting)

**Responsabilidade:** object storage para blobs.

- S3-compatible: R2, B2, AWS, MinIO, DigitalOcean Spaces
- Operações: put, get, getStream, head, presign, delete, list

---

### 5. Auth (Supporting)

**Responsabilidade:** autenticação, tokens, secrets.

- HMAC-SHA256 tokens (60s TTL para GPU pods)
- API key validation
- Vault: AES-256-GCM encrypted secret storage

---

### 6. Realtime (Supporting)

**Responsabilidade:** WebSocket broadcasting e streaming.

- Broadcast por tipo de evento (gpu:status, transcript, dub)
- Binary frames: metadata JSON + audio buffer
- Subscriptions por idioma-alvo

---

### 7. Events (Supporting)

**Responsabilidade:** pub/sub + hooks.

- Event bus tipado com histórico (últimos 1000)
- Hooks fire-and-forget: onRequestEnd, onScaleUp, onCostAlert, onHealthChange, onError
- Canais: GPU, Provider, Pipeline, Auth, Cost, System

---

### 8. Platform (Generic)

**Responsabilidade:** infraestrutura compartilhada.

- Adapters: InMemoryStateAdapter, RedisStateAdapter
- DI contracts: StateStore, SettingsStore, SessionResolver
- Logger, tracing, alerting (Slack, Discord, webhook)

---

## Eventos de Domínio

| Evento | Origem (BC) | Consumidores |
|--------|-------------|--------------|
| ProviderSelected | Gateway/Routing | Events (logging) |
| ProviderFailed | Gateway/Routing | Gateway/Routing (cooldown) |
| StageCompleted | Gateway/Pipeline | Realtime (broadcast), Events |
| AudioChunk | Gateway/Pipeline | Realtime (broadcast por idioma) |
| DeployStarted | Gateway/Deploy | Events, Realtime |
| TierReady | Gateway/Deploy | Gateway/Routing (novo endpoint) |
| InstanceStopped | Gateway/Deploy | Events, Realtime |
| CostAlert | Gateway/Deploy | Events (alert channels) |
| WorkloadCreated | Compute | Events |
| BotJoined | Compute/Bots | Realtime (broadcast) |

---

## Fluxo principal: speech-to-speech

```
WebSocket /v1/speech/ws
  ↓
Gateway/Pipeline: PipelineRunner.run()
  ├── Stage STT → Gateway/Routing: Race(GPU, Groq, Fireworks)
  ├── Stage LLM → Gateway/Routing: Race(GPU, Fireworks, OpenRouter)
  │   └── Overlap: inicia TTS com tokens parciais
  └── Stage TTS → Gateway/Routing: Race(GPU, Modal, ElevenLabs)
  ↓
Gateway/Pipeline: DubFanout (se multi-idioma)
  └── N × (LLM + TTS) em paralelo
  ↓
Realtime: broadcast áudio por idioma via WebSocket
```
