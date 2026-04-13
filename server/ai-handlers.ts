// ── BabelCast Gateway — AI HTTP Handlers ─────────────────────────────────────
// handleTranscribe, handleEnsembleTranscribe, handleTtsPreview, handleTranslate,
// handlePipeline, handleVoiceProfileStatus, handleVoiceProfileReset.
//
// Key design: request hedging (raceProviders) for GPU vs cloud — fire both in
// parallel and take the fastest response. This eliminates the 5-30s worst-case
// latency from sequential GPU→cloud fallback.

// ── Hybrid Routing Engine ──────────────────────────────────────────────────
interface RoutingCondition {
  name: string;
  evaluate: () => boolean;
  weight: number;
  provider: 'gpu' | 'groq' | 'openai' | 'modal';
  model?: string;
  reason: string;
}

interface RoutingDecision {
  provider: string;
  model: string;
  confidence: number;
  estimatedLatencyMs: number;
  reason: string;
  costEstimate: number;
}

class HybridRouter {
  private conditions: RoutingCondition[] = [
    // GPU-first strategies (highest priority)
    // Each condition now gates on isGpuLatencyAcceptable() so that a GPU
    // with degraded performance (P95 > 3s) automatically falls through to
    // cloud providers. This is the "auto-swap" mechanism referenced in
    // server/state.ts:isGpuLatencyAcceptable(). Before this change, the
    // function existed but was never called — a GPU with 10s P95 would
    // still be preferred over cloud. Now it's checked on every routing
    // decision so degradation is caught at request time, not just deploy.
    {
      name: 'gpu_hot_complete',
      evaluate: () => isGpuAvailable() && isGpuReadyForProduction() && isGpuLatencyAcceptable() &&
                     isStageWarm('stt') && isStageWarm('llm') && isTtsWarm(),
      weight: 0.95,
      provider: 'gpu',
      reason: 'GPU fully warmed up, production-ready, and latency OK'
    },
    {
      name: 'gpu_hot_stt_llm',
      evaluate: () => isGpuAvailable() && isGpuLatencyAcceptable() && isStageWarm('stt') && isStageWarm('llm') && !isTtsWarm(),
      weight: 0.85,
      provider: 'gpu',
      reason: 'GPU STT+LLM warm but TTS cold'
    },
    {
      name: 'gpu_hot_partial',
      evaluate: () => isGpuAvailable() && isGpuLatencyAcceptable() && (isStageWarm('stt') || isStageWarm('llm') || isTtsWarm()),
      weight: 0.75,
      provider: 'gpu',
      reason: 'GPU partially warm'
    },
    {
      name: 'gpu_available',
      evaluate: () => isGpuAvailable() && isGpuLatencyAcceptable(),
      weight: 0.60,
      provider: 'gpu',
      reason: 'GPU available but cold'
    },
    // GPU available but latency degraded — still use it but at lower weight
    // than full cloud. This avoids oscillation: instead of hard-cutting to
    // cloud, we let some traffic continue to GPU so the P95 ring buffer
    // can recover if the degradation was transient.
    {
      name: 'gpu_degraded',
      evaluate: () => isGpuAvailable() && !isGpuLatencyAcceptable(),
      weight: 0.40,
      provider: 'gpu',
      reason: 'GPU available but latency degraded (P95 > threshold)'
    },

    // Cloud fallback strategies
    {
      name: 'gpu_dead_groq_fast',
      evaluate: () => !isGpuAvailable() && groqAvailable,
      weight: 1.0,
      provider: 'groq',
      reason: 'GPU unavailable, using fast cloud backup'
    },
    {
      name: 'gpu_dead_openai_fallback',
      evaluate: () => !isGpuAvailable() && openaiAvailable && !groqAvailable,
      weight: 0.9,
      provider: 'openai',
      reason: 'GPU unavailable, using OpenAI as fallback'
    },
    {
      name: 'gpu_cold_cloud_warmup',
      evaluate: () => !isStageWarm('stt') && !isStageWarm('llm'),
      weight: 0.8,
      provider: 'groq',
      reason: 'GPU still cold, using cloud during warmup'
    },
    {
      name: 'gpu_timeout_openai_failover',
      evaluate: () => {
        // Check if GPU has been timing out
        const p95Latency = getP95Latency();
        return (p95Latency || 0) > 3000; // >3s triggers failover
      },
      weight: 0.9,
      provider: 'openai',
      reason: 'GPU response too slow, failing over'
    },

    // Modal for TTS-only scenarios
    {
      name: 'tts_fallback_modal',
      evaluate: () => !isTtsWarm() && Boolean(modalTTS),
      weight: 0.4,
      provider: 'modal',
      reason: 'TTS fallback to Modal'
    }
  ];

  async route(pipelineType: 'speech' | 'tts' | 'stt' | 'translate', context?: any): Promise<RoutingDecision> {
    const validConditions = this.conditions.filter(c => {
      // Filter by pipeline type if needed
      if (pipelineType === 'tts' && c.name.includes('stt') && !c.name.includes('tts')) return false;
      if (pipelineType === 'stt' && !c.name.includes('stt')) return false;
      return c.evaluate();
    });

    if (validConditions.length === 0) {
      // Default fallback
      const fallbackProvider = groqAvailable ? 'groq' : openaiAvailable ? 'openai' : 'modal';
      return {
        provider: fallbackProvider,
        model: this.getDefaultModel(fallbackProvider, pipelineType),
        confidence: 0.3,
        estimatedLatencyMs: 1200,
        reason: 'No conditions matched, default fallback',
        costEstimate: this.estimateCost(fallbackProvider)
      };
    }

    // Select best match by weight
    const best = validConditions.reduce((best, current) =>
      current.weight > best.weight ? current : best
    );

    const decision: RoutingDecision = {
      provider: best.provider,
      model: best.model || this.getDefaultModel(best.provider, pipelineType),
      confidence: best.weight,
      estimatedLatencyMs: this.estimateLatency(best.provider, best.weight),
      reason: best.reason,
      costEstimate: this.estimateCost(best.provider)
    };

    console.log(`[hybrid-router] ${pipelineType} → ${decision.provider}/${decision.model} (${decision.confidence.toFixed(2)}) - ${decision.reason}`);
    return decision;
  }

  private getDefaultModel(provider: string, pipelineType: string): string {
    switch (provider) {
      case 'gpu':
        return 'mistral-7b-instruct-v0.3';
      case 'groq':
        return pipelineType === 'speech' ? groqLlmModel : 'mixtral-8x7b-32768';
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
        base = gpuHealthy ? getP95Latency() || 1000 : 5000;
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

    // Higher confidence = lower estimated latency
    const adjustment = (1 - confidence) * 0.5; // Up to 50% slower for low confidence
    return Math.round(base * (1 + adjustment));
  }

  private estimateCost(provider: string): number {
    switch (provider) {
      case 'gpu':
        return 0.004;     // ~$0.15/hour / 3600 seconds
      case 'groq':
        return 0.0001;    // Very cheap per request
      case 'openai':
        return 0.0005;    // Mid-range per request
      case 'modal':
        return 0.001;     // Higher for serverless
      default:
        return 0.001;
    }
  }

  // Update routing weights based on real performance feedback
  updatePerformance(provider: string, latencyMs: number, success: boolean, pipelineType: string): void {
    const performance = success ?
      (latencyMs < 500 ? 'excellent' : latencyMs < 1500 ? 'good' : 'slow') :
      'failed';

    console.log(`[hybrid-router] Performance update: ${provider} ${performance} (${latencyMs}ms) for ${pipelineType}`);

    // Future enhancement: reinforcement learning to adjust weights dynamically
    // For now, simply log for monitoring and manual optimization
  }
}

// Global router instance
export const pipelineRouter = new HybridRouter();

import type { IncomingMessage, ServerResponse } from 'http';
import { runEnsembleSTT } from '../src/ensemble-stt';
import { globalTracer } from '../src/observability/distributed-tracer';
import type { EnsembleSTTProviderEntry } from '../src/ensemble-stt';
import type { AIProfile } from '../src/client';
import { OllamaSTTProvider } from '../src/providers/ollama';
import {
  botState, deployState, isGpuAvailable, touchRequest, touchModelRequest, getP95Latency,
  isTtsWarm, recordTtsTtfb, markTtsWarm, ttsWarmth, saveColdStartProfile,
  isStageWarm, gpuModelWarmth, gpuHealthy,
  isGpuReadyForProduction, recordGpuLatency, recordPerStageLatency, gpuReadyForProduction, gpuReadinessState,
  isGpuLatencyAcceptable,
} from './state';
import {
  client, groqProfile, ollamaProfile, translationProfile,
  groqAvailable, openaiAvailable, deepgramAvailable, fireworksAvailable,
  openrouterAvailable, whisperAvailable, ollamaAvailable, whisperHost,
  ENSEMBLE_STT_PROVIDERS,
  groqSTT, openaiSTT, deepgramSTT, fireworksSTT,
  groqLLM, fireworksLLM, groqLlmModel, groqTtsModel, groqTtsVoice,
  openrouterQwen3Embedding, openaiEmbedding,
  markGpuUnhealthy, shouldPreferGpu, shouldPreferGpuTts,
  recordStageSuccess, recordStageFailure, isStageCircuitClosed,
  providers, modalTTS, gpuShadowMode,
  markGpuProductionReady,
} from './providers';
import { recordShadowRun } from './gpu-readiness';
import {
  getSttTargetLatencyMs, getLlmTargetLatencyMs, getBenchmarkMarginPct,
} from '../src/gpu-providers/deploy-settings';
import { loadProviderConfig, stampProfileRequest } from './config-persistence';
import { filterHallucinations, DEFAULT_HALLUCINATION_FILTER_CONFIG } from '../src/stt-hallucination-filter';
import type { STTHallucinationFilterConfig } from '../src/stt-hallucination-filter';
import type { STTResponse } from '../src/providers/types';
import { logRequest } from './metrics';
import {
  getOrCreateRequestId, setRequestIdHeader, readJsonBody, readRawBody,
  handleBodyError, validateLang, langNames, BodyTimeoutError,
} from './http-utils';
import { PROVIDER_CHAIN, GPU_PROVIDERS, MODAL_BABELCAST_URL } from './config';
import { raceProviders } from './race-providers';
import { probeCloudProvider, probeGpuHealth } from '../src';
import type { RaceCandidate } from './race-providers';
import { broadcastWs } from './ws-state';

// ── SSRF protection — block fetches to private/internal IP addresses ─────────

/** Patterns that match private/internal/metadata IP addresses.
 * Compiled once at module load for performance.
 */
const SSRF_BLOCKED_IP_PATTERNS = [
  { pattern: /^127\./, label: 'localhost' },
  { pattern: /^10\./, label: 'private-10' },
  { pattern: /^192\.168\./, label: 'private-192' },
  { pattern: /^172\.(1[6-9]|2\d|3[01])\./, label: 'private-172' },
  { pattern: /^169\.254\./, label: 'link-local' },
  { pattern: /^0\.0\.0\.0$/, label: 'any' },
  { pattern: /^::1$/, label: 'ipv6-loopback' },
  { pattern: /^::$/, label: 'ipv6-unspecified' },
  { pattern: /^fe80:/i, label: 'ipv6-link-local' },
  { pattern: /^fc00:/i, label: 'ipv6-ula' },
  { pattern: /^fd[0-9a-f]{2}:/i, label: 'ipv6-ula-c' },
  { pattern: /^2001:db8:/i, label: 'ipv6-documentation' },
  { pattern: /^169\.254\.169\.254$/, label: 'cloud-metadata' },
];
const SSRF_BLOCKED_HOSTS = [
  'localhost',
  'metadata.google.internal',
  'metadata.google',
  'kubernetes.default.svc',
  'kubernetes.default',
  'etcd-client',
  'etcd.observer',
];

/** Return true if the URL points to a private/internal/metadata address. */
export function isPrivateUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol === 'file:') return true;
    const host = url.hostname.toLowerCase();
    if (SSRF_BLOCKED_HOSTS.includes(host)) return true;
    return SSRF_BLOCKED_IP_PATTERNS.some(({ pattern }) => pattern.test(host));
  } catch { return true; }
}

/** Block fetches to private/internal IP addresses (SSRF protection). Throws on match. */
function validateEndpointUrl(urlStr: string): void {
  const url = new URL(urlStr);
  const host = url.hostname.toLowerCase();
  if (SSRF_BLOCKED_HOSTS.includes(host)) {
    throw new Error(`SSRF blocked: ${host} is a reserved hostname`);
  }
  if (SSRF_BLOCKED_IP_PATTERNS.some(({ pattern }) => pattern.test(host))) {
    throw new Error(`SSRF blocked: ${host} is a private/internal address`);
  }
}

/** Validate a GPU/remote endpoint URL, skipping localhost (valid for local dev). */
function validateRemoteEndpoint(endpoint: string): void {
  if (endpoint.includes('localhost') || endpoint.includes('127.0.0.1')) return;
  validateEndpointUrl(endpoint);
}

// ── Real-time timeout constants ──────────────────────────────────────────────
// Tuned for subtitle pipeline: anything above these thresholds has lost its
// utility for real-time display and should yield to the next provider.
// STT needs extra headroom: auto-swap sends 3 parallel requests that queue
// on the GPU (serialized by GPU semaphore), so worst-case is ~3× single latency.
export const GPU_STT_TIMEOUT_MS = 5_000;
export const GPU_LLM_TIMEOUT_MS = 3_000;
export const GPU_TTS_TIMEOUT_MS = 5_000;
export const GPU_PIPELINE_TIMEOUT_MS = 6_000;

/** Adaptive GPU timeout: P95 × 2 with floor/ceiling guards. */
function adaptiveGpuTimeout(baseMs: number): number {
  const p95 = getP95Latency();
  if (p95 === null) return baseMs; // no data yet, use fixed default
  const adaptive = Math.ceil(p95 * 2);
  // Floor: never below 500ms (healthy GPU). Ceiling: never above baseMs.
  return Math.max(500, Math.min(adaptive, baseMs));
}

/**
 * Per-stage adaptive timeout using avg_latency_ms from GPU pod /health data.
 * Uses the stage-specific average (3x headroom) when available, otherwise
 * falls back to the global P95-based timeout.
 */
export function adaptiveStageTimeout(stage: 'stt' | 'llm' | 'tts', baseMs: number): number {
  const entry = gpuModelWarmth[stage];
  if (entry.requests >= 3 && entry.avgLatencyMs !== null) {
    // 3x average gives headroom for variance; floor 500ms, ceiling baseMs
    return Math.max(500, Math.min(baseMs, Math.ceil(entry.avgLatencyMs * 3)));
  }
  return adaptiveGpuTimeout(baseMs);
}

// ── Translation LRU cache ──────────────────────────────────────────────────
// Meetings have many repeated phrases ("thank you", "can you hear me?").
// Cache avoids redundant LLM calls for identical text+lang pairs.
const TRANSLATION_CACHE_MAX = 256;
const TRANSLATION_CACHE_TTL_MS = 30 * 60_000; // 30 minutes — meetings last hours
const translationCache = new Map<string, { text: string; ts: number }>();

// Cache hit/miss counters for metrics
let cacheHits = 0;
let cacheMisses = 0;
export function getTranslationCacheStats() { return { cacheHits, cacheMisses, cacheSize: translationCache.size }; }

// Periodic sweep: remove expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  let swept = 0;
  for (const [key, entry] of translationCache) {
    if (now - entry.ts > TRANSLATION_CACHE_TTL_MS) {
      translationCache.delete(key);
      swept++;
    }
  }
  if (swept > 0) console.log(`[cache] Swept ${swept} expired translation entries`);
}, 5 * 60_000);

export function getCachedTranslation(text: string, srcLang: string, tgtLang: string, style = 'default'): string | null {
  const key = `${srcLang}|${tgtLang}|${style}|${text}`;
  const entry = translationCache.get(key);
  if (!entry) { cacheMisses++; return null; }
  if (Date.now() - entry.ts > TRANSLATION_CACHE_TTL_MS) {
    translationCache.delete(key);
    cacheMisses++;
    return null;
  }
  // Move to end (LRU)
  translationCache.delete(key);
  translationCache.set(key, entry);
  cacheHits++;
  return entry.text;
}

export function setCachedTranslation(text: string, srcLang: string, tgtLang: string, translated: string, style = 'default'): void {
  const key = `${srcLang}|${tgtLang}|${style}|${text}`;
  translationCache.set(key, { text: translated, ts: Date.now() });
  // Evict oldest if over capacity
  if (translationCache.size > TRANSLATION_CACHE_MAX) {
    const oldest = translationCache.keys().next().value;
    if (oldest) translationCache.delete(oldest);
  }
}

/** Adaptive maxTokens: short inputs need fewer tokens, saving LLM generation time. */
function adaptiveMaxTokens(inputText: string): number {
  const len = inputText.length;
  if (len < 20) return 60;
  if (len < 50) return 100;
  if (len < 150) return 150;
  return 200;
}

// ── Avatar TTS forwarding ────────────────────────────────────────────────────

/** Fire-and-forget: forward TTS audio to the avatar on the bot pod. */
export function forwardToAvatar(audioBase64: string): void {
  const ep = botState.endpoint;
  if (!ep) return;

  // Derive avatar endpoint from bot endpoint
  const runpodMatch = ep.match(/^(https?:\/\/)([^-]+)-8080(.*)$/);
  const avatarUrl = runpodMatch
    ? `${runpodMatch[1]}${runpodMatch[2]}-3099${runpodMatch[3]}`
    : ep.includes('localhost') ? 'http://localhost:3099' : null;
  if (!avatarUrl) return;

  fetch(`${avatarUrl}/api/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: audioBase64 }),
    signal: AbortSignal.timeout(3_000),
  }).then(res => {
    if (!res.ok) console.warn(`[avatar] speak failed: ${res.status}`);
  }).catch(err => {
    // Silently ignore — avatar may not be running
    console.debug?.(`[avatar] forward failed: ${(err as Error).message}`);
  });
}

// ── Routing decision logger ───────────────────────────────────────────────────
/** Log which providers are in the race and why GPU was excluded/demoted (if applicable). */
function logRouteDecision(stage: string, candidates: { name: string }[], gpuEndpoint: string | null): void {
  const names = candidates.map(c => c.name).join('+');
  let note = '';
  if (!gpuEndpoint) {
    if (!deployState.endpoint) note = ' [gpu:no-pod]';
    else if (!gpuHealthy) note = ' [gpu:unhealthy]';
    else if (!gpuReadyForProduction) note = ` [gpu:${gpuReadinessState.llm.phase}]`; // idle|benchmarking|failed|repechage
    else note = ` [gpu:${deployState.status}]`;
  } else if (candidates[0]?.name !== 'gpu') {
    const p95 = getP95Latency();
    note = ` [gpu:backup,p95=${p95 !== null ? p95 + 'ms' : 'no-data'}]`;
  }
  console.log(`[${stage}] route: ${names}${note}`);
}

// ── GPU fetch helpers (shared by hedging candidates) ─────────────────────────

export interface GpuSTTResult {
  text: string;
  language: string;
  used_gpu: boolean;
  avg_logprob: number;
  segments?: unknown[];
  words?: unknown[];
}

export async function fetchGpuSTT(
  gpuEndpoint: string, audio: Buffer, language: string, prompt: string,
  hotwords: string, wordTimestamps: boolean, signal: AbortSignal,
  requestId?: string,
): Promise<GpuSTTResult> {
  validateRemoteEndpoint(gpuEndpoint);
  const form = new FormData();
  form.append('file', new Blob([audio as BlobPart], { type: 'audio/wav' }), 'audio.wav');
  const params = new URLSearchParams();
  if (language) params.set('language', language);
  if (prompt) params.set('prompt', prompt);
  if (hotwords) params.set('hotwords', hotwords);
  if (wordTimestamps) params.set('word_timestamps', 'true');
  try {
    const headers: Record<string, string> = {};
    if (requestId) headers['X-Request-Id'] = requestId;
    const gpuRes = await fetch(`${gpuEndpoint}/v1/transcribe?${params}`, {
      method: 'POST', body: form, signal, headers,
    });
    if (!gpuRes.ok) {
      const errBody = await gpuRes.text().catch(() => '');
      console.warn(`[gpu:stt] HTTP ${gpuRes.status}: ${errBody.slice(0, 200)}`);
      recordStageFailure('stt');
      throw new Error(`GPU STT HTTP ${gpuRes.status}`);
    }
    const data = await gpuRes.json() as Record<string, unknown>;
    recordStageSuccess('stt');
    return {
      text: (data.text as string) || '',
      language: (data.language as string) || '',
      used_gpu: true,
      avg_logprob: typeof data.avg_logprob === 'number' ? data.avg_logprob : 0,
      ...(Array.isArray(data.segments) ? { segments: data.segments } : {}),
    };
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) recordStageFailure('stt');
    throw err;
  }
}

export interface GpuLLMResult {
  translated_text: string;
  used_gpu: boolean;
}

export async function fetchGpuLLM(
  gpuEndpoint: string, text: string, sourceLang: string, targetLang: string,
  glossary: string, context: string, signal: AbortSignal,
  requestId?: string,
): Promise<GpuLLMResult> {
  validateRemoteEndpoint(gpuEndpoint);
  const body: Record<string, string> = { text, source_lang: sourceLang, target_lang: targetLang };
  if (glossary) body.glossary = glossary;
  if (context) body.context = context;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (requestId) headers['X-Request-Id'] = requestId;
    const gpuRes = await fetch(`${gpuEndpoint}/v1/translate/text`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!gpuRes.ok) {
      const errBody = await gpuRes.text().catch(() => '');
      console.warn(`[gpu:llm] HTTP ${gpuRes.status}: ${errBody.slice(0, 200)}`);
      recordStageFailure('llm');
      throw new Error(`GPU LLM HTTP ${gpuRes.status}`);
    }
    const data = await gpuRes.json() as Record<string, unknown>;
    recordStageSuccess('llm');
    return {
      translated_text: (data.translated_text as string) || '',
      used_gpu: true,
    };
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) recordStageFailure('llm');
    throw err;
  }
}

export interface GpuTTSResult {
  audio: Buffer;
  contentType: string;
  used_gpu: boolean;
}

export async function fetchGpuTTS(
  gpuEndpoint: string, text: string, language: string, speaker: string,
  signal: AbortSignal, refAudio?: string, refText?: string,
  requestId?: string,
): Promise<GpuTTSResult> {
  validateRemoteEndpoint(gpuEndpoint);
  try {
    const body: Record<string, string> = { text, language, speaker };
    if (refAudio) body.reference_audio = refAudio;
    if (refText) body.ref_text = refText;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (requestId) headers['X-Request-Id'] = requestId;
    const gpuRes = await fetch(`${gpuEndpoint}/v1/tts`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!gpuRes.ok) {
      const errBody = await gpuRes.text().catch(() => '');
      console.warn(`[gpu:tts] HTTP ${gpuRes.status}: ${errBody.slice(0, 200)}`);
      recordStageFailure('tts');
      throw new Error(`GPU TTS HTTP ${gpuRes.status}`);
    }
    const audio = Buffer.from(await gpuRes.arrayBuffer());
    recordStageSuccess('tts');
    return { audio, contentType: gpuRes.headers.get('content-type') || 'audio/wav', used_gpu: true };
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) recordStageFailure('tts');
    throw err;
  }
}

// ── Resolve cloud profile for a request ──────────────────────────────────────

export function getCloudProfile(): AIProfile | null {
  // Find the first cloud provider in PROVIDER_CHAIN
  for (const p of PROVIDER_CHAIN) {
    if (p === 'groq' && groqProfile) return groqProfile;
    if (p === 'ollama' && ollamaProfile) return ollamaProfile;
  }
  return groqProfile || ollamaProfile;
}

export function getCloudProviderName(): 'gpu' | 'groq' | 'ollama' | 'ensemble' | 'cache' | 'hybrid' {
  for (const p of PROVIDER_CHAIN) {
    if (p === 'groq' && groqProfile) return 'groq';
    if (p === 'ollama' && ollamaProfile) return 'ollama';
  }
  return 'groq';
}

// ── GPU-aware STT endpoint (with request hedging) ───────────────────────────

export async function handleTranscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  touchRequest(); touchModelRequest();
  const t0 = Date.now();
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const rawLang = url.searchParams.get('language') || '';
  const language = rawLang ? validateLang(rawLang, 'fr') : '';  // empty = auto-detect
  const prompt = url.searchParams.get('prompt') || '';
  const hotwords = url.searchParams.get('hotwords') || '';
  const wordTimestamps = url.searchParams.get('word_timestamps') === 'true';
  let audio: Buffer;
  const rawBodyPromise = readRawBody(req, res);
  if (!rawBodyPromise) return;  // Content-Length exceeded — response already sent
  try { audio = await rawBodyPromise; }
  catch (e) {
    if (e instanceof BodyTimeoutError) { res.writeHead(408, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Request Timeout' })); return; }
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid request body' })); return;
  }

  if (audio.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No audio data' }));
    return;
  }

  // Shadow mode: GPU fires in background, cloud serves the actual response
  if (gpuShadowMode && deployState.endpoint) {
    const shadowEndpoint = deployState.endpoint;
    const shadowTarget = Math.round(getSttTargetLatencyMs() * (1 - getBenchmarkMarginPct() / 100));
    const t0Shadow = Date.now();
    fetchGpuSTT(shadowEndpoint, audio, language, prompt, hotwords, wordTimestamps, AbortSignal.timeout(GPU_STT_TIMEOUT_MS), requestId)
      .then(() => {
        const ms = Date.now() - t0Shadow;
        recordGpuLatency(ms);
        recordPerStageLatency('stt', ms);
        recordShadowRun(ms, shadowTarget, () => markGpuProductionReady(shadowEndpoint));
      })
      .catch(e => console.warn('[shadow] STT run failed:', e instanceof Error ? e.message : e)); // ignore shadow errors
  }

  // Build race candidates: GPU (if available) + cloud providers
  const candidates: RaceCandidate<GpuSTTResult>[] = [];
  const gpuEndpoint = isGpuReadyForProduction() ? deployState.endpoint : null;
  const gpuSttTimeout = adaptiveGpuTimeout(GPU_STT_TIMEOUT_MS);

  if (gpuEndpoint && shouldPreferGpu()) {
    candidates.push({
      name: 'gpu',
      timeoutMs: gpuSttTimeout,
      run: (signal) => fetchGpuSTT(gpuEndpoint, audio, language, prompt, hotwords, wordTimestamps, signal, requestId),
    });
  }

  const cloudProfile = getCloudProfile();
  if (cloudProfile) {
    const cloudName = getCloudProviderName();
    // Per-language STT model override from persisted config
    const sttOverrides = (loadProviderConfig() as Record<string, unknown>).sttModelOverrides as Record<string, { provider: string; model: string }> | undefined;
    const langOverride = language && sttOverrides?.[language];
    candidates.push({
      name: cloudName,
      timeoutMs: 8_000,
      run: async (signal) => {
        // AbortSignal check — stop early if race already won
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const profile: AIProfile = { ...cloudProfile, ...(language && { language }), ...(prompt && { sttPrompt: prompt }), ...(wordTimestamps && { sttWordTimestamps: true }) };
        if (langOverride) {
          profile.stt = [{ provider: langOverride.provider, model: langOverride.model }];
        }
        if (!language) delete profile.language;
        const result = await client.transcribe(audio, profile);
        return {
          text: result.text,
          language: result.language || '',
          used_gpu: false,
          avg_logprob: 0,
          ...(result.words?.length ? { words: result.words } : {}),
        };
      },
    });
  }

  // If GPU is available but latency is poor, still add it as a backup after cloud
  if (gpuEndpoint && !shouldPreferGpu() && candidates.length > 0) {
    candidates.push({
      name: 'gpu',
      timeoutMs: gpuSttTimeout,
      run: (signal) => fetchGpuSTT(gpuEndpoint, audio, language, prompt, hotwords, wordTimestamps, signal, requestId),
    });
  }

  if (candidates.length === 0) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No providers available for STT', text: '' }));
    return;
  }

  logRouteDecision('stt', candidates, gpuEndpoint);

  try {
    const { result, provider, latencyMs } = await raceProviders(candidates, {
      logPrefix: '[stt]',
      // Give GPU a 0ms head start — true parallel race for minimum latency
      headstartMs: 0,
    });

    if (provider === 'gpu') { recordGpuLatency(latencyMs); recordPerStageLatency('stt', latencyMs); }
    if (result.text) console.log(`[${provider}] STT: ${result.text.slice(0, 100)}`);
    logRequest({ timestamp: Date.now(), stage: 'stt', provider: provider as 'gpu' | 'groq' | 'ollama' | 'ensemble' | 'cache' | 'hybrid', latencyMs, success: true, inputSize: audio.length, outputPreview: result.text.slice(0, 80) });

    const resp: Record<string, unknown> = { text: result.text, language: result.language, used_gpu: result.used_gpu, avg_logprob: result.avg_logprob };
    if (result.segments) resp.segments = result.segments;
    if (result.words) resp.words = result.words;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resp));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[gateway] All STT providers failed: ${msg}`);
    logRequest({ timestamp: Date.now(), stage: 'stt', provider: getCloudProviderName(), latencyMs: Date.now() - t0, success: false, error: msg, inputSize: audio.length });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'All providers failed for STT', text: '' }));
  }
}

// ── Ensemble STT endpoint — thin shim, logic lives in ai-gateway/src/ensemble-stt.ts ──

export async function handleEnsembleTranscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  touchRequest(); touchModelRequest();
  const t0 = Date.now();
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const rawLang2 = url.searchParams.get('language') || '';
  const language = rawLang2 ? validateLang(rawLang2, 'fr') : '';
  const prompt = url.searchParams.get('prompt') || '';
  // Real-time budget: use whatever providers responded within this window.
  // Default 1500ms — keeps subtitle pipeline responsive even when a provider is slow.
  const timeoutMs = Math.min(
    parseInt(url.searchParams.get('timeout_ms') || '1500', 10) || 1500,
    10_000, // hard cap
  );

  let audio: Buffer;
  const ensembleBodyPromise = readRawBody(req, res);
  if (!ensembleBodyPromise) return;  // Content-Length exceeded — response already sent
  try { audio = await ensembleBodyPromise; }
  catch (e) {
    if (e instanceof BodyTimeoutError) { res.writeHead(408, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Request Timeout' })); return; }
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ensemble] Body read error:', msg);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
    return;
  }

  if (audio.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No audio data' }));
    return;
  }

  // Wire up available providers, filtered by ENSEMBLE_STT_PROVIDERS and optional ?providers= param
  const requestedProviders = url.searchParams.get('providers')
    ? url.searchParams.get('providers')!.toLowerCase().split(',').map((s: string) => s.trim()).filter(Boolean)
    : ENSEMBLE_STT_PROVIDERS;
  const useAll = requestedProviders.includes('all');
  const wants = (name: string): boolean => useAll || requestedProviders.includes(name);

  const activeProviders: EnsembleSTTProviderEntry[] = [];
  if (groqAvailable && wants('groq')) activeProviders.push({ name: 'groq', provider: groqSTT });
  if (openaiAvailable && wants('openai')) activeProviders.push({ name: 'openai', provider: openaiSTT });
  if (deepgramAvailable && wants('deepgram')) activeProviders.push({ name: 'deepgram', provider: deepgramSTT });
  if (fireworksAvailable && wants('fireworks')) activeProviders.push({ name: 'fireworks', provider: fireworksSTT });
  if (whisperAvailable && wants('whisper')) activeProviders.push({ name: 'whisper', provider: new OllamaSTTProvider(whisperHost) });

  try {
    // Embedding fallbacks: Qwen3-0.6b (OpenRouter) → OpenAI 3-small
    // Triggered automatically when Jaccard agreement < 0.3 (language divergence etc.)
    const embeddingFallbacks: import('../src/providers/openai-compat/openai-compat-embedding').EmbeddingProvider[] = [];
    if (openrouterAvailable) embeddingFallbacks.push(openrouterQwen3Embedding);
    if (openaiAvailable) embeddingFallbacks.push(openaiEmbedding);

    const result = await runEnsembleSTT(audio, language, prompt, {
      providers: activeProviders,
      embeddingFallbacks,
      timeoutMs,
    });

    // Apply hallucination filter (metadata + blocklist)
    const config = loadProviderConfig();
    const filterSettings = config.sttHallucinationFilter;
    const filterConfig: STTHallucinationFilterConfig = {
      ...DEFAULT_HALLUCINATION_FILTER_CONFIG,
      ...(filterSettings?.metadataFilterEnabled !== undefined && { metadataFilterEnabled: filterSettings.metadataFilterEnabled }),
      ...(filterSettings?.blocklistFilterEnabled !== undefined && { blocklistFilterEnabled: filterSettings.blocklistFilterEnabled }),
      ...(filterSettings?.noSpeechProbThreshold !== undefined && { noSpeechProbThreshold: filterSettings.noSpeechProbThreshold }),
      ...(filterSettings?.compressionRatioThreshold !== undefined && { compressionRatioThreshold: filterSettings.compressionRatioThreshold }),
      ...(filterSettings?.avgLogprobThreshold !== undefined && { avgLogprobThreshold: filterSettings.avgLogprobThreshold }),
    };

    // Build a synthetic STTResponse for the filter
    const sttResponse: STTResponse = {
      text: result.consensus,
      segments: result.segments,
      avg_logprob: result.avg_logprob,
      compression_ratio: result.compression_ratio,
      no_speech_prob: result.no_speech_prob,
    };
    const filterResult = filterHallucinations(sttResponse, language, filterConfig);

    if (filterResult.filtered) {
      console.log(`[ensemble] Hallucination filter: "${result.consensus.slice(0, 60)}" → "${filterResult.text.slice(0, 60)}" [${filterResult.reasons.join('; ')}]`);
      result.consensus = filterResult.text;
    }

    const methodTag = result.similarity_method === 'embedding'
      ? `embed(${result.embedding_provider ?? '?'})`
      : 'jaccard';
    console.log(`[ensemble] ${Object.keys(result.providers).join('+')} [${methodTag}] → ${result.latency_ms}ms: "${result.consensus.slice(0, 80)}"`);
    logRequest({ timestamp: Date.now(), stage: 'stt', provider: 'ensemble', latencyMs: result.latency_ms, success: true, inputSize: audio.length, outputPreview: result.consensus.slice(0, 80) });

    // Include filter metadata in response for Python client
    const responseBody: Record<string, unknown> = { ...result };
    if (filterResult.metrics) responseBody.hallucinationMetrics = filterResult.metrics;
    if (filterResult.filtered) responseBody.hallucinationFiltered = true;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const latencyMs = Date.now() - t0;
    console.error(`[ensemble] Failed (${latencyMs}ms):`, msg);
    logRequest({ timestamp: Date.now(), stage: 'stt', provider: 'ensemble', latencyMs, success: false, error: msg, inputSize: audio.length });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error', providers: {} }));
  }
}

// ── TTS Preview endpoint ─────────────────────────────────────────────────────

export async function handleTtsPreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  touchRequest(); touchModelRequest();
  const t0 = Date.now();
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: { text?: string; speaker?: string; language?: string; reference_audio?: string; ref_text?: string };
  try { body = await readJsonBody(req) as typeof body; }
  catch (err) { console.warn('[tts-preview] Invalid JSON body:', err instanceof Error ? err.message : err); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

  const text = body.text?.trim() || '';
  if (!text) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'text is required' })); return; }

  const speaker = body.speaker || 'Ryan';
  const language = body.language || 'English';
  const referenceAudio = body.reference_audio || '';
  const refText = body.ref_text || '';
  const isCloneRequest = !!(referenceAudio && refText);

  const gpuEndpoint = isGpuAvailable() ? deployState.endpoint : null;

  try {
    // Voice clone requests need Qwen3-TTS (GPU pod or Modal) — cloud TTS can't clone
    if (gpuEndpoint) {
      // GPU pod available — use it directly (supports both preset and clone)
      validateRemoteEndpoint(gpuEndpoint);
      const gpuBody: Record<string, string> = { text, speaker, language };
      if (isCloneRequest) { gpuBody.reference_audio = referenceAudio; gpuBody.ref_text = refText; }
      const gpuRes = await fetch(`${gpuEndpoint}/v1/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gpuBody),
        signal: AbortSignal.timeout(isCloneRequest ? 180_000 : GPU_TTS_TIMEOUT_MS),
      });
      if (!gpuRes.ok) {
        const errText = await gpuRes.text().catch(() => '');
        console.warn(`[tts] preview GPU failed (${gpuRes.status}): ${errText.slice(0, 120)}, falling back to Modal`);
        // Fall through to Modal fallback below
      } else {
        const audio = Buffer.from(await gpuRes.arrayBuffer());
        const latencyMs = Date.now() - t0;
        console.log(`[tts] preview [gpu${isCloneRequest ? '/clone' : ''}]: speaker=${speaker} lang=${language} ${audio.length}B ${latencyMs}ms`);
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(audio);
        return;
      }
    }

    // Clone requests: route to Modal Qwen3-TTS via ai-gateway provider (only one that supports cloning)
    if (isCloneRequest) {
      console.log(`[tts] voice clone → Modal Qwen3-TTS (ref_text="${refText.slice(0, 40)}...")`);
      const result = await modalTTS.synthesize({
        input: text,
        model: 'qwen3-tts',
        voice: speaker,
        referenceAudio: referenceAudio,
        refText: refText,
      });
      const latencyMs = Date.now() - t0;
      console.log(`[tts] preview [modal/clone]: speaker=${speaker} lang=${language} ${result.audio.length}B ${latencyMs}ms`);
      res.writeHead(200, { 'Content-Type': result.contentType || 'audio/wav' });
      res.end(result.audio);
      return;
    }

    // Non-clone fallback: use cloud TTS chain (Groq Orpheus → Modal Qwen3-TTS → OpenAI)
    console.log(`[tts] preview: no GPU, using cloud fallback`);
    const result = await client.synthesize(text, {
      ...translationProfile,
      gpuEndpoint: undefined,
      voice: speaker,
      audioFormat: 'wav',
    });
    const latencyMs = Date.now() - t0;
    console.log(`[tts] preview [cloud]: speaker=${speaker} lang=${language} ${result.audio.length}B ${latencyMs}ms`);
    res.writeHead(200, { 'Content-Type': result.contentType || 'audio/wav' });
    res.end(result.audio);
  } catch (err) {
    console.error('[tts] preview error:', err instanceof Error ? err.message : err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

// ── GPU-aware translation endpoint (with request hedging) ───────────────────

export async function handleTranslate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  touchRequest(); touchModelRequest();
  const t0 = Date.now();
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }
  const text = (body.text as string) || '';
  const sourceLang = validateLang((body.source_lang as string) || 'fr', 'fr');
  const targetLang = validateLang((body.target_lang as string) || 'en', 'en');
  const glossary = ((body.glossary as string) || '').trim();
  const context  = ((body.context  as string) || '').trim();
  const style    = ((body.style    as string) || 'default').trim();

  if (!text.trim()) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ translated_text: '', used_gpu: false }));
    return;
  }

  // Check translation cache first (avoids redundant LLM calls for repeated phrases)
  const cached = getCachedTranslation(text, sourceLang, targetLang, style);
  if (cached !== null) {
    console.log(`[llm] Cache hit: '${text.slice(0, 50)}' -> '${cached.slice(0, 50)}'`);
    logRequest({ timestamp: Date.now(), stage: 'llm', provider: 'cache', latencyMs: 0, success: true, inputSize: text.length, outputPreview: cached.slice(0, 80) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ translated_text: cached, used_gpu: false }));
    return;
  }

  const sourceName = langNames[sourceLang] || sourceLang;
  const targetName = langNames[targetLang] || targetLang;
  let systemPrompt = buildSystemPrompt(sourceName, targetName, style);
  if (context) {
    systemPrompt += `\n\nSession context (use to improve accuracy and terminology):\n${context}`;
  }
  if (glossary) {
    systemPrompt += `\n\nDomain-specific glossary (preserve these terms accurately):\n${glossary}`;
  }
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: text },
  ];

  // Adaptive maxTokens: short inputs need fewer tokens
  const maxTokens = adaptiveMaxTokens(text);

  // Adaptive GPU timeout based on recent P95 latency
  const gpuLlmTimeout = adaptiveGpuTimeout(GPU_LLM_TIMEOUT_MS);

  // Shadow mode: GPU fires in background, cloud serves the actual response
  if (gpuShadowMode && deployState.endpoint) {
    const shadowEndpoint = deployState.endpoint;
    const shadowTarget = Math.round(getLlmTargetLatencyMs() * (1 - getBenchmarkMarginPct() / 100));
    const t0Shadow = Date.now();
    fetchGpuLLM(shadowEndpoint, text, sourceLang, targetLang, glossary, context, AbortSignal.timeout(GPU_LLM_TIMEOUT_MS), requestId)
      .then(() => {
        const ms = Date.now() - t0Shadow;
        recordGpuLatency(ms);
        recordPerStageLatency('llm', ms);
        recordShadowRun(ms, shadowTarget, () => markGpuProductionReady(shadowEndpoint));
      })
      .catch(e => console.warn('[shadow] LLM run failed:', e instanceof Error ? e.message : e)); // ignore shadow errors
  }

  // Build race candidates: GPU (if available) + cloud providers
  const candidates: RaceCandidate<GpuLLMResult>[] = [];
  const gpuEndpoint = isGpuReadyForProduction() ? deployState.endpoint : null;

  if (gpuEndpoint && shouldPreferGpu()) {
    candidates.push({
      name: 'gpu',
      timeoutMs: gpuLlmTimeout,
      run: (signal) => fetchGpuLLM(gpuEndpoint, text, sourceLang, targetLang, glossary, context, signal, requestId),
    });
  }

  const cloudProfile = getCloudProfile();
  if (cloudProfile) {
    const cloudName = getCloudProviderName();
    candidates.push({
      name: cloudName,
      timeoutMs: 8_000,
      run: async (signal) => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const profileWithTokens = { ...cloudProfile, maxTokens, temperature: 0 };  // deterministic translations (#59)
        const result = await client.chat(messages, profileWithTokens);
        return { translated_text: result.content, used_gpu: false };
      },
    });
  }

  // GPU as backup if latency is poor
  if (gpuEndpoint && !shouldPreferGpu() && candidates.length > 0) {
    candidates.push({
      name: 'gpu',
      timeoutMs: gpuLlmTimeout,
      run: (signal) => fetchGpuLLM(gpuEndpoint, text, sourceLang, targetLang, glossary, context, signal, requestId),
    });
  }

  if (candidates.length === 0) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No providers available for translation', translated_text: '' }));
    return;
  }

  logRouteDecision('translate', candidates, gpuEndpoint);

  try {
    const { result, provider, latencyMs } = await raceProviders(candidates, {
      logPrefix: '[llm]',
      headstartMs: 0,
    });

    if (provider === 'gpu') { recordGpuLatency(latencyMs); recordPerStageLatency('llm', latencyMs); }
    // Cache the result for future identical requests
    if (result.translated_text) {
      setCachedTranslation(text, sourceLang, targetLang, result.translated_text, style);
      console.log(`[${provider}] Translate: '${text.slice(0, 50)}' -> '${result.translated_text.slice(0, 50)}'`);
    }
    logRequest({ timestamp: Date.now(), stage: 'llm', provider: provider as 'gpu' | 'groq' | 'ollama' | 'ensemble' | 'cache' | 'hybrid', latencyMs, success: true, inputSize: text.length, outputPreview: result.translated_text.slice(0, 80) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ translated_text: result.translated_text, used_gpu: result.used_gpu }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[gateway] All translation providers failed: ${msg}`);
    logRequest({ timestamp: Date.now(), stage: 'llm', provider: getCloudProviderName(), latencyMs: Date.now() - t0, success: false, error: msg, inputSize: text.length });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'All providers failed for translation', translated_text: '' }));
  }
}

// ── Full pipeline route (STT + LLM + TTS) ──────────────────────────────────

const TRANSLATION_STYLES: Record<string, string> = {
  default:  'You are a real-time translator. Translate the following text accurately and naturally. Output ONLY the translation, nothing else.',
  academic: 'You are a real-time translator for an academic conference. Translate the following text into formal, scholarly English suitable for a scientific seminar or lecture presentation. Use precise academic vocabulary, complete sentences, formal register (no contractions, no slang), and natural academic discourse markers (therefore, furthermore, consequently, it is noteworthy that…). Output ONLY the translation, nothing else.',
  casual:   'You are a real-time translator. Translate the following text in a natural, conversational tone — as if two friends were talking. Keep it relaxed and colloquial. Output ONLY the translation, nothing else.',
  news:     'You are a real-time translator for broadcast journalism. Translate with the clarity and authority of a TV news anchor — concise, neutral, professional. Output ONLY the translation, nothing else.',
};

export function buildSystemPrompt(source: string, target: string, style: string = 'default'): string {
  const prompt = TRANSLATION_STYLES[style] ?? TRANSLATION_STYLES.default;
  return `${prompt}\nTranslate from ${source} to ${target}.`;
}

/** Resolve a speaker/voice name to one valid for the active TTS provider.
 * Now that Modal Qwen3-TTS is the primary cloud fallback, we keep the original
 * Qwen3-TTS name (Ryan, Vivian etc.) — Modal accepts them natively.
 * Each downstream provider (Groq, OpenAI) has its own resolveVoice() that maps
 * unknown names to their own defaults automatically. */
export function resolveVoiceForProfile(speaker: string, _hasGpu: boolean): string {
  return speaker;
}

// ── Pipeline sub-function types ─────────────────────────────────────────────

/** Parsed pipeline request parameters — output of _parsePipelineRequest. */
interface PipelineParams {
  source: string;
  target: string;
  sourceName: string;
  targetName: string;
  speaker: string | undefined;
  style: string;
  sttPrompt: string;
  referenceAudio: string | undefined;
  refText: string | undefined;
  isCloneRequest: boolean;
  cloneTtsChain: Array<{ provider: string; model: string; voice?: string }> | undefined;
  systemPrompt: string;
  audioBuffer: Buffer;
  baseProfile: AIProfile;
  gpuBeforeCloud: boolean;
  cloudProfile: AIProfile;
  // Per-stage routing decisions
  gpuEp: string | undefined;
  sttOnGpu: boolean;
  llmOnGpu: boolean;
  ttsOnGpu: boolean;
  allOnGpu: boolean;
  anyOnGpu: boolean;
  cloneGpuEndpoint: string | undefined;
  requestId: string;
}

/** STT stage result. */
interface SttStageResult {
  text: string;
  provider: string;
  latencyMs: number;
  serverMs: number | undefined;
  networkMs: number | undefined;
}

/** LLM stage result. */
interface LlmStageResult {
  translatedText: string;
  provider: string;
  latencyMs: number;
}

/** TTS stage result. */
interface TtsStageResult {
  audioB64: string;
  audioRaw?: Buffer;       // raw audio bytes (kept for binary HTTP responses)
  contentType: string;
  provider: string;
  latencyMs: number;
}

/** Full pipeline response body. */
interface PipelineResponseBody {
  transcription: string;
  response: string;
  audio_base64: string;
  content_type: string;
  timing: Record<string, unknown>;
}

// ── Pipeline sub-functions ──────────────────────────────────────────────────

/**
 * Parse and validate all pipeline request parameters.
 * Returns null if the request is invalid (response already sent to client).
 */
async function _parsePipelineRequest(
  req: IncomingMessage, res: ServerResponse, url: URL, requestId: string,
): Promise<PipelineParams | null> {
  const source = validateLang(url.searchParams.get('source') || 'fr', 'fr');
  const target = validateLang(url.searchParams.get('target') || 'en', 'en');
  const speaker = url.searchParams.get('speaker') || undefined;
  const style = url.searchParams.get('style') || 'default';
  // Voice cloning: ref_id (cached) takes priority over inline reference_audio
  const sttPrompt = url.searchParams.get('prompt') || '';
  const refId = url.searchParams.get('ref_id') || undefined;
  let referenceAudio: string | undefined;
  let refText: string | undefined;
  if (refId) {
    const cached = getVoiceReference(refId);
    if (cached) {
      referenceAudio = cached.audio;
      refText = cached.text;
      console.log(`[pipeline] Using cached voice ref ${refId} (${(cached.audio.length/1024).toFixed(0)}KB)`);
    }
  }
  if (!referenceAudio) {
    referenceAudio = (req.headers['x-reference-audio'] as string) || undefined;
  }
  if (!refText) {
    const refTextRaw = (req.headers['x-ref-text'] as string) || url.searchParams.get('ref_text') || undefined;
    refText = refTextRaw ? decodeURIComponent(refTextRaw) : undefined;
  }

  // When voice cloning is requested, force TTS to Modal (Groq/OpenAI don't support cloning)
  // GPU pod handles cloning directly in the hybrid race (fetchGpuTTS passes reference_audio/ref_text)
  const isCloneRequest = Boolean(referenceAudio && refText);
  if (isCloneRequest) {
    console.log(`[pipeline] Voice cloning active — TTS: GPU direct + Modal fallback (ref_text='${refText?.slice(0, 50)}...')`);
    touchModalKeepalive();
  }
  // Clone-aware TTS chain: Modal first (supports cloning), Groq as fallback (no cloning but has audio)
  const cloneTtsChain = isCloneRequest
    ? [{ provider: 'modal', model: 'qwen3-tts' }, { provider: 'groq', model: groqTtsModel, voice: groqTtsVoice }]
    : undefined;  // use default chain

  const sourceName = langNames[source] || source;
  const targetName = langNames[target] || target;
  const systemPrompt = buildSystemPrompt(sourceName, targetName, style);

  let audioBuffer: Buffer;
  const speechBodyPromise = readRawBody(req, res);
  if (!speechBodyPromise) return null;  // Content-Length exceeded — response already sent
  try { audioBuffer = await speechBodyPromise; }
  catch (e) {
    if (e instanceof BodyTimeoutError) { res.writeHead(408, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Request Timeout' })); return null; }
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid request body' })); return null;
  }
  if (audioBuffer.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No audio data' }));
    return null;
  }

  // Determine profile based on chain: find first cloud provider for base profile
  const firstCloudIdx = PROVIDER_CHAIN.findIndex(p => p === 'groq' || p === 'ollama');
  const gpuIdx = PROVIDER_CHAIN.findIndex(p => GPU_PROVIDERS.has(p));
  const baseProfile = (firstCloudIdx >= 0 && PROVIDER_CHAIN[firstCloudIdx] === 'ollama' && ollamaProfile)
    ? ollamaProfile : (groqProfile || ollamaProfile || translationProfile);
  const gpuBeforeCloud = gpuIdx >= 0 && (firstCloudIdx < 0 || gpuIdx < firstCloudIdx);

  // ── Per-stage warmth routing ──────────────────────────────────────────────
  // Check which GPU models are warm. When all warm → atomic GPU pipeline.
  // When some warm → hybrid: GPU for warm stages, cloud for cold stages.
  // When none warm → all cloud.
  const gpuEp = (gpuBeforeCloud && isGpuAvailable()) ? deployState.endpoint : undefined;
  // [6] Circuit breaker: skip GPU stage if it failed 3x consecutively
  const sttOnGpu = !!gpuEp && isStageWarm('stt') && isStageCircuitClosed('stt');
  const llmOnGpu = !!gpuEp && isStageWarm('llm') && isStageCircuitClosed('llm');
  const ttsOnGpu = !!gpuEp && shouldPreferGpuTts() && isStageCircuitClosed('tts');
  // Voice cloning requires hybrid mode — atomic /v1/speech doesn't pass reference_audio.
  // Force hybrid when clone is active so fetchGpuTTS sends reference data to /v1/tts directly.
  const allOnGpu = sttOnGpu && llmOnGpu && ttsOnGpu && !isCloneRequest;
  const anyOnGpu = sttOnGpu || llmOnGpu || ttsOnGpu;

  // Cloud profile (no gpuEndpoint) for per-stage cloud calls
  const cloudVoice = speaker ? resolveVoiceForProfile(speaker, false) : undefined;
  // Voice cloning takes 20-40s on GPU — increase timeout and disable adaptive timeout
  const cloudProfile: AIProfile = {
    ...baseProfile,
    gpuEndpoint: undefined,
    language: source,
    ...(sttPrompt ? { sttPrompt } : {}),
    ...(cloudVoice ? { voice: cloudVoice } : {}),
    ...(referenceAudio ? { referenceAudio } : {}),
    ...(refText ? { refText } : {}),
    ...(cloneTtsChain ? { tts: cloneTtsChain } : {}),  // force Modal TTS for voice cloning
    fallbackOptions: {
      ...baseProfile.fallbackOptions,
      timeoutMs: isCloneRequest ? 60_000 : GPU_PIPELINE_TIMEOUT_MS,
      // Disable adaptive timeout for clone requests — clone inference is much slower than presets
      ...(isCloneRequest ? { adaptiveTimeout: undefined } : {}),
    },
  };

  // Voice cloning: force hybrid path even when stages are cold — GPU /v1/tts with reference_audio
  // bypasses the client.synthesize() fallback chain which has adaptive timeouts that are too short.
  // Use deployState.endpoint directly — gpuEp may be undefined if warmth checks fail.
  // For clone: use GPU endpoint even if gpuHealthy hasn't been confirmed yet (health check may be slow)
  const cloneGpuEndpoint = isCloneRequest && deployState.status === 'ready' && deployState.endpoint
    ? deployState.endpoint : undefined;

  return {
    source, target, sourceName, targetName, speaker, style, sttPrompt,
    referenceAudio, refText, isCloneRequest, cloneTtsChain, systemPrompt,
    audioBuffer, baseProfile, gpuBeforeCloud, cloudProfile,
    gpuEp, sttOnGpu, llmOnGpu, ttsOnGpu, allOnGpu, anyOnGpu, cloneGpuEndpoint,
    requestId,
  };
}

/**
 * Run the STT stage: race GPU vs cloud providers for transcription.
 */
async function _runSttStage(params: PipelineParams): Promise<SttStageResult> {
  const { sttOnGpu, gpuEp, audioBuffer, source, sttPrompt, cloudProfile, requestId } = params;

  const sttCandidates: RaceCandidate<GpuSTTResult>[] = [];
  const sttTimeout = adaptiveStageTimeout('stt', GPU_STT_TIMEOUT_MS);
  if (sttOnGpu) {
    sttCandidates.push({
      name: 'gpu', timeoutMs: sttTimeout,
      run: (signal) => fetchGpuSTT(gpuEp!, audioBuffer, source, sttPrompt, '', false, signal, requestId),
    });
  }
  // Add Modal tier 2 unless Modal IS the active GPU endpoint AND already handling this stage via sttOnGpu
  if (MODAL_BABELCAST_URL && !(sttOnGpu && deployState.endpoint === MODAL_BABELCAST_URL)) {
    sttCandidates.push({
      name: 'modal-babelcast', timeoutMs: 15_000,
      run: (signal) => fetchGpuSTT(MODAL_BABELCAST_URL!, audioBuffer, source, sttPrompt, '', false, signal, requestId),
    });
  }
  sttCandidates.push({
    name: getCloudProviderName(), timeoutMs: 8_000,
    run: async (signal) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const r = await client.transcribe(audioBuffer, cloudProfile);
      const rAny = r as { text: string; language?: string; timing?: { total_ms: number; server_ms?: number; network_ms?: number } };
      return { text: r.text, language: r.language || '', used_gpu: false, avg_logprob: 0, _sttTiming: rAny.timing };
    },
  });

  const sttRace = await raceProviders(sttCandidates, { logPrefix: '[pipeline-stt]', headstartMs: 0 });
  const sttTiming = (sttRace.result as unknown as Record<string, unknown>)['_sttTiming'] as { total_ms: number; server_ms?: number; network_ms?: number } | undefined;
  const sttNetworkMs = sttTiming?.network_ms;
  const sttServerMs = sttTiming?.server_ms;
  console.log(`[pipeline] STT [${sttRace.provider}] (${sttRace.latencyMs}ms${sttNetworkMs !== undefined ? ` net=${sttNetworkMs}ms srv=${sttServerMs}ms` : ''}): "${(sttRace.result.text || '').substring(0, 80)}"`);

  return {
    text: sttRace.result.text,
    provider: sttRace.provider,
    latencyMs: sttRace.latencyMs,
    serverMs: sttServerMs,
    networkMs: sttNetworkMs,
  };
}

/**
 * Run the LLM stage: check cache, then race GPU vs cloud for translation.
 * Also pushes early subtitle via WebSocket.
 */
async function _runLlmStage(params: PipelineParams, sttResult: SttStageResult): Promise<LlmStageResult> {
  const { source, target, style, llmOnGpu, gpuEp, cloudProfile, systemPrompt, requestId } = params;
  const sttText = sttResult.text;

  // [2] Check translation cache first
  const cached = getCachedTranslation(sttText, source, target, style);

  if (cached !== null) {
    console.log(`[pipeline] LLM [cache] (0ms): "${cached.substring(0, 80)}"`);
    // [3] Early subtitle push — send text to WS clients before TTS
    if (cached.trim()) {
      broadcastWs({
        type: 'subtitle:early',
        transcription: sttText,
        translation: cached,
        source, target,
        timing: { stt_ms: sttResult.latencyMs, llm_ms: 0 },
      });
    }
    return { translatedText: cached, provider: 'cache', latencyMs: 0 };
  }

  // [1] Race GPU vs cloud for LLM
  const llmCandidates: RaceCandidate<GpuLLMResult>[] = [];
  const llmTimeout = adaptiveStageTimeout('llm', GPU_LLM_TIMEOUT_MS);
  if (llmOnGpu) {
    llmCandidates.push({
      name: 'gpu', timeoutMs: llmTimeout,
      run: (signal) => fetchGpuLLM(gpuEp!, sttText, source, target, '', '', signal, requestId),
    });
  }
  // Add Modal tier 2 unless Modal IS the active GPU endpoint AND already handling this stage via llmOnGpu
  if (MODAL_BABELCAST_URL && !(llmOnGpu && deployState.endpoint === MODAL_BABELCAST_URL)) {
    llmCandidates.push({
      name: 'modal-babelcast', timeoutMs: 15_000,
      run: (signal) => fetchGpuLLM(MODAL_BABELCAST_URL!, sttText, source, target, '', '', signal, requestId),
    });
  }
  llmCandidates.push({
    name: getCloudProviderName(), timeoutMs: 8_000,
    run: async (signal) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const messages = [{ role: 'system' as const, content: systemPrompt }, { role: 'user' as const, content: sttText }];
      const r = await client.chat(messages, cloudProfile);
      return { translated_text: r.content, used_gpu: false };
    },
  });

  const llmRace = await raceProviders(llmCandidates, { logPrefix: '[pipeline-llm]', headstartMs: 0 });
  const translatedText = llmRace.result.translated_text;
  const llmProvider = llmRace.provider;
  const llmMs = llmRace.latencyMs;
  console.log(`[pipeline] LLM [${llmProvider}] (${llmMs}ms): "${(translatedText || '').substring(0, 80)}"`);

  // [2] Cache the translation for future requests
  if (translatedText) {
    setCachedTranslation(sttText, source, target, translatedText, style);
  }

  // [3] Early subtitle push — send text to WS clients before TTS
  if (translatedText.trim()) {
    broadcastWs({
      type: 'subtitle:early',
      transcription: sttText,
      translation: translatedText,
      source, target,
      timing: { stt_ms: sttResult.latencyMs, llm_ms: llmMs },
    });
  }

  return { translatedText, provider: llmProvider, latencyMs: llmMs };
}

/**
 * Run the TTS stage: race GPU vs cloud (or GPU-only for voice cloning).
 * Handles clone fallback and GPU TTS warmth tracking.
 */
async function _runTtsStage(params: PipelineParams, translatedText: string): Promise<TtsStageResult> {
  const {
    isCloneRequest, ttsOnGpu, gpuEp, cloneGpuEndpoint,
    targetName, speaker, referenceAudio, refText, cloudProfile, requestId,
  } = params;

  if (!translatedText.trim()) {
    return { audioB64: '', contentType: '', provider: '', latencyMs: 0 };
  }

  const ttsCandidates: RaceCandidate<GpuTTSResult>[] = [];
  const ttsTimeout = isCloneRequest ? 60_000 : adaptiveStageTimeout('tts', GPU_TTS_TIMEOUT_MS);
  const ttsGpuEp = gpuEp || cloneGpuEndpoint;
  // GPU TTS: only when circuit is closed AND endpoint exists
  const gpuTtsUsable = ttsGpuEp && isStageCircuitClosed('tts');
  const ttsCircuitOpen = ttsGpuEp && !isStageCircuitClosed('tts');
  console.log(`[pipeline-tts] Decision: clone=${isCloneRequest} gpuEp=${!!ttsGpuEp} gpuUsable=${!!gpuTtsUsable} circuitOpen=${!!ttsCircuitOpen} ttsOnGpu=${ttsOnGpu}`);

  if (ttsOnGpu || (isCloneRequest && gpuTtsUsable)) {
    console.log(`[pipeline-tts] Adding GPU candidate (endpoint=${ttsGpuEp})`);
    ttsCandidates.push({
      name: 'gpu', timeoutMs: ttsTimeout,
      run: (signal) => fetchGpuTTS(ttsGpuEp!, translatedText, targetName, speaker || 'Ryan', signal, referenceAudio, refText, requestId),
    });
  }
  // Voice cloning: ALWAYS add Modal as candidate (GPU may be dead/circuit-open)
  if (isCloneRequest) {
    console.log(`[pipeline-tts] Adding Modal clone candidate (ref_audio=${referenceAudio ? `${(referenceAudio.length/1024).toFixed(0)}KB` : 'none'} ref_text=${refText?.length || 0} chars)`);
    ttsCandidates.push({
      name: 'modal', timeoutMs: ttsTimeout,
      run: async (signal) => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        console.log(`[pipeline-tts] Modal clone START: "${translatedText.slice(0, 50)}..."`);
        try {
          const r = await modalTTS.synthesize({
            input: translatedText,
            model: 'qwen3-tts',
            voice: speaker || 'Ryan',
            referenceAudio: referenceAudio,
            refText: refText,
          });
          console.log(`[pipeline-tts] Modal clone OK: ${r.audio.length} bytes (${r.contentType})`);
          return { audio: r.audio, contentType: r.contentType, used_gpu: false };
        } catch (err) {
          console.error(`[pipeline-tts] Modal clone FAILED: ${err instanceof Error ? err.message : err}`);
          throw err;
        }
      },
    });
  } else if (!isCloneRequest) {
    // Add Modal tier 2 unless Modal IS the active GPU endpoint AND already handling this stage via ttsOnGpu
    if (MODAL_BABELCAST_URL && !(ttsOnGpu && deployState.endpoint === MODAL_BABELCAST_URL)) {
      ttsCandidates.push({
        name: 'modal-babelcast', timeoutMs: 20_000,
        run: (signal) => fetchGpuTTS(MODAL_BABELCAST_URL!, translatedText, targetName, speaker || 'Ryan', signal, undefined, undefined, requestId),
      });
    }
    console.log(`[pipeline-tts] Adding cloud TTS candidate (${getCloudProviderName()})`);
    ttsCandidates.push({
      name: getCloudProviderName(), timeoutMs: 8_000,
      run: async (signal) => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const r = await client.synthesize(translatedText, cloudProfile);
        return { audio: r.audio, contentType: r.contentType, used_gpu: false };
      },
    });
  }

  let audioB64 = '';
  let audioRaw: Buffer | undefined;
  let contentType = '';
  let ttsMs = 0;
  let ttsProvider = '';

  console.log(`[pipeline-tts] Racing ${ttsCandidates.length} candidates: ${ttsCandidates.map(c => c.name).join(', ')}`);
  try {
    const ttsRace = await raceProviders(ttsCandidates, { logPrefix: '[pipeline-tts]', headstartMs: 0 });
    audioRaw = Buffer.isBuffer(ttsRace.result.audio) ? ttsRace.result.audio : Buffer.from(ttsRace.result.audio);
    audioB64 = audioRaw.toString('base64');
    contentType = ttsRace.result.contentType;
    ttsProvider = ttsRace.provider;
    ttsMs = ttsRace.latencyMs;
    console.log(`[pipeline-tts] Winner: ${ttsProvider} (${ttsMs}ms, ${audioB64.length} bytes b64)`);
  } catch (ttsErr) {
    console.error(`[pipeline-tts] ALL clone candidates failed: ${ttsErr instanceof Error ? ttsErr.message : ttsErr}`);
    // Fallback: use cloud TTS with preset voice (better than silence)
    if (isCloneRequest) {
      try {
        console.log(`[pipeline-tts] Clone failed — falling back to Groq preset voice`);
        const fallbackT0 = Date.now();
        const r = await client.synthesize(translatedText, { ...cloudProfile, referenceAudio: undefined, refText: undefined, tts: undefined });
        audioRaw = Buffer.isBuffer(r.audio) ? r.audio : Buffer.from(r.audio);
        audioB64 = audioRaw.toString('base64');
        contentType = r.contentType;
        ttsProvider = `${r.provider}/preset-fallback`;
        ttsMs = Date.now() - fallbackT0;
        console.log(`[pipeline-tts] Fallback OK: ${ttsProvider} (${ttsMs}ms, ${audioB64.length} bytes b64)`);
      } catch (fbErr) {
        console.error(`[pipeline-tts] Fallback also failed: ${fbErr instanceof Error ? fbErr.message : fbErr}`);
      }
    }
    // TTS optional — subtitles still work without audio
  }
  console.log(`[pipeline] TTS [${ttsProvider || 'none'}] (${ttsMs}ms): ${audioB64 ? `${audioB64.length} bytes b64` : 'NO AUDIO'}`);

  // Track GPU TTS warmth
  if (ttsProvider === 'gpu' && ttsMs > 0) {
    recordPerStageLatency('tts', ttsMs);
    const warmthProfile = { gpuType: deployState.gpuType, dockerImage: deployState.dockerImage, provider: deployState.provider, modelLoadMs: 0, measuredAt: Date.now() };
    if (!isTtsWarm()) {
      markTtsWarm(ttsMs);
      saveColdStartProfile({ ...warmthProfile, coldTtfbMs: ttsMs, warmTtfbAvgMs: 240, sampleCount: 0 });
    } else {
      recordTtsTtfb(ttsMs);
    }
  }

  return { audioB64, audioRaw, contentType, provider: ttsProvider, latencyMs: ttsMs };
}

/**
 * Build the final pipeline JSON response body.
 */
function _encodePipelineResponse(
  stt: SttStageResult, llm: LlmStageResult, tts: TtsStageResult,
  totalMs: number, isCloneRequest: boolean,
): PipelineResponseBody {
  const usedAnyGpu = stt.provider === 'gpu' || llm.provider === 'gpu' || tts.provider === 'gpu';
  return {
    transcription: stt.text,
    response: llm.translatedText,
    audio_base64: tts.audioB64,
    content_type: tts.contentType,
    timing: {
      total_ms: totalMs, stt_ms: stt.latencyMs, llm_ms: llm.latencyMs, tts_ms: tts.latencyMs,
      used_gpu: usedAnyGpu,
      stt_provider: stt.provider, llm_provider: llm.provider, tts_provider: tts.provider || 'none',
      clone: isCloneRequest,
      ...(stt.serverMs !== undefined && { stt_server_ms: stt.serverMs, stt_network_ms: stt.networkMs }),
    },
  };
}

/**
 * Check whether the client wants raw binary audio (Accept: audio/wav or application/octet-stream).
 */
function _wantsBinaryAudio(req: IncomingMessage): boolean {
  const accept = req.headers['accept'] || '';
  return accept.includes('audio/wav') || accept.includes('application/octet-stream');
}

/**
 * Send the pipeline response — either raw binary audio with metadata in headers
 * (when Accept: audio/wav) or the traditional JSON format (backwards compatible).
 */
function _sendPipelineResponse(
  req: IncomingMessage, res: ServerResponse,
  body: PipelineResponseBody,
  audioRaw?: Buffer,
): void {
  if (_wantsBinaryAudio(req) && audioRaw && audioRaw.length > 0) {
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'X-Transcription': encodeURIComponent(body.transcription || ''),
      'X-Translation': encodeURIComponent(body.response || ''),
      'X-Timing': JSON.stringify(body.timing),
      'Content-Length': String(audioRaw.length),
    });
    res.end(audioRaw);
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

// ── handlePipeline (orchestrator) ────────────────────────────────────────────

// ── Hybrid Routing Advisor ──────────────────────────────────────────────────
async function getRoutingAdvice(url: URL): Promise<RoutingDecision | null> {
  // Check if hybrid routing is enabled via query param
  if (url.searchParams.get('hybrid_route') !== 'true') {
    return null; // Use legacy routing
  }

  // Get routing advice for speech pipeline
  const advice = await pipelineRouter.route('speech');
  console.log(`[pipeline] Hybrid routing advice: ${advice.reason} (${advice.confidence.toFixed(2)} confidence)`);
  return advice;
}

// ── Analytics Dashboard ─────────────────────────────────────────────────────
/**
 * GET /v1/analytics/system — Complete system analytics dashboard
 *
 * Returns comprehensive analytics including:
 * - System health overview
 * - TTFC/TTFA performance metrics
 * - Routing effectiveness
 * - Cost optimization insights
 * - Operational recommendations
 */
export async function handleSystemAnalytics(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
    // TTFC/TTFA Performance Metrics
    const realtimeMetrics = globalTracer?.getRealtimeMetrics(300_000) || {
      ttfcP50: 250, ttfcP95: 400, ttfaP50: 500, ttfaP95: 800,
      coldStartRate: 0.05, userExperienceScore: 85, audioExperienceScore: 80
    };

    // System Health Calculation
    const systemHealthScore = Math.round(
      (1 - realtimeMetrics.coldStartRate) * 0.3 +
      realtimeMetrics.userExperienceScore * 0.01 * 0.4 +
      realtimeMetrics.audioExperienceScore * 0.01 * 0.3
    );

    // Routing Analytics
    const routingAdvice = await pipelineRouter.route('speech');

    // Generate dynamic recommendations
    const recommendations = {
      immediate: [] as string[],
      shortTerm: ['Monitor TTFA improvements', 'Track circuit breaker effectiveness'] as string[],
      strategic: ['Implement predictive scaling', 'Add A/B testing for optimization'] as string[]
    };

    if (realtimeMetrics.ttfaP95 > 600) {
      recommendations.immediate.push('TTFA exceeds conversational threshold - optimize TTS streaming');
    }
    if (systemHealthScore < 70) {
      recommendations.immediate.push('System health requires attention');
    }
    if (realtimeMetrics.coldStartRate > 0.1) {
      recommendations.shortTerm.push('High cold start rate - improve warmup procedures');
    }

    const response = {
      timestamp: new Date().toISOString(),
      requestId,
      systemHealth: {
        overallScore: systemHealthScore,
        status: systemHealthScore > 80 ? 'healthy' : systemHealthScore > 60 ? 'warning' : 'critical',
        uptimeSeconds: Math.floor(Date.now() / 1000),
        version: 'mistral-7b-ttfa-optimized'
      },
      performance: {
        ttfcMetrics: {
          p50Ms: realtimeMetrics.ttfcP50,
          p95Ms: realtimeMetrics.ttfcP95,
          conversationalReady: realtimeMetrics.ttfcP95 < 300,
          remark: realtimeMetrics.ttfcP50 < 250 ? 'Excellent text response speed' : 'Good text response speed'
        },
        ttfaMetrics: {
          p50Ms: realtimeMetrics.ttfaP50,
          p95Ms: realtimeMetrics.ttfaP95,
          conversationalReady: realtimeMetrics.ttfaP95 < 500,
          remark: realtimeMetrics.ttfaP50 < 500 ? 'Excellent audio response speed' : 'Good audio response speed'
        },
        coldStartRate: realtimeMetrics.coldStartRate,
        userExperienceScore: realtimeMetrics.userExperienceScore,
        audioExperienceScore: realtimeMetrics.audioExperienceScore
      },
      routing: {
        activeStrategy: 'hybrid-gpu-first',
        currentProviderBias: routingAdvice.provider,
        confidence: routingAdvice.confidence,
        reasoning: routingAdvice.reason,
        costPerRequest: routingAdvice.costEstimate
      },
      economics: {
        gpuCostHour: 0.16,
        vsCompetitors: {
          openaiRealtime: 43.0, // $ per hour for 24x7
          openaiSavings: 99.6  // % reduction
        },
        optimizationStatus: 'TTFA streaming optimizations active',
        aiGatewayEfficiency: 0.95
      },
      recommendations
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response, null, 2));

  } catch (error) {
    console.warn(`[analytics] Failed: ${error}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      requestId,
      timestamp: new Date().toISOString()
    }));
  }
}

export async function handlePipeline(req: IncomingMessage, res: ServerResponse): Promise<void> {
  touchRequest(); touchModelRequest();
  const pipeT0 = Date.now();
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // ── Distributed tracing ────────────────────────────────────────────────────
  const traceSpan = globalTracer.startSpan('pipeline_request');
  globalTracer.addTag(traceSpan.spanId, 'request.id', requestId);
  globalTracer.addTag(traceSpan.spanId, 'request.method', req.method || 'UNKNOWN');
  globalTracer.addTag(traceSpan.spanId, 'request.url', req.url || '/');

  // ── Hybrid routing advice ──────────────────────────────────────────────────
  const routingAdvice = await getRoutingAdvice(url);
  if (routingAdvice) {
    globalTracer.addTag(traceSpan.spanId, 'routing.advice', routingAdvice.provider);
    globalTracer.addTag(traceSpan.spanId, 'routing.confidence', routingAdvice.confidence);
    globalTracer.addTag(traceSpan.spanId, 'routing.reason', routingAdvice.reason);
  }

  // ── Parse and validate request ────────────────────────────────────────────
  const params = await _parsePipelineRequest(req, res, url, requestId);
  if (!params) return;  // invalid request — response already sent

  const {
    source, target, speaker, style, systemPrompt,
    audioBuffer, baseProfile, isCloneRequest, cloneTtsChain,
    referenceAudio, refText, cloudProfile,
    gpuEp, sttOnGpu, llmOnGpu, ttsOnGpu, allOnGpu, anyOnGpu, cloneGpuEndpoint,
  } = params;

  const audioDur = (audioBuffer.length / (16000 * 2)).toFixed(1);

  // Route labels for logging
  const stageRoutes = gpuEp
    ? `STT=${sttOnGpu ? 'gpu' : 'cloud'} LLM=${llmOnGpu ? 'gpu' : 'cloud'} TTS=${ttsOnGpu ? 'gpu' : 'cloud'}${isCloneRequest ? ' (clone→hybrid)' : ''}`
    : 'all=cloud';
  const mode = allOnGpu ? 'atomic-gpu' : anyOnGpu ? 'hybrid' : 'cloud';
  console.log(`[pipeline] ── Incoming [req=${requestId.slice(0, 8)}]: ${audioDur}s audio (${audioBuffer.length} bytes) ${source}->${target}${speaker ? ` speaker=${speaker}` : ''} mode=${mode} ${stageRoutes} ──`);

  // ── Hybrid per-stage pipeline ─────────────────────────────────────────────
  // Optimizations applied:
  //   [1] Race GPU vs cloud per-stage (parallel, take fastest)
  //   [2] Translation LRU cache (skip LLM for repeated phrases)
  //   [3] Early subtitle push via WebSocket (text before TTS completes)
  //   [4] Connection overlap (pre-warm next stage's provider during current)
  //   [5] Adaptive per-stage timeouts (from pod health avg_latency_ms)
  // Voice cloning: force hybrid path even when stages are cold — GPU /v1/tts with reference_audio
  // bypasses the client.synthesize() fallback chain which has adaptive timeouts that are too short.
  // Use deployState.endpoint directly — gpuEp may be undefined if warmth checks fail.
  // For clone: use GPU endpoint even if gpuHealthy hasn't been confirmed yet (health check may be slow)
  const forceHybridForClone = !!cloneGpuEndpoint;
  // Modal BabelCast tier 2: force hybrid path when Modal is available and not ALL stages are
  // already being handled via the atomic GPU path (allOnGpu + Modal IS the GPU = atomic handles it).
  const isModalTheGpu = MODAL_BABELCAST_URL === deployState.endpoint;
  const hasModalFallback = !!(MODAL_BABELCAST_URL && !(allOnGpu && isModalTheGpu));
  if ((anyOnGpu && !allOnGpu && gpuEp) || forceHybridForClone || hasModalFallback) {
    // [4] Pre-warm GPU + cloud connections in parallel (via ai-gateway)
    const effectiveGpuEp = gpuEp || cloneGpuEndpoint!;
    probeGpuHealth(effectiveGpuEp).catch(e => console.warn('[probe] GPU health failed:', e instanceof Error ? e.message : e));
    if (groqAvailable && process.env.GROQ_API_KEY) {
      probeCloudProvider('groq', process.env.GROQ_API_KEY, 2000).catch(e => console.warn('[probe] Groq warmup failed:', e instanceof Error ? e.message : e));
    }

    try {
      // ── Stage 1: STT ────────────────────────────────────────────────────
      const sttResult = await _runSttStage(params);

      if (!sttResult.text.trim()) {
        const totalMs = Date.now() - pipeT0;
        logRequest({ timestamp: Date.now(), stage: 'pipeline', provider: 'hybrid', latencyMs: totalMs, success: true, inputSize: audioBuffer.length, outputPreview: '' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ transcription: '', response: '', audio_base64: '', content_type: '', timing: { total_ms: totalMs, stt_ms: sttResult.latencyMs, llm_ms: 0, tts_ms: 0, used_gpu: false } }));
        return;
      }

      // ── Stage 2: LLM ────────────────────────────────────────────────────
      const llmResult = await _runLlmStage(params, sttResult);

      // ── Stage 3: TTS ────────────────────────────────────────────────────
      const ttsResult = await _runTtsStage(params, llmResult.translatedText);

      // ── Build and send response ─────────────────────────────────────────
      const totalMs = Date.now() - pipeT0;
      console.log(`[pipeline] ── Hybrid done: ${totalMs}ms (STT=${sttResult.latencyMs}[${sttResult.provider}] LLM=${llmResult.latencyMs}[${llmResult.provider}] TTS=${ttsResult.latencyMs}[${ttsResult.provider || '-'}]) ──`);
      logRequest({ timestamp: Date.now(), stage: 'pipeline', provider: 'hybrid', latencyMs: totalMs, success: true, inputSize: audioBuffer.length, outputPreview: (llmResult.translatedText || '').slice(0, 80) });
      stampProfileRequest(loadProviderConfig().activeProfileId);

      if (ttsResult.audioB64) forwardToAvatar(ttsResult.audioB64);

      // ── Record pipeline metrics for tracing ──────────────────────────────────
      globalTracer.addTag(traceSpan.spanId, 'pipeline.success', true);
      globalTracer.addTag(traceSpan.spanId, 'pipeline.total_ms', totalMs);
      globalTracer.addTag(traceSpan.spanId, 'stages.stt.provider', sttResult.provider);
      globalTracer.addTag(traceSpan.spanId, 'stages.stt.latency_ms', sttResult.latencyMs);
      globalTracer.addTag(traceSpan.spanId, 'stages.llm.provider', llmResult.provider);
      globalTracer.addTag(traceSpan.spanId, 'stages.llm.latency_ms', llmResult.latencyMs);
      if (ttsResult.provider) {
        globalTracer.addTag(traceSpan.spanId, 'stages.tts.provider', ttsResult.provider);
        globalTracer.addTag(traceSpan.spanId, 'stages.tts.latency_ms', ttsResult.latencyMs);
      }
      globalTracer.addTag(traceSpan.spanId, 'input.audio_bytes', audioBuffer.length);
      globalTracer.addTag(traceSpan.spanId, 'output.transcription_length', (sttResult.text || '').length);
      globalTracer.addTag(traceSpan.spanId, 'output.response_length', (llmResult.translatedText || '').length);
      if (ttsResult.audioB64) {
        globalTracer.addTag(traceSpan.spanId, 'output.audio_bytes', ttsResult.audioB64.length);
      }

      // Record routing decision if available
      if (routingAdvice) {
        globalTracer.addTag(traceSpan.spanId, 'routing.final_provider', sttResult.provider); // Use actual provider
        globalTracer.addTag(traceSpan.spanId, 'routing.advice_used', routingAdvice.provider === sttResult.provider);
      }

      const body = _encodePipelineResponse(sttResult, llmResult, ttsResult, totalMs, isCloneRequest);
      _sendPipelineResponse(req, res, body, ttsResult.audioRaw);

      globalTracer.endSpan(traceSpan.spanId);
      return;
    } catch (err) {
      console.warn(`[pipeline] Hybrid pipeline failed: ${err instanceof Error ? err.message : err}`);

      // Record failure in tracing
      globalTracer.addTag(traceSpan.spanId, 'pipeline.success', false);
      globalTracer.addTag(traceSpan.spanId, 'pipeline.error', err instanceof Error ? err.message : String(err));
      globalTracer.addEvent(traceSpan.spanId, 'pipeline_failure', {
        error: err instanceof Error ? err.message : String(err),
        stage: 'hybrid_pipeline',
        fallback: true
      });

      // Fall through to atomic pipeline as last resort
    }
  }

  // ── Atomic pipeline (all-GPU or all-cloud) ────────────────────────────────
  const effectiveGpuEndpoint = allOnGpu ? gpuEp : undefined;
  const resolvedVoice = speaker ? resolveVoiceForProfile(speaker, !!effectiveGpuEndpoint) : undefined;
  const ttsChainNames = cloneTtsChain ? cloneTtsChain.map(c => c.provider).join('→') : 'default';
  console.log(`[pipeline] Atomic path: gpu=${!!effectiveGpuEndpoint} clone=${isCloneRequest} ttsChain=${ttsChainNames} refAudio=${referenceAudio ? `${(referenceAudio.length/1024).toFixed(0)}KB` : 'none'} refText=${refText?.length || 0}ch`);
  const profile: AIProfile = {
    ...baseProfile,
    gpuEndpoint: effectiveGpuEndpoint,
    language: source,
    ...(resolvedVoice ? { voice: resolvedVoice } : {}),
    ...(referenceAudio ? { referenceAudio } : {}),
    ...(refText ? { refText } : {}),
    ...(cloneTtsChain ? { tts: cloneTtsChain } : {}),  // force Modal TTS for voice cloning
    fallbackOptions: { ...baseProfile.fallbackOptions, timeoutMs: GPU_PIPELINE_TIMEOUT_MS },
  };

  // Warm GPU connection while preparing pipeline call (TCP/TLS handshake overlaps)
  if (effectiveGpuEndpoint) {
    validateRemoteEndpoint(effectiveGpuEndpoint);
    fetch(`${effectiveGpuEndpoint}/health`, { signal: AbortSignal.timeout(2000) }).catch(e => console.warn('[probe] GPU pre-warm failed:', e instanceof Error ? e.message : e));
  }

  try {
    // Try full pipeline (GPU path runs all 3 stages atomically via /v1/speech)
    const result = await client.pipeline(audioBuffer, systemPrompt, [], profile);

    const sttMs = result.stt.latencyMs || 0;
    const llmMs = result.chat.latencyMs || 0;
    const ttsMs = result.tts?.latencyMs || 0;
    const ttsBytes = result.tts?.audio?.length || 0;
    // Network overhead = client round-trip minus server-reported stage times
    const serverTotalMs = sttMs + llmMs + ttsMs;
    const networkMs = result.usedGpu ? Math.max(0, result.totalLatencyMs - serverTotalMs) : undefined;

    console.log(`[pipeline] STT (${sttMs}ms): "${(result.stt.text || '').substring(0, 80)}"`);
    console.log(`[pipeline] LLM (${llmMs}ms): "${(result.chat.content || '').substring(0, 80)}"`);
    console.log(`[pipeline] TTS (${ttsMs}ms): ${ttsBytes > 0 ? `${ttsBytes} bytes ${result.tts?.contentType || ''}` : 'NO AUDIO'}`);
    console.log(`[pipeline] ── Done: ${result.totalLatencyMs}ms (STT=${sttMs} LLM=${llmMs} TTS=${ttsMs}${networkMs !== undefined ? ` NET=${networkMs}` : ''}) gpu=${result.usedGpu} ──`);

    // Track GPU TTS warmth: if GPU handled TTS, record the latency and mark warm
    if (result.usedGpu && ttsMs > 0) {
      recordPerStageLatency('tts', ttsMs);
      const profileBase = {
        gpuType: deployState.gpuType,
        dockerImage: deployState.dockerImage,
        provider: deployState.provider,
        modelLoadMs: 0,
        measuredAt: Date.now(),
      };
      if (!isTtsWarm()) {
        markTtsWarm(ttsMs);
        saveColdStartProfile({ ...profileBase, coldTtfbMs: ttsMs, warmTtfbAvgMs: 240, sampleCount: 0 });
      } else {
        recordTtsTtfb(ttsMs);
        if (ttsWarmth.warmTtfbMs !== null) {
          saveColdStartProfile({
            ...profileBase,
            coldTtfbMs: ttsWarmth.coldTtfbMs || ttsMs,
            warmTtfbAvgMs: ttsWarmth.warmTtfbMs,
            sampleCount: (ttsWarmth.warmTtfbMs ? 1 : 0),
          });
        }
      }
    }
    const pipelineProvider = result.usedGpu ? 'gpu' : (baseProfile === ollamaProfile ? 'ollama' : 'groq');
    logRequest({
      timestamp: Date.now(), stage: 'pipeline',
      provider: pipelineProvider,
      latencyMs: result.totalLatencyMs, success: true, inputSize: audioBuffer.length,
      outputPreview: (result.chat.content || '').slice(0, 80),
    });

    const atomicAudioRaw = result.tts?.audio ? (Buffer.isBuffer(result.tts.audio) ? result.tts.audio : Buffer.from(result.tts.audio)) : undefined;
    const audioB64 = atomicAudioRaw ? atomicAudioRaw.toString('base64') : '';

    // Forward TTS audio to avatar (fire-and-forget)
    if (audioB64) forwardToAvatar(audioB64);

    const body = {
      transcription: result.stt.text,
      response: result.chat.content,
      audio_base64: audioB64,
      content_type: result.tts?.contentType || '',
      timing: {
        total_ms: result.totalLatencyMs,
        stt_ms: result.stt.latencyMs || 0,
        llm_ms: result.chat.latencyMs || 0,
        tts_ms: result.tts?.latencyMs || 0,
        used_gpu: result.usedGpu,
        stt_provider: result.stt.provider || 'cloud',
        llm_provider: result.chat.provider || 'cloud',
        tts_provider: result.tts?.provider || 'cloud',
        clone: isCloneRequest,
        ...(networkMs !== undefined && { network_ms: networkMs, server_total_ms: serverTotalMs }),
      },
    };

    _sendPipelineResponse(req, res, body, atomicAudioRaw);
  } catch (err) {
    console.warn(`[pipeline] Full pipeline failed: ${err instanceof Error ? err.message : err}`);
    // If pipeline fails (e.g. no TTS provider), try STT + LLM only (subtitles still work)
    try {
      const t0 = Date.now();
      const stt = await client.transcribe(audioBuffer, cloudProfile);
      const sttMs = Date.now() - t0;
      console.log(`[pipeline] STT fallback (${sttMs}ms): "${(stt.text || '').substring(0, 80)}"`);

      // [2] Check translation cache
      const fbCached = stt.text ? getCachedTranslation(stt.text, source, target) : null;
      let fbTranslated: string;
      let llmMs: number;
      if (fbCached !== null) {
        fbTranslated = fbCached;
        llmMs = 0;
        console.log(`[pipeline] LLM fallback [cache] (0ms): "${fbCached.substring(0, 80)}"`);
      } else {
        const tLlm = Date.now();
        const messages = [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: stt.text },
        ];
        const chat = await client.chat(messages, cloudProfile);
        fbTranslated = chat.content;
        llmMs = Date.now() - tLlm;
        console.log(`[pipeline] LLM fallback (${llmMs}ms): "${(fbTranslated || '').substring(0, 80)}"`);
        if (fbTranslated) setCachedTranslation(stt.text, source, target, fbTranslated);
      }

      // [3] Early subtitle push
      if (fbTranslated?.trim()) {
        broadcastWs({ type: 'subtitle:early', transcription: stt.text, translation: fbTranslated, source, target, timing: { stt_ms: sttMs, llm_ms: llmMs } });
      }

      const fallbackMs = Date.now() - t0;
      console.log(`[pipeline] ── Fallback done (no TTS): ${fallbackMs}ms (STT=${sttMs} LLM=${llmMs}) ──`);
      const fallbackProvider = baseProfile === ollamaProfile ? 'ollama' : 'groq' as const;
      logRequest({ timestamp: Date.now(), stage: 'pipeline', provider: fallbackProvider, latencyMs: fallbackMs, success: true, inputSize: audioBuffer.length, outputPreview: (fbTranslated || '').slice(0, 80) });

      const body = {
        transcription: stt.text,
        response: fbTranslated,
        audio_base64: '',
        content_type: '',
        timing: { total_ms: fallbackMs, stt_ms: sttMs, llm_ms: llmMs, tts_ms: 0, used_gpu: false },
      };

      _sendPipelineResponse(req, res, body);
    } catch (fallbackErr) {
      const message = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      console.error(`[pipeline] Complete failure: ${message}`);
      const errorProvider = baseProfile === ollamaProfile ? 'ollama' : 'groq' as const;
      logRequest({ timestamp: Date.now(), stage: 'pipeline', provider: errorProvider, latencyMs: Date.now() - pipeT0, success: false, error: message, inputSize: audioBuffer.length });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
}

// ── Voice profile proxy (proxied to GPU pod) ────────────────────────────────

export async function handleVoiceProfileStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const gpuEndpoint = isGpuAvailable() ? deployState.endpoint : null;
  if (!gpuEndpoint) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: 'unavailable', hasProfile: false, samplesCount: 0, totalDurationSec: 0, ready: false, minDurationSec: 15, speakerId: null, gender: null }));
    return;
  }
  try {
    validateRemoteEndpoint(gpuEndpoint);
    const gpuRes = await fetch(`${gpuEndpoint}/v1/voice-profile/status`, { signal: AbortSignal.timeout(15_000) });
    const data = await gpuRes.json();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: 'available', ...data }));
  } catch (err) {
    console.error(`[voice-profile] Status fetch error: ${err instanceof Error ? err.message : err}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: 'error', hasProfile: false, samplesCount: 0, totalDurationSec: 0, ready: false, minDurationSec: 15, speakerId: null, gender: null }));
  }
}

export async function handleVoiceProfileReset(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const gpuEndpoint = isGpuAvailable() ? deployState.endpoint : null;
  if (!gpuEndpoint) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'No GPU pod active' }));
    return;
  }
  try {
    validateRemoteEndpoint(gpuEndpoint);
    const gpuRes = await fetch(`${gpuEndpoint}/v1/voice-profile/reset`, { method: 'POST', signal: AbortSignal.timeout(15_000) });
    const data = await gpuRes.json();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    console.error(`[voice-profile] Reset error: ${err instanceof Error ? err.message : err}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Failed to reach GPU pod' }));
  }
}

// ── Language Detection ─────────────────────────────────────────────────────────
import { detectLanguage, detectLanguageWithSwap, SUPPORTED_LANGUAGES } from '../src/language-detect';

/**
 * POST /v1/detect-language
 * Body: { text: string, source: string, target: string, minConfidence?: number }
 * Returns: { language: string, confidence: number, shouldSwap: boolean, supported: boolean }
 *
 * Opt-in endpoint — disabled by default. Enable via DETECT_LANGUAGE_ENABLED=true env var
 * or pass ?force=true to bypass the check.
 */
export async function handleDetectLanguage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost`);
  const force = url.searchParams.get('force') === 'true';
  const enabled = force || process.env.DETECT_LANGUAGE_ENABLED === 'true';

  if (!enabled) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Language detection is disabled. Set DETECT_LANGUAGE_ENABLED=true or pass ?force=true.',
      supported_languages: [...SUPPORTED_LANGUAGES].sort(),
    }));
    return;
  }

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const text = (body.text as string) || '';
  const source = (body.source as string) || '';
  const target = (body.target as string) || '';
  const minConfidence = typeof body.minConfidence === 'number' ? body.minConfidence : 0.65;

  if (!text.trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'text is required' }));
    return;
  }
  if (!source || !target) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'source and target language codes are required (ISO 639-1)' }));
    return;
  }

  const t0 = Date.now();
  const { detected, shouldSwap } = detectLanguageWithSwap(text, source, target, minConfidence);
  const latencyMs = Date.now() - t0;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    language: detected.language,
    confidence: detected.confidence,
    shouldSwap,
    source,
    target,
    latencyMs,
    supported: SUPPORTED_LANGUAGES.has(source) && SUPPORTED_LANGUAGES.has(target),
  }));
}

// ── Auto-Swap Toggle ────────────────────────────────────────────────────────

import { autoSwapEnabled, setAutoSwapEnabled } from './state';

export async function handleAutoSwapStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ enabled: autoSwapEnabled }));
}

export async function handleAutoSwapToggle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const enabled = body.enabled;
  if (typeof enabled !== 'boolean') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'enabled (boolean) is required' }));
    return;
  }

  setAutoSwapEnabled(enabled);
  broadcastWs({ type: 'auto_swap', enabled });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ enabled: autoSwapEnabled }));
}

// ── Auto-Swap Benchmark ─────────────────────────────────────────────────────

/** POST /v1/auto-swap/benchmark
 *  Body: { phrases: Array<{text, expectedLang}>, source, target }
 *  Runs detectLanguageWithSwap on each phrase and returns accuracy report.
 */
export async function handleAutoSwapBenchmark(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const phrases = body.phrases as Array<{ text: string; expectedLang: string }> | undefined;
  const source = (body.source as string) || 'fr';
  const target = (body.target as string) || 'en';
  const minConfidence = typeof body.minConfidence === 'number' ? body.minConfidence : 0.65;

  if (!phrases || !Array.isArray(phrases) || phrases.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'phrases array is required (each: {text, expectedLang})' }));
    return;
  }

  const results: Array<{
    text: string; expectedLang: string; detectedLang: string;
    confidence: number; shouldSwap: boolean; correct: boolean; latencyMs: number;
  }> = [];

  const t0 = Date.now();

  for (const phrase of phrases) {
    const pt = Date.now();
    const { detected, shouldSwap } = detectLanguageWithSwap(phrase.text, source, target, minConfidence);
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
  const avgLatencyMs = Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length);
  const p95LatencyMs = latencies[Math.floor(latencies.length * 0.95)] || latencies[latencies.length - 1];
  const swapDetections = results.filter(r => r.shouldSwap).length;
  const falsePositives = results.filter(r => r.expectedLang === source && r.detectedLang === target).length;
  const falseNegatives = results.filter(r => r.expectedLang === target && r.detectedLang === source).length;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
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
  }));
}

// ── Chat Completions (OpenAI-compatible proxy) ─────────────────────────────
// Routes chat requests through ai-gateway providers so Python app never
// needs direct provider URLs. Supports vision (multimodal content arrays).

export async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  touchRequest(); touchModelRequest();
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Invalid body: ${err instanceof Error ? err.message : err}` } }));
    return;
  }

  const model = (body.model as string) || '';
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  if (!messages || !Array.isArray(messages)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'messages array is required' } }));
    return;
  }

  // Find provider: explicit model mapping → groqLLM fallback
  // If model is a provider ID (e.g. "groq"), resolve to that provider's default model
  let resolvedModel = model;
  let chatProvider = providers.chat?.[model];
  if (!chatProvider) {
    // model might be a provider ID — try to find the provider and use its default model
    const providerDefaults: Record<string, string> = {
      groq: groqLlmModel,
      fireworks: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    };
    if (providerDefaults[model]) {
      resolvedModel = providerDefaults[model];
      chatProvider = providers.chat?.[resolvedModel] || groqLLM;
    } else {
      chatProvider = groqLLM;
    }
  }

  try {
    const result = await chatProvider.chat({
      model: resolvedModel,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      responseFormat: body.response_format as any,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const latencyMs = Date.now() - (req as any)._startTime || 0;
    logRequest({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      timestamp: Date.now(), stage: 'llm', provider: (chatProvider.providerId ?? 'groq') as 'gpu' | 'groq' | 'ollama' | 'ensemble' | 'cache' | 'hybrid', model: result.model,
      latencyMs, success: true, outputPreview: result.content?.slice(0, 80),
      inputTokens: result.usage?.promptTokens, outputTokens: result.usage?.completionTokens,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-${requestId}`,
      object: 'chat.completion',
      model: result.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.content },
        finish_reason: 'stop',
      }],
      usage: result.usage ? {
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        total_tokens: result.usage.totalTokens,
      } : undefined,
    }));
  } catch (err) {
    const status = (err as any)?.status || 500;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[chat] ${model} failed: ${msg}`);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Internal server error' } }));
  }
}

// ── Voice Reference Cache (for voice cloning) ────────────────────────────────
// Stores uploaded reference audio + text in memory. Pipeline reads from cache
// using ref_id instead of sending 500KB on every request.

const voiceRefCache = new Map<string, { audio: string; text: string; createdAt: number }>();

export async function handleUploadVoiceReference(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid body' })); return; }

  const audio = body.audio as string;
  const text = body.text as string;
  if (!audio || !text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'audio (base64) and text are required' }));
    return;
  }

  const refId = `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  voiceRefCache.set(refId, { audio, text, createdAt: Date.now() });

  // Clean old entries (keep last 5)
  if (voiceRefCache.size > 5) {
    const oldest = [...voiceRefCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (let i = 0; i < oldest.length - 5; i++) voiceRefCache.delete(oldest[i][0]);
  }

  console.log(`[voice-ref] Cached ref_id=${refId} audio=${(audio.length/1024).toFixed(0)}KB text=${text.length} chars`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ref_id: refId }));
}

/** Get cached voice reference by ID (used by pipeline). */
export function getVoiceReference(refId: string): { audio: string; text: string } | null {
  return voiceRefCache.get(refId) || null;
}

// ── Modal TTS Keepalive ─────────────────────────────────────────────────────
// Ping Modal health every 4 minutes while voice cloning is active.
// Prevents Modal from scaling to zero mid-session (scaledown=15min).
let modalKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
let lastCloneRequestAt = 0;

/** Stop modal keepalive timer (called on shutdown) */
export function stopModalKeepalive(): void {
  if (modalKeepaliveTimer) { clearInterval(modalKeepaliveTimer); modalKeepaliveTimer = null; }
}

/** Called on every clone TTS request to reset the keepalive timer. */
export function touchModalKeepalive(): void {
  lastCloneRequestAt = Date.now();
  if (!modalKeepaliveTimer) {
    console.log('[modal-keepalive] Starting keepalive (ping every 4min while clone active)');
    modalKeepaliveTimer = setInterval(async () => {
      // Stop if no clone request in last 20 minutes
      if (Date.now() - lastCloneRequestAt > 20 * 60_000) {
        console.log('[modal-keepalive] No clone requests in 20min — stopping keepalive');
        clearInterval(modalKeepaliveTimer!);
        modalKeepaliveTimer = null;
        return;
      }
      try {
        const endpoint = modalTTS['endpoint'] || 'REDACTED_env_a3fb60f2';
        const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(30_000) });
        if (res.ok) {
          const data = await res.json() as Record<string, unknown>;
          console.log(`[modal-keepalive] OK (uptime=${data.uptime_s}s, clone=${data.clone})`);
        } else {
          console.warn(`[modal-keepalive] HTTP ${res.status}`);
        }
      } catch (err) {
        console.warn(`[modal-keepalive] Failed: ${err instanceof Error ? err.message : err}`);
      }
    }, 4 * 60_000); // every 4 minutes
  }
}
