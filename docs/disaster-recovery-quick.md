# Disaster Recovery Runbook — Quick Reference

## Critical Scenarios

| Scenario | Detection | Response | Recovery Time |
|----------|-----------|----------|---------------|
| Gateway crash | Health check fails | Auto-restart | <1 min |
| GPU outage | GPU health fails | Fallback to cloud | <5 min |
| API key leak | Audit log alert | Rotate keys | <10 min |
| DB corruption | Query failures | Restore backup | <15 min |
| Memory leak | Heap > 1GB | Restart + GC | <2 min |
| Cost runaway | Budget exceeded | Stop GPUs | <1 min |

## Emergency Commands

```bash
# Check health
curl http://localhost:4000/health

# Restart gateway
bun run serve.ts

# Stop all GPUs
ai-gateway gpu stop --all

# Rotate keys
ai-gateway rotate-key --provider=groq

# Check costs
ai-gateway cost-report

# Restore from backup
ai-gateway db restore --latest
```

## Contact

| Role | Contact | When |
|------|---------|------|
| On-call | PagerDuty | SEV-1/2 |
| Engineering lead | @marcosremar | SEV-1, 30min no response |
| Provider support | Provider status pages | Provider outage |
