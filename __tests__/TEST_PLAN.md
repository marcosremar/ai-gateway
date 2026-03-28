# AI Gateway — Plano de Cobertura de Testes 100%

**Objetivo:** Cobrir os 27 módulos sem teste, alcançando 100% de cobertura dos módulos testáveis.

**Convenção:** Todos os testes usam `vitest`. Nomes seguem padrão `<modulo>-<tipo>.test.ts`.

---

## Fase 1 — Lógica Pura (unit tests, sem rede)
**Prioridade: HIGH | Complexidade: Baixa | Tempo estimado: 2h**

São funções puras — input → output, sem side effects, sem API.

### 1.1 `providers/guardrails.ts` → `providers-guardrails.test.ts`
- `checkContent()` com config disabled → allow
- `checkContent()` detecta hate, harassment, self_harm, sexual, violence
- `checkContent()` com custom keywords
- `checkContent()` com confidence threshold (abaixo = allow, acima = block)
- `checkContent()` com per-request options (skip, override filters)
- `checkPromptAndResponse()` — prompt limpo + response flagged → overall blocked
- `createGuardrailMiddleware().checkRequest()` — extrai texto de OpenAI messages, string, objeto
- `createGuardrailMiddleware().checkResponse()` — extrai texto de OpenAI choices

### 1.2 `providers/dlp.ts` → `providers-dlp.test.ts`
- `detectPII()` com config disabled → allow
- Detecta credit card (Visa, Mastercard, Amex)
- Detecta SSN, email, phone, IP address, date of birth
- `detectPII()` com custom patterns (regex personalizado)
- `detectPII()` com minMatches > 1
- `detectPII()` com invalid regex → não crasha
- `maskValue()` — máscara correta (**** últimos 4)
- `scanPromptAndResponse()` — merge de results
- `createDLPMiddleware().scanRequest()` — extrai texto de body
- `createDLPMiddleware().scanResponse()` — extrai texto de response
- `createComplianceConfig('gdpr'|'hipaa'|'pci')` — padrões corretos
- `COMPLIANCE_PATTERNS` — cobre frameworks corretamente

### 1.3 `providers/percentage-routing.ts` → `providers-percentage-routing.test.ts`
- `selectPercentageRoute()` — deterministic (mesmo hashKey = mesma rota)
- `selectPercentageRoute()` com sticky=false (usa hashKey mesmo assim)
- `selectPercentageRoute()` com seed diferente = resultado diferente
- `selectPercentageRoute()` com rotas 80/20 → distribuição consistente
- `selectPercentageRoute()` com array vazio → null
- `selectRandomRoute()` — rotas 50/50, distribuição estatística (1000 chamadas)
- `buildPercentageRoutes()` — mapeia config para PercentageRoute[]

### 1.4 `vault/vault-singleton.ts` → `vault-singleton.test.ts`
- `initVaultFromEnv()` sem env vars → null
- `initVaultFromEnv()` com env vars → Vault instance
- `getVault()` sem init → null
- `setVault()` + `getVault()` → mesma instância
- `resetVault()` → getVault() retorna null

### 1.5 `vault/file-store.ts` → `vault-file-store.test.ts`
- `FileVaultStore` com arquivo inexistente → get() retorna null
- set() + get() → valor persistido
- delete() → get() retorna null
- list() → retorna todas as keys
- Arquivo não existe → cria diretório automaticamente
- Arquivo corrompido (JSON inválido) → não crasha, retorna vazio

---

## Fase 2 — SDK + Providers sem API key
**Prioridade: HIGH | Complexidade: Baixa-Média | Tempo estimado: 3h**

Testes que verificam comportamento sem precisar de API keys reais.

### 2.1 `providers/cloud-health.ts` → `providers-cloud-health.test.ts`
- `probeCloudProvider()` com provider sem endpoint → `{ ok: false }`
- `probeCloudProvider()` com provider conhecido (mock fetch) → `{ ok: true }`
- `probeCloudProvider()` com timeout → `{ ok: false, error }`
- `probeCloudProvider()` — Deepgram usa `Token` header, outros usam `Bearer`
- `probeAllCloudProviders()` com keys={groq: 'key'} → 1 resultado
- `probeAllCloudProviders()` com keys vazio → array vazio
- `probeAllCloudProviders()` — ignora providers sem endpoint

### 2.2 `gpu-providers/deploy-orchestrator.ts` → `deploy-orchestrator.test.ts`
- `ProviderCooldownTracker` — recordFail() + isInCooldown()
- Exponential backoff: 1ª falha = 60s, 2ª = 120s, ...
- `loadFromFile()` / `saveToFile()` — persistência JSON
- Expired cooldowns ignorados no load
- `selectProviderForDeploy()` — pula providers em cooldown
- `selectProviderForDeploy()` — todos em cooldown → null
- `markSuccess()` → reset fail count

### 2.3 `observability/distributed-tracer.ts` → `observability-tracer.test.ts`
- `generateTraceId()` / `generateSpanId()` — formatos hex corretos
- `startSpan()` com parentSpanId — hierarquia correta
- `addTag()` / `getSpan()` — tags persistidas
- `addEvent()` — eventos com timestamp
- `finishSpan()` — calcula durationMs
- `getTraceTree()` — retorna árvore de spans
- `getPipelineMetrics()` — retorna métricas agregadas
- `reset()` — limpa todos os spans

### 2.4 `observability/langfuse-hooks.ts` → `observability-langfuse.test.ts`
- `createLangfuseHooks()` — retorna GatewayHooks parciais
- `onRequestStart()` — POST para `/api/public/ingestion`
- `onRequestEnd()` — cria span
- Auth header — `Basic base64(publicKey:secretKey)`
- Config sem baseUrl → usa `https://cloud.langfuse.com`
- Network error → não crasha (fire-and-forget)

### 2.5 `adapters/redis-state.ts` → `adapters-redis.test.ts`
- Mock `RedisLike` interface
- `get()` / `set()` / `del()` — KV ops
- `set()` com TTL — passa `EX` para redis
- `lpush()` / `lrange()` / `ltrim()` — list ops
- `hset()` / `hgetall()` / `hdel()` — hash ops
- `keys()` — usa scan cursor

---

## Fase 3 — Proxy Routes (unit tests com mocks)
**Prioridade: HIGH | Complexidade: Média | Tempo estimado: 3h**

Rotas HTTP que recebem request e retornam response. Testar validação de input e roteamento com providers mockados.

### 3.1 `proxy/routes/chat-completions.ts` → `proxy-chat-completions.test.ts`
- Body sem model → 400
- Body sem messages → 400
- temperature fora do range → 400
- max_tokens fora do range → 400
- Model não encontrado → 404
- Request válido → chama provider.chat() → 200
- Streaming → retorna SSE
- Com cache → hit retorna cache, miss chama provider
- Emits hooks onRequestStart/onRequestEnd

### 3.2 `proxy/routes/audio-speech.ts` → `proxy-audio-speech.test.ts`
- Body sem model/input/voice → 400
- input > 4096 chars → 400
- speed fora do range → 400
- response_format inválido → 400
- Model não encontrado → 404
- Request válido → chama provider.synthesize() → 200 + audio buffer

### 3.3 `proxy/routes/audio-transcriptions.ts` → `proxy-transcriptions.test.ts`
- Body sem model ou sem audio → 400
- Model não encontrado → 404
- Request válido → chama provider.transcribe() → 200 + text

### 3.4 `proxy/routes/embeddings.ts` → `proxy-embeddings.test.ts`
- Body sem model/input → 400
- Model não encontrado → 404
- Request válido → chama provider.embed() → 200 + embedding array

### 3.5 `proxy/routes/models.ts` → `proxy-models.test.ts`
- Retorna lista de modelos registrados
- Filtra por provider (query param)
- Com streaming=true → inclui modelos de streaming

### 3.6 `proxy/routes/retry.ts` → `proxy-retry.test.ts`
- `withProxyRetry()` — sucesso na primeira tentativa
- `withProxyRetry()` — falha 429 → retry → sucesso
- `withProxyRetry()` — falha 5xx → retry com backoff → sucesso
- `withProxyRetry()` — falha 401 → não retry, propaga erro
- `withProxyRetry()` — todas as tentativas falham → propaga último erro
- Respeita maxRetries

---

## Fase 4 — SDK + Providers com API real
**Prioridade: MEDIUM | Complexidade: Baixa | Tempo estimado: 2h**

Testes de integração reais (precisam de API keys). Usam o mesmo padrão dos testes existentes.

### 4.1 Provider wrappers (batch test) → `modal-providers.test.ts`
Todos usam endpoints Modal públicos (sem API key):
- `modal-kokoro` → TTS com voice 'af_bella'
- `modal-moss` → TTS com voice 'moss-pt'
- `modal-voxtral` → STT com áudio de teste
- `modal-seamless` → STT com áudio de teste
- `modal-qwen3asr-pipeline` → STT com áudio de teste
- Fallback: se Modal offline → skip

### 4.2 `providers/deepgram/index.ts` → `deepgram-integration.test.ts`
- `transcribe()` com áudio de teste (precisa DEEPGRAM_API_KEY)
- `isConfigured()` → true/false baseado em env var
- Sem key → skip

### 4.3 `providers/elevenlabs/index.ts` → `elevenlabs-integration.test.ts`
- `transcribe()` com áudio de teste (precisa ELEVENLABS_API_KEY)
- `isConfigured()` → true/false
- Sem key → skip

### 4.4 `providers/mlx-qwen3-asr/index.ts` → `mlx-qwen3-asr.test.ts`
- `transcribe()` com áudio de teste (precisa servidor local rodando em localhost:8765)
- `isConfigured()` → true/false
- Sem servidor → skip

---

## Fase 5 — Browser SDK (WebRTC, Audio Worker)
**Prioridade: LOW | Complexidade: Alta | Tempo estimado: 3h**

### 5.1 `browser/transport-webrtc.ts` → `browser-transport-webrtc.test.ts`
- Mock RTCPeerConnection, MediaStream
- `connect()` — cria peer connection, troca SDP
- `sendAudio()` — envia chunks via data channel
- `disconnect()` — fecha pc e streams
- `onResponse` callback — recebe texto do data channel
- Pipecat mode vs aiortc simple mode
- Sem clusterName → aiortc mode
- Com clusterName → Pipecat mode (mock dynamic import)

### 5.2 `browser/audio-decode-worker.ts` → `browser-audio-decode.test.ts`
- Mock Worker context (postMessage/onmessage)
- Decodifica WAV → PCM
- Decodifica MP3 → PCM
- Erro no formato → envia error message de volta

---

## Fase 6 — Integracao E2E via SDK
**Prioridade: MEDIUM | Complexidade: Média | Tempo estimado: 2h**

### 6.1 `streaming-stt.ts` → `streaming-stt.test.ts`
- `StreamingSTTRouter` com GPU disponível → usa GPU
- `StreamingSTTRouter` com GPU down + Fireworks key → fallback
- `StreamingSTTRouter` sem GPU sem Fireworks → erro
- Provider order customizado → respeita ordem
- Status check → retorna provider disponível

### 6.2 Full SDK pipeline test → `sdk-pipeline.test.ts`
- Testa `createAIClient()` com guardrails + DLP ativos
- Pipeline completo: audio → STT → (guardrail check) → LLM → (DLP check) → TTS → audio
- Contente blocked por guardrails → resposta vazia
- PII detectado por DLP → flag mas não block (config audit)

---

## Fase 7 — CPU Providers
**Prioridade: LOW | Complexidade: Média | Tempo estimado: 1h**

### 7.1 `cpu-providers/scaleway-client.ts` → `cpu-provider-scaleway.test.ts`
- Mock fetch
- `createInstance()` — valida spec, chama API
- `getInstance()` — retorna instância
- `deleteInstance()` — destroy
- `listInstances()` — lista todas as zonas
- Sem API key → isConfigured() false
- Auth header = `X-Auth-Token`

### 7.2 `benchmarking/cli-bench.ts` → `benchmarking-cli.test.ts`
- Mock fetch + timer
- `runCliBench()` com mock endpoint → resultado com latência
- `runCliBench()` com endpoint offline → erro

### 7.3 `benchmarking/ws-bench-client.ts` → `benchmarking-ws-bench.test.ts`
- Mock WebSocket
- Conecta, envia frames, mede latência
- Desconecta limpo

---

## Resumo

| Fase | Módulos | Tipo | Prioridade | Tempo |
|------|---------|------|------------|-------|
| 1 | guardrails, dlp, percentage-routing, vault-singleton, file-store | Unit | HIGH | 2h |
| 2 | cloud-health, deploy-orchestrator, distributed-tracer, langfuse, redis | Unit+Mock | HIGH | 3h |
| 3 | 6 proxy routes | Unit+Mock | HIGH | 3h |
| 4 | 9 provider wrappers | Integration | MEDIUM | 2h |
| 5 | webrtc transport, audio worker | Unit+Mock | LOW | 3h |
| 6 | streaming-stt, full SDK pipeline | Integration | MEDIUM | 2h |
| 7 | scaleway, cli-bench, ws-bench | Unit+Mock | LOW | 1h |
| **Total** | **27 módulos → 25 test files** | | | **~16h** |

### Ordem de execução
1. Fase 1 (lógica pura) — zero dependências, resultado imediato
2. Fase 3 (proxy routes) — alta prioridade de negócio
3. Fase 2 (observability + infra) — médio risco
4. Fase 4 (provider wrappers) — depende de API keys / Modal online
5. Fase 6 (SDK pipeline) — depende de Fase 1+3
6. Fase 7 (CPU + bench) — menor impacto
7. Fase 5 (browser) — mais complexo, menor prioridade
