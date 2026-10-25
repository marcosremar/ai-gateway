/**
 * What Silero hears, put at the level of normal speech.
 *
 * Silero judges loudness too: in the ucast.me benchmark (`room`, 2026-10-25) a talk heard from across a room —
 * reverb (RT60 0.8 s), ~6 m, air-conditioning noise — came out at speech probability ~0.05 for 40 s, so nothing
 * was transcribed, and at 0.7 with +12 dB. The level is the room's average over the last seconds (`tauMs`), never
 * per frame (a pause must not be blown up into speech), and only goes UP, to at most `maxDb`; audio under
 * −60 dBFS (a muted microphone) is left alone. Only the classifier's copy changes: the RMS gate and the turn's
 * WAV keep the audio as it came. Same rule and numbers as the desktop app and `ai-gateway-audio` (Rust).
 *
 * Measured in this pipeline (`scripts/voice-level-bench`): speech found in the room 47.6 → 74.0 % (es), more or the
 * same in every other set, and 0 false alarms on noise only, with or without it.
 */

export interface VoiceLevelTuning {
  /** Average level (dBFS) the classifier should hear. */
  targetDb: number;
  /** Most it may raise (dB). */
  maxDb: number;
  /** Length of the average (ms). */
  tauMs: number;
}

/** −24 dBFS, up to +12 dB, over 3 s: the best of −22…−28 dB on the benchmark's room, clean talk, accent and conversation sets. */
export const VOICE_LEVEL: VoiceLevelTuning = { targetDb: -24, maxDb: 12, tauMs: 3000 };

const FRAME_MS = 32;
const FLOOR = 1e-3;

export interface VoiceLevel {
  /** The frame as the classifier should hear it (a new array; the input is not touched). */
  apply(frame: Float32Array): Float32Array;
  /** The gain applied to the last frame. */
  gain(): number;
}

export function createVoiceLevel(tuning: VoiceLevelTuning = VOICE_LEVEL): VoiceLevel {
  const target = 10 ** (tuning.targetDb / 20);
  const maxGain = 10 ** (tuning.maxDb / 20);
  const keep = Math.exp(-FRAME_MS / tuning.tauMs);
  let meanSquare = 0;
  // Weight of the average so far: dividing by it keeps the first seconds from reading as near silence
  // (which would raise them by the whole maxDb).
  let weight = 0;
  let current = 1;
  return {
    apply(frame) {
      let sum = 0;
      for (const s of frame) sum += s * s;
      meanSquare = meanSquare * keep + (sum / Math.max(frame.length, 1)) * (1 - keep);
      weight = weight * keep + (1 - keep);
      const level = Math.sqrt(meanSquare / weight);
      current = level < FLOOR ? 1 : Math.min(Math.max(target / level, 1), maxGain);
      const out = new Float32Array(frame.length);
      for (let i = 0; i < frame.length; i += 1) out[i] = Math.max(-1, Math.min(1, frame[i]! * current));
      return out;
    },
    gain: () => current,
  };
}
