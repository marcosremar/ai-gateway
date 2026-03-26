/**
 * STT Verifier — Integration Benchmark
 *
 * Generates real French speech via gTTS, runs through OpenAI + Deepgram,
 * and shows detailed benchmark: latency, WER, Jaccard/embedding scores.
 *
 * Requirements:
 *   - Python + gTTS installed  (pip install gtts)
 *   - OPENAI_API_KEY           (gpt-4o-transcribe)
 *   - DEEPGRAM_API_KEY         (nova-3)
 *   - OPENROUTER_API_KEY       (optional — qwen3 embedding fallback)
 *
 * Run: bun run test __tests__/stt-verifier-benchmark.test.ts --reporter=verbose
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { runVerifiedSTT } from '../src/ensemble-stt';
import type { STTVerifierProviderEntry } from '../src/ensemble-stt';
import { openaiSTT } from '../src/providers/openai';
import { deepgramSTT } from '../src/providers/deepgram';
import { openrouterQwen3Embedding } from '../src/providers/openrouter/openrouter-embedding';
import { openaiEmbedding } from '../src/providers/openai/openai-embedding';
import type { EmbeddingProvider } from '../src/providers/openai-compat/openai-compat-embedding';
import { loadEnv } from './helpers';

beforeAll(() => loadEnv());

// ─── Phrases to benchmark ────────────────────────────────────────────────────

const PHRASES = [
  { id: 'greeting',   lang: 'fr', text: 'Bonjour, je voudrais un café s\'il vous plaît.' },
  { id: 'date',       lang: 'fr', text: 'La réunion est prévue le quinze mars à quatorze heures.' },
  { id: 'technical',  lang: 'fr', text: 'Le modèle génère des sous-titres en temps réel avec une faible latence.' },
  { id: 'casual',     lang: 'fr', text: 'C\'est absolument formidable, n\'est-ce pas mon ami?' },
  { id: 'names',      lang: 'fr', text: 'François travaille comme ingénieur dans une grande entreprise à Paris.' },
  { id: 'short',      lang: 'fr', text: 'Merci beaucoup.' },
  { id: 'long',       lang: 'fr', text: 'L\'intelligence artificielle transforme notre façon de communiquer et de travailler ensemble dans le monde moderne.' },
  { id: 'numbers',    lang: 'fr', text: 'Il y a quatre-vingt-dix-neuf problèmes mais la transcription n\'en est pas un.' },
  { id: 'english',    lang: 'en', text: 'The speech recognition system works remarkably well for both French and English.' },
  { id: 'mixed_ctx',  lang: 'fr', text: 'Le GPU RTX cinq mille quatre-vingt-dix est très puissant pour l\'IA.' },
];

// ─── Audio generation via gTTS ───────────────────────────────────────────────

// Resolve Python from .venv if available, fall back to system python3
const PYTHON = (() => {
  const venv = new URL('../../.venv/bin/python3', import.meta.url).pathname;
  return require('fs').existsSync(venv) ? venv : 'python3';
})();

async function generateGTTS(text: string, lang: string): Promise<Buffer> {
  const tmpPath = `/tmp/gtts_bench_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`;
  try {
    const escapedText = text.replace(/'/g, "\\'").replace(/"/g, '\\"');
    const proc = Bun.spawn(
      [PYTHON, '-c', `from gtts import gTTS; gTTS("${escapedText}", lang="${lang}").save("${tmpPath}")`],
      { stderr: 'pipe' },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`gTTS failed (exit ${exitCode}): ${err.slice(0, 200)}`);
    }
    const buf = readFileSync(tmpPath);
    return buf;
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
}

// ─── WER helpers ─────────────────────────────────────────────────────────────

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s\u00C0-\u017E]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Simple Word Error Rate: (S+D+I) / N using Levenshtein on word sequences */
function wer(ref: string, hyp: string): number {
  const r = normalize(ref);
  const h = normalize(hyp);
  if (r.length === 0) return h.length === 0 ? 0 : 1;

  // Levenshtein distance on word arrays
  const dp: number[][] = Array.from({ length: r.length + 1 }, (_, i) =>
    Array.from({ length: h.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0),
  );
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      dp[i][j] = r[i - 1] === h[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[r.length][h.length] / r.length;
}

function werLabel(w: number): string {
  if (w <= 0.05) return '✅ excellent';
  if (w <= 0.15) return '✓  good';
  if (w <= 0.30) return '⚠  fair';
  return '✗  poor';
}

// ─── Benchmark runner ────────────────────────────────────────────────────────

interface ProviderResult {
  name: string;
  text: string;
  latencyMs: number;
  werScore: number;
}

interface PhraseResult {
  id: string;
  text: string;
  lang: string;
  audioSizeKb: number;
  providers: ProviderResult[];
  timedOutProviders: string[];
  consensus: string;
  consensusWer: number;
  similarityMethod: string;
  embeddingProvider?: string;
  scores: Record<string, number>;
  outliers: string[];
  totalMs: number;
  timeoutMs: number;
  fanOutMs: number;
}

async function runBenchmark(
  phrase: { id: string; lang: string; text: string },
  providers: STTVerifierProviderEntry[],
  embeddingFallbacks: Parameters<typeof runVerifiedSTT>[3]['embeddingFallbacks'],
  timeoutMs = 8000,
): Promise<PhraseResult> {
  const audio = await generateGTTS(phrase.text, phrase.lang);

  // Measure per-provider latency (uncapped — to see real individual latencies)
  const perProviderResults = await Promise.allSettled(
    providers.map(async ({ name, provider }) => {
      const t = Date.now();
      const modelId = provider.getModels()[0]?.id ?? '';
      const r = await provider.transcribe({ audio, model: modelId, language: phrase.lang });
      return { name, text: r.text, latencyMs: Date.now() - t };
    }),
  );

  const providerResults: ProviderResult[] = [];
  for (const r of perProviderResults) {
    if (r.status === 'fulfilled') {
      providerResults.push({
        name: r.value.name,
        text: r.value.text,
        latencyMs: r.value.latencyMs,
        werScore: wer(phrase.text, r.value.text),
      });
    }
  }

  // Which providers would be cut at the given timeout?
  const timedOutProviders = providerResults
    .filter(p => p.latencyMs > timeoutMs)
    .map(p => p.name);

  // Full ensemble with the real-time timeout applied
  const t0 = Date.now();
  const result = await runVerifiedSTT(audio, phrase.lang, '', {
    providers,
    embeddingFallbacks,
    timeoutMs,
  });
  const totalMs = Date.now() - t0;

  return {
    id: phrase.id,
    text: phrase.text,
    lang: phrase.lang,
    audioSizeKb: Math.round(audio.length / 1024),
    providers: providerResults,
    timedOutProviders,
    consensus: result.consensus,
    consensusWer: wer(phrase.text, result.consensus),
    similarityMethod: result.similarity_method,
    embeddingProvider: result.embedding_provider,
    scores: result.scores,
    outliers: result.outliers,
    totalMs,
    timeoutMs,
    fanOutMs: result.latency_ms ?? 0,
  };
}

// ─── Print helpers ───────────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function printBenchmarkTable(results: PhraseResult[]): void {
  console.log('\n' + '═'.repeat(100));
  console.log('  STT VERIFIER BENCHMARK — Detailed Results');
  console.log('═'.repeat(100));

  for (const r of results) {
    console.log(`\n▸ [${r.id.toUpperCase()}] "${r.text}"`);
    console.log(`  Audio: ${r.audioSizeKb}KB ${r.lang.toUpperCase()} | Total (with ${r.timeoutMs}ms budget): ${r.totalMs}ms`);
    console.log(`  Similarity method: ${r.similarityMethod}${r.embeddingProvider ? ` (${r.embeddingProvider})` : ''}`);
    if (r.timedOutProviders.length > 0) console.log(`  ✂ Cut by ${r.timeoutMs}ms timeout: ${r.timedOutProviders.join(', ')}`);
    if (r.outliers.length > 0) console.log(`  ⚠ Outliers: ${r.outliers.join(', ')}`);

    console.log('  ' + '─'.repeat(80));
    console.log(`  ${pad('Provider', 12)} ${pad('Latency', 12)} ${pad('WER', 14)} ${pad('Score', 8)} Transcription`);
    console.log('  ' + '─'.repeat(84));

    for (const p of r.providers) {
      const score = r.scores[p.name] ?? '-';
      const scoreStr = typeof score === 'number' ? score.toFixed(3) : '-';
      const werStr = `${(p.werScore * 100).toFixed(1)}% ${werLabel(p.werScore)}`;
      const cut = r.timedOutProviders.includes(p.name) ? ' ✂' : '  ';
      const truncated = p.text.length > 45 ? p.text.slice(0, 42) + '...' : p.text;
      const latTag = `${p.latencyMs}ms${cut}`;
      console.log(`  ${pad(p.name, 12)} ${pad(latTag, 12)} ${pad(werStr, 14)} ${pad(scoreStr, 8)} "${truncated}"`);
    }

    console.log('  ' + '─'.repeat(84));
    const cWerStr = `${(r.consensusWer * 100).toFixed(1)}% ${werLabel(r.consensusWer)}`;
    const cTrunc = r.consensus.length > 45 ? r.consensus.slice(0, 42) + '...' : r.consensus;
    console.log(`  ${pad('CONSENSUS', 12)} ${pad('', 12)} ${pad(cWerStr, 14)} ${pad('', 8)} "${cTrunc}"`);
  }

  // Summary table
  console.log('\n' + '═'.repeat(100));
  console.log('  SUMMARY');
  console.log('═'.repeat(100));
  console.log(`  ${pad('Phrase', 14)} ${pad('Method', 10)} ${pad('Total', 8)} ${pad('Timeout', 9)} ${pad('Cut', 12)} ${pad('Consensus WER', 15)} Providers`);
  console.log('  ' + '─'.repeat(90));

  let totalWer = 0;
  let jaccardCount = 0;
  let embeddingCount = 0;
  let totalFanOut = 0;

  for (const r of results) {
    const method = r.similarityMethod === 'embedding'
      ? `emb`
      : 'jac';
    if (r.similarityMethod === 'embedding') embeddingCount++;
    else jaccardCount++;
    totalWer += r.consensusWer;
    totalFanOut += r.fanOutMs;

    const cWerStr = `${(r.consensusWer * 100).toFixed(1)}% ${werLabel(r.consensusWer)}`;
    const providerNames = r.providers.map(p => p.name).join('+');
    const cutStr = r.timedOutProviders.length > 0 ? `✂ ${r.timedOutProviders.join(',')}` : '-';
    console.log(
      `  ${pad(r.id, 14)} ${pad(method, 10)} ${pad(r.totalMs + 'ms', 8)} ` +
      `${pad(r.timeoutMs + 'ms', 9)} ${pad(cutStr, 12)} ${pad(cWerStr, 15)} ${providerNames}`,
    );
  }

  const avgWer = (totalWer / results.length * 100).toFixed(1);
  const totalCut = results.reduce((s, r) => s + r.timedOutProviders.length, 0);
  const avgTotal = Math.round(results.reduce((s, r) => s + r.totalMs, 0) / results.length);
  console.log('  ' + '─'.repeat(90));
  console.log(`  ${'AVERAGE'.padEnd(14)} ${''.padEnd(10)} ${(avgTotal + 'ms').padEnd(8)} ${''.padEnd(9)} ${(totalCut + ' total').padEnd(12)} Avg WER: ${avgWer}%`);
  console.log(`  Methods used: Jaccard=${jaccardCount} | Embedding=${embeddingCount} | Providers cut by timeout: ${totalCut}`);
  console.log('═'.repeat(100) + '\n');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const hasOpenAI = !!process.env.OPENAI_API_KEY;
const hasDeepgram = !!process.env.DEEPGRAM_API_KEY;
const hasAtLeastTwo = hasOpenAI && hasDeepgram;
const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;

describe.skipIf(!hasAtLeastTwo)('STT Verifier — Integration Benchmark (Real APIs)', () => {
  let allResults: PhraseResult[] = [];

  const activeProviders: STTVerifierProviderEntry[] = [];
  if (hasOpenAI) activeProviders.push({ name: 'openai', provider: openaiSTT });
  if (hasDeepgram) activeProviders.push({ name: 'deepgram', provider: deepgramSTT });

  const embeddingFallbacks: EmbeddingProvider[] = [];
  if (hasOpenRouter) embeddingFallbacks.push(openrouterQwen3Embedding);
  if (hasOpenAI) embeddingFallbacks.push(openaiEmbedding);

  // Real-time budget for production use
  const REALTIME_TIMEOUT_MS = 1500;

  it.each(PHRASES)('[$id] $text', async ({ id, lang, text }) => {
    // Run with realtime timeout (production mode)
    const result = await runBenchmark(
      { id, lang, text },
      activeProviders,
      embeddingFallbacks as EmbeddingProvider[],
      REALTIME_TIMEOUT_MS,
    );
    allResults.push(result);

    // Basic assertions
    expect(result.consensus).toBeTruthy();
    expect(result.providers.length).toBeGreaterThanOrEqual(1);
    expect(result.totalMs).toBeLessThan(15_000);
    expect(result.consensusWer).toBeLessThan(0.60); // at least 40% words correct

    console.log(
      `[${id}] ${result.similarityMethod} | ${result.fanOutMs}ms fan-out | ` +
      `WER ${(result.consensusWer * 100).toFixed(0)}% | "${result.consensus.slice(0, 60)}"`,
    );
  }, 20_000);

  it('prints full benchmark report', () => {
    if (allResults.length === 0) {
      console.log('No results collected yet — run individual phrase tests first');
      return;
    }
    printBenchmarkTable(allResults);

    // Aggregate assertions
    const avgWer = allResults.reduce((s, r) => s + r.consensusWer, 0) / allResults.length;
    expect(avgWer).toBeLessThan(0.25); // average < 25% WER across all phrases
  });
});

describe.skipIf(!hasOpenAI || !hasDeepgram)('STT Verifier — Embedding Fallback Trigger (Real APIs)', () => {
  it('detects low-confidence Jaccard and triggers embedding fallback', async () => {
    // Use a very high embeddingFallbackThreshold to force the embedding path
    const audio = await generateGTTS('Bonjour, comment allez-vous aujourd\'hui?', 'fr');

    const providers: STTVerifierProviderEntry[] = [
      { name: 'openai', provider: openaiSTT },
      { name: 'deepgram', provider: deepgramSTT },
    ];

    const fallbacks = hasOpenRouter
      ? [openrouterQwen3Embedding, openaiEmbedding]
      : [openaiEmbedding];

    const result = await runVerifiedSTT(audio, 'fr', '', {
      providers,
      embeddingFallbacks: fallbacks,
      embeddingFallbackThreshold: 2.0,  // > 1.0 always triggers (Jaccard max is 1.0)
      embeddingOutlierThreshold: 0.60,
    });

    console.log(`\nForced embedding path:`);
    console.log(`  Method: ${result.similarity_method}`);
    console.log(`  Provider: ${result.embedding_provider ?? 'n/a'}`);
    console.log(`  Consensus: "${result.consensus}"`);
    console.log(`  Scores:`, result.scores);
    console.log(`  Latency: ${result.latency_ms}ms`);

    expect(result.similarity_method).toBe('embedding');
    expect(result.embedding_provider).toBeTruthy();
    expect(result.consensus).toBeTruthy();
  }, 20_000);
});
