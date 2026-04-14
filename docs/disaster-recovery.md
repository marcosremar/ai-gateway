# Disaster Recovery Runbook

This document describes recovery procedures for AI Gateway infrastructure.

## Severity Levels

| Level | Description | Response Time | Escalation |
|-------|-------------|---------------|------------|
| SEV-1 | Complete outage | 15 min | On-call → Engineering Lead |
| SEV-2 | Degraded service | 1 hour | On-call |
| SEV-3 | Minor issue | 4 hours | Next business day |

---

## Scenario 1: Gateway Server Crash

### Symptoms
- `/health` returns 503 or no response
- All requests fail

### Recovery Steps

```bash
# 1. Check if process is running
fly status  # or your deployment platform

# 2. Restart the machine
fly machines restart <machine-id>

# 3. Verify health
curl https://ai-gateway.fly.dev/health

# 4. Check logs for root cause
fly logs --app parle-ai-gateway | tail -100
```

### Prevention
- Enable auto-restart in deployment config
- Set up health check alerts
- Monitor process memory (restart if >1GB)

---

## Scenario 2: GPU Provider Outage

### Symptoms
- GPU boot failures across all tiers
- `GPU_BOOT_ERROR` in logs
- All requests falling back to cloud

### Recovery Steps

```bash
# 1. Check provider status
ai-gateway gpu status
ai-gateway gpu offers  # Check if GPUs are available

# 2. Switch to cloud-only mode temporarily
# Set PROVIDER_FORCE_CLOUD=true in env
# This bypasses GPU and uses cloud providers directly

# 3. Check provider status page
# RunPod: https://status.runpod.io
# Vast.ai: https://vast.ai/status
# Modal: https://modal.com/status

# 4. If provider is down, wait for recovery
# GPU autoscaler will retry when provider is back
```

### Prevention
- Multiple GPU providers configured (RunPod + Vast.ai + Modal)
- Cloud fallback always available (Groq, OpenAI)
- Monitor provider status pages

---

## Scenario 3: API Key Compromise

### Symptoms
- Unexpected charges on provider accounts
- Unknown API keys in vault
- Audit log shows unauthorized access

### Recovery Steps

```bash
# 1. Rotate ALL API keys immediately
# Groq: https://console.groq.com/keys
# OpenAI: https://platform.openai.com/api-keys
# RunPod: https://www.runpod.io/console/user/settings

# 2. Update gateway secrets
fly secrets set GROQ_API_KEY=new_key OPENAI_API_KEY=new_key

# 3. Restart gateway to pick up new keys
fly machines restart <machine-id>

# 4. Audit access
# Check vault file: ~/.babelcast/vault.json
# Check audit log: ~/.babelcast/audit.jsonl
cat ~/.babelcast/audit.jsonl | grep "AUTH_FAILURE"
```

### Prevention
- Use separate keys for dev/staging/prod
- Enable key rotation alerts
- Monitor provider billing dashboards
- Use RBAC to limit key permissions

---

## Scenario 4: Database Corruption

### Symptoms
- State persistence failures
- Cooldowns not saved
- GPU state lost

### Recovery Steps

```bash
# 1. Check database status
fly postgres status <db-name>

# 2. Restore from backup
fly postgres restore <db-name> --from <backup-id>

# 3. Verify state
ai-gateway gpu status

# 4. Rebuild state if necessary
ai-gateway gpu reconcile
```

### Prevention
- Regular automated backups
- Test restore procedures monthly
- Monitor database health

---

## Scenario 5: Memory Leak

### Symptoms
- Memory usage grows continuously
- Eventually OOM kill
- Response times degrade

### Recovery Steps

```bash
# 1. Check memory usage
curl http://localhost:4000/v1/services

# 2. Take heap snapshot for analysis
curl http://localhost:4000/debug/heap

# 3. Force restart (temporary fix)
fly machines restart <machine-id>

# 4. Enable GC on idle (preventive)
# Set GC_ON_IDLE=true in env

# 5. Analyze heap snapshot
# Use Chrome DevTools → Memory → Load heap snapshot
# Look for large arrays, maps, unclosed connections
```

### Prevention
- Monitor memory trends in Grafana
- Set memory alert at 512MB
- Enable GC on idle in production
- Regular load testing to catch leaks early

---

## Scenario 6: Cost Runaway

### Symptoms
- Unexpected high charges
- Budget exceeded
- Too many GPU instances running

### Recovery Steps

```bash
# 1. Stop all GPU instances immediately
ai-gateway gpu list  # List all active
ai-gateway gpu stop --all  # Stop all

# 2. Check charges
# RunPod: https://www.runpod.io/console/user/billing
# Vast.ai: https://console.vast.ai/billing

# 3. Investigate root cause
# Check audit log for deploy events
cat ~/.babelcast/audit.jsonl | grep "GPU_DEPLOY"

# 4. Tighten budget limits
fly secrets set DAILY_BUDGET_USD=25  # Lower limit

# 5. Review autoscaler config
# Ensure IDLE_TIMEOUT_MIN is set (default: 15)
# Ensure IDLE_DESTROY_HOURS is set (default: 2)
```

### Prevention
- Set hard budget caps
- Enable budget alerts at 80%
- Review costs daily
- Use cheaper GPU tiers first

---

## Contact Information

| Role | Contact | When to Escalate |
|------|---------|------------------|
| On-call engineer | PagerDuty #ai-gateway | SEV-1/2 |
| Engineering lead | Slack @marcosremar | SEV-1, no response in 30min |
| Provider support | Provider status pages | Provider outage |
