# Deploy do ai-gateway em produção — 2026-10-09 (madrugada, Europe/Paris)

Executado pelo runbook `2026-10-08-deploy-runbook.md`, sexta 00:31 → 01:45 de Paris (22:31 → 23:45 UTC de 08/10), fora de
aula. Só o serviço `ai-gateway` foi tocado; nenhuma variável mudou; o reaper não foi redeployado.

## Resultado

| | |
|---|---|
| Deploy | **feito**: Railway `29e23119-3002-4bd5-a7a1-fad4dafbd7f8`, `SUCCESS` às 22:55:03Z (build 22:53:51 → 22:54:54, container novo de pé em ~1 min) |
| Commit | `baea25879bdc52a03104a0f4d340c49959346766` (`origin/main`, PR #56), worktree limpo |
| Anterior (rollback) | `b7f62dea-a18e-4f94-aa55-de781ab21457` (commit `bf909f7`, 07/10) |
| Estado | carregado de `/data`: os 4 deployments, `parle-speech` declarado `applied` |
| Voz clonada (`parle-tts`) | servida pelo `parle-qwen-tts`; boot frio sob o código novo 460 s |
| Stack de voz (`parle-speech`) | boot frio 496 s; sessão realtime de 28 turnos sem cair |
| **Incidente achado, fora do deploy** | **a `OPENROUTER_API_KEY` da API dev expirou** (`401 API key expired`): toda a reserva de nuvem (STT, LLM, voz) está `no_key`. Sem GPU pronta o pedido volta 503 |

## Incidente: chave da OpenRouter expirada

- Entre 22:41Z (último turno servido pela reserva, 200) e 22:55Z a chave que a API dev (`palco`) entrega passou a
  responder `401 {"message":"API key expired."}` em `/api/v1/key` e em `/api/v1/chat/completions` (sondado direto na
  OpenRouter, fora do gateway). É a mesma chave do processo antigo (as recargas de 5 em 5 min nunca a listaram como
  alterada): o processo antigo estaria quebrado do mesmo jeito, e rollback não resolve.
- Efeito medido: 23:05:38–23:06:00Z, com o `parle-speech` ainda subindo, `POST /v1/audio/transcriptions` e
  `/v1/chat/completions` voltaram **503** em 12–81 ms. `/health?details=1`: os elos `openrouter:*` das três rotas em
  `no_key`; log de boot: `openrouterKey: invalid`, `openrouterRouting: disabled`.
- Conserto (dono): chave nova na conta da OpenRouter, gravada na API dev (`bun run sandbox:set` no babylon-cinema ou
  `PUT /v1/admin/keys`); o gateway relê em até 5 min, sem restart. Conferir: `/health?details=1` com os elos
  `openrouter:*` em `ready`.

## Passo a passo

0. **Pré-voo.** CI do `baea258`: `CI`, `CodeQL`, `AppSec Gates`, `aigw-edge image`, `speech-stack image` verdes; os dois
   `Deploy Docs` falham como já falhavam no `d43f108`. Os dois consertos da prova conferidos no código:
   `DEFAULT_EDGE_IMAGE = ghcr.io/marcosremar/aigw-edge:f66b6b80` (`src/deployments/cloud-init.ts`) e o serviço realtime
   lendo réplicas em dreno (`readyReplicas(dep, true)` em `src/realtime/service.ts`). Mudança pendente no ambiente
   Railway desde 02/10: criação de um serviço `ci-runner-…` com uma variável; `railway up` não a aplica e ela segue
   pendente, intocada. Imagem `ghcr.io/marcosremar/speech-stack:20261008-1317`: digest `sha256:3ff347aa…bf6de`
   conferido; a cópia no registro da Scaleway não dá para ler sem credencial (não conferida; subiu no passo 5b).
   **Produção estava em uso:** ver «Quem acorda a produção». Esperei 10 min sem pedido (22:41 → 22:51Z) antes de seguir.
1. **Backup.** O botão de backup do volume não está disponível pela API (`volumeInstanceBackupCreate`: `Not
   Authorized`; nenhum backup existente). Feito por `railway volume files download`: `deployments.json` (3 926 511
   bytes) e `apps.json` (3 537 bytes) de 22:53Z, JSON válido, guardados **fora do repositório**, na máquina do dono
   (modo 600; contêm segredos). Mais o export pela API (specs sem `env`/`files`, rotas do app, `/health`).
2. **Portão local** no worktree limpo: `tsc --noEmit` ok; `test:unit` 701 arquivos, 11 910 testes, 0 falha.
3. **Deploy:** `railway up --detach --service ai-gateway --project … --environment production` com a CLI logada como o
   dono (o token de workspace da API dev não serve na CLI: `Unauthorized`).
4. **Boot.** `deployments: no scaling block, running under the default mode` (`balanced`) para os quatro;
   `declared deployment registered` `parle-speech` → `applied`; as duas réplicas L4 que estavam de pé foram adotadas
   (mesmos ids), nenhuma máquina criada pelo boot; nenhuma linha `warn`/`error`. `/capacity` responde nos quatro.
5. **Fumaça.** Abaixo.
6. **Decisão:** fica no ar. Nada do que falhou é do código novo.
7. **Máquinas:** ver «Estado ao fim».

## Specs guardados, antes → depois

`envKeys` e a contagem de `files` idênticos nos quatro. Todas as diferenças:

| Deployment | Campo | Antes | Depois |
|---|---|---|---|
| `parle-speech` | `image` | `…/speech-stack:20261006-0107` | `…/speech-stack:20261008-1317` |
| | `placements` | — | `fr-par-1`; Vast `RTX 5090` ≤ €0,85/h, 1 réplica, imagem GHCR `20261008-1317` |
| | `scaling` | — | `fast` |
| | `realtime` | — | `{}` |
| `parle-qwen-tts`, `parle-speech-s2s`, `parle-livekit` | `scaling` | — | `balanced` |

Avisos novos na leitura: `coldStartWaitSeconds 840` acima do máximo de 240 s do gateway (`parle-speech`,
`parle-speech-s2s`); lugar Vast do `parle-speech` pulado (o registro tem `files`), como previsto.

`/capacity` depois dos boots: `parle-speech` L40S teto 4 sessões (`configured`), boot **496 s** (`measured`, 1);
`parle-qwen-tts` L4 boot 600 s (`default`) logo após o deploy.

Export antes (campos-chave, sem segredo):

```json
{"name": "parle-livekit", "status": "scaled-to-zero", "spec": {"provider": "scaleway", "machineType": "POP2-HC-48C-96G", "zone": "fr-par-1", "image": "", "placements": null, "scaling": null, "realtime": null, "minReplicas": 0, "maxReplicas": 1, "minActiveReplicas": 1, "targetInflightPerReplica": 4, "idleMinutes": 20, "idleAction": "stop", "bootTimeoutMinutes": 25, "coldStartWaitSeconds": 240, "maxEurPerHour": 3, "maxHours": 168, "paused": false, "bootScript": true, "envKeys": ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"], "files": 0}}
{"name": "parle-qwen-tts", "status": "ready", "spec": {"provider": "scaleway", "machineType": "L4-1-24G", "zone": "fr-par-2", "image": "", "placements": null, "scaling": null, "realtime": null, "minReplicas": 0, "maxReplicas": 2, "minActiveReplicas": 2, "targetInflightPerReplica": 4, "idleMinutes": 15, "idleAction": null, "bootTimeoutMinutes": 45, "coldStartWaitSeconds": 240, "maxEurPerHour": 1, "maxHours": 4, "paused": false, "bootScript": true, "envKeys": [], "files": 20}}
{"name": "parle-speech", "status": "scaled-to-zero", "spec": {"provider": "scaleway", "machineType": "L40S-1-48G", "zone": "fr-par-2", "image": "rg.fr-par.scw.cloud/aigw/speech-stack:20261006-0107", "placements": null, "scaling": null, "realtime": null, "minReplicas": 0, "maxReplicas": 2, "minActiveReplicas": 1, "targetInflightPerReplica": 8, "idleMinutes": 1, "idleAction": null, "bootTimeoutMinutes": 45, "coldStartWaitSeconds": 840, "maxEurPerHour": 1.6, "maxHours": 12, "paused": false, "bootScript": false, "envKeys": ["STT_BATCH", "LLM_PARALLEL", "TTS_STAGE0_MB", "TTS_PARALLEL"], "files": 9}}
{"name": "parle-speech-s2s", "status": "scaled-to-zero", "spec": {"provider": "scaleway", "machineType": "L4-1-24G", "zone": "fr-par-2", "image": "", "placements": null, "scaling": null, "realtime": null, "minReplicas": 0, "maxReplicas": 1, "minActiveReplicas": 1, "targetInflightPerReplica": 16, "idleMinutes": 20, "idleAction": null, "bootTimeoutMinutes": 60, "coldStartWaitSeconds": 840, "maxEurPerHour": 1, "maxHours": 3, "paused": false, "bootScript": true, "envKeys": ["HF_TOKEN", "SPEECH_TOKEN", "TRUST_UPSTREAM_AUTH", "HALT"], "files": 1}}
```

Depois:

```json
{"name": "parle-livekit", "status": "scaled-to-zero", "spec": {"provider": "scaleway", "machineType": "POP2-HC-48C-96G", "zone": "fr-par-1", "image": "", "placements": null, "scaling": {"mode": "balanced"}, "realtime": null, "minReplicas": 0, "maxReplicas": 1, "minActiveReplicas": 1, "targetInflightPerReplica": 4, "idleMinutes": 20, "idleAction": "stop", "bootTimeoutMinutes": 25, "coldStartWaitSeconds": 240, "maxEurPerHour": 3, "maxHours": 168, "paused": false, "bootScript": true, "envKeys": ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"], "files": 0}}
{"name": "parle-qwen-tts", "status": "ready", "spec": {"provider": "scaleway", "machineType": "L4-1-24G", "zone": "fr-par-2", "image": "", "placements": null, "scaling": {"mode": "balanced"}, "realtime": null, "minReplicas": 0, "maxReplicas": 2, "minActiveReplicas": 2, "targetInflightPerReplica": 4, "idleMinutes": 15, "idleAction": null, "bootTimeoutMinutes": 45, "coldStartWaitSeconds": 240, "maxEurPerHour": 1, "maxHours": 4, "paused": false, "bootScript": true, "envKeys": [], "files": 20}}
{"name": "parle-speech", "status": "scaled-to-zero", "spec": {"provider": "scaleway", "machineType": "L40S-1-48G", "zone": "fr-par-2", "image": "rg.fr-par.scw.cloud/aigw/speech-stack:20261008-1317", "placements": [{"zone": "fr-par-1"}, {"provider": "vast", "machineType": "RTX 5090", "maxEurPerHour": 0.85, "maxReplicas": 1, "image": "ghcr.io/marcosremar/speech-stack:20261008-1317"}], "scaling": {"mode": "fast"}, "realtime": {}, "minReplicas": 0, "maxReplicas": 2, "minActiveReplicas": 1, "targetInflightPerReplica": 8, "idleMinutes": 1, "idleAction": null, "bootTimeoutMinutes": 45, "coldStartWaitSeconds": 840, "maxEurPerHour": 1.6, "maxHours": 12, "paused": false, "bootScript": false, "envKeys": ["STT_BATCH", "LLM_PARALLEL", "TTS_STAGE0_MB", "TTS_PARALLEL"], "files": 9}}
{"name": "parle-speech-s2s", "status": "scaled-to-zero", "spec": {"provider": "scaleway", "machineType": "L4-1-24G", "zone": "fr-par-2", "image": "", "placements": null, "scaling": {"mode": "balanced"}, "realtime": null, "minReplicas": 0, "maxReplicas": 1, "minActiveReplicas": 1, "targetInflightPerReplica": 16, "idleMinutes": 20, "idleAction": null, "bootTimeoutMinutes": 60, "coldStartWaitSeconds": 840, "maxEurPerHour": 1, "maxHours": 3, "paused": false, "bootScript": true, "envKeys": ["HF_TOKEN", "SPEECH_TOKEN", "TRUST_UPSTREAM_AUTH", "HALT"], "files": 1}}
```

## Fumaça

**a. Voz clonada pelo alias da escola.** `POST /v1/audio/speech`, `model: parle-tts`, `voice: br-m-02`,
`language: pt`, `response_format: wav`, com as duas L4 adotadas e prontas: 200, `X-Gateway-Provider:
deployment:parle-qwen-tts`, primeiro byte 271 ms, total 1,53 s, WAV 24 kHz mono de 5,52 s (RMS 2218). A reserva
imediata não pôde ser vista (chave expirada). Boot frio sob o código novo aconteceu sozinho: às 23:02:18Z uma das L4
(33 min de vida) parou de responder, foi solta como `halted` em 20 s, a criação seguinte bateu na cota (a antiga ainda
existia), nova tentativa 75 s depois, pronta às 23:11:34Z, **`bootMs` 459 931**. Causa da parada: não investigada
(já acontecia com o código antigo, ver «Estado ao fim»).

**b. `parle-speech`.** `POST /v1/deployments/parle-speech/wake` 22:57:44Z → `ready` 23:06:00Z, **`bootMs` 495 513**
(L40S fr-par-2, imagem 1317, com os `files` e o `env` de produção). Harness `scripts/realtime-e2e/load.ts`, app
`sandbox`, 1 aluno, WS, uma sessão de 470 s, clipe de fala sintética local de 4,97 s, `--think 1-2`:

| | |
|---|---|
| Turnos | 28 na mesma sessão (passou do 26º), 0 falha de turno, 0 reconexão |
| Primeiro som (última amostra com voz → primeiro áudio) | p50 1277 · p95 1813 · max 2052 ms; 0 acima de 2500 |
| Edge | `ttfa` p50 398 / p95 435 ms; STT 206, LLM 133, TTS 369 ms |
| Conexão | WS 410 ms, admissão 215 ms |
| Erro | 1 turno (o 5º): `error upstream` 250 ms depois do `audio_start`, 560 ms de áudio; a sessão seguiu |
| «Truncados» do harness | mais 4 por razão áudio/caractere (72–77 ms contra o limiar de 77,9), todos com `audio_end` e `done` limpos, 7,8–8,7 s de áudio: variação de ritmo da voz, não corte |

A versão do edge não é exposta pelo gateway; a evidência de que é o `f66b6b80` é o padrão do código no ar e a sessão
ter passado do 26º turno com `LLM_SLOT_CTX` 2048. Veredito do harness `FAIL` só pelo critério de truncados (> 1 %).

**c. Orçamentos.** `APP_DAILY_REQUESTS` e `APP_DAILY_TOKENS` estão no serviço (nomes conferidos) e são lidos no
start. `appBudgets` em `/health?details=1` veio `[]`: só lista app não-admin com uso no dia, e desde o restart só a
chave `sandbox` (admin) chamou. **Valores não vistos na leitura.**

## Quem acorda a produção à noite

`userId: sandbox` (o `SANDBOX_TOKEN` como chave), do IP público desta máquina de desenvolvimento, `User-Agent`
`Bun/1.4.2` (ciclos STT → chat → voz a cada ~15 s pelos aliases `parle-*`) e um cliente sem `User-Agent` (STT a cada
2–3 s, `chat/completions` com 404). É uma sessão local de desenvolvimento usando o gateway de produção, não aluno.
Cada pedido com a GPU fria cria um L40S (21:23, 21:37, 22:15, 22:26Z) e as duas L4. Seguiu chamando depois do
deploy (23:14Z em diante).

## Estado ao fim

**Ficaram máquinas ligadas, e não por este deploy.** Às 23:44:47Z (30 min de espera depois da fumaça):
`parle-speech` 1 L40S `ready` (último pedido 23:44:46Z), `parle-qwen-tts` 1 L4 `ready` + 1 L4 `booting` (último pedido
23:44:31Z), €3,045/h; `parle-livekit` e `parle-speech-s2s` em zero. Quem as segura é a sessão local descrita acima,
que não parou de chamar; o escalonamento a zero depois da ociosidade (15 min na voz, ~8 min no `parle-speech`) **não
pôde ser observado**. Às 23:37:18Z a segunda L4 antiga (68 min de vida) também foi solta como `halted` e substituída;
o código antigo já registrava `halted` no `parle-qwen-tts` (08/10 15:26Z), então não é regressão. Gateway: `/health`
200, 50 min de pé, sem reinício.

Reaper (`ai-gateway-reaper`, sem `--apply`): última rodada lida 22:45:54Z, `{"gatewayUp":true,"seen":0,"released":[],"failed":[]}`.

Custo de máquina desta tarefa: o L40S de 22:57:45Z até o fim da fumaça às 23:14Z (~€0,40) e ~16 min a mais das duas
L4 (~€0,42); dali em diante quem as mantém é a outra sessão.

## Rollback

Painel do Railway → `ai-gateway` → Deployments → `b7f62dea-a18e-4f94-aa55-de781ab21457` → Rollback, ou:

```bash
git worktree add --detach /tmp/aigw-rollback bf909f7 && cd /tmp/aigw-rollback
railway up --detach --service ai-gateway --project 2213991a-748b-4576-8bd1-f45232f722e3 --environment production
```

Depois, devolver o registro (o código antigo não reconcilia): repor `deployments.json` do backup de 22:53Z com
`railway volume files upload` antes do deploy de volta, ou

```bash
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  https://parle-ai-gateway.up.railway.app/v1/deployments/parle-speech \
  -d '{"image":"rg.fr-par.scw.cloud/aigw/speech-stack:20261006-0107","placements":[]}'
```

## Antes da aula de segunda

1. **Chave nova da OpenRouter na API dev** e os elos `openrouter:*` em `ready`. Sem isso não há reserva.
2. Parar a sessão local que chama a produção com o `SANDBOX_TOKEN`, ou apontá-la para outro gateway.
3. Um pedido com a chave `parle` e ler `appBudgets` (limites 20 000 / 12 000 000).
4. Por que uma L4 do `parle-qwen-tts` parou sozinha aos 33 min (`halted`).
5. O erro `upstream` depois do `audio_start` (1 em 28 turnos).
6. Backup do volume pelo painel (a API recusou) e apagar a cópia local do estado quando não for mais precisa.
