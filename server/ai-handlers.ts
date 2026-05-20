// ── BabelCast Gateway — AI HTTP Handlers ─────────────────────────────────────
// handleTranscribe, handleEnsembleTranscribe, handleTtsPreview, handleTranslate,
// handlePipeline, handleVoiceProfileStatus, handleVoiceProfileReset.
//
// Key design: request hedging (raceProviders) for GPU vs cloud — fire both in
// parallel and take the fastest response. This eliminates the 5-30s worst-case
// latency from sequential GPU→cloud fallback.

import type { IncomingMessage, ServerResponse } from 'http';
import { HybridRouter } from '../src/gateway/routing/hybrid-router';
import type { RoutingDecision } from '../src/gateway/routing/hybrid-router';
import { buildSystemAnalytics, DEFAULT_REALTIME_METRICS } from '../src/gateway/routing/analytics-service';
import { runAutoSwapBenchmark } from '../src/gateway/routing/auto-swap-benchmark';
import { sttRace } from '../src/stt-race';
import { globalTracer } from '../src/observability/distributed-tracer';
import type { STTRaceProvider } from '../src/stt-race';
import type { AIProfile } from '../src/client';
import { OllamaSTTProvider } from '../src/providers/ollama';
import { createLogger } from '../src/logger';
// ── Domain logic extracted to src/gateway/pipeline/ ─────────────────────────
import {
  // SSRF protection
  isPrivateUrl as _isPrivateUrl,
  isPrivateUrlResolved as _isPrivateUrlResolved,
  validateRemoteEndpointResolved,
  // Translation cache
  getCachedTranslation, setCachedTranslation, getTranslationCacheStats as _getTranslationCacheStats,
  adaptiveMaxTokens,
  // System prompt
  TRANSLATION_STYLES, buildSystemPrompt, resolveVoiceForProfile,
  // GPU fetch (DI version)
  fetchGpuSTT as _fetchGpuSTTCore,
  fetchGpuLLM as _fetchGpuLLMCore,
  fetchGpuTTS as _fetchGpuTTSCore,
  // Pipeline response
  encodePipelineResponse as _encodePipelineResponse, wantsBinaryAudio,
  // Timeouts
  GPU_STT_TIMEOUT_MS, GPU_LLM_TIMEOUT_MS, GPU_TTS_TIMEOUT_MS, GPU_PIPELINE_TIMEOUT_MS,
  // Voice reference cache
  storeVoiceReference, getVoiceReference,
  // Shadow mode + Modal keepalive
  runShadowStage, ModalKeepalive,
  // Hybrid pipeline stage runners
  runSttStage as _runSttStageCore,
  runLlmStage as _runLlmStageCore,
  runTtsStage as _runTtsStageCore,
  generateTtsPreview,
  resolveChatProvider, buildOpenAiChatResponse,
  buildAtomicResponseBody, computeNetworkMs, extractAtomicAudio,
  runTranslateRace, buildTranslatePrompt,
} from '../src/gateway/pipeline';
import type { HybridStagesDeps, PipelineStageParams } from '../src/gateway/pipeline';
import type {
  GpuSTTResult, GpuLLMResult, GpuTTSResult, StageRecorder,
  SttStageResult, PipelineResponseBody,
} from '../src/gateway/pipeline';
import { getLocalKokoroUrl } from '../src/gateway/pipeline/local-kokoro';

const log = createLogger('ai-handlers');
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
  whisperAvailable, whisperHost,
  ENSEMBLE_STT_PROVIDERS,
  groqSTT, openaiSTT, deepgramSTT, fireworksSTT,
  groqLLM, fireworksLLM, groqLlmModel, groqTtsModel, groqTtsVoice,
  shouldPreferGpu, shouldPreferGpuTts,
  recordStageSuccess, recordStageFailure, isStageCircuitClosed,
  providers, modalTTS, minimaxTTS, minimaxLLM, gpuShadowMode,
  markGpuProductionReady,
  openrouterLLM, openrouterQwen3Embedding, openaiEmbedding,
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

// ── Shadow-mode DI bundle — injected into runShadowStage() for each call ────
const shadowRunDeps = {
  recordGpuLatency,
  recordPerStageLatency,
  recordShadowRun,
  markGpuProductionReady,
};

// ── Hybrid routing engine — extracted to src/gateway/routing/hybrid-router.ts ──
// Inject server-side state readers so the router remains pure.
export const pipelineRouter = new HybridRouter({
  isGpuAvailable,
  isGpuReadyForProduction,
  isGpuLatencyAcceptable,
  isStageWarm,
  isTtsWarm,
  getP95Latency,
  gpuHealthy: () => gpuHealthy,
  groqAvailable: () => groqAvailable,
  openaiAvailable: () => openaiAvailable,
  modalAvailable: () => Boolean(modalTTS),
  groqLlmModel: () => groqLlmModel,
  log: (msg) => log.log(msg),
});

// ── SSRF protection — imported from src/gateway/pipeline/ssrf-protection.ts ──
// Re-export for backward compatibility (other server/ modules may import from here)
export const isPrivateUrl = _isPrivateUrl;
export const isPrivateUrlResolved = _isPrivateUrlResolved;
export const getTranslationCacheStats = _getTranslationCacheStats;

// ── Real-time timeout constants — imported from src/gateway/pipeline/timeouts.ts
// Re-exported for backward compatibility via named import at top
export { GPU_STT_TIMEOUT_MS, GPU_LLM_TIMEOUT_MS, GPU_TTS_TIMEOUT_MS, GPU_PIPELINE_TIMEOUT_MS };

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

// ── Translation LRU cache — imported from src/gateway/pipeline/translation-cache.ts
// Re-exported for backward compatibility (other server/ modules import from here)
export { getCachedTranslation, setCachedTranslation, adaptiveMaxTokens, getVoiceReference };

// ── Avatar TTS forwarding ────────────────────────────────────────────────────

/** Fire-and-forget: forward TTS audio to the avatar on the bot pod. */
export function forwardToAvatar(audioBase64: string): void {
  const ep = botState.endpoint;
  if (!ep) return;

  // Derive avatar endpoint from bot endpoint. RunPod proxy URLs look like
  // `https://<podid>-8080.proxy.runpod.net`. The previous regex used `[^-]+`
  // for the pod ID which fails when pod IDs contain hyphens (they often do).
  // Use a non-greedy capture up to the last `-8080`.
  const runpodMatch = ep.match(/^(https?:\/\/)(.+)-8080(.*)$/);
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
    if (!res.ok) log.warn(`speak failed: ${res.status}`);
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
  log.log(`${stage} route: ${names}${note}`);
}

// ── GPU fetch helpers — thin wrappers around src/gateway/pipeline/gpu-fetch.ts
// Inject the server-side stage recorder (recordStageSuccess/recordStageFailure)
// so the core logic remains independent of server/ modules.

const stageRecorder: StageRecorder = {
  recordSuccess: (stage) => recordStageSuccess(stage),
  recordFailure: (stage) => recordStageFailure(stage),
};

export { GpuSTTResult, GpuLLMResult, GpuTTSResult };

export async function fetchGpuSTT(
  gpuEndpoint: string, audio: Buffer, language: string, prompt: string,
  hotwords: string, wordTimestamps: boolean, signal: AbortSignal,
  requestId?: string,
): Promise<GpuSTTResult> {
  return _fetchGpuSTTCore(gpuEndpoint, audio, language, prompt, hotwords, wordTimestamps, signal, stageRecorder, requestId);
}

export async function fetchGpuLLM(
  gpuEndpoint: string, text: string, sourceLang: string, targetLang: string,
  glossary: string, context: string, signal: AbortSignal,
  requestId?: string,
): Promise<GpuLLMResult> {
  return _fetchGpuLLMCore(gpuEndpoint, text, sourceLang, targetLang, glossary, context, signal, stageRecorder, requestId);
}

export async function fetchGpuTTS(
  gpuEndpoint: string, text: string, language: string, speaker: string,
  signal: AbortSignal, refAudio?: string, refText?: string,
  requestId?: string,
): Promise<GpuTTSResult> {
  return _fetchGpuTTSCore(gpuEndpoint, text, language, speaker, signal, stageRecorder, refAudio, refText, requestId);
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
    runShadowStage('stt', shadowEndpoint, shadowTarget,
      () => fetchGpuSTT(shadowEndpoint, audio, language, prompt, hotwords, wordTimestamps, AbortSignal.timeout(GPU_STT_TIMEOUT_MS), requestId),
      shadowRunDeps);
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
    const sttOverrides = (await loadProviderConfig() as Record<string, unknown>).sttModelOverrides as Record<string, { provider: string; model: string }> | undefined;
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
    if (result.text) log.log(`STT: ${result.text.slice(0, 100)}`);
    logRequest({ timestamp: Date.now(), stage: 'stt', provider: provider as 'gpu' | 'groq' | 'ollama' | 'ensemble' | 'cache' | 'hybrid', latencyMs, success: true, inputSize: audio.length, outputPreview: result.text.slice(0, 80) });

    const resp: Record<string, unknown> = { text: result.text, language: result.language, used_gpu: result.used_gpu, avg_logprob: result.avg_logprob };
    if (result.segments) resp.segments = result.segments;
    if (result.words) resp.words = result.words;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resp));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`All STT providers failed: ${msg}`);
    logRequest({ timestamp: Date.now(), stage: 'stt', provider: getCloudProviderName(), latencyMs: Date.now() - t0, success: false, error: msg, inputSize: audio.length });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'All providers failed for STT', text: '' }));
  }
}

// ── STT Race endpoint — fires all providers in parallel, returns the fastest ──

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
    log.error('[ensemble] Body read error:', msg);
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

  const activeProviders: STTRaceProvider[] = [];
  if (groqAvailable && wants('groq')) activeProviders.push({ name: 'groq', provider: groqSTT });
  if (openaiAvailable && wants('openai')) activeProviders.push({ name: 'openai', provider: openaiSTT });
  if (deepgramAvailable && wants('deepgram')) activeProviders.push({ name: 'deepgram', provider: deepgramSTT });
  if (fireworksAvailable && wants('fireworks')) activeProviders.push({ name: 'fireworks', provider: fireworksSTT });
  if (whisperAvailable && wants('whisper')) activeProviders.push({ name: 'whisper', provider: new OllamaSTTProvider(whisperHost) });

  try {
    const result = await sttRace(audio, language, prompt, {
      providers: activeProviders,
      timeoutMs,
    });

    let finalText = result.text;

    // Apply hallucination filter (metadata + blocklist)
    const config = await loadProviderConfig();
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
      text: finalText,
      segments: result.segments,
      avg_logprob: result.avgLogprob,
      compression_ratio: result.compressionRatio,
      no_speech_prob: result.noSpeechProb,
    };
    const filterResult = filterHallucinations(sttResponse, language, filterConfig);

    if (filterResult.filtered) {
      log.log(`Hallucination filter: "${finalText.slice(0, 60)}" → "${filterResult.text.slice(0, 60)}" [${filterResult.reasons.join('; ')}]`);
      finalText = filterResult.text;
    }

    log.log(`${result.provider} → ${result.latencyMs}ms: "${finalText.slice(0, 80)}"`);
    logRequest({ timestamp: Date.now(), stage: 'stt', provider: result.provider as 'gpu' | 'groq' | 'ollama' | 'ensemble' | 'cache' | 'hybrid', latencyMs: result.latencyMs, success: true, inputSize: audio.length, outputPreview: finalText.slice(0, 80) });

    // Include filter metadata in response for Python client
    const responseBody = {
      text: finalText,
      provider: result.provider as string,
      latencyMs: result.latencyMs,
      segments: result.segments,
    } as Record<string, unknown>;
    if (filterResult.metrics) responseBody.hallucinationMetrics = filterResult.metrics;
    if (filterResult.filtered) responseBody.hallucinationFiltered = true;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const latencyMs = Date.now() - t0;
    log.error(`Failed (${latencyMs}ms):`, msg);
    logRequest({ timestamp: Date.now(), stage: 'stt', provider: 'ensemble', latencyMs, success: false, error: msg, inputSize: audio.length });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error', providers: {} }));
  }
}

// ── TTS Preview endpoint ─────────────────────────────────────────────────────

export async function handleTtsPreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  touchRequest(); touchModelRequest();
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: { text?: string; speaker?: string; language?: string; reference_audio?: string; ref_text?: string };
  try { body = await readJsonBody(req) as typeof body; }
  catch (err) {
    log.warn('[tts-preview] Invalid JSON body:', err instanceof Error ? err.message : err);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const text = body.text?.trim() || '';
  if (!text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'text is required' }));
    return;
  }

  try {
    const result = await generateTtsPreview(
      {
        text,
        speaker: body.speaker || 'Ryan',
        language: body.language || 'English',
        referenceAudio: body.reference_audio || '',
        refText: body.ref_text || '',
      },
      {
        gpuEndpoint: isGpuAvailable() ? deployState.endpoint : null,
        localKokoroUrl: getLocalKokoroUrl(),
        client, modalTTS, minimaxTTS, translationProfile,
      },
    );
    res.writeHead(200, { 'Content-Type': result.contentType });
    res.end(result.audio);
  } catch (err) {
    log.error('preview error:', err instanceof Error ? err.message : err);
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
    log.log(`Cache hit: '${text.slice(0, 50)}' -> '${cached.slice(0, 50)}'`);
    logRequest({ timestamp: Date.now(), stage: 'llm', provider: 'cache', latencyMs: 0, success: true, inputSize: text.length, outputPreview: cached.slice(0, 80) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ translated_text: cached, used_gpu: false }));
    return;
  }

  const sourceName = langNames[sourceLang] || sourceLang;
  const targetName = langNames[targetLang] || targetLang;
  let systemPrompt = buildTranslatePrompt(buildSystemPrompt(sourceName, targetName, style), context, glossary);
  // Optional incomplete-turn filter — opt-in via env or per-request flag.
  // Augments the system prompt with ✓/○/◐ marker instruction; the LLM emits
  // the marker as its first character and we suppress + re-prompt if user
  // was cut off mid-thought.
  const filterIncompleteTurns = process.env.FILTER_INCOMPLETE_USER_TURNS === '1'
    || (body && (body as Record<string, unknown>).filter_incomplete_user_turns === true);
  let _turnFilter: { classify: (s: string) => { kind: string; cleanedText: string; timeoutMs: number } } | null = null;
  if (filterIncompleteTurns) {
    const { IncompleteTurnFilter } = await import('../src/llm-context');
    const f = new IncompleteTurnFilter();
    systemPrompt = f.augmentSystemPrompt(systemPrompt);
    _turnFilter = f;
  }
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: text },
  ];
  const maxTokens = adaptiveMaxTokens(text);
  const gpuLlmTimeout = adaptiveGpuTimeout(GPU_LLM_TIMEOUT_MS);

  // Shadow mode: GPU fires in background, cloud serves the actual response
  if (gpuShadowMode && deployState.endpoint) {
    const shadowEndpoint = deployState.endpoint;
    const shadowTarget = Math.round(getLlmTargetLatencyMs() * (1 - getBenchmarkMarginPct() / 100));
    runShadowStage('llm', shadowEndpoint, shadowTarget,
      () => fetchGpuLLM(shadowEndpoint, text, sourceLang, targetLang, glossary, context, AbortSignal.timeout(GPU_LLM_TIMEOUT_MS), requestId),
      shadowRunDeps);
  }

  const gpuEndpoint = isGpuReadyForProduction() ? deployState.endpoint : null;
  const cloudProfile = getCloudProfile();

  const llmReqTs = Date.now();
  const { emitFrame } = await import('../src/observers');
  emitFrame({ kind: 'llm_request', ts: llmReqTs, stage: 'llm', meta: { sourceLang, targetLang, len: text.length } });
  try {
    const out = await runTranslateRace(
      { text, sourceLang, targetLang, glossary, context, style, systemPrompt, messages, maxTokens,
        gpuLlmTimeout, gpuEndpoint, requestId },
      { client, cloudProfile, cloudProviderName: getCloudProviderName(), shouldPreferGpu, raceProviders, fetchGpuLLM },
    );
    emitFrame({ kind: 'llm_complete', ts: Date.now(), stage: 'llm', provider: out.provider, meta: { latencyMs: out.latencyMs, len: out.translatedText.length } });
    if (out.provider === 'gpu') { recordGpuLatency(out.latencyMs); recordPerStageLatency('llm', out.latencyMs); }
    let translatedText = out.translatedText;
    let turnDecision: { kind: string; timeoutMs: number } | null = null;
    if (_turnFilter && translatedText) {
      const decision = _turnFilter.classify(translatedText);
      turnDecision = { kind: decision.kind, timeoutMs: decision.timeoutMs };
      // Incomplete turn → don't cache, suppress translatedText (caller
      // schedules re-prompt based on timeoutMs).
      if (decision.kind !== 'complete') {
        translatedText = '';
      } else {
        translatedText = decision.cleanedText;
      }
    }
    if (translatedText) setCachedTranslation(text, sourceLang, targetLang, translatedText, style);
    logRequest({ timestamp: Date.now(), stage: 'llm',
      provider: out.provider as 'gpu' | 'groq' | 'ollama' | 'ensemble' | 'cache' | 'hybrid',
      latencyMs: out.latencyMs, success: true, inputSize: text.length, outputPreview: translatedText.slice(0, 80) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      translated_text: translatedText,
      used_gpu: out.usedGpu,
      ...(turnDecision && turnDecision.kind !== 'complete' ? { incomplete_turn: turnDecision } : {}),
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`All translation providers failed: ${msg}`);
    logRequest({ timestamp: Date.now(), stage: 'llm', provider: getCloudProviderName(), latencyMs: Date.now() - t0, success: false, error: msg, inputSize: text.length });
    const status = msg.includes('No providers available') ? 500 : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: msg.includes('No providers available') ? 'No providers available for translation' : 'All providers failed for translation',
      translated_text: '',
    }));
  }
}

// ── Full pipeline route (STT + LLM + TTS) ──────────────────────────────────

// TRANSLATION_STYLES, buildSystemPrompt, resolveVoiceForProfile — imported from src/gateway/pipeline/system-prompt.ts
// Re-exported for backward compatibility via named import at top
export { TRANSLATION_STYLES, buildSystemPrompt, resolveVoiceForProfile };

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

// SttStageResult, LlmStageResult, TtsStageResult, PipelineResponseBody
// — types imported from src/gateway/pipeline/pipeline-response.ts

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
      log.log(`Using cached voice ref ${refId} (${(cached.audio.length/1024).toFixed(0)}KB)`);
    }
  }
  if (!referenceAudio) {
    referenceAudio = (req.headers['x-reference-audio'] as string) || undefined;
  }
  if (!refText) {
    const refTextRaw = (req.headers['x-ref-text'] as string) || url.searchParams.get('ref_text') || undefined;
    // Defend against malformed `%XX` sequences — `decodeURIComponent` throws
    // URIError on `%FF`/lone `%`, which would crash the request handler.
    if (refTextRaw) {
      try { refText = decodeURIComponent(refTextRaw); }
      catch { refText = refTextRaw; /* keep raw — provider will likely reject too */ }
    }
  }

  // When voice cloning is requested, force TTS to Modal (Groq/OpenAI don't support cloning)
  // GPU pod handles cloning directly in the hybrid race (fetchGpuTTS passes reference_audio/ref_text)
  const isCloneRequest = Boolean(referenceAudio && refText);
  if (isCloneRequest) {
    log.log(`Voice cloning active — TTS: GPU direct + Modal fallback (ref_text='${refText?.slice(0, 50)}...')`);
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

// ── Hybrid pipeline stage DI bundle ──────────────────────────────────────────
// Wires server-side state/side-effects into the pure runSttStage/runLlmStage/
// runTtsStage functions in src/gateway/pipeline/hybrid-stages.ts.
const hybridStagesDeps: HybridStagesDeps = {
  client, modalTTS,
  modalBabelcastUrl: () => MODAL_BABELCAST_URL,
  currentGpuEndpoint: () => deployState.endpoint,
  getCloudProviderName,
  raceProviders,
  adaptiveStageTimeout,
  fetchGpuSTT, fetchGpuLLM, fetchGpuTTS,
  getCachedTranslation, setCachedTranslation,
  isStageCircuitClosed,
  broadcastWs: (msg: unknown) => broadcastWs(msg as Record<string, unknown>),
  isTtsWarm, markTtsWarm, recordTtsTtfb, recordPerStageLatency,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  saveColdStartProfile: (p) => saveColdStartProfile(p as any),
  deployMetadata: () => ({
    gpuType: deployState.gpuType,
    dockerImage: deployState.dockerImage,
    provider: deployState.provider,
  }),
  GPU_STT_TIMEOUT_MS, GPU_LLM_TIMEOUT_MS, GPU_TTS_TIMEOUT_MS,
};

/** Stage runners — thin aliases that inject the server-side DI bundle. */
const _runSttStage = (p: PipelineParams) => _runSttStageCore(p as PipelineStageParams, hybridStagesDeps);
const _runLlmStage = (p: PipelineParams, stt: SttStageResult) => _runLlmStageCore(p as PipelineStageParams, stt, hybridStagesDeps);
const _runTtsStage = (p: PipelineParams, text: string) => _runTtsStageCore(p as PipelineStageParams, text, hybridStagesDeps);

// _encodePipelineResponse — uses encodePipelineResponse from src/gateway/pipeline
// _wantsBinaryAudio — uses wantsBinaryAudio from src/gateway/pipeline

/**
 * Send the pipeline response — either raw binary audio with metadata in headers
 * (when Accept: audio/wav) or the traditional JSON format (backwards compatible).
 */
function _sendPipelineResponse(
  req: IncomingMessage, res: ServerResponse,
  body: PipelineResponseBody,
  audioRaw?: Buffer,
): void {
  if (wantsBinaryAudio(req.headers['accept'] || '') && audioRaw && audioRaw.length > 0) {
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
  log.log(`Hybrid routing advice: ${advice.reason} (${advice.confidence.toFixed(2)} confidence)`);
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
    const realtimeMetrics = globalTracer?.getRealtimeMetrics(300_000) || DEFAULT_REALTIME_METRICS;
    const routingAdvice = await pipelineRouter.route('speech');
    const response = buildSystemAnalytics({ requestId, realtimeMetrics, routingAdvice });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response, null, 2));
  } catch (error) {
    log.warn(`Failed: ${error}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      requestId,
      timestamp: new Date().toISOString(),
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
    source, target, speaker, systemPrompt,
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
  log.log(`── Incoming [req=${requestId.slice(0, 8)}]: ${audioDur}s audio (${audioBuffer.length} bytes) ${source}->${target}${speaker ? ` speaker=${speaker}` : ''} mode=${mode} ${stageRoutes} ──`);

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
    probeGpuHealth(effectiveGpuEp).catch(e => log.warn('GPU health failed:', e instanceof Error ? e.message : e));
    if (groqAvailable && process.env.GROQ_API_KEY) {
      probeCloudProvider('groq', process.env.GROQ_API_KEY, 2000).catch(e => log.warn('Groq warmup failed:', e instanceof Error ? e.message : e));
    }

    try {
      // Emit user_speech_start at audio receive — opens a turn for the
      // UserBotLatencyObserver / TurnTrackingObserver.
      const { emitFrame: _ef } = await import('../src/observers');
      _ef({ kind: 'user_speech_start', ts: pipeT0, stage: 'pipeline', meta: { audioBytes: audioBuffer.length } });

      // ── Stage 1: STT ────────────────────────────────────────────────────
      const sttSpan = globalTracer.startSpan('stt_stage', traceSpan.spanId);
      const sttResult = await _runSttStage(params);
      globalTracer.addTag(sttSpan.spanId, 'stt.provider', sttResult.provider);
      globalTracer.addTag(sttSpan.spanId, 'stt.latency_ms', sttResult.latencyMs);
      globalTracer.addTag(sttSpan.spanId, 'stt.text_length', (sttResult.text || '').length);
      globalTracer.endSpan(sttSpan.spanId);

      _ef({ kind: 'stt_final', ts: Date.now(), stage: 'stt', provider: sttResult.provider, meta: { text: sttResult.text, latencyMs: sttResult.latencyMs } });

      if (!sttResult.text.trim()) {
        const totalMs = Date.now() - pipeT0;
        logRequest({ timestamp: Date.now(), stage: 'pipeline', provider: 'hybrid', latencyMs: totalMs, success: true, inputSize: audioBuffer.length, outputPreview: '' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ transcription: '', response: '', audio_base64: '', content_type: '', timing: { total_ms: totalMs, stt_ms: sttResult.latencyMs, llm_ms: 0, tts_ms: 0, used_gpu: false } }));
        return;
      }

      // ── Stage 2: LLM ────────────────────────────────────────────────────
      const llmSpan = globalTracer.startSpan('llm_stage', traceSpan.spanId);
      _ef({ kind: 'llm_request', ts: Date.now(), stage: 'llm', meta: { len: sttResult.text.length } });
      const llmResult = await _runLlmStage(params, sttResult);
      globalTracer.addTag(llmSpan.spanId, 'llm.provider', llmResult.provider);
      globalTracer.addTag(llmSpan.spanId, 'llm.latency_ms', llmResult.latencyMs);
      globalTracer.addTag(llmSpan.spanId, 'llm.output_length', (llmResult.translatedText || '').length);
      globalTracer.endSpan(llmSpan.spanId);
      _ef({ kind: 'llm_first_token', ts: Date.now(), stage: 'llm', provider: llmResult.provider });
      _ef({ kind: 'llm_complete', ts: Date.now(), stage: 'llm', provider: llmResult.provider, meta: { latencyMs: llmResult.latencyMs, len: (llmResult.translatedText || '').length } });

      // ── Stage 3: TTS ────────────────────────────────────────────────────
      const ttsSpan = globalTracer.startSpan('tts_stage', traceSpan.spanId);
      const { emitFrame: _emitFrame } = await import('../src/observers');
      _emitFrame({ kind: 'tts_request', ts: Date.now(), stage: 'tts', meta: { len: llmResult.translatedText.length } });
      const ttsResult = await _runTtsStage(params, llmResult.translatedText);
      globalTracer.addTag(ttsSpan.spanId, 'tts.provider', ttsResult.provider ?? 'unknown');
      globalTracer.addTag(ttsSpan.spanId, 'tts.latency_ms', ttsResult.latencyMs);
      if (ttsResult.audioB64) {
        globalTracer.addTag(ttsSpan.spanId, 'tts.audio_bytes', ttsResult.audioB64.length);
        _emitFrame({ kind: 'tts_first_audio', ts: Date.now(), stage: 'tts', provider: ttsResult.provider ?? undefined, meta: { latencyMs: ttsResult.latencyMs, bytes: ttsResult.audioB64.length } });
      }
      globalTracer.endSpan(ttsSpan.spanId);
      _emitFrame({ kind: 'tts_complete', ts: Date.now(), stage: 'tts', provider: ttsResult.provider ?? undefined, meta: { latencyMs: ttsResult.latencyMs } });

      // ── Build and send response ─────────────────────────────────────────
      const totalMs = Date.now() - pipeT0;
      log.log(`── Hybrid done: ${totalMs}ms (STT=${sttResult.latencyMs}[${sttResult.provider}] LLM=${llmResult.latencyMs}[${llmResult.provider}] TTS=${ttsResult.latencyMs}[${ttsResult.provider || '-'}]) ──`);
      logRequest({ timestamp: Date.now(), stage: 'pipeline', provider: 'hybrid', latencyMs: totalMs, success: true, inputSize: audioBuffer.length, outputPreview: (llmResult.translatedText || '').slice(0, 80) });
      stampProfileRequest((await loadProviderConfig()).activeAppId);

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
      log.warn(`Hybrid pipeline failed: ${err instanceof Error ? err.message : err}`);

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
  log.log(`Atomic path: gpu=${!!effectiveGpuEndpoint} clone=${isCloneRequest} ttsChain=${ttsChainNames} refAudio=${referenceAudio ? `${(referenceAudio.length/1024).toFixed(0)}KB` : 'none'} refText=${refText?.length || 0}ch`);
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
    await validateRemoteEndpointResolved(effectiveGpuEndpoint);
    fetch(`${effectiveGpuEndpoint}/health`, { signal: AbortSignal.timeout(2000) }).catch(e => log.warn('GPU pre-warm failed:', e instanceof Error ? e.message : e));
  }

  try {
    // Try full pipeline (GPU path runs all 3 stages atomically via /v1/speech)
    const result = await client.pipeline(audioBuffer, systemPrompt, [], profile);

    const sttMs = result.stt.latencyMs || 0;
    const llmMs = result.chat.latencyMs || 0;
    const ttsMs = result.tts?.latencyMs || 0;
    const ttsBytes = result.tts?.audio?.length || 0;
    const networkMs = computeNetworkMs(result);

    log.log(`STT (${sttMs}ms): "${(result.stt.text || '').substring(0, 80)}"`);
    log.log(`LLM (${llmMs}ms): "${(result.chat.content || '').substring(0, 80)}"`);
    log.log(`TTS (${ttsMs}ms): ${ttsBytes > 0 ? `${ttsBytes} bytes ${result.tts?.contentType || ''}` : 'NO AUDIO'}`);
    log.log(`── Done: ${result.totalLatencyMs}ms (STT=${sttMs} LLM=${llmMs} TTS=${ttsMs}${networkMs !== undefined ? ` NET=${networkMs}` : ''}) gpu=${result.usedGpu} ──`);

    // Track GPU TTS warmth: if GPU handled TTS, record the latency and mark warm
    if (result.usedGpu && ttsMs > 0) {
      recordPerStageLatency('tts', ttsMs);
      const profileBase = {
        gpuType: deployState.gpuType, dockerImage: deployState.dockerImage, provider: deployState.provider,
        modelLoadMs: 0, measuredAt: Date.now(),
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
      timestamp: Date.now(), stage: 'pipeline', provider: pipelineProvider,
      latencyMs: result.totalLatencyMs, success: true, inputSize: audioBuffer.length,
      outputPreview: (result.chat.content || '').slice(0, 80),
    });

    const atomicAudioRaw = extractAtomicAudio(result);
    const audioB64 = atomicAudioRaw ? atomicAudioRaw.toString('base64') : '';
    if (audioB64) forwardToAvatar(audioB64);

    const body = buildAtomicResponseBody(result, audioB64, isCloneRequest);
    _sendPipelineResponse(req, res, body, atomicAudioRaw);
  } catch (err) {
    log.warn(`Full pipeline failed: ${err instanceof Error ? err.message : err}`);
    // If pipeline fails (e.g. no TTS provider), try STT + LLM only (subtitles still work)
    try {
      const t0 = Date.now();
      const stt = await client.transcribe(audioBuffer, cloudProfile);
      const sttMs = Date.now() - t0;
      log.log(`STT fallback (${sttMs}ms): "${(stt.text || '').substring(0, 80)}"`);

      // [2] Check translation cache
      const fbCached = stt.text ? getCachedTranslation(stt.text, source, target) : null;
      let fbTranslated: string;
      let llmMs: number;
      if (fbCached !== null) {
        fbTranslated = fbCached;
        llmMs = 0;
        log.log(`LLM fallback [cache] (0ms): "${fbCached.substring(0, 80)}"`);
      } else {
        const tLlm = Date.now();
        const messages = [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: stt.text },
        ];
        const chat = await client.chat(messages, cloudProfile);
        fbTranslated = chat.content;
        llmMs = Date.now() - tLlm;
        log.log(`LLM fallback (${llmMs}ms): "${(fbTranslated || '').substring(0, 80)}"`);
        if (fbTranslated) setCachedTranslation(stt.text, source, target, fbTranslated);
      }

      // [3] Early subtitle push
      if (fbTranslated?.trim()) {
        broadcastWs({ type: 'subtitle:early', transcription: stt.text, translation: fbTranslated, source, target, timing: { stt_ms: sttMs, llm_ms: llmMs } });
      }

      const fallbackMs = Date.now() - t0;
      log.log(`── Fallback done (no TTS): ${fallbackMs}ms (STT=${sttMs} LLM=${llmMs}) ──`);
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
      log.error(`Complete failure: ${message}`);
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
    await validateRemoteEndpointResolved(gpuEndpoint);
    const gpuRes = await fetch(`${gpuEndpoint}/v1/voice-profile/status`, { signal: AbortSignal.timeout(15_000) });
    const data = await gpuRes.json();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: 'available', ...data }));
  } catch (err) {
    log.error(`Status fetch error: ${err instanceof Error ? err.message : err}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: 'error', hasProfile: false, samplesCount: 0, totalDurationSec: 0, ready: false, minDurationSec: 15, speakerId: null, gender: null }));
  }
}

export async function handleVoiceProfileReset(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const gpuEndpoint = isGpuAvailable() ? deployState.endpoint : null;
  if (!gpuEndpoint) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'No GPU pod active' }));
    return;
  }
  try {
    await validateRemoteEndpointResolved(gpuEndpoint);
    const gpuRes = await fetch(`${gpuEndpoint}/v1/voice-profile/reset`, { method: 'POST', signal: AbortSignal.timeout(15_000) });
    const data = await gpuRes.json();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    log.error(`Reset error: ${err instanceof Error ? err.message : err}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Failed to reach GPU pod' }));
  }
}

// ── Language Detection ─────────────────────────────────────────────────────────
import { detectLanguageWithSwap, SUPPORTED_LANGUAGES } from '../src/language-detect';

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

  const summary = runAutoSwapBenchmark({
    phrases,
    source,
    target,
    minConfidence,
    detect: detectLanguageWithSwap,
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(summary));
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

  let model = (body.model as string) || '';
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  if (!messages || !Array.isArray(messages)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'messages array is required' } }));
    return;
  }

  // Profile-driven model selection: when client sends `model: "@app/llm"`
  // (or omits it entirely), resolve to the authenticated user's app config
  // — apps[].llm[0]. This lets babylon-cinema, dumont-agent, etc. pin their
  // preferred LLM in ~/.babelcast/provider-config.json without hardcoding it
  // client-side.
  if (!model || model === '@app/llm' || model === 'auto') {
    const userId = req.headers['x-aigw-user-id'] as string | undefined;
    if (userId) {
      try {
        const cfg = await loadProviderConfig();
        const app = cfg.apps.find(a => a.id === userId);
        const first = app?.llm?.[0];
        if (first?.model) {
          model = first.model;
        }
      } catch (err) {
        log.warn('app-profile resolve failed: %s', err instanceof Error ? err.message : err);
      }
    }
  }

  const providerAdapters = {
    groq: groqLLM,
    ...(fireworksLLM ? { fireworks: fireworksLLM } : {}),
    ...(openrouterLLM ? { openrouter: openrouterLLM } : {}),
    ...(minimaxLLM?.isConfigured() ? { minimax: minimaxLLM } : {}),
  };

  const { provider: chatProvider, resolvedModel } = resolveChatProvider(model, {
    chatProviders: providers.chat || {},
    fallback: groqLLM,
    providerDefaults: {
      groq: groqLlmModel,
      fireworks: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    },
    providerAdapters,
  });

  try {
    // OpenRouter passthrough — reasoning + provider routing.
    const reasoning = body.reasoning && typeof body.reasoning === 'object'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (body.reasoning as any)
      : undefined;
    const providerRouting = body.provider && typeof body.provider === 'object'
      ? (body.provider as Record<string, unknown>)
      : undefined;

    const result = await chatProvider.chat({
      model: resolvedModel,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      responseFormat: body.response_format as any,
      ...(reasoning ? { reasoning } : {}),
      ...(providerRouting ? { provider: providerRouting } : {}),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const latencyMs = Date.now() - (req as any)._startTime || 0;
    logRequest({
      timestamp: Date.now(), stage: 'llm',
      provider: (chatProvider.providerId ?? 'groq') as 'gpu' | 'groq' | 'ollama' | 'ensemble' | 'cache' | 'hybrid',
      model: result.model,
      latencyMs, success: true, outputPreview: result.content?.slice(0, 80),
      inputTokens: result.usage?.promptTokens, outputTokens: result.usage?.completionTokens,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildOpenAiChatResponse(requestId, result)));
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (err as any)?.status || 500;
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`${model} failed: ${msg}`);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Internal server error' } }));
  }
}

// ── Embeddings — POST /v1/embeddings (OpenAI-compatible) ───────────────────
//
// Routes to OpenRouter's qwen3-embedding-0.6b by default. Used by the
// scenery-author asset retrieval pipeline (semantic search over thumb VLM
// descriptions) and any consumer that needs vector embeddings.

export async function handleEmbeddings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  touchRequest();
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Invalid body: ${err instanceof Error ? err.message : err}` } }));
    return;
  }
  // Default to qwen3-embedding-8b on OpenRouter — qwen3-embedding-0.6b isn't
  // exposed by the upstream and OpenAI text-embedding-3-* needs separate
  // quota. -8b is the most reliable open multilingual embedder available.
  const model = (body.model as string) || 'qwen/qwen3-embedding-8b';
  const input = body.input;
  if (!input || (typeof input !== 'string' && !Array.isArray(input))) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'input must be a string or array of strings' } }));
    return;
  }

  const provider = model.includes('text-embedding-3') ? openaiEmbedding : openrouterQwen3Embedding;
  if (!provider.isConfigured()) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Embedding provider for "${model}" not configured` } }));
    return;
  }

  try {
    const inputs = Array.isArray(input) ? input as string[] : [input as string];
    const result = await provider.embed(inputs, { model });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: result.embeddings.map((vec, i) => ({ object: 'embedding', index: i, embedding: vec })),
      model,
      usage: result.usage,
    }));
  } catch (err) {
    const status = (err as { status?: number })?.status || 500;
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`${model} embed failed: ${msg}`);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: msg.slice(0, 200) } }));
  }
}

// ── Voice Reference Cache — uses storeVoiceReference/getVoiceReference from src/gateway/pipeline
// The HTTP handler remains here (depends on server/ http-utils) but the cache itself is in src/.

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

  const refId = storeVoiceReference(audio, text);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ref_id: refId }));
}

// ── Modal TTS Keepalive — implementation in src/gateway/pipeline/modal-keepalive.ts
// Single shared instance. Endpoint lazily resolved from modalTTS config so
// tests/mocks that swap `modalTTS` see the latest value the first time
// touchModalKeepalive is called.
const modalKeepalive = new ModalKeepalive({
  endpoint: (modalTTS as unknown as { endpoint?: string })?.endpoint
    || 'REDACTED_env_a3fb60f2',
});

/** Stop modal keepalive timer (called on shutdown). */
export function stopModalKeepalive(): void { modalKeepalive.stop(); }

/** Called on every clone TTS request to reset the keepalive timer. */
export function touchModalKeepalive(): void { modalKeepalive.touch(); }
