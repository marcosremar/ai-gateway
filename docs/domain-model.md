# Domain Model — AI Gateway

> Vocabulário compartilhado entre desenvolvedores e o AI. Todo prompt deve usar estes termos.
> Baseado em DDD (Domain-Driven Design). Atualizar quando o domínio evoluir.

---

## O que este sistema faz (visão real)

Este é uma **plataforma de inferência AI full-stack**. Não é só um autoscaler de GPU.

Ele faz quatro coisas grandes:

1. **Pipeline speech-to-speech em tempo real** — STT → LLM → TTS com latência <100ms, multi-idioma, voice cloning
2. **Gerenciamento de infraestrutura GPU** — provisiona, monitora, otimiza e destrói instâncias em 5+ provedores cloud
3. **Proxy OpenAI-compatível** — substitui a OpenAI API com fallback transparente entre provedores
4. **Orquestração de workloads** — gerencia GPU deploys, meeting bots (Zoom/Teams/Meet) e database jobs com API unificada

---

## Ubiquitous Language

Termos canônicos do projeto. Use exatamente como escritos em código e prompts.

| Termo | Definição |
|-------|-----------|
| **Pipeline** | Sequência STT → LLM → TTS executada por turno de fala |
| **Stage** | Uma etapa do pipeline: `stt`, `llm`, `tts` |
| **Fanout** | Uma transcrição → N traduções + TTS em paralelo para múltiplos idiomas |
| **Dub** | Saída de áudio dublado para um idioma-alvo específico |
| **Voice Clone** | TTS condicionado por áudio de referência + texto do usuário |
| **Warmth** | Estado de uma instância GPU: `cold` (primeiro request) ou `warm` (modelo já carregado) |
| **Speculative Translation** | Cache de traduções previstas dentro de uma sessão para reduzir latência |
| **Deploy** | Processo de provisionar uma instância GPU em um provedor cloud |
| **Tier** | Uma configuração de GPU dentro de uma cascade (ex: tier[0]=RunPod, tier[1]=Vast.ai) |
| **Tier Cascade** | Sequência de tiers tentados em ordem até um subir com sucesso |
| **Instance** | Máquina GPU criada num provedor cloud |
| **Snapshot** | Checkpoint do estado de modelo + cache para boot rápido (<30s) |
| **Offer** | GPU disponível para contratar num provedor (tipo, preço, região, VRAM) |
| **Provider Race** | N candidatos disparados em paralelo; primeiro a responder vence |
| **EWMA** | Exponential Weighted Moving Average — média de latência adaptativa por provedor |
| **Headstart** | Vantagem de tempo dada ao provider com menor EWMA no race |
| **Cooldown** | Período de bloqueio de um provedor após falha (rate limit, timeout) |
| **Orphan** | Instância GPU ativa no provedor sem referência no estado local |
| **Watchdog** | Processo background que verifica saúde e para instâncias idle |
| **Budget Gate** | `canAffordDeploy()` — verificação de saldo antes de qualquer deploy |
| **Session** | Conexão ativa de usuário usando o pipeline (WebSocket ou REST) |
| **Workload** | Unidade orquestrável: pode ser `gpu`, `bot`, ou `db` |
| **Bot** | Meeting bot (Recall.ai) implantado em Zoom / Google Meet / Teams |
| **Relay** | Instância de media server Scaleway para streaming HLS sob demanda |
| **Latency DB** | Banco PostgreSQL com histórico de RTT por host GPU |
| **Probe** | HTTP GET `/health` ou RTT measurement para validar disponibilidade |
| **Coalescing** | Requests LLM idênticos concorrentes compartilham uma única chamada upstream |
| **Profile** | Configuração de pipeline salva pelo usuário (cadeia de providers, GPU settings) |

---

## Bounded Contexts

### 1. Real-Time Speech Pipeline (core)

**Arquivos:** `server/pipeline-runner.ts`, `server/ai-handlers.ts`, `server/dub-fanout.ts`, `server/race-providers.ts`

**Responsabilidade:** executar STT → LLM → TTS com mínima latência, suporte a múltiplos idiomas e voice cloning.

**Entidades:**
- `PipelineRun` — execução de uma fala: input WAV → transcription → translation → output WAV
- `Stage` — etapa individual (stt / llm / tts) com provider, latência, warmth
- `DubFanout` — execução paralela de N `(llm + tts)` para idiomas-alvo diferentes
- `VoiceClone` — par (áudio de referência + texto) para condicionar TTS

**Serviços de domínio:**
- `PipelineRunner` — orquestra as 3 stages com streaming overlap e circuit breaker por stage
- `DubFanout` — dispara fanout de idiomas, broadcast de áudio/subtitles por WebSocket
- `RaceProviders` — hedged request com EWMA e headstart
- `SpeculativeCache` — prediz e armazena traduções da sessão

**Value Objects:**
- `StageResult` — latência, provider usado, warmth, erro se falhou
- `PipelineResult` — soma dos stages com timing breakdown completo

**Invariantes:**
- Overlap começa TTS em tokens parciais do LLM — não esperar resposta completa
- Voice clone: prioridade GPU → Modal → cloud fallback
- Circuit breaker por stage — muitas falhas abre o circuito e faz fallback para cloud
- Speculative cache usa confidence threshold antes de servir resultado previsto

---

### 2. GPU Infrastructure (core)

**Arquivos:** `src/gpu-providers/`, `src/autoscaler/`, `server/gpu-handlers.ts`, `server/gpu-deploy.ts`, `server/latency-db.ts`

**Responsabilidade:** provisionar, monitorar, otimizar latência e destruir instâncias GPU em 5+ provedores.

**Entidades:**
- `GpuInstance` — instância criada, com id, endpoint, provider, status
- `GpuTierConfig` — spec de um tier: provider, GPU types, imagem Docker, região, timeouts
- `GpuTierState` — estado runtime de um tier: `IdleTierState | BootingTierState | ReadyTierState`
- `DeploySettings` — preferências do usuário (GPU priority, filtros, sort strategy)
- `Snapshot` — checkpoint de modelo + cache para boot rápido
- `HostLatency` — medições persistidas de RTT por host GPU (Prisma/PostgreSQL)

**Serviços de domínio:**
- `AutoscalerEngine` — decide quando bootar/parar tiers com base em sessions e latência
- `BootOrchestrator` — executa race de boot entre providers na cascade
- `Watchdog` — background: verifica saúde, para instâncias idle, detecta orphans
- `Reconciler` — elimina orphans
- `LatencyScheduler` — agenda probes adaptativas (estável: 2h, instável: 30m, falhando: 6h)

**Agregados:**
- `DeploymentStateMachine` — máquina de estado do deploy ativo: `idle → deploying → booting → ready | error | stopped`
- `TierCascade` — conjunto de GpuTierConfigs + GpuTierStates para um usuário

**Invariantes:**
- Budget Gate verificado antes de qualquer boot (em `startDeployWithTiers` E `startDeployRace`)
- Tier só vira `ready` após Health Probe retornar 200
- `monitorCrashRecoveryAttempts` NÃO é resetado por `resetIdleState()` — intencional
- Nenhum código fora de `src/gpu-providers/` conhece detalhes de API dos provedores
- Todas as ops GPU passam pela gateway API — nunca chamar RunPod/Vast.ai/TensorDock direto

**Estados do Deploy:**
```
idle → deploying → booting → ready
                          → error
                          → stopped → [destruído após 2h]
```

---

### 3. OpenAI-Compatible Proxy (core)

**Arquivos:** `src/proxy/server.ts`, `src/proxy/routes/`, `src/proxy/middleware/`

**Responsabilidade:** substituir a OpenAI API com roteamento inteligente, fallback transparente e otimizações de throughput.

**Entidades:**
- `ProviderChain` — lista ordenada de providers para fallback
- `CooldownTracker` — providers bloqueados após rate limit (429)
- `RequestCoalescer` — requests LLM idênticos concorrentes em voo
- `ResponseCache` — cache de respostas determinísticas (temp=0)

**Endpoints expostos:**
- `POST /v1/chat/completions` — LLM com streaming SSE e fallback
- `POST /v1/audio/transcriptions` — STT multipart
- `POST /v1/audio/speech` — TTS
- `POST /v1/embeddings` — embeddings
- `GET /v1/models` — catálogo de modelos disponíveis

**Invariantes:**
- Rate limit por usuário via token buckets
- Concurrency limit por usuário
- Cooldown entra após 429 — não retenta o mesmo provider imediatamente
- Coalescing: requests com mesmo hash compartilham uma única chamada upstream
- Erros retornam no formato OpenAI (`{ error: { message, type, code } }`)

---

### 4. Workload Orchestration (supporting)

**Arquivos:** `server/workload-handlers.ts`, `server/recall-handlers.ts`, `server/relay-handlers.ts`

**Responsabilidade:** ciclo de vida unificado para três tipos de workload.

**Tipos de Workload:**

| Tipo | O que é | Provedor |
|------|---------|---------|
| `gpu` | Instância GPU para inferência | RunPod, Vast.ai, TensorDock, Modal |
| `bot` | Meeting bot que grava e transmite áudio | Recall.ai (Zoom, Teams, Meet) |
| `db` | Job de database / migração | interno |

**Entidades:**
- `Workload` — unidade com id, tipo, estado, config
- `Bot` — meeting bot com meeting URL, estado, stream de áudio
- `Relay` — instância Scaleway de media server com HLS URL

**Ciclo de vida unificado:**
```
POST /v1/workloads         → criar
GET  /v1/workloads/:id     → status
POST /v1/workloads/:id/start   → retomar
POST /v1/workloads/:id/stop    → pausar
DELETE /v1/workloads/:id       → destruir
```

---

### 5. Persistence & State (infrastructure)

**Arquivos:** `src/storage.ts`, `src/adapters/`, `src/deps.ts`, `server/latency-db.ts`, `server/cooldown-persistence.ts`

**Responsabilidade:** abstrair storage para que a lógica de domínio não dependa de implementação.

**Interfaces:**
- `StateStore` (KV + List + Hash) — estado de tiers, sessions, latências
- `SettingsStore` — configuração por usuário (provider chain, perfis)
- `Storage` — adapter completo: settings, sessions, benchmarks, lifecycle logs, deploy history

**Implementações:**
- `InMemoryStateAdapter` — testes e dev single-node
- `RedisStateAdapter` — produção multi-instância
- Prisma/PostgreSQL — `HostLatency`, deploy history, benchmarks, snapshots

**Arquivos locais `~/.babelcast/`:**
- `active_deploy.json` — pod ativo (sobrevive restart)
- `daily_spend.json` — gasto acumulado (atomic write, debounced 10s)
- `cooldowns.json` — cooldowns por provedor
- `provider-config.json` — configuração de chains e perfis

---

## Eventos de Domínio

| Evento | Origem | Consumidores |
|--------|--------|--------------|
| `DeployStarted` | AutoscalerEngine | Watchdog, WS broadcast |
| `TierReady` | BootOrchestrator | LoadBalancer, WS broadcast |
| `TierError` | BootOrchestrator | Cascade fallback para próximo tier |
| `InstanceStopped` | Watchdog | StateStore, WS broadcast |
| `CostAlert` | CostMonitor | Hooks externos |
| `LatencyBreach` | LatencyTracker | AutoscalerEngine (scale-up) |
| `SessionStarted/Ended` | SessionTracker | AutoscalerEngine (idle detection) |
| `StageStart/Done` | PipelineRunner | Analytics, WS broadcast |
| `AudioChunk` | TTS stage | WS broadcast por idioma |
| `BotJoined/Left` | RecallHandlers | WS broadcast |

---

## Fluxo principal (speech-to-speech)

```
WebSocket /v1/speech/ws  (áudio do usuário)
  ↓
PipelineRunner.run()
  ├── Stage STT  →  RaceProviders(GPU, Groq, ...)  →  transcrição
  ├── Stage LLM  →  RaceProviders(GPU, Fireworks, ...) → tradução (inicia TTS em paralelo se streaming overlap ativo)
  └── Stage TTS  →  RaceProviders(GPU, Modal, ...) → áudio
  ↓
DubFanout (se multi-idioma)
  └── N × (LLM + TTS) em paralelo → broadcast por idioma via WS
  ↓
WebSocket broadcast → clientes subscritos
```
