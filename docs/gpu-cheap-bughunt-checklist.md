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

## Commands

Use only gateway-safe commands:

```bash
ai-gateway gpu offers
ai-gateway gpu deploy --max-cost-usd 0.10
ai-gateway gpu wait --timeout 600
ai-gateway gpu dev exec 'curl -s localhost:8000/health'
```
