# API de máquinas avulsas e plano de migração do palco (10/10/2026)

## O que entrou no gateway

`/v1/machines` e `/v1/jobs` (`src/machines/`), ao lado dos deployments, sobre as mesmas chaves de provedor
(Scaleway, Vast, RunPod). Referência das rotas e dos limites: [HTTP API § Machines and jobs](../api/http.md#machines-and-jobs);
funcionamento interno e o recolhedor: [Deployments § Machines](../deployments.md#machines-single-hosts-with-a-lease-src-machines).

| Pedido do dono | Onde |
|---|---|
| criar com tipo, provedor ou `cheapest`, preço máximo/h, imagem, disco, portas, SSH, prazo obrigatório, ociosidade | `POST /v1/machines` (`spec.ts`, `controller.ts`) |
| listar, ver, apagar, estender (e keepalive) | `GET /v1/machines[/:id]`, `DELETE /v1/machines/:id`, `POST /v1/machines/:id/extend` |
| dono e etiquetas | dono = usuário da chave ou `X-App`; `holder` = agente; etiquetas `aigw-machine`/`aigw-mns-<ns>`/`aigw-mid-<id>` (Scaleway), `aigw-m:<ns>:<id>` (Vast, RunPod) |
| estado persistido, atômico, `.bak` | `machines.json` por `state-file.ts` (o mesmo escritor dos deployments) |
| jobs em lote | `POST /v1/jobs`, `GET /v1/jobs[/:id]`, `/logs`, `DELETE`; a máquina baixa as entradas por link assinado, roda, sobe o resultado e avisa `POST /v1/job-report` |
| limites e 402 | prazo, vida máxima, ociosidade, preço/h, máquinas rodando, teto por app (24 h e mês), por agente (24 h) e global (24 h) |
| custo | `GET /v1/machines/costs` por dono, agente e máquina |
| recolhedor | `scripts/reap-orphans.ts` cobre as máquinas de todos os provedores, com o gateway caído ou de pé |

Não entrou (fica para quando o palco precisar): `stop`/`start` (estacionar pod RunPod), IP reservado por máquina,
Hyperstack/TensorDock/Daytona como provedores, o "equivalente" de outra zona do Scaleway. A espera de prontidão (CDP,
WebGL, banner SSH) continua sendo do chamador: o gateway diz `ip` e `ports`, quem usa prova que está pronto.

## Inventário do hub (o que aluga hoje por fora)

Só o Scaleway passa pela fachada `backend/compute`; Vast e RunPod são chamados pelos clientes HTTP do gateway
vendorizado, reexportados por `palco/hub/hub-compute.ts`. Os únicos lugares que alugam e apagam de fato são
`VastProvider` (`vast-provider.ts`), `RunpodLeaseProvider` (`runpod-provider.ts`) e `ScalewayPalcoCloudPlay`
(`palco-cloud-play-scaleway.ts`); `LeaseControl`, `VastWarmPool`, `GpuJobs` e `palco-cloud-play-hub.ts` usam essas classes.

## Quais chamadas mudam

| Hoje (hub) | Passa a ser |
|---|---|
| `VastProvider.create` / `acceptOffers` (pool Chrome: `-p 9223 -p 22`, `onstart` Chrome, teto US$ 0,20) | `POST /v1/machines` `{ provider: "vast", machineType, maxUsdPerHour: 0.2, image, diskGb: 40, ports: [{tcp,9223}], sshPublicKey, onstart, maxHours, idleMinutes, holder }` |
| `VastProvider.attach` (chave SSH depois do aluguel) | `sshPublicKey` no próprio `POST` |
| `VastProvider.status` / `list` / `destroy` | `GET /v1/machines/:id`, `GET /v1/machines`, `DELETE /v1/machines/:id` |
| `VastProvider.createJob` + `GpuJobs` (GVHMR: `boot.sh?key=`) | `POST /v1/jobs` `{ command, inputs: [links assinados do bucket], output: { url: PUT assinado } }`; `GpuJobs.sweep` some (o gateway libera no fim/erro/prazo) |
| `RunpodLeaseProvider.createFresh` / `tryCandidate` (`createPod`, `PUBLIC_KEY`, `dockerStartCmd`) | `POST /v1/machines` `{ provider: "runpod", machineType: <gpu id>, sshPublicKey, ports, onstart }` |
| `RunpodLeaseProvider.park` / `wake` (`stopPod`/`startPod`) | **sem rota ainda**: até o gateway ganhar `stop`/`start`, estacionar vira apagar e o pool quente RunPod passa a 0 |
| `ScalewayPalcoCloudPlay.create` / `destroy` / `list` (fachada `compute.rent`) | `POST /v1/machines` `{ provider: "scaleway", machineType: "L4-1-24G", onstart: <boot do cloud play>, ports: [porta do stream] }` / `DELETE` / `GET` |
| `palco-cloud-play-hub.ts` `rent` (Vast) | `POST /v1/machines` `{ provider: "vast", near, onstart: palcoCloudPlayBootScript(...) }` |
| `LeaseControl` renew (TTL 15 min) e o beat de 60 s do cloud play | `POST /v1/machines/:id/extend` (sem `hours` = keepalive; `idleMinutes: 15` faz o gateway apagar quem parou de renovar) |
| `FLEET_BUDGET` (US$ 10/24 h frota, US$ 6/agente) em `fleet-admission.ts` | chave do hub com `X-App: palco` e `holder: <agente>`; no gateway `MACHINES_OWNER_USD_PER_DAY=10`, `MACHINES_HOLDER_USD_PER_DAY=6`; o 402 do gateway sobe como o 402 `FLEET_BUDGET` de hoje |
| `qa_machine_runs` (`machine-ledger.ts`) | fica como espelho, alimentado por `GET /v1/machines/costs` e pelas respostas; o livro de verdade passa a ser o gateway |
| reapers do hub (`reapOrphans`, `reapUnleased`, `reapPalcoCloudPlay`, `GpuJobs.sweep`) | o loop do gateway (prazo, ociosidade, órfã) e o recolhedor externo; o hub só fecha as próprias sessões |
| `supply-health.ts` (crédito Vast direto), `palco-cloud-play-scaleway.ts:inventory` (volumes direto) | leituras; trocar por `GET /health?details=1` do gateway (`providerCredit`) e remover o inventário de volumes |

## Ordem

1. **Gateway em produção**: deploy desta PR, `MACHINES_USERS=palco` (ou chave admin do hub), `AIGW_PUBLIC_URL`,
   `RUNPOD_API_KEY` no serviço e no recolhedor, tetos acima. Prova: uma máquina CPU Scaleway pequena criada e apagada por
   `curl`, um job de 1 min que sobe um arquivo, e o recolhedor em `--dry-run` mostrando `machines` no relatório.
2. **Jobs GPU (GVHMR)**: o menor e mais isolado. `gpu-jobs.ts` chama `POST /v1/jobs`; sai `VastProvider.createJob`.
3. **Cloud play**: `palco-cloud-play-hub.ts` e `palco-cloud-play-scaleway.ts` pedem máquina ao gateway (Vast e
   Scaleway); some o uso da fachada `backend/compute` no cloud play.
4. **Pool Chrome Vast**: `VastProvider` vira um cliente fino de `/v1/machines`, mantendo a interface
   (`ResourceProvider`/`VastApi`) para `LeaseControl` e `VastWarmPool` não mudarem; `attach` sai.
5. **RunPod**: `RunpodLeaseProvider` sobre `/v1/machines`; estacionar desliga (pool quente 0) até existir `stop`/`start`
   no gateway, que é a próxima mudança do gateway se o tempo de boot pesar.
6. **Limpeza**: `hub-compute.ts`, a cópia do gateway na imagem (`deploy/school/palco-stage.ts`), `backend/compute/*`
   e por fim o submódulo `vendor/ai-gateway`; chaves de provedor saem do serviço `palco`.

## Como a lista de exceções encolhe

`test/architecture/_machines-via-gateway-baseline.json` (babylon-cinema), por passo:

| Passo | Entradas que caem |
|---|---|
| 2 | `palco/hub/gpu-jobs.ts` (provider-key 1); `palco/hub/server.ts` (machine-module 1, o `VastProvider` dos jobs) |
| 3 | `palco/hub/palco-cloud-play-hub.ts` (machine-module 3, provider-key 2), `palco-cloud-play-routes.ts` (1), `palco-cloud-play-scaleway.ts` (provider-api 1) |
| 4 | `palco/hub/vast-provider.ts` (2), `palco/hub/lease-routes.ts` (machine-module 1, provider-key 2), `palco/hub/fleet-routes.ts` (2) |
| 5 | `palco/hub/runpod-provider.ts` (2), `palco/hub/runpod-policy.ts` (1) |
| 6 | `palco/hub/hub-compute.ts` (gateway-lib 5, machine-module 1), `deploy/school/palco-stage.ts` (gateway-lib 3, machine-module 2), `backend/compute/ai-gateway-backend.ts` (gateway-lib 1, provider-key 5), `backend/compute/compute.ts` (2); `supply-health.ts`, `device-test.ts`, `boot-config.ts`, `palco/shared/*` (revisar: chaves que deixam de existir no hub) |

Cada passo é uma PR no babylon-cinema que roda `bun run baselines:update` (a lista só aperta) e atualiza
`docs/compute.md` § Andamento. Ao fim do passo 6, a regra «toda GPU ou VM pelo ai-gateway publicado» vale sem exceção
no hub.
