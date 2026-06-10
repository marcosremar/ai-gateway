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
