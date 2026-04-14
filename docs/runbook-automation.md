# Runbook Automation

This document describes how to automate operational runbooks
using the AI Gateway CLI and API.

## Philosophy

Runbooks should be:
1. **Executable** — Not just docs, but actual scripts
2. **Testable** — Can be run in staging to verify correctness
3. **Versioned** — Stored in Git alongside code
4. **Self-documenting** — `--help` explains what the runbook does

---

## Automated Runbooks

### 1. GPU Health Check Runbook

**Manual steps replaced:**
1. SSH into GPU instance
2. Run `nvidia-smi`
3. Check memory usage
4. Check temperature
5. Verify service is responding

**Automated:**
```bash
# Single command replaces all manual steps
ai-gateway gpu health-check --all --format=json
```

**What it does:**
- Calls `probeGpuHealth()` for each GPU instance
- Checks SSH health if accessible
- Reports memory, temperature, utilization
- Returns non-zero exit code if any GPU unhealthy

**Implementation:** `src/autoscaler/health.ts`

---

### 2. Cost Audit Runbook

**Manual steps replaced:**
1. Check each provider billing dashboard
2. Sum up charges
3. Compare to budget
4. Alert if over budget

**Automated:**
```bash
# Generate cost report
ai-gateway cost-report --period=7d --format=markdown

# Alert if budget exceeded
ai-gateway cost-check --budget=50 --exit-on-exceed
```

**What it does:**
- Aggregates spend across all providers
- Compares to configured budget limits
- Sends alerts via configured channels (Slack/Discord)
- Generates report with breakdown by provider/user

**Implementation:** `src/alerting/cost-watcher.ts`

---

### 3. Incident Response Runbook

**Manual steps replaced:**
1. Check health endpoint
2. Check GPU status
3. Check provider health
4. Review recent logs
5. Restart if necessary

**Automated:**
```bash
# Incident assessment
ai-gateway incident-assess --verbose

# Auto-remediate (if safe)
ai-gateway incident-remediate --dry-run  # Preview
ai-gateway incident-remediate --execute  # Actually do it
```

**What it does:**
- Collects health status from all components
- Identifies root cause (GPU down? provider outage? memory leak?)
- Suggests remediation steps
- Can auto-execute safe remediations (restart, fallback to cloud)

**Implementation:** `src/proxy/routes/status.ts` + CLI commands

---

### 4. Deployment Runbook

**Manual steps replaced:**
1. Build new image
2. Push to registry
3. Deploy to staging
4. Run smoke tests
5. Deploy to production
6. Verify health

**Automated:**
```bash
# Full deployment pipeline
ai-gateway deploy --environment=staging --smoke-test
ai-gateway deploy --environment=production --promote-from=staging
```

**What it does:**
- Builds and pushes Docker image
- Deploys to target environment
- Runs smoke tests automatically
- Rolls back on health check failure
- Sends notification on success/failure

**Implementation:** CI/CD workflows (`.github/workflows/release.yml`)

---

### 5. Secrets Rotation Runbook

**Manual steps replaced:**
1. Generate new API key in provider console
2. Update env var in deployment
3. Restart service
4. Verify new key works
5. Delete old key

**Automated:**
```bash
# Rotate a specific provider key
ai-gateway rotate-key --provider=groq --dry-run
ai-gateway rotate-key --provider=groq --execute

# Rotate all keys
ai-gateway rotate-all-keys --dry-run
ai-gateway rotate-all-keys --execute
```

**What it does:**
- Generates new key (if provider API supports it)
- Updates secrets store
- Triggers graceful reload
- Verifies new key works
- Logs rotation event for audit

**Implementation:** `src/secrets-rotation/`

---

## Runbook Execution Framework

### Structure

Each runbook follows this pattern:

```typescript
interface Runbook {
  /** Human-readable name */
  name: string;
  /** What this runbook does */
  description: string;
  /** Prerequisites */
  prerequisites: string[];
  /** Steps to execute */
  steps: RunbookStep[];
  /** Whether this runbook is safe to auto-execute */
  safeToAutomate: boolean;
  /** Expected output */
  expectedOutput: string;
  /** Rollback steps if execution fails */
  rollback?: RunbookStep[];
}

interface RunbookStep {
  name: string;
  action: () => Promise<void>;
  onError?: (error: Error) => Promise<void>;
}
```

### Execution

```bash
# Preview what a runbook would do
ai-gateway runbook preview gpu-health-check

# Execute a runbook
ai-gateway runbook execute gpu-health-check --environment=production

# List available runbooks
ai-gateway runbook list
```

---

## Integration with Alerting

Runbooks are automatically triggered by alerts:

| Alert | Auto-Runbook | Manual Override |
|-------|-------------|-----------------|
| GPU health failure | `gpu-health-check` | `--no-auto` |
| Budget exceeded | `cost-audit` | `--skip-cost` |
| Memory leak | `memory-restart` | `--no-auto-restart` |
| Provider outage | `provider-failover` | `--keep-provider` |

---

## Testing Runbooks

Runbooks must be tested in staging before production use:

```bash
# Test a runbook in staging
ai-gateway runbook test gpu-health-check --environment=staging

# Verify rollback works
ai-gateway runbook test gpu-health-check --test-rollback
```

---

## Adding New Runbooks

1. Create `src/runbooks/<name>.ts`
2. Implement the `Runbook` interface
3. Register in `src/runbooks/index.ts`
4. Add CLI command in `bin/ai-gateway.ts`
5. Write tests in `__tests__/runbooks/<name>.test.ts`
6. Update this document
