/**
 * What is wrong with the microphone, from the audio itself — so the page can tell the person what to change ("too
 * quiet", "far away or echoing", "clipping", "noisy room", "electrical hum") instead of transcribing worse without a
 * reason. Same rules and thresholds as `ai-gateway-audio`'s `MicCheck` (Rust), measured on the ucast.me benchmark's
 * room grid: each check only flags conditions that made the subtitles worse.
 *
 * Feed it every 32 ms frame as it came from the microphone (before `createVoiceLevel`) with the speech probability
 * Silero gave it (`null` while the RMS gate kept Silero off: counted as a pause); `report()` looks at the last 30 s.
 */
import { SILERO_FRAME_SAMPLES, SILERO_SAMPLE_RATE } from './silero';

export type MicIssue = 'clipping' | 'farOrEcho' | 'tooQuiet' | 'noisy' | 'hum';

/**
 * The issues that made the transcription worse on the benchmark (app WER, clean talk 6.8 %): far/echo 11–41 %, noisy
 * (5 dB) 18 %. Clipping (6.9 %), hum (6.9–7.2 %) and a quiet microphone (6.8–7.0 %) are real but were transcribed
 * through — show them for recordings or an audience, not as a reason for bad subtitles.
 */
export const ISSUES_THAT_HURT_TRANSCRIPTION: readonly MicIssue[] = ['farOrEcho', 'noisy'];

export interface MicReport {
  /** Median level of the frames with sound (dBFS, as it came from the microphone). */
  speechDb: number;
  /** The room's floor (20th percentile of the frames Silero calls silence), null when unknown. */
  noiseDb: number | null;
  /** Median speech probability on the frames with clear sound, null with too few. */
  vadConfidence: number | null;
  /** Share of the samples of the sound frames at full scale. */
  clippedShare: number;
  /** Peak of the 50/60 Hz bins over their neighbours (dB) and its level relative to the speech (dB). */
  hum: { peakDb: number; levelDb: number } | null;
  /** What to tell the person, most harmful first (empty = nothing to change). */
  issues: MicIssue[];
}

export const MIC_CHECK = {
  windowS: 30,
  minSoundS: 8,
  humS: 4,
  quietDb: -50,
  clippedShare: 0.001,
  unsureVad: 0.95,
  /** Far/echo only above this speech level (dBFS); quieter is studio-pause ambient. */
  farMinSpeechDb: -40,
  noisySnrDb: 10,
  /** VAD probability that counts as speech for the noisy check (see rust `NOISY_VOICED_PROB`). */
  noisyVoicedProb: 0.85,
  humPeakDb: 8,
  humAudibleDb: -25,
} as const;

const FRAMES_PER_S = SILERO_SAMPLE_RATE / SILERO_FRAME_SAMPLES;
/** Frames per hum block (~0.5 s, 2 Hz resolution: the neighbours 6–14 Hz away stay apart). */
const HUM_BLOCK = 16;
const framesIn = (s: number): number => Math.floor(s * FRAMES_PER_S);

interface Frame { db: number; prob: number; known: boolean; clipped: number }

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Goertzel power of `freq` over `x`. */
function power(x: Float32Array, freq: number): number {
  const c = 2 * Math.cos((2 * Math.PI * freq) / SILERO_SAMPLE_RATE);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i += 1) {
    const s0 = x[i]! + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2);
}

export interface MicCheck {
  push(frame: Float32Array, probability: number | null): void;
  /** null until there are `minSoundS` seconds of sound in the window. */
  report(): MicReport | null;
  /** Forget everything (another microphone). */
  clear(): void;
}

export function createMicCheck(): MicCheck {
  let frames: Frame[] = [];
  let pauses: number[] = [];
  const keepPauses = MIC_CHECK.humS * SILERO_SAMPLE_RATE;
  return {
    push(frame, probability) {
      const prob = probability ?? 0;
      let ms = 0, clipped = 0;
      for (const s of frame) { ms += s * s; if (Math.abs(s) >= 0.98) clipped += 1; }
      const db = 10 * Math.log10(Math.max(ms / Math.max(frame.length, 1), 1e-18));
      frames.push({ db, prob, known: probability !== null, clipped });
      if (frames.length > framesIn(MIC_CHECK.windowS)) frames = frames.slice(-framesIn(MIC_CHECK.windowS));
      if (prob < 0.2 && db > -100) {
        for (const s of frame) pauses.push(s);
        if (pauses.length > keepPauses) pauses = pauses.slice(-keepPauses);
      }
    },
    report() {
      const silent = frames.filter((f) => f.prob < 0.2 && f.db > -100).map((f) => f.db).sort((a, b) => a - b);
      const noiseDb = silent.length >= framesIn(2) ? silent[Math.floor(silent.length / 5)]! : null;
      const gate = noiseDb === null ? -60 : noiseDb + 10;
      // Silero's confidence only where it ran (the RMS gate keeps it off on quiet frames: unknown, not unsure).
      const clear = frames.filter((f) => f.db > gate && f.known);
      const sound = frames.filter((f) => f.db > gate || f.prob >= 0.5);
      if (sound.length < framesIn(MIC_CHECK.minSoundS)) return null;
      const speechDb = median(sound.map((f) => f.db));
      const vadConfidence = clear.length >= framesIn(4) ? median(clear.map((f) => f.prob)) : null;
      const clippedShare = sound.reduce((a, f) => a + f.clipped, 0) / (sound.length * SILERO_FRAME_SAMPLES);
      let hum: MicReport['hum'] = null;
      if (pauses.length >= 2 * SILERO_SAMPLE_RATE) {
        // The pauses are pieces cut out between words: the hum's phase jumps from one to the next, so each block of
        // HUM_BLOCK frames is measured on its own and the powers are added (not one coherent sum).
        const size = HUM_BLOCK * SILERO_FRAME_SAMPLES;
        const blocks: Float32Array[] = [];
        for (let i = 0; i + size <= pauses.length; i += size) blocks.push(Float32Array.from(pauses.slice(i, i + size)));
        const total = (freq: number) => blocks.reduce((a, b) => a + power(b, freq), 0) / blocks.length;
        for (const base of [50, 60]) {
          let peak = 0, side = 0;
          for (const k of [1, 2, 3]) {
            peak += total(base * k);
            side += [6, 8, 10, 12, 14].reduce((a, d) => a + total(base * k + d), 0) / 5;
          }
          // Goertzel power of a sine of amplitude a over n samples ≈ (a n / 2)², so its rms is √(2 P) / n.
          const candidate = { peakDb: 10 * Math.log10(peak / Math.max(side, 1e-18)), levelDb: 20 * Math.log10(Math.max(Math.sqrt(2 * peak) / size, 1e-9)) - speechDb };
          if (!hum || candidate.peakDb > hum.peakDb) hum = candidate;
        }
      }
      const issues: MicIssue[] = [];
      if (clippedShare > MIC_CHECK.clippedShare) issues.push('clipping');
      // Far/echo needs a long stretch of unsure speech (10 s), not studio pauses after leveling
      // (presentation pauses ≈ 8 s / 30 s in 0.15..noisyVoicedProb; a real room mic ≈ 38 %).
      const unsureSpeech = frames.filter((f) => f.prob >= 0.15 && f.prob < MIC_CHECK.noisyVoicedProb).length
        >= framesIn(10);
      if (unsureSpeech && speechDb >= MIC_CHECK.farMinSpeechDb && vadConfidence !== null && vadConfidence < MIC_CHECK.unsureVad) {
        issues.push('farOrEcho');
      }
      if (speechDb < MIC_CHECK.quietDb) issues.push('tooQuiet');
      const humming = hum !== null && hum.peakDb > MIC_CHECK.humPeakDb && hum.levelDb > MIC_CHECK.humAudibleDb;
      // SNR from frames the VAD is sure are speech — not ambient the level boosts into mid probabilities.
      // Same 8 s bar as minSoundS: a loud AC floor stays under it.
      const voiced = frames.filter((f) => f.prob >= MIC_CHECK.noisyVoicedProb).map((f) => f.db);
      const voicedDb = voiced.length >= framesIn(MIC_CHECK.minSoundS) ? median(voiced) : null;
      // A hum raises the floor too; then it is the hum, not a noisy room (and the hum was transcribed through).
      if (!humming && voicedDb !== null && noiseDb !== null && voicedDb - noiseDb < MIC_CHECK.noisySnrDb) issues.push('noisy');
      if (humming) issues.push('hum');
      return { speechDb, noiseDb, vadConfidence, clippedShare, hum, issues };
    },
    clear() {
      frames = [];
      pauses = [];
    },
  };
}
