// ── BabelCast Gateway — Hybrid Pipeline Stage Runners ────────────────────────
// Extracted from server/ai-handlers.ts: _runSttStage / _runLlmStage / _runTtsStage.
// Each stage races GPU vs Modal vs cloud providers in parallel (raceProviders)
// and returns the first successful result. Side effects (broadcastWs, TTS
// warmth tracking) are injected via HybridStagesDeps so this module stays
// server/-free.

import type { AIProfile } from '../../client';
import type { RaceCandidate } from '../routing/provider-racer';
import type { GpuSTTResult, GpuLLMResult, GpuTTSResult } from './gpu-fetch';
import type { SttStageResult, LlmStageResult, TtsStageResult } from './pipeline-response';
import { createLogger } from '../../logger';

const log = createLogger('hybrid-stages');

function assertValidAudio(result: GpuTTSResult, provider: string): GpuTTSResult {
  const audioLength = Buffer.isBuffer(result.audio) ? result.audio.length : Buffer.from(result.audio).length;
  if (audioLength === 0) {
    throw new Error(`${provider} returned empty audio`);
  }
  if (!result.contentType?.trim()) {
    throw new Error(`${provider} returned missing audio content type`);
  }
  return result;
}

/** Transcription / LLM / TTS client surface needed for cloud-side races. */
export interface HybridStagesClient {
  transcribe(audio: Buffer, profile: AIProfile): Promise<{
    text: string;
    language?: string;
    timing?: { total_ms: number; server_ms?: number; network_ms?: number };
  }>;
  chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    profile: AIProfile,
  ): Promise<{ content: string }>;
  synthesize(text: string, profile: AIProfile): Promise<{
    audio: Buffer | Uint8Array;
    contentType: string;
    provider?: string;
  }>;
}

/** Minimal Modal TTS surface for clone requests. */
export interface HybridStagesModalTTS {
  synthesize(input: {
    input: string;
    model: string;
    voice: string;
    referenceAudio?: string;
    refText?: string;
  }): Promise<{ audio: Buffer | Uint8Array; contentType: string }>;
}

export interface HybridStagesDeps {
  client: HybridStagesClient;
  modalTTS: HybridStagesModalTTS;

  /** Returns Modal BabelCast URL if tier-2 Modal is configured, otherwise null/undefined. */
  modalBabelcastUrl: () => string | null | undefined;
  /** Currently-deployed GPU endpoint (for detecting "modal IS the gpu" case). */
  currentGpuEndpoint: () => string | null | undefined;
  /** Cloud provider name — used as raceProviders candidate label. */
  getCloudProviderName: () => string;

  /** Stage race runner (server-owned because it uses EWMA tracker state). */
  raceProviders: <T>(
    candidates: RaceCandidate<T>[],
    opts: { logPrefix: string; headstartMs: number },
  ) => Promise<{ result: T; provider: string; latencyMs: number }>;

  /** Per-stage adaptive timeout. Reads stage warmth data. */
  adaptiveStageTimeout: (stage: 'stt' | 'llm' | 'tts', baseMs: number) => number;

  /** GPU fetch wrappers (thin DI-ified versions that call gpu-fetch.ts + recordStage*). */
  fetchGpuSTT: (
    gpuEndpoint: string, audio: Buffer, language: string, prompt: string,
    hotwords: string, wordTimestamps: boolean, signal: AbortSignal, requestId?: string,
  ) => Promise<GpuSTTResult>;
  fetchGpuLLM: (
    gpuEndpoint: string, text: string, sourceLang: string, targetLang: string,
    glossary: string, context: string, signal: AbortSignal, requestId?: string,
  ) => Promise<GpuLLMResult>;
  fetchGpuTTS: (
    gpuEndpoint: string, text: string, language: string, speaker: string,
    signal: AbortSignal, refAudio?: string, refText?: string, requestId?: string,
  ) => Promise<GpuTTSResult>;

  /** Translation cache. */
  getCachedTranslation: (text: string, source: string, target: string, style?: string) => string | null;
  setCachedTranslation: (text: string, source: string, target: string, translated: string, style?: string) => void;

  /** Stage circuit breaker — only TTS path reads this (gates GPU TTS). */
  isStageCircuitClosed: (stage: 'stt' | 'llm' | 'tts') => boolean;

  /** WebSocket broadcast for early subtitle push. */
  broadcastWs: (msg: unknown) => void;

  /** TTS warmth tracking — gates `markTtsWarm` vs `recordTtsTtfb`. */
  isTtsWarm: () => boolean;
  markTtsWarm: (ms: number) => void;
  recordTtsTtfb: (ms: number) => void;
  recordPerStageLatency: (stage: 'stt' | 'llm' | 'tts', ms: number) => void;
  /** Persist cold-start profile when the TTS stage ships its first warm token. */
  saveColdStartProfile: (profile: {
    gpuType: unknown;
    dockerImage: unknown;
    provider: unknown;
    modelLoadMs: number;
    measuredAt: number;
    coldTtfbMs: number;
    warmTtfbAvgMs: number;
    sampleCount: number;
  }) => void;

  /** deployState snapshot — needed for cold-start profile persist. */
  deployMetadata: () => { gpuType: unknown; dockerImage: unknown; provider: unknown };

  /** Timeout constants — passed in rather than imported so server can override. */
  GPU_STT_TIMEOUT_MS: number;
  GPU_LLM_TIMEOUT_MS: number;
  GPU_TTS_TIMEOUT_MS: number;
}

/** Parsed pipeline request — server computes routing flags + profiles. */
export interface PipelineStageParams {
  source: string;
  target: string;
  sourceName: string;
  targetName: string;
  speaker?: string;
  style: string;
  sttPrompt: string;
  referenceAudio?: string;
  refText?: string;
  isCloneRequest: boolean;
  systemPrompt: string;
  audioBuffer: Buffer;
  cloudProfile: AIProfile;
  gpuEp?: string;
  sttOnGpu: boolean;
  llmOnGpu: boolean;
  ttsOnGpu: boolean;
  cloneGpuEndpoint?: string;
  requestId: string;
}

// ── STT ──────────────────────────────────────────────────────────────────────

export async function runSttStage(
  params: PipelineStageParams,
  deps: HybridStagesDeps,
): Promise<SttStageResult> {
  const { sttOnGpu, gpuEp, audioBuffer, source, sttPrompt, cloudProfile, requestId } = params;
  const MODAL_URL = deps.modalBabelcastUrl();

  const sttCandidates: RaceCandidate<GpuSTTResult>[] = [];
  const sttTimeout = deps.adaptiveStageTimeout('stt', deps.GPU_STT_TIMEOUT_MS);

  if (sttOnGpu) {
    sttCandidates.push({
      name: 'gpu', timeoutMs: sttTimeout,
      run: (signal) => deps.fetchGpuSTT(gpuEp!, audioBuffer, source, sttPrompt, '', false, signal, requestId),
    });
  }
  if (MODAL_URL && !(sttOnGpu && deps.currentGpuEndpoint() === MODAL_URL)) {
    sttCandidates.push({
      name: 'modal-babelcast', timeoutMs: 15_000,
      run: (signal) => deps.fetchGpuSTT(MODAL_URL, audioBuffer, source, sttPrompt, '', false, signal, requestId),
    });
  }
  sttCandidates.push({
    name: deps.getCloudProviderName(), timeoutMs: 8_000,
    run: async (signal) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const r = await deps.client.transcribe(audioBuffer, cloudProfile);
      return {
        text: r.text, language: r.language || '', used_gpu: false, avg_logprob: 0,
        _sttTiming: r.timing,
      } as GpuSTTResult & { _sttTiming?: typeof r.timing };
    },
  });

  const sttRace = await deps.raceProviders(sttCandidates, { logPrefix: '[pipeline-stt]', headstartMs: 0 });
  const sttTiming = (sttRace.result as unknown as Record<string, unknown>)['_sttTiming'] as
    { total_ms: number; server_ms?: number; network_ms?: number } | undefined;
  const sttNetworkMs = sttTiming?.network_ms;
  const sttServerMs = sttTiming?.server_ms;
  log.log(`STT [${sttRace.provider}] (${sttRace.latencyMs}ms${sttNetworkMs !== undefined ? ` net=${sttNetworkMs}ms srv=${sttServerMs}ms` : ''}): "${(sttRace.result.text || '').substring(0, 80)}"`);

  return {
    text: sttRace.result.text,
    provider: sttRace.provider,
    latencyMs: sttRace.latencyMs,
    serverMs: sttServerMs,
    networkMs: sttNetworkMs,
  };
}

// ── LLM ──────────────────────────────────────────────────────────────────────

export async function runLlmStage(
  params: PipelineStageParams,
  sttResult: SttStageResult,
  deps: HybridStagesDeps,
): Promise<LlmStageResult> {
  const { source, target, style, llmOnGpu, gpuEp, cloudProfile, systemPrompt, requestId } = params;
  const sttText = sttResult.text;
  const MODAL_URL = deps.modalBabelcastUrl();

  const cached = deps.getCachedTranslation(sttText, source, target, style);
  if (cached !== null) {
    log.log(`LLM [cache] (0ms): "${cached.substring(0, 80)}"`);
    if (cached.trim()) {
      deps.broadcastWs({
        type: 'subtitle:early',
        transcription: sttText, translation: cached,
        source, target,
        timing: { stt_ms: sttResult.latencyMs, llm_ms: 0 },
      });
    }
    return { translatedText: cached, provider: 'cache', latencyMs: 0 };
  }

  const llmCandidates: RaceCandidate<GpuLLMResult>[] = [];
  const llmTimeout = deps.adaptiveStageTimeout('llm', deps.GPU_LLM_TIMEOUT_MS);
  if (llmOnGpu) {
    llmCandidates.push({
      name: 'gpu', timeoutMs: llmTimeout,
      run: (signal) => deps.fetchGpuLLM(gpuEp!, sttText, source, target, '', '', signal, requestId),
    });
  }
  if (MODAL_URL && !(llmOnGpu && deps.currentGpuEndpoint() === MODAL_URL)) {
    llmCandidates.push({
      name: 'modal-babelcast', timeoutMs: 15_000,
      run: (signal) => deps.fetchGpuLLM(MODAL_URL, sttText, source, target, '', '', signal, requestId),
    });
  }
  llmCandidates.push({
    name: deps.getCloudProviderName(), timeoutMs: 8_000,
    run: async (signal) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: sttText },
      ];
      const r = await deps.client.chat(messages, cloudProfile);
      return { translated_text: r.content, used_gpu: false };
    },
  });

  const llmRace = await deps.raceProviders(llmCandidates, { logPrefix: '[pipeline-llm]', headstartMs: 0 });
  const translatedText = llmRace.result.translated_text;
  log.log(`LLM [${llmRace.provider}] (${llmRace.latencyMs}ms): "${(translatedText || '').substring(0, 80)}"`);

  if (translatedText) {
    deps.setCachedTranslation(sttText, source, target, translatedText, style);
  }
  if (translatedText.trim()) {
    deps.broadcastWs({
      type: 'subtitle:early',
      transcription: sttText, translation: translatedText,
      source, target,
      timing: { stt_ms: sttResult.latencyMs, llm_ms: llmRace.latencyMs },
    });
  }

  return { translatedText, provider: llmRace.provider, latencyMs: llmRace.latencyMs };
}

// ── TTS ──────────────────────────────────────────────────────────────────────

export async function runTtsStage(
  params: PipelineStageParams,
  translatedText: string,
  deps: HybridStagesDeps,
): Promise<TtsStageResult> {
  const {
    isCloneRequest, ttsOnGpu, gpuEp, cloneGpuEndpoint,
    targetName, speaker, referenceAudio, refText, cloudProfile, requestId,
  } = params;

  if (!translatedText.trim()) {
    return { audioB64: '', contentType: '', provider: '', latencyMs: 0 };
  }

  const MODAL_URL = deps.modalBabelcastUrl();
  const ttsCandidates: RaceCandidate<GpuTTSResult>[] = [];
  const ttsTimeout = isCloneRequest ? 60_000 : deps.adaptiveStageTimeout('tts', deps.GPU_TTS_TIMEOUT_MS);
  const ttsGpuEp = gpuEp || cloneGpuEndpoint;
  const gpuTtsUsable = ttsGpuEp && deps.isStageCircuitClosed('tts');
  const ttsCircuitOpen = ttsGpuEp && !deps.isStageCircuitClosed('tts');
  log.log(`Decision: clone=${isCloneRequest} gpuEp=${!!ttsGpuEp} gpuUsable=${!!gpuTtsUsable} circuitOpen=${!!ttsCircuitOpen} ttsOnGpu=${ttsOnGpu}`);

  if (ttsOnGpu || (isCloneRequest && gpuTtsUsable)) {
    log.log(`Adding GPU candidate (endpoint=${ttsGpuEp})`);
    ttsCandidates.push({
      name: 'gpu', timeoutMs: ttsTimeout,
      run: async (signal) => assertValidAudio(
        await deps.fetchGpuTTS(ttsGpuEp!, translatedText, targetName, speaker || 'Ryan', signal, referenceAudio, refText, requestId),
        'gpu',
      ),
    });
  }
  if (isCloneRequest) {
    log.log(`Adding Modal clone candidate (ref_audio=${referenceAudio ? `${(referenceAudio.length/1024).toFixed(0)}KB` : 'none'} ref_text=${refText?.length || 0} chars)`);
    ttsCandidates.push({
      name: 'modal', timeoutMs: ttsTimeout,
      run: async (signal) => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        log.log(`Modal clone START: "${translatedText.slice(0, 50)}..."`);
        try {
          const r = await deps.modalTTS.synthesize({
            input: translatedText, model: 'qwen3-tts', voice: speaker || 'Ryan',
            referenceAudio, refText,
          });
          log.log(`Modal clone OK: ${r.audio.length} bytes (${r.contentType})`);
          return assertValidAudio({ audio: r.audio as Buffer, contentType: r.contentType, used_gpu: false }, 'modal');
        } catch (err) {
          log.error(`Modal clone FAILED: ${err instanceof Error ? err.message : err}`);
          throw err;
        }
      },
    });
  } else {
    if (MODAL_URL && !(ttsOnGpu && deps.currentGpuEndpoint() === MODAL_URL)) {
      ttsCandidates.push({
        name: 'modal-babelcast', timeoutMs: 20_000,
        run: async (signal) => assertValidAudio(
          await deps.fetchGpuTTS(MODAL_URL, translatedText, targetName, speaker || 'Ryan', signal, undefined, undefined, requestId),
          'modal-babelcast',
        ),
      });
    }
    log.log(`Adding cloud TTS candidate (${deps.getCloudProviderName()})`);
    ttsCandidates.push({
      name: deps.getCloudProviderName(), timeoutMs: 8_000,
      run: async (signal) => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const r = await deps.client.synthesize(translatedText, cloudProfile);
        return assertValidAudio({ audio: r.audio as Buffer, contentType: r.contentType, used_gpu: false }, deps.getCloudProviderName());
      },
    });
  }

  let audioB64 = '';
  let audioRaw: Buffer | undefined;
  let contentType = '';
  let ttsMs = 0;
  let ttsProvider = '';

  log.log(`Racing ${ttsCandidates.length} candidates: ${ttsCandidates.map(c => c.name).join(', ')}`);
  try {
    const ttsRace = await deps.raceProviders(ttsCandidates, { logPrefix: '[pipeline-tts]', headstartMs: 0 });
    audioRaw = Buffer.isBuffer(ttsRace.result.audio) ? ttsRace.result.audio : Buffer.from(ttsRace.result.audio);
    audioB64 = audioRaw.toString('base64');
    contentType = ttsRace.result.contentType;
    ttsProvider = ttsRace.provider;
    ttsMs = ttsRace.latencyMs;
    log.log(`Winner: ${ttsProvider} (${ttsMs}ms, ${audioB64.length} bytes b64)`);
  } catch (ttsErr) {
    log.error(`ALL clone candidates failed: ${ttsErr instanceof Error ? ttsErr.message : ttsErr}`);
    if (isCloneRequest) {
      try {
        log.log(`Clone failed — falling back to Groq preset voice`);
        const fallbackT0 = Date.now();
        const r = await deps.client.synthesize(translatedText, {
          ...cloudProfile, referenceAudio: undefined, refText: undefined, tts: undefined,
        });
        const valid = assertValidAudio({ audio: r.audio as Buffer, contentType: r.contentType, used_gpu: false }, 'cloud/preset-fallback');
        audioRaw = Buffer.isBuffer(valid.audio) ? valid.audio : Buffer.from(valid.audio);
        audioB64 = audioRaw.toString('base64');
        contentType = valid.contentType;
        ttsProvider = `${r.provider || 'cloud'}/preset-fallback`;
        ttsMs = Date.now() - fallbackT0;
        log.log(`Fallback OK: ${ttsProvider} (${ttsMs}ms, ${audioB64.length} bytes b64)`);
      } catch (fbErr) {
        log.error(`Fallback also failed: ${fbErr instanceof Error ? fbErr.message : fbErr}`);
      }
    }
  }
  log.log(`TTS [${ttsProvider || 'none'}] (${ttsMs}ms): ${audioB64 ? `${audioB64.length} bytes b64` : 'NO AUDIO'}`);

  // Track GPU TTS warmth
  if (ttsProvider === 'gpu' && ttsMs > 0) {
    deps.recordPerStageLatency('tts', ttsMs);
    const meta = deps.deployMetadata();
    const warmthProfile = {
      gpuType: meta.gpuType, dockerImage: meta.dockerImage, provider: meta.provider,
      modelLoadMs: 0, measuredAt: Date.now(),
    };
    if (!deps.isTtsWarm()) {
      deps.markTtsWarm(ttsMs);
      deps.saveColdStartProfile({ ...warmthProfile, coldTtfbMs: ttsMs, warmTtfbAvgMs: 240, sampleCount: 0 });
    } else {
      deps.recordTtsTtfb(ttsMs);
    }
  }

  return { audioB64, audioRaw, contentType, provider: ttsProvider, latencyMs: ttsMs };
}
