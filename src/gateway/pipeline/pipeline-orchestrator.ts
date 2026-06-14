// ── BabelCast Gateway — Pipeline Orchestrator (Pure Domain Logic) ─────────────
// Core STT → LLM → TTS pipeline sequencing extracted from server/pipeline-runner.ts.
// This module contains ZERO server/ imports — all server-bound state and I/O are
// injected via the PipelineDeps interface.

import { createLogger } from '../../logger';
import type { RaceCandidate } from '../routing/provider-racer';
import { raceProviders } from '../routing/provider-racer';
import type { EWMATracker } from '../routing/ewma-tracker';
import type { GpuSTTResult, GpuLLMResult, GpuTTSResult } from './gpu-fetch';
import type { SpeculativeCache } from './speculative-cache';
import type { StreamingOverlap } from './streaming-overlap';
import type { PipelinePluginRegistry, PluginContext } from './plugin-registry';
import { GPU_STT_TIMEOUT_MS, GPU_LLM_TIMEOUT_MS, GPU_TTS_TIMEOUT_MS, GPU_PIPELINE_TIMEOUT_MS } from './timeouts';
import { DEFAULT_SPEAKER } from './system-prompt';

const log = createLogger('pipeline-orchestrator');

/**
 * Whether a stage's resolved provider name denotes a GPU path (#91). Replaces
 * the brittle `=== 'gpu'` string compare, which missed structured GPU provider
 * names like `'gpu-modal'` / `'gpu/preset-fallback'`, under-reporting GPU use.
 */
export function isGpuProvider(provider: string | undefined | null): boolean {
  if (!provider) return false;
  const p = provider.toLowerCase();
  return p === 'gpu' || p.startsWith('gpu-') || p.startsWith('gpu/') || p.startsWith('gpu:');
}

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

/** Feature flags snapshot — matches server/labs-settings.ts LabsFlags shape. */
export interface PipelineLabsFlags {
  peakEwma: boolean;
  speculativeTranslation: boolean;
  streamingOverlap: boolean;
  ewmaDecayFactor: number;
  speculationMinConfidence: number;
  overlapMinTokens: number;
}

/**
 * Routing snapshot — pre-computed by the server layer from runtime state
 * (deploy status, warmth checks, circuit breakers, provider chain config).
 * The orchestrator uses these booleans to decide which race candidates to build.
 */
export interface PipelineRouting {
  /** GPU endpoint URL, or undefined if GPU not available / behind cloud in chain. */
  gpuEndpoint?: string;
  /** Whether STT should include a GPU candidate. */
  sttOnGpu: boolean;
  /** Whether LLM should include a GPU candidate. */
  llmOnGpu: boolean;
  /** Whether TTS should prefer GPU. */
  ttsOnGpu: boolean;
  /** Modal babelcast URL for tier-2 fallback, or undefined. */
  modalBabelcastUrl?: string;
  /** Whether the deploy endpoint matches Modal babelcast (dedup guard). */
  deployEndpointIsModal: boolean;
  /** Cloud provider human-readable name for logging / race candidate naming. */
  cloudProviderName: string;
  /** Whether this is a voice-clone request (affects TTS routing). */
  isCloneRequest: boolean;
  /** GPU endpoint usable for clone TTS, or undefined. */
  cloneGpuEndpoint?: string;
  /** Whether the GPU TTS stage circuit breaker is closed (clone-specific). */
  gpuTtsCircuitClosed: boolean;
}

/**
 * Server-bound side-effect callbacks injected by the server layer.
 * Each is called at the appropriate point in the pipeline for bookkeeping,
 * broadcasting, metrics, etc. All are fire-and-forget (return void).
 */
export interface PipelineSideEffects {
  /** Called at pipeline start (touch request counters). */
  onPipelineStart(): void;
  /** Called when a clone request starts (touch Modal keepalive). */
  onCloneStart(): void;
  /** Pre-warm GPU/cloud connections. */
  preWarmConnections(gpuEndpoint: string | undefined): void;
  /** Broadcast subtitle early (before TTS finishes). */
  broadcastSubtitle(data: {
    transcription: string; translation: string;
    source: string; target: string;
    timing: { stt_ms: number; llm_ms: number };
  }): void;
  /** Broadcast dub audio to subscribed WebSocket clients. */
  broadcastDubAudio(target: string, data: {
    type: 'dub:audio'; target: string;
    audio: string; transcription: string; translation: string;
    timing: { stt_ms: number; llm_ms: number; tts_ms: number; total_ms: number };
  }, audioBuffer?: Buffer): void;
  /** Forward TTS audio to avatar. */
  forwardToAvatar(audioBase64: string): void;
  /** Log completed pipeline request. */
  logRequest(data: {
    timestamp: number; stage: 'pipeline'; provider: 'stream';
    latencyMs: number; success: boolean;
    inputSize: number; outputPreview: string;
  }): void;
  /** Stamp profile with latest request time. */
  stampProfile(): void;
  /** Record GPU TTS warmth / cold-start profile. */
  recordGpuTtsWarmth(ttsMs: number): void;
  /** Record per-stage latency (GPU). */
  recordPerStageLatency(stage: 'stt' | 'llm' | 'tts', latencyMs: number): void;
  /** Get active dub targets (excluding the primary target). */
  getOtherDubTargets(excludeTarget: string): string[];
  /** Fire-and-forget multi-language fanout. */
  runDubFanout(sttText: string, source: string, sttMs: number, sttProvider: string, opts: {
    speaker?: string; style?: string; targets: string[];
  }): void;
}

/**
 * Stage execution functions — the actual AI provider calls.
 * These are constructed by the server layer from its provider instances.
 */
export interface PipelineStageExecutors {
  /** Build STT race candidates for the given routing context. */
  buildSttCandidates(routing: PipelineRouting, audio: Buffer, source: string, sttPrompt: string,
    adaptiveTimeout: (stage: 'stt' | 'llm' | 'tts', baseMs: number) => number): RaceCandidate<GpuSTTResult>[];

  /** Build LLM race candidates for the given routing context. */
  buildLlmCandidates(routing: PipelineRouting, sttText: string, source: string, target: string,
    systemPrompt: string,
    adaptiveTimeout: (stage: 'stt' | 'llm' | 'tts', baseMs: number) => number): RaceCandidate<GpuLLMResult>[];

  /** Build TTS race candidates for the given routing context. */
  buildTtsCandidates(routing: PipelineRouting, translatedText: string, targetName: string,
    speaker: string, referenceAudio?: string, refText?: string,
    adaptiveTimeout?: (stage: 'stt' | 'llm' | 'tts', baseMs: number) => number): RaceCandidate<GpuTTSResult>[];

  /** Get the streaming LLM+TTS overlap function (for overlap mode). */
  getOverlapTtsFn(routing: PipelineRouting, targetName: string, speaker: string,
    referenceAudio?: string, refText?: string): (chunkText: string) => Promise<Buffer>;

  /** Get the streaming LLM iterator (for overlap mode). */
  createLlmStream(systemPrompt: string, sttText: string): AsyncIterable<string>;

  /** Whether streaming LLM is available (provider supports chatStream). */
  canStreamLlm(): boolean;

  /** Get translation cache. */
  getCachedTranslation(text: string, source: string, target: string, style: string): string | null;
  setCachedTranslation(text: string, source: string, target: string, translated: string, style: string): void;

  /** Get voice reference by refId. */
  getVoiceReference(refId: string): { audio: string; text: string } | null;

  /** Build system prompt. */
  buildSystemPrompt(sourceName: string, targetName: string, style: string): string;

  /** TTS fallback for clone failures. */
  ttsFallbackSynthesize(translatedText: string): Promise<{ audio: Buffer; contentType: string; provider: string }>;
}

/** All dependencies injected into the pipeline orchestrator. */
export interface PipelineDeps {
  routing: PipelineRouting;
  labs: PipelineLabsFlags;
  sideEffects: PipelineSideEffects;
  executors: PipelineStageExecutors;
  ewmaTracker: EWMATracker;
  speculativeCache: SpeculativeCache;
  streamingOverlap: StreamingOverlap;
  /** Language code → human name map (e.g. { fr: 'French', en: 'English' }). */
  langNames: Record<string, string>;
  /** Adaptive stage timeout calculator. */
  adaptiveStageTimeout: (stage: 'stt' | 'llm' | 'tts', baseMs: number) => number;
  /** Pipeline plugin registry for pre/post hooks. */
  plugins?: PipelinePluginRegistry;
}

// ── EWMA Race Options ────────────────────────────────────────────────────────

/**
 * Compute EWMA-aware race options for a set of candidates.
 * When peakEwma is enabled:
 *   - Adjusts timeouts based on EWMA: timeout = ewmaMs * 2.5 (generous but adaptive)
 *   - Gives the best (lowest EWMA) candidate a headstart so it wins ties
 * When disabled: returns { headstartMs: 0 } (no change to existing behavior).
 */
export function ewmaRaceOpts(
  candidates: RaceCandidate<unknown>[],
  stage: string,
  labs: PipelineLabsFlags,
  ewmaTracker: EWMATracker,
): { headstartMs: number } {
  if (!labs.peakEwma || candidates.length < 2) return { headstartMs: 0 };

  // Sync decay factor from settings
  ewmaTracker.setDecayFactor(labs.ewmaDecayFactor);

  const names = candidates.map(c => c.name);
  const best = ewmaTracker.pickBest(names);
  if (!best) return { headstartMs: 0 };

  // Adjust timeouts based on EWMA data
  for (const c of candidates) {
    const ewma = ewmaTracker.getLatency(c.name);
    if (ewma !== null && c.timeoutMs) {
      c.timeoutMs = Math.max(500, Math.min(c.timeoutMs, Math.ceil(ewma * 2.5)));
    }
  }

  // Sort candidates so the best (lowest EWMA) is first
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
    log.log(`Routing ${stage} to ${best} (ewma=${bestEntry.ewmaMs}ms) over ${secondEntry.provider} (ewma=${secondEntry.ewmaMs}ms)`);
  }

  return { headstartMs: 50 };
}

// ── Pipeline Orchestrator ────────────────────────────────────────────────────

/**
 * Run the streaming STT → LLM → TTS pipeline.
 *
 * This is the pure orchestration logic — all server-bound state and I/O
 * are injected via `deps`. The function:
 *
 * 1. Resolves voice cloning references
 * 2. Builds STT race candidates and races them
 * 3. Optionally triggers multi-language dub fan-out
 * 4. Builds LLM candidates (with speculative cache / streaming overlap)
 * 5. Builds TTS candidates and races them
 * 6. Assembles timing and calls completion callback
 */
export async function runPipelineOrchestrator(
  audio: Buffer,
  opts: PipelineOpts,
  cb: PipelineCallbacks,
  deps: PipelineDeps,
): Promise<void> {
  const { routing, labs, sideEffects: fx, executors: ex, ewmaTracker: ewma, langNames: langs } = deps;

  fx.onPipelineStart();
  const pipeT0 = Date.now();

  const source = opts.source || 'fr';
  const target = opts.target || 'en';
  const speaker = opts.speaker;
  const style = opts.style || 'default';
  const sttPrompt = opts.sttPrompt || '';

  const pluginCtx: PluginContext = {
    source,
    target,
    style,
    speaker,
    sessionId: opts.sessionId,
    requestId: opts.sessionId,
  };

  // Voice cloning: ref_id (cached) takes priority over inline reference_audio
  let referenceAudio = opts.referenceAudio;
  let refText = opts.refText;
  if (opts.refId) {
    const cached = ex.getVoiceReference(opts.refId);
    if (cached) {
      referenceAudio = cached.audio;
      refText = cached.text;
    }
  }

  const isCloneRequest = Boolean(referenceAudio && refText);
  if (isCloneRequest) fx.onCloneStart();

  const sourceName = langs[source] || source;
  const targetName = langs[target] || target;
  const systemPrompt = ex.buildSystemPrompt(sourceName, targetName, style);

  const audioDur = (audio.length / (16000 * 2)).toFixed(1);

  // Pre-warm connections
  fx.preWarmConnections(routing.gpuEndpoint || routing.cloneGpuEndpoint);

  log.log(`── Incoming: ${audioDur}s audio ${source}->${target} ──`);

  try {
    // ── Plugin: pre-pipeline ────────────────────────────────────────────────
    if (deps.plugins) await deps.plugins.runPrePipelineStart(pluginCtx);

    // ── Stage 1: STT ─────────────────────────────────────────────────────────
    cb.onStageStart('stt');
    const sttT0 = Date.now();

    // Plugin pre-STT hook
    let processedAudio = audio;
    if (deps.plugins) processedAudio = await deps.plugins.runPreSTT(audio, pluginCtx);

    const sttCandidates = ex.buildSttCandidates(routing, processedAudio, source, sttPrompt, deps.adaptiveStageTimeout);
    const sttEwmaOpts = ewmaRaceOpts(sttCandidates as RaceCandidate<unknown>[], 'STT', labs, ewma);
    const sttRaceResult = await raceProviders(sttCandidates, { logPrefix: '[stream-stt]', headstartMs: sttEwmaOpts.headstartMs });
    let sttResult = sttRaceResult.result;

    // Plugin post-STT hook
    if (deps.plugins) sttResult = await deps.plugins.runPostSTT(sttResult, pluginCtx);

    const sttText = sttResult.text;
    const sttProvider = sttRaceResult.provider;
    const sttMs = Date.now() - sttT0;

    // Record latency for EWMA tracking (always, even when flag is off)
    ewma.record(sttProvider, sttMs);

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
    const otherDubTargets = fx.getOtherDubTargets(target);
    if (otherDubTargets.length > 0) {
      fx.runDubFanout(sttText, source, sttMs, sttProvider, {
        speaker, style, targets: otherDubTargets,
      });
    }

    // ── Stage 2: LLM Translation ─────────────────────────────────────────────
    cb.onStageStart('llm');
    const llmT0 = Date.now();

    const cached = ex.getCachedTranslation(sttText, source, target, style);
    let translatedText = '';
    let llmProvider = '';
    let llmMs = 0;

    // TTS variables — declared here so both overlap and sequential paths can set them
    let audioB64 = '';
    let contentType = '';
    let ttsMs = 0;
    let ttsProvider = '';
    let ttfacMs = 0;
    let ttsHandled = false;

    if (cached !== null) {
      translatedText = cached;
      llmProvider = 'cache';
      llmMs = 0;
    } else {
      // ── Speculative translation check ──────────────────────────────────
      const sessionId = opts.sessionId;
      let speculationUsed = false;

      if (labs.speculativeTranslation && sessionId) {
        const specResult = await deps.speculativeCache.resolve(sessionId, sttText, labs.speculationMinConfidence);
        if (specResult) {
          translatedText = specResult;
          llmProvider = 'speculation';
          llmMs = Date.now() - llmT0;
          speculationUsed = true;
          ex.setCachedTranslation(sttText, source, target, translatedText, style);
        }
      }

      if (!speculationUsed) {
        // ── Check if streaming overlap is possible ──────────────────────────
        const canOverlap = labs.streamingOverlap
          && !routing.isCloneRequest
          && ex.canStreamLlm()
          && !routing.llmOnGpu;

        if (canOverlap) {
          // ── Streaming Overlap Path: LLM → TTS interleaved ─────────────
          ttsHandled = true;
          deps.streamingOverlap.setMinTokens(labs.overlapMinTokens);
          log.log('Using streaming overlap (LLM+TTS interleaved)');

          cb.onStageStart('tts');

          const llmStream = ex.createLlmStream(systemPrompt, sttText);
          const overlapTtsFn = ex.getOverlapTtsFn(routing, targetName, speaker || DEFAULT_SPEAKER, referenceAudio, refText);

          // Collect audio chunks in order for concatenation
          const orderedChunks: Map<number, Buffer> = new Map();
          let firstChunkSentAt: number | null = null;

          const overlapT0 = Date.now();
          translatedText = await deps.streamingOverlap.processWithOverlap(
            llmStream,
            overlapTtsFn,
            (chunkAudio, chunkIndex) => {
              orderedChunks.set(chunkIndex, chunkAudio);
              if (firstChunkSentAt === null) {
                firstChunkSentAt = Date.now();
                cb.onAudioChunk(chunkAudio, true);
              } else {
                cb.onAudioChunk(chunkAudio, false);
              }
            },
          );
          const overlapTotalMs = Date.now() - overlapT0;

          llmProvider = 'groq';
          llmMs = overlapTotalMs;
          ewma.record(llmProvider, llmMs);

          if (translatedText) ex.setCachedTranslation(sttText, source, target, translatedText, style);

          // Assemble results
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
          ttsProvider = routing.ttsOnGpu ? 'gpu' : routing.cloudProviderName;

          // Mark stages done
          cb.onStageDone('llm', { text: translatedText, latencyMs: llmMs, provider: llmProvider });

          // Early subtitle push
          if (translatedText.trim()) {
            fx.broadcastSubtitle({ transcription: sttText, translation: translatedText, source, target, timing: { stt_ms: sttMs, llm_ms: llmMs } });
          }

          // Broadcast dub:audio for website viewers
          if (audioB64) {
            fx.broadcastDubAudio(target, {
              type: 'dub:audio', target,
              audio: audioB64,
              transcription: sttText, translation: translatedText,
              timing: { stt_ms: sttMs, llm_ms: llmMs, tts_ms: ttsMs, total_ms: Date.now() - pipeT0 },
            }, combinedAudio.length > 0 ? combinedAudio : undefined);
          }

          cb.onStageDone('tts', { latencyMs: ttsMs, provider: ttsProvider });

        } else {
          // ── Sequential LLM ───────────────────────────────────────────────
          // Plugin pre-LLM hook
          let llmInput = sttText;
          if (deps.plugins) {
            const preResult = await deps.plugins.runPreLLM(sttText, pluginCtx);
            if (preResult.skip) {
              translatedText = sttText;
              llmProvider = 'plugin-skipped';
              llmMs = 0;
            } else {
              llmInput = preResult.text;
            }
          }

          if (llmProvider !== 'plugin-skipped') {
            const llmCandidates = ex.buildLlmCandidates(routing, llmInput, source, target, systemPrompt, deps.adaptiveStageTimeout);
            const llmEwmaOpts = ewmaRaceOpts(llmCandidates as RaceCandidate<unknown>[], 'LLM', labs, ewma);
            const llmRaceResult = await raceProviders(llmCandidates, { logPrefix: '[stream-llm]', headstartMs: llmEwmaOpts.headstartMs });
            let llmResult = llmRaceResult.result;

            // Plugin post-LLM hook
            if (deps.plugins) llmResult = await deps.plugins.runPostLLM(llmResult, pluginCtx);

            translatedText = llmResult.translated_text;
            llmProvider = llmRaceResult.provider;
            llmMs = Date.now() - llmT0;

            ewma.record(llmProvider, llmMs);

            if (translatedText) ex.setCachedTranslation(sttText, source, target, translatedText, style);
          }
        }
      }
    }

    // ── LLM done callback (for non-overlap paths) ────────────────────────────
    if (!ttsHandled) {
      cb.onStageDone('llm', { text: translatedText, latencyMs: llmMs, provider: llmProvider });

      // Early subtitle push
      if (translatedText.trim()) {
        fx.broadcastSubtitle({ transcription: sttText, translation: translatedText, source, target, timing: { stt_ms: sttMs, llm_ms: llmMs } });
      }
    }

    // ── Stage 3: TTS (Sequential — skipped when overlap already handled it) ──
    if (!ttsHandled) {
      cb.onStageStart('tts');
      const seqTtsT0 = Date.now();

      if (translatedText.trim()) {
        // Plugin pre-TTS hook
        let ttsInput = translatedText;
        let ttsSkipped = false;
        if (deps.plugins) {
          const preResult = await deps.plugins.runPreTTS(translatedText, pluginCtx);
          if (preResult.skip) {
            ttsSkipped = true;
          } else {
            ttsInput = preResult.text;
          }
        }

        const ttsCandidates = ttsSkipped
          ? []
          : ex.buildTtsCandidates(routing, ttsInput, targetName, speaker || DEFAULT_SPEAKER, referenceAudio, refText, deps.adaptiveStageTimeout);

        try {
          let audioBuffer = Buffer.alloc(0);
          if (!ttsSkipped) {
            const ttsEwmaOpts = ewmaRaceOpts(ttsCandidates as RaceCandidate<unknown>[], 'TTS', labs, ewma);
            const ttsRaceResult = await raceProviders(ttsCandidates, { logPrefix: '[stream-tts]', headstartMs: ttsEwmaOpts.headstartMs });
            let ttsResult = ttsRaceResult.result;

            // Plugin post-TTS hook
            if (deps.plugins) ttsResult = await deps.plugins.runPostTTS(ttsResult, pluginCtx);

            audioBuffer = Buffer.from(ttsResult.audio);
            contentType = ttsResult.contentType;
            ttsProvider = ttsRaceResult.provider;
          } else {
            ttsProvider = 'plugin-skipped';
          }
          ttsMs = Date.now() - seqTtsT0;
          ttfacMs = ttsMs;
          audioB64 = audioBuffer.toString('base64');

          ewma.record(ttsProvider, ttsMs);

          // Send audio as a single chunk
          cb.onAudioChunk(audioBuffer, true);

          // Broadcast dub:audio for website viewers subscribed to this target
          fx.broadcastDubAudio(target, {
            type: 'dub:audio', target,
            audio: audioB64,
            transcription: sttText, translation: translatedText,
            timing: { stt_ms: sttMs, llm_ms: llmMs, tts_ms: ttsMs, total_ms: Date.now() - pipeT0 },
          }, audioBuffer);

          // Track GPU TTS warmth
          if (ttsProvider === 'gpu' && ttsMs > 0) {
            fx.recordPerStageLatency('tts', ttsMs);
            fx.recordGpuTtsWarmth(ttsMs);
          }
        } catch (ttsErr) {
          // TTS failure — try fallback for clone, else just continue without audio
          if (routing.isCloneRequest) {
            try {
              const fallbackT0 = Date.now();
              const r = await ex.ttsFallbackSynthesize(translatedText);
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

    if (audioB64) fx.forwardToAvatar(audioB64);

    const totalMs = Date.now() - pipeT0;
    const usedAnyGpu = isGpuProvider(sttProvider) || isGpuProvider(llmProvider) || isGpuProvider(ttsProvider);

    fx.logRequest({ timestamp: Date.now(), stage: 'pipeline', provider: 'stream', latencyMs: totalMs, success: true, inputSize: audio.length, outputPreview: (translatedText || '').slice(0, 80) });
    fx.stampProfile();

    log.log(`── Done: ${totalMs}ms (STT=${sttMs}[${sttProvider}] LLM=${llmMs}[${llmProvider}] TTS=${ttsMs}[${ttsProvider || '-'}]) ──`);

    // Plugin post-pipeline hook
    if (deps.plugins) {
      await deps.plugins.runPostPipelineEnd(pluginCtx, { transcription: sttText, translation: translatedText });
    }

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
    log.error(`Error: ${error.message}`);
    cb.onError('pipeline', error);
  }
}
