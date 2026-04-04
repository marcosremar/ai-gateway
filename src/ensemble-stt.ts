/**
 * STT Race — fire all configured providers in parallel, return the FIRST
 * that responds with non-empty text within the timeoutMs budget.
 * Remaining in-flight requests are abandoned once a winner is found.
 *
 * Architecture:
 *   - Providers injected via deps — no hard env-var dependency here.
 *   - gateway-server.ts wires up active providers from env.
 */

import type { STTProvider, STTSegment } from './providers/types';
import type { EmbeddingProvider } from './providers/openai-compat/openai-compat-embedding';

export interface STTVerifierProviderEntry {
  name: string;
  provider: STTProvider;
}

export interface STTVerifierDeps {
  providers: STTVerifierProviderEntry[];
  /** Ignored — kept for backward compatibility. */
  outlierThreshold?: number;
  /**
   * Per-provider deadline in ms. Providers that miss it are dropped.
   * Default: no timeout.
   */
  timeoutMs?: number;
  /** Ignored — kept for backward compatibility. */
  embeddingFallbacks?: EmbeddingProvider[];
  /** Ignored — kept for backward compatibility. */
  embeddingFallbackThreshold?: number;
  /** Ignored — kept for backward compatibility. */
  embeddingOutlierThreshold?: number;
}

export interface STTVerifierResult {
  /** First provider to respond with non-empty text. */
  consensus: string;
  /** Map of provider name → transcription (only the winner). */
  providers: Record<string, string>;
  /** Similarity scores — always 1 for the winner in race mode. */
  scores: Record<string, number>;
  /** Always empty in race mode. */
  outliers: string[];
  /** Always 1 — the winning provider. */
  used_providers: number;
  /** Wall-clock latency from fan-out start to first response. */
  latency_ms: number;
  /** Always 'jaccard' in race mode. */
  similarity_method: 'jaccard' | 'embedding';
  embedding_provider?: string;
  segments?: STTSegment[];
  avg_logprob?: number;
  compression_ratio?: number;
  no_speech_prob?: number;
}

/**
 * Fan-out to all providers simultaneously. Return the first non-empty
 * result. If all providers fail or time out, throws.
 */
export async function runVerifiedSTT(
  audio: Buffer,
  language: string,
  prompt: string,
  deps: STTVerifierDeps,
): Promise<STTVerifierResult> {
  const t0 = Date.now();

  if (deps.providers.length === 0) {
    throw new Error('[stt-verifier] No STT providers configured');
  }

  interface ProviderResult {
    name: string;
    text: string;
    segments?: STTSegment[];
    avg_logprob?: number;
    compression_ratio?: number;
    no_speech_prob?: number;
  }

  const races = deps.providers.map(({ name, provider }) => {
    const modelId = provider.getModels()[0]?.id;
    if (!modelId) {
      return Promise.reject<ProviderResult>(new Error(`[stt-verifier] ${name} has no models`));
    }

    let p: Promise<ProviderResult> = provider
      .transcribe({ audio, model: modelId, language, prompt })
      .then((r): ProviderResult => {
        if (!r.text.trim()) throw new Error(`${name}: empty response`);
        return {
          name,
          text: r.text,
          segments: r.segments,
          avg_logprob: r.avg_logprob,
          compression_ratio: r.compression_ratio,
          no_speech_prob: r.no_speech_prob,
        };
      });

    if (deps.timeoutMs !== undefined) {
      const deadline = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${name}: timeout after ${deps.timeoutMs}ms`)), deps.timeoutMs),
      );
      p = Promise.race([p, deadline]);
    }

    return p;
  });

  let winner: ProviderResult;
  try {
    winner = await Promise.any(races);
  } catch {
    const total = deps.providers.length;
    throw new Error(`[stt-verifier] All ${total} provider${total !== 1 ? 's' : ''} failed or timed out`);
  }

  const latency_ms = Date.now() - t0;
  console.log(`[stt-verifier] ${winner.name} won in ${latency_ms}ms`);

  return {
    consensus: winner.text,
    providers: { [winner.name]: winner.text },
    scores: { [winner.name]: 1 },
    outliers: [],
    used_providers: 1,
    latency_ms,
    similarity_method: 'jaccard',
    ...(winner.segments ? { segments: winner.segments } : {}),
    ...(winner.avg_logprob !== undefined ? { avg_logprob: winner.avg_logprob } : {}),
    ...(winner.compression_ratio !== undefined ? { compression_ratio: winner.compression_ratio } : {}),
    ...(winner.no_speech_prob !== undefined ? { no_speech_prob: winner.no_speech_prob } : {}),
  };
}

// Back-compat aliases (used in gateway-server.ts)
export type EnsembleSTTProviderEntry = STTVerifierProviderEntry;
export type EnsembleSTTDeps = STTVerifierDeps & { consensusLLM?: unknown; consensusModel?: string };
export type EnsembleSTTResult = STTVerifierResult;
export const runEnsembleSTT = runVerifiedSTT;
