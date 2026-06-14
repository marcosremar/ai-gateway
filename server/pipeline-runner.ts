// ── BabelCast Gateway — Streaming Pipeline Runner ───────────────────────────
// Thin server layer that wires concrete server state + provider instances
// into the pure pipeline orchestrator from src/gateway/pipeline/.

import type { AIProfile } from '../src/client';
import { createLogger } from '../src/logger';
import {
  runPipelineOrchestrator,
  ewmaRaceOpts as _ewmaRaceOpts,
} from '../src/gateway/pipeline/pipeline-orchestrator';
import type {
  PipelineCallbacks as _PipelineCallbacks,
  PipelineOpts as _PipelineOpts,
  PipelineResult as _PipelineResult,
  PipelineDeps,
  PipelineRouting,
  PipelineLabsFlags,
  PipelineSideEffects,
  PipelineStageExecutors,
} from '../src/gateway/pipeline/pipeline-orchestrator';

const log = createLogger('pipeline-runner');
import {
  botState, deployState, isGpuAvailable, touchRequest, touchModelRequest,
  isTtsWarm, recordTtsTtfb, markTtsWarm, ttsWarmth, saveColdStartProfile,
  isStageWarm, gpuReadyForProduction, gpuReadinessState,
  recordPerStageLatency,
} from './state';
import {
  client, groqProfile, ollamaProfile, translationProfile,
  groqAvailable, groqLLM, groqLlmModel, groqTtsModel, groqTtsVoice,
  shouldPreferGpuTts,
  recordStageSuccess, recordStageFailure, isStageCircuitClosed,
  providers, modalTTS,
} from './providers';
import { PROVIDER_CHAIN, GPU_PROVIDERS, MODAL_BABELCAST_URL } from './config';
import { raceProviders } from './race-providers';
import type { RaceCandidate } from './race-providers';
import { EWMATracker } from './ewma-tracker';
import { getLabsFlags, type LabsFlags } from './labs-settings';
import { StreamingOverlap } from './streaming-overlap';
import { speculativeCache } from './speculative-cache';
import { broadcastWs, broadcastDubAudio } from './ws-state';
import { getActiveTargets, runMultiLangFanout } from './dub-fanout';
import { logRequest } from './metrics';
import { loadProviderConfig, stampProfileRequest } from './config-persistence';
import { sttRace } from '../src/stt-race';
import type { STTRaceProvider } from '../src/stt-race';
import { groqSTT } from '../src/providers/groq';
import { langNames } from './http-utils';
import { probeCloudProvider, probeGpuHealth } from '../src';
import {
  fetchGpuSTT, fetchGpuLLM, fetchGpuTTS,
  getCachedTranslation, setCachedTranslation,
  buildSystemPrompt, getCloudProviderName, getCloudProfile,
  resolveVoiceForProfile, forwardToAvatar,
  adaptiveStageTimeout, adaptiveMaxTokens,
  GPU_STT_TIMEOUT_MS, GPU_LLM_TIMEOUT_MS, GPU_TTS_TIMEOUT_MS, GPU_PIPELINE_TIMEOUT_MS,
  getVoiceReference, touchModalKeepalive,
  type GpuSTTResult, type GpuLLMResult, type GpuTTSResult,
} from './ai-handlers';

// ── Re-export types for existing consumers ──────────────────────────────────

export type { _PipelineCallbacks as PipelineCallbacks };
export type { _PipelineOpts as PipelineOpts };
export type { _PipelineResult as PipelineResult };

// ── PeakEWMA Singleton ───────────────────────────────────────────────────────

export const ewmaTracker = new EWMATracker();

// ── Streaming Overlap Singleton ────────────────────────────────────────────

export const streamingOverlap = new StreamingOverlap();

// ── Exported EWMA helper (for server modules that use it directly) ──────────

export function ewmaRaceOpts(
  candidates: RaceCandidate<unknown>[],
  stage: string,
  labs?: LabsFlags,
): { headstartMs: number } {
  const flags = labs ?? getLabsFlags();
  return _ewmaRaceOpts(candidates, stage, flags, ewmaTracker);
}

// ── Wire server deps → pipeline orchestrator ─────────────────────────────────

function buildRouting(opts: _PipelineOpts, referenceAudio?: string, refText?: string): PipelineRouting {
  const firstCloudIdx = PROVIDER_CHAIN.findIndex(p => p === 'groq' || p === 'ollama');
  const gpuIdx = PROVIDER_CHAIN.findIndex(p => GPU_PROVIDERS.has(p));
  const gpuBeforeCloud = gpuIdx >= 0 && (firstCloudIdx < 0 || gpuIdx < firstCloudIdx);

  const gpuEp = (gpuBeforeCloud && isGpuAvailable()) ? deployState.endpoint : undefined;
  const sttOnGpu = !!gpuEp && isStageWarm('stt') && isStageCircuitClosed('stt');
  const llmOnGpu = !!gpuEp && isStageWarm('llm') && isStageCircuitClosed('llm');
  const ttsOnGpu = !!gpuEp && shouldPreferGpuTts() && isStageCircuitClosed('tts');

  const isCloneRequest = Boolean(referenceAudio && refText);
  const cloneGpuEndpoint = isCloneRequest && deployState.status === 'ready' && deployState.endpoint
    ? deployState.endpoint : undefined;

  return {
    gpuEndpoint: gpuEp,
    sttOnGpu,
    llmOnGpu,
    ttsOnGpu,
    modalBabelcastUrl: MODAL_BABELCAST_URL,
    deployEndpointIsModal: deployState.endpoint === MODAL_BABELCAST_URL,
    cloudProviderName: getCloudProviderName(),
    isCloneRequest,
    cloneGpuEndpoint,
    gpuTtsCircuitClosed: isStageCircuitClosed('tts'),
  };
}

function buildSideEffects(): PipelineSideEffects {
  return {
    onPipelineStart() { touchRequest(); touchModelRequest(); },
    onCloneStart() { touchModalKeepalive(); },
    preWarmConnections(gpuEndpoint) {
      if (gpuEndpoint) {
        probeGpuHealth(gpuEndpoint).catch(e => log.warn('GPU health probe failed:', e instanceof Error ? e.message : e));
        if (groqAvailable && process.env.GROQ_API_KEY) {
          probeCloudProvider('groq', process.env.GROQ_API_KEY, 2000).catch(e => log.warn('Groq warmup failed:', e instanceof Error ? e.message : e));
        }
      }
    },
    broadcastSubtitle(data) {
      broadcastWs({
        type: 'subtitle:early',
        transcription: data.transcription,
        translation: data.translation,
        source: data.source, target: data.target,
        timing: data.timing,
      });
    },
    broadcastDubAudio: broadcastDubAudio,
    forwardToAvatar,
    logRequest(data) { logRequest(data); },
    stampProfile() { loadProviderConfig().then(c => stampProfileRequest(c.activeAppId)); },
    recordGpuTtsWarmth(ttsMs) {
      const warmthProfile = { gpuType: deployState.gpuType, dockerImage: deployState.dockerImage, provider: deployState.provider, modelLoadMs: 0, measuredAt: Date.now() };
      if (!isTtsWarm()) {
        markTtsWarm(ttsMs);
        saveColdStartProfile({ ...warmthProfile, coldTtfbMs: ttsMs, warmTtfbAvgMs: 240, sampleCount: 0 });
      } else {
        recordTtsTtfb(ttsMs);
      }
    },
    recordPerStageLatency,
    getOtherDubTargets(excludeTarget) {
      return getActiveTargets().filter(t => t !== excludeTarget);
    },
    runDubFanout(sttText, source, sttMs, sttProvider, opts) {
      runMultiLangFanout(sttText, source, sttMs, sttProvider, opts).catch(err => log.warn('dub-fanout', err));
    },
  };
}

function buildStageExecutors(routing: PipelineRouting): PipelineStageExecutors {
  const baseProfile = getBaseProfile();
  const isClone = routing.isCloneRequest;

  return {
    buildSttCandidates(rt, audio, source, sttPrompt, adaptTimeout) {
      const candidates: RaceCandidate<GpuSTTResult>[] = [];
      if (rt.sttOnGpu) {
        const sttTimeout = adaptTimeout('stt', GPU_STT_TIMEOUT_MS);
        candidates.push({
          name: 'gpu', timeoutMs: sttTimeout,
          run: (signal) => fetchGpuSTT(rt.gpuEndpoint!, audio, source, sttPrompt, '', false, signal),
        });
      }
      if (rt.modalBabelcastUrl && !(rt.sttOnGpu && rt.deployEndpointIsModal)) {
        candidates.push({
          name: 'modal-babelcast', timeoutMs: 15_000,
          run: (signal) => fetchGpuSTT(rt.modalBabelcastUrl!, audio, source, sttPrompt, '', false, signal),
        });
      }
      const cloudProfile = buildCloudProfile(baseProfile, source, sttPrompt, isClone, routing);
      candidates.push({
        name: rt.cloudProviderName, timeoutMs: 8_000,
        run: async (signal) => {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const r = await client.transcribe(audio, cloudProfile);
          return { text: r.text, language: r.language || '', used_gpu: false, avg_logprob: 0 };
        },
      });
      if (groqAvailable) {
        candidates.push({
          name: 'ensemble-fallback', timeoutMs: 3_000,
          run: async (signal) => {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const providers: STTRaceProvider[] = [{ name: 'groq', provider: groqSTT }];
            const result = await sttRace(audio, source, sttPrompt, { providers, timeoutMs: 2500 });
            return { text: result.text, language: '', used_gpu: false, avg_logprob: result.avgLogprob ?? 0 };
          },
        });
      }
      return candidates;
    },

    buildLlmCandidates(rt, sttText, source, target, systemPrompt, adaptTimeout) {
      const candidates: RaceCandidate<GpuLLMResult>[] = [];
      if (rt.llmOnGpu) {
        const llmTimeout = adaptTimeout('llm', GPU_LLM_TIMEOUT_MS);
        candidates.push({
          name: 'gpu', timeoutMs: llmTimeout,
          run: (signal) => fetchGpuLLM(rt.gpuEndpoint!, sttText, source, target, '', '', signal),
        });
      }
      if (rt.modalBabelcastUrl && !(rt.llmOnGpu && rt.deployEndpointIsModal)) {
        candidates.push({
          name: 'modal-babelcast', timeoutMs: 15_000,
          run: (signal) => fetchGpuLLM(rt.modalBabelcastUrl!, sttText, source, target, '', '', signal),
        });
      }
      const cloudProfile = buildCloudProfile(baseProfile, source, '', isClone, routing);
      candidates.push({
        name: rt.cloudProviderName, timeoutMs: 8_000,
        run: async (signal) => {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const messages = [{ role: 'system' as const, content: systemPrompt }, { role: 'user' as const, content: sttText }];
          const r = await client.chat(messages, cloudProfile);
          return { translated_text: r.content, used_gpu: false };
        },
      });
      return candidates;
    },

    buildTtsCandidates(rt, translatedText, targetName, speaker, referenceAudio, refText, adaptTimeout) {
      const candidates: RaceCandidate<GpuTTSResult>[] = [];
      const ttsTimeout = isClone ? 60_000 : (adaptTimeout ? adaptTimeout('tts', GPU_TTS_TIMEOUT_MS) : GPU_TTS_TIMEOUT_MS);
      const ttsGpuEp = rt.gpuEndpoint || rt.cloneGpuEndpoint;
      const gpuTtsUsable = ttsGpuEp && rt.gpuTtsCircuitClosed;

      if (rt.ttsOnGpu || (isClone && gpuTtsUsable)) {
        candidates.push({
          name: 'gpu', timeoutMs: ttsTimeout,
          run: (signal) => fetchGpuTTS(ttsGpuEp!, translatedText, targetName, speaker, signal, referenceAudio, refText),
        });
      }
      if (isClone) {
        candidates.push({
          name: 'modal', timeoutMs: ttsTimeout,
          run: async (signal) => {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const r = await modalTTS.synthesize({ input: translatedText, model: 'qwen3-tts', voice: speaker, referenceAudio, refText });
            return { audio: r.audio, contentType: r.contentType, used_gpu: false };
          },
        });
      } else {
        if (rt.modalBabelcastUrl && !(rt.ttsOnGpu && rt.deployEndpointIsModal)) {
          candidates.push({
            name: 'modal-babelcast', timeoutMs: 20_000,
            run: (signal) => fetchGpuTTS(rt.modalBabelcastUrl!, translatedText, targetName, speaker, signal),
          });
        }
        const cloudProfile = buildCloudProfile(baseProfile, '', '', isClone, routing);
        candidates.push({
          name: rt.cloudProviderName, timeoutMs: 8_000,
          run: async (signal) => {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const r = await client.synthesize(translatedText, cloudProfile);
            return { audio: r.audio, contentType: r.contentType, used_gpu: false };
          },
        });
      }
      return candidates;
    },

    getOverlapTtsFn(rt, targetName, speaker, referenceAudio, refText) {
      return async (chunkText: string): Promise<Buffer> => {
        const ttsGpuEp = rt.gpuEndpoint || rt.cloneGpuEndpoint;
        if (rt.ttsOnGpu && ttsGpuEp) {
          const result = await fetchGpuTTS(ttsGpuEp, chunkText, targetName, speaker, AbortSignal.timeout(GPU_TTS_TIMEOUT_MS), referenceAudio, refText);
          return result.audio;
        }
        const cloudProfile = buildCloudProfile(baseProfile, '', '', isClone, routing);
        const r = await client.synthesize(chunkText, cloudProfile);
        return r.audio;
      };
    },

    createLlmStream(systemPrompt, sttText) {
      const messages = [{ role: 'system' as const, content: systemPrompt }, { role: 'user' as const, content: sttText }];
      // Size the output budget to the input — a short utterance ("oui") never
      // needs 200 output tokens. Caps at 200 for long input, so this only ever
      // *reduces* generation cost on the hot streaming path (never raises it).
      return groqLLM.chatStream({
        messages,
        model: groqLlmModel,
        temperature: 0,
        maxTokens: adaptiveMaxTokens(sttText),
      });
    },

    canStreamLlm() {
      return groqAvailable && typeof groqLLM.chatStream === 'function';
    },

    getCachedTranslation,
    setCachedTranslation,
    getVoiceReference,
    buildSystemPrompt,

    async ttsFallbackSynthesize(translatedText) {
      const cloudProfile = buildCloudProfile(baseProfile, '', '', false, routing);
      const r = await client.synthesize(translatedText, { ...cloudProfile, referenceAudio: undefined, refText: undefined, tts: undefined });
      return { audio: r.audio, contentType: r.contentType, provider: r.provider || routing.cloudProviderName };
    },
  };
}

function getBaseProfile(): AIProfile {
  const firstCloudIdx = PROVIDER_CHAIN.findIndex(p => p === 'groq' || p === 'ollama');
  return (firstCloudIdx >= 0 && PROVIDER_CHAIN[firstCloudIdx] === 'ollama' && ollamaProfile)
    ? ollamaProfile : (groqProfile || ollamaProfile || translationProfile)!;
}

function cloneTtsChain(isClone: boolean): AIProfile['tts'] {
  if (!isClone) return undefined;
  const chain = [{ provider: 'modal', model: 'qwen3-tts' }, { provider: 'groq', model: groqTtsModel, voice: groqTtsVoice }];
  return chain as AIProfile['tts'];
}

function buildCloudProfile(
  baseProfile: AIProfile, source: string, sttPrompt: string,
  isClone: boolean, routing: PipelineRouting,
): AIProfile {
  const cloudVoice = undefined; // voice resolved per-call in TTS candidates
  return {
    ...baseProfile,
    gpuEndpoint: undefined,
    language: source,
    ...(sttPrompt ? { sttPrompt } : {}),
    ...(cloudVoice ? { voice: cloudVoice } : {}),
    ...(isClone ? {
      tts: cloneTtsChain(isClone),
    } : {}),
    fallbackOptions: {
      ...baseProfile.fallbackOptions,
      timeoutMs: isClone ? 60_000 : GPU_PIPELINE_TIMEOUT_MS,
      ...(isClone ? { adaptiveTimeout: undefined } : {}),
    },
  };
}

// ── Pipeline Runner (public API — same signature as before) ──────────────────

export async function runStreamingPipeline(
  audio: Buffer, opts: _PipelineOpts, cb: _PipelineCallbacks,
): Promise<void> {
  // Resolve voice cloning references for routing computation
  let referenceAudio = opts.referenceAudio;
  let refText = opts.refText;
  if (opts.refId) {
    const cached = getVoiceReference(opts.refId);
    if (cached) {
      referenceAudio = cached.audio;
      refText = cached.text;
    }
  }

  const routing = buildRouting(opts, referenceAudio, refText);

  // Check that we have a base profile
  const baseProfile = getBaseProfile();
  if (!baseProfile) {
    cb.onError('pipeline', new Error('No LLM provider configured (groq, ollama, or translation profile required)'));
    return;
  }

  const labs = getLabsFlags();

  const deps: PipelineDeps = {
    routing,
    labs,
    sideEffects: buildSideEffects(),
    executors: buildStageExecutors(routing),
    ewmaTracker,
    speculativeCache,
    streamingOverlap,
    langNames,
    adaptiveStageTimeout,
  };

  return runPipelineOrchestrator(audio, opts, cb, deps);
}
