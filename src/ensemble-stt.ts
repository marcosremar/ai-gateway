/**
 * STT Verifier — fan-out to multiple STT providers in parallel, then pick
 * the best transcription via layered similarity:
 *
 *   Layer 1 — Jaccard (word overlap):  zero cost, ~0ms, works for same-language STT
 *   Layer 2 — Embedding fallback 1:    Qwen3-0.6b via OpenRouter (~25ms, $0.01/1M)
 *   Layer 3 — Embedding fallback 2:    OpenAI text-embedding-3-small (~15ms, $0.02/1M)
 *
 * Fallback is triggered automatically when Jaccard agreement is too low
 * (< embeddingFallbackThreshold, default 0.3) — typically caused by:
 *   - Providers returning text in different languages (FR vs EN)
 *   - Heavy paraphrasing on ambiguous audio
 *
 * Architecture:
 *   - Providers injected via deps — no hard env-var dependency here.
 *   - gateway-server.ts wires up active providers + embedding fallbacks from env.
 */

import type { STTProvider } from './providers/types';
import type { EmbeddingProvider } from './providers/openai-compat/openai-compat-embedding';

export interface STTVerifierProviderEntry {
  name: string;
  provider: STTProvider;
}

export interface STTVerifierDeps {
  providers: STTVerifierProviderEntry[];
  /**
   * Minimum Jaccard score to consider a result "in the majority".
   * Default: 0.25
   */
  outlierThreshold?: number;
  /**
   * Wall-clock budget in ms for provider fan-out.
   * Providers that miss the deadline are dropped; consensus uses whoever arrived.
   * Set to e.g. 1500ms for real-time pipelines.
   * Default: no timeout.
   */
  timeoutMs?: number;
  /**
   * Embedding providers tried in order when Jaccard confidence is too low.
   * Recommended: [openrouterQwen3Embedding, openaiEmbedding]
   * Each provider is tried until one succeeds (skips unconfigured ones).
   */
  embeddingFallbacks?: EmbeddingProvider[];
  /**
   * Jaccard best-score threshold below which embedding fallback is triggered.
   * Default: 0.3 — catches language divergence and heavy disagreement.
   */
  embeddingFallbackThreshold?: number;
  /**
   * Minimum cosine similarity for a result to not be flagged as outlier
   * when using embedding-based consensus.
   * Default: 0.70 (embeddings produce higher raw scores than Jaccard).
   */
  embeddingOutlierThreshold?: number;
}

export interface STTVerifierResult {
  /** Best transcription — highest average similarity to all others. */
  consensus: string;
  /** Per-provider transcription text (only providers that succeeded). */
  providers: Record<string, string>;
  /** Per-provider similarity score (avg vs all others, 0–1). */
  scores: Record<string, number>;
  /** Providers flagged as outliers (low agreement with majority). */
  outliers: string[];
  /** How many providers returned a non-empty result. */
  used_providers: number;
  /** Total wall-clock latency in ms. */
  latency_ms: number;
  /** Which similarity method produced the final consensus. */
  similarity_method: 'jaccard' | 'embedding';
  /** Name of the embedding provider used, if similarity_method is 'embedding'. */
  embedding_provider?: string;
}

// ---------------------------------------------------------------------------
// Similarity helpers
// ---------------------------------------------------------------------------

/** Tokenise text into lowercase words, preserving accented characters (French etc.). */
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

/** Cosine similarity between two embedding vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Compute per-text agreement scores and outlier indices from a similarity matrix. */
function scoreAndOutliers(
  similarities: number[][],
  outlierThreshold: number,
): { bestIdx: number; scores: number[]; outlierIndices: number[] } {
  const n = similarities.length;
  const scores = similarities.map((row, i) => {
    if (n === 1) return 1;
    let total = 0;
    for (let j = 0; j < n; j++) {
      if (i !== j) total += row[j];
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

/** Build a Jaccard similarity matrix for a list of tokenized texts. */
function jaccardMatrix(texts: string[]): number[][] {
  const tokens = texts.map(tokenize);
  return tokens.map((a, i) => tokens.map((b, j) => i === j ? 1 : jaccardSimilarity(a, b)));
}

/**
 * Build a cosine similarity matrix using an embedding provider.
 * All texts are embedded in a single batched API call.
 */
async function embeddingMatrix(
  texts: string[],
  provider: EmbeddingProvider,
): Promise<number[][]> {
  const { embeddings } = await provider.embed(texts);
  return embeddings.map((a, i) =>
    embeddings.map((b, j) => i === j ? 1 : cosineSimilarity(a, b)),
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run verified STT: fan-out to all providers in parallel, then select the
 * most agreed-upon transcription via layered similarity (Jaccard → embeddings).
 */
export async function runVerifiedSTT(
  audio: Buffer,
  language: string,
  prompt: string,
  deps: STTVerifierDeps,
): Promise<STTVerifierResult> {
  const t0 = Date.now();
  const outlierThreshold = deps.outlierThreshold ?? 0.25;
  const embeddingFallbackThreshold = deps.embeddingFallbackThreshold ?? 0.3;
  const embeddingOutlierThreshold = deps.embeddingOutlierThreshold ?? 0.70;

  if (deps.providers.length === 0) {
    throw new Error('[stt-verifier] No STT providers configured');
  }

  // ── Fan-out to all STT providers in parallel ────────────────────────────

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
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), deps.timeoutMs),
    );
    settled = await Promise.allSettled(
      providerPromises.map(p => Promise.race([p, deadline])),
    );
    const timedOut = settled.filter(r =>
      r.status === 'rejected' && (r as PromiseRejectedResult).reason?.message === 'timeout',
    ).length;
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
      similarity_method: 'jaccard',
    };
  }

  // ── Layer 1: Jaccard ───────────────────────────────────────────────────

  const jMatrix = jaccardMatrix(texts);
  const jaccard = scoreAndOutliers(jMatrix, outlierThreshold);
  const jaccardBestScore = Math.max(...jaccard.scores);

  const useFallback =
    deps.embeddingFallbacks &&
    deps.embeddingFallbacks.length > 0 &&
    jaccardBestScore < embeddingFallbackThreshold;

  if (useFallback) {
    console.log(
      `[stt-verifier] Jaccard confidence low (${jaccardBestScore.toFixed(2)} < ${embeddingFallbackThreshold}) — trying embedding fallback`,
    );
  }

  // ── Layers 2 & 3: Embedding fallbacks (tried in order) ─────────────────

  if (useFallback) {
    for (const embProvider of deps.embeddingFallbacks!) {
      if (!embProvider.isConfigured()) continue;
      try {
        const eMatrix = await embeddingMatrix(texts, embProvider);
        const emb = scoreAndOutliers(eMatrix, embeddingOutlierThreshold);

        const scoreMap: Record<string, number> = {};
        names.forEach((name, i) => { scoreMap[name] = Math.round(emb.scores[i] * 1000) / 1000; });

        const outlierNames = emb.outlierIndices.map(i => names[i]);
        if (outlierNames.length > 0) {
          console.log(`[stt-verifier] Outliers (${embProvider.name}): ${outlierNames.join(', ')}`);
        }

        console.log(`[stt-verifier] Embedding consensus via ${embProvider.name}`);
        return {
          consensus: texts[emb.bestIdx],
          providers: succeeded,
          scores: scoreMap,
          outliers: outlierNames,
          used_providers: texts.length,
          latency_ms: Date.now() - t0,
          similarity_method: 'embedding',
          embedding_provider: embProvider.name,
        };
      } catch (err) {
        console.warn(
          `[stt-verifier] Embedding fallback ${embProvider.name} failed:`,
          err instanceof Error ? err.message : err,
        );
        // continue to next fallback
      }
    }
    console.warn('[stt-verifier] All embedding fallbacks failed — using Jaccard result');
  }

  // ── Return Jaccard result ───────────────────────────────────────────────

  const scoreMap: Record<string, number> = {};
  names.forEach((name, i) => { scoreMap[name] = Math.round(jaccard.scores[i] * 1000) / 1000; });

  const outlierNames = jaccard.outlierIndices.map(i => names[i]);
  if (outlierNames.length > 0) {
    console.log(`[stt-verifier] Outliers (Jaccard): ${outlierNames.join(', ')}`);
  }

  return {
    consensus: texts[jaccard.bestIdx],
    providers: succeeded,
    scores: scoreMap,
    outliers: outlierNames,
    used_providers: texts.length,
    latency_ms: Date.now() - t0,
    similarity_method: 'jaccard',
  };
}

// Back-compat aliases (used in gateway-server.ts)
export type EnsembleSTTProviderEntry = STTVerifierProviderEntry;
export type EnsembleSTTDeps = STTVerifierDeps & { consensusLLM?: unknown; consensusModel?: string };
export type EnsembleSTTResult = STTVerifierResult;
export const runEnsembleSTT = runVerifiedSTT;
