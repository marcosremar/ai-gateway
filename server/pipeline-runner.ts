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
import { runEnsembleSTT } from '../src/ensemble-stt';
import type { EnsembleSTTProviderEntry } from '../src/ensemble-stt';
import { groqSTT } from '../src/providers/groq';
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
  /** Session ID for speculative translation cache lookups. */
  sessionId?: string;
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

// ── PeakEWMA Singleton ───────────────────────────────────────────────────────
// Module-level tracker shared across all pipeline runs. Records latency per
// provider name (e.g. "gpu", "groq") and uses it to inform routing when the
// Labs peakEwma flag is enabled. Lightweight, in-memory only.

export const ewmaTracker = new EWMATracker();

// ── Streaming Overlap Singleton ────────────────────────────────────────────
// Module-level overlap manager shared across all pipeline runs. Starts TTS
// on partial LLM output when the Labs streamingOverlap flag is enabled.
export const streamingOverlap = new StreamingOverlap();

/**
 * Compute EWMA-aware race options for a set of candidates.
 * When peakEwma is enabled:
 *   - Adjusts timeouts based on EWMA: timeout = ewmaMs * 2.5 (generous but adaptive)
 *   - Gives the best (lowest EWMA) candidate a headstart so it wins ties
 * When disabled: returns { headstartMs: 0 } (no change to existing behavior).
 */
function ewmaRaceOpts(
  candidates: RaceCandidate<unknown>[],
  stage: string,
  labs?: LabsFlags,
): { headstartMs: number } {
  const flags = labs ?? getLabsFlags();
  if (!flags.peakEwma || candidates.length < 2) return { headstartMs: 0 };

  // Sync decay factor from settings
  ewmaTracker.setDecayFactor(flags.ewmaDecayFactor);

  const names = candidates.map(c => c.name);
  const best = ewmaTracker.pickBest(names);
  if (!best) return { headstartMs: 0 };

  // Adjust timeouts based on EWMA data (clone timeoutMs to avoid mutating originals)
  for (const c of candidates) {
    const ewma = ewmaTracker.getLatency(c.name);
    if (ewma !== null && c.timeoutMs) {
      c.timeoutMs = Math.max(500, Math.min(c.timeoutMs, Math.ceil(ewma * 2.5)));
    }
  }

  // Sort candidates so the best (lowest EWMA) is first — swap in place, no splice
  const bestIdx = candidates.findIndex(c => c.name === best);
  if (bestIdx > 0) {
    const tmp = candidates[0];
    candidates[0] = candidates[bestIdx];
    candidates[bestIdx] = tmp;
  }

  // Give the best provider a 50ms headstart so it wins ties
  const ranking = ewmaTracker.ranking().filter(r => names.includes(r.provider));
  const bestEntry = ranking.find(r => r.provider === best);
  const secondEntry = ranking.find(r => r.provider !== best);

  if (bestEntry && secondEntry) {
    console.log(`[ewma] Routing ${stage} to ${best} (ewma=${bestEntry.ewmaMs}ms) over ${secondEntry.provider} (ewma=${secondEntry.ewmaMs}ms)`);
  }

  return { headstartMs: 50 };
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

  // Snapshot labs flags once per pipeline run (avoids 3+ shallow copies)
  const labs = getLabsFlags();

  // Determine routing
  const firstCloudIdx = PROVIDER_CHAIN.findIndex(p => p === 'groq' || p === 'ollama');
  const gpuIdx = PROVIDER_CHAIN.findIndex(p => GPU_PROVIDERS.has(p));
  const baseProfile = (firstCloudIdx >= 0 && PROVIDER_CHAIN[firstCloudIdx] === 'ollama' && ollamaProfile)
    ? ollamaProfile : (groqProfile || ollamaProfile || translationProfile);
  if (!baseProfile) {
    cb.onError('pipeline', new Error('No LLM provider configured (groq, ollama, or translation profile required)'));
    return;
  }
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
    // Tier 2: add Modal unless Modal IS the GPU AND already handling this stage via sttOnGpu
    if (MODAL_BABELCAST_URL && !(sttOnGpu && deployState.endpoint === MODAL_BABELCAST_URL)) {
      sttCandidates.push({
        name: 'modal-babelcast', timeoutMs: 15_000,
        run: (signal) => fetchGpuSTT(MODAL_BABELCAST_URL!, audio, source, sttPrompt, '', false, signal),
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
    // Ensemble fallback: works without vault (uses env vars directly).
    // Added as last candidate so it only runs if AIClient fails (e.g. no vault configured).
    if (groqAvailable) {
      sttCandidates.push({
        name: 'ensemble-fallback', timeoutMs: 3_000,
        run: async (signal) => {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const ensembleProviders: EnsembleSTTProviderEntry[] = [{ name: 'groq', provider: groqSTT }];
          const result = await runEnsembleSTT(audio, source, sttPrompt, {
            providers: ensembleProviders, timeoutMs: 2500,
          });
          return { text: result.consensus, language: '', used_gpu: false, avg_logprob: result.avg_logprob ?? 0 };
        },
      });
    }

    const sttEwmaOpts = ewmaRaceOpts(sttCandidates as RaceCandidate<unknown>[], 'STT', labs);
    const sttRace = await raceProviders(sttCandidates, { logPrefix: '[stream-stt]', headstartMs: sttEwmaOpts.headstartMs });
    const sttText = sttRace.result.text;
    const sttProvider = sttRace.provider;
    const sttMs = Date.now() - sttT0;

    // Record latency for EWMA tracking (always, even when flag is off — cheap and useful for when it's turned on)
    ewmaTracker.record(sttProvider, sttMs);

    cb.onStageDone('stt', { text: sttText, latencyMs: sttMs, provider: sttProvider });

    if (!sttText.trim()) {
      const totalMs = Date.now() - pipeT0;
      cb.onComplete({
        transcription: '', translation: '', audioBase64: '', contentType: '',
        timing: { total_ms: totalMs, stt_ms: sttMs, llm_ms: 0, tts_ms: 0, tts_ttfac_ms: 0, stt_provider: sttProvider, llm_provider: 'none', tts_provider: 'none', used_gpu: false },
      });
      return;
    }

    // ── Dub fan-out for other subscribed languages (fire-and-forget) ──
    const otherDubTargets = getActiveTargets().filter(t => t !== target);
    if (otherDubTargets.length > 0) {
      runMultiLangFanout(sttText, source, sttMs, sttProvider, {
        speaker, style, targets: otherDubTargets,
      }).catch(err => console.warn('[dub-fanout]', err));
    }

    // ── Stage 2: LLM Translation ─────────────────────────────────────────────
    cb.onStageStart('llm');
    const llmT0 = Date.now();

    const cached = getCachedTranslation(sttText, source, target, style);
    let translatedText = '';
    let llmProvider = '';
    let llmMs = 0;

    // TTS variables — declared here so both overlap and sequential paths can set them
    let audioB64 = '';
    let contentType = '';
    let ttsMs = 0;
    let ttsProvider = '';
    let ttfacMs = 0;
    let ttsHandled = false; // set true when streaming overlap handles TTS internally

    if (cached !== null) {
      translatedText = cached;
      llmProvider = 'cache';
      llmMs = 0;
    } else {
      // ── Speculative translation check ──────────────────────────────────
      const sessionId = opts.sessionId;
      let speculationUsed = false;

      if (labs.speculativeTranslation && sessionId) {
        const specResult = await speculativeCache.resolve(sessionId, sttText, labs.speculationMinConfidence);
        if (specResult) {
          translatedText = specResult;
          llmProvider = 'speculation';
          llmMs = Date.now() - llmT0;
          speculationUsed = true;
          // Also store in the regular translation cache for future reuse
          setCachedTranslation(sttText, source, target, translatedText, style);
        }
      }

      if (!speculationUsed) {
        // ── Check if streaming overlap is possible ──────────────────────────
        // Overlap merges LLM+TTS: we stream LLM tokens and fire TTS on chunk
        // boundaries so the first audio arrives before the LLM finishes.
        // Requirements: flag ON, cloud LLM available with streaming, not a
        // clone request (clone TTS needs special handling), and not GPU-only LLM.
        const canOverlap = labs.streamingOverlap
          && !isCloneRequest
          && groqAvailable
          && typeof groqLLM.chatStream === 'function'  // provider supports streaming
          && !llmOnGpu;          // GPU /v1/translate/text doesn't stream

        if (canOverlap) {
          // ── Streaming Overlap Path: LLM → TTS interleaved ─────────────
          ttsHandled = true;
          streamingOverlap.setMinTokens(labs.overlapMinTokens);
          console.log('[pipeline-stream] Using streaming overlap (LLM+TTS interleaved)');

          cb.onStageStart('tts'); // TTS starts alongside LLM in overlap mode

          const messages = [{ role: 'system' as const, content: systemPrompt }, { role: 'user' as const, content: sttText }];
          const llmStream = groqLLM.chatStream({
            messages,
            model: groqLlmModel,
            temperature: 0,
            maxTokens: 200,
          });

          // Build a TTS function that uses the same routing as the sequential path
          const overlapTtsFn = async (chunkText: string): Promise<Buffer> => {
            const ttsGpuEp = gpuEp || cloneGpuEndpoint;
            if (ttsOnGpu && ttsGpuEp) {
              const result = await fetchGpuTTS(ttsGpuEp, chunkText, targetName, speaker || 'Ryan', AbortSignal.timeout(GPU_TTS_TIMEOUT_MS), referenceAudio, refText);
              return result.audio;
            }
            const r = await client.synthesize(chunkText, cloudProfile);
            return r.audio;
          };

          // Collect audio chunks in order for concatenation
          const orderedChunks: Map<number, Buffer> = new Map();
          let firstChunkSentAt: number | null = null;

          const overlapT0 = Date.now();
          translatedText = await streamingOverlap.processWithOverlap(
            llmStream,
            overlapTtsFn,
            (audio, chunkIndex) => {
              orderedChunks.set(chunkIndex, audio);
              if (firstChunkSentAt === null) {
                firstChunkSentAt = Date.now();
                cb.onAudioChunk(audio, true);
              } else {
                cb.onAudioChunk(audio, false);
              }
            },
          );
          const overlapTotalMs = Date.now() - overlapT0;

          llmProvider = 'groq';
          llmMs = overlapTotalMs; // LLM+TTS combined in overlap mode
          ewmaTracker.record(llmProvider, llmMs);

          if (translatedText) setCachedTranslation(sttText, source, target, translatedText, style);

          // Assemble results for downstream (subtitle push, dub, avatar, completion)
          const allChunks: Buffer[] = [];
          for (let i = 0; i < orderedChunks.size; i++) {
            const chunk = orderedChunks.get(i);
            if (chunk) allChunks.push(chunk);
          }
          const combinedAudio = allChunks.length > 0 ? Buffer.concat(allChunks) : Buffer.alloc(0);
          audioB64 = combinedAudio.length > 0 ? combinedAudio.toString('base64') : '';
          contentType = combinedAudio.length > 0 ? 'audio/wav' : '';
          ttsMs = firstChunkSentAt !== null ? Date.now() - overlapT0 : 0;
          ttfacMs = firstChunkSentAt !== null ? firstChunkSentAt - overlapT0 : 0;
          ttsProvider = ttsOnGpu ? 'gpu' : getCloudProviderName();

          // Mark stages done
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

          // Broadcast dub:audio for website viewers
          if (audioB64) {
            broadcastDubAudio(target, {
              type: 'dub:audio', target,
              audio: audioB64,
              transcription: sttText, translation: translatedText,
              timing: { stt_ms: sttMs, llm_ms: llmMs, tts_ms: ttsMs, total_ms: Date.now() - pipeT0 },
            }, combinedAudio.length > 0 ? combinedAudio : undefined);
          }

          cb.onStageDone('tts', { latencyMs: ttsMs, provider: ttsProvider });

        } else {
          // ── Sequential LLM ───────────────────────────────────────────────
          const llmCandidates: RaceCandidate<GpuLLMResult>[] = [];
          if (llmOnGpu) {
            const llmTimeout = adaptiveStageTimeout('llm', GPU_LLM_TIMEOUT_MS);
            llmCandidates.push({
              name: 'gpu', timeoutMs: llmTimeout,
              run: (signal) => fetchGpuLLM(gpuEp!, sttText, source, target, '', '', signal),
            });
          }
          // Tier 2: add Modal unless Modal IS the GPU AND already handling this stage via llmOnGpu
          if (MODAL_BABELCAST_URL && !(llmOnGpu && deployState.endpoint === MODAL_BABELCAST_URL)) {
            llmCandidates.push({
              name: 'modal-babelcast', timeoutMs: 15_000,
              run: (signal) => fetchGpuLLM(MODAL_BABELCAST_URL!, sttText, source, target, '', '', signal),
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

          const llmEwmaOpts = ewmaRaceOpts(llmCandidates as RaceCandidate<unknown>[], 'LLM', labs);
          const llmRace = await raceProviders(llmCandidates, { logPrefix: '[stream-llm]', headstartMs: llmEwmaOpts.headstartMs });
          translatedText = llmRace.result.translated_text;
          llmProvider = llmRace.provider;
          llmMs = Date.now() - llmT0;

          // Record latency for EWMA tracking
          ewmaTracker.record(llmProvider, llmMs);

          if (translatedText) setCachedTranslation(sttText, source, target, translatedText, style);
        }
      }
    }

    // ── LLM done callback (for non-overlap paths) ────────────────────────────
    if (!ttsHandled) {
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
    }

    // ── Stage 3: TTS (Sequential — skipped when overlap already handled it) ──
    if (!ttsHandled) {
      cb.onStageStart('tts');
      const seqTtsT0 = Date.now();

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
              const r = await modalTTS.synthesize({ input: translatedText, model: 'qwen3-tts', voice: speaker || 'Ryan', referenceAudio, refText });
              return { audio: r.audio, contentType: r.contentType, used_gpu: false };
            },
          });
        } else {
          // Tier 2: add Modal unless Modal IS the GPU AND already handling this stage via ttsOnGpu
          if (MODAL_BABELCAST_URL && !(ttsOnGpu && deployState.endpoint === MODAL_BABELCAST_URL)) {
            ttsCandidates.push({
              name: 'modal-babelcast', timeoutMs: 20_000,
              run: (signal) => fetchGpuTTS(MODAL_BABELCAST_URL!, translatedText, targetName, speaker || 'Ryan', signal),
            });
          }
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
          const ttsEwmaOpts = ewmaRaceOpts(ttsCandidates as RaceCandidate<unknown>[], 'TTS', labs);
          const ttsRace = await raceProviders(ttsCandidates, { logPrefix: '[stream-tts]', headstartMs: ttsEwmaOpts.headstartMs });
          ttsMs = Date.now() - seqTtsT0;
          ttfacMs = ttsMs; // TTFAC = time to first audio chunk (full buffer for now)
          const audioBuffer = ttsRace.result.audio;
          contentType = ttsRace.result.contentType;
          ttsProvider = ttsRace.provider;
          audioB64 = audioBuffer.toString('base64');

          // Record latency for EWMA tracking
          ewmaTracker.record(ttsProvider, ttsMs);

          // Send audio as a single chunk
          cb.onAudioChunk(audioBuffer, true);

          // Broadcast dub:audio for website viewers subscribed to this target
          broadcastDubAudio(target, {
            type: 'dub:audio', target,
            audio: audioB64,
            transcription: sttText, translation: translatedText,
            timing: { stt_ms: sttMs, llm_ms: llmMs, tts_ms: ttsMs, total_ms: Date.now() - pipeT0 },
          }, audioBuffer);

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
    }

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
