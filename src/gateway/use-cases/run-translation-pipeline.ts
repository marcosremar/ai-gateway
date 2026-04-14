/**
 * RunTranslationPipeline — use case: STT → LLM → TTS for a single turn.
 *
 * Clean Architecture use case: orchestrates capability ports. Pure domain flow
 * with zero transport knowledge (no WebSocket, no HTTP, no EWMA/race here —
 * those are adapter/infra concerns).
 *
 * Flow:
 *   1. Transcribe audio (SttPort)
 *   2. Translate text (LlmPort)
 *   3. Synthesize output audio (TtsPort)
 *   4. Emit events at each stage
 */

import type { SttPort, Transcription } from '../ports/stt-port';
import type { LlmPort, Translation } from '../ports/llm-port';
import type { TtsPort, SynthesizedAudio } from '../ports/tts-port';
import type { EventPublisher } from '../ports/event-publisher';

export interface RunTranslationPipelineInput {
  audio: Buffer;
  sourceLang: string;
  targetLang: string;
  voice: string;
  /** Optional voice cloning reference. */
  voiceClone?: {
    referenceAudio: Buffer;
    referenceTranscript: string;
  };
  /** Correlation ID for tracing/logging. */
  sessionId?: string;
}

export interface RunTranslationPipelineOutput {
  transcription: Transcription;
  translation: Translation;
  synthesized: SynthesizedAudio;
  totalLatencyMs: number;
  stageLatencies: { stt: number; llm: number; tts: number };
}

export interface RunTranslationPipelineDeps {
  stt: SttPort;
  llm: LlmPort;
  tts: TtsPort;
  events: EventPublisher;
}

export class RunTranslationPipeline {
  constructor(private readonly deps: RunTranslationPipelineDeps) {}

  async execute(input: RunTranslationPipelineInput): Promise<RunTranslationPipelineOutput> {
    const startedAt = Date.now();
    const sessionId = input.sessionId ?? '';

    // 1. STT
    this.deps.events.publish({
      type: 'pipeline.stage.started',
      timestamp: Date.now(),
      payload: { sessionId, stage: 'stt' },
    });
    const transcription = await this.deps.stt.transcribe({
      audio: input.audio,
      language: input.sourceLang,
    });
    this.deps.events.publish({
      type: 'pipeline.stage.completed',
      timestamp: Date.now(),
      payload: {
        sessionId,
        stage: 'stt',
        latencyMs: transcription.latencyMs,
        model: transcription.model,
      },
    });

    // 2. LLM
    this.deps.events.publish({
      type: 'pipeline.stage.started',
      timestamp: Date.now(),
      payload: { sessionId, stage: 'llm' },
    });
    const translation = await this.deps.llm.translate({
      text: transcription.text,
      from: transcription.language ?? input.sourceLang,
      to: input.targetLang,
    });
    this.deps.events.publish({
      type: 'pipeline.stage.completed',
      timestamp: Date.now(),
      payload: {
        sessionId,
        stage: 'llm',
        latencyMs: translation.latencyMs,
        model: translation.model,
      },
    });

    // 3. TTS
    this.deps.events.publish({
      type: 'pipeline.stage.started',
      timestamp: Date.now(),
      payload: { sessionId, stage: 'tts' },
    });
    const synthesized = await this.deps.tts.synthesize({
      text: translation.text,
      voice: input.voice,
      language: input.targetLang,
      clone: input.voiceClone,
    });
    this.deps.events.publish({
      type: 'pipeline.stage.completed',
      timestamp: Date.now(),
      payload: {
        sessionId,
        stage: 'tts',
        latencyMs: synthesized.latencyMs,
        model: synthesized.model,
      },
    });

    const totalLatencyMs = Date.now() - startedAt;
    this.deps.events.publish({
      type: 'pipeline.completed',
      timestamp: Date.now(),
      payload: {
        sessionId,
        totalLatencyMs,
        stages: {
          stt: transcription.latencyMs,
          llm: translation.latencyMs,
          tts: synthesized.latencyMs,
        },
      },
    });

    return {
      transcription,
      translation,
      synthesized,
      totalLatencyMs,
      stageLatencies: {
        stt: transcription.latencyMs,
        llm: translation.latencyMs,
        tts: synthesized.latencyMs,
      },
    };
  }
}
