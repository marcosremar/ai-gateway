# Teste de estresse na Vast.ai — 2026-10-09

Código sob teste: `rt/integration-2` em `557bed6` (PR #70), worktree `/Users/marcos/aigw-vs`, branch `test/vast-stress`.
Gateway local `bun serve.ts` na porta 4200, namespace `marcos-vast-stress`, estado em diretório de rascunho da sessão,
chaves carregadas da API dev pelo `SANDBOX_TOKEN` (nunca impressas). Mac na França (uplink móvel, IPv4 atrás de CGNAT).
Todas as horas em UTC. Ferramentas: `scripts/vast-stress/` (README lá).

Carga: imagem pública `ghcr.io/ggml-org/llama.cpp:server-cuda-b11382` (a mesma tag do `docker/speech-stack/Dockerfile`;
2,59 GB comprimida, CUDA 12.8 → `minCuda: 12.8`), modelo público `Qwen/Qwen2.5-0.5B-Instruct-GGUF`
`qwen2.5-0.5b-instruct-q4_k_m.gguf` (491 400 032 bytes, sha256 `74a4da8c…7d9db`, conferido no Hugging Face antes),
baixado no boot por `fileUrls` com sha256. `llama-server -ngl 99 -c 16384 --parallel 16`, `/v1/chat/completions` em
streaming, saúde em `/health`. Spec: `scripts/vast-stress/llm.json` (RTX 3090/3080/4070/3060, ≤ €0,22/h).

Sessão anterior (03:00–03:13): preparou o worktree e leu o saldo (US$ 9,90 de crédito às 03:13:09); parou por cota da
API antes de alugar qualquer coisa. Confirmado pela listagem no provedor às 03:19:28: 0 instâncias no namespace.

## Resumo

- Alugar, servir e escalar funcionam: 25 aluguéis em 16 hosts (11 liberados pelo portão RTT), boot de 40–160 s com imagem pequena, 128 streams
  numa RTX 3090 de US$ 0,18/h sem erro nem travamento, reinício do gateway sem duplicar máquina, reaper limpa o namespace.
- Quatro defeitos reais corrigidos com teste nesta branch: app morto que nunca era substituído (502 para sempre),
  pedido pendurado 15 min num caminho de rede morto, imagem inexistente em laço pago, réplica em boot escapando do
  portão RTT num reinício.
- O ponto fraco para uma aula é a recuperação: perder um host custa 1,5–7 min sem GPU (substituta + portão RTT
  rejeitando hosts), e o portão fica cego sob carga.
- Gasto: US$ 0,87 (Vast); nada alugado no fim (provedor e reaper `seen: 0`).

| Recuperação | Detecção | O que o chamador viu | Recuperou? |
|---|---|---|---|
| 5a app morto (antes) | nunca | 502 HTML por 7,5 min, sem fim | não (só por acaso, num reinício) |
| 5a app morto (depois) | 2 min 4 s | ~2,5 min de 502, depois espera | sim |
| 5b host destruído (3 rodadas) | 4 s | streams cortados ou reencaminhados; espera 95 s – 7+ min pela substituta | sim (95 s, 4 min 57 s) / não em 7 min (mercado vazio) |
| 5c rede some (teste local) | ~30 s (`DOWN_GRACE_MS`) | antes: pendurado 15 min; depois: erro/reenvio | sim (depois do conserto) |
| 5d `kill -9` do gateway, 2× | — | erro imediato de conexão; nada pendurado | sim, réplicas adotadas, 0 duplicadas |
| 5e gateway fora 10 min + reaper | — | — | sim, 2 órfãs liberadas, a nova (11 min) poupada, nada de outro namespace |

## Saldo e gasto

| Momento | Crédito Vast | Fonte |
|---|---|---|
| 03:13:09 | US$ 9,8998 | `scripts/vast-stress/vast.ts balance` (sessão anterior) |
| 03:22:19 (antes do 1º aluguel) | US$ 9,8974 | idem |
| 05:07:48 (fim, nada alugado) | US$ 9,0309 | idem — gasto US$ 0,867 (detalhe em Limpeza e custo) |

## Resultados

### 1. Aluguel e boot

| Hora | Deployment | Instância / host | Local, US$/h | O que aconteceu | Tempo |
|---|---|---|---|---|---|
| 03:22:20 | llm-a (rajada fria) | 54957875 / 2501 | Noruega, 0,224 | oferta 1 de 4 (a francesa do `/offers` de 03:21 tinha sumido); endereço em ~60 s; portão RTT 72 ms, base 31 ms (+41 > 20): **liberada `too-far`** às 03:23:23, host evitado 24 h | 63 s pagos |
| 03:23:24 | llm-a | 54958014 / 48973 | França, 0,176 (Vast cobra 0,181 com disco) | oferta 1 de 6; RTT 50 / base 38 ms (+12): mantida; **pronta às 03:26:01** | **157 s** do aluguel ao pronto |
| 03:36:38 | llm-a (escala p/ 2 em carga 64) | 54959533 / 700 | Noruega, 0,208 | oferta 1 de 6 | ver abaixo |
| 03:36:43 | llm-soak | 54959545 / 150060 | Espanha, 0,216 | oferta 1 de 5 | ver abaixo |

- Portão RTT: decidido **depois** do pull da imagem (o endereço só existe com o contêiner rodando). Custo do host
  rejeitado: 63 s × US$ 0,224/h ≈ **US$ 0,004** (imagem de 2,6 GB; com a imagem de 22 GB do speech-stack seriam minutos).
- Rajada fria (10 pedidos em streaming, `minReplicas 0`, `maxReplicas 2`): **1 máquina** pedida (`desired 1, reason base`,
  mais a substituta do host rejeitado), sem estouro de manada. Os 10 esperaram **222 s** e os 10 receberam resposta
  completa (200, `[DONE]`); nenhum 503: a espera ficou abaixo do `coldStartWaitSeconds` 240. O primeiro aluno espera
  ~3,7 min sem nenhum sinal de progresso no corpo.

### 2. Conectividade pela internet

Réplica 54958014 (França, `82.65.196.171`), portas mapeadas pela Vast: 80/tcp → 16729 (nginx do gateway), 22/tcp → 16637 (SSH).

| Caminho | RTT (TCP connect, mediana de 7) | TTFT p50 / p95 (seq., 20 s) | Total p50 / p95 |
|---|---|---|---|
| Mac → réplica direta (porta 16729, com token) | 33 ms (S3 Paris: 33 ms) | 56 / 69 ms | 112 / 161 ms |
| Mac → gateway local → réplica (`/invoke`) | — | 58 / 132 ms | 124 / 198 ms |

| Exposição pública (sem token) | Resposta |
|---|---|
| `/health`, `/v1/chat/completions`, `/v1/models`, `/props`, `/slots`, `/metrics`, `/__aigw/ready` | 401 (nginx), também com token errado |
| HTTPS na porta 80 | sem TLS (só HTTP) |
| porta 8000 do llama-server | fechada (só 127.0.0.1) |
| SSH (16637) | `SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.19` aberto à internet (só chave; vem do `runtype: ssh_direct`) |
| com o token certo | tudo do llama-server, inclusive `/slots` |

Veredito: **passou** (modelo não fica aberto sem token). Achado: o token `X-Aigw-Token` e o conteúdo dos pedidos
trafegam **em texto claro** entre gateway e host (HTTP); quem estiver no caminho vê o token e passa a usar a réplica.

### 3. Inferência sob carga (03:30:36–03:40:40, código ainda sem o conserto)

Rampa 1 → 4 → 16 → 64 → 128 pedidos simultâneos em streaming pelo gateway, 120 s por nível, `max_tokens` 64,
timeout do cliente 90 s. `targetInflightPerReplica` 16, `maxReplicas` 2. Custo por 1 000 pedidos com sucesso =
preço Vast (com disco) × 120 s das réplicas que serviram ÷ sucessos.

| Simultâneos | Pedidos | Sucesso | TTFT p50 / p95 / máx (ms) | Total p50 / p95 / máx (ms) | tokens/s | Por réplica | RSS do gateway (MB) | US$ / 1 000 |
|---|---|---|---|---|---|---|---|---|
| 1 | 936 | 100 % | 59 / 141 / 283 | 118 / 210 / 356 | 258 | 8014: 936 | 50–66 | 0.0064 |
| 4 | 1710 | 100 % | 66 / 153 / 510 | 268 / 464 / 675 | 462 | 8014: 1710 | 56–69 | 0.0035 |
| 16 | 3312 | 100 % | 84 / 201 / 588 | 537 / 996 / 1334 | 891 | 8014: 3312 | 71–82 | 0.0018 |
| 64 | 4999 | 100 % | 1302 / 1448 / 1720 | 1651 / 2089 / 2366 | 1353 | 8014: 4376 / 9533: 623 | 82–93 | 0.0026 |
| 128 | 8089 | 100 % | 1462 / 1581 / 1865 | 1887 / 2329 / 2678 | 2203 | 8014: 4352 / 9533: 3737 | 85–100 | 0.0016 |

- **Nenhum erro, nenhum pedido pendurado** (0 timeouts de cliente em 19 046 pedidos). Acima da capacidade
  (16 × fator 1,5 = 24 por réplica) o gateway **enfileira** (`waiting` 40 em 64), não devolve 429/503: o TTFT sobe para
  1,3–1,5 s, que é a espera na fila. Sem `Retry-After` porque nada foi recusado.
- Escala: em carga 64 o autoscale pediu a 2ª réplica (`burst: load 64 is a full replica above capacity 16`) às 03:36:38,
  pronta às 03:38:18 (100 s); em 128 a carga dividiu 4 352 / 3 737.
- Recuperação: depois da carga `inflight` 0 e `waiting` 0 nas duas réplicas (nenhum contador preso); 1 simultâneo
  logo depois: TTFT p50 59 ms / p95 77 ms, igual ao início (59 / 141).
- Memória do gateway: 50 → 100 MB no pico de 128 streams.
- **Achado:** a 2ª réplica caiu num host da Noruega com RTT **144 ms** e base **143 ms**: a base (S3 de Paris) foi medida
  com o uplink do Mac saturado pela própria carga, então os dois números subiram juntos e o portão relativo deixou passar
  (+1 ms). O portão fica cego exatamente quando a escala acontece (sob carga).

### 4. Escala (parcial: ver também 3)

| Teste | Resultado |
|---|---|
| Rajada fria com `minReplicas 0` | 1 máquina para 10 pedidos (sem manada); 222 s de espera; todos atendidos |
| Escala para 2 sob carga (modo padrão `balanced`) | em carga 64 → 2ª réplica pedida no mesmo tick, pronta em 100 s; `/capacity` dizia `boot 100 s (measured, 2 amostras)`, `ceiling 8 sessions (default)` — o teto de sessões não reflete a carga real (64 streams numa 3090 sem erro) |
| Escala para dentro (`PATCH maxReplicas 1`) | réplica ociosa liberada em 1 s (`scale-down`) |

### 5b. Destruição da instância no provedor com pedidos em andamento

03:42:37 `vast.ts destroy 54958014` (backend do repo, fora do gateway) com 8 streams contínuos em llm-a (única réplica).

| Medida | Valor |
|---|---|
| Detecção | 4 s (03:42:41 `creating replica`; a lista da Vast já não trazia a instância) |
| Pedidos em andamento | terminaram ou foram reencaminhados: às 03:42:45 `inflight 0`, `waiting 8` (sem erro devolvido) |
| O que o chamador viu | **silêncio**: os pedidos ficaram na fila esperando a substituta; com timeout de cliente de 90 s, 16 pedidos expiraram sem nenhum byte (2 levas de 8) |
| Substituição | 3 tentativas: Noruega (host 700) `too-far` 70/43 ms, Tchéquia `too-far` 60/37 ms, França (143628) mantida; **pronta às 03:47:34 = 4 min 57 s** depois da destruição (o reinício do gateway às 03:46:48 caiu no meio, ver 5d) |
| Réplica fantasma no estado | nenhuma |
| Cobrança dupla | não: a instância destruída sumiu da listagem; a substituta é a única de llm-a |

Veredito: **passou com ressalva**. O gateway detecta e substitui, mas um aluno ficaria ~5 min sem resposta e sem aviso
(o `coldStartWaitSeconds` 240 devolveria 503 só aos 4 min). O host da Noruega que tinha passado no portão com a base
inflada (seção 3) virou "conhecido bom" e foi o **primeiro** tentado — o erro do portão sob carga envenena o ranking.

### 5d. Reinício do gateway (`kill -9`) com réplicas no ar e em boot

03:46:48 `kill -9` no gateway com llm-soak servindo (trickle), llm-a e llm-crash **ainda em boot** (o caso clássico de
órfão); novo processo no mesmo diretório de estado às 03:47:13 (pronto em 1 s).

| Medida | Valor |
|---|---|
| Arquivo de estado | intacto (byte a byte igual ao de antes, JSON válido) |
| Réplicas adotadas | as 3 (mesmos ids), nenhuma criação nova; listagem no provedor: 3 instâncias |
| Pedidos em andamento | os da fila de llm-a receberam `socket closed unexpectedly` na hora; o trickle perdeu 8 pedidos em 24 s (`Unable to connect`) — erro limpo, nenhum pendurado |
| Réplica em boot | adotada e ficou pronta (llm-a 03:47:34, llm-crash 03:47:56) |
| **Defeito** | as duas em boot **escaparam do portão RTT**: adotada = "pode estar servindo", nunca medida contra a base. Um host distante alugado logo antes de um reinício ficaria. Corrigido (commit `e451d1c`) |
| Defeito menor | após o reinício, `replica ready` de llm-soak saiu com `bootMs 632845` (idade da máquina, não boot) |

### 5a. O servidor do modelo morre dentro do contêiner

Deployment `llm-crash`: mesmo spec, `bootScript` = llama-server em segundo plano e `kill -9` nele 420 s depois (o nginx
do gateway continua de pé). Trickle de 2 pedidos simultâneos a cada ~2 s. Host 146617 (Alemanha), pronto 03:47:56.

| Medida | Antes do conserto (código de `557bed6` + 1º conserto) |
|---|---|
| Morte do llama-server | 03:54:51 |
| O que o chamador viu | **502 Bad Gateway em HTML do nginx**, em ~50 ms, para **todos** os pedidos, por 7 min 36 s (≈ 1 300 pedidos) |
| O gateway | a réplica ficou `ready` (`busy: true`): o probe via `/__aigw/ready` ok e `/health` falhando = "ocupada"; e cada 502 contava como "respondeu" e renovava a carência de 120 s. **Nunca seria substituída** enquanto houvesse tráfego |
| Como terminou | só porque reiniciei o gateway às 04:02:21: a réplica adotada, nunca pronta desde o reinício, foi liberada como **`boot-timeout`** às 04:02:27 — rótulo errado, que ainda põe o host (que estava bom) na lista de evitados por 1 h |

**Defeito grave, corrigido** (commit `95a8950`): uma resposta 5xx não prova mais que o app está vivo (nem conta como
falha): o probe de saúde que falha substitui a réplica. Prova ao vivo depois do conserto: ver 5a (2º ciclo) abaixo.

### 5c. Rede degradada entre gateway e réplica

Não usei `pfctl`/`dnctl` (exige sudo e não dá para limitar com segurança só ao IP:porta da réplica sem tocar no resto do
Mac). Simulei com um proxy TCP local na frente de uma réplica falsa, num teste do repo
(`__tests__/unit/deployments/replica-network-fault.test.ts`): o caminho vira buraco negro (aceita, não responde, não
fecha) com um pedido no ar.

| Medida | Antes | Depois do conserto (commit `dfbc601`) |
|---|---|---|
| Pedido no ar quando o caminho some | **pendurado** até o timeout de 15 min do invoke (o teste estoura em 75 s) — mesmo depois de o controlador liberar a réplica como `unhealthy` | cortado quando a réplica sai da lista (≈ `DOWN_GRACE_MS` 30 s + strikes), reencaminhado/502 |
| Réplica | liberada como `unhealthy` após 30 s sem resposta da frente | igual |

### 5f. Erros da API da Vast (falsos do repo)

`__tests__/unit/deployments/vast-provider-faults.test.ts` (novo) e os existentes de `vast-backend.test.ts`:

| Falha no aluguel (`PUT /asks`) | Comportamento |
|---|---|
| 429 com `Retry-After: 7` | para na 1ª oferta (não gasta as 5); o controlador espera 60 → 120 → 300 → 600 s. O `Retry-After` do create é ignorado (só a listagem o respeita) |
| 500 / timeout | idem, para na 1ª oferta |
| resposta perdida depois do aluguel (socket caiu) | a instância aparece na próxima listagem pelo rótulo `aigw:<ns>:<deployment>` e é adotada: nunca fica sem dono |
| listagem com 429/5xx | já coberto: recuo de 15 s dobrando até 2 min, serve a última listagem boa até o limite de staleness, depois falha alto |

Ao vivo: nenhum 429 da Vast em ~1 h de uso.

### 5g. Crédito acabando (`insufficient_credit`) — só leitura do código + falso

- Não há tratamento próprio no backend de deployments (`src/deployments/vast-backend.ts`): um `PUT /asks` com
  `400 {"error":"insufficient_credit"}` vira erro genérico: 1 tentativa, recuo 1 → 10 min, e o `lastError` mostra o
  texto cru da Vast. O cliente antigo de GPU (`src/gateway/providers/gpu/vast/marketplace.ts`) reconhece o caso; o novo não.
- Uma réplica que a Vast para por falta de crédito aparece como `stopped` → `exited` → apagada e "substituída"; a
  substituição falha com `insufficient_credit`. Os alunos daquela réplica caem e esperam até 240 s por uma réplica que
  não vem. Nenhum alerta, nenhuma checagem de saldo antes de alugar, nenhum aviso de saldo baixo.
- Mudança recomendada (não feita): reconhecer `insufficient_credit` como terminal (código próprio, `blockedBy` claro,
  503 imediato em vez de espera, `ALERT_WEBHOOK_URL`) e ler `/users/current/` (crédito) antes de alugar.

### 4b. Modos de escala (04:03–04:06, 40 simultâneos por 60 s em llm-a, `maxReplicas 2`, teto global 3)

| Modo | Decisão (`autoscale.reason`) | Resultado | TTFT p50 / p95 |
|---|---|---|---|
| economy | pediu a 2ª: "fallback took 17.1 load-minutes … (€0.34) ≥ €0.02 for one replica start" | bloqueada pelo teto global (3 máquinas) | 598 / 694 ms |
| balanced | pediu a 2ª (mesma regra de custo) | alugou (França, pronta em 81 s) | 601 / 708 ms |
| fast | "one spare replica at load 40" | 2 réplicas | 144 / 612 ms |

- Com GPU barata (€0,17/h × boot 100 s) um start custa €0,02: **economy se comporta como balanced** — a régua de custo
  não poupa nada nesta faixa de preço.
- "fallback took … load-minutes" é contado sobre pedidos **enfileirados** (não há fallback neste deployment): o texto
  engana.
- **Achado (médio):** o teto global não reserva o piso `minReplicas` de ninguém. Às 04:03:46 a réplica nova de
  `llm-crash` (`minReplicas 1`) foi liberada por `too-far`; 1 s depois o `economy`/`balanced` de llm-a pegou a vaga, e
  llm-crash ficou **sem réplica** ("replica cap reached … held by llm-a 2, llm-soak 1") com status `scaled-to-zero`,
  apesar do `minReplicas 1`. Num cliente: o burst de uma turma pode tomar o piso de outra.

### 5a (2º ciclo). Depois do conserto, ao vivo

Gateway reiniciado às 04:02:21 com os três consertos. `llm-crash` alugou Polônia (`too-far` 04:03:46), perdeu a vaga
para llm-a (achado acima), depois Áustria (`too-far` 04:07:46) e Espanha 54962730 (pronta 04:08:26, **39 s** de boot).

| Medida | Depois do conserto |
|---|---|
| Morte do llama-server | 04:15:20 (1º 502 visto pelo cliente) |
| Detecção (`replica unhealthy`) | 04:17:24 = **2 min 4 s** (a carência de 120 s conta a partir do último 200 verdadeiro) |
| Liberada (`unhealthy`, rótulo certo) e substituta pedida | 04:17:45 / 04:17:46 (Bulgária) |
| O que o chamador viu | 502 do nginx por ~2 min 25 s (143 pedidos), depois espera pela substituta |

Veredito: **passou depois do conserto** (antes: nunca recuperava). Ainda 2 min de 502 para o aluno; ver mudanças.

### 6. Soak (03:38:26–04:18:26)

llm-soak, 1 réplica na Espanha (host 150060), 1 pedido a cada 1,5–4,5 s por 40 min enquanto os outros testes rodavam.
773 pedidos, 763 ok (98,7 %): os 10 erros são os dois `kill -9` do gateway (5d), `Unable to connect` local. Zero
timeouts, zero desconexões da réplica, nenhuma deriva:

| 5 min a partir de | Pedidos ok | TTFT p50 | p95 | máx (ms) | Erros |
|---|---|---|---|---|---|
| 03:35 | 28 | 61 | 143 | 144 | 0 |
| 03:40 | 102 | 57 | 142 | 484 | 0 |
| 03:45 | 88 | 55 | 168 | 1662 | 8 (kill -9) |
| 03:50 | 100 | 53 | 107 | 165 | 0 |
| 03:55 | 96 | 52 | 134 | 208 | 0 |
| 04:00 | 90 | 60 | 135 | 164 | 2 (kill -9) |
| 04:05 | 97 | 57 | 111 | 151 | 0 |
| 04:10 | 95 | 51 | 102 | 141 | 0 |
| 04:15 | 67 | 51 | 85 | 134 | 0 |

A saúde da réplica ficou `ready` o tempo todo (watcher a cada 10 s), inclusive nos dois reinícios (adotada).

### 5e. Gateway fora do ar por 10 min, depois o reaper

04:18:36 `kill -9` no gateway com llm-soak e llm-a prontas e llm-crash em boot (Bulgária, alugada 04:17:46). Às 04:28:45
(10 min) o reaper em modo gateway-down, só para o meu namespace (`GATEWAY_URL` = a porta morta, sem chave de admin).

| Passo | Resultado |
|---|---|
| Dry run (04:28:45, sai 0) | `seen 3, releasing 2`: `llm-soak/54959545`, `llm-a/54960394` (idade > 30 min); a da Bulgária (11 min) **poupada** pela regra dos 30 min. Linha final `reaper: DRY RUN, nothing released … would release 2` |
| Outros namespaces | só **listados** (`ALERT reaper.foreign_quota_held`): `marcos-proof-70` (L40S Scaleway do outro agente, rodando) e `dev-marmos` (2 POP2 paradas há 42 h). Nenhum na lista de liberação. Nenhuma instância Vast de outro namespace |
| `--apply` (04:31:25–04:33:27, sai 0) | `released: [54959545, 54960394]`, `failed: []`; a listagem no provedor depois: só a da Bulgária |
| Reinício do gateway (04:34:00) | a da Bulgária (deployment apagado logo em seguida) liberada como `orphan` em 1 s; namespace vazio às 04:34:28 |

Veredito: **passou**. Pior caso real em produção: 15 min do cron + 2 min de sondagem + o que faltar para 30 min de idade.

### 1b. Imagem que não existe

04:34:54 `bad-img`: o mesmo spec com `image: ghcr.io/ggml-org/llama.cpp:server-cuda-does-not-exist`, `bootTimeoutMinutes 10`.

| Passo | Resultado (antes do conserto `a36d941`) |
|---|---|
| `PUT` | aceito, `warnings: []` (nenhuma checagem do registro) |
| Vast | alugou (Estônia, US$ 0,175/h); instância em `loading` com `status_msg: Error response from daemon: manifest unknown` |
| Gateway | réplica `booting`, `lastError: null` por **10 min** (o padrão é 30) |
| Depois | liberada como `boot-timeout` (o host bom fica evitado 1 h) e **outro host alugado na hora** (França, `failed to resolve reference … not found`): laço sem fim, ~10–30 min pagos por volta |
| Custo | ~11 min de máquina ≈ US$ 0,035 até eu apagar o deployment |

Conserto (commit `a36d941`): a listagem da Vast passa a trazer o erro de pull; a réplica é liberada na hora como
`boot-failed` (sem culpar o host), `lastError` = `boot failed on the provider: <mensagem>`, criação com recuo 1 → 10 min
até o spec mudar. Coberto por teste; **não provado ao vivo** (o conserto veio depois da rodada).

"Oferta que some entre a listagem e o aluguel": vista ao vivo uma vez (a francesa de 03:21 já não estava às 03:22);
o caminho "outra oferta é tomada → próxima" é coberto pelo teste existente (`not available` → próxima oferta).

## Reputação de hosts (`vast-hosts.json` no fim)

13 hosts. Bons: França 48973 (2 boots, 90 s), França 150998 (2 boots, 43 s), Espanha 150060 (2 boots, 39 s).
`too-far` (evitados 24 h): Noruega 2501 (+41 ms), Noruega 700 (+27; antes passou com +1 sob carga), Tchéquia 24033
(+23), Polônia 13098 (+33), Áustria 150574 (+22). `boot-timeout` (evitados 1 h): Alemanha 146617 — **errado**, era o meu
llama-server que morreu (5a) — e Estônia 56254 — **errado**, era a imagem inexistente (1b).

## Distribuição de boot e falhas

17 aluguéis em 12 hosts (sem contar a 2ª rodada do `run.ts`). Do aluguel ao pronto, nos que chegaram a ficar prontos
sem reinício no meio: 39, 43, 63, 81, 81, 90, 100, 157 s (mediana ~85 s). Imagem de 2,6 GB + modelo de 0,5 GB; a
imagem de 22 GB do speech-stack ficaria muito acima (16 min em 2026-10-08).

| Desfecho do aluguel | Quantos |
|---|---|
| ficou pronto e serviu | 9 |
| liberado `too-far` pelo portão RTT (40–100 s pagos cada) | 5 (29 %) |
| imagem inexistente (teste 1b) | 2 |
| apagado em boot com o deployment | 1 |

## Defeitos encontrados

| # | Defeito | Severidade | Estado |
|---|---|---|---|
| D1 | Servidor do modelo morto atrás do nginx: cada 502 renovava a carência de "ocupada" e a réplica **nunca** era substituída enquanto houvesse tráfego; todo chamador recebia 502 em HTML | **alta** | corrigido `95a8950` + teste; provado ao vivo (detecção 2 min 4 s) |
| D2 | Pedido no ar numa réplica cujo caminho de rede some (sem RST) ficava pendurado até 15 min, mesmo depois de a réplica ser liberada | alta | corrigido `dfbc601` + teste (proxy buraco negro); não provado ao vivo (a destruição na Vast manda RST) |
| D3 | Imagem inexistente: réplica `booting` com `lastError null` até o `bootTimeoutMinutes`, host bom culpado, novo aluguel em laço | média-alta (dinheiro) | corrigido `a36d941` + teste; não provado ao vivo |
| D4 | Réplica ainda em boot num reinício do gateway escapava do portão RTT | média | corrigido `e451d1c` + teste |
| D5 | Portão RTT relativo cego sob carga: a base é medida do mesmo uplink saturado (Noruega passou com 144/143 ms) e o host vira "conhecido bom", primeiro do ranking | média | aberto |
| D6 | O teto global de réplicas não protege o `minReplicas` de outro deployment: um burst tomou a vaga de llm-crash, que ficou sem réplica (`scaled-to-zero` com `minReplicas 1`) | média | aberto |
| D7 | `insufficient_credit` sem tratamento no backend novo: erro genérico, sem alerta, alunos esperando 240 s por réplica que não vem | média | aberto (lido no código + falso) |
| D8 | Token `X-Aigw-Token` e conteúdo em HTTP claro entre gateway e host; SSH do `ssh_direct` aberto à internet | média | aberto |
| D9 | Rótulos errados: crash do app depois de reinício liberado como `boot-timeout` (culpa o host 1 h); `replica ready` com `bootMs` = idade da máquina após reinício (632 845 ms, 1 543 320 ms); linhas de log do controlador carregam campos de outra chamada (a linha `replica ready` de llm-a dizia "Spain" com o host da Noruega) | baixa | aberto |
| D10 | `economy` não economiza com GPU barata (um start custa €0,02) e o motivo fala em "fallback" sem haver fallback | baixa | aberto |
| D11 | Primeiro chamador numa partida a frio espera até 240 s sem nenhum byte; `PUT` aceita imagem sem checar o registro | baixa | aberto |

Ferramenta (não gateway): `run.ts` contava as máquinas do namespace inteiro e tratava espera da fila como travamento —
corrigido no próprio script.

## O que isso diz sobre usar a Vast como transbordo da sala

- **Boot**: com imagem pequena, 40–160 s do aluguel ao pronto (mediana ~85 s). Um em cada ~3,5 aluguéis cai no portão
  RTT (hosts NO/CZ/PL/AT/BG a +20–40 ms de Paris) e soma 40–100 s; na prática o 1º aluno espera 1–5 min. Com a imagem
  de 22 GB do speech-stack, some ~4 min de pull a cada tentativa.
- **Em carga**: uma 3090 de US$ 0,18/h serviu 128 streams sem erro (fila, TTFT 1,5 s); nada pendurou. Custo ≈ US$ 0,001
  por 1 000 pedidos curtos em carga alta.
- **Falhas** (o que o aluno sentiria):
  - host destruído/recuperado pela Vast: 0–5 s para notar, depois **1,5–5 min de silêncio** até a substituta (sem aviso);
  - app morto dentro do host: antes do conserto, 502 para sempre; agora **~2 min de 502** e depois a espera da substituta;
  - gateway reiniciado: pedidos em andamento caem na hora com erro; réplicas são adotadas, nada duplicado;
  - gateway morto por muito tempo: o reaper libera as máquinas com mais de 30 min; o resto morre com o `maxHours`;
  - crédito acabando: a réplica cai e a substituta não vem (só leitura de código).
- Veredito: **utilizável como transbordo com fallback na nuvem na frente**, não como única capacidade de uma turma:
  qualquer falha de host custa minutos de silêncio a quem estava nele.

## Mudanças antes de confiar nisso numa aula

1. Integrar os quatro consertos desta PR (D1–D4).
2. Portão RTT: medir a base com a carga própria fora do caminho (ou várias vezes e usar a menor) e não promover a
   "conhecido bom" um host medido sob carga (D5).
3. Reservar o `minReplicas` de cada deployment dentro do teto global (D6).
4. `insufficient_credit` terminal + alerta + checar crédito antes de alugar e avisar abaixo de um piso (D7).
5. Ao perder a réplica no meio de uma sessão, devolver logo um 503 com `Retry-After` (para o cliente cair no fallback)
   em vez de esperar até 240 s pela substituta; o mesmo para o 1º chamador a frio.
6. Carência de "ocupada" mais curta quando o probe de saúde falha e só chegam 5xx (hoje 2 min de 502).
7. TLS ou túnel entre gateway e host, ou pelo menos rotacionar o token por réplica; fechar o SSH se não for usado.
8. Imagem pequena e pública (ou credencial só-leitura) para o speech-stack: o pull de 22 GB domina o boot.

## Repetição com o comando único (`bun scripts/vast-stress/run.ts`)

Duas rodadas, gateway já com os consertos D1–D3 (a 2ª também com D4).

| Checagem | Rodada 1 (04:34–04:46) | Rodada 2 (04:48–05:05) |
|---|---|---|
| rajada fria 10/10 | PASS (44 s, host já com a imagem) | PASS (178 s: Polônia `too-far` antes) |
| uma máquina para a rajada | FAIL (contou a `bad-img` em paralelo; script corrigido) | PASS |
| rampa 1/4/16/64, sucesso ≥ 99 % | PASS (100 %) | PASS (100 %) |
| TTFT p95 a 1 ≤ 500 ms | PASS (115) | PASS (80) |
| destruição no provedor: substituta pronta ≤ 420 s | PASS (95 s) | **FAIL**: 5 hosts seguidos `too-far` (França +24 ms, Bulgária ×3, Tchéquia) em 7 min; nenhum perto livre |
| ninguém pendurado | FAIL (espera de 95 s > timeout de 90 s do cliente; script corrigido para 300 s) | PASS: streams em andamento cortados (`socket closed`, 6), novos pedidos `503 Retry-After: 30 "replicas are starting"` (8) |
| nada sobrando no provedor | PASS | PASS |
| gasto | US$ 0,034 (gateway) | US$ 0,051 (gateway) / US$ 0,081 (Vast) |

A rodada 2 mostra o risco real do transbordo às 05h: o mercado perto de Paris esvaziou e o portão rejeitou tudo por
7 min; um aluno ficaria sem GPU (com `503 Retry-After`, ao menos, e não pendurado).

## Limpeza e custo

| Prova (05:05–05:07) | Resultado |
|---|---|
| `GET /v1/deployments?scope=all` no gateway de teste | 0 deployments, 0 réplicas, `eurPerHour 0` |
| listagem no provedor pelo backend do repo (`vast.ts list`) | `mine: []`, `otherNamespaces: []` |
| reaper em modo gateway-down (gateway parado), dry run | `seen: 0` em Vast e Scaleway para `marcos-vast-stress` |
| gateway da porta 4200 e watcher | parados |

| Saldo Vast | Crédito |
|---|---|
| 03:22:19 (antes) | US$ 9,8974 |
| 05:07:48 (depois) | US$ 9,0309 |
| **gasto pela Vast** | **US$ 0,867** |
| gasto pelo gateway (preço × tempo, watcher + 16 min sem watcher estimados) | ≈ US$ 0,75 |

A diferença (~14 %) é disco (20 GB por instância), banda cobrada por alguns hosts (imagem 2,6 GB + modelo 0,5 GB a cada
aluguel, 25 aluguéis) e os segundos entre o aluguel e a 1ª leitura do watcher. Ficaram ~US$ 9,03 na conta.
