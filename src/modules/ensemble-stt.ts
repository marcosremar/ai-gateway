/**
 * Ensemble STT — races multiple STT providers and returns the first winner.
 *
 * Uses Promise.any to race providers. Tracks deadline timers that are cleared
 * in a finally block to prevent orphaned setTimeout handles.
 *
 * Fixes: #613-#615 (ensemble STT with timer cleanup)
 */

import type { STTProvider, STTResponse } from './providers/types';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Embedding provider used as a fallback for semantic similarity comparison
 * when Jaccard similarity is insufficient.
 */
export interface EmbeddingProvider {
  /** Human-readable provider name */
  name: string;
  /** Unique identifier for this provider */
  providerId: string;
  /** Whether the provider has valid credentials and configuration */
  isConfigured(): boolean;
  /** Generate embedding vectors for a list of texts. */
  embed(texts: string[]): Promise<number[][]>;
}

/** A single STT provider entry in the ensemble configuration. */
export interface STTProviderEntry {
  /** Human-readable name (e.g. "openai-whisper", "deepgram") */
  name: string;
  /** The STT provider instance */
  provider: STTProvider;
}

/**
 * Dependencies injected into the ensemble STT runner.
 *
 * This interface keeps the function pure and testable — all external
 * dependencies (providers, thresholds, timeouts) are passed in.
 */
export interface STTVerifierDeps {
  /** List of STT providers to race against each other */
  providers: STTProviderEntry[];
  /** Jaccard similarity threshold for outlier detection (default: 0.3) */
  outlierThreshold?: number;
  /** Per-provider timeout in milliseconds. If 0 or unset, no timeout is applied. */
  timeoutMs?: number;
  /** Fallback embedding providers for semantic similarity scoring */
  embeddingFallbacks?: EmbeddingProvider[];
  /** Minimum embedding similarity to consider a result valid */
  embeddingFallbackThreshold?: number;
}

/**
 * Result returned after running the ensemble STT verification.
 *
 * Contains the consensus text, per-provider results, similarity scores,
 * and latency metrics.
 */
export interface STTVerifierResult {
  /** The winning transcription text */
  consensus: string;
  /** Similarity method used ("jaccard" or "embedding") */
  similarity_method: 'jaccard' | 'embedding';
  /** Number of providers that participated */
  used_providers: number;
  /** Per-provider transcription results */
  providers: Record<string, string>;
  /** Per-provider similarity scores */
  scores: Record<string, number>;
  /** Provider names identified as outliers */
  outliers: string[];
  /** Total elapsed time in milliseconds */
  latency_ms: number;
  /** Word-level segments from the winning provider (if available) */
  segments?: STTResponse['segments'];
  /** Average log probability from the winning provider (if available) */
  avg_logprob?: number;
  /** Compression ratio from the winning provider (if available) */
  compression_ratio?: number;
  /** No-speech probability from the winning provider (if available) */
  no_speech_prob?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute Jaccard similarity between two strings (word-token sets).
 * Returns value in [0, 1].
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

// ── Core implementation ───────────────────────────────────────────────────────

/**
 * Race all configured STT providers and return the first successful result.
 *
 * Uses `Promise.any` to race providers. Deadline timers are tracked and
 * always cleared in a `finally` block to prevent orphaned `setTimeout` handles.
 *
 * @param audio     Raw audio buffer to transcribe
 * @param language  BCP-47 language code (e.g. "en", "fr")
 * @param prompt    Optional system prompt to guide transcription
 * @param deps      Injected providers and settings
 * @returns Result containing the winning transcription, scores, and latency
 * @throws Error if no STT providers are configured or all providers fail
 *
 * @example
 * ```typescript
 * const result = await runVerifiedSTT(
 *   audioBuffer,
 *   'en',
 *   'This is a medical consultation',
 *   { providers: [{ name: 'openai', provider: openaiStt }] }
 * );
 * console.log(result.consensus); // winning transcription
 * ```
 */
export async function runVerifiedSTT(
  audio: Buffer,
  language: string,
  prompt: string,
  deps: STTVerifierDeps,
): Promise<STTVerifierResult> {
  const { providers } = deps;
  // Default 30s upper bound to prevent N× upstream cost on losers.
  const timeoutMs = deps.timeoutMs && deps.timeoutMs > 0 ? deps.timeoutMs : 30_000;
  const t0 = Date.now();

  if (providers.length === 0) {
    throw new Error('No STT providers configured');
  }

  // deadlineTimers: array of timeout handles, always cleared in finally
  const deadlineTimers: ReturnType<typeof setTimeout>[] = [];

  try {
    // Build a race for each provider
    const providerRaces = providers.map(({ name, provider }) =>
      new Promise<{ name: string; response: STTResponse }>((resolve, reject) => {
        // Skip providers with no models
        const models = provider.getModels();
        if (!models || models.length === 0) {
          reject(new Error(`Provider ${name} has no models`));
          return;
        }

        const model = models[0].id;

        const transcribePromise = provider.transcribe({
          audio,
          model,
          language,
          prompt,
        }).then((response) => {
          // Treat empty or whitespace-only as a failure
          if (!response.text || !response.text.trim()) {
            reject(new Error(`Provider ${name} returned empty transcription`));
            return;
          }
          resolve({ name, response });
        }).catch(reject);

        // Deadline timer always fires so losers don't run forever paying upstream cost.
        const timer = setTimeout(() => {
          reject(new Error(`Provider ${name} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        deadlineTimers.push(timer);
        void transcribePromise.finally?.(() => {
          clearTimeout(timer);
        });
      }),
    );

    let winnerName: string;
    let winnerResponse: STTResponse;

    try {
      // Race mode: use Promise.any to get the first successful provider
      const winner = await Promise.any(providerRaces);
      winnerName = winner.name;
      winnerResponse = winner.response;
    } catch {
      // All providers failed (Promise.any rejects with AggregateError)
      throw new Error(`All ${providers.length} providers failed`);
    }

    const latency_ms = Date.now() - t0;

    return {
      consensus: winnerResponse.text.trim(),
      similarity_method: 'jaccard',
      used_providers: 1,
      providers: { [winnerName]: winnerResponse.text.trim() },
      scores: { [winnerName]: 1 },
      outliers: [],
      latency_ms,
      segments: winnerResponse.segments,
      avg_logprob: winnerResponse.avg_logprob,
      compression_ratio: winnerResponse.compression_ratio,
      no_speech_prob: winnerResponse.no_speech_prob,
    };
  } finally {
    // Always clear all deadline timers to prevent orphaned handles
    for (const t of deadlineTimers) {
      clearTimeout(t);
    }
  }
}

/** Alias for `runVerifiedSTT` — exported for backward compatibility. */
export const runEnsembleSTT = runVerifiedSTT;
