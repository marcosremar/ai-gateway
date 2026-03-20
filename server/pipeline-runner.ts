// ── BabelCast Gateway — Streaming Pipeline Runner ───────────────────────────
// Shared pipeline logic for SSE and WebSocket streaming handlers.
// Runs STT → LLM → TTS with per-stage callbacks for real-time streaming.

import type { AIProfile } from '../src/client';
import {
  botState, deployState, isGpuAvailable, touchRequest, touchModelRequest,
  isTtsWarm, recordTtsTtfb, markTtsWarm, ttsWarmth, saveColdStartProfile,
  isStageWarm, gpuReadyForProduction, gpuReadinessState,
  recordPerStageLatency,
} from './state';
import {
  client, groqProfile, ollamaProfile, translationProfile,
  groqAvailable, groqTtsModel, groqTtsVoice,
  shouldPreferGpuTts,
  recordStageSuccess, recordStageFailure, isStageCircuitClosed,
  providers, modalTTS,
} from './providers';
import { PROVIDER_CHAIN, GPU_PROVIDERS } from './config';
import { raceProviders } from './race-providers';
import type { RaceCandidate } from './race-providers';
import { broadcastWs } from './ws-state';
import { logRequest } from './metrics';
import { loadProviderConfig, stampProfileRequest } from './config-persistence';
import { langNames } from './http-utils';
import { probeCloudProvider, probeGpuHealth } from '../src';
import {
  fetchGpuSTT, fetchGpuLLM, fetchGpuTTS,
  getCachedTranslation, setCachedTranslation,
  buildSystemPrompt, getCloudProviderName, getCloudProfile,
  resolveVoiceForProfile, forwardToAvatar,
  adaptiveStageTimeout,
  GPU_STT_TIMEOUT_MS, GPU_LLM_TIMEOUT_MS, GPU_TTS_TIMEOUT_MS, GPU_PIPELINE_TIMEOUT_MS,
  getVoiceReference, touchModalKeepalive,
  type GpuSTTResult, type GpuLLMResult, type GpuTTSResult,
} from './ai-handlers';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PipelineCallbacks {
  onStageStart(stage: string): void;
  onStageDone(stage: string, result: { text?: string; latencyMs: number; provider: string }): void;
  onAudioChunk(chunk: Buffer, isFirst: boolean): void;
  onComplete(result: PipelineResult): void;
  onError(stage: string, error: Error): void;
}

export interface PipelineOpts {
  source: string;
  target: string;
  speaker?: string;
  style?: string;
  sttPrompt?: string;
  refId?: string;
  referenceAudio?: string;
  refText?: string;
}

export interface PipelineResult {
  transcription: string;
  translation: string;
  audioBase64: string;
  contentType: string;
  timing: {
    total_ms: number;
    stt_ms: number;
    llm_ms: number;
    tts_ms: number;
    tts_ttfac_ms: number;
    stt_provider: string;
    llm_provider: string;
    tts_provider: string;
    used_gpu: boolean;
  };
}

// ── Pipeline Runner ──────────────────────────────────────────────────────────

export async function runStreamingPipeline(
  audio: Buffer, opts: PipelineOpts, cb: PipelineCallbacks,
): Promise<void> {
  touchRequest(); touchModelRequest();
  const pipeT0 = Date.now();

  const source = opts.source || 'fr';
  const target = opts.target || 'en';
  const speaker = opts.speaker;
  const style = opts.style || 'default';
  const sttPrompt = opts.sttPrompt || '';

  // Voice cloning: ref_id (cached) takes priority over inline reference_audio
  let referenceAudio = opts.referenceAudio;
  let refText = opts.refText;
  if (opts.refId) {
    const cached = getVoiceReference(opts.refId);
    if (cached) {
      referenceAudio = cached.audio;
      refText = cached.text;
    }
  }

  const isCloneRequest = Boolean(referenceAudio && refText);
  if (isCloneRequest) touchModalKeepalive();

  const cloneTtsChain = isCloneRequest
    ? [{ provider: 'modal', model: 'qwen3-tts' }, { provider: 'groq', model: groqTtsModel, voice: groqTtsVoice }]
    : undefined;

  const sourceName = langNames[source] || source;
  const targetName = langNames[target] || target;
  const systemPrompt = buildSystemPrompt(sourceName, targetName, style);

  const audioDur = (audio.length / (16000 * 2)).toFixed(1);

  // Determine routing
  const firstCloudIdx = PROVIDER_CHAIN.findIndex(p => p === 'groq' || p === 'ollama');
  const gpuIdx = PROVIDER_CHAIN.findIndex(p => GPU_PROVIDERS.has(p));
  const baseProfile = (firstCloudIdx >= 0 && PROVIDER_CHAIN[firstCloudIdx] === 'ollama' && ollamaProfile)
    ? ollamaProfile : (groqProfile || ollamaProfile || translationProfile);
  const gpuBeforeCloud = gpuIdx >= 0 && (firstCloudIdx < 0 || gpuIdx < firstCloudIdx);

  const gpuEp = (gpuBeforeCloud && isGpuAvailable()) ? deployState.endpoint : undefined;
  const sttOnGpu = !!gpuEp && isStageWarm('stt') && isStageCircuitClosed('stt');
  const llmOnGpu = !!gpuEp && isStageWarm('llm') && isStageCircuitClosed('llm');
  const ttsOnGpu = !!gpuEp && shouldPreferGpuTts() && isStageCircuitClosed('tts');

  const cloneGpuEndpoint = isCloneRequest && deployState.status === 'ready' && deployState.endpoint
    ? deployState.endpoint : undefined;

  const cloudVoice = speaker ? resolveVoiceForProfile(speaker, false) : undefined;
  const cloudProfile: AIProfile = {
    ...baseProfile,
    gpuEndpoint: undefined,
    language: source,
    ...(sttPrompt ? { sttPrompt } : {}),
    ...(cloudVoice ? { voice: cloudVoice } : {}),
    ...(referenceAudio ? { referenceAudio } : {}),
    ...(refText ? { refText } : {}),
    ...(cloneTtsChain ? { tts: cloneTtsChain } : {}),
    fallbackOptions: {
      ...baseProfile.fallbackOptions,
      timeoutMs: isCloneRequest ? 60_000 : GPU_PIPELINE_TIMEOUT_MS,
      ...(isCloneRequest ? { adaptiveTimeout: undefined } : {}),
    },
  };

  // Pre-warm connections
  const effectiveGpuEp = gpuEp || cloneGpuEndpoint;
  if (effectiveGpuEp) {
    probeGpuHealth(effectiveGpuEp).catch(e => console.warn('[pipeline] GPU health probe failed:', e instanceof Error ? e.message : e));
    if (groqAvailable && process.env.GROQ_API_KEY) {
      probeCloudProvider('groq', process.env.GROQ_API_KEY, 2000).catch(e => console.warn('[pipeline] Groq warmup failed:', e instanceof Error ? e.message : e));
    }
  }

  console.log(`[pipeline-stream] ── Incoming: ${audioDur}s audio ${source}->${target} ──`);

  try {
    // ── Stage 1: STT ─────────────────────────────────────────────────────────
    cb.onStageStart('stt');
    const sttT0 = Date.now();

    const sttCandidates: RaceCandidate<GpuSTTResult>[] = [];
    if (sttOnGpu) {
      const sttTimeout = adaptiveStageTimeout('stt', GPU_STT_TIMEOUT_MS);
      sttCandidates.push({
        name: 'gpu', timeoutMs: sttTimeout,
        run: (signal) => fetchGpuSTT(gpuEp!, audio, source, sttPrompt, '', false, signal),
      });
    }
    sttCandidates.push({
      name: getCloudProviderName(), timeoutMs: 8_000,
      run: async (signal) => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const r = await client.transcribe(audio, cloudProfile);
        return { text: r.text, language: r.language || '', used_gpu: false, avg_logprob: 0 };
      },
    });

    const sttRace = await raceProviders(sttCandidates, { logPrefix: '[stream-stt]', headstartMs: 0 });
    const sttText = sttRace.result.text;
    const sttProvider = sttRace.provider;
    const sttMs = Date.now() - sttT0;

    cb.onStageDone('stt', { text: sttText, latencyMs: sttMs, provider: sttProvider });

    if (!sttText.trim()) {
      const totalMs = Date.now() - pipeT0;
      cb.onComplete({
        transcription: '', translation: '', audioBase64: '', contentType: '',
        timing: { total_ms: totalMs, stt_ms: sttMs, llm_ms: 0, tts_ms: 0, tts_ttfac_ms: 0, stt_provider: sttProvider, llm_provider: 'none', tts_provider: 'none', used_gpu: false },
      });
      return;
    }

    // ── Stage 2: LLM Translation ─────────────────────────────────────────────
    cb.onStageStart('llm');
    const llmT0 = Date.now();

    const cached = getCachedTranslation(sttText, source, target, style);
    let translatedText = '';
    let llmProvider = '';
    let llmMs = 0;

    if (cached !== null) {
      translatedText = cached;
      llmProvider = 'cache';
      llmMs = 0;
    } else {
      const llmCandidates: RaceCandidate<GpuLLMResult>[] = [];
      if (llmOnGpu) {
        const llmTimeout = adaptiveStageTimeout('llm', GPU_LLM_TIMEOUT_MS);
        llmCandidates.push({
          name: 'gpu', timeoutMs: llmTimeout,
          run: (signal) => fetchGpuLLM(gpuEp!, sttText, source, target, '', '', signal),
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

      const llmRace = await raceProviders(llmCandidates, { logPrefix: '[stream-llm]', headstartMs: 0 });
      translatedText = llmRace.result.translated_text;
      llmProvider = llmRace.provider;
      llmMs = Date.now() - llmT0;

      if (translatedText) setCachedTranslation(sttText, source, target, translatedText, style);
    }

    cb.onStageDone('llm', { text: translatedText, latencyMs: llmMs, provider: llmProvider });

    // Early subtitle push
    if (translatedText.trim()) {
      broadcastWs({
        type: 'subtitle:early',
        transcription: sttText,
        translation: translatedText,
        source, target,
        timing: { stt_ms: sttMs, llm_ms: llmMs },
      });
    }

    // ── Stage 3: TTS ─────────────────────────────────────────────────────────
    cb.onStageStart('tts');
    const ttsT0 = Date.now();
    let audioB64 = '';
    let contentType = '';
    let ttsMs = 0;
    let ttsProvider = '';
    let ttfacMs = 0;

    if (translatedText.trim()) {
      const ttsCandidates: RaceCandidate<GpuTTSResult>[] = [];
      const ttsTimeout = isCloneRequest ? 60_000 : adaptiveStageTimeout('tts', GPU_TTS_TIMEOUT_MS);
      const ttsGpuEp = gpuEp || cloneGpuEndpoint;
      const gpuTtsUsable = ttsGpuEp && isStageCircuitClosed('tts');

      if (ttsOnGpu || (isCloneRequest && gpuTtsUsable)) {
        ttsCandidates.push({
          name: 'gpu', timeoutMs: ttsTimeout,
          run: (signal) => fetchGpuTTS(ttsGpuEp!, translatedText, targetName, speaker || 'Ryan', signal, referenceAudio, refText),
        });
      }
      if (isCloneRequest) {
        ttsCandidates.push({
          name: 'modal', timeoutMs: ttsTimeout,
          run: async (signal) => {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const r = await modalTTS.synthesize({ input: translatedText, voice: speaker || 'Ryan', referenceAudio, refText });
            return { audio: r.audio, contentType: r.contentType, used_gpu: false };
          },
        });
      } else {
        ttsCandidates.push({
          name: getCloudProviderName(), timeoutMs: 8_000,
          run: async (signal) => {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const r = await client.synthesize(translatedText, cloudProfile);
            return { audio: r.audio, contentType: r.contentType, used_gpu: false };
          },
        });
      }

      try {
        const ttsRace = await raceProviders(ttsCandidates, { logPrefix: '[stream-tts]', headstartMs: 0 });
        ttsMs = Date.now() - ttsT0;
        ttfacMs = ttsMs; // TTFAC = time to first audio chunk (full buffer for now)
        const audioBuffer = ttsRace.result.audio;
        contentType = ttsRace.result.contentType;
        ttsProvider = ttsRace.provider;
        audioB64 = audioBuffer.toString('base64');

        // Send audio as a single chunk
        cb.onAudioChunk(audioBuffer, true);

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
      } catch (ttsErr) {
        // TTS failure — try fallback for clone, else just continue without audio
        if (isCloneRequest) {
          try {
            const fallbackT0 = Date.now();
            const r = await client.synthesize(translatedText, { ...cloudProfile, referenceAudio: undefined, refText: undefined, tts: undefined });
            ttsMs = Date.now() - fallbackT0;
            ttfacMs = ttsMs;
            audioB64 = r.audio.toString('base64');
            contentType = r.contentType;
            ttsProvider = `${r.provider}/preset-fallback`;
            cb.onAudioChunk(r.audio, true);
          } catch {
            // TTS optional — subtitles still work
          }
        }
      }
    }

    cb.onStageDone('tts', { latencyMs: ttsMs, provider: ttsProvider || 'none' });

    if (audioB64) forwardToAvatar(audioB64);

    const totalMs = Date.now() - pipeT0;
    const usedAnyGpu = sttProvider === 'gpu' || llmProvider === 'gpu' || ttsProvider === 'gpu';

    logRequest({ timestamp: Date.now(), stage: 'pipeline', provider: 'stream', latencyMs: totalMs, success: true, inputSize: audio.length, outputPreview: (translatedText || '').slice(0, 80) });
    stampProfileRequest(loadProviderConfig().activeProfileId);

    console.log(`[pipeline-stream] ── Done: ${totalMs}ms (STT=${sttMs}[${sttProvider}] LLM=${llmMs}[${llmProvider}] TTS=${ttsMs}[${ttsProvider || '-'}]) ──`);

    cb.onComplete({
      transcription: sttText,
      translation: translatedText,
      audioBase64: audioB64,
      contentType,
      timing: {
        total_ms: totalMs,
        stt_ms: sttMs,
        llm_ms: llmMs,
        tts_ms: ttsMs,
        tts_ttfac_ms: ttfacMs,
        stt_provider: sttProvider,
        llm_provider: llmProvider,
        tts_provider: ttsProvider || 'none',
        used_gpu: usedAnyGpu,
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[pipeline-stream] Error: ${error.message}`);
    cb.onError('pipeline', error);
  }
}
