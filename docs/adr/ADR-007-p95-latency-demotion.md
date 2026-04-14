# ADR-007: P95 Latency Demotion with Consecutive Breach Requirement

**Status:** Accepted
**Date:** 2024-07-20
**Deciders:** Marcos

## Context

GPU latency can spike due to shared GPU contention, thermal throttling, or network issues. We need to demote a GPU from "production" to "bootstrapping" when it's degraded. But we must avoid thrashing on transient spikes.

## Decision

Require **3 consecutive P95 breaches** before demoting a GPU:

```typescript
// From server/gpu-monitor-loop.ts
const P95_DEMOTION_CONSECUTIVE_VIOLATIONS = 3;

// Latency trend prediction: detect degradation slope before P95 threshold is hit
const TREND_WINDOW = 5;
const LATENCY_INCREASE_THRESHOLD = 0.2; // 20%+ increase
```

**Demotion flow:**
1. Track P95 latency per stage (STT, LLM, TTS) over rolling window
2. If P95 > threshold × multiplier for 3 consecutive monitor cycles → demote
3. Demotion triggers re-benchmark and canary evaluation

## Latency Tracking

```typescript
// From server/latency-tracker.ts
interface LatencySample {
  timestamp: number;
  latencyMs: number;
  stage: 'stt' | 'llm' | 'tts';
}

// 20-sample rolling window per stage
// P95 computed via nearest-rank method
```

## Reasoning

### Why 3 consecutive violations?
- **Single spike:** Network hiccup, temporary load — ignore
- **3 consecutive:** Likely persistent degradation — demote
- **More than 3:** Would be too slow to respond

### Why P95 instead of average?
- P95 is robust to outliers (single slow requests don't affect it)
- Better reflects user-experienced latency
- Industry standard for latency SLOs

### Why also check latency trend?
- Catches degradation before P95 threshold is hit
- 20% increase over last 5 samples triggers warning
- Proactive demotion before users are impacted

## Monitoring Thresholds

```typescript
// From server/constants.ts
const LATENCY_TARGETS = {
  stt: { p50: 500, p95: 1000 },   // ms
  llm: { p50: 800, p95: 2000 },
  tts: { p50: 300, p95: 800 }
};

// P95 demotion multiplier: demote if P95 > target × 1.5
const P95_DEMOTION_MULTIPLIER = 1.5;
```

## Recovery

After demotion:
1. GPU enters "bootstrapping" mode
2. Small percentage of traffic continues (canary)
3. If canary succeeds for N minutes → promote back to production
4. If canary fails → stay in bootstrapping or terminate

## Alternatives Considered

### Immediate demotion on first breach
- Too aggressive, thrashes on transient spikes
- Rejected

### 5+ consecutive breaches
- More stable but too slow to respond
- Rejected

### Average latency only
- Average is sensitive to outliers
- Doesn't reflect P95 user experience
- Rejected

## Consequences

- **Positive:** Stable production — ignores transient spikes
- **Positive:** Proactive detection via trend analysis
- **Positive:** Graceful recovery via canary
- **Negative:** Slower to respond to sudden degradation
- **Negative:** Configuration complexity (thresholds, multipliers)

## Monitoring

- `gpu_latency_p95_ms{stage="..."}`
- `gpu_latency_violations_total{stage="...",type="consecutive|trend"}`
- `gpu_demotion_total{reason="p95|trend|health"}`
- `gpu_recovery_total`
