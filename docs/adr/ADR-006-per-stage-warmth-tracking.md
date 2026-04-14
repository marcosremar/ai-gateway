# ADR-006: Per-Stage Warmth Tracking

**Status:** Accepted
**Date:** 2024-06-01
**Deciders:** Marcos

## Context

GPU stages (STT, LLM, TTS) have different warm-up times. We need to track when each stage is "warm" (loaded and ready) vs "cold" (needs initialization) to set appropriate timeouts and make routing decisions.

## Decision

Track **per-stage warmth** with cold-start profiles:

```typescript
// From src/autoscaler/state.ts
interface WarmthState {
  stt: 'cold' | 'warm';
  llm: 'cold' | 'warm';
  tts: 'cold' | 'warm';
}

interface ColdStartProfile {
  gpuType: string;
  dockerImage: string;
  provider: string;
  coldTtfbMs: number;      // Time to first byte cold
  warmTtfbAvgMs: number;   // Time to first byte warm
  sampleCount: number;
}
```

**Warmth gates:**
- STT warm: Whisper model loaded, ready for inference
- LLM warm: Gemma/llama model loaded, KV cache initialized
- TTS warm: MOSS-TTS model loaded, voice ready

## Warmth Detection

```typescript
// From server/gpu-warmth-monitor.ts
async function checkStageWarmth(endpoint: string, stage: 'stt' | 'llm' | 'tts'): Promise<boolean> {
  // Probes /health endpoint and checks warmth indicators
  // STT: checks whisper_ready flag
  // LLM: checks model_loaded + kv_cache_ready
  // TTS: checks tts_model_loaded
}
```

## Adaptive Timeouts

Based on warmth, timeouts adapt:

| Stage | Cold Timeout | Warm Timeout |
|-------|-------------|--------------|
| STT | 60s | 8s |
| LLM | 120s | 10s |
| TTS | 30s | 5s |

## Staged Boot

Stages boot sequentially to minimize total time:

```
1. STT warm → start LLM boot
2. LLM warm → start TTS boot
3. All warm → mark GPU "ready for production"
```

This is managed by `startBackgroundWarmthMonitor()` which polls readiness in stages.

## Reasoning

### Why per-stage?
- STT (Whisper) boots in ~10s
- LLM (Gemma 7B) boots in ~30s
- TTS (MOSS) boots in ~15s
- Sequential boot (STT → LLM → TTS) is faster than parallel (all at once) due to VRAM constraints

### Why cold-start profiles?
- Different GPU types have different boot times
- RTX 5090 is faster than A6000
- Profiles enable accurate timeout prediction

### Why warmth tracking gates pipeline?
- Prevents requests from hitting cold stages
- Enables intelligent fallback (cold LLM → cloud LLM)
- Tracks when to capture snapshots

## Consequences

- **Positive:** Accurate timeout prediction per GPU type
- **Positive:** Staged boot minimizes total boot time
- **Positive:** Intelligent routing based on actual readiness
- **Negative:** Additional complexity in warmth detection
- **Negative:** Warmth state needs persistence for resume after stop

## Monitoring

- `gpu_warmth_state{stage="stt|llm|tts",state="cold|warm"}`
- `cold_start_duration_ms{stage="...",gpu_type="..."}`
- `warm_ttfb_ms{stage="...",gpu_type="..."}`
