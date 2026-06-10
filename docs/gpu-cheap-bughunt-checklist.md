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
