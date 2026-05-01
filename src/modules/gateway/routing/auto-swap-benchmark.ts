// ── BabelCast Gateway — Auto-Swap Language Detection Benchmark ───────────────
// Pure benchmark runner for the detectLanguageWithSwap function. Computes
// accuracy, p50/p95 latency, and false positive/negative counts for a set of
// test phrases. Callers pass in the detection function to keep this module
// dependency-free.

export interface BenchmarkPhrase {
  text: string;
  expectedLang: string;
}

export interface BenchmarkRowResult {
  text: string;
  expectedLang: string;
  detectedLang: string;
  confidence: number;
  shouldSwap: boolean;
  correct: boolean;
  latencyMs: number;
}

export interface BenchmarkSummary {
  totalPhrases: number;
  relevantPhrases: number;
  correctCount: number;
  accuracy: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalMs: number;
  swapDetections: number;
  falsePositives: number;
  falseNegatives: number;
  source: string;
  target: string;
  results: BenchmarkRowResult[];
}

export type DetectWithSwapFn = (
  text: string, source: string, target: string, minConfidence: number,
) => { detected: { language: string; confidence: number }; shouldSwap: boolean };

/**
 * Run auto-swap benchmark over a list of phrases.
 * Returns per-row results plus aggregate accuracy/latency/fp/fn stats.
 */
export function runAutoSwapBenchmark(opts: {
  phrases: BenchmarkPhrase[];
  source: string;
  target: string;
  minConfidence: number;
  detect: DetectWithSwapFn;
}): BenchmarkSummary {
  const { phrases, source, target, minConfidence, detect } = opts;
  const results: BenchmarkRowResult[] = [];
  const t0 = Date.now();

  for (const phrase of phrases) {
    const pt = Date.now();
    const { detected, shouldSwap } = detect(phrase.text, source, target, minConfidence);
    const latencyMs = Date.now() - pt;

    const isRelevant = phrase.expectedLang === source || phrase.expectedLang === target;
    const correct = isRelevant
      ? detected.language === phrase.expectedLang
      : detected.language !== '';

    results.push({
      text: phrase.text,
      expectedLang: phrase.expectedLang,
      detectedLang: detected.language,
      confidence: detected.confidence,
      shouldSwap,
      correct,
      latencyMs,
    });
  }

  const totalMs = Date.now() - t0;
  const relevantResults = results.filter(r => r.expectedLang === source || r.expectedLang === target);
  const correctCount = relevantResults.filter(r => r.correct).length;
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const avgLatencyMs = latencies.length > 0
    ? Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length)
    : 0;
  const p95LatencyMs = latencies.length > 0
    ? latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)]
    : 0;
  const swapDetections = results.filter(r => r.shouldSwap).length;
  const falsePositives = results.filter(r => r.expectedLang === source && r.detectedLang === target).length;
  const falseNegatives = results.filter(r => r.expectedLang === target && r.detectedLang === source).length;

  return {
    totalPhrases: phrases.length,
    relevantPhrases: relevantResults.length,
    correctCount,
    accuracy: relevantResults.length > 0 ? correctCount / relevantResults.length : 0,
    avgLatencyMs,
    p95LatencyMs,
    totalMs,
    swapDetections,
    falsePositives,
    falseNegatives,
    source,
    target,
    results,
  };
}
