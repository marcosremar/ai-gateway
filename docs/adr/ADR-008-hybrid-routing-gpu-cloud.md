# ADR-008: Hybrid Routing — GPU and Cloud as Transports

**Status:** Accepted
**Date:** 2024-08-15
**Deciders:** Marcos

## Context

We have self-hosted GPU inference and cloud API providers. They are fundamentally different in cost, latency, and reliability profiles. We need a unified routing layer that abstracts the transport layer.

## Decision

Treat **GPU and cloud as transports**, not different domains:

```typescript
// From src/autoscaler/hybrid-stages.ts
interface ProviderTransport {
  name: string;
  type: 'gpu' | 'cloud' | 'modal';
  
  // Unified interface
  infer(stage: Stage, input: Input): Promise<Output>;
  health(): Promise<boolean>;
  latency(): Promise<number>;
  cost(): Promise<number>;
}

// Registry of transports
const transports: Record<string, ProviderTransport> = {
  'gpu-runpod': gpuTransport,
  'gpu-vast': gpuTransport,
  'cloud-groq': cloudTransport,
  'cloud-openai': cloudTransport,
};
```

**Routing decision logic:**
```typescript
function selectTransport(stage: Stage, options: RoutingOptions): ProviderTransport {
  if (gpuReady(stage) && !gpuInCircuitBreak(stage) && isCostEffective(stage)) {
    return race(gpuTransport, cloudTransport); // race
  }
  return cloudTransport; // fallback
}
```

## Reasoning

### Why GPU and cloud are the same domain?
- Both perform inference
- Both have latency, cost, reliability tradeoffs
- Abstracting them enables transparent fallback
- Caller doesn't need to know where inference happens

### Why race instead of preference?
- GPU is cheaper at scale but has cold start
- Cloud is always-ready but more expensive
- Racing gets the best of both: GPU speed when ready, cloud reliability otherwise

### Why not always use GPU?
- Cold start latency can be 2-5 minutes
- GPU might be unhealthy or in circuit break
- Cloud needed for canary validation anyway

## Cost Optimization

```typescript
// GPU is cost-effective when:
// 1. Warm (no cold-start penalty)
// 2. Not sharing with other workloads
// 3. Electricity cost < cloud API cost for same throughput

// Break-even calculation:
const gpuCostPerRequest = (gpuCostPerHour / 3600) * avgRequestDuration;
const cloudCostPerRequest = provider.apiCostPerToken * avgTokensPerRequest;
```

## Canary Deployment

New GPU versions go through canary before full traffic:

```typescript
// 5% traffic to new GPU, 95% to current
// Monitor error rate for 10 minutes
// If error rate < 1% → promote to 100%
// If error rate > 5% → rollback
```

## Consequences

- **Positive:** Transparent to callers — don't know or care where inference happens
- **Positive:** Cost optimization — GPU when cost-effective, cloud when needed
- **Positive:** Reliability — automatic fallback when GPU fails
- **Negative:** Complexity in race coordination
- **Negative:** Cost monitoring needed to prevent bill shock

## Monitoring

- `routing_decisions_total{reason="warmth|cost|health|manual"}`
- `transport_latency_ms{transport="gpu|cloud",provider="..."}`
- `transport_cost_usd{provider="..."}`
- `canary_traffic_ratio`
- `canary_error_rate`
