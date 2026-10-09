/**
 * Speech detection reducer: RMS arms, Silero confirms, Silero's low run ends the utterance.
 *
 * Pure and frame-driven (one call per 32 ms frame of 16 kHz audio); no clock, no audio API. The browser wiring lives
 * in `silero-listener.ts` / `speech-detector.ts`, the game wiring in the consumer.
 *
 *   silent ──(rms ≥ rmsOnset for rmsOnsetFrames)──▶ armed ──(p ≥ vadStart)──▶ speech
 *     ▲                                              │                         │
 *     └──(armedTimeoutFrames without p ≥ vadStart)───┘◀──(vadEndFrames of p < vadEnd)
 *
 * While `silent` the classifier never runs (energy gate): Silero only scores frames after the RMS gate opened.
 */

export type VoiceStage = 'silent' | 'armed' | 'speech';

export interface VoiceActivityTuning {
  /** Frame RMS (linear, full scale = 1) that counts as "loud" while silent. */
  rmsOnset: number;
  /** Consecutive loud frames that arm the classifier. */
  rmsOnsetFrames: number;
  /** Silero probability that opens speech. */
  vadStart: number;
  /** Silero probability under which a frame counts toward the end of speech. */
  vadEnd: number;
  /** Consecutive frames under `vadEnd` that close speech (`vadEnd` effect). */
  vadEndFrames: number;
  /** Frames the classifier stays armed without speech before falling back to silent. */
  armedTimeoutFrames: number;
  /** Loud frames ignored after a rejected arming (noisy room: do not re-arm on every frame). */
  rejectCooldownFrames: number;
  pauseFrames?: number;
}

/** One Silero v5 frame: 512 samples at 16 kHz. */
export const VOICE_FRAME_MS = 32;

/**
 * Default tuning (moved unchanged from parle `core/voice/voice-activity.ts`, 06/10/2026).
 *
 * - `vadStart` 0.5 / `vadEnd` 0.35: Silero's own defaults, `threshold = 0.5` and `neg_threshold = threshold - 0.15`
 *   in `get_speech_timestamps` (Silero Team 2021, "Silero VAD: pre-trained enterprise-grade Voice Activity Detector",
 *   github.com/snakers4/silero-vad, no DOI). Hysteresis keeps a word's soft tail from splitting the utterance.
 * - `vadEndFrames` 10 (320 ms), `rmsOnset` 0.02 (≈ −34 dBFS) × 2 frames, `armedTimeoutFrames` 25 (800 ms),
 *   `rejectCooldownFrames` 94 (≈ 3 s): design choices of the parle study, with no published source in the original
 *   code (declared design choice to pilot, parle rule 28). The energy gate spares the classifier on silence and keeps
 *   a noisy room from re-arming it every frame. The end-of-turn pause is NOT here: the consumer passes its own
 *   `endSilenceMs` and the detector waits the rest after `vadEnd` (`turnEndAfterVadEndMs`).
 */
export const VOICE_ACTIVITY_TUNING: VoiceActivityTuning = {
  rmsOnset: 0.02,
  rmsOnsetFrames: 2,
  vadStart: 0.5,
  vadEnd: 0.35,
  vadEndFrames: 10,
  armedTimeoutFrames: 25,
  rejectCooldownFrames: 94,
};

export interface VoiceActivityState {
  stage: VoiceStage;
  frame: number;
  loudFrames: number;
  armedFrames: number;
  lowFrames: number;
  cooldownFrames: number;
  spokeSinceArmed: boolean;
  speechStartFrame: number;
  peakProbability: number;
}

export type VoiceActivityEffect =
  | { kind: 'resetVad' }
  | { kind: 'rmsOnset'; frame: number; rms: number }
  | { kind: 'vadStart'; frame: number; probability: number; afterRmsFrames: number }
  | { kind: 'vadEnd'; frame: number; speechFrames: number; peakProbability: number }
  | { kind: 'vadPause'; frame: number }
  | { kind: 'vadResume'; frame: number }
  | { kind: 'rmsRejected'; frame: number; armedFrames: number; peakProbability: number };

/** Every effect but the internal classifier reset: what a listener reports to its caller. */
export type VadEffect = Exclude<VoiceActivityEffect, { kind: 'resetVad' }>;

export interface VoiceFrameInput {
  rms: number;
  probability: number | null;
}

export function initialVoiceActivity(): VoiceActivityState {
  return {
    stage: 'silent',
    frame: -1,
    loudFrames: 0,
    armedFrames: 0,
    lowFrames: 0,
    cooldownFrames: 0,
    spokeSinceArmed: false,
    speechStartFrame: 0,
    peakProbability: 0,
  };
}

export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

/**
 * Wait after Silero's `vadEnd` before the turn closes, so that the whole pause from the last voiced frame equals the
 * consumer's `endSilenceMs` (the `vadEndFrames` low frames already elapsed). Never negative.
 */
export function turnEndAfterVadEndMs(endSilenceMs: number, tuning: VoiceActivityTuning = VOICE_ACTIVITY_TUNING): number {
  return Math.max(0, endSilenceMs - tuning.vadEndFrames * VOICE_FRAME_MS);
}

function stepSilent(state: VoiceActivityState, rms: number, tuning: VoiceActivityTuning) {
  const loud = rms >= tuning.rmsOnset;
  if (!loud) return { state: { ...state, loudFrames: 0, cooldownFrames: 0 }, effects: [] };
  if (state.cooldownFrames > 0) return { state: { ...state, cooldownFrames: state.cooldownFrames - 1 }, effects: [] };
  const loudFrames = state.loudFrames + 1;
  if (loudFrames < tuning.rmsOnsetFrames) return { state: { ...state, loudFrames }, effects: [] };
  return {
    state: { ...state, stage: 'armed' as const, loudFrames: 0, armedFrames: 0, spokeSinceArmed: false, peakProbability: 0 },
    effects: [{ kind: 'resetVad' as const }, { kind: 'rmsOnset' as const, frame: state.frame, rms }],
  };
}

function stepArmed(state: VoiceActivityState, probability: number, tuning: VoiceActivityTuning) {
  const peakProbability = Math.max(state.peakProbability, probability);
  if (probability >= tuning.vadStart) {
    return {
      state: { ...state, stage: 'speech' as const, lowFrames: 0, speechStartFrame: state.frame, spokeSinceArmed: true, peakProbability: probability },
      effects: [{ kind: 'vadStart' as const, frame: state.frame, probability, afterRmsFrames: state.armedFrames }],
    };
  }
  const armedFrames = state.armedFrames + 1;
  if (armedFrames < tuning.armedTimeoutFrames) return { state: { ...state, armedFrames, peakProbability }, effects: [] };
  const silent = { ...state, stage: 'silent' as const, armedFrames: 0, loudFrames: 0, peakProbability: 0 };
  if (state.spokeSinceArmed) return { state: silent, effects: [] };
  return {
    state: { ...silent, cooldownFrames: tuning.rejectCooldownFrames },
    effects: [{ kind: 'rmsRejected' as const, frame: state.frame, armedFrames, peakProbability }],
  };
}

function stepSpeech(state: VoiceActivityState, probability: number, tuning: VoiceActivityTuning) {
  const peakProbability = Math.max(state.peakProbability, probability);
  const lowFrames = probability < tuning.vadEnd ? state.lowFrames + 1 : 0;
  if (lowFrames < tuning.vadEndFrames) {
    const pause = tuning.pauseFrames;
    const kind = !pause ? null : lowFrames === pause ? 'vadPause' as const : lowFrames === 0 && state.lowFrames >= pause ? 'vadResume' as const : null;
    return { state: { ...state, lowFrames, peakProbability }, effects: kind ? [{ kind, frame: state.frame }] : [] };
  }
  return {
    state: { ...state, stage: 'armed' as const, lowFrames: 0, armedFrames: 0, peakProbability: 0 },
    effects: [{
      kind: 'vadEnd' as const,
      frame: state.frame,
      speechFrames: state.frame - state.speechStartFrame - lowFrames + 1,
      peakProbability,
    }],
  };
}

export function stepVoiceActivity(
  previous: VoiceActivityState,
  input: VoiceFrameInput,
  tuning: VoiceActivityTuning = VOICE_ACTIVITY_TUNING,
): { state: VoiceActivityState; effects: VoiceActivityEffect[] } {
  const state = { ...previous, frame: previous.frame + 1 };
  if (state.stage === 'silent' || input.probability === null) return stepSilent(state, input.rms, tuning);
  if (state.stage === 'armed') return stepArmed(state, input.probability, tuning);
  return stepSpeech(state, input.probability, tuning);
}

/** A stateful per-frame speech classifier (Silero keeps an LSTM state and a 64-sample context). */
export interface VoiceFrameClassifier {
  probability(frame: Float32Array): Promise<number>;
  reset(): void;
}

export interface VoiceActivityPipeline {
  push(frame: Float32Array): Promise<void>;
  stage(): VoiceStage;
  classifiedFrames(): number;
}

export function createVoiceActivityPipeline(
  classifier: VoiceFrameClassifier,
  onEffect: (effect: VadEffect) => void,
  tuning: VoiceActivityTuning = VOICE_ACTIVITY_TUNING,
): VoiceActivityPipeline {
  let state = initialVoiceActivity();
  let classified = 0;
  return {
    async push(frame) {
      const rms = rmsOf(frame);
      const probability = state.stage === 'silent' ? null : await classifier.probability(frame);
      if (probability !== null) classified += 1;
      const next = stepVoiceActivity(state, { rms, probability }, tuning);
      state = next.state;
      for (const effect of next.effects) {
        if (effect.kind === 'resetVad') classifier.reset();
        else onEffect(effect);
      }
    },
    stage: () => state.stage,
    classifiedFrames: () => classified,
  };
}
