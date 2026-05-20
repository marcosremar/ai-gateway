/**
 * MuteController — gates user audio input based on bot speaking state.
 *
 * Strategies (matching pipecat's user-mute):
 *   - 'always_mute_during_bot_speech' — hard block: any user_speech_start
 *     while bot is talking is dropped. Best for speakers (no headphones)
 *     to prevent feedback loops.
 *   - 'mute_until_first_word' — mute when bot starts; unmute on first
 *     bot_speech_end OR after `unmuteAfterMs`. Useful when bot greets +
 *     hands turn back.
 *   - 'never' — pass-through, no muting.
 *
 * Usage (server-side):
 *   const mute = new MuteController({ strategy: 'always_mute_during_bot_speech' });
 *   attachObserver(mute);
 *   // before processing user audio: if (mute.shouldDropUserAudio()) return;
 *
 * The controller subscribes via the observer pattern AND exposes a sync
 * `shouldDropUserAudio()` so callers can decide per-chunk without await.
 */

import { BaseObserver, type PipelineFrame } from './base';

export type MuteStrategy = 'always_mute_during_bot_speech' | 'mute_until_first_word' | 'never';

export interface MuteControllerOptions {
  strategy?: MuteStrategy;
  /** For 'mute_until_first_word', auto-unmute after N ms even if no bot_speech_end. */
  unmuteAfterMs?: number;
  /** Called whenever the muted state flips. */
  onMuteChange?: (muted: boolean) => void;
}

export class MuteController extends BaseObserver {
  readonly name = 'mute-controller';
  private muted = false;
  private autoUnmuteTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly strategy: MuteStrategy;
  private readonly unmuteAfterMs: number;
  private readonly onMuteChange?: (muted: boolean) => void;

  constructor(opts: MuteControllerOptions = {}) {
    super();
    this.strategy = opts.strategy ?? 'always_mute_during_bot_speech';
    this.unmuteAfterMs = opts.unmuteAfterMs ?? 30_000;
    this.onMuteChange = opts.onMuteChange;
  }

  /** Should the caller drop the next chunk of user audio? */
  shouldDropUserAudio(): boolean {
    return this.strategy !== 'never' && this.muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  private setMuted(v: boolean): void {
    if (this.muted === v) return;
    this.muted = v;
    try { this.onMuteChange?.(v); } catch { /* observer must not throw */ }
  }

  private clearAutoUnmute(): void {
    if (this.autoUnmuteTimer) {
      clearTimeout(this.autoUnmuteTimer);
      this.autoUnmuteTimer = null;
    }
  }

  onFrame(frame: PipelineFrame): void {
    if (this.strategy === 'never') return;

    if (frame.kind === 'tts_first_audio' || frame.kind === 'bot_speech_start') {
      this.setMuted(true);
      this.clearAutoUnmute();
      if (this.strategy === 'mute_until_first_word') {
        this.autoUnmuteTimer = setTimeout(() => {
          this.autoUnmuteTimer = null;
          this.setMuted(false);
        }, this.unmuteAfterMs);
      }
      return;
    }

    if (frame.kind === 'tts_complete' || frame.kind === 'bot_speech_end') {
      this.clearAutoUnmute();
      this.setMuted(false);
      return;
    }

    // For 'always_mute_during_bot_speech', a user_speech_start during muted
    // window does NOT unmute — caller drops the audio at source.
    // For 'mute_until_first_word', user_speech_start unmutes immediately
    // (gives turn back to user).
    if (frame.kind === 'user_speech_start' && this.strategy === 'mute_until_first_word' && this.muted) {
      this.clearAutoUnmute();
      this.setMuted(false);
    }
  }

  dispose(): void {
    this.clearAutoUnmute();
  }
}
