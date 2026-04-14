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

export interface EmbeddingProvider {
  name: string;
  providerId: string;
  isConfigured(): boolean;
  embed(texts: string[]): Promise<number[][]>;
}

export interface STTProviderEntry {
  name: string;
  provider: STTProvider;
}

export interface STTVerifierDeps {
  providers: STTProviderEntry[];
  outlierThreshold?: number;
  timeoutMs?: number;
  embeddingFallbacks?: EmbeddingProvider[];
  embeddingFallbackThreshold?: number;
}

export interface STTVerifierResult {
  consensus: string;
  similarity_method: 'jaccard' | 'embedding';
  used_providers: number;
  providers: Record<string, string>;
  scores: Record<string, number>;
  outliers: string[];
  latency_ms: number;
  segments?: STTResponse['segments'];
  avg_logprob?: number;
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
 * Tracks deadline timers that are always cleared in a finally block to avoid
 * memory/timer leaks.
 *
 * @param audio     Raw audio buffer
 * @param language  BCP-47 language code (e.g. 'en', 'fr')
 * @param prompt    Optional system prompt for transcription
 * @param deps      Injected providers and settings
 */
export async function runVerifiedSTT(
  audio: Buffer,
  language: string,
  prompt: string,
  deps: STTVerifierDeps,
): Promise<STTVerifierResult> {
  const { providers, timeoutMs } = deps;
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

        // Set up deadline timer if timeoutMs is specified
        if (timeoutMs && timeoutMs > 0) {
          const timer = setTimeout(() => {
            reject(new Error(`Provider ${name} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          deadlineTimers.push(timer);
          // Attach cleanup to the transcribe promise to clear timer on success
          void transcribePromise.finally?.(() => {
            clearTimeout(timer);
          });
        }
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
    };
  } finally {
    // Always clear all deadline timers to prevent orphaned handles
    for (const t of deadlineTimers) {
      clearTimeout(t);
    }
  }
}

/** Alias for runVerifiedSTT — exported for backward compatibility. */
export const runEnsembleSTT = runVerifiedSTT;
