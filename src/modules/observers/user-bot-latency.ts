/**
 * UserBotLatencyObserver — turn-around latency from user speech START
 * (NOT stop), with per-stage breakdown.
 *
 * Why this is different from the existing latency ring buffer:
 *   - Ring buffer measures /v1/translate or /v1/speech HTTP call duration
 *     (server-side request span).
 *   - This observer measures end-to-end UX latency: from the moment the
 *     user started speaking to the moment the bot responds. Subtracts VAD
 *     stop-secs so users see "real" perceived latency.
 *
 * Emits two callback shapes:
 *   - onLatencyMeasured(ms)        — single number per turn
 *   - onLatencyBreakdown(detail)   — per-stage breakdown for ops dashboards
 */

import { BaseObserver, type PipelineFrame } from './base';

export interface LatencyBreakdown {
  /** End-to-end: user speech start → first bot audio. */
  totalMs: number;
  /** STT TTFB (first partial after user_speech_start). */
  sttTtfbMs: number | null;
  /** STT final time (final transcript - speech_start). */
  sttFinalMs: number | null;
  /** LLM TTFT (llm_first_token - stt_final). */
  llmTtftMs: number | null;
  /** LLM complete. */
  llmCompleteMs: number | null;
  /** TTS TTFA (first audio bytes - llm_first_token). */
  ttsTtfaMs: number | null;
  /** Provider chain. */
  providers: { stt?: string; llm?: string; tts?: string };
}

export interface LatencyMeasurement {
  totalMs: number;
  ts: number;
}

export interface UserBotLatencyObserverOptions {
  onLatencyMeasured?: (m: LatencyMeasurement) => void;
  onLatencyBreakdown?: (b: LatencyBreakdown) => void;
  /** Window of frames retained per turn (cap memory). */
  maxFramesPerTurn?: number;
}

export class UserBotLatencyObserver extends BaseObserver {
  readonly name = 'user-bot-latency';
  private currentTurn: PipelineFrame[] = [];
  private readonly opts: UserBotLatencyObserverOptions;

  constructor(opts: UserBotLatencyObserverOptions = {}) {
    super();
    this.opts = opts;
  }

  onFrame(frame: PipelineFrame): void {
    // user_speech_start opens a new turn (closes any pending one — interrupt).
    if (frame.kind === 'user_speech_start') {
      this.currentTurn = [frame];
      return;
    }
    if (this.currentTurn.length === 0) return;

    const cap = this.opts.maxFramesPerTurn ?? 200;
    if (this.currentTurn.length < cap) this.currentTurn.push(frame);

    if (frame.kind === 'tts_first_audio' || frame.kind === 'bot_speech_start') {
      this._emit();
    }
  }

  private _emit(): void {
    const frames = this.currentTurn;
    this.currentTurn = [];

    const speechStart = frames.find(f => f.kind === 'user_speech_start');
    if (!speechStart) return;

    const find = (k: PipelineFrame['kind']) => frames.find(f => f.kind === k);
    const sttPartial = find('stt_partial');
    const sttFinal = find('stt_final');
    const llmReq = find('llm_request');
    const llmFirst = find('llm_first_token');
    const llmDone = find('llm_complete');
    const ttsFirst = find('tts_first_audio');
    const botStart = find('bot_speech_start');
    const endFrame = ttsFirst ?? botStart;
    if (!endFrame) return;

    const totalMs = endFrame.ts - speechStart.ts;
    const breakdown: LatencyBreakdown = {
      totalMs,
      sttTtfbMs: sttPartial ? sttPartial.ts - speechStart.ts : null,
      sttFinalMs: sttFinal ? sttFinal.ts - speechStart.ts : null,
      llmTtftMs: llmFirst && (sttFinal ?? llmReq)
        ? llmFirst.ts - (sttFinal ?? llmReq)!.ts
        : null,
      llmCompleteMs: llmDone && llmFirst ? llmDone.ts - llmFirst.ts : null,
      ttsTtfaMs: ttsFirst && llmFirst ? ttsFirst.ts - llmFirst.ts : null,
      providers: {
        stt: sttFinal?.provider ?? sttPartial?.provider,
        llm: llmFirst?.provider ?? llmReq?.provider,
        tts: ttsFirst?.provider,
      },
    };

    try { this.opts.onLatencyMeasured?.({ totalMs, ts: endFrame.ts }); } catch { /* observer must not throw */ }
    try { this.opts.onLatencyBreakdown?.(breakdown); } catch { /* observer must not throw */ }
  }
}
