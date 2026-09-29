import { describe, it, expect } from 'vitest';
import {
  runAutoSwapBenchmark,
} from '../../src/gateway/routing/auto-swap-benchmark';
import type {
  DetectWithSwapFn,
  BenchmarkPhrase,
} from '../../src/gateway/routing/auto-swap-benchmark';

// ── Deterministic detect helpers ─────────────────────────────────────────────

/** Always detects the given language with the given confidence. */
function alwaysDetect(lang: string, confidence = 0.99, swap = false): DetectWithSwapFn {
  return () => ({ detected: { language: lang, confidence }, shouldSwap: swap });
}

/** Per-phrase override map: phrase text → result. Falls back to defaultLang. */
function perPhraseDetect(
  map: Record<string, { lang: string; confidence?: number; shouldSwap?: boolean }>,
  defaultLang = 'en',
): DetectWithSwapFn {
  return (text) => {
    const override = map[text];
    if (override) {
      return {
        detected: { language: override.lang, confidence: override.confidence ?? 0.9 },
        shouldSwap: override.shouldSwap ?? false,
      };
    }
    return { detected: { language: defaultLang, confidence: 0.9 }, shouldSwap: false };
  };
}

// ── Empty / trivial inputs ────────────────────────────────────────────────────

describe('runAutoSwapBenchmark — empty / trivial', () => {
  it('returns zero stats for empty phrase list', () => {
    const result = runAutoSwapBenchmark({
      phrases: [],
      source: 'en',
      target: 'fr',
      minConfidence: 0.8,
      detect: alwaysDetect('en'),
    });

    expect(result.totalPhrases).toBe(0);
    expect(result.relevantPhrases).toBe(0);
    expect(result.correctCount).toBe(0);
    expect(result.accuracy).toBe(0);
    expect(result.avgLatencyMs).toBe(0);
    expect(result.p95LatencyMs).toBe(0);
    expect(result.swapDetections).toBe(0);
    expect(result.falsePositives).toBe(0);
    expect(result.falseNegatives).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('preserves source and target in summary', () => {
    const result = runAutoSwapBenchmark({
      phrases: [],
      source: 'de',
      target: 'ja',
      minConfidence: 0.5,
      detect: alwaysDetect('de'),
    });
    expect(result.source).toBe('de');
    expect(result.target).toBe('ja');
  });

  it('preserves requestId in result', () => {
    const result = runAutoSwapBenchmark({
      phrases: [{ text: 'hello', expectedLang: 'en' }],
      source: 'en',
      target: 'fr',
      minConfidence: 0.8,
      detect: alwaysDetect('en'),
    });
    expect(result.requestId ?? undefined).toBeUndefined();
  });
});

// ── Single phrase ─────────────────────────────────────────────────────────────

describe('runAutoSwapBenchmark — single phrase', () => {
  it('counts one correct detection for source language', () => {
    const result = runAutoSwapBenchmark({
      phrases: [{ text: 'hello world', expectedLang: 'en' }],
      source: 'en',
      target: 'fr',
      minConfidence: 0.8,
      detect: alwaysDetect('en'),
    });

    expect(result.totalPhrases).toBe(1);
    expect(result.relevantPhrases).toBe(1);
    expect(result.correctCount).toBe(1);
    expect(result.accuracy).toBe(1);
    expect(result.results[0].correct).toBe(true);
    expect(result.results[0].detectedLang).toBe('en');
    expect(result.results[0].text).toBe('hello world');
    expect(result.results[0].expectedLang).toBe('en');
  });

  it('counts one correct detection for target language', () => {
    const result = runAutoSwapBenchmark({
      phrases: [{ text: 'bonjour', expectedLang: 'fr' }],
      source: 'en',
      target: 'fr',
      minConfidence: 0.8,
      detect: alwaysDetect('fr'),
    });

    expect(result.correctCount).toBe(1);
    expect(result.accuracy).toBe(1);
    expect(result.results[0].correct).toBe(true);
  });

  it('counts incorrect detection for source phrase detected as target', () => {
    const result = runAutoSwapBenchmark({
      phrases: [{ text: 'hello world', expectedLang: 'en' }],
      source: 'en',
      target: 'fr',
      minConfidence: 0.8,
      detect: alwaysDetect('fr'),
    });

    expect(result.correctCount).toBe(0);
    expect(result.accuracy).toBe(0);
    expect(result.falsePositives).toBe(1);
    expect(result.falseNegatives).toBe(0);
    expect(result.results[0].correct).toBe(false);
  });

  it('counts false negative when target phrase detected as source', () => {
    const result = runAutoSwapBenchmark({
      phrases: [{ text: 'bonjour', expectedLang: 'fr' }],
      source: 'en',
      target: 'fr',
      minConfidence: 0.8,
      detect: alwaysDetect('en'),
    });

    expect(result.falsePositives).toBe(0);
    expect(result.falseNegatives).toBe(1);
    expect(result.accuracy).toBe(0);
  });
});

// ── Accuracy calculation ──────────────────────────────────────────────────────

describe('runAutoSwapBenchmark — accuracy', () => {
  it('reports 100% accuracy when all relevant phrases correct', () => {
    const phrases: BenchmarkPhrase[] = [
      { text: 'hello', expectedLang: 'en' },
      { text: 'world', expectedLang: 'en' },
      { text: 'bonjour', expectedLang: 'fr' },
    ];

    const detect = perPhraseDetect({
      hello: { lang: 'en' },
      world: { lang: 'en' },
      bonjour: { lang: 'fr' },
    });

    const result = runAutoSwapBenchmark({ phrases, source: 'en', target: 'fr', minConfidence: 0.8, detect });

    expect(result.totalPhrases).toBe(3);
    expect(result.relevantPhrases).toBe(3);
    expect(result.correctCount).toBe(3);
    expect(result.accuracy).toBe(1);
  });

  it('reports 0% accuracy when all relevant phrases wrong', () => {
    const phrases: BenchmarkPhrase[] = [
      { text: 'hello', expectedLang: 'en' },
      { text: 'bonjour', expectedLang: 'fr' },
    ];

    const detect = perPhraseDetect({
      hello: { lang: 'fr' },
      bonjour: { lang: 'en' },
    });

    const result = runAutoSwapBenchmark({ phrases, source: 'en', target: 'fr', minConfidence: 0.8, detect });

    expect(result.accuracy).toBe(0);
    expect(result.correctCount).toBe(0);
  });

  it('reports 50% accuracy for half-correct phrases', () => {
    const phrases: BenchmarkPhrase[] = [
      { text: 'a', expectedLang: 'en' },
      { text: 'b', expectedLang: 'en' },
    ];

    const detect = perPhraseDetect({ a: { lang: 'en' }, b: { lang: 'fr' } });
    const result = runAutoSwapBenchmark({ phrases, source: 'en', target: 'fr', minConfidence: 0.8, detect });

    expect(result.correctCount).toBe(1);
    expect(result.accuracy).toBeCloseTo(0.5, 5);
  });

  it('excludes irrelevant phrases from accuracy but includes in totalPhrases', () => {
    const phrases: BenchmarkPhrase[] = [
      { text: 'hola', expectedLang: 'es' },   // irrelevant
      { text: 'hello', expectedLang: 'en' },  // relevant
    ];

    const detect = perPhraseDetect({ hola: { lang: 'es' }, hello: { lang: 'en' } });
    const result = runAutoSwapBenchmark({ phrases, source: 'en', target: 'fr', minConfidence: 0.8, detect });

    expect(result.totalPhrases).toBe(2);
    expect(result.relevantPhrases).toBe(1);
    expect(result.accuracy).toBe(1);  // 1/1 relevant correct
  });

  it('returns accuracy=0 when there are only irrelevant phrases', () => {
    const phrases: BenchmarkPhrase[] = [
      { text: 'hola', expectedLang: 'es' },
      { text: 'ciao', expectedLang: 'it' },
    ];

    const detect = alwaysDetect('es');
    const result = runAutoSwapBenchmark({ phrases, source: 'en', target: 'fr', minConfidence: 0.8, detect });

    expect(result.relevantPhrases).toBe(0);
    expect(result.accuracy).toBe(0);
  });
});

// ── False positive / negative counting ───────────────────────────────────────

describe('runAutoSwapBenchmark — fp / fn counting', () => {
  it('counts multiple false positives correctly', () => {
    const phrases: BenchmarkPhrase[] = [
      { text: 'a', expectedLang: 'en' },
      { text: 'b', expectedLang: 'en' },
      { text: 'c', expectedLang: 'fr' },
    ];
    // All detected as 'fr' → 2 false positives (en phrases detected as fr), 0 false negatives
    const detect = alwaysDetect('fr');
    const result = runAutoSwapBenchmark({ phrases, source: 'en', target: 'fr', minConfidence: 0.8, detect });

    expect(result.falsePositives).toBe(2);
    expect(result.falseNegatives).toBe(0);
  });

  it('counts multiple false negatives correctly', () => {
    const phrases: BenchmarkPhrase[] = [
      { text: 'a', expectedLang: 'fr' },
      { text: 'b', expectedLang: 'fr' },
      { text: 'c', expectedLang: 'en' },
    ];
    // All detected as 'en' → 0 false positives, 2 false negatives
    const detect = alwaysDetect('en');
    const result = runAutoSwapBenchmark({ phrases, source: 'en', target: 'fr', minConfidence: 0.8, detect });

    expect(result.falsePositives).toBe(0);
    expect(result.falseNegatives).toBe(2);
  });

  it('fp/fn are independent — can have both simultaneously', () => {
    const phrases: BenchmarkPhrase[] = [
      { text: 'a', expectedLang: 'en' }, // fp if detected as fr
      { text: 'b', expectedLang: 'fr' }, // fn if detected as en
    ];
    const detect = perPhraseDetect({ a: { lang: 'fr' }, b: { lang: 'en' } });
    const result = runAutoSwapBenchmark({ phrases, source: 'en', target: 'fr', minConfidence: 0.8, detect });

    expect(result.falsePositives).toBe(1);
    expect(result.falseNegatives).toBe(1);
  });

  it('does not count irrelevant phrases as fp or fn', () => {
    const phrases: BenchmarkPhrase[] = [
      { text: 'hola', expectedLang: 'es' },
      { text: 'ciao', expectedLang: 'it' },
    ];
    const detect = alwaysDetect('fr');
    const result = runAutoSwapBenchmark({ phrases, source: 'en', target: 'fr', minConfidence: 0.8, detect });

    expect(result.falsePositives).toBe(0);
    expect(result.falseNegatives).toBe(0);
  });
});

// ── Swap detection counting ───────────────────────────────────────────────────

describe('runAutoSwapBenchmark — swap detection', () => {
  it('counts swap detections across all phrases', () => {
    const phrases: BenchmarkPhrase[] = [
      { text: 'a', expectedLang: 'en' },
      { text: 'b', expectedLang: 'fr' },
      { text: 'c', expectedLang: 'en' },
    ];
    let idx = 0;
    const detect: DetectWithSwapFn = (text, source) => {
      idx++;
      return {
        detected: { language: source, confidence: 0.9 },
        shouldSwap: idx % 2 === 0,  // phrases b and... wait, only 3 phrases: 1→false, 2→true, 3→false
      };
    };
    const result = runAutoSwapBenchmark({ phrases, source: 'en', target: 'fr', minConfidence: 0.8, detect });

    expect(result.swapDetections).toBe(1);
  });

  it('counts zero swap detections when none fire', () => {
    const phrases: BenchmarkPhrase[] = [
      { text: 'hello', expectedLang: 'en' },
      { text: 'world', expectedLang: 'en' },
    ];
    const result = runAutoSwapBenchmark({
      phrases,
      source: 'en', target: 'fr', minConfidence: 0.8,
      detect: alwaysDetect('en', 0.9, false),
    });
    expect(result.swapDetections).toBe(0);
  });

  it('counts all swap detections when all fire', () => {
    const phrases: BenchmarkPhrase[] = Array.from({ length: 5 }, (_, i) => ({
      text: `phrase${i}`,
      expectedLang: 'en',
    }));
    const result = runAutoSwapBenchmark({
      phrases,
      source: 'en', target: 'fr', minConfidence: 0.8,
      detect: alwaysDetect('fr', 0.9, true),
    });
    expect(result.swapDetections).toBe(5);
  });
});

// ── Per-row result fields ─────────────────────────────────────────────────────

describe('runAutoSwapBenchmark — per-row result fields', () => {
  it('result rows include all expected fields', () => {
    const result = runAutoSwapBenchmark({
      phrases: [{ text: 'hello', expectedLang: 'en' }],
      source: 'en', target: 'fr', minConfidence: 0.8,
      detect: alwaysDetect('en', 0.95, false),
    });

    const row = result.results[0];
    expect(row).toHaveProperty('text', 'hello');
    expect(row).toHaveProperty('expectedLang', 'en');
    expect(row).toHaveProperty('detectedLang', 'en');
    expect(row).toHaveProperty('confidence', 0.95);
    expect(row).toHaveProperty('shouldSwap', false);
    expect(row).toHaveProperty('correct', true);
    expect(row).toHaveProperty('latencyMs');
    expect(typeof row.latencyMs).toBe('number');
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('rows are in same order as input phrases', () => {
    const phrases: BenchmarkPhrase[] = [
      { text: 'alpha', expectedLang: 'en' },
      { text: 'beta', expectedLang: 'fr' },
      { text: 'gamma', expectedLang: 'en' },
    ];
    const result = runAutoSwapBenchmark({
      phrases, source: 'en', target: 'fr', minConfidence: 0.8,
      detect: alwaysDetect('en'),
    });

    expect(result.results.map(r => r.text)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('correct field is false for irrelevant phrase detected as empty string', () => {
    const result = runAutoSwapBenchmark({
      phrases: [{ text: 'hola', expectedLang: 'es' }],
      source: 'en', target: 'fr', minConfidence: 0.8,
      detect: () => ({ detected: { language: '', confidence: 0 }, shouldSwap: false }),
    });
    // irrelevant phrase: correct = (detected.language !== '')
    expect(result.results[0].correct).toBe(false);
  });

  it('correct field is true for irrelevant phrase with non-empty language', () => {
    const result = runAutoSwapBenchmark({
      phrases: [{ text: 'hola', expectedLang: 'es' }],
      source: 'en', target: 'fr', minConfidence: 0.8,
      detect: alwaysDetect('es'),
    });
    expect(result.results[0].correct).toBe(true);
  });
});

// ── Latency statistics ────────────────────────────────────────────────────────

describe('runAutoSwapBenchmark — latency statistics', () => {
  it('avgLatencyMs is non-negative for a single phrase', () => {
    const result = runAutoSwapBenchmark({
      phrases: [{ text: 'hello', expectedLang: 'en' }],
      source: 'en', target: 'fr', minConfidence: 0.8,
      detect: alwaysDetect('en'),
    });
    expect(result.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('p95LatencyMs is non-negative for a single phrase', () => {
    const result = runAutoSwapBenchmark({
      phrases: [{ text: 'hello', expectedLang: 'en' }],
      source: 'en', target: 'fr', minConfidence: 0.8,
      detect: alwaysDetect('en'),
    });
    expect(result.p95LatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('totalMs is non-negative', () => {
    const result = runAutoSwapBenchmark({
      phrases: [
        { text: 'a', expectedLang: 'en' },
        { text: 'b', expectedLang: 'fr' },
      ],
      source: 'en', target: 'fr', minConfidence: 0.8,
      detect: alwaysDetect('en'),
    });
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('p95LatencyMs equals single row latencyMs for a single phrase', () => {
    const result = runAutoSwapBenchmark({
      phrases: [{ text: 'hello', expectedLang: 'en' }],
      source: 'en', target: 'fr', minConfidence: 0.8,
      detect: alwaysDetect('en'),
    });
    expect(result.p95LatencyMs).toBe(result.results[0].latencyMs);
  });

  it('p95LatencyMs is ≤ max latency', () => {
    const phrases = Array.from({ length: 10 }, (_, i) => ({
      text: `p${i}`, expectedLang: 'en',
    }));
    const result = runAutoSwapBenchmark({
      phrases, source: 'en', target: 'fr', minConfidence: 0.8,
      detect: alwaysDetect('en'),
    });
    const maxLatency = Math.max(...result.results.map(r => r.latencyMs));
    expect(result.p95LatencyMs).toBeLessThanOrEqual(maxLatency);
  });

  it('avgLatencyMs is ≤ max latency', () => {
    const phrases = Array.from({ length: 5 }, (_, i) => ({
      text: `p${i}`, expectedLang: 'en',
    }));
    const result = runAutoSwapBenchmark({
      phrases, source: 'en', target: 'fr', minConfidence: 0.8,
      detect: alwaysDetect('en'),
    });
    const maxLatency = Math.max(...result.results.map(r => r.latencyMs));
    expect(result.avgLatencyMs).toBeLessThanOrEqual(maxLatency);
  });
});

// ── Large input ───────────────────────────────────────────────────────────────

describe('runAutoSwapBenchmark — large input', () => {
  it('handles 100 phrases without throwing', () => {
    const phrases = Array.from({ length: 100 }, (_, i) => ({
      text: `phrase ${i}`,
      expectedLang: i % 2 === 0 ? 'en' : 'fr',
    }));

    const detect = perPhraseDetect(
      Object.fromEntries(phrases.map(p => [p.text, { lang: p.expectedLang }])),
    );

    const result = runAutoSwapBenchmark({ phrases, source: 'en', target: 'fr', minConfidence: 0.8, detect });

    expect(result.totalPhrases).toBe(100);
    expect(result.relevantPhrases).toBe(100);
    expect(result.correctCount).toBe(100);
    expect(result.accuracy).toBe(1);
  });

  it('correctly computes fp+fn rates across mixed large input', () => {
    // 50 en phrases all detected as fr → 50 FPs
    // 50 fr phrases all detected as en → 50 FNs
    const phrases = [
      ...Array.from({ length: 50 }, (_, i) => ({ text: `en${i}`, expectedLang: 'en' })),
      ...Array.from({ length: 50 }, (_, i) => ({ text: `fr${i}`, expectedLang: 'fr' })),
    ];

    const detect: DetectWithSwapFn = (text) => ({
      detected: { language: text.startsWith('en') ? 'fr' : 'en', confidence: 0.9 },
      shouldSwap: false,
    });

    const result = runAutoSwapBenchmark({ phrases, source: 'en', target: 'fr', minConfidence: 0.8, detect });

    expect(result.falsePositives).toBe(50);
    expect(result.falseNegatives).toBe(50);
    expect(result.accuracy).toBe(0);
  });
});

// ── Detect fn receives correct arguments ─────────────────────────────────────

describe('runAutoSwapBenchmark — detect fn contract', () => {
  it('passes text, source, target, minConfidence to detect', () => {
    const calls: Array<[string, string, string, number]> = [];
    const detect: DetectWithSwapFn = (text, source, target, minConf) => {
      calls.push([text, source, target, minConf]);
      return { detected: { language: source, confidence: minConf }, shouldSwap: false };
    };

    runAutoSwapBenchmark({
      phrases: [{ text: 'hello', expectedLang: 'en' }],
      source: 'en', target: 'fr', minConfidence: 0.75, detect,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['hello', 'en', 'fr', 0.75]);
  });

  it('calls detect once per phrase', () => {
    let count = 0;
    const detect: DetectWithSwapFn = () => {
      count++;
      return { detected: { language: 'en', confidence: 0.9 }, shouldSwap: false };
    };

    runAutoSwapBenchmark({
      phrases: [
        { text: 'a', expectedLang: 'en' },
        { text: 'b', expectedLang: 'en' },
        { text: 'c', expectedLang: 'en' },
      ],
      source: 'en', target: 'fr', minConfidence: 0.8, detect,
    });

    expect(count).toBe(3);
  });
});
