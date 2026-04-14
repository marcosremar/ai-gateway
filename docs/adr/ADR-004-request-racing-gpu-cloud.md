# ADR-004: Request Racing — GPU + Cloud in Parallel

**Status:** Accepted
**Date:** 2024-04-05
**Deciders:** Marcos

## Context

We have both self-hosted GPU inference and cloud API providers (Groq, OpenAI, Fireworks). GPU offers better cost at scale but has cold-start latency. Cloud is always-ready but more expensive. We want the best of both worlds.

## Decision

Race GPU vs cloud providers **in parallel** for each pipeline stage. The first successful result wins; losers are cancelled via `AbortController`.

```typescript
// From src/autoscaler/hybrid-stages.ts
async function raceProviders(
  gpuCandidate: () => Promise<Result>,
  cloudCandidates: (() => Promise<Result>)[],
  options: { gpuTimeoutMs: number; cloudTimeoutMs: number }
): Promise<Result> {
  // GPU and cloud fire simultaneously
  // Fastest wins, losers cancelled via AbortController
}
```

**Default timeouts:**
- GPU: adaptive (based on warmth), 60s cold, 8s warm
- Cloud: 8s (Groq is fast, OpenAI moderate)

## Reasoning

### Why race instead of fallback?
- **Fallback** means waiting for GPU timeout before trying cloud
- **Race** means no waiting — GPU fires, cloud fires simultaneously
- P95 latency improves significantly because we don't wait for GPU cold start

### Why AbortController?
- Clean cancellation ofloser requests
- No wasted compute on cancelled work
- Proper cleanup of resources

### Why GPU + Modal + Cloud?
- GPU is primary (cheapest at scale)
- Modal is tier-2 fallback (always-on, no cold start)
- Cloud is final fallback (most expensive, most reliable)

### Headstart calculation
GPU with lower EWMA latency gets a headstart in the race:

```typescript
const headstartMs = Math.max(0,
  (cloudEwmaLatency - gpuEwmaLatency) * 0.3 // 30% of latency difference
);
```

This accounts for GPU cold-start overhead while leveraging GPU warmth data.

## Per-Stage Racing

Each stage races independently:

```
STT race: [GPU_WHISPER] vs [GROQ] vs [OPENAI] vs [DEEPGRAM] vs [FIREWORKS]
LLM race: [GPU_Gemma] vs [GROQ_LLAMA] vs [OPENAI_GPT4] vs [FIREWORKS]
TTS race: [GPU_MOSS] vs [MODAL_CLONE] vs [GROQ_PLAYAI] vs [OPENAI_TTS]
```

## Consequences

- **Positive:** P95 latency ~200ms better than fallback approach
- **Positive:** Cost optimization (GPU at scale, cloud for spikes)
- **Positive:** Resilience (if GPU fails, cloud succeeds)
- **Negative:** Wasted compute on cancelled requests (minimal)
- **Negative:** Complexity in timeout management
- **Negative:** Cloud costs can spike if GPU is consistently unhealthy

## Monitoring

- `request_race_winners_total{winner="gpu|modal|cloud"}`
- `request_race_latency_ms{provider="..."}`
- `request_race_aborts_total`

## Notes

- For TTS with voice clone: forces hybrid GPU path (cloud TTS can't do clone)
- Canary deployments use race to validate new GPU before full traffic switch
