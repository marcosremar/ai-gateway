# Fault bench — o gateway contra falhas conhecidas de gateways LLM (2026-10-06)

O gateway real (`serve.ts`) rodou localmente contra um upstream **falso** que fala os formatos OpenAI do OpenRouter e
do Groq e falha de propósito. Nenhuma chamada saiu da máquina: chaves falsas, upstream em `127.0.0.1`, e
`HTTP(S)_PROXY` apontando para uma porta fechada (só `127.0.0.1` passa). Gasto: zero.

- Bancada: `scripts/fault-bench/` — `fake-upstream.ts` (falhas por modelo via `PUT /__control/faults`, log de cada
  requisição com sha256 do corpo/arquivo, tempos e se o cliente abortou), `gateway.ts` (sobe o `serve.ts`),
  `run.ts` (cenários). Rodar: `bun run bench:faults` ou `bun scripts/fault-bench/run.ts 8 11 18`.
- Cadeias usadas (`MODEL_ROUTES`): `t-llm` → `openrouter:a` → `openrouter:b` → `groq:c` (+ os dois fallbacks
  genéricos do chat: `groq:llama-3.3-70b-versatile`, `openrouter:meta-llama/llama-3.3-70b-instruct`);
  `t-stt` → `openrouter:sa` → `groq:sc`; `t-tts` → `openrouter:ta` → `groq:tc`.
- Para o `GROQ_API_BASE` não foi preciso mudar nada (já existia). A sonda de chave no boot ia sempre ao
  `openrouter.ai`/`api.groq.com`; agora segue `OPENROUTER_API_BASE`/`GROQ_API_BASE` (padrão inalterado).
- Bun: produção usa `oven/bun:1` (hoje 1.4.2). A bancada rodou com **Bun 1.4.2**; o Bun local era 1.3.14 e se
  comporta diferente (ver «Bun 1.3.x» abaixo).
- Testes de regressão: `__tests__/unit/gateway-routing/fault-bench-regressions.test.ts` — 20 testes; com `src/`
  revertido para o `origin/main` 18 falham (os 2 que passam são controles de caminho feliz), com as correções os 20
  passam.

## Resultado

| # | Modo de falha | Antes | Depois | Evidência (depois, salvo indicação) |
|---|---|---|---|---|
| ★1 | Erro no meio do SSE com HTTP 200 (`error` + `finish_reason:"error"`; `event: error`) | PASS / FAIL (breaker) | PASS | Cliente recebe o texto parcial + evento `error`, sem `[DONE]`. Erro antes do 1º token → fallback para `b`. Antes: 6 erros no meio do stream seguidos e o breaker continuava `ready` (o sucesso no 1º token zerava a contagem); depois: `openrouter=circuit_open`. No s2s composto, o `sseDeltas` ignorava o evento de erro e entregava a resposta cortada como completa — corrigido. |
| 2 | Comentários `: OPENROUTER PROCESSING` | PASS | PASS | 3 s de comentários → texto íntegro, 0 erro de parse, 1º byte 3018 ms (comentário não conta como 1º byte). 20 s de comentários → 503 em 8006 ms (orçamento de 1º token = orçamento do estágio, 8 s): por desenho, ver decisões. |
| 3 | UTF-8 multibyte e linha `data:` partidos entre chunks | PASS | PASS | `"Não, não é assim — ção"` idêntico, cortado em todos os bytes de continuação e no meio do JSON. |
| ★5 | Upstream mudo no meio do stream | **FAIL** | PASS | Antes: o timer de 15 s do `chatStream` era TOTAL; aos 15 s abortava, o SDK engolia o próprio abort e o gateway mandava `finish_reason:"stop"` + `[DONE]` com o texto cortado (`"Olá, tudo "`). Depois: timer de inatividade; mudo 70 s → evento `error` aos 15024 ms, sem `[DONE]`, upstream abortado; mudo 12 s → resposta completa (12083 ms). Bun 1.4.2 não corta o cliente parado 12 s (sem `idleTimeout` de 10 s no `node:http`): chat não-stream de 12 s → 200. |
| 6 | Upstream fecha sem `[DONE]`/`finish_reason` | **FAIL** (fim limpo) | PASS | TCP destruído → erro in-band (já passava). Fim limpo após 3 deltas sem `finish_reason`: antes `stop` + `[DONE]`; depois erro `stream ended without finish_reason`. Não-stream cortado no meio do corpo → `b` (antes 3 chamadas a `a` pelos retries do SDK, depois 1). |
| 7 | Timeouts configurados aplicados | PASS | PASS | Upstream que aceita e não responde / manda cabeçalhos e trava: 503 em 8004–8010 ms (orçamento 8 s, ±1 %) para chat, chat stream, STT e TTS; upstream abortado. |
| ★8 | Tempestade de retries (tudo 503) | **FAIL** | PASS | Antes: 17 chamadas para 1 requisição não-stream (`a`×6, `b`×6, `c`×5 — o SDK OpenAI refazia 2× cada tentativa), 15 no stream, 600 para 50 concorrentes (12/req), 17 via SDK `GatewayClient`. Depois: 10 (5 alvos × 1 + o retry 5xx da rota), 5 no stream, 200 para 50 concorrentes (4/req, os breakers abrem), 10 via SDK (o 503 do gateway não aciona o fallback direto). |
| 9 | 429 `retry-after: 5`, 30 concorrentes | **FAIL** | PASS | Antes: o SDK dormia 5 s e repetia o MESMO provedor; as 30 requisições morriam em 503 aos 8 s, `b` nunca chamado. Depois: nenhuma repetição a `a` antes de 5 s, 30×200, p50 53 ms. |
| 10 | Hedge: perdedor cancelado | PASS | PASS | Executado no núcleo (`runTargets`) por HTTP real: alvos de nuvem não têm hedge via `MODEL_ROUTES` (só links de deployment). Vencedor `secondary` em 2507 ms, secundário partiu em +997 ms, primário abortado (o fake viu o abort), 1 resposta. |
| ★11 | Matriz de erros do OpenRouter | **FAIL** | PASS exceto 502/503 | 401/402/403/408/429 → fallback imediato, 1 chamada (antes 408/429 faziam 3 chamadas e 1,4 s). 403 de moderação: antes abria o breaker compartilhado (`openrouter:a`/`b` = `circuit_open`); depois código `moderation`, neutro, breaker fechado. 502/503: 2 chamadas e ~220 ms (o retry 5xx da rota) — decisão abaixo. 401 do NOSSO cliente (chave do gateway errada) ×10: 0 chamadas upstream, nenhum breaker. |
| 12/13 | Todos os breakers abertos, upstream se cura | PASS | PASS | 1º 200 aos 30,1 s após abrir (reset 30 s). Meio-aberto com 100 concorrentes: 2 chamadas upstream (1 sonda por provedor), 98 → 503. |
| 14 | Vazamento do slot de concorrência por usuário | PASS (Bun 1.4.2) / **FAIL (Bun 1.3.14)** | idem | Limite 2, 200 ciclos (abort do cliente, timeout, erro no meio, reset) → 2 requisições normais: 200, 200 no Bun 1.4.2. No Bun 1.3.14 o `node:http` não emite `close` quando o cliente cai → 429 para sempre. Decisão abaixo. |
| 16 | Vazamento de chave do provedor | PASS | PASS | 401 que ecoa a chave, 404, timeout, DNS (`.invalid`) em chat/stream/STT: 0 ocorrências da chave falsa no stdout/stderr do gateway e nos corpos de erro (`[redacted]`). |
| ★18 | Cliente desconecta 500 ms após enviar | **FAIL** (exceto chat SSE) | PASS | Antes (Bun 1.4.2): chat SSE abortado (516 ms); chat não-stream, TTS, STT e s2s **nunca** abortavam o upstream (rodava até o fim e cobrava). Depois: upstream vê o abort 2–6 ms após o cliente em todos; slot liberado (próxima requisição com limite 1 → 200). |
| 21 | Tamanho do corpo | **FAIL** | PASS | 0 B → 400 `audio data is required`; 26 MB → 400 (STT, limite 25 MB) / 413 (s2s); 200 MB com `Content-Length` → 413 em ~0,5 s; 200 MB **chunked** no STT: antes conexão resetada sem resposta, depois 413 em 177 ms. Chunked = não-chunked em todos os casos; nenhum 401. |
| ★23 | Envenenamento do cache STT | **FAIL** | PASS / decisão | Antes: 200 com `text:""` era cacheado e a 2ª chamada recebia `""` (HIT). Depois: vazio nunca é cacheado (2ª → `"bom dia"`, MISS). pt vs fr → chaves diferentes (PASS). Erro nunca cacheado (PASS). Resposta de fallback: continua cacheada — decisão abaixo. |
| ★24 | Multipart reenviado no fallback | PASS | PASS | Primário lê 50 % e devolve 502 → secundário recebe o arquivo com sha256 idêntico. `audio/mp4` do iPhone com nome `blob` → upstream recebe `audio.m4a`, `audio/mp4`, bytes idênticos. Hedge no meio do upload: N/A (STT de nuvem sem hedge). |
| 26 | 200 vazio de modelo de raciocínio | PASS | PASS | `content:""`+`length` e `choices:[]`, stream e não-stream → próximo alvo (`X-Gateway-Fallback: empty`/`truncated`), nunca resposta vazia ao cliente. Não há cache de chat montado no `serve.ts`. |
| 29a | SDK `GatewayClient` com fallback direto | PASS | PASS | Gateway morto (SIGKILL) no meio do stream: o SDK entrega os 3 deltas recebidos e lança `stream_error` (não repete nada). A chamada seguinte vai direto ao OpenRouter falso em 95 ms (`openrouter-direct:direct-a`). |
| 22 | (deployments Scaleway) | N/A | N/A | Fora do escopo pedido. |

## Correções (cada uma com teste que falha antes e passa depois)

1. **O SDK OpenAI não refaz mais nada** (`client-cache.ts`, `withApiKey`/`withConfig` de LLM/STT/TTS:
   `maxRetries: 0`). O SDK refazia 408/409/429/5xx e erro de conexão 2× e dormia o `retry-after` (≤ 60 s) no mesmo
   provedor. Retry, fallback e hedge são do `runTargets`. Itens 6, 8, 9, 11.
2. **`chatStream` com timeout de inatividade e fim verificado** (`openai-compat-llm.ts`): o timer é rearmado a cada
   chunk; um stream que termina sem `finish_reason` (corte limpo, ou abort que o SDK engole) lança `truncated` /
   `timeout` em vez de terminar como resposta completa. Itens 5, 6, 7.
3. **O cliente que sai aborta o upstream** (`server.ts` cria um `AbortController` por requisição ligado ao `close`
   da resposta; `ProxyRequest.signal`; `runTargets({ signal })` aborta as tentativas e para a cadeia sem alimentar
   breaker/cooldown; chat, STT e TTS repassam; o stream aberto expõe `abort()` e o `cancel()` aborta o fetch na hora
   em vez de esperar o próximo token; s2s ouve `res.close` — o `req.close` dispara logo após ler o corpo e o ouvinte
   nunca valia). Item 18.
4. **Breaker vê falha no meio do stream** (`chat-completions.ts`): a saúde do stream é registrada no fim (sucesso
   com `[DONE]`, falha no erro, sonda liberada se o cliente sai), não no 1º token. Item 1.
5. **403 de moderação é neutro** (`provider-routing.ts`, `isModerationRefusal` → código `moderation`): passa ao
   próximo alvo sem contar no breaker que todos os modelos do OpenRouter compartilham. Item 11.
6. **Cache STT não guarda texto vazio** (`audio-transcriptions.ts`). Item 23.
7. **s2s composto não fala resposta cortada** (`loopback-stages.ts` `sseDeltas`): evento `error` e corpo sem
   `[DONE]` lançam; o pipeline emite `error` parcial. Itens 1, 6.
8. **413 para corpo chunked acima do limite** (`server.ts` `BodyTooLargeError`): para de acumular sem destruir o
   socket, responde 413 com `Connection: close` e só então fecha. Item 21.
9. (bancada) A sonda de chave do boot segue `OPENROUTER_API_BASE`/`GROQ_API_BASE` (`cloud-health.ts`).

## Para decidir (não corrigido)

- **Retry 5xx no mesmo provedor** (`retriesPerProvider: 1` em chat/STT/TTS): um 502/503 custa 2 chamadas e ~200 ms
  antes do fallback. Opções: (a) 0 para alvos de nuvem e manter 1 só para deployments; (b) manter; (c) refazer só em
  erro de conexão.
- **Breaker por provedor, compartilhado entre modelos.** 429 ou falha num modelo do OpenRouter conta para todos
  (30 × 429 em `a` abrem `openrouter` e `b` também sai); e um modelo sempre quebrado nunca abre se outro modelo do
  mesmo provedor responde (o sucesso zera a contagem). Opções: chave `provider:model` para agregadores; ou breaker
  por provedor só para 5xx/conexão e cooldown por modelo para 429.
- **`retry-after` do upstream** agora só faz a cadeia seguir; a próxima requisição tenta `a` de novo. Opção:
  cooldown do alvo pelo `retry-after`.
- **Cache STT de resposta de fallback.** Pedido do teste: nunca cachear. Hoje continua cacheada porque o teste
  existente «3) STT cache … still warm the deployment» exige exatamente isso (deployment frio → resposta do OpenRouter
  cacheada, o HIT acorda o deployment). Opções: não cachear quando o fallback veio de falha real (5xx/timeout) e
  cachear quando veio de `cold`; ou TTL menor para fallback.
- **Comentários de keep-alive vs orçamento de 8 s:** um modelo que demora 20 s para o 1º token dá 503 aos 8 s. É o
  orçamento do estágio (`GATEWAY_CHAT_BUDGET_MS`); subir por alias se houver modelo lento de propósito.
- **`finish_reason` no SSE do gateway é sempre `stop`** (o `length` do upstream se perde no caminho stream; o
  não-stream repassa). Opção: sentinela `__finish__:` como o `__usage__:`.
- **STT acima de 25 MB responde 400**, s2s e corpo > 100 MB respondem 413; o SDK trata 413 como `too_large`.
  Unificar em 413?
- **Bun 1.3.x:** no 1.3.14 o `node:http` não emite `close`/`finish` quando o cliente cai — slot por usuário vaza
  (429 permanente após `MAX_CONCURRENT_PER_USER` abortos) e nenhum abort chega ao upstream. O 1.4.2 corrige. As
  imagens usam `oven/bun:1` (flutuante); fixar `>= 1.4.2` nos Dockerfiles e em `engines` evita regredir, e quem roda
  o gateway local com Bun antigo deve atualizar.
- **Código `unreachable`** para erro in-band antes do 1º token (o erro do SDK não tem status) — só rótulo.

## Fontes da pesquisa

- OpenRouter, erros e streaming: https://openrouter.ai/docs/api/reference/errors-and-debugging ,
  https://openrouter.ai/docs/api/reference/streaming
- Quedas do OpenRouter em fev/2026: https://openrouter.ai/blog/announcements/openrouter-outages-on-february-17-and-19-2026/
- Bun SSE e idle: https://bun.com/docs/guides/http/sse ; corte de 5 min no Railway:
  https://station.railway.com/community/requests-cut-at-exactly-5-minutes-with-h-88503c0c
- LiteLLM — cliente desconectado: https://github.com/BerriAI/litellm/issues/30244 ; tempestade de retries:
  https://github.com/BerriAI/litellm/pull/41191 ; cache de vazio: https://github.com/BerriAI/litellm/issues/44655 ;
  multipart consumido: https://github.com/BerriAI/litellm/issues/42224 ; vazamento de chave:
  https://github.com/BerriAI/litellm/issues/24902
- The Tail at Scale (hedging): https://research.google/pubs/pub40801/
