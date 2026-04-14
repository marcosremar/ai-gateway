# Software Design Document — AI Gateway

> Decisões arquiteturais já tomadas. O AI deve respeitá-las em vez de reinventá-las.
> Visão: **Firebase for AI** — Backend-as-a-Service para aplicações de inteligência artificial.

---

## O que é este sistema

Plataforma que fornece **acesso unificado a inteligência artificial** independente de onde ela roda (cloud API ou GPU self-hosted), com serviços de plataforma (database, storage, auth, compute, realtime) ao redor.

Analogia: o Firebase fornece auth + database + storage + functions para apps web/mobile. O AI Gateway fornece o equivalente para apps de IA.

---

## Serviços da plataforma

| Serviço | O que faz | Implementação |
|---------|-----------|---------------|
| **Gateway** (core) | Acesso a IA: routing, fallback, racing, pipeline STT→LLM→TTS, GPU deploy | src/gateway/ |
| **Compute** | Deploy de workloads do usuário (GPU, bots, DB) | src/compute/ |
| **Database** | PostgreSQL (Neon) + latency DB | src/database/ |
| **Storage** | Object storage S3-compatível | src/storage/ |
| **Auth** | Tokens + API keys + vault de secrets | src/auth/ |
| **Realtime** | WebSocket broadcast + streaming | src/realtime/ |
| **Events** | Pub/sub + hooks de observabilidade | src/events/ |
| **Platform** | Adapters, DI, logger | src/platform/ |

---

## Decisões arquiteturais

### 1. Cloud e GPU são variantes do mesmo conceito

**Decisão:** `CloudProvider` e `GpuProvider` implementam a mesma interface e vivem no mesmo registry.

**Por quê:** o gateway abstrai de onde a IA vem. O caller não precisa saber se um request foi para Groq (cloud) ou para um pod RunPod (GPU). São transports diferentes para o mesmo serviço.

---

### 2. src/ é a lib publicável, server/ é thin delivery layer

**Decisão:** toda lógica de negócio em `src/`. `server/` apenas recebe HTTP, autentica, delega para src/, serializa resposta.

**Por quê:** qualquer consumidor da lib deve levar junto o gateway, pipeline, routing, deploy — sem precisar do servidor HTTP específico.

**CI enforced:** `src/` não importa `server/`.

---

### 3. HTTP server sem framework (Bun native)

**Decisão:** `Bun.serve()` + flat object de rotas. Sem Express/Hono/Fastify.

**Por quê:** zero overhead, sem magic de framework para debugar.

---

### 4. DI via interfaces, sem acoplamento a banco

**Decisão:** `src/` não conhece Prisma, Redis nem Next.js. Tudo injetado via contratos:
```typescript
interface StateStore { get, set, del, rpush, ltrim, lrange, hset, hdel, hgetall }
interface SettingsStore { getSettings, patchSettings }
```

**Por quê:** testes usam InMemory, prod usa Redis. Trocar sem mudar lógica.

---

### 5. Provider racing com EWMA

**Decisão:** para toda stage do pipeline, disparar GPU + cloud em paralelo. Timeout adaptativo baseado em EWMA. Provider com menor EWMA recebe headstart.

**Por quê:** latência de pipeline P95 melhora progressivamente com uso.

---

### 6. Tier cascade para resiliência GPU

**Decisão:** providers tentados em ordem: RunPod → Vast.ai → TensorDock → Modal. Cada tier com seus próprios timeouts e GPU types.

**Por quê:** nenhum provider tem 100% de disponibilidade. Cascade garante SLA.

---

### 7. Deploy race para cold start

**Decisão:** `startDeployRace` dispara N deploys em paralelo, usa o primeiro pronto, cancela os demais.

**Por quê:** P99 de cold start reduzido significativamente.

---

### 8. Streaming overlap LLM → TTS

**Decisão:** TTS começa em tokens parciais do LLM.

**Por quê:** ~100-200ms de redução na latência percebida.

---

### 9. Modelos pré-baked na imagem Docker

**Decisão:** modelos baixados no docker build, nunca no startup.

**Por quê:** +63% vs lazy download em benchmark real (Vast.ai RTX 4090 + NVMe).

---

### 10. Budget Gate obrigatório

**Decisão:** `canAffordDeploy()` verificado antes de qualquer boot.

**Por quê:** fail-fast; sem gasto não intencional.

---

### 11. Latency DB com probe scheduling adaptativo

**Decisão:** PostgreSQL com RTT por host. Estável: probe 2h. Instável: 30min. Falhando: 6h.

**Por quê:** `sortGpuTypesByLatency()` usa dados reais para selecionar melhor host.

---

### 12. Estado persistido localmente em ~/.babelcast/

**Decisão:** `active_deploy.json`, `daily_spend.json`, `cooldowns.json`, `provider-config.json`.

**Por quê:** servidor é stateful por design; Redis é opcional para single-node.

---

## Fronteiras

| Fronteira | Regra |
|-----------|-------|
| `src/` vs `server/` | src/ nunca importa server/ |
| Gateway vs Compute | Compute pode usar Gateway (provisionar GPU). Gateway não conhece Compute. |
| Cross-context state | Cada BC gerencia seu próprio estado. Nada de god object compartilhado. |
| Comunicação entre BCs | Via Events (hooks), nunca imports diretos entre BCs |
| Providers cloud vs GPU | Mesma interface, mesmo registry. Diferença é transport, não domínio. |

---

## O que NÃO fazer

- **Não** chamar RunPod/Vast.ai direto — sempre via gateway/deploy
- **Não** adicionar Prisma em src/ — usar interface DI
- **Não** centralizar estado em god object — estado pertence ao BC
- **Não** colocar lógica de negócio em server/ — server/ é thin delivery
- **Não** separar providers cloud e GPU como domínios diferentes — são o mesmo
- **Não** usar `HF_HUB_ENABLE_HF_TRANSFER` — deprecated; usar `hf-xet`
- **Não** benchmarkar cold start em Mac/laptop — números enganosos
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
| DB | Prisma + PostgreSQL (Neon) |
| State (prod) | Redis via RedisStateAdapter |
| State (dev/test) | InMemoryStateAdapter |
| UI | Next.js + Tailwind |
| Object storage | S3-compatible (R2/B2/AWS/MinIO) |
| GPU providers | RunPod, Vast.ai, TensorDock, Modal, SnapGPU |
| AI providers | Groq, OpenAI, Fireworks, OpenRouter, Ollama, Deepgram, ElevenLabs |
| Meeting bots | Recall.ai (via Fly.io / RunPod) |
| Secrets | AES-256-GCM vault |
