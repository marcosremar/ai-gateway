// ── BabelCast Gateway — Full Path Benchmark ──────────────────────────────────
// Single comprehensive benchmark that tests everything:
//   Phase 1+2: Per-stage provider comparison — ALL configured providers per stage
//              with cold start / warm separation and TTFAC for TTS
//   Phase 3:   Pipeline progression — sequential /v1/speech requests tracking
//              real routing decisions, latency convergence, and GPU warmth over time
//   Phase 4:   Analysis — all path combinations, best TTFAC, recommendation

import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { deployState, gpuModelWarmth } from './state';
import type { GpuModelWarmth } from './state';
import {
  client, groqDefaults, ollamaDefaults,
  groqAvailable, ollamaAvailable, openaiAvailable,
  deepgramAvailable, fireworksAvailable,
  groqSTT, openaiSTT, fireworksSTT, deepgramSTT,
  groqLLM, fireworksLLM,
  groqTTS, openaiTTS, modalTTS, modalMossTTS,
  ttfacTracker, performanceRanker,
} from './providers';
import type { AIProfile } from '../src/client';
import type { STTProvider, LLMProvider, TTSProvider } from '../src/providers/types';
import { readJsonBody, getOrCreateRequestId, setRequestIdHeader, langNames } from './http-utils';
import { PORT } from './config';

// ── Types ───────────────────────────────────────────────────────────────────

type StageName = 'stt' | 'llm' | 'tts';

interface ProviderResult {
  available: boolean;
  warm: boolean;
  latencies: number[];
  avg: number;
  p95: number;
  min: number;
  errors: number;
  errorMessages?: string[];
  // Cold start detection
  coldMs: number;      // first iteration latency
  warmAvg: number;     // avg of iterations 2+
  coldPenaltyMs: number; // coldMs - warmAvg (positive = cold start exists)
  // TTS only: Time to First Audio Chunk
  ttfacLatencies?: number[];
  ttfacAvg?: number;
  ttfacP95?: number;
  ttfacMin?: number;
}

interface StageResult {
  providers: Record<string, ProviderResult>;
  fastest: string | null;
  fastestWarm: string | null; // fastest by warm latency (ignoring cold start)
}

interface PathResult {
  totalAvg: number;
  ttfacAvg?: number;
  warmTotalAvg: number;    // using warm latencies (excludes cold start)
  warmTtfacAvg?: number;
  description: string;
  stages: Record<string, string>; // stage → provider
}

interface PipelineIteration {
  index: number;
  totalMs: number;
  sttMs: number;
  llmMs: number;
  ttsMs: number;
  ttfacMs: number;
  usedGpu: boolean;
  transcription: string;
  translation: string;
  hasAudio: boolean;
  error?: string;
}

interface ProgressionResult {
  warmupIterations: PipelineIteration[];
  measuredIterations: PipelineIteration[];
  trend: {
    firstHalfAvg: number;
    secondHalfAvg: number;
    improvementPct: number;
  };
  coldStartPenalty: {
    firstCallMs: number;
    warmAvgMs: number;
    penaltyMs: number;
  };
  perStageTrend: Record<string, { first: number; last: number; delta: number }>;
}

interface FullBenchmarkResponse {
  timestamp: string;
  gpuStatus: {
    available: boolean;
    endpoint: string;
    gpuType: string;
    dockerImage: string;
    provider: string;
    warmth: GpuModelWarmth;
  };
  stages: Record<StageName, StageResult>;
  paths: Record<string, PathResult>;
  recommendation: {
    path: string;
    reason: string;
    estimatedTotalMs: number;
    estimatedTtfacMs: number;
    warmTotalMs: number;
    warmTtfacMs: number;
    routing: Record<string, string>;
  };
  progression: ProgressionResult | null;
  durationMs: number;
  notes: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function hasGpuEndpoint(): boolean {
  return deployState.status === 'ready' && !!deployState.endpoint;
}

function computeP95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

function computeAvg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function buildProviderResult(
  available: boolean, warm: boolean, latencies: number[], errors: number, errorMessages: string[],
  ttfacLatencies?: number[],
): ProviderResult {
  const coldMs = latencies[0] || 0;
  const warmLats = latencies.slice(1);
  const warmAvg = warmLats.length > 0 ? computeAvg(warmLats) : coldMs;
  const result: ProviderResult = {
    available, warm, latencies,
    avg: computeAvg(latencies),
    p95: computeP95(latencies),
    min: latencies.length > 0 ? Math.min(...latencies) : 0,
    errors,
    coldMs,
    warmAvg,
    coldPenaltyMs: coldMs - warmAvg,
    ...(errorMessages.length > 0 ? { errorMessages } : {}),
  };
  if (ttfacLatencies && ttfacLatencies.length > 0) {
    result.ttfacLatencies = ttfacLatencies;
    result.ttfacAvg = computeAvg(ttfacLatencies);
    result.ttfacP95 = computeP95(ttfacLatencies);
    result.ttfacMin = Math.min(...ttfacLatencies);
  }
  return result;
}

function loadTestAudio(): { buffer: Buffer; mimeType: string; fileName: string } | null {
  const dir = process.cwd();
  const candidates = [
    { path: `${dir}/test_audio_sdk_test.wav`, mime: 'audio/wav', name: 'audio.wav' },
    { path: `${dir}/test_audio.mp3`, mime: 'audio/mpeg', name: 'audio.mp3' },
  ];
  for (const c of candidates) {
    if (existsSync(c.path)) {
      try {
        const buf = readFileSync(c.path);
        if (buf.length > 0) return { buffer: buf, mimeType: c.mime, fileName: c.name };
      } catch { /* skip */ }
    }
  }
  return null;
}

function getLangName(code: string): string {
  return langNames[code] || code;
}

/** Read response body via stream, returning time to first chunk and total time */
async function readWithTTFAC(response: Response, t0: number): Promise<{ ttfacMs: number; totalMs: number }> {
  const reader = response.body?.getReader();
  if (!reader) {
    await response.arrayBuffer();
    const totalMs = Date.now() - t0;
    return { ttfacMs: totalMs, totalMs };
  }
  let ttfacMs = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!ttfacMs && value?.length) ttfacMs = Date.now() - t0;
  }
  const totalMs = Date.now() - t0;
  return { ttfacMs: ttfacMs || totalMs, totalMs };
}

// ── Benchmark target interface ──────────────────────────────────────────────

interface BenchTarget {
  name: string;
  available: boolean;
  bench: (n: number) => Promise<ProviderResult>;
}

// ── STT benchmark functions ─────────────────────────────────────────────────

function sttTargets(audio: Buffer, mimeType: string, fileName: string, source: string): BenchTarget[] {
  const targets: BenchTarget[] = [];

  // GPU (Whisper on pod)
  if (hasGpuEndpoint()) {
    targets.push({
      name: 'gpu',
      available: true,
      bench: (n) => benchGpuSTT(audio, mimeType, fileName, source, n),
    });
  }

  // Groq (whisper-large-v3-turbo)
  if (groqAvailable) {
    targets.push({
      name: 'groq',
      available: true,
      bench: (n) => benchProviderSTT(groqSTT, 'whisper-large-v3-turbo', audio, source, n, true),
    });
  }

  // OpenAI (gpt-4o-transcribe)
  if (openaiAvailable) {
    targets.push({
      name: 'openai',
      available: true,
      bench: (n) => benchProviderSTT(openaiSTT, 'gpt-4o-transcribe', audio, source, n, true),
    });
  }

  // Deepgram (nova-3) — uses ai-gateway provider
  if (deepgramAvailable) {
    targets.push({
      name: 'deepgram',
      available: true,
      bench: (n) => benchProviderSTT(deepgramSTT, 'nova-3', audio, source, n, true),
    });
  }

  // Fireworks (whisper-v3)
  if (fireworksAvailable) {
    targets.push({
      name: 'fireworks',
      available: true,
      bench: (n) => benchProviderSTT(fireworksSTT, 'whisper-v3', audio, source, n, true),
    });
  }

  return targets;
}

/** GPU STT benchmark — direct to pod endpoint (self-hosted, not a cloud provider) */
async function benchGpuSTT(
  audio: Buffer, mimeType: string, fileName: string, source: string, n: number,
): Promise<ProviderResult> {
  const ep = deployState.endpoint;
  const latencies: number[] = [];
  let errors = 0;
  const msgs: string[] = [];
  for (let i = 0; i < n; i++) {
    try {
      const form = new FormData();
      form.append('file', new Blob([audio as BlobPart], { type: mimeType }), fileName);
      form.append('model', 'whisper-large-v3-turbo');
      if (source) form.append('language', source);
      const t0 = Date.now();
      const r = await fetch(`${ep}/v1/transcribe`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) { errors++; msgs.push(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); continue; }
      await r.json();
      latencies.push(Date.now() - t0);
    } catch (e) { errors++; msgs.push(e instanceof Error ? e.message : String(e)); }
  }
  return buildProviderResult(true, gpuModelWarmth.stt.warm, latencies, errors, msgs);
}

/** STT benchmark via ai-gateway provider instance (Groq, OpenAI, Deepgram, Fireworks) */
async function benchProviderSTT(
  provider: STTProvider, model: string, audio: Buffer, source: string, n: number, warm = true,
): Promise<ProviderResult> {
  const latencies: number[] = [];
  let errors = 0;
  const msgs: string[] = [];
  for (let i = 0; i < n; i++) {
    try {
      const t0 = Date.now();
      await provider.transcribe({ audio, model, language: source || undefined });
      latencies.push(Date.now() - t0);
    } catch (e) { errors++; msgs.push(e instanceof Error ? e.message : String(e)); }
  }
  return buildProviderResult(true, warm, latencies, errors, msgs);
}

// ── LLM benchmark functions ─────────────────────────────────────────────────

function llmTargets(text: string, source: string, target: string): BenchTarget[] {
  const sysPrompt = `You are a real-time translator. Translate the following ${getLangName(source)} text into natural ${getLangName(target)}. Only output the translation, nothing else.`;
  const targets: BenchTarget[] = [];

  // GPU (llama_cpp on pod)
  if (hasGpuEndpoint()) {
    targets.push({
      name: 'gpu',
      available: true,
      bench: (n) => benchGpuLLM(text, source, target, n),
    });
  }

  // Groq
  if (groqAvailable) {
    targets.push({
      name: 'groq',
      available: true,
      bench: (n) => benchProviderLLM(groqLLM, 'llama-3.3-70b-versatile', sysPrompt, text, n),
    });
  }

  // Fireworks
  if (fireworksAvailable) {
    targets.push({
      name: 'fireworks',
      available: true,
      bench: (n) => benchProviderLLM(
        fireworksLLM, 'accounts/fireworks/models/llama-v3p3-70b-instruct', sysPrompt, text, n,
      ),
    });
  }

  return targets;
}

async function benchGpuLLM(text: string, source: string, target: string, n: number): Promise<ProviderResult> {
  const ep = deployState.endpoint;
  const latencies: number[] = [];
  let errors = 0;
  const msgs: string[] = [];
  for (let i = 0; i < n; i++) {
    try {
      const t0 = Date.now();
      const r = await fetch(`${ep}/v1/translate/text`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source_lang: source, target_lang: target }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) { errors++; msgs.push(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); continue; }
      await r.json();
      latencies.push(Date.now() - t0);
    } catch (e) { errors++; msgs.push(e instanceof Error ? e.message : String(e)); }
  }
  return buildProviderResult(true, gpuModelWarmth.llm.warm, latencies, errors, msgs);
}

/** LLM benchmark via ai-gateway provider instance (Groq, Fireworks) */
async function benchProviderLLM(
  provider: LLMProvider, model: string, systemPrompt: string, text: string, n: number,
): Promise<ProviderResult> {
  const latencies: number[] = [];
  let errors = 0;
  const msgs: string[] = [];
  for (let i = 0; i < n; i++) {
    try {
      const t0 = Date.now();
      await provider.chat({
        model, maxTokens: 150,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
      });
      latencies.push(Date.now() - t0);
    } catch (e) { errors++; msgs.push(e instanceof Error ? e.message : String(e)); }
  }
  return buildProviderResult(true, true, latencies, errors, msgs);
}

// ── TTS benchmark functions (with TTFAC) ─────────────────────────────────────

function ttsTargets(text: string, target: string, speaker: string): BenchTarget[] {
  const targets: BenchTarget[] = [];

  // GPU (qwen3-tts on pod)
  if (hasGpuEndpoint()) {
    targets.push({
      name: 'gpu',
      available: true,
      bench: (n) => benchGpuTTS(text, target, speaker, n),
    });
  }

  // Groq (Orpheus) — via ai-gateway provider
  if (groqAvailable) {
    targets.push({
      name: 'groq',
      available: true,
      bench: (n) => benchProviderTTS(groqTTS, 'canopylabs/orpheus-v1-english', 'autumn', text, n),
    });
  }

  // OpenAI (gpt-4o-mini-tts) — via ai-gateway provider
  if (openaiAvailable && openaiTTS) {
    targets.push({
      name: 'openai',
      available: true,
      bench: (n) => benchProviderTTS(openaiTTS!, 'gpt-4o-mini-tts', 'coral', text, n),
    });
  }

  // Modal (Qwen3-TTS on serverless GPU) — via ai-gateway provider
  targets.push({
    name: 'modal',
    available: true,
    bench: (n) => benchProviderTTS(modalTTS, 'qwen3-tts', 'serena', text, n),
  });

  // Modal (MOSS-TTS on serverless GPU) — alternative
  targets.push({
    name: 'modal-moss',
    available: true,
    bench: (n) => benchProviderTTS(modalMossTTS, 'moss-tts', 'moss-en', text, n),
  });

  return targets;
}

async function benchGpuTTS(text: string, target: string, speaker: string, n: number): Promise<ProviderResult> {
  const ep = deployState.endpoint;
  const latencies: number[] = [];
  const ttfacs: number[] = [];
  let errors = 0;
  const msgs: string[] = [];
  for (let i = 0; i < n; i++) {
    try {
      const t0 = Date.now();
      const r = await fetch(`${ep}/v1/tts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: getLangName(target), speaker }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) { errors++; msgs.push(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); continue; }
      const { ttfacMs, totalMs } = await readWithTTFAC(r, t0);
      latencies.push(totalMs);
      ttfacs.push(ttfacMs);
    } catch (e) { errors++; msgs.push(e instanceof Error ? e.message : String(e)); }
  }
  return buildProviderResult(true, gpuModelWarmth.tts.warm, latencies, errors, msgs, ttfacs);
}

/** TTS benchmark via ai-gateway provider instance (Groq, OpenAI, Modal) — with TTFAC via streaming */
async function benchProviderTTS(
  provider: TTSProvider, model: string, voice: string, text: string, n: number, warm = true,
): Promise<ProviderResult> {
  const latencies: number[] = [];
  const ttfacs: number[] = [];
  let errors = 0;
  const msgs: string[] = [];
  for (let i = 0; i < n; i++) {
    try {
      const t0 = Date.now();
      const stream = await provider.synthesizeStream({
        input: text, model, voice, responseFormat: 'wav',
      });
      // Measure TTFAC from stream
      const reader = stream.getReader();
      let ttfacMs = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!ttfacMs && value?.length) ttfacMs = Date.now() - t0;
      }
      const totalMs = Date.now() - t0;
      latencies.push(totalMs);
      ttfacs.push(ttfacMs || totalMs);
    } catch (e) { errors++; msgs.push(e instanceof Error ? e.message : String(e)); }
  }
  return buildProviderResult(true, warm, latencies, errors, msgs, ttfacs);
}

// ── Translate helper ────────────────────────────────────────────────────────

async function translateForTTS(text: string, source: string, target: string): Promise<string> {
  if (source === target) return text;
  const sysPrompt = `You are a real-time translator. Translate the following ${getLangName(source)} text into natural ${getLangName(target)}. Only output the translation, nothing else.`;
  if (hasGpuEndpoint()) {
    try {
      const r = await fetch(`${deployState.endpoint}/v1/translate/text`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source_lang: source, target_lang: target }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) { const d = await r.json() as Record<string, string>; return d.translated_text || d.text || text; }
    } catch { /* fall through */ }
  }
  const profile = groqDefaults || ollamaDefaults;
  if (profile) {
    try {
      const r = await client.chat([{ role: 'system', content: sysPrompt }, { role: 'user', content: text }], profile);
      return r.content || text;
    } catch { /* return original */ }
  }
  return text;
}

// ── Synthesize source-language audio ─────────────────────────────────────────

async function synthesizeSourceAudio(text: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const profile = groqDefaults || ollamaDefaults;
  if (!profile) return null;
  try {
    const result = await client.synthesize(text, profile);
    if (result.audio && result.audio.length > 100) {
      return { buffer: result.audio, mimeType: result.contentType || 'audio/wav' };
    }
  } catch (e) {
    console.log(`[bench] Could not synthesize test audio: ${e instanceof Error ? e.message : e}`);
  }
  return null;
}

// ── Pipeline progression (Phase 3) ──────────────────────────────────────────

async function runPipelineProgression(
  audio: Buffer, mimeType: string, source: string, target: string, speaker: string,
  warmupCount: number, measureCount: number,
  ttsTtfacRatio: number,
): Promise<ProgressionResult> {
  const warmupIterations: PipelineIteration[] = [];
  const measuredIterations: PipelineIteration[] = [];

  async function callPipeline(idx: number): Promise<PipelineIteration> {
    const t0 = Date.now();
    try {
      const r = await fetch(`http://localhost:${PORT}/v1/speech?source=${source}&target=${target}${speaker ? `&speaker=${speaker}` : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': mimeType },
        body: new Blob([audio as BlobPart], { type: mimeType }),
        signal: AbortSignal.timeout(30_000),
      });
      const totalMs = Date.now() - t0;
      if (!r.ok) {
        const body = await r.text();
        return { index: idx, totalMs, sttMs: 0, llmMs: 0, ttsMs: 0, ttfacMs: 0, usedGpu: false, transcription: '', translation: '', hasAudio: false, error: `HTTP ${r.status}: ${body.slice(0, 100)}` };
      }
      const data = await r.json() as Record<string, unknown>;
      const timing = data.timing as Record<string, unknown> || {};
      const sttMs = (timing.stt_ms as number) || 0;
      const llmMs = (timing.llm_ms as number) || 0;
      const ttsMs = (timing.tts_ms as number) || 0;
      const ttfacMs = Math.round(sttMs + llmMs + ttsMs * ttsTtfacRatio);
      return {
        index: idx, totalMs, sttMs, llmMs, ttsMs, ttfacMs,
        usedGpu: !!(timing.used_gpu),
        transcription: ((data.transcription as string) || '').slice(0, 80),
        translation: ((data.response as string) || '').slice(0, 80),
        hasAudio: !!(data.audio_base64),
      };
    } catch (e) {
      return { index: idx, totalMs: Date.now() - t0, sttMs: 0, llmMs: 0, ttsMs: 0, ttfacMs: 0, usedGpu: false, transcription: '', translation: '', hasAudio: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  for (let i = 0; i < warmupCount; i++) {
    const r = await callPipeline(i);
    warmupIterations.push(r);
    console.log(`[bench-pipe] warmup ${i + 1}/${warmupCount}: ${r.totalMs}ms gpu=${r.usedGpu} ${r.error || ''}`);
  }

  for (let i = 0; i < measureCount; i++) {
    const r = await callPipeline(i);
    measuredIterations.push(r);
    console.log(`[bench-pipe] measure ${i + 1}/${measureCount}: ${r.totalMs}ms (stt=${r.sttMs} llm=${r.llmMs} tts=${r.ttsMs} ttfac~${r.ttfacMs}) gpu=${r.usedGpu} ${r.error || ''}`);
  }

  const successful = measuredIterations.filter(it => !it.error);
  const half = Math.ceil(successful.length / 2);
  const firstHalf = successful.slice(0, half);
  const secondHalf = successful.slice(half);
  const firstHalfAvg = computeMedian(firstHalf.map(it => it.totalMs));
  const secondHalfAvg = computeMedian(secondHalf.map(it => it.totalMs));
  const improvementPct = firstHalfAvg > 0 ? Math.round(((firstHalfAvg - secondHalfAvg) / firstHalfAvg) * 100) : 0;

  const allIts = [...warmupIterations, ...measuredIterations].filter(it => !it.error);
  const firstCallMs = allIts[0]?.totalMs || 0;
  const warmIts = allIts.slice(2);
  const warmAvgMs = computeMedian(warmIts.map(it => it.totalMs));
  const penaltyMs = firstCallMs - warmAvgMs;

  const perStageTrend: Record<string, { first: number; last: number; delta: number }> = {};
  if (successful.length >= 2) {
    for (const key of ['sttMs', 'llmMs', 'ttsMs', 'ttfacMs'] as const) {
      const stageName = key === 'ttfacMs' ? 'TTFAC' : key.replace('Ms', '').toUpperCase();
      const first = computeMedian(firstHalf.map(it => it[key]));
      const last = computeMedian(secondHalf.map(it => it[key]));
      perStageTrend[stageName] = { first, last, delta: last - first };
    }
  }

  return {
    warmupIterations, measuredIterations,
    trend: { firstHalfAvg, secondHalfAvg, improvementPct },
    coldStartPenalty: { firstCallMs, warmAvgMs, penaltyMs },
    perStageTrend,
  };
}

// ── Realtime TTFC Benchmark ──────────────────────────────────────────────────
/**
 * POST /v1/benchmark/realtime — Measure TTFC and total latency under realistic load
 *
 * Body: { requestCount?: 10, intervalMs?: 2000 }
 *
 * Measures Time To First Content (transcript/audio) for real-time performance analysis.
 */
export async function handleRealtimeTTFCBenchmark(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  const body = await readJsonBody(req) as {
    requestCount?: number;
    intervalMs?: number;
  } | undefined;

  const requestCount = Math.min(body?.requestCount || 10, 50); // Max 50 requests
  const intervalMs = body?.intervalMs || 2000; // Default 2s between requests

  console.log(`[rt-bench] Starting realtime TTFC benchmark: ${requestCount} requests @ ${intervalMs}ms intervals`);

  const { globalTracer } = await import('../src/observability/distributed-tracer');

  try {
    const results = await globalTracer.runRealtimeBenchmark(requestCount, intervalMs);

    const metrics = globalTracer.getRealtimeMetrics();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      benchmark: {
        ttfcStats: results.ttfcStats,
        reliability: results.reliability,
        throughput: results.throughput,
        analysis: results.analysis
      },
      realtimeMetrics: {
        ttfcP50: metrics.ttfcP50,
        ttfcP95: metrics.ttfcP95,
        coldStartRate: metrics.coldStartRate,
        userExperienceScore: metrics.userExperienceScore
      },
      config: {
        requestCount,
        intervalMs,
        timestamp: new Date().toISOString()
      }
    }));

  } catch (error) {
    console.warn(`[rt-bench] Failed: ${error instanceof Error ? error.message : error}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      requestId
    }));
  }
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function handleBenchmarkPaths(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  const benchStart = Date.now();

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Invalid body: ${err instanceof Error ? err.message : err}` }));
    return;
  }

  const iterations = Math.min(Math.max(Number(body.iterations) || 3, 1), 20);
  const pipelineIterations = Math.min(Math.max(Number(body.pipelineIterations) || 5, 0), 30);
  const warmupIterations = Math.min(Math.max(Number(body.warmupIterations) || 2, 0), 5);
  const source = (body.source as string) || 'fr';
  const target = (body.target as string) || 'en';
  const speaker = (body.speaker as string) || 'Ryan';
  const testText = (body.testText as string) || "Bonjour, comment allez-vous aujourd'hui? Je suis content de vous voir ici.";
  const includeGpu = body.includeGpu !== false;
  const includeCloud = body.includeCloud !== false;

  const notes: string[] = [];
  const gpuAvail = hasGpuEndpoint();
  const audio = loadTestAudio();

  const providerList: string[] = [];
  if (gpuAvail && includeGpu) providerList.push('gpu');
  if (includeCloud) {
    if (groqAvailable) providerList.push('groq');
    if (openaiAvailable) providerList.push('openai');
    if (deepgramAvailable) providerList.push('deepgram');
    if (fireworksAvailable) providerList.push('fireworks');
    providerList.push('modal');
  }
  console.log(`[bench] ══ Full benchmark ═══ providers: [${providerList.join(',')}] stages: ${iterations}it, pipeline: ${warmupIterations}w+${pipelineIterations}m`);

  // ── GPU snapshot ──
  const gpuStatus = {
    available: gpuAvail,
    endpoint: deployState.endpoint || '',
    gpuType: deployState.gpuType || '',
    dockerImage: deployState.dockerImage || '',
    provider: deployState.provider || '',
    warmth: { ...gpuModelWarmth },
  };

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 1+2: Per-stage provider comparison
  // ══════════════════════════════════════════════════════════════════════════

  const stages = {} as Record<StageName, StageResult>;

  // Helper to run all targets for a stage
  async function benchStage(targets: BenchTarget[]): Promise<Record<string, ProviderResult>> {
    const results: Record<string, ProviderResult> = {};
    // Run all targets concurrently
    const settled = await Promise.allSettled(
      targets.filter(t => t.available).map(async t => ({ name: t.name, result: await t.bench(iterations) }))
    );
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results[s.value.name] = s.value.result;
      } else {
        // Should not happen, but handle gracefully
        console.error(`[bench] Provider failed:`, s.reason);
      }
    }
    return results;
  }

  function findFastest(providers: Record<string, ProviderResult>, key: 'avg' | 'warmAvg' = 'avg'): string | null {
    let best: string | null = null;
    let bestVal = Infinity;
    for (const [name, r] of Object.entries(providers)) {
      if (!r.available || r.latencies.length === 0) continue;
      const val = r[key];
      if (val < bestVal) { bestVal = val; best = name; }
    }
    return best;
  }

  // ── STT ──
  if (audio) {
    const targets = sttTargets(audio.buffer, audio.mimeType, audio.fileName, source);
    const providers = await benchStage(targets);
    stages.stt = { providers, fastest: findFastest(providers), fastestWarm: findFastest(providers, 'warmAvg') };
    console.log(`[bench] STT: tested ${Object.keys(providers).length} providers — fastest: ${stages.stt.fastest}`);
  } else {
    stages.stt = { providers: {}, fastest: null, fastestWarm: null };
    notes.push('STT skipped: no test audio file found');
  }

  // ── LLM ──
  {
    const targets = llmTargets(testText, source, target);
    const providers = await benchStage(targets);
    stages.llm = { providers, fastest: findFastest(providers), fastestWarm: findFastest(providers, 'warmAvg') };
    console.log(`[bench] LLM: tested ${Object.keys(providers).length} providers — fastest: ${stages.llm.fastest}`);
  }

  // ── TTS ──
  {
    let ttsText = testText;
    try { ttsText = await translateForTTS(testText, source, target); }
    catch { notes.push('TTS text translation failed, using source text'); }

    const targets = ttsTargets(ttsText, target, speaker);
    const providers = await benchStage(targets);
    stages.tts = { providers, fastest: findFastest(providers), fastestWarm: findFastest(providers, 'warmAvg') };
    console.log(`[bench] TTS: tested ${Object.keys(providers).length} providers — fastest: ${stages.tts.fastest}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 3: Pipeline progression
  // ══════════════════════════════════════════════════════════════════════════

  // Compute TTS TTFAC ratio from best provider
  let ttsTtfacRatio = 1.0;
  if (stages.tts.fastest) {
    const bestTts = stages.tts.providers[stages.tts.fastest];
    if (bestTts?.ttfacAvg && bestTts.avg > 0) {
      ttsTtfacRatio = bestTts.ttfacAvg / bestTts.avg;
    }
  }

  let progression: ProgressionResult | null = null;
  if (pipelineIterations > 0) {
    let pipeAudio: { buffer: Buffer; mimeType: string } | null = null;
    console.log(`[bench] Synthesizing ${source}-language test audio...`);
    pipeAudio = await synthesizeSourceAudio(testText);
    if (pipeAudio) {
      console.log(`[bench] Using synthesized audio (${pipeAudio.buffer.length} bytes, ${pipeAudio.mimeType})`);
    } else if (audio) {
      pipeAudio = { buffer: audio.buffer, mimeType: audio.mimeType };
      notes.push('Could not synthesize source-language audio; using file audio');
    }
    if (pipeAudio) {
      console.log(`[bench] ── Pipeline progression: ${warmupIterations}w + ${pipelineIterations}m (TTS TTFAC ratio: ${ttsTtfacRatio.toFixed(2)}) ──`);
      progression = await runPipelineProgression(pipeAudio.buffer, pipeAudio.mimeType, source, target, speaker, warmupIterations, pipelineIterations, ttsTtfacRatio);
    } else {
      notes.push('Pipeline progression skipped: no audio available');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 4: All path combinations & recommendation
  // ══════════════════════════════════════════════════════════════════════════

  const paths: Record<string, PathResult> = {};

  // Get latencies per provider per stage
  function getProviderLatency(stage: StageName, provider: string): { avg: number; warm: number; ttfac: number; warmTtfac: number } | null {
    const p = stages[stage]?.providers[provider];
    if (!p || !p.available || p.latencies.length === 0) return null;
    const avg = p.avg;
    const warm = p.warmAvg;
    const ttfac = p.ttfacAvg ?? avg;
    const warmTtfac = p.ttfacLatencies && p.ttfacLatencies.length > 1
      ? computeAvg(p.ttfacLatencies.slice(1))
      : (p.ttfacAvg ?? warm);
    return { avg, warm, ttfac, warmTtfac };
  }

  // Get all working providers per stage
  const sttProviders = Object.keys(stages.stt.providers).filter(p => {
    const r = stages.stt.providers[p];
    return r && r.available && r.latencies.length > 0;
  });
  const llmProviders = Object.keys(stages.llm.providers).filter(p => {
    const r = stages.llm.providers[p];
    return r && r.available && r.latencies.length > 0;
  });
  const ttsProviders = Object.keys(stages.tts.providers).filter(p => {
    const r = stages.tts.providers[p];
    return r && r.available && r.latencies.length > 0;
  });

  console.log(`[bench] Path combinations: ${sttProviders.length} STT × ${llmProviders.length} LLM × ${ttsProviders.length} TTS = ${sttProviders.length * llmProviders.length * ttsProviders.length} paths`);

  // Generate all valid combinations
  for (const stt of sttProviders) {
    for (const llm of llmProviders) {
      for (const tts of ttsProviders) {
        const sttL = getProviderLatency('stt', stt)!;
        const llmL = getProviderLatency('llm', llm)!;
        const ttsL = getProviderLatency('tts', tts)!;

        const totalAvg = sttL.avg + llmL.avg + ttsL.avg;
        const ttfacAvg = sttL.avg + llmL.avg + ttsL.ttfac;
        const warmTotalAvg = sttL.warm + llmL.warm + ttsL.warm;
        const warmTtfacAvg = sttL.warm + llmL.warm + ttsL.warmTtfac;

        const name = stt === llm && llm === tts ? `all-${stt}` : `${stt}+${llm}+${tts}`;
        const desc = `STT:${stt} LLM:${llm} TTS:${tts}`;

        paths[name] = {
          totalAvg, ttfacAvg, warmTotalAvg, warmTtfacAvg,
          description: desc,
          stages: { stt, llm, tts },
        };
      }
    }
  }

  // Find best path by warm TTFAC (what matters for real-time after cold start)
  let bestPath = '';
  let bestWarmTtfac = Infinity;
  for (const [name, p] of Object.entries(paths)) {
    const wt = p.warmTtfacAvg ?? p.warmTotalAvg;
    if (wt < bestWarmTtfac) { bestWarmTtfac = wt; bestPath = name; }
  }

  const bestObj = paths[bestPath];
  const recommendation = {
    path: bestPath,
    reason: bestObj
      ? `${bestObj.description} — warm TTFAC ${bestObj.warmTtfacAvg}ms, warm total ${bestObj.warmTotalAvg}ms (cold: TTFAC ${bestObj.ttfacAvg}ms, total ${bestObj.totalAvg}ms)`
      : 'No data',
    estimatedTotalMs: bestObj?.totalAvg ?? 0,
    estimatedTtfacMs: bestObj?.ttfacAvg ?? 0,
    warmTotalMs: bestObj?.warmTotalAvg ?? 0,
    warmTtfacMs: bestObj?.warmTtfacAvg ?? 0,
    routing: bestObj?.stages ?? {},
  };

  const durationMs = Date.now() - benchStart;
  console.log(`[bench] ══ Done in ${durationMs}ms — best: ${bestPath} (warm TTFAC ${bestWarmTtfac}ms) ══`);

  // ── Seed intelligence modules from benchmark results ─────────────────────
  const providerModelMap: Record<string, string> = {
    groq: 'canopylabs/orpheus-v1-english',
    openai: 'gpt-4o-mini-tts',
    modal: 'qwen3-tts',
    'modal-moss': 'moss-tts',
    gpu: 'qwen3-tts',
  };
  const ttfacSeeds: Array<{ provider: string; model: string; ttfacMs: number; totalMs: number }> = [];
  for (const [name, result] of Object.entries(stages.tts?.providers ?? {})) {
    if (!result.available || !result.ttfacLatencies?.length) continue;
    const model = providerModelMap[name] ?? '*';
    for (let i = 0; i < result.ttfacLatencies.length; i++) {
      ttfacSeeds.push({
        provider: name,
        model,
        ttfacMs: result.ttfacLatencies[i],
        totalMs: result.latencies[i] ?? result.ttfacLatencies[i],
      });
    }
  }
  if (ttfacSeeds.length > 0) {
    ttfacTracker.seedFromBenchmark(ttfacSeeds);
    console.log(`[bench] Seeded TTFAC tracker with ${ttfacSeeds.length} samples from ${Object.keys(stages.tts?.providers ?? {}).length} TTS providers`);
  }

  // Seed performance ranker with per-stage latency data
  for (const [stageName, stageResult] of Object.entries(stages)) {
    for (const [provName, result] of Object.entries(stageResult.providers)) {
      if (!result.available || !result.latencies.length) continue;
      const model = providerModelMap[provName] ?? '*';
      for (const lat of result.latencies) {
        performanceRanker.record(stageName, provName, model, lat, true);
      }
    }
  }
  console.log(`[bench] Seeded performance ranker from all benchmark stages`);

  const response: FullBenchmarkResponse = {
    timestamp: new Date().toISOString(),
    gpuStatus, stages, paths, recommendation,
    progression, durationMs, notes,
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}
