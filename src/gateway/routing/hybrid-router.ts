// ── BabelCast Gateway — Hybrid Routing Engine ────────────────────────────────
// Decides which provider (GPU vs cloud) to use per-request based on warmth,
// latency, availability, and cost. Pure logic — all runtime state is injected
// via HybridRouterDeps (so src/ never imports from server/).

export interface RoutingCondition {
  name: string;
  evaluate: () => boolean;
  weight: number;
  provider: 'gpu' | 'groq' | 'openai' | 'modal';
  model?: string;
  reason: string;
}

export interface RoutingDecision {
  provider: string;
  model: string;
  confidence: number;
  estimatedLatencyMs: number;
  reason: string;
  costEstimate: number;
}

/**
 * Dependencies injected into HybridRouter so it remains pure (no server/ imports).
 * All readers — HybridRouter never mutates state.
 */
export interface HybridRouterDeps {
  // State readers
  isGpuAvailable: () => boolean;
  isGpuReadyForProduction: () => boolean;
  isGpuLatencyAcceptable: () => boolean;
  isStageWarm: (stage: 'stt' | 'llm' | 'tts') => boolean;
  isTtsWarm: () => boolean;
  getP95Latency: () => number | null;
  gpuHealthy: () => boolean;

  // Provider availability
  groqAvailable: () => boolean;
  openaiAvailable: () => boolean;
  modalAvailable: () => boolean;

  // Default models
  groqLlmModel: () => string;

  // Logger (optional)
  log?: (msg: string) => void;
}

export class HybridRouter {
  private conditions: RoutingCondition[];

  constructor(private deps: HybridRouterDeps) {
    this.conditions = this.buildConditions();
  }

  private buildConditions(): RoutingCondition[] {
    const d = this.deps;
    return [
      // GPU-first strategies (highest priority)
      // Each condition now gates on isGpuLatencyAcceptable() so that a GPU
      // with degraded performance (P95 > 3s) automatically falls through to
      // cloud providers.
      {
        name: 'gpu_hot_complete',
        evaluate: () => d.isGpuAvailable() && d.isGpuReadyForProduction() && d.isGpuLatencyAcceptable() &&
                       d.isStageWarm('stt') && d.isStageWarm('llm') && d.isTtsWarm(),
        weight: 0.95,
        provider: 'gpu',
        reason: 'GPU fully warmed up, production-ready, and latency OK',
      },
      {
        name: 'gpu_hot_stt_llm',
        evaluate: () => d.isGpuAvailable() && d.isGpuLatencyAcceptable() && d.isStageWarm('stt') && d.isStageWarm('llm') && !d.isTtsWarm(),
        weight: 0.85,
        provider: 'gpu',
        reason: 'GPU STT+LLM warm but TTS cold',
      },
      {
        name: 'gpu_hot_partial',
        evaluate: () => d.isGpuAvailable() && d.isGpuLatencyAcceptable() && (d.isStageWarm('stt') || d.isStageWarm('llm') || d.isTtsWarm()),
        weight: 0.75,
        provider: 'gpu',
        reason: 'GPU partially warm',
      },
      {
        name: 'gpu_available',
        evaluate: () => d.isGpuAvailable() && d.isGpuLatencyAcceptable(),
        weight: 0.60,
        provider: 'gpu',
        reason: 'GPU available but cold',
      },
      {
        name: 'gpu_degraded',
        evaluate: () => d.isGpuAvailable() && !d.isGpuLatencyAcceptable(),
        weight: 0.40,
        provider: 'gpu',
        reason: 'GPU available but latency degraded (P95 > threshold)',
      },

      // Cloud fallback strategies
      {
        name: 'gpu_dead_groq_fast',
        evaluate: () => !d.isGpuAvailable() && d.groqAvailable(),
        weight: 1.0,
        provider: 'groq',
        reason: 'GPU unavailable, using fast cloud backup',
      },
      {
        name: 'gpu_dead_openai_fallback',
        evaluate: () => !d.isGpuAvailable() && d.openaiAvailable() && !d.groqAvailable(),
        weight: 0.9,
        provider: 'openai',
        reason: 'GPU unavailable, using OpenAI as fallback',
      },
      {
        name: 'gpu_cold_cloud_warmup',
        evaluate: () => !d.isStageWarm('stt') && !d.isStageWarm('llm'),
        weight: 0.8,
        provider: 'groq',
        reason: 'GPU still cold, using cloud during warmup',
      },
      {
        name: 'gpu_timeout_openai_failover',
        evaluate: () => {
          const p95Latency = d.getP95Latency();
          return (p95Latency || 0) > 3000; // >3s triggers failover
        },
        weight: 0.9,
        provider: 'openai',
        reason: 'GPU response too slow, failing over',
      },

      // Modal for TTS-only scenarios
      {
        name: 'tts_fallback_modal',
        evaluate: () => !d.isTtsWarm() && d.modalAvailable(),
        weight: 0.4,
        provider: 'modal',
        reason: 'TTS fallback to Modal',
      },
    ];
  }

  async route(pipelineType: 'speech' | 'tts' | 'stt' | 'translate', _context?: unknown): Promise<RoutingDecision> {
    const validConditions = this.conditions.filter(c => {
      if (pipelineType === 'tts' && c.name.includes('stt') && !c.name.includes('tts')) return false;
      if (pipelineType === 'stt' && !c.name.includes('stt')) return false;
      return c.evaluate();
    });

    if (validConditions.length === 0) {
      const fallbackProvider = this.deps.groqAvailable()
        ? 'groq'
        : this.deps.openaiAvailable()
          ? 'openai'
          : 'modal';
      return {
        provider: fallbackProvider,
        model: this.getDefaultModel(fallbackProvider, pipelineType),
        confidence: 0.3,
        estimatedLatencyMs: 1200,
        reason: 'No conditions matched, default fallback',
        costEstimate: this.estimateCost(fallbackProvider),
      };
    }

    const best = validConditions.reduce((b, cur) => (cur.weight > b.weight ? cur : b));

    const decision: RoutingDecision = {
      provider: best.provider,
      model: best.model || this.getDefaultModel(best.provider, pipelineType),
      confidence: best.weight,
      estimatedLatencyMs: this.estimateLatency(best.provider, best.weight),
      reason: best.reason,
      costEstimate: this.estimateCost(best.provider),
    };

    this.deps.log?.(`${pipelineType} → ${decision.provider}/${decision.model} (${decision.confidence.toFixed(2)}) - ${decision.reason}`);
    return decision;
  }

  private getDefaultModel(provider: string, pipelineType: string): string {
    switch (provider) {
      case 'gpu':
        return 'mistral-7b-instruct-v0.3';
      case 'groq':
        // mixtral-8x7b-32768 was decommissioned by Groq (#390); use a current
        // supported model as the non-speech default.
        return pipelineType === 'speech' ? this.deps.groqLlmModel() : 'llama-3.3-70b-versatile';
      case 'openai':
        return 'gpt-4o-mini';
      case 'modal':
        return 'sonic-speed';
      default:
        return 'unknown';
    }
  }

  private estimateLatency(provider: string, confidence: number): number {
    let base: number;
    switch (provider) {
      case 'gpu':
        base = this.deps.gpuHealthy() ? this.deps.getP95Latency() || 1000 : 5000;
        break;
      case 'groq':
        base = 800;
        break;
      case 'openai':
        base = 1200;
        break;
      case 'modal':
        base = 2000;
        break;
      default:
        base = 1500;
    }
    const adjustment = (1 - confidence) * 0.5;
    return Math.round(base * (1 + adjustment));
  }

  private estimateCost(provider: string): number {
    switch (provider) {
      case 'gpu':
        return 0.004;
      case 'groq':
        return 0.0001;
      case 'openai':
        return 0.0005;
      case 'modal':
        return 0.001;
      default:
        return 0.001;
    }
  }

  /** Update routing weights based on real performance feedback. */
  updatePerformance(provider: string, latencyMs: number, success: boolean, pipelineType: string): void {
    const performance = success
      ? latencyMs < 500 ? 'excellent' : latencyMs < 1500 ? 'good' : 'slow'
      : 'failed';
    this.deps.log?.(`Performance update: ${provider} ${performance} (${latencyMs}ms) for ${pipelineType}`);
    // Future: reinforcement learning to adjust weights dynamically.
  }
}
