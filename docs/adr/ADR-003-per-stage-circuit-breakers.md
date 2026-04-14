# ADR-003: Per-Stage Circuit Breakers

**Status:** Accepted
**Date:** 2024-03-10
**Deciders:** Marcos

## Context

The AI pipeline has three independent stages: STT, LLM, and TTS. A failure or slowdown in one stage should not cascade to others. Additionally, we need to handle both actual failures AND predictive failures based on latency trends.

## Decision

Implement **per-stage circuit breakers** with three states: `closed → open → half-open`

```typescript
// From src/autoscaler/circuit-breaker.ts
type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreaker {
  stage: 'stt' | 'llm' | 'tts';
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
  recoveryTimeoutMs: number; // 30s default
}
```

**Trigger conditions for opening:**
- 3 consecutive failures (configurable per tier)
- Success rate below 95% over rolling window
- Predictive failure score > 0.7 (latency trend analysis)

## Reasoning

### Why per-stage?
- STT failure ≠ LLM failure
- TTS being slow doesn't mean STT is broken
- Independent circuits allow partial degradation (STT fails → LLM still works → serve from cache)

### Why adaptive thresholds?
- Tier 1 (production) is more reliable → higher tolerance (up to 5 failures)
- Tier 0 (bootstrapping) is less reliable → lower tolerance (as low as 1)
- Prevents false positives on cold-start flakiness

### Why predictive opening?
- Latency trends often predict failures before they happen
- A GPU with 20% latency increase is likely to fail soon
- Opening proactively prevents cascading failures

## State Transitions

```
CLOSED → OPEN (3 consecutive failures OR success rate < 95% OR predictive > 0.7)
OPEN → HALF_OPEN (after recoveryTimeoutMs = 30s)
HALF_OPEN → CLOSED (1 successful request)
HALF_OPEN → OPEN (failure in half-open state)
```

## Persistence

Circuit state is persisted to `StateStore` — survives server restarts:

```typescript
// From circuit-breaker.ts
await stateStore.set(`circuit:${stage}`, {
  state: 'open',
  failureCount: 3,
  lastFailureTime: Date.now()
});
```

## Alternatives Considered

### Global circuit breaker
- Single failure would block entire pipeline
- Doesn't reflect independent stage behavior
- Rejected

### No predictive opening
- Only opens on actual failures
- More conservative but slower to respond
- We chose predictive for faster degradation detection

## Consequences

- **Positive:** Prevents cascading failures across stages
- **Positive:** Predictive opening reduces P95 latency during degradation events
- **Positive:** Adaptive thresholds reduce false positives
- **Negative:** Complexity in configuration and monitoring
- **Negative:** Recovery timeout requires tuning per deployment

## Monitoring

Exposed metrics:
- `circuit_breaker_state{stage="stt|llm|tts"}` (1=closed, 2=open, 3=half-open)
- `circuit_breaker_failures_total{stage="..."}`
- `circuit_breaker_recovery_total{stage="..."}`
