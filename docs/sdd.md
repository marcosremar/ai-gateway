# Software Design Document — AI Gateway

> Decisões arquiteturais já tomadas. O AI deve respeitá-las em vez de reinventá-las.
> Atualizar quando uma decisão for revisada — não quando o código mudar.

---

## O que é este sistema

**Plataforma de inferência AI full-stack** com quatro responsabilidades:

1. **Speech-to-speech em tempo real** — STT → LLM → TTS <100ms, multi-idioma, voice cloning
2. **Gestão de GPU cloud** — provisionamento, ciclo de vida, snapshots, latency DB em 5+ provedores
3. **Proxy OpenAI-compatível** — drop-in replacement com fallback, coalescing, cache
4. **Orquestração de workloads** — GPU deploys, meeting bots (Recall.ai) e database jobs com API unificada

---

## Mapa de módulos

```
src/                        Lib publicável (tree-shakeable, 12 entry points)
  proxy/                    Proxy OpenAI-compatível (rate limit, auth, fallback)
  autoscaler/               Decisões de boot/stop, watchdog, reconciler
  gpu-providers/            Clientes cloud (RunPod, Vast.ai, TensorDock, Modal, SnapGPU)
  providers/                Clientes AI (Groq, OpenAI, Fireworks, OpenRouter, self-hosted)
  adapters/                 InMemoryStateAdapter, RedisStateAdapter
  storage.ts                Interface de storage (adapter pattern)
  deps.ts                   Contratos DI (AutoscalerDeps, StateStore, SettingsStore)
  create-gateway.ts         Entry point público — wiring de todos os componentes

server/                     Servidor de referência (importa src/, nunca o contrário — CI enforced)
  ws-server.ts              HTTP + WebSocket server (Bun.serve) + registro de rotas
  pipeline-runner.ts        Engine do pipeline STT→LLM→TTS com streaming overlap
  ai-handlers.ts            Handlers /v1/transcribe, /v1/translate, /v1/chat, /v1/speech
  gpu-handlers.ts           Handlers /v1/gpu/* (28 endpoints)
  gpu-deploy.ts             Deploy orchestration (startDeployWithTiers, startDeployRace)
  deployment-state-machine.ts  Estado do deploy ativo (máquina de estados)
  workload-handlers.ts      API unificada /v1/workloads (gpu, bot, db)
  recall-handlers.ts        Meeting bots via Recall.ai
  relay-handlers.ts         Media relay Scaleway para HLS
  dub-fanout.ts             Fanout multi-idioma após STT
  race-providers.ts         Hedged requests com EWMA
  latency-db.ts             Banco PostgreSQL de RTT por host GPU
  latency-scheduler.ts      Agendamento adaptativo de probes
```

---

## Decisões arquiteturais

### 1. src/ não importa server/ (lei, CI enforced)

`src/` é a lib publicável. Nunca depende do servidor de referência.

**Impacto:** toda lógica reutilizável vai em `src/`; o servidor apenas compõe.

---

### 2. DI via interfaces, sem acoplamento a banco ou framework

`src/` não conhece Prisma, Redis nem Next.js. Tudo injetado via `AutoscalerDeps` e `Storage`:

```typescript
interface AutoscalerDeps {
  settingsStore: SettingsStore;
  stateStore: StateStore;       // KV + List + Hash
  sessionResolver: SessionResolver;
  logger?: Logger;
}
```

**Impacto:** testes usam `InMemoryStateAdapter`; produção usa Redis. Trocar sem mudar lógica.

---

### 3. HTTP server sem framework (Bun native)

Rotas registradas como flat object:
```typescript
handlers['POST /v1/gpu/deploy'] = gh.handleGpuDeploy;
```

Zero Express/Hono/Fastify.

**Impacto:** sem magic de framework para debugar; overhead mínimo.

---

### 4. Tier cascade como estratégia de resiliência GPU

Provedores tentados em ordem: **RunPod → Vast.ai → TensorDock → Modal**.

Cada tier tem GPU types, imagem Docker, região e timeouts próprios.

**Impacto:** SLA mantido mesmo com falha parcial de provedores.

---

### 5. Deploy race para reduzir cold start

`startDeployRace` dispara N deploys em paralelo, usa o primeiro pronto, cancela os demais.

**Impacto:** P99 de cold start reduzido significativamente.

---

### 6. Provider race com EWMA para todas as stages do pipeline

`RaceProviders` dispara GPU + cloud em paralelo. Timeout adaptativo baseado em EWMA de latência histórica. Provider com menor EWMA recebe headstart de 50ms.

**Impacto:** latência de pipeline P95 melhora progressivamente com uso.

---

### 7. Streaming overlap LLM → TTS

TTS começa em tokens parciais do LLM antes da resposta completa.

**Impacto:** ~100-200ms de redução de latência percebida no primeiro chunk de áudio.

---

### 8. Modelos pré-baked na imagem Docker, nunca lazy download

Modelos baixados no `docker build`, não no startup.

**Impacto:** benchmark real mostrou +63% vs lazy download (Vast.ai RTX 4090 + NVMe). Layer cache domina.

---

### 9. Budget Gate obrigatório antes de qualquer deploy

`canAffordDeploy()` verificado em `startDeployWithTiers` E `startDeployRace`.

**Impacto:** fail-fast; sem gasto não intencional.

---

### 10. Latency DB para seleção inteligente de GPU

PostgreSQL (Neon) com histórico de RTT por host. Probe scheduling adaptativo:
- Host estável → probe a cada 2h
- Host instável → probe a cada 30min
- Host falhando → probe a cada 6h

**Impacto:** `sortGpuTypesByLatency()` usa dados reais para selecionar o host mais rápido.

---

### 11. Estado persistido em ~/.babelcast/ (local) ou Redis (cloud)

`active_deploy.json`, `daily_spend.json`, `cooldowns.json`, `provider-config.json`.

**Impacto:** servidor é stateful por design; Redis é opcional para single-node.

---

## Fronteiras que o AI deve respeitar

| Fronteira | Regra |
|-----------|-------|
| `src/` vs `server/` | `src/` nunca importa `server/` |
| GPU ops | Sempre via gateway API — nunca direto no provedor |
| Prisma/Redis/Next.js | Somente em `server/` ou via adapter interface |
| Clientes GPU | Sempre via `GpuProviderClient` interface |
| UI components | Sempre `web/src/components/ui/` — nunca reinventar |

---

## O que NÃO fazer

- **Não** chamar RunPod/Vast.ai/TensorDock direto — bypassa watchdog e cost tracking
- **Não** adicionar Prisma em `src/` — quebra a lib publicável
- **Não** resetar `monitorCrashRecoveryAttempts` em `resetIdleState()` — intencional
- **Não** usar volumes de rede com imagens pre-baked — zero benefício
- **Não** usar `HF_HUB_ENABLE_HF_TRANSFER` — deprecated; usar `hf-xet`
- **Não** benchmarkar cold start em Mac/laptop — números enganosos vs. GPU real
- **Não** usar R2/B2 para servir pesos de modelo — 8x mais lento que HF CloudFront

---

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Runtime | Bun |
| Linguagem | TypeScript |
| Testes | Vitest (sequential) |
| Build | tsup (ESM + CJS + .d.ts) |
| HTTP/WS | Bun.serve() nativo |
| DB (server) | Prisma + PostgreSQL (Neon) |
| Estado (prod) | Redis via `RedisStateAdapter` |
| Estado (dev/test) | `InMemoryStateAdapter` |
| UI | Next.js + Tailwind |
| GPU providers | RunPod, Vast.ai, TensorDock, Modal, SnapGPU |
| AI providers | Groq, OpenAI, Fireworks, OpenRouter, self-hosted |
| Meeting bots | Recall.ai |
| Media relay | Scaleway |
