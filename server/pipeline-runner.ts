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

// ── Static provider-chain indices (#66) ──────────────────────────────────────
// PROVIDER_CHAIN and GPU_PROVIDERS are module-level constants, so these scans
// are pure and identical on every request. `buildRouting` re-ran two
// `findIndex` scans (plus a comparison) per pipeline run; compute them once.

/**
 * Pure resolver for the static provider-chain indices used by routing (#66).
 * Extracted so the (otherwise module-private) hoist is unit-testable.
 */
export function computeChainIndices(
  chain: readonly string[],
  gpuProviders: ReadonlySet<string>,
): { firstCloudIdx: number; gpuIdx: number; gpuBeforeCloud: boolean } {
  const firstCloudIdx = chain.findIndex(p => p === 'groq' || p === 'ollama');
  const gpuIdx = chain.findIndex(p => gpuProviders.has(p));
  const gpuBeforeCloud = gpuIdx >= 0 && (firstCloudIdx < 0 || gpuIdx < firstCloudIdx);
  return { firstCloudIdx, gpuIdx, gpuBeforeCloud };
}

const _chainIdx = computeChainIndices(PROVIDER_CHAIN, GPU_PROVIDERS);
const FIRST_CLOUD_IDX = _chainIdx.firstCloudIdx;
const GPU_BEFORE_CLOUD = _chainIdx.gpuBeforeCloud;

/**
 * Invariant (#74): the cloud TTS providers (Groq/OpenAI) CANNOT voice-clone, so
 * a clone TTS request must never append a cloud synth leg (it would pay for an
 * un-cloned voice that can't satisfy the request). For a clone the chain is
 * GPU (+Modal); for non-clone it is GPU/Modal + cloud. This pure descriptor
 * mirrors the candidate-builder branch so the contract is asserted in tests.
 */
export function ttsCandidateKindsForClone(isClone: boolean): { gpu: boolean; modal: boolean; cloud: boolean } {
  return isClone
    ? { gpu: true, modal: true, cloud: false }
    : { gpu: true, modal: true, cloud: true };
}

// modal-babelcast STT leg deadline (#65). The cloud STT leg has an 8s deadline,
// so a 15s Modal leg fired in parallel kept a (possibly cold-started) Modal
// container alive ~7s past the point cloud already won. Tighten to 10s — enough
// cold-start margin to occasionally win, without billing long after the race
// is decided. (LLM/TTS Modal legs are unchanged — their work is heavier.)
export const MODAL_BABELCAST_STT_TIMEOUT_MS = 10_000;
/** Cloud STT leg deadline, for the #65 invariant test (Modal must not outlast it by much). */
export const CLOUD_STT_TIMEOUT_MS = 8_000;

/**
 * Build the WebSocket payload broadcast when a dub fanout fails entirely (#61),
 * so the UI dub status reflects the drop instead of failing silently.
 */
export function buildDubErrorEvent(source: string, err: unknown): {
  type: 'dub:error'; source: string; message: string; at: number;
} {
  const message = err instanceof Error ? err.message : String(err);
  return { type: 'dub:error', source, message, at: Date.now() };
}

/**
 * Normalize a cloud/ensemble STT avg_logprob (#18). The cloud path doesn't
 * surface Whisper logprobs, so a literal 0 looked like a real, very-confident
 * measurement and defeated the metadata hallucination filter (which uses NaN as
 * its missing-metric sentinel). Pass through a real number; otherwise NaN.
 */
export function cloudSttAvgLogprob(raw: number | null | undefined): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : NaN;
}

// ── Wire server deps → pipeline orchestrator ─────────────────────────────────

function buildRouting(opts: _PipelineOpts, referenceAudio?: string, refText?: string): PipelineRouting {
  const gpuBeforeCloud = GPU_BEFORE_CLOUD;

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
      // Surface a totally-failed fanout (#61). Previously a rejection was only
      // log.warn'd, so the client/UI dub status never learned the dubbed
      // languages were dropped. Emit a dub:error event in addition to logging.
      runMultiLangFanout(sttText, source, sttMs, sttProvider, opts).catch(err => {
        log.warn('dub-fanout', err);
        broadcastWs(buildDubErrorEvent(source, err));
      });
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
          name: 'modal-babelcast', timeoutMs: MODAL_BABELCAST_STT_TIMEOUT_MS,
          run: (signal) => fetchGpuSTT(rt.modalBabelcastUrl!, audio, source, sttPrompt, '', false, signal),
        });
      }
      const cloudProfile = buildCloudProfile(baseProfile, source, sttPrompt, isClone, routing);
      candidates.push({
        name: rt.cloudProviderName, timeoutMs: 8_000,
        run: async (signal) => {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const r = await client.transcribe(audio, cloudProfile);
          // NaN (not 0) signals "no avg_logprob measured" so the metadata
          // hallucination filter handles the missing metric explicitly (#18).
          return { text: r.text, language: r.language || '', used_gpu: false, avg_logprob: cloudSttAvgLogprob(undefined) };
        },
      });
      if (groqAvailable) {
        candidates.push({
          name: 'ensemble-fallback', timeoutMs: 3_000,
          run: async (signal) => {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const providers: STTRaceProvider[] = [{ name: 'groq', provider: groqSTT }];
            const result = await sttRace(audio, source, sttPrompt, { providers, timeoutMs: 2500 });
            // Preserve a real logprob when the race surfaced one; otherwise NaN
            // (the missing-metric sentinel) rather than a misleading 0 (#18).
            return { text: result.text, language: '', used_gpu: false, avg_logprob: cloudSttAvgLogprob(result.avgLogprob) };
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
  return (FIRST_CLOUD_IDX >= 0 && PROVIDER_CHAIN[FIRST_CLOUD_IDX] === 'ollama' && ollamaProfile)
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
