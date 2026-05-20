/**
 * TurnTrackingObserver — emits explicit turn lifecycle events with
 * stable turn ids. Useful for analytics, transcripts, and per-turn
 * cost attribution.
 *
 * Events derived from the frame stream:
 *   - on_user_turn_started   — first user_speech_start observed (or after
 *                              a bot turn ended)
 *   - on_user_turn_ended     — stt_final OR user_speech_end (whichever first)
 *   - on_bot_turn_started    — llm_first_token OR tts_first_audio (whichever first)
 *   - on_bot_turn_ended      — tts_complete OR bot_speech_end OR next user_speech_start
 *
 * Turn IDs are monotonically increasing integers, starting at 1.
 */

import { BaseObserver, type PipelineFrame } from './base';

export interface TurnEvent {
  turnId: number;
  ts: number;
  /** Optional metadata copied from the triggering frame. */
  provider?: string;
}

export interface TurnTrackingHandlers {
  onUserTurnStarted?: (e: TurnEvent) => void;
  onUserTurnEnded?: (e: TurnEvent & { transcript?: string }) => void;
  onBotTurnStarted?: (e: TurnEvent) => void;
  onBotTurnEnded?: (e: TurnEvent & { audioBytes?: number }) => void;
}

export class TurnTrackingObserver extends BaseObserver {
  readonly name = 'turn-tracking';
  private currentTurnId = 0;
  private inUserTurn = false;
  private inBotTurn = false;
  private lastTranscript: string | null = null;
  private lastAudioBytes = 0;

  constructor(private readonly handlers: TurnTrackingHandlers = {}) {
    super();
  }

  onFrame(frame: PipelineFrame): void {
    const fire = <T extends keyof TurnTrackingHandlers>(name: T, payload: Parameters<NonNullable<TurnTrackingHandlers[T]>>[0]) => {
      const fn = this.handlers[name] as ((p: typeof payload) => void) | undefined;
      try { fn?.(payload); } catch { /* observer must not throw */ }
    };

    if (frame.kind === 'user_speech_start') {
      // If a bot turn was open, close it before opening user turn.
      if (this.inBotTurn) {
        this.inBotTurn = false;
        fire('onBotTurnEnded', { turnId: this.currentTurnId, ts: frame.ts, audioBytes: this.lastAudioBytes });
        this.lastAudioBytes = 0;
      }
      // New turn id increments on every new user speech start.
      this.currentTurnId += 1;
      this.inUserTurn = true;
      this.lastTranscript = null;
      fire('onUserTurnStarted', { turnId: this.currentTurnId, ts: frame.ts, provider: frame.provider });
      return;
    }

    if (frame.kind === 'stt_final') {
      const text = typeof frame.meta?.text === 'string' ? (frame.meta.text as string) : undefined;
      if (text !== undefined) this.lastTranscript = text;
      if (this.inUserTurn) {
        this.inUserTurn = false;
        fire('onUserTurnEnded', { turnId: this.currentTurnId, ts: frame.ts, provider: frame.provider, transcript: this.lastTranscript ?? undefined });
      }
      return;
    }

    if (frame.kind === 'user_speech_end' && this.inUserTurn) {
      this.inUserTurn = false;
      fire('onUserTurnEnded', { turnId: this.currentTurnId, ts: frame.ts, provider: frame.provider, transcript: this.lastTranscript ?? undefined });
      return;
    }

    if ((frame.kind === 'llm_first_token' || frame.kind === 'tts_first_audio') && !this.inBotTurn) {
      this.inBotTurn = true;
      fire('onBotTurnStarted', { turnId: this.currentTurnId, ts: frame.ts, provider: frame.provider });
      // fall through — tts_first_audio also captures audio bytes below
    }

    if (frame.kind === 'tts_first_audio' && typeof frame.meta?.bytes === 'number') {
      this.lastAudioBytes = frame.meta.bytes as number;
    }

    if ((frame.kind === 'tts_complete' || frame.kind === 'bot_speech_end') && this.inBotTurn) {
      this.inBotTurn = false;
      fire('onBotTurnEnded', { turnId: this.currentTurnId, ts: frame.ts, provider: frame.provider, audioBytes: this.lastAudioBytes });
      this.lastAudioBytes = 0;
    }
  }
}
