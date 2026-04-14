# ADR-009: Provider Cooldown Tracking with Exponential Backoff

**Status:** Accepted
**Date:** 2024-09-01
**Deciders:** Marcos

## Context

When a provider (RunPod, Vast.ai, etc.) fails repeatedly, we need to stop using it temporarily. But we also need to recover quickly when the provider becomes healthy again.

## Decision

Implement **exponential backoff with auto-blacklist**:

```typescript
// From server/gpu-deploy-tiers.ts
interface CooldownEntry {
  provider: ProviderName;
  failureCount: number;
  cooldownUntil: number;  // Unix timestamp
  reason: 'rate_limit' | 'billing' | 'health' | 'deploy_failed';
}

// Base cooldown: 60 seconds
// Exponential: base * 2^(failCount-1), capped at 15 minutes
// Auto-blacklist: 5+ failures in 1 hour → 1 hour cooldown
```

**Cooldown reasons:**
- `rate_limit`: 429 response from provider
- `billing`: Insufficient funds
- `health`: Health checks consistently failing
- `deploy_failed`: Deployment failures

## State Transitions

```
Provider healthy → Failure → 60s cooldown
                → 2nd failure → 120s cooldown
                → 3rd failure → 240s cooldown
                → 5th failure in 1h → 1h cooldown (blacklist)
                
Cooldown expires → Half-open (allow one attempt)
                → Success → Clear cooldown, reset failure count
                → Failure → Back to cooldown
```

## Persistence

Cooldowns persist to `~/.babelcast/cooldowns.json`:

```json
{
  "runpod": {
    "failureCount": 3,
    "cooldownUntil": 1699999999999,
    "reason": "rate_limit",
    "lastAttempt": 1699999900000
  }
}
```

Survives server restarts.

## Provider Selection with Cooldowns

```typescript
// From server/gpu-deploy-tiers.ts
async function selectProvider(cascade: ProviderName[]): Promise<ProviderName | null> {
  const available = cascade.filter(p => !isInCooldown(p));
  if (available.length === 0) {
    return pickEarliestExpiry(cascade); // Allow even if in cooldown
  }
  return available[0]; // First non-cooldown provider
}
```

## Reasoning

### Why exponential backoff?
- Prevents hammering a failing provider
- Gives provider time to recover
- Exponential growth prevents persistent failures

### Why base of 60s?
- 5 minutes was too slow for retry loops
- 60s is aggressive enough for fast recovery
- 15-minute cap prevents excessive wait

### Why auto-blacklist?
- 5+ failures in 1 hour indicates systemic issue
- 1-hour cooldown gives time for manual intervention
- Billing failures get automatic 1-hour block

### Why pickEarliestExpiry when all in cooldown?
- At least try the one closest to recovery
- Better than no deployment attempt

## Alternatives Considered

### Fixed cooldown (no exponential)
- Too slow to recover when issue resolves quickly
- Too fast to recover from sustained issues
- Rejected

### Manual blacklist only
- Requires human intervention
- Too slow for automated operations
- Rejected

## Consequences

- **Positive:** Automatic recovery when provider heals
- **Positive:** Prevents billing waste on failing providers
- **Positive:** Exponential backoff prevents thrashing
- **Negative:** Can still deploy to partially-recovered provider
- **Negative:** Need monitoring to detect systematic issues

## Monitoring

- `provider_cooldown_active{provider="..."}`
- `provider_cooldown_duration_seconds{reason="..."}`
- `provider_failure_total{provider="...",reason="..."}`
- `provider_recovery_total{provider="..."}`
