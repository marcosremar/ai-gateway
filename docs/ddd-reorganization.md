# Plano de Reorganização DDD — AI Gateway como "Firebase for AI"

> Documento de planejamento. Nenhuma mudança deve ser feita sem alinhamento.
> Última atualização: 2026-04-14

---

## Visão: Firebase for AI

O AI Gateway é uma **plataforma Backend-as-a-Service para aplicações de IA**. Assim como o Firebase fornece auth, database, storage e compute para apps web/mobile, o AI Gateway fornece:

| Firebase | AI Gateway | Status hoje |
|----------|-----------|-------------|
| Authentication | Auth + API keys + Vault | ✅ Existe (src/auth/, src/vault/) |
| Cloud Firestore | Database (Neon PostgreSQL) | ✅ Existe (src/database/) |
| Cloud Storage | Object Storage (S3/R2/B2) | ✅ Existe (src/object-storage/) |
| Cloud Functions | Compute (GPU, Bots, DB workloads) | ✅ Existe (src/workloads/) |
| Realtime Database | State Store (KV/List/Hash) + WebSocket | ✅ Existe (src/adapters/, server/ws-state.ts) |
| Pub/Sub | Event Bus | ✅ Existe (src/event-bus/) |
| Firebase SDK | Client SDK (browser + server) | ✅ Existe (src/sdk/, src/client/, src/browser/) |
| Secrets Manager | Vault (AES-256-GCM) | ✅ Existe (src/vault/) |

**Tudo já existe. O problema é que está espalhado sem coerência.**

---

## Diagnóstico: estado atual

### O que funciona bem
- `src/autoscaler/` — bounded context isolado, self-contained
- `src/proxy/` — bounded context isolado do server/
- `src/workloads/` — já tem a abstração de workload com drivers
- `src/object-storage/` — adapter S3-compatível limpo
- `src/vault/` — vault com encryption funcional
- `src/event-bus/` — pub/sub com histórico
- A regra `src/ não importa server/` existe e funciona (quase — proxy importa 1 arquivo de server/)

### O que está errado

**1. God files (complexidade acidental)**

| Arquivo | Tamanho | Deveria ser |
|---------|---------|-------------|
| `server/gpu-deploy.ts` | 182 KB | Quebrado em ~8 módulos (orchestration, monitoring, recovery, cleanup, cache) |
| `server/ai-handlers.ts` | 108 KB | Separar handlers HTTP (thin) da lógica do pipeline (rich) |
| `server/ws-server.ts` | 72 KB | Separar route registration, bot audio processing, streaming STT |
| `server/bot-handlers.ts` | 54 KB | Separar lifecycle, audio bridge, webcam/RTMP |
| `server/state.ts` | 39 KB | Quebrar por bounded context (deploy, readiness, cost, bot, metrics) |
| `server/metrics.ts` | 53 KB | Extrair em observability |

**2. Core domain no lugar errado**

Lógica de alto valor presa em `server/` (não publicável):
- `pipeline-runner.ts` — o pipeline STT→LLM→TTS
- `race-providers.ts` + `ewma-tracker.ts` — algoritmo de racing inteligente
- `speculative-cache.ts` — predição de traduções
- `streaming-overlap.ts` — TTS em tokens parciais
- `dub-fanout.ts` — multi-idioma paralelo
- `gpu-deploy.ts` — orquestração de deploy (182KB!)

**3. God object de estado (`state.ts`)**

39 KB com estado de 7 domínios misturados:
- Deploy state + locks (GPU Fleet)
- Standby deploy state (GPU Fleet)
- GPU readiness + warmth (GPU Fleet)
- Cold start profiles (GPU Fleet)
- Cost + budget (Tracking)
- Bot state (Compute/Bots)
- Metrics + latency rings (Observability)
- Request tracking (Gateway)

Cada bounded context deveria gerenciar seu próprio estado.

**4. ~40 thin wrappers sem uso claro**

Diretórios com um único `index.ts`:
```
src/async-errors/  src/null-safety/  src/memory-safe/  src/chaos/
src/async-fs/      src/error-boundary/  src/memory-watcher/  src/test-property/
src/async-utils/   src/di-container/    src/connection-pool/  src/secrets-rotation/
```

Provavelmente gerados sem necessidade real. Precisam ser auditados.

**5. Provider naming collision**

```
src/providers/      → 42+ arquivos de provedores de IA (Groq, OpenAI, Fireworks, etc.)
src/gpu-providers/  → 15 arquivos de provedores de GPU (RunPod, Vast.ai, etc.)
```

Na visão "Firebase for AI", ambos são parte do **mesmo core domain** — fornecer acesso a IA independente do transport. A separação atual cria uma fronteira artificial.

---

## Design Estratégico DDD

### Core Domain: AI Gateway

O coração do produto: **fornecer acesso unificado a inteligência artificial**, independente de onde ela roda (cloud API ou GPU self-hosted).

Inclui:
- Roteamento de requests para provedores (cloud + GPU)
- Fallback automático entre provedores
- Provider racing com EWMA (hedged requests)
- Request coalescing e caching
- Provisioning de GPU (é parte do acesso — sem GPU não há acesso)
- Pipeline STT→LLM→TTS (é uma forma de acessar IA em real-time)
- Fanout multi-idioma, voice cloning, speculative cache

**Por que tudo isso é core:** se você tirar qualquer pedaço, o produto fica significativamente pior. É tudo parte de "fornecer acesso inteligente a IA".

### Serviços da Plataforma (Supporting)

Análogos aos serviços do Firebase — cada um com API própria, mas compartilhando auth e infra base.

| Serviço | Responsabilidade |
|---------|-----------------|
| **Compute** | Deploy de workloads (GPU, Bots, DB) em infraestrutura remota |
| **Database** | PostgreSQL (Neon) + state store (KV/List/Hash) |
| **Storage** | Object storage S3-compatível (R2, B2, AWS, MinIO) |
| **Auth** | Tokens, API keys, vault de secrets |
| **Realtime** | WebSocket broadcasting, streaming de áudio |
| **Events** | Pub/sub interno + hooks de observabilidade |

### Generic (Infra)

| Módulo | Responsabilidade |
|--------|-----------------|
| **Observability** | Logging, tracing, metrics, alerting |
| **SDK** | Client libraries (browser, TypeScript, Python) |

---

## Bounded Contexts propostos

### BC 1: Gateway (Core)

Acesso unificado a IA — cloud e GPU como variantes do mesmo conceito.

```
src/gateway/
  providers/                  ← TODOS os provedores de IA (cloud + GPU são peers)
    cloud/                    Cloud APIs
      groq/
      openai/
      fireworks/
      openrouter/
      ollama/
      deepgram/
      elevenlabs/
    gpu/                      GPU self-hosted (o "transport" é diferente, o serviço é o mesmo)
      runpod/
      vast/
      tensordock/
      modal/
      snapgpu/
    types.ts                  Interface unificada: AIProvider + GpuProvider como mesma coisa
    registry.ts               Registry unificado (não dois registries separados)

  routing/                    ← Roteamento inteligente
    fallback-chain.ts           Chain com cooldown e circuit breaker
    provider-racer.ts           Hedged requests com EWMA e headstart
    ewma-tracker.ts             Média ponderada adaptativa de latência
    coalescer.ts                Dedup de requests idênticos
    response-cache.ts           Cache de respostas determinísticas
    adaptive-timeout.ts         Timeout baseado em histórico

  pipeline/                   ← Pipeline real-time (STT→LLM→TTS)
    pipeline-runner.ts          Orquestra stages com overlap
    streaming-overlap.ts        TTS em tokens parciais do LLM
    dub-fanout.ts               1 transcrição → N idiomas
    speculative-cache.ts        Predição de traduções
    voice-clone.ts              TTS condicionado por referência
    stt-race.ts                 STT multi-provider
    streaming-stt.ts            STT streaming contínuo

  deploy/                     ← Provisioning de GPU (parte do core — sem GPU não há acesso)
    orchestrator.ts             Multi-provider deploy com tiering
    deploy-race.ts              N deploys paralelos, primeiro ganha
    state-machine.ts            idle → deploying → booting → ready
    health-monitor.ts           30s health probes
    auto-recovery.ts            Replace de instância falhada
    orphan-cleanup.ts           Sweep de instâncias órfãs
    idle-manager.ts             Auto-stop/destroy por inatividade
    ssh-tunnel.ts               Tunnel para Vast.ai SSH-only

  proxy/                      ← API OpenAI-compatível (uma "view" do gateway)
    server.ts                   HTTP server
    routes/
    middleware/

  config/                     ← Apps/profiles de configuração
    persistence.ts              ~/.babelcast/provider-config.json
    apps.ts                     GatewayApp profiles
    labs.ts                     Feature flags

  state/                      ← Estado do gateway (apenas este contexto)
    deploy-state.ts             Estado do deploy ativo
    readiness-state.ts          Warmth e readiness por modelo
    standby-state.ts            Deploy de standby
    cost-state.ts               Budget tracking
    metrics-state.ts            Latency rings, counters

  types.ts
  index.ts
```

**Por que é tudo um bounded context:**
- `providers/cloud/` e `providers/gpu/` resolvem o mesmo problema (acesso a IA) por transports diferentes
- `routing/` decide QUAL provider usar
- `pipeline/` usa routing para executar STT→LLM→TTS
- `deploy/` provisiona a infraestrutura que o pipeline e o routing precisam
- `proxy/` expõe tudo via API OpenAI-compatível

Tudo serve o mesmo propósito: **dar acesso a IA de forma inteligente**.

---

### BC 2: Compute (Supporting)

Deploy de workloads em infraestrutura remota.

```
src/compute/
  workloads/
    types.ts                  Workload, WorkloadDriver, WorkloadConfig
    registry.ts               In-memory store + event emission
    gpu-driver.ts             Deploy de GPU pods
    bot-driver.ts             Deploy de meeting bots (Fly.io/RunPod)
    db-driver.ts              Managed Neon databases
  bots/
    recall-adapter.ts         ACL para Recall.ai API
    bot-lifecycle.ts          Join, leave, monitor
    audio-bridge.ts           Streaming de áudio do bot para pipeline
  image-builder/
    (já existe, mover para cá)
  types.ts
  index.ts
```

**Diferença de Gateway vs Compute:**
- Gateway `deploy/` = provisionar GPU **para o próprio gateway usar** (self-hosted inference)
- Compute `workloads/gpu-driver.ts` = provisionar GPU **para o usuário** (workload as a service)

Se são a mesma infra por baixo: Compute pode delegar para Gateway internamente.

---

### BC 3: Database (Supporting)

Persistência e queries.

```
src/database/
  service.ts                  DatabaseService (Prisma + raw SQL + Neon management)
  config.ts                   Connection config
  neon-management.ts          Branch/endpoint lifecycle
  pg-driver.ts                Raw SQL driver
  backup.ts                   Snapshot + restore
  latency/
    latency-db.ts             Host RTT tracking (PostgreSQL)
    latency-scheduler.ts      Adaptive probe intervals
    migrations.ts             Schema migrations
  types.ts
  index.ts
```

---

### BC 4: Storage (Supporting)

Object storage para blobs (model weights, recordings, exports).

```
src/storage/
  object-store.ts             S3-compatible adapter (R2/B2/AWS/MinIO)
  types.ts
  index.ts
```

(Já existe em `src/object-storage/`, renomear)

---

### BC 5: Auth (Supporting)

Autenticação, autorização e secrets.

```
src/auth/
  tokens.ts                   HMAC-SHA256 token signing/verification
  api-keys.ts                 API key validation
  vault/
    vault.ts                  AES-256-GCM encryption
    file-store.ts             File-based backend
    types.ts
  rbac.ts                     Role-based access control
  types.ts
  index.ts
```

---

### BC 6: Realtime (Supporting)

WebSocket broadcasting e streaming.

```
src/realtime/
  ws-broadcast.ts             Broadcast por tipo de evento/idioma
  binary-frame.ts             Pack metadata + audio buffer
  subscriptions.ts            Subscribe/unsubscribe por idioma-alvo
  types.ts
  index.ts
```

---

### BC 7: Events (Supporting)

Pub/sub + hooks de observabilidade.

```
src/events/
  event-bus.ts                Pub/sub tipado com histórico
  hooks.ts                    Fire-and-forget hooks (onRequestEnd, onScaleUp, etc.)
  types.ts
  index.ts
```

---

### BC 8: Platform (Generic)

Infraestrutura compartilhada.

```
src/platform/
  adapters/                   InMemoryStateAdapter, RedisStateAdapter
  logger.ts
  observability/              Tracing, metrics, alerting
  deps.ts                     Contratos DI (StateStore, SettingsStore, etc.)
  types.ts
  index.ts
```

---

### Delivery Layer (server/)

**Zero lógica de negócio.** Apenas:
- Recebe request HTTP ou WebSocket
- Autentica
- Chama o bounded context correto
- Serializa resposta

```
server/
  index.ts                    Entry point
  startup.ts                  Wiring (cria gateway, registra rotas)
  routes/
    gateway/                  Endpoints do gateway (/v1/transcribe, /v1/chat, /v1/speech, etc.)
      inference.ts            STT, LLM, TTS endpoints
      pipeline.ts             Speech-to-speech pipeline
      gpu.ts                  GPU management endpoints
      gpu-info.ts             GPU catalog, offers, types
      gpu-settings.ts         Latency settings, deploy settings
      config.ts               App profiles, provider config
    compute/                  Endpoints de compute (/v1/workloads/*)
      workloads.ts
      bots.ts
      images.ts
    proxy/                    Forward para gateway proxy
    diagnostics/              Health, metrics, diagnostics
  ws/
    server.ts                 WebSocket setup
    commands.ts               WS command routing
    bot-audio.ts              Bot audio buffering e processing
    streaming-stt.ts          Streaming STT sessions
```

---

## Context Map — como os BCs se comunicam

```
                        ┌────────────┐
                        │   Auth     │
                        └─────┬──────┘
                              │ valida tokens
                              ▼
┌──────────┐    ┌─────────────────────────────┐    ┌──────────┐
│ Compute  │◀───│       GATEWAY (Core)        │───▶│ Database │
│          │    │                             │    │          │
│ workloads│    │  providers + routing +      │    │ latency  │
│ bots     │    │  pipeline + deploy + proxy  │    │ config   │
│ images   │    │                             │    │          │
└──────────┘    └──────────────┬──────────────┘    └──────────┘
                               │
                    ┌──────────┼──────────┐
                    ▼          ▼          ▼
              ┌─────────┐ ┌────────┐ ┌────────┐
              │Realtime │ │ Events │ │Storage │
              │         │ │        │ │        │
              │WebSocket│ │pub/sub │ │S3/R2   │
              │broadcast│ │hooks   │ │blobs   │
              └─────────┘ └────────┘ └────────┘
                    │          │          │
                    └──────────┼──────────┘
                               ▼
                         ┌──────────┐
                         │ Platform │
                         │adapters  │
                         │logger    │
                         │DI deps   │
                         └──────────┘
```

**Relações:**
- Gateway usa Database (latency DB, config persistence)
- Gateway usa Realtime (broadcast status, áudio)
- Gateway usa Events (emit onScaleUp, onRequestEnd, etc.)
- Gateway usa Auth (validar tokens de GPU pods)
- Compute delega para Gateway (provisionar GPUs) — shared kernel ou customer-supplier
- Todos usam Platform (adapters, logger, deps)

---

## Regras de dependência

```
gateway/     → pode usar: platform/, auth/, database/, realtime/, events/, storage/
compute/     → pode usar: platform/, auth/, gateway/ (para provisionar GPU)
database/    → pode usar: platform/
storage/     → pode usar: platform/
auth/        → pode usar: platform/
realtime/    → pode usar: platform/
events/      → pode usar: platform/
server/      → pode usar: TUDO de src/ (é a camada de composição)
src/         → NÃO importa server/ (CI enforced)
```

---

## Estratégia de migração

### Princípios

1. **Sem big bang** — mover módulo a módulo
2. **Tests first** — garantir cobertura antes de mover
3. **Barrel exports** — manter `index.ts` com re-exports para não quebrar imports existentes
4. **Um PR por fase** — cada fase é reviewable isoladamente
5. **Feature flag off** — código novo convive com código antigo até validar

### Fase 0: Preparação (1-2 dias)

- [ ] Auditar thin wrappers: quais dos ~40 diretórios com 1 arquivo são usados?
- [ ] Remover os não usados
- [ ] Corrigir violação: `src/proxy/server.ts` importa de `server/middleware/security-headers.ts`
- [ ] Adicionar lint rule para prevenir novas violações
- [ ] Adicionar barrel exports para os módulos que vão mover (backwards compat)

### Fase 1: Extrair Platform (1 dia)

Mover infraestrutura compartilhada para `src/platform/`:
- [ ] `src/adapters/` → `src/platform/adapters/`
- [ ] `src/deps.ts` → `src/platform/deps.ts`
- [ ] `src/logger.ts` → `src/platform/logger.ts`
- [ ] `src/observability/` → `src/platform/observability/`
- [ ] Criar `src/platform/index.ts` com re-exports
- [ ] Manter barrel em `src/adapters/index.ts` → re-export de `src/platform/adapters`
- [ ] Manter barrel em `src/deps.ts` → re-export de `src/platform/deps`

### Fase 2: Organizar serviços de plataforma existentes (1 dia)

Apenas renomear/mover — sem mudança de lógica:
- [ ] `src/vault/` → `src/auth/vault/`
- [ ] `src/object-storage/` → `src/storage/`
- [ ] `src/event-bus/` → `src/events/`
- [ ] `src/hooks.ts` → `src/events/hooks.ts`
- [ ] `src/database/` → `src/database/` (fica onde está)
- [ ] Barrels para backwards compat

### Fase 3: Unificar providers em Gateway (2-3 dias)

Este é o passo conceitual mais importante:
- [ ] Criar `src/gateway/`
- [ ] Mover `src/providers/` → `src/gateway/providers/cloud/`
- [ ] Mover `src/gpu-providers/` → `src/gateway/providers/gpu/`
- [ ] Mover `src/proxy/` → `src/gateway/proxy/`
- [ ] Mover `src/autoscaler/` → `src/gateway/autoscaler/`
- [ ] Criar `src/gateway/providers/types.ts` — interface unificada
- [ ] Criar `src/gateway/providers/registry.ts` — registry único (cloud + GPU)
- [ ] Barrels para backwards compat

### Fase 4: Mover core domain de server/ para src/gateway/ (3-5 dias)

A fase mais importante — liberta a lógica de negócio do server:
- [ ] `server/race-providers.ts` → `src/gateway/routing/provider-racer.ts`
- [ ] `server/ewma-tracker.ts` → `src/gateway/routing/ewma-tracker.ts`
- [ ] `server/speculative-cache.ts` → `src/gateway/pipeline/speculative-cache.ts`
- [ ] `server/streaming-overlap.ts` → `src/gateway/pipeline/streaming-overlap.ts`
- [ ] `server/dub-fanout.ts` → `src/gateway/pipeline/dub-fanout.ts`
- [ ] `server/pipeline-runner.ts` → `src/gateway/pipeline/pipeline-runner.ts`
- [ ] `server/deployment-state-machine.ts` → `src/gateway/deploy/state-machine.ts`
- [ ] Extrair lógica de `server/ai-handlers.ts` (108KB):
  - Funções GPU fetch → `src/gateway/pipeline/gpu-fetch.ts`
  - Lógica de routing → `src/gateway/routing/`
  - Handlers HTTP ficam em `server/routes/gateway/inference.ts`
- [ ] Extrair lógica de `server/gpu-deploy.ts` (182KB):
  - Orchestration → `src/gateway/deploy/orchestrator.ts`
  - Health monitoring → `src/gateway/deploy/health-monitor.ts`
  - Auto-recovery → `src/gateway/deploy/auto-recovery.ts`
  - Orphan cleanup → `src/gateway/deploy/orphan-cleanup.ts`
  - GPU cache → `src/gateway/deploy/gpu-cache.ts`
  - Handlers HTTP ficam em `server/routes/gateway/gpu.ts`

### Fase 5: Quebrar state.ts (2 dias)

Decompor o god object por bounded context:
- [ ] Estado de deploy → `src/gateway/state/deploy-state.ts`
- [ ] Readiness + warmth → `src/gateway/state/readiness-state.ts`
- [ ] Standby → `src/gateway/state/standby-state.ts`
- [ ] Cost/budget → `src/gateway/state/cost-state.ts`
- [ ] Bot state → `src/compute/bots/bot-state.ts`
- [ ] Metrics/rings → `src/platform/observability/metrics-state.ts`
- [ ] Request tracking → `src/gateway/state/request-state.ts`
- [ ] Cada módulo expõe apenas suas próprias funções de mutação

### Fase 6: Separar delivery layer (2-3 dias)

Quebrar `server/ws-server.ts` (72KB) em routes organizadas:
- [ ] Criar `server/routes/gateway/`
- [ ] Criar `server/routes/compute/`
- [ ] Criar `server/ws/`
- [ ] `ws-server.ts` vira apenas o setup + route registration
- [ ] Handlers viram thin wrappers que delegam para src/

### Fase 7: Compute (1-2 dias)

Reorganizar workloads:
- [ ] `src/workloads/` → `src/compute/workloads/`
- [ ] Extrair lógica de `server/bot-handlers.ts` (54KB) para `src/compute/bots/`
- [ ] `server/recall-handlers.ts` → handlers thin + `src/compute/bots/recall-adapter.ts`
- [ ] `server/relay-handlers.ts` → handlers thin + `src/compute/relay/`
- [ ] `src/image-builder/` → `src/compute/image-builder/`

---

## Resultado final esperado

Após todas as fases:

```
src/
  gateway/          ← Core Domain (40-50 módulos focados)
    providers/        cloud/ + gpu/ unificados
    routing/          fallback, racer, coalescer, cache
    pipeline/         STT→LLM→TTS, dub, speculative, overlap
    deploy/           orchestrator, state-machine, monitoring
    autoscaler/       engine, boot, watchdog, reconcile
    proxy/            OpenAI-compatible API
    config/           apps, profiles, persistence
    state/            deploy, readiness, cost (por contexto)

  compute/          ← Workloads-as-a-Service
    workloads/        registry, drivers (gpu, bot, db)
    bots/             recall adapter, audio bridge
    relay/            media relay (Scaleway)
    image-builder/    Docker image builds

  database/         ← Data Layer
  storage/          ← Object Storage
  auth/             ← Tokens + Vault
  events/           ← Event bus + Hooks
  realtime/         ← WebSocket broadcast
  platform/         ← Adapters, logger, DI, observability
  client/           ← SDK (browser, TypeScript, Python)

server/             ← Delivery Layer (thin)
  routes/             handlers HTTP por contexto
  ws/                 WebSocket setup + command routing
  startup.ts          wiring
  index.ts
```

---

## Métricas de sucesso

| Métrica | Hoje | Meta |
|---------|------|------|
| Maior arquivo | 182 KB (gpu-deploy.ts) | < 30 KB |
| state.ts | 39 KB, 7 domínios | Eliminado; estado por BC |
| Lógica de negócio em server/ | ~500 KB | < 50 KB (apenas handlers HTTP) |
| ws-server.ts | 72 KB, 80+ rotas | < 10 KB (setup + registration) |
| Thin wrappers sem uso | ~40 dirs | 0 |
| Provider registries | 2 separados | 1 unificado |
| Imports cross-context | Livre | Lint rules enforced |

---

## Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| Quebrar imports existentes | Barrel exports + re-exports mantidos até todo consumidor migrar |
| Regressões | Rodar `bun run test` após cada move; manter CI green |
| Merge conflicts em WIP | Cada fase é 1 PR; não manter branches longas |
| Perder a referência de onde algo estava | Commits com mensagem clara: "move X from A to B" |
| Over-engineering | Cada fase só reorganiza; nenhuma lógica é reescrita |
| Scope creep | Fases são independentes; pode parar após qualquer uma |

---

## O que NÃO está neste plano

- Reescrita de lógica — apenas reorganização
- Novos features — apenas mover código existente
- Mudança de APIs HTTP — endpoints não mudam
- Separação em múltiplos repositórios — continua monorepo
- Mudança de stack (Bun, TypeScript, Vitest) — tudo fica igual
