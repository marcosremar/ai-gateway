/**
 * Client VAD (`@parle/ai-gateway/voice` effects) → session control, pure and clock-injected:
 *
 * - barge-in: Silero confirms the learner's voice (`vadStart`) while the NPC is speaking → `interrupt`;
 * - realtime rungs: `vadEnd` + the rest of the consumer's `endSilenceMs` (`turnEndAfterVadEndMs`) → `end_turn`
 *   (the edge need not wait for its own silence timer); a new `vadStart` before that cancels it;
 * - clip rungs: effects go to the voice SDK's turn-taking, which records the clip and hands over one WAV per turn.
 */
import type { VadEffect } from '../voice/voice-activity';

export interface VoiceBridgeOptions {
  endAfterVadEndMs: number;
  npcSpeaking(): boolean;
  clipMode(): boolean;
  onInterrupt(): void;
  /** Realtime rungs: the learner finished speaking (`speechMs` = from the first `vadStart` of the turn). */
  onEndTurn(speechMs: number): void;
  onClipEffect?(effect: VadEffect): void;
  /** One voiced segment (`vadStart` → `vadEnd`), for telemetry (`vad.segment`). */
  onSegment?(durMs: number): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface VoiceBridge {
  onEffect(effect: VadEffect): void;
  /** Drops a pending end of turn (session closing, transport switch). */
  reset(): void;
  speaking(): boolean;
}

export function createVoiceBridge(opts: VoiceBridgeOptions): VoiceBridge {
  const now = opts.now ?? (() => performance.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let pending: unknown = null;
  let turnStart: number | null = null;
  let segmentStart: number | null = null;

  const cancel = () => { if (pending !== null) clearTimer(pending); pending = null; };

  return {
    onEffect(effect) {
      if (effect.kind === 'vadStart') {
        segmentStart = now();
        if (opts.npcSpeaking()) opts.onInterrupt();
        if (!opts.clipMode()) {
          cancel();
          if (turnStart === null) turnStart = segmentStart;
        }
      }
      if (effect.kind === 'vadEnd' && segmentStart !== null) {
        opts.onSegment?.(now() - segmentStart);
        segmentStart = null;
        if (!opts.clipMode() && turnStart !== null) {
          cancel();
          pending = setTimer(() => {
            pending = null;
            const speech = now() - (turnStart ?? now());
            turnStart = null;
            opts.onEndTurn(speech);
          }, opts.endAfterVadEndMs);
        }
      }
      if (opts.clipMode()) opts.onClipEffect?.(effect);
    },
    reset() {
      cancel();
      turnStart = null;
      segmentStart = null;
    },
    speaking: () => turnStart !== null,
  };
}
