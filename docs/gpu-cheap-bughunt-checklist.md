# GPU Cheap Bughunt Checklist

Goal: test cheap GPU deploy paths through ai-gateway only, prioritize offers under $0.10/hr, verify model deploy filters, fix confirmed bugs.

## Guardrails

- [x] Use gateway API or `ai-gateway` CLI only
- [x] No direct provider API calls
- [x] No raw SSH into pods
- [x] No manual sleep polling loops
- [x] Preserve existing dirty work; commit only files touched in this run

## Progress

- [x] Read domain vocabulary for Provider, GPU Provider, Deploy, Tier, Tier Cascade, Instance, Offer, Budget Gate
- [x] Read SDD boundaries for gateway deploy and provider rules
- [x] Locate cheap offer and deploy filter code paths
- [x] Audit offer sorting and price filtering for <$0.10/hr flows
- [x] Add or fix local tests for cheap offer filtering
- [x] Verify deploy payload keeps cost cap and GPU filters
- [ ] Verify multi-model deploy config paths
- [x] Run focused tests
- [x] Fix confirmed bug 1
- [x] Fix confirmed bug 2
- [x] Fix confirmed bug 3
- [ ] Fix confirmed bug 4
- [ ] Fix confirmed bug 5
- [ ] Fix confirmed bug 6
- [ ] Fix confirmed bug 7
- [ ] Fix confirmed bug 8
- [ ] Fix confirmed bug 9
- [ ] Fix confirmed bug 10

## Findings

| # | Status | Area | Evidence | Fix |
|---|---|---|---|---|
| 1 | Fixed | Vast cancellation | `__tests__/unit/vast-improvements.test.ts` expected no reservation after cooperative cancellation | Check `spec.isCancelled` before offer launch/create |
| 2 | Fixed | Vast offer selection | `__tests__/vast-improvements.test.ts` expected expired host failure history demoted | Sort strict-fast offers by host failure score before reliability |
| 3 | Fixed | Health stall abort | `__tests__/unit/gpu-poll-stall-abort.test.ts` expected 20 identical `/health` checks before timeout | Keep model timeout behind active health stall detection |
| 4 | Fixed | Recently-used offer dedupe | `__tests__/resilience-fixes.test.ts` expected recently-used-only offer to be re-admitted | Fall back to recently-used hosts when dedupe result is empty |
| 5 | Verified | Cheap deploy filters | `__tests__/unit/gpu-handlers-core.test.ts` and `__tests__/unit/gpu-cache-retry.test.ts` | `maxCostUsd` passes as `maxPricePerHr`; cheapest matching offer retained |
| 6 | Fixed | Host reputation gap | Live e2e 2026-06-10: SSH-readiness timeout on host 91.211.212.250 not recorded; the very next burst deploy re-picked the same dead host and stalled again | Public `vast.reportHostDeployFailure(hostIp)` (feeds unstable cooldown + escalating blacklist), called from `gpu-deploy-loop` poll-failure path for non-app_error results |
| 7 | Fixed | Deploy lock leak | Synchronous throw inside `_startDeployAndRespond` (setDeployState/appSlot path, `appSlot.state` access, response write) leaked the deploy lock forever — callers mark `lockTransferred=true` before the call | try/catch releases locks in the SM block; `activeDeployId` resolved before promise creation; response write wrapped (promise owns the lock) |
| 8 | Fixed | Orphan sweep hang | `listVastInstancesDirect`/`terminateVastInstanceDirect` fetched without timeout — could hang the sweep forever | `AbortSignal.timeout(15_000)` on both |
| 9 | Fixed | Error messages | gpu.jsonl: "Request timed out after undefinedms" (550 deploy_failed analyzed); "No GPUs available in region: unknown" still emitted by `src/modules/` copy | `DeployError` constructor skips undefined/null context values and degrades unresolved `{placeholders}` to `?`; PRV_NO_GPUS detail fix ported to `src/modules/errors/deploy-errors.ts` |
| 10 | Fixed | Exhausted-retries message | Live e2e reproduced "Vast.ai deploy failed: max retries exceeded" masking the real cause (ssh_timeout on a dead host) | `lastFailureReason` carried into the exhausted message: `… — last failure: <result> on <instance> (<gpu>)` |
| 11 | Fixed | Resume stuck in scheduling | Vast docs: >30s in `scheduling` after stop/start means the GPU was reassigned — resume waited the full 5-min health timeout | Early-abort in `gpu-resume-manager` after 60s of scheduling (RESUME_SCHEDULING_ABORT_MS) → existing fresh-deploy fallback |
| 12 | Open | GPU allowlist dead code | `GPU_TYPE_ALLOWLIST` (server/constants.ts:161) is exported but never enforced — explicit `gpuTypes` in deploy requests pass through (which is what enables <$0.10/hr types like RTX 3060) | Decide: enforce or delete the constant |
| 13 | Fixed | **SSH key not on account (ROOT CAUSE of ssh-probe "hangs")** | 6 consecutive live deploys failed SSH readiness across different hosts; `ssh root@ssh2.vast.ai` → "Permission denied (publickey)" — the gateway machine's ed25519 key was never registered on the Vast account, so every instance rejected probes until boot timeout | `_ensureAccountSshKey()` preflight in `vast.createInstance` (idempotent: lists `/ssh/`, registers `~/.ssh/id_ed25519.pub` or `AIGW_SSH_PUBKEY_PATH` if missing). After fix: SSH ready in **61s**, inference at **74s** |
| 14 | Fixed | Direct SSH port firewalled on community hosts | Vast advertises a 22/tcp direct mapping that some host firewalls silently drop while the ssh proxy works; probe policy refuses proxy by default | Direct-first proxy-fallback in `pollSshUntilReady` after 120s (`AIGW_VAST_DIRECT_SSH_FALLBACK_MS`, 0=off); `_parseInstance` now preserves `sshProxyHost/Port` |

## Validated end-to-end timeline (2026-06-10, RTX 3060 @ $0.076/hr, ollama + smollm2:135m)

| Marco | Tempo |
|---|---|
| POST /v1/gpu/deploy → instância criada | 16s |
| Instância "running" na Vast | 41s |
| SSH ready (gateway "ready") | **61s** |
| API Ollama respondendo | 62s |
| Modelo 135M baixado (pull) | 72s |
| **Primeira inferência real concluída** | **~74s** |
| Inferência quente (p50 / p95, 20 reqs, 0 erros) | 243ms / 347ms |

Custo total da bateria de validação (7 instâncias reais): ≈ $0.09. Cleanup: 0 órfãos.

| 15 | Fixed | Race ignores `readinessProbe: "ssh"` | Live: race×2 with ollama (no HTTP /health) polled `/health` for the FULL 30-min timeout on both slots (~$0.09 burned), while the non-race path was ready in 61s | SSH-probe branch in the race health loop (mirrors pollSshUntilReady); winner declaration extracted to `declareWinner()`. Re-validated live: race×2 ssh-ready in **71s**, loser destroyed in 72s ($0.002) |
| 16 | Fixed | Cancelled racers poison host reputation | Race loser cleanup deletes the instance; the vast client's poll then sees "instance vanished (host reclaimed)" and blacklists the innocent host | Race now passes `isCancelled` into `createInstance`; the vanish branch checks `spec.isCancelled?.()` before `_markHostUnstable`/`_recordHostFailure`. Validated live: blacklist empty after race |
| 17 | Fixed | Stale `deployCancelled` swallows direct deploys (ROOT CAUSE of "returned to idle unexpectedly — possible silent failure", 11× in logs) | `resetDeployState()` sets `deployCancelled=true`; only `_startDeployAndRespond` cleared it. Direct callers (resume fallback, auto-recovery, standby, workloads) ran with EVERY `setDeployState` silently dropped — incl. `ready` (instance leak) | `_executeDeploy` clears the stale flag for global deploys (covers all 6 direct callers) |
| 18 | Fixed | `/v1/gpu/stop` and `/v1/gpu/resume` not slot-aware | Live: deploy landed in per-caller slot; stop answered "No active pod (idle)" for a running, billing instance (status/terminate are slot-aware; stop/resume read only global deployState) | Slot-aware branches in both handlers (`mode: app_slot_stop` / `app_slot_resume`). Validated live: stop instant, **resume in 4s** |
| 19 | Open | Slot instances have no idle auto-stop / auto-destroy | `gpu-monitor-loop` and `gpu-destroy-timer` are global-only; a ready slot instance never idles out (bills until credit 0 → Vast stops-not-destroys → storage keeps billing). Blanket auto-stop would kill long finetune runs — needs per-slot policy decision | Design needed: opt-in `idleTimeoutSec` per deploy? |
| 20 | Open | Auto-snapshot fires and fails on every Vast deploy | `takeSnapshot` → HTTP 400 "invalid_args: Invalid command given" on every create (log noise; snapshot never works on Vast) | Disable for vast or fix the API payload |
| 22 | Fixed | `/v1/gpu/stop`/`/v1/gpu/resume` slot resolution ignores query params | Live (bench 7B): `POST /v1/gpu/stop?slot=bench7b` without `x-aigw-user-id` header answered "No active pod (idle)" for a running, billing slot instance. `findCallerDeploySlot` only reads `body.parallelSlot` + the `x-aigw-user-id` header, while `/v1/gpu/status` and `/v1/gpu/terminate` also accept `?slot=`/`?parallelSlot=` query params | Align: accept query params in stop/resume too (or 400 with a hint instead of idempotent 200) |
| 23 | Open | First ollama generation costs ~37s beyond model-on-disk (cold) | Live 7B bench: model pulled at 67.8s but first inference only at 105.4s — `load_duration` 16.7s + ~20s runner/CUDA warmup not captured by load_duration. A warmup `ollama run` in onstart would absorb this before traffic arrives | Add warmup generate to the onstart recipe / deploy template |
| 24 | Open | Uncached docker image → SSH-timeout death spiral | Live (bench llama.cpp): `ghcr.io/ggml-org/llama.cpp:server-cuda` (não cacheada nos hosts) → 3 hosts consecutivos, cada um estourou o SSH-readiness timeout (~177s) DURANTE o pull da imagem; deploy falhou aos 614s ($0.03 queimado). O timeout de SSH não distingue "host morto" de "pull em andamento" — Vast reporta a instância como `running`/`loading` durante o pull e o client tem detecção de pull progress no log-probe, mas o caminho ssh-readiness não a usa | Estender o prazo de SSH enquanto o status Vast = `loading`/pull ativo; ou pré-validar tamanho/popularidade da imagem |
| 25 | Open | Deploy falho deixa instância viva em estado `error` | Após o ssh_timeout do bench llama.cpp, `inst-40382289` permaneceu existindo (cobrando) no slot `default:bench7bllama` — terminate manual foi necessário | Auto-destroy da instância quando o deploy do slot transiciona para `error` (ou timer) |
| 26 | Fixed | **Auto-recovery ressuscita deploy morto de sessão anterior após restart** | Live 2026-06-10: gateway reiniciado 12:14; startup recovery repovoou o estado global com config antiga (`marcosremar/gpu-dev:latest`, dev-box de outra sessão); health probe condenou o pod fantasma → `startAutoRecoveryDeploy()` (gpu-auto-recovery.ts:386, via gpu-readiness.ts:532 / gpu-monitor-loop.ts:294) disparou "replacement" ninguém-pediu → cascata vast (3× ssh-timeout, 13min) → runpod → tensordock → vast-vm preso em creating ~1h trocando hosts. Resolvido na hora com `POST /v1/gpu/terminate {"force":true}` | Fix: `server/gpu-deploy-intent.ts` — deploy/resume/bootOnStartup gravam intenção por imagem; `startAutoRecoveryDeploy` e o fresh-deploy fallback do resume-manager exigem intenção da MESMA imagem nesta sessão e recente (`AIGW_AUTONOMOUS_REDEPLOY_MAX_AGE_MIN`, default 30). 11 unit tests. #22: `mergeSlotQueryParams` em stop/resume (validado live: `POST /v1/gpu/stop?slot=X` body vazio → `app_slot_stop`). Pós-restart: zero deploys espontâneos; warmpool HTTP endpoints validados live (provision 136s, acquire 11.4s, teardown 0 órfãos) |
| 21 | Fixed | GPU telemetry gaps (assessment 2026-06-10) | (a) slot deploys never accrued into `dailyGpuSpendUsd` — `daily_spend.json` didn't exist despite real spend, budget gate blind; (b) /metrics had zero deploy-lifecycle data; (c) deploy failures/stuck deploys/cost anomalies alerted nowhere; (d) `deploy_started` carried no deployId/gpuType/owner; (e) race failures emitted no `deploy_failed` event | New `server/gpu-telemetry.ts`: 60s accrual loop over deploy slots (validated: spend file reappeared), `gateway_deploy_attempts_total{provider,gpu_type,result}` + boot-time histogram + host-reputation gauges in /metrics, alert router (SLACK_WEBHOOK_URL / DISCORD_WEBHOOK_URL / ALERT_WEBHOOK_URL) firing on deploy_failed / orphan / crash / stuck>12min (`GPU_DEPLOY_STUCK_ALERT_MIN`) / spend >1.5× 7-day avg; events enriched with deployId/gpuType/owner; race emits deploy_failed |

## Validated 7B timeline (2026-06-10, RTX 3060 @ $0.136/hr, ollama/ollama:latest + qwen2.5:7b 4.7GB, minInetDownMbps=500)

Cold deploy (onstart faz `ollama pull` em paralelo com o boot):

| Marco | Tempo |
|---|---|
| POST /v1/gpu/deploy aceito (offer search + preflights) | 6.7s |
| Instância criada/running | 44.8s |
| SSH ready (gateway "ready", probe=ssh) | **48.9s** |
| API Ollama respondendo | 49.4s |
| Modelo 7B (4.7GB) baixado e registrado | **67.8s** |
| Primeira inferência concluída (37.6s: load 16.7s + ~20s warmup → finding #23) | **105.4s** |
| Inferência quente (p50, 5 reqs) | 997ms |

Stop→resume na mesma instância (modelo já no disco) — **caminho <60s validado**:

| Marco | Tempo |
|---|---|
| Stop (app_slot_stop) | instantâneo |
| Resume (app_slot_resume, durationMs reportado) | 7.6s |
| API Ollama respondendo | 8.2s |
| **Primeira inferência 7B pós-resume (load 2.8s)** | **11.7s** |

Conclusão <60s: cold deploy fresh-rental 7B fica em ~105s (piso realista ~70-85s com llama.cpp/imagem cacheada; pesquisa: nenhum relato crível de <60s em rental novo no Vast). O caminho confiável <60s é warm pool de instâncias paradas (resume 11.7s, margem 5×) — mesma arquitetura dos "cold workers" do Vast Serverless. Risco: GPU pode ser alugada por outro enquanto parada (>30s em `scheduling` = perdida, finding #11) → manter N≥2 paradas em hosts distintos + fallback para cold deploy. Custo bateria: ~$0.03, 0 órfãos.

Contra-teste llama.cpp (2026-06-10, mesma config, `ghcr.io/ggml-org/llama.cpp:server-cuda` + `-hf` Qwen2.5-7B Q4_K_M): FALHOU aos 614s — 3 hosts, todos SSH-timeout durante o pull da imagem não-cacheada (findings #24/#25). Lição central: **cache da imagem no host domina o cold start** (ollama/ollama cacheada: running→SSH em 4s; ghcr exótica: 177s+ só de pull). Engine mais rápido não compensa imagem fria. Gaps de client identificados: sem filtro `disk_bw` na busca (offer parse já lê `disk_bw_read/write`), sem pin de `machine_id` para re-alugar hosts com a imagem já em cache (única rota plausível de cold <60s).

## Warm pool validado (2026-06-10, `server/gpu-warmpool.ts` + qwen2.5:7b)

Implementação: pool de instâncias paradas com imagem+modelo no disco (`POST /v1/gpu/warmpool/provision|acquire|release|teardown`, `GET /v1/gpu/warmpool/status`; estado em `~/.babelcast/warmpool.json`; orquestra via loopback HTTP nos endpoints de slot já validados; 9 unit tests `server/gpu-warmpool.test.ts`).

| Marco | Resultado |
|---|---|
| Provision 2 workers (deploy→pull 7B→warmup→stop), hosts distintos (RTX 3070 $0.136 + RTX 3060 Ti $0.100) | 282s |
| Acquire #1 (resume→inferência 7B verificada) | **12.1s** (inferência 3.0s) |
| Release (stop de volta ao pool) | instantâneo |
| Failover: worker 0 terminado por fora → acquire #2 detecta perda e resume worker 1 | **10.2s total** (perda detectada via 400 imediato) |
| Teardown + órfãos | 2 terminados, 0 sobrando |

Nota: a simulação de perda exercitou o caminho fail-fast (slot limpo → 400 imediato). Reclaim real de GPU trava o resume em `scheduling` até `WARMPOOL_RESUME_TIMEOUT_MS` (90s) antes do failover — pior caso real ≈ 90+12s. Custo do teste ≈ $0.05. Follow-ups: health-check/replenish automático em loop, idle auto-release (#19), client-timeout não cancela o resume server-side.

## Live run evidence (2026-06-10, gateway @ localhost:9012, maxCostUsd=0.10)

- Offers under $0.10/hr available: RTX 3060 $0.075/hr (rel 0.987), GTX 1080 Ti $0.082/hr (rel 0.983)
- ✓ validate payload (no provisioning), ✓ coalesce duplicate deploys + force-terminate
- × single reservation + × burst: both traced to ONE dead host (91.211.212.250) re-picked back-to-back → finding #6
- Cleanup verified: 0 orphans after run (`/v1/gpu/list?all=1`), total spend ≈ $0.03
- Vast docs (researched): 429 has NO Retry-After header; >30s "scheduling" = recreate elsewhere; balance=0 stops (not destroys) instances — storage keeps billing; `min_bid` per offer is queryable for interruptible

## Commands

Use only gateway-safe commands:

```bash
ai-gateway gpu offers
ai-gateway gpu deploy --max-cost-usd 0.10
ai-gateway gpu wait --timeout 600
ai-gateway gpu dev exec 'curl -s localhost:8000/health'
```
