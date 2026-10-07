# Fault bench, rodada 2 — cenários de falha nunca executados (2026-10-07)

Continuação de [`2026-10-06-fault-bench.md`](2026-10-06-fault-bench.md). Seis cenários que ninguém tinha rodado:
réplica que morre no meio da resposta, OpenRouter **e** GPU própria fora, gateway que reinicia com trabalho em voo,
cliente lento ou que some, soak comprimido com falhas aleatórias e rajada de pedidos frios contra os limites de gasto.
Tudo local: chaves falsas, upstream falso e nuvem falsa em `127.0.0.1`, `HTTP(S)_PROXY` numa porta fechada. Nenhuma
chamada à nuvem real, gasto zero.

- Rodar: `bun run bench:fault-scenarios` (todos; soak de `SOAK_MINUTES`, padrão 30) ou
  `bun scripts/fault-bench/scenarios.ts S1 S6`. `BENCH_BUN=<bun 1.4.2>` escolhe o Bun do `serve.ts`.
- Bancada nova: `scripts/fault-bench/scenarios.ts` (executor), `gateway-scenarios.ts` (S2–S5 contra o `serve.ts`
  real), `deployment-scenarios.ts` (S1, S2-GPU, S3c, S6 com o `DeploymentController`, os providers de deployment e a
  rota `/v1/s2s` reais, em processo), `replica-cloud.ts` (nuvem falsa: cada réplica é um servidor HTTP com o portão de
  token, `/__aigw/ready`, saúde, e um app roteirizável que pode transmitir, travar ou morrer). O `serve.ts` não sobe
  um controller sem chave de nuvem real, por isso os cenários de deployment rodam o mesmo código em processo.
- Bun: o `serve.ts` e o executor rodaram com **Bun 1.4.2** (o de produção, `oven/bun:1`), baixado para `/tmp` só para
  a bancada; o Bun local é 1.3.14 (ver rodada 1, item 14).
- Testes de regressão: `__tests__/unit/gateway-routing/fault-scenarios-regressions.test.ts` — 18 testes; 13 falham
  sem a correção correspondente (D1: 3, D2: 4, D3: 6); os outros 5 são controles (passam antes e depois).

## Consertos na própria bancada

1. **A bancada de 06/10 respondia 403 a tudo no `main`.** Desde os limites de chave de app (#41) uma chave não-admin
   só chama os aliases do seu app, e os aliases de `MODEL_ROUTES` da bancada não são de app nenhum: todo chat/STT/TTS
   voltava `403 model 't-llm' is not an alias of app 'bench'`. `gateway.ts` agora sobe com
   `DEPLOYMENTS_ADMIN_USERS=bench` (a chave da bancada é admin). Itens 1 e 29a da rodada 1 conferidos de novo: PASS.
2. `stop()` de um gateway morto por sinal ficava pendurado para sempre (`exitCode` fica `null` com `signalCode` setado
   e o `exit` já tinha disparado) — agora olha os dois.
3. Reinício na mesma porta (`env.PORT`): o `startGateway` sondava a porta seguinte do contador, não a pedida.
4. `fake-upstream.ts`: modo caos (`setChaos({p5xx, pTimeout, pDrop, seed})`, sorteio determinístico por requisição
   sem falha explícita) e dois erros de lint antigos.

## Resultado por cenário

### S1 — réplica morre no meio da resposta (controller real, réplica que derruba o socket)

O temporizador de reconcile é parado depois que a réplica fica pronta: só o caminho da requisição pode marcar a
réplica morta (uma sonda periódica esconderia o defeito — na 1ª execução, com reconcile a 100 ms, o chat «passou» por
causa da sonda, não da requisição).

| Caso | Esperado | Antes | Depois | Evidência (depois) |
|---|---|---|---|---|
| a) `/v1/chat/completions` stream, réplica morre após parte do corpo | Cliente recebe o fallback, nada da réplica; lease liberado; réplica marcada | Resposta do fallback OK; **lease liberado como saudável no cabeçalho**: o próximo `acquire` recebia **a mesma réplica morta** — **FAIL** | PASS | `200`, `X-Gateway-Fallback: unreachable` de `deployment:parle-speech`, texto só do OpenRouter falso, 167 ms. Depois: `inflight=0`, réplica `unhealthy`, próximo `acquire` → nenhuma; com o reconcile ligado é liberada (`unhealthy`) e substituída. O provider de chat do deployment não tem `chatStream`: o gateway pede a resposta inteira à réplica, então «após os primeiros tokens» não chega token nenhum ao cliente — o corte vira fallback antes do 1º byte. |
| a') TTS em stream da réplica, morre após 10 kB | Cliente vê o corte; lease vale enquanto o áudio sai | Corte visto (erro de leitura, não fim limpo); **`inflight=0` durante o áudio** e réplica morta entregue de novo — **FAIL** | PASS | 10 000 B e erro de socket em 217 ms; `inflight` durante o stream = 1; depois 0 e réplica `unhealthy`. |
| b) `/v1/s2s`, morre após o transcript, antes do áudio | Pipeline composto retoma no LLM com esse transcript (sem 2º STT) | PASS | PASS | Eventos `route(deployment) transcript route(composite/resumed) … done`; estágios `llm:"Quero dois pães."`, `tts`; nenhum `stt`; 71 ms; lease `done(true)`, réplica `unhealthy`. |
| c) `/v1/s2s`, morre depois do áudio começar | `error` in-band (`partial`) + `done`, nada falado duas vezes | PASS | PASS | `… sentence error(partial) done(partial)`, áudio `"Claro, querida!"` uma vez, nenhum estágio composto chamado, 44 ms; lease `done(true)`. |

### S2 — OpenRouter e Groq fora, e a GPU própria fora

| Caso | Esperado | Observado | Veredito |
|---|---|---|---|
| chat / chat stream / STT / TTS / s2s, tudo 503 (`serve.ts`) | 503 limpo com os motivos, dentro do orçamento, sem tempestade | chat 503 em 34 ms (5 chamadas = os 5 alvos, 1 cada); stream 17 ms (5); STT 13 ms (2); TTS 9 ms (2); s2s 503 `provider_unavailable` em 31 ms (4: o estágio STT do loopback refaz 1× um 503, `loopback-stages.ts`). Mensagens nomeiam cada alvo e o HTTP. | PASS |
| 30 chats concorrentes, tudo fora | todos 503, chamadas limitadas | 30 × 503, 148 chamadas (4,9/req), p50 177 ms, máx 192 ms | PASS |
| 10 seguintes com os breakers abertos | 503 rápido, sem chamada | máx 11 ms, 0 chamadas, «circuit open … retrying in <30 s» | PASS |
| GPU própria morta (réplica caída) + OpenRouter 503, chat | 503 nomeando os dois, rápido | 503 em 21 ms: `deployment:parle-speech failed (HTTP 502): replica unreachable; openrouter failed (HTTP 503)…` | PASS |
| GPU própria fria (zero réplicas) + OpenRouter 503 | idem, e acorda o deployment | 503 em 13 ms `… replicas are starting; openrouter failed (HTTP 503)`; deployment acordado (1 create) | PASS |
| GPU morta + cadeias de estágio fora, s2s | 503 `provider_unavailable` real | 503 em 7 ms com os motivos; réplica marcada `unhealthy` | PASS |
| SDK, gateway fora, plano **sem chave** em cache | Falha rápida e erro claro | Antes: rápido (≤ 5 ms) mas a mensagem era só «gateway skipped: unreachable recently (breaker open)». Depois: ≤ 3 ms e «…; no direct fallback: the fallback plan has no provider key for chat 't-llm' (keyless plan: …)» | PASS (mensagem: corrigida, D2) |
| SDK, gateway fora, nenhum plano obtido | Falha rápida | ~805 ms por chamada (o GET do plano é idempotente: 2 retries com 200 + 600 ms) — «…; no direct fallback: no fallback plan could be fetched» | PASS |
| SDK, gateway que aceita TCP e não responde, plano sem chave | Limitado pelo timeout, nunca pendura | cada chamada ≤ 3003 ms (timeout de chat 3 s na bancada; padrão 15 s); sem plano: 3 s + 1 s do plano | PASS |
| SDK, gateway fora, chave cunhada falsa | Fallback direto serve chat/stream/STT/TTS; filtro de alucinação no SDK | chat 2 ms e stream 100 ms `openrouter-direct:direct-a`; STT «Legendas pela comunidade Amara.org» → `text:""`, `filtered:["blocklist"]`; TTS 40 000 B | PASS |

### S3 — gateway reinicia no meio das requisições

| Caso | Esperado | Antes | Depois | Evidência |
|---|---|---|---|---|
| `SIGKILL` com 10 SSE + 5 s2s em voo | Todo cliente vê stream quebrado na hora, nunca um fim limpo truncado | PASS | PASS | 10/10 SSE e 5/5 s2s terminam com erro de leitura 6–8 ms após o kill; 0 «truncado mas limpo»; requisição nova: conexão recusada. |
| `SIGTERM` com os mesmos em voo | Drena até completar, recusa novas, sai | PASS | PASS | 10/10 SSE com `[DONE]` e 5/5 s2s com `done`, +4,5–4,6 s; requisição durante o dreno: recusada; processo saiu 4,6 s após o sinal. |
| SDK sem `directFallback`, reinício na mesma porta | Falha rápida enquanto fora, 1º sucesso logo após voltar | PASS | PASS | fora: `network` em 0–1 ms; de volta: sucesso na 1ª chamada, +25 ms. Nenhum POST é refeito pelo SDK (só idempotentes). |
| SDK com `directFallback` e plano **sem chave** (o padrão sem `OPENROUTER_PROVISIONING_KEY`) | idem | **FAIL**: o breaker abre após 3 falhas e o SDK **pula o gateway pelo cooldown inteiro** mesmo com ele de volta: 1º sucesso só +30,6 s depois, 61 chamadas falhando com `gateway_unreachable` | PASS | 1º sucesso na 1ª chamada, +27 ms (D2). |
| Controller reinicia (store em arquivo, nuvem falsa) | Estado recuperado, máquinas adotadas, sem create duplicado, leases não vazam, `stopping` respeitado | PASS | PASS | `live` pronto com 1 réplica, creates 2 → 2; o processo morto segurava 3 leases e o novo começa com `inflight=0`; réplica `stopping` (1,5 s) adotada no meio: não liberada, termina `stopped`, `stopped=1`. |

### S4 — cliente lento e cliente que some (`serve.ts`, limite por usuário 150)

| Caso | Esperado | Observado | Veredito |
|---|---|---|---|
| 20 leitores SSE lentos (150 ms por leitura) | Respostas inteiras | Inteiras (`[DONE]`, último token). O gateway lê o upstream até o fim e guarda (upstream acaba em ≤ 778 ms, cliente em ~1,1 s): **não há contrapressão até o provedor**; para respostas de LLM (kB) não pesa — RSS 63 → 81 MB com 20 leitores. Registrado, não consertado. | PASS (obs.) |
| 5 leitores s2s lentos | Turnos inteiros | 5/5 com `done`, 0 erro | PASS |
| 500 desconexões no meio (chat SSE, s2s, TTS, STT; abort aleatório 20–420 ms) | Upstream abortado, nada aberto | 501 chamadas upstream: 497 abortadas pelo gateway, 4 terminaram antes do abort, 0 abertas; conexões ativas do gateway depois = 1 (a própria sonda) | PASS |
| Memória e handles | Sem crescimento contínuo | RSS 81 → 85 → 92 MB (aquecimento → +500 → +1000), fds 10 → 10 → 10. Heap do processo Bun não é legível de fora: o RSS é o indicador (ver tendência longa no S5). | PASS |
| Depois das 500, 150 concorrentes (o limite) | Todos 200 (slots devolvidos) | 150 × 200 | PASS |

### S5 — soak comprimido

30 min de tráfego misto (16 clientes em laço: 35 % chat SSE, 15 % chat JSON, 20 % STT — metade com o mesmo áudio,
para exercitar o cache —, 15 % TTS, 15 % s2s composto) contra o upstream em modo caos determinístico: 5 % 5xx, 2 %
sem resposta (timeout), 1 % conexão derrubada no meio. `/health` lido a cada 2 s (breakers), RSS/fds/conexões a cada
30 s. O soak é «comprimido» na taxa de falha (8 % por chamada, muito acima do real), não no tempo: rodou os 30 min.

| Medida | Esperado | Observado | Veredito |
|---|---|---|---|
| Memória | Plana depois do aquecimento | RSS 62 MB no início, 93 MB aos 30 s, depois **97–105 MB** do minuto 2 ao 30 (inclinação da 2ª metade −4,6 MB/10 min); 92 MB no fim | PASS |
| Conexões e handles | Sem acúmulo | fds 53–69 sob carga (16 clientes + upstream), **12 → 12** do início ao fim; conexões ativas 17–27 sob carga, **1** no fim (a sonda); upstream deixado aberto: 0 | PASS |
| Respostas | Nenhum 200 que esconda resposta quebrada | 98 498 requisições, 96,40 % ok. Todo corte depois do 1º byte veio com evento de erro in-band (331 SSE, 168 s2s); nenhum corte silencioso | PASS |
| Latência | — | p50/p95/p99 (ms): chat JSON 2/7/8002; STT 2/7/8002; SSE 94/102/8002; TTS 206/218/8002; s2s 101/8100/8108 | INFO |
| Breakers | Sem oscilação descontrolada | 33 mudanças de estado, 17 aberturas em 7 elos em 30 min (≈ 1 a cada 2 min com 8 % de falha por chamada); no fim só `chat/t-llm/openrouter:a` aberto | INFO |
| Cache STT | Limitado | 200 entradas (`STT_CACHE_MAX_ENTRIES`, código); metade das ~19 700 transcrições com áudio único não fez o RSS subir | PASS |

**Corrigido depois (D3, abaixo): 5 min com o mesmo caos e a mesma semente, antes (`GATEWAY_CLOUD_HEDGE_MS=0`) ×
depois:** 503 **3,14 % → 1,83 %** (516/16 439 → 386/21 067); chat JSON 51 → 1, chat SSE 115 → 3, TTS 74 → 37, s2s 42
→ 54 (o s2s herda o STT), p99 de chat/SSE/TTS 8002 → ~4000–4200 ms; 97,68 % ok (antes 96,35 %), mais requisições no
mesmo tempo (21 067 × 16 439). Os 503 de STT não mudam (7,1 % → 6,9 %): são falha dupla numa cadeia de 2 elos com o
sorteio duplicado da bancada, não elo pendurado. Memória igual (RSS 91–95 MB, conexões 1 no fim).

**O p99 de 8 s era o elo pendurado comendo o orçamento do estágio.** Os 503 (chat JSON 1,8 %, ≈ os 2 % de «sem
resposta») vêm de o 1º alvo não responder: o tempo até o 1º byte de um alvo de nuvem é o orçamento inteiro do estágio
(8 s), então não sobra tempo para o 2º — o cliente recebe 503 aos 8 s em vez do fallback. É a decisão já registrada
na rodada 1 («orçamento do estágio», só os elos de deployment têm hedge/timeout curto); o soak mede o preço: ~2 % das
requisições com um provedor que trava. Decisão do dono: corrigir (D3). STT tem mais 503 (6,8 %) porque a bancada sorteia a falha duas vezes por
requisição multipart (antes e depois de ler o modelo) e a cadeia tem 2 elos.

### S6 — limites de gasto sob rajada (controller real, nuvem falsa com create de 300 ms, €1/h por réplica)

| Caso | Esperado | Observado | Veredito |
|---|---|---|---|
| 300 pedidos frios simultâneos em 3 deployments, teto 4 réplicas e €2,5/h | Só as réplicas permitidas, teto em € respeitado, sem tempestade | 2 creates (o 3º recusado pelo teto: «spend ceiling reached: running replicas bill €2/h and this one €1/h…»), no máximo 2 creates simultâneos, €2/h. 100/300 servidos em 3 s (`d1`, `d2`); `d3` fica sem réplica enquanto o teto não libera — por desenho. | PASS |
| Rajada com uma réplica `stopping` | Não apagada, termina estacionada | `stopping` durante a rajada, nunca liberada, termina `stopped`. A réplica `stopping` conta no gasto (€) até parar: o 2º create do deployment quente esperou ela parar — conservador. | PASS |
| `list` falhando durante 200 pedidos | Nenhum create; quando volta, só o necessário | 0 creates com a lista falhando (12 listas em 1 s, modo só-liberação); depois 2 creates (= `maxReplicas`), no máximo 2 simultâneos. | PASS |

## Defeitos e correções (cada um com teste que falha antes e passa depois)

**D1 — o lease de uma réplica era devolvido como saudável no cabeçalho da resposta** (`src/deployments/inference-providers.ts`,
`callReplica`). Uma réplica que morria no meio do corpo nunca era marcada suspeita pelo caminho da requisição (a
próxima requisição recebia a mesma réplica morta e só a sonda periódica, 20 s em produção, a tirava), e um TTS em
stream contava 0 em voo enquanto o áudio tocava (o planner subestimava a carga). Correção: o corpo da resposta passa
por `leasedBody`, que devolve o lease no fim do corpo, como **falha** se o corpo quebra (falha de conexão, como diz o
contrato de `Lease.done`), como saudável se quem chama cancela ou desiste (`signal`), e no máximo após `timeoutMs`
(120 s) — um corpo que ninguém lê não segura o lease para sempre. O corpo do catálogo de vozes que não é JSON agora é
cancelado em vez de ignorado. `controller.ts` **não foi tocado**. Testes: «chat: the body breaks after the headers…»,
«TTS stream: the lease is held while the audio streams…», «a body nobody reads…» (falham antes); «a whole answer…»,
«cancels / gives up…», «STT read whole…» (controles).

**D2 — SDK com plano de fallback sem chave pulava um gateway que já tinha voltado** (`sdk/node/gateway-client.ts`,
`gateway-breaker.ts`, `direct-fallback.ts`). Sem `OPENROUTER_PROVISIONING_KEY` o plano vem sem chave (#41), e esse é
hoje o caso normal. Depois de 3 falhas o breaker do SDK manda tudo «direto» por 30 s — mas não há rota direta, então
toda chamada falhava com «gateway skipped», inclusive com o gateway de pé de novo (30,6 s e 61 falhas no S3). Correção:
uma chamada cujo alias não tem entrada direta (s2s: plano sem entrada nenhuma) não é simplesmente pulada — ela sonda
`GET /health` antes (`breaker.recheck()`, no máximo uma sonda por segundo, para um gateway pendurado não custar uma
sonda de 3 s a cada chamada) e vai ao gateway assim que ele responde. Com chave cunhada nada muda (direto, sem sonda).
O erro sem fallback agora diz por quê: «…; no direct fallback: the fallback plan has no provider key for chat '<alias>'
(keyless plan…)» ou «no fallback plan could be fetched». Documentado em `docs/api/client.md`. Testes: «keyless: …
first call after it is back is served», «keyless s2s…», «fails fast with an error that says…», «a failed probe answers
for the next second» (falham antes); «minted key: … straight to the provider» (controle).

**D3 — um elo de nuvem pendurado comia o orçamento inteiro do estágio** (`src/gateway/proxy/provider-routing.ts`,
`routes/chat-completions.ts`). No soak, ~2 % de 503 aos 8 s com 2 % das chamadas travadas; em produção (teste de
autoscale de 07/10, 25 concorrentes em `parle-llm` = `deployment:parle-speech` → `openrouter qwen/qwen3.5-9b` →
`openrouter google/gemini-2.5-flash-lite`): 25/4710 (0,53 %) de 503 aos ~8,1 s, «deployment timed out after 4000ms;
openrouter timed out after 6500ms; openrouter: not tried (stage time budget used up)» — o qwen lento ficava com o
resto do orçamento e o gemini nunca era tentado. Correção: um elo de nuvem com alvo atrás e sem hedge próprio dispara o
seguinte em paralelo depois de **min(4 s, metade do orçamento que resta)** (`runTargets`: chat não-stream, STT, TTS;
o primeiro que responde ganha, o outro é abortado); no chat em stream o mesmo valor é o limite de 1º token antes de
passar ao seguinte. O último elo sempre fica com uma parte real do orçamento. Deployments mantêm o hedge e o timeout
deles. `GATEWAY_CLOUD_HEDGE_MS` (0 = desliga). Custo: um chat não-stream legítimo de mais de 4 s pode faturar o 2º
provedor também (o perdedor é abortado). Documentado em `docs/api/http.md`. Testes (falham antes, passam depois):
«the cloud hedge is min(…)», «non-streamed chat: the first link hangs…», «streamed chat: … no first byte…», e a
cadeia de produção de 3 elos — deployment pendurado (não-stream e stream) e deployment frio: o gemini responde dentro
de 8 s (antes: 503 aos 8 s); controle: um elo de deployment sem hedge não ganha hedge de nuvem.

## Integração com o `main` (bf909f7, #45/#46)

- `inference-providers.ts`: o lease do corpo (D1) agora usa os desfechos neutros do #46 — `ok` no fim do corpo,
  `failed` quando o corpo quebra, `timeout` quando o limite (nosso ou de quem chama) corta, `cancelled` quando quem
  chama cancela/aborta ou ninguém lê o corpo em `timeoutMs`; 429 da réplica = `overloaded`.
- S1a' (TTS) depois do #46: o lease vale durante o áudio e sai como `failed`, mas a réplica que acabou de servir (o
  catálogo de vozes) é tratada como **ocupada**, não suspeita («busy is not dead»), e o próximo `acquire` ainda pode
  recebê-la até uma sonda falhar. É a política do #46; a bancada registra sem julgar.
- S6a depois do #46: 12/300 servidos em 3 s (antes 100/300) — o excesso agora é desviado na hora (`saturated`) em vez
  de esperar; réplicas e teto em € iguais.

## Observações não consertadas (decisão ou fora do escopo)

- **Sem contrapressão no SSE** (S4): `buildSSEStream` enfileira tudo o que o provedor manda; com respostas de LLM de
  poucos kB não importa. Só valeria mexer se houver respostas grandes ou muitos leitores lentos.
- **s2s com STT fora faz 2 chamadas por provedor** (S2): o estágio do loopback refaz uma vez um 502/503 (pensado para
  a réplica em cold start). Barato (ms) e limitado.
- **SDK sem plano nenhum: ~0,8 s por chamada** enquanto o gateway está fora (GET do plano com 2 retries). Limitado;
  some assim que um plano é obtido (`refreshFallbackPlan()` no boot).
- **Gateway pendurado + plano sem chave**: depois de D2 cada chamada espera no máximo a sonda (3 s), uma por segundo;
  antes as chamadas falhavam em 0 ms mas a recuperação esperava o cooldown inteiro.
- O lint dos diretórios tocados tem 2 erros antigos em arquivos não tocados (`sdk/node/audio.ts` prefer-const,
  `sdk/node/gateway-contract.ts` tipo não usado).

## Arquivos

- `src/deployments/inference-providers.ts` (D1), `src/gateway/proxy/provider-routing.ts`,
  `src/gateway/proxy/routes/chat-completions.ts`, `docs/api/http.md` (D3), `sdk/node/gateway-client.ts`, `sdk/node/gateway-breaker.ts`,
  `sdk/node/direct-fallback.ts` (D2), `docs/api/client.md`.
- `scripts/fault-bench/{scenarios,gateway-scenarios,deployment-scenarios,replica-cloud}.ts` (novos),
  `scripts/fault-bench/{gateway,fake-upstream}.ts`, `package.json` (`bench:fault-scenarios`).
- `__tests__/unit/gateway-routing/fault-scenarios-regressions.test.ts`.
