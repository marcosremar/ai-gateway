/**
 * STT Verifier — fan-out to multiple STT providers in parallel, then pick
 * the best transcription using word-level similarity (majority agreement).
 *
 * No LLM needed: similarity-based consensus is faster and deterministic.
 * The text most "agreed upon" by other providers wins (highest avg Jaccard similarity).
 * Providers whose result deviates too much from the majority are flagged as outliers.
 *
 * Usage:
 *   import { runVerifiedSTT } from './ensemble-stt';
 *   const result = await runVerifiedSTT(audioBuffer, 'fr', '', { providers });
 *
 * Architecture (follows ai-gateway DI pattern):
 *   - Providers injected via deps — no hard env-var dependency here.
 *   - gateway-server.ts wires up active providers from env and calls this function.
 */

import type { STTProvider } from './providers/types';

export interface STTVerifierProviderEntry {
  name: string;
  provider: STTProvider;
}

export interface STTVerifierDeps {
  providers: STTVerifierProviderEntry[];
  /**
   * Minimum Jaccard similarity score for a result to be considered "in the majority".
   * Results below this threshold relative to the winning cluster are flagged as outliers.
   * Default: 0.25 (tuned for short transcription segments).
   */
  outlierThreshold?: number;
  /**
   * Maximum wall-clock budget in ms for provider fan-out.
   * Providers that haven't responded within this deadline are dropped —
   * consensus is built from whoever made it in time.
   * This is critical for real-time use: set to e.g. 1500ms so the pipeline
   * never blocks on a slow provider.
   * Default: no timeout (wait for all providers).
   */
  timeoutMs?: number;
}

export interface STTVerifierResult {
  /** Best transcription — the one with highest average word-similarity to others. */
  consensus: string;
  /** Per-provider transcription text for each provider that succeeded. */
  providers: Record<string, string>;
  /** Per-provider similarity score (avg Jaccard vs all others). */
  scores: Record<string, number>;
  /** Providers flagged as outliers (low agreement with majority). */
  outliers: string[];
  /** How many providers returned a non-empty result. */
  used_providers: number;
  /** Total wall-clock latency in ms (fan-out only — no LLM call). */
  latency_ms: number;
}

// ---------------------------------------------------------------------------
// Similarity helpers
// ---------------------------------------------------------------------------

/** Tokenise text into lowercase words, keeping accented chars (French, etc.). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s\u00C0-\u017E]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Word-level Jaccard similarity: |A ∩ B| / |A ∪ B|. Returns 1 for identical, 0 for disjoint. */
function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Pick the transcription with the highest average Jaccard similarity to all others.
 * Returns the index, per-text scores, and outlier indices.
 */
function pickByAgreement(
  texts: string[],
  outlierThreshold: number,
): { bestIdx: number; scores: number[]; outlierIndices: number[] } {
  const tokens = texts.map(tokenize);
  const n = texts.length;

  const scores = tokens.map((_, i) => {
    if (n === 1) return 1;
    let total = 0;
    for (let j = 0; j < n; j++) {
      if (i !== j) total += jaccardSimilarity(tokens[i], tokens[j]);
    }
    return total / (n - 1);
  });

  const bestScore = Math.max(...scores);
  const bestIdx = scores.indexOf(bestScore);
  const outlierIndices = scores
    .map((s, i) => (s < outlierThreshold ? i : -1))
    .filter(i => i >= 0);

  return { bestIdx, scores, outlierIndices };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run verified STT: fan-out to all providers in parallel, then select the
 * most agreed-upon transcription via word-level Jaccard similarity.
 */
export async function runVerifiedSTT(
  audio: Buffer,
  language: string,
  prompt: string,
  deps: STTVerifierDeps,
): Promise<STTVerifierResult> {
  const t0 = Date.now();
  const outlierThreshold = deps.outlierThreshold ?? 0.25;

  if (deps.providers.length === 0) {
    throw new Error('[stt-verifier] No STT providers configured');
  }

  // Build per-provider promises — failures are silently collected by allSettled
  const providerPromises = deps.providers.map(({ name, provider }) => {
    const modelId = provider.getModels()[0]?.id;
    if (!modelId) {
      return Promise.reject(new Error(`[stt-verifier] ${name} has no models configured`));
    }
    return provider
      .transcribe({ audio, model: modelId, language, prompt })
      .then(r => ({ name, text: r.text }));
  });

  let settled: PromiseSettledResult<{ name: string; text: string }>[];

  if (deps.timeoutMs !== undefined) {
    // Race each provider against the shared deadline.
    // Any provider that misses the deadline is treated as rejected.
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), deps.timeoutMs),
    );
    settled = await Promise.allSettled(
      providerPromises.map(p => Promise.race([p, deadline])),
    );
    const timedOut = settled.filter(r => r.status === 'rejected' &&
      (r as PromiseRejectedResult).reason?.message === 'timeout').length;
    if (timedOut > 0) {
      console.log(`[stt-verifier] ${timedOut} provider(s) timed out after ${deps.timeoutMs}ms`);
    }
  } else {
    settled = await Promise.allSettled(providerPromises);
  }

  const succeeded: Record<string, string> = {};
  for (const r of settled) {
    if (r.status === 'rejected') {
      const msg = (r.reason as Error)?.message ?? String(r.reason);
      if (msg !== 'timeout') console.warn('[stt-verifier] provider failed:', msg);
    } else if (r.value.text.trim()) {
      succeeded[r.value.name] = r.value.text;
    }
  }

  const names = Object.keys(succeeded);
  const texts = Object.values(succeeded);

  if (texts.length === 0) {
    const total = deps.providers.length;
    throw new Error(`[stt-verifier] All ${total} provider${total !== 1 ? 's' : ''} failed or timed out`);
  }

  if (texts.length === 1) {
    return {
      consensus: texts[0],
      providers: succeeded,
      scores: { [names[0]]: 1 },
      outliers: [],
      used_providers: 1,
      latency_ms: Date.now() - t0,
    };
  }

  // Similarity-based consensus
  const { bestIdx, scores: rawScores, outlierIndices } = pickByAgreement(texts, outlierThreshold);

  const scoreMap: Record<string, number> = {};
  names.forEach((name, i) => { scoreMap[name] = Math.round(rawScores[i] * 1000) / 1000; });

  const outlierNames = outlierIndices.map(i => names[i]);
  if (outlierNames.length > 0) {
    console.log(`[stt-verifier] Outliers detected: ${outlierNames.join(', ')}`);
  }

  return {
    consensus: texts[bestIdx],
    providers: succeeded,
    scores: scoreMap,
    outliers: outlierNames,
    used_providers: texts.length,
    latency_ms: Date.now() - t0,
  };
}

// Back-compat aliases (used in gateway-server.ts)
export type EnsembleSTTProviderEntry = STTVerifierProviderEntry;
export type EnsembleSTTDeps = STTVerifierDeps & { consensusLLM?: unknown; consensusModel?: string };
export type EnsembleSTTResult = STTVerifierResult;
export const runEnsembleSTT = runVerifiedSTT;
