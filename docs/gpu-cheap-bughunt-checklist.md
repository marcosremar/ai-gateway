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
- [ ] Audit offer sorting and price filtering for <$0.10/hr flows
- [ ] Add or fix local tests for cheap offer filtering
- [ ] Verify deploy payload keeps cost cap and GPU filters
- [ ] Verify multi-model deploy config paths
- [ ] Run focused tests
- [ ] Fix confirmed bug 1
- [ ] Fix confirmed bug 2
- [ ] Fix confirmed bug 3
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
| 1 | Open | Offer filters | Pending audit | Pending |

## Commands

Use only gateway-safe commands:

```bash
ai-gateway gpu offers
ai-gateway gpu deploy --max-cost-usd 0.10
ai-gateway gpu wait --timeout 600
ai-gateway gpu dev exec 'curl -s localhost:8000/health'
```
