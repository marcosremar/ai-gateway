# Environment Promotion Guide

This document describes how to promote code through environments: Dev → Staging → Production.

## Environments

| Environment | Purpose | URL | Deploy Command |
|-------------|---------|-----|----------------|
| Development | Local testing | localhost:4000 | `bun run dev` |
| Staging | Integration testing | staging.ai-gateway.dev | `fly deploy --app ai-gateway-staging` |
| Production | Live traffic | ai-gateway.fly.dev | `fly deploy --app ai-gateway-production` |

## Promotion Workflow

```
PR → Main → Staging → Production
```

### Step 1: Merge to Main

```bash
# PR is reviewed and merged
git checkout main
git pull
```

### Step 2: Deploy to Staging

```bash
# Deploy to staging
fly deploy --app ai-gateway-staging

# Run smoke tests
curl -s https://staging.ai-gateway.dev/health | jq .
bun run test:integration --env=staging

# Run performance tests
bun run test:performance --env=staging
```

### Step 3: Verify Staging

- [ ] Health check passes
- [ ] All integration tests pass
- [ ] Performance within SLO (p95 < 5s)
- [ ] No error rate spike (< 1%)
- [ ] GPU autoscaler functional

### Step 4: Promote to Production

```bash
# Deploy to production
fly deploy --app ai-gateway-production

# Monitor rollout
fly logs --app ai-gateway-production

# Verify production
curl -s https://ai-gateway.fly.dev/health | jq .
```

### Step 5: Monitor Production

- [ ] Health check passes for 5 minutes
- [ ] Error rate < 1%
- [ ] Latency p95 < 5s
- [ ] GPU instances healthy
- [ ] No budget alerts

## Rollback Procedure

If production deployment fails:

```bash
# Rollback to previous version
fly deploy --app ai-gateway-production --image <previous-image>

# Verify rollback
curl -s https://ai-gateway.fly.dev/health | jq .
```

## Automated Promotion (CI/CD)

For automated promotion, use GitHub Actions:

```yaml
# .github/workflows/promote.yml
name: Promote to Production

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to promote'
        required: true

jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to Production
        run: fly deploy --app ai-gateway-production
```

## Environment Variables

| Variable | Dev | Staging | Production |
|----------|-----|---------|------------|
| `NODE_ENV` | development | staging | production |
| `GROQ_API_KEY` | dev key | staging key | prod key |
| `RATE_LIMIT_RPM` | 0 (disabled) | 100 | 1000 |
| `LOG_LEVEL` | debug | info | warn |
| `PROFILE` | 1 | 0 | 0 |

## Testing Strategy

| Test Type | Dev | Staging | Production |
|-----------|-----|---------|------------|
| Unit Tests | ✅ | ✅ | ✅ |
| Integration Tests | ✅ | ✅ | ❌ |
| Performance Tests | ✅ | ✅ | ❌ |
| Load Tests | ✅ | ✅ | ❌ |
| Smoke Tests | ✅ | ✅ | ✅ |
| Chaos Tests | ✅ | ❌ | ❌ |
