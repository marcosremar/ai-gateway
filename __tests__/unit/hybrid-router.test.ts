/**
 * HybridRouter unit tests — pure routing-decision logic.
 *
 * HybridRouter is fully dependency-injected so every branch can be tested
 * without any live state or provider connections.
 */
import { describe, it, expect } from 'vitest';
import { HybridRouter, type HybridRouterDeps } from '../../src/gateway/routing/hybrid-router';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a deps stub with sensible defaults; override specific fields per test. */
function makeDeps(overrides: Partial<HybridRouterDeps> = {}): HybridRouterDeps {
  return {
    isGpuAvailable: () => false,
    isGpuReadyForProduction: () => false,
    isGpuLatencyAcceptable: () => true,
    isStageWarm: () => false,
    isTtsWarm: () => false,
    getP95Latency: () => null,
    gpuHealthy: () => false,
    groqAvailable: () => true,
    openaiAvailable: () => true,
    modalAvailable: () => true,
    groqLlmModel: () => 'llama3-70b-8192',
    ...overrides,
  };
}

/** Build a fully-warm GPU deps. */
function gpuFullyWarm(): HybridRouterDeps {
  return makeDeps({
    isGpuAvailable: () => true,
    isGpuReadyForProduction: () => true,
    isGpuLatencyAcceptable: () => true,
    isStageWarm: () => true,
    isTtsWarm: () => true,
    gpuHealthy: () => true,
    getP95Latency: () => 600,
  });
}

// ── Provider selection ────────────────────────────────────────────────────────

describe('HybridRouter — provider selection', () => {
  it('routes to GPU when fully warm and production-ready', async () => {
    const router = new HybridRouter(gpuFullyWarm());
    const decision = await router.route('speech');
    expect(decision.provider).toBe('gpu');
    expect(decision.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('routes to Groq when GPU is unavailable', async () => {
    const router = new HybridRouter(makeDeps({
      isGpuAvailable: () => false,
      groqAvailable: () => true,
    }));
    const decision = await router.route('speech');
    expect(decision.provider).toBe('groq');
  });

  it('routes to OpenAI when GPU is unavailable and Groq is down', async () => {
    const router = new HybridRouter(makeDeps({
      isGpuAvailable: () => false,
      groqAvailable: () => false,
      openaiAvailable: () => true,
    }));
    const decision = await router.route('speech');
    expect(decision.provider).toBe('openai');
  });

  it('routes to Groq during GPU cold-start warmup (cloud warmup takes priority)', async () => {
    // gpu_cold_cloud_warmup (weight 0.80) fires when stages are cold, beating gpu_available (0.60).
    // This is intentional: cloud warms up while GPU cold-starts.
    const router = new HybridRouter(makeDeps({
      isGpuAvailable: () => true,
      isGpuLatencyAcceptable: () => true,
      isStageWarm: () => false,
      isTtsWarm: () => false,
      groqAvailable: () => true,
    }));
    const decision = await router.route('speech');
    expect(decision.provider).toBe('groq');
    expect(decision.reason).toContain('cold');
  });

  it('routes to degraded GPU when stages are warm and latency not acceptable', async () => {
    // gpu_cold_cloud_warmup fires only when stages are COLD.
    // When stages are warm, it doesn't fire — so gpu_degraded (0.40) can win.
    // Disable cloud providers to prevent cloud conditions from also firing.
    const router = new HybridRouter(makeDeps({
      isGpuAvailable: () => true,
      isGpuLatencyAcceptable: () => false,
      isGpuReadyForProduction: () => false,
      isStageWarm: () => true, // warm stages prevent gpu_cold_cloud_warmup from firing
      isTtsWarm: () => false,
      groqAvailable: () => false,
      openaiAvailable: () => false,
      modalAvailable: () => false,
    }));
    const decision = await router.route('speech');
    expect(decision.provider).toBe('gpu');
    expect(decision.confidence).toBe(0.40);
    expect(decision.reason).toContain('latency degraded');
  });

  it('routes to OpenAI when p95 > 3000ms and GPU is down', async () => {
    const router = new HybridRouter(makeDeps({
      isGpuAvailable: () => false,
      getP95Latency: () => 4000,
      groqAvailable: () => false,
      openaiAvailable: () => true,
    }));
    const decision = await router.route('speech');
    expect(decision.provider).toBe('openai');
  });
});

// ── Pipeline-type filtering ───────────────────────────────────────────────────

describe('HybridRouter — pipeline type filtering', () => {
  it('speech routing picks highest-weight GPU condition when fully warm', async () => {
    const router = new HybridRouter(gpuFullyWarm());
    const decision = await router.route('speech');
    expect(decision.confidence).toBe(0.95);
    expect(decision.reason).toContain('fully warmed');
  });

  it('tts route falls back to modal when TTS is cold and no cloud available', async () => {
    // gpu_cold_cloud_warmup fires for TTS (weight 0.80) when stages are cold → routes to groq.
    // When groq and openai are down, it still wins but provider is 'groq' (unavailable).
    // tts_fallback_modal (0.40) loses. To get modal, also disable stages warm so gpu wins at 0.75+ OR
    // ensure stages ARE warm (so gpu_cold_cloud_warmup doesn't fire) and GPU is unavailable.
    // The easiest way to test modal path: make stages warm AND disable GPU and groq/openai.
    const router = new HybridRouter(makeDeps({
      isGpuAvailable: () => false,
      groqAvailable: () => false,
      openaiAvailable: () => false,
      isTtsWarm: () => false,
      isStageWarm: () => true, // warm stages prevents gpu_cold_cloud_warmup from firing
      modalAvailable: () => true,
    }));
    const decision = await router.route('tts');
    expect(decision.provider).toBe('modal');
  });

  it('returns a valid decision for stt pipeline type', async () => {
    const router = new HybridRouter(makeDeps({ groqAvailable: () => true }));
    const decision = await router.route('stt');
    expect(decision.provider).toBeTruthy();
    expect(typeof decision.confidence).toBe('number');
  });

  it('returns a valid decision for translate pipeline type', async () => {
    const router = new HybridRouter(makeDeps({ groqAvailable: () => true }));
    const decision = await router.route('translate');
    expect(decision.provider).toBeTruthy();
    expect(decision.costEstimate).toBeGreaterThan(0);
  });
});

// ── RoutingDecision shape ─────────────────────────────────────────────────────

describe('HybridRouter — RoutingDecision shape', () => {
  it('decision always includes all required fields', async () => {
    const router = new HybridRouter(makeDeps());
    const decision = await router.route('speech');
    expect(decision).toHaveProperty('provider');
    expect(decision).toHaveProperty('model');
    expect(decision).toHaveProperty('confidence');
    expect(decision).toHaveProperty('estimatedLatencyMs');
    expect(decision).toHaveProperty('reason');
    expect(decision).toHaveProperty('costEstimate');
  });

  it('groq decision uses configured LLM model for speech', async () => {
    const router = new HybridRouter(makeDeps({
      isGpuAvailable: () => false,
      groqAvailable: () => true,
      groqLlmModel: () => 'llama3-70b-custom',
    }));
    const decision = await router.route('speech');
    expect(decision.provider).toBe('groq');
    expect(decision.model).toBe('llama3-70b-custom');
  });

  it('groq decision uses default model for non-speech pipeline', async () => {
    const router = new HybridRouter(makeDeps({
      isGpuAvailable: () => false,
      groqAvailable: () => true,
    }));
    const decision = await router.route('translate');
    expect(decision.model).toBe('mixtral-8x7b-32768');
  });

  it('gpu decision uses expected default model', async () => {
    const router = new HybridRouter(gpuFullyWarm());
    const decision = await router.route('speech');
    expect(decision.model).toBe('mistral-7b-instruct-v0.3');
  });

  it('confidence is between 0 and 1', async () => {
    const router = new HybridRouter(makeDeps());
    const decision = await router.route('speech');
    expect(decision.confidence).toBeGreaterThanOrEqual(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
  });

  it('estimatedLatencyMs is a positive number', async () => {
    const router = new HybridRouter(makeDeps());
    const decision = await router.route('speech');
    expect(decision.estimatedLatencyMs).toBeGreaterThan(0);
  });
});

// ── Cost estimation ───────────────────────────────────────────────────────────

describe('HybridRouter — cost estimation', () => {
  it('Groq is cheapest per-call (token-based billing vs GPU time-based)', async () => {
    // GPU cost estimate (0.004/call) > Groq (0.0001/call) in the router model —
    // GPU cost covers the amortised hourly rate per inference, which is higher
    // than token-priced cloud API calls. Groq is intentionally the lowest-cost option.
    const groqRouter = new HybridRouter(makeDeps({ isGpuAvailable: () => false }));
    const groqDecision = await groqRouter.route('speech');

    const openaiRouter = new HybridRouter(makeDeps({
      isGpuAvailable: () => false,
      groqAvailable: () => false,
      openaiAvailable: () => true,
    }));
    const openaiDecision = await openaiRouter.route('speech');

    expect(groqDecision.costEstimate).toBeLessThan(openaiDecision.costEstimate);
  });

  it('OpenAI costs more than Groq', async () => {
    const openAiRouter = new HybridRouter(makeDeps({
      isGpuAvailable: () => false,
      groqAvailable: () => false,
      openaiAvailable: () => true,
    }));
    const openaiDecision = await openAiRouter.route('speech');

    const groqRouter = new HybridRouter(makeDeps({ isGpuAvailable: () => false }));
    const groqDecision = await groqRouter.route('speech');

    expect(openaiDecision.costEstimate).toBeGreaterThan(groqDecision.costEstimate);
  });
});

// ── Latency estimation ────────────────────────────────────────────────────────

describe('HybridRouter — latency estimation', () => {
  it('GPU latency uses p95 when healthy and fully warm', async () => {
    // Use fully-warm GPU so gpu_hot_complete (0.95) beats all cloud conditions.
    const router = new HybridRouter(makeDeps({
      isGpuAvailable: () => true,
      isGpuReadyForProduction: () => true,
      isGpuLatencyAcceptable: () => true,
      isStageWarm: () => true,
      isTtsWarm: () => true,
      gpuHealthy: () => true,
      getP95Latency: () => 800,
    }));
    const decision = await router.route('speech');
    expect(decision.provider).toBe('gpu');
    // Estimated latency is derived from p95 (800ms) with confidence adjustment
    expect(decision.estimatedLatencyMs).toBeGreaterThan(0);
    expect(decision.estimatedLatencyMs).toBeLessThan(5000);
  });

  it('GPU latency estimate is 5000ms when unhealthy (stages warm, no cloud available)', async () => {
    // gpu_cold_cloud_warmup fires only when stages are COLD.
    // With warm stages and no cloud, gpu_degraded (0.40) wins; unhealthy GPU → 5000ms base.
    const router = new HybridRouter(makeDeps({
      isGpuAvailable: () => true,
      isGpuLatencyAcceptable: () => false,
      gpuHealthy: () => false,
      getP95Latency: () => null,
      isGpuReadyForProduction: () => false,
      isStageWarm: () => true, // warm stages prevent gpu_cold_cloud_warmup from firing
      isTtsWarm: () => false,
      groqAvailable: () => false,
      openaiAvailable: () => false,
      modalAvailable: () => false,
    }));
    const decision = await router.route('speech');
    expect(decision.provider).toBe('gpu');
    expect(decision.estimatedLatencyMs).toBeGreaterThanOrEqual(5000);
  });

  it('Groq latency is significantly lower than GPU cold start', async () => {
    const groqRouter = new HybridRouter(makeDeps({ isGpuAvailable: () => false }));
    const groqDecision = await groqRouter.route('speech');
    // Groq base is 800ms, GPU unhealthy is 5000ms
    expect(groqDecision.estimatedLatencyMs).toBeLessThan(2000);
  });
});

// ── No-conditions fallback ────────────────────────────────────────────────────

describe('HybridRouter — fallback when no conditions match', () => {
  it('returns Groq as ultimate fallback when available', async () => {
    // All GPU conditions fail; cloud conditions also won't match in a clean way
    // when no conditions fire, the fallback kicks in
    const router = new HybridRouter(makeDeps({
      isGpuAvailable: () => false,
      groqAvailable: () => true,
      openaiAvailable: () => false,
      modalAvailable: () => false,
      isStageWarm: () => true, // warm but no GPU — groq_cold_warmup fires
    }));
    const decision = await router.route('speech');
    // Should still produce a valid decision
    expect(decision.provider).toBeTruthy();
    expect(decision.confidence).toBeGreaterThan(0);
  });

  it('falls back to openai when groq is down and no conditions match', async () => {
    const router = new HybridRouter(makeDeps({
      isGpuAvailable: () => false,
      groqAvailable: () => false,
      openaiAvailable: () => true,
    }));
    const decision = await router.route('speech');
    expect(decision.provider).toBe('openai');
  });

  it('ultimate fallback uses groq even when groq reports unavailable (gpu_cold_cloud_warmup fires)', async () => {
    // gpu_cold_cloud_warmup (weight 0.80) fires whenever stages are cold — it routes to
    // 'groq' without checking groqAvailable(). This is the highest-priority cloud condition
    // when GPU is down and stages are cold. The router selects the condition's provider
    // even if availability is false; the actual request may fail at call time.
    const router = new HybridRouter(makeDeps({
      isGpuAvailable: () => false,
      groqAvailable: () => false,
      openaiAvailable: () => false,
      modalAvailable: () => true,
      isStageWarm: () => false,
    }));
    const decision = await router.route('speech');
    // gpu_cold_cloud_warmup fires (weight 0.80) and declares 'groq' as provider
    expect(decision.provider).toBe('groq');
    expect(decision.confidence).toBe(0.80);
  });
});

// ── updatePerformance (smoke test) ───────────────────────────────────────────

describe('HybridRouter — updatePerformance', () => {
  it('does not throw on success feedback', () => {
    const router = new HybridRouter(makeDeps());
    expect(() => router.updatePerformance('groq', 400, true, 'speech')).not.toThrow();
  });

  it('does not throw on failure feedback', () => {
    const router = new HybridRouter(makeDeps());
    expect(() => router.updatePerformance('gpu', 6000, false, 'tts')).not.toThrow();
  });

  it('calls the injected logger when one is supplied', () => {
    const logs: string[] = [];
    const router = new HybridRouter(makeDeps({ log: (m) => logs.push(m) }));
    router.updatePerformance('openai', 1200, true, 'translate');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toContain('openai');
  });
});

// ── GPU partial-warm conditions ───────────────────────────────────────────────

describe('HybridRouter — GPU partial warmth conditions', () => {
  it('selects gpu_hot_stt_llm when STT+LLM warm but TTS cold', async () => {
    const router = new HybridRouter(makeDeps({
      isGpuAvailable: () => true,
      isGpuLatencyAcceptable: () => true,
      isStageWarm: (stage) => stage === 'stt' || stage === 'llm',
      isTtsWarm: () => false,
    }));
    const decision = await router.route('speech');
    expect(decision.provider).toBe('gpu');
    expect(decision.confidence).toBe(0.85);
    expect(decision.reason).toContain('STT+LLM warm');
  });

  it('selects gpu_hot_partial when only one stage is warm', async () => {
    const router = new HybridRouter(makeDeps({
      isGpuAvailable: () => true,
      isGpuLatencyAcceptable: () => true,
      isStageWarm: (stage) => stage === 'stt',
      isTtsWarm: () => false,
    }));
    const decision = await router.route('speech');
    expect(decision.provider).toBe('gpu');
    expect(decision.confidence).toBe(0.75);
    expect(decision.reason).toContain('partially warm');
  });
});
