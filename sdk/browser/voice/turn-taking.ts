/**
 * From Silero effects to speaking turns: when the clip starts and stops, when the learner's voice is announced, and
 * when the turn closes. No audio API here (clip, track and WAV conversion are injected), so it runs in tests.
 *
 * - Effects are ignored while the caller does not listen and for `echoTailMs` after listening opens (the tail of the
 *   page's own voice in the room).
 * - `rmsOnset` starts recording (the first syllable is weak: recording before Silero confirms keeps it); `rmsRejected`
 *   drops it unless the turn is already voiced.
 * - The first `vadStart` of a turn calls `onVoice` and arms the `maxSpeechMs` cap; a later `vadStart` cancels a pending
 *   end. `vadEnd` closes the turn after `turnEndAfterVadEndMs(endSilenceMs)`, so the pause from the last voiced frame
 *   equals the consumer's `endSilenceMs`.
 *
 * `endSilenceMs`, `maxSpeechMs` and `echoTailMs` are the consumer's numbers (parle: `turnListenFor(level)` from its
 * curriculum Lua); the SDK has no defaults for them.
 */
import type { TurnClip } from './turn-clip';
import { turnEndAfterVadEndMs, type VadEffect, type VoiceActivityTuning } from './voice-activity';

export interface TurnTakingOptions {
  clip: Pick<TurnClip, 'running' | 'start' | 'finish' | 'cancel'>;
  /** The microphone track the clip records from (it changes when the microphone is switched). */
  track: () => MediaStreamTrack;
  toWav: (clip: Blob) => Promise<Blob | null>;
  endSilenceMs: number;
  maxSpeechMs: number;
  echoTailMs: number;
  tuning?: VoiceActivityTuning;
  onVoice: () => void;
  onTurn: (wav: Blob) => void;
  now?: () => number;
}

export interface TurnTaking {
  onEffect(effect: VadEffect): void;
  /** The polled listening gate; `true` when listening just opened (the caller restarts its VAD then). */
  setListening(may: boolean): boolean;
  /** Drops the turn in progress (no `onTurn`). */
  drop(): void;
}

export function createTurnTaking(opts: TurnTakingOptions): TurnTaking {
  const now = opts.now ?? (() => performance.now());
  const endAfterVadEndMs = turnEndAfterVadEndMs(opts.endSilenceMs, opts.tuning);
  const clip = opts.clip;
  let listening = false;
  let listenSince = 0;
  let voiced = false;
  let turnEnd: ReturnType<typeof setTimeout> | null = null;
  let turnCap: ReturnType<typeof setTimeout> | null = null;

  const clearTurnEnd = () => { if (turnEnd) clearTimeout(turnEnd); turnEnd = null; };
  const clearTurnCap = () => { if (turnCap) clearTimeout(turnCap); turnCap = null; };

  const drop = () => {
    clearTurnEnd();
    clearTurnCap();
    clip.cancel();
    voiced = false;
  };

  const finishTurn = async () => {
    clearTurnEnd();
    clearTurnCap();
    if (!voiced) return;
    voiced = false;
    const recorded = await clip.finish();
    const wav = recorded && await opts.toWav(recorded);
    if (wav) opts.onTurn(wav);
  };

  return {
    onEffect(effect) {
      if (!listening || now() - listenSince < opts.echoTailMs) return;
      const at = now();
      if (effect.kind === 'rmsOnset' && !clip.running()) clip.start(opts.track(), at);
      if (effect.kind === 'rmsRejected' && !voiced) clip.cancel();
      if (effect.kind === 'vadStart') {
        clearTurnEnd();
        if (!clip.running()) clip.start(opts.track(), at);
        if (!voiced) {
          opts.onVoice();
          turnCap = setTimeout(() => void finishTurn(), opts.maxSpeechMs);
        }
        voiced = true;
      }
      if (effect.kind === 'vadEnd' && voiced) turnEnd = setTimeout(() => void finishTurn(), endAfterVadEndMs);
    },
    setListening(may) {
      const opened = may && !listening;
      if (opened) listenSince = now();
      if (!may && listening) drop();
      listening = may;
      return opened;
    },
    drop,
  };
}
