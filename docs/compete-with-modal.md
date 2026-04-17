# Plano: Como competir com Modal.com em cold-start e custo

> **Status**: em execução — Fases A e B em paralelo
> **Contexto**: análise feita em 2026-04-17 após levantamento completo do código atual + pesquisa do estado da arte.
> **Meta**: cold-start p50 **30-60s → 3-8s** (snapshot path), waste de idle/race **~$65k/ano → ~$15k/ano**.

---

## Por que isso importa

Hoje o cold-start end-to-end oscila entre **2-15 minutos** dependendo do tier/imagem/modelo. Dominado por:

1. **Image pull** (60-600s) — imagens de 20-52GB. Timeouts adaptativos existem em `pull-time-estimator.ts` mas **não persistem** entre restarts.
2. **Container boot** (300-900s) — Python + CUDA + PyTorch init.
3. **Model download+load** (600-1800s) — sequencial, sem parallelism real entre STT/LLM/TTS.
4. **Health check** (10-60s) — polling fixo de 10s durante todo o ciclo.

Waste estimado hoje: idle agressivo de 15min após ready (~$32k/ano) + race losers mantidos em billing durante boot (~$20k/ano) + retries em hosts lentos (~$13k/ano).

## Como Modal consegue <2s

Três primitivas, todas **open-source** ou padrão NVIDIA:

- **`cuda-checkpoint`** (driver NVIDIA 570+): dumpa VRAM + kernels + CUDA graphs do processo vivo.
- **CRIUgpu** (upstream CRIU 4.0, 2025): integra `cuda-checkpoint` como plugin CRIU. Totalmente transparente (sem API interception, diferente de Cedana).
- **FUSE image streaming**: image pull lazy, com prefetch agressivo. (Não é o maior win pra nós — pré-bake já venceu lazy-load no nosso bench.)

**Ativo subutilizado que já temos**: CRIU/GPU VRAM checkpoint já foi validado (`memory/project_criu_benchmark.md` — dump 4.3s, restore 3.6s, VRAM intacta, driver 565). ADR-005 já define a policy. **Falta a implementação real do fluxo snapshot→restore no deploy lifecycle.** Esse é o maior gap.

---

## Fase A — Quick wins (1-2 semanas, sem mudança arquitetural)

**Alvo:** -30% cold-start médio, -$25k/ano em waste, **zero risco** (mudanças locais nas funções existentes).

### A1. Persistir `pull-time-estimator` histórico
**Por quê:** hoje `pullHistory[]` vive em memória (500 records max em `pull-time-estimator.ts:67`) e se perde em todo restart. Primeiros deploys pós-restart usam timeout conservador 2× multiplier.
**Como:** dump debounced (10s) em `~/.babelcast/pull-history.json`, segue exatamente o padrão de `cooldowns.json` (ADR-009). Load no startup.
**Arquivo:** `src/gpu-providers/pull-time-estimator.ts` + novo helper em `server/config-persistence.ts`.

### A2. Reordenar tiers por P50 latência observada
**Por quê:** tier cascade hoje é fixo (RunPod → Vast → TensorDock → Modal) baseado em custo. Se RunPod está 30% mais lento que Vast por 24h, ainda tenta RunPod primeiro.
**Como:** manter EWMA de `pullMs + bootMs + modelLoadMs` por provider (janela de 7 dias). Reordenar tiers em runtime por P50, respeitando custo como desempate. Não mexer no cooldown (ADR-009).
**Arquivo:** `server/gpu-deploy-tiers.ts` + novo `server/tier-ranking.ts`.

### A3. Idle timeout: 15 → 5 min + `stop` ao invés de `destroy`
**Por quê:** `IDLE_TIMEOUT_MS=15min` em `server/gpu-idle-logic.ts:67` é a maior fonte de waste (~$32k/ano). Resume de pod stopped é 10× mais rápido que deploy novo.
**Como:**
- Reduzir `IDLE_TIMEOUT_MS` para 5 min.
- Em vez de terminate, chamar `stopInstance()` (já existe em RunPod/TensorDock providers).
- Destroy só depois de 2h stopped (já existe como auto-destroy, só mover a trigger).
**Arquivo:** `server/gpu-idle-logic.ts` + `server/config.ts`.

### A4. Adaptive health polling
**Por quê:** `HEALTH_POLL_INTERVAL_MS=10s` em `gpu-poll-health.ts` significa até 10s de latência pra detectar ready. 6 req/min × 45min = 270 HTTP calls por deploy, overhead desnecessário pós-ready.
**Como:** 2s durante fase boot+model-load, 30s após primeiro ready signal. Detectar a fase pelo campo `services.*_ready` no payload `/health`.
**Arquivo:** `server/gpu-poll-health.ts`.

### A5. `runc` → `crun` nos Dockerfiles
**Por quê:** `crun` (C impl, API-compatível) é ~2× mais rápido que `runc` no container startup. Drop-in.
**Como:** adicionar `RUN apt install -y crun` e `--runtime=crun` no entrypoint. Não precisa mudar código do gateway.
**Arquivo:** `dockers/babelcast-subtitle/Dockerfile` + outras images que a gente controla.
**Risco:** RunPod/Vast.ai podem não expor flag de runtime — validar antes.

### A6. Parallelizar downloads STT+LLM+TTS
**Por quê:** hoje o container baixa modelos sequencialmente. Com hf_xet já em uso (+24% vs legacy), paralelizar 3 modelos dá outra redução significativa.
**Como:** no entrypoint Python do container, lançar 3 threads para `snapshot_download()` em paralelo. hf_xet já suporta concorrência interna; o ganho aqui é sobrepor wait I/O entre 3 repos HF distintos.
**Arquivo:** `dockers/babelcast-subtitle/entrypoint.py` (ou equivalente).
**Cuidado:** encoder-decoder (Whisper) quebra com fastsafetensors — manter safetensors normal (já é a nossa prática).

### Tests obrigatórios
- Test A1: matar processo, restart, verificar que `pull-history.json` é carregado e próximo pull usa histórico.
- Test A2: injetar latências fake, verificar que tier order muda.
- Test A3: idle timeout dispara stop (não terminate) em 5min.
- Test A6: entrypoint inicia 3 downloads em paralelo, tempo total ≤ max(downloads) + 10% overhead.

---

## Fase B — CRIUgpu production-wire (4-6 semanas)

**Alvo:** cold-start **30-60s → 3-8s** no snapshot path, destravando tier gratuito-de-facto (snapshot storage é barato comparado a GPU live).

### Provider constraints (revisado 2026-04-17)

CRIUgpu exige **driver NVIDIA 570+** E **CAP_CHECKPOINT_RESTORE ou CAP_SYS_ADMIN** E **CAP_SYS_PTRACE**. Após pesquisa técnica:

| Provider | Snapshot viável? | Motivo |
|---|---|---|
| **Vast.ai VM (KVM mode)** | ✓ | Root total, custom kernel, instala driver 570 |
| **Hyperstack (H100 VMs)** | ✓ | Driver 570.195.03 default, root, VM |
| **CoreWeave CKS** | ✓ | Privileged pods + driver 570+ configurável (enterprise) |
| Lambda Labs | ✓ mas sem 4090 | Só H100+ |
| RunPod (Community/Secure) | ✗ | Não expõe `--privileged` nem `--cap-add` |
| Vast.ai containers | ✗ | Strippa CAP_SYS_ADMIN (cap bound a80425fb) |
| TensorDock | ✗ (hoje) | Driver default velho (525-535); VM permite upgrade mas instabilidade |
| Modal | ✗ | Fechado, usa CRIU internamente mas não expõe |

**Decisão:** snapshot path usa **Vast.ai VM mode** (primário — custo baixo, já temos API keys) + **Hyperstack** (secundário — H100 com driver 570 confirmado). RunPod continua como provider principal do **cold path normal** (beneficia de Fase A). TensorDock sai do snapshot path. Hyperstack é integração nova.

**Correção ADR-005:** "SnapGPU" não existe como serviço. Referência deve ser substituída por "cuda-checkpoint + CRIU 4.0+" (CRIUgpu). Ficará num ADR-014 de correção.

### B1. Snapshot capture automático pós-first-ready
**Por quê:** ADR-005 já define a policy, mas o código real de capture não está wireado no deploy lifecycle. Hoje só temos o flag/decision tree.
**Como:**
- No `gpu-poll-health.ts`, após detectar `allServicesLoaded === true` pela primeira vez, disparar `captureSnapshot(deployId)` async (não bloquear response).
- Nova função em `server/gpu-snapshot.ts` (novo) que:
  1. SSH no pod
  2. `sudo criu dump --tree $PID --images-dir /snapshot --leave-running` (modo non-destructive)
  3. tar + upload para R2 em `snapshots/{provider}/{imageHash}/{modelHash}.tar.zst`
  4. Registrar em `~/.babelcast/snapshot-catalog.json`
- Usar driver pinning: só capturar se `nvidia-smi` reporta driver 570+.
**Dependência:** imagens Docker precisam ter `criu` instalado (adicionar em `dockers/*/Dockerfile`).

### B2. Snapshot restore no boot path
**Por quê:** sem isso o capture é só overhead.
**Como:**
- Em `gpu-deploy.ts`, após `createInstance()` retornar, checar `snapshot-catalog.json` por match exato `{imageHash, modelHash, providerFamily, driverMajor}`.
- Se match e `age < 7 days` (ADR-005): SSH no pod novo, download snapshot de R2, `criu restore --images-dir /snapshot`.
- Health check imediato — pula todo o ciclo de pull+boot+model-load.
- Se restore falhar: fallback transparente ao cold path normal. Registrar falha para auto-disable (ADR-005 já cobre isso).

### B3. Storage: R2 para snapshots (não weights)
**Por quê:** snapshots são 500MB-2GB por checkpoint. R2 é perfeito para isso — barato, cold egress não é problema (um restore por deploy). **Não confundir com weights**: R2 é ruim para 4GB+ de modelos servidos a pods (já sabemos — memória `feedback_r2_slow_for_bulk_downloads.md`).
**Como:** novo bucket `ai-gateway-snapshots`. Adapter já existe no gateway (S3-compatible).

### B4. Standby pool (1-2 por profile ativo)
**Por quê:** mesmo com snapshot restore em 5s, primeiro deploy ainda paga o restore. Pool standby elimina esse 5s para requests latency-critical.
**Como:**
- Novo `server/standby-pool.ts`.
- Config por profile ativo: `{ profile: 'babelcast', minStandby: 1, maxStandby: 2 }`.
- Standby pods rodam com modelos loaded mas handling só `/health` (sem tráfego real). **Não é idle** — está loaded, é o snapshot-restored process rodando.
- Billing real: ~$0.20-0.44/h/standby em RunPod spot. Com demanda moderada, cobre o custo em 1 request salva.
**Decisão aberta:** pool em qual tier? Recomendo tier 1 (RunPod spot) para começar, medir, expandir.

### B5. `fastsafetensors` na stage LLM
**Por quê:** 4.8-7.5× mais rápido que safetensors padrão em Llama 7B/13B/70B (paper CLOUD 2025, arxiv 2505.23072). Open-source, IBM, em uso em produção.
**Como:** wrapper `coldstart.load_with_fastsafetensors()` no container LLM, com fallback automático para safetensors padrão se encoder-decoder detectado (Whisper, T5). Dessa forma Whisper continua safe (memória existente confirma que fastsafetensors quebra para encoder-decoder).
**Arquivo:** `dockers/babelcast-subtitle/llm-loader.py` (novo) + requirements.

### B6. Driver pinning + Hyperstack provider integration
**Por quê:** CRIUgpu exige driver 570+. Sem pinning, snapshot capture falha silenciosamente. E precisamos de um provider VM-first para o snapshot path.
**Como:**
- Filtrar offers em `autoSelectCheapestGpu()` para `driver_version >= 570` quando snapshot-eligible.
- **Vast.ai VM mode**: usar `runtype: 'vm'` e validar na offer que o host expõe KVM. Documentar seleção de hosts.
- **Novo provider Hyperstack**: adicionar `src/gpu-providers/hyperstack.ts` com client API. Driver 570.195.03 default confirmado em H100 PCIe VMs. Integrar ao tier cascade.
- Desabilitar tier TensorDock para snapshot-eligible deploys (driver default velho).

### Tests obrigatórios
- Test B1: deploy completa, snapshot é capturado, aparece em catalog.json dentro de 60s pós-ready.
- Test B2: segundo deploy mesma config → restore path, cold-start < 10s.
- Test B2-fallback: corromper snapshot no R2, verificar fallback transparente ao cold path.
- Test B4: standby pool mantém N pods ready, request real usa pod do pool, pool reabastece.
- Test B5: LLM load com fastsafetensors, fallback para Whisper usa safetensors normal.
- E2E benchmark: cold-start p50 e p95 antes/depois em RunPod spot RTX 4090. Commitar números no `insights/`.

---

## O que explicitamente **não** vamos fazer agora

Essas ideias apareceram na pesquisa mas foram descartadas para este escopo:

- **Nydus/Stargz lazy image pull** — nosso benchmark mostra pré-bake ganhando (+24% vs lazy no Vast.ai, +63% vs lazy-load variant). Microsoft também publicou que lazy sem prefetch_all piora LLM cold-start. Manter pré-bake.
- **Dragonfly P2P** — só faz sentido com fleet multi-node na mesma região. Hoje é single-pod-per-deploy. Revisitar se chegar a multi-tenant.
- **Run:ai Model Streamer** (S3→GPU DMA) — ganho é secundário enquanto pré-bake estiver em uso. Reavaliar se/quando decidir parar de pré-bake.
- **SkyPilot** — substitui nosso `startDeployWithTiers`. Opção válida, mas é refactor grande e perde tunabilidade. Só considerar se cascade virar fardo de manutenção.
- **TensorRT-LLM** — 28min de compile por engine. Só vale TCO para workloads fixos de altíssimo volume. Não é nosso perfil.

## O que vai para ADRs depois

Essas decisões merecem formalização após implementação:

- **ADR-010**: persistência de `pull-time-estimator` + tier ranking dinâmico (cobre A1+A2).
- **ADR-011**: idle policy — stop vs destroy, timeouts (cobre A3).
- **ADR-012**: snapshot lifecycle end-to-end (cobre B1+B2+B3) — substitui ADR-005 quando implementado.
- **ADR-013**: standby pool policy (cobre B4).

## Tracking

- Fase A: worktree `agent-phase-a`, owner = Claude
- Fase B: worktree `agent-phase-b`, owner = Claude
- Merge para `main` só depois de: tests passando + benchmark real em RunPod spot + revisão humana.
