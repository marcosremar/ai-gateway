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

export type MicIssue = 'clipping' | 'farOrEcho' | 'tooQuiet' | 'noisy' | 'hum' | 'dead' | 'hiss';

/**
 * What the microphone hears **when nobody is talking** — the pause floor, which decides whether an advice is
 * even meaningful. Same rules as `Floor` in the Rust crate. Measured on the ucast.me benchmark sets
 * (2026-10-26, `docs/medicoes.md` § piso): one threshold cannot tell a clean studio pause from air-conditioning,
 * nor either from a real noisy room.
 */
export type Floor = 'digitalSilence' | 'studioQuiet' | 'roomAmbient' | 'loudFloor' | 'meetingFloor';

/** The floor from the pauses: their median level (dBFS) and how much of them is digital silence. */
export function floorOf(pauseMedianDb: number, digitalShare: number): Floor {
  if (pauseMedianDb <= -90 || (digitalShare >= 0.05 && pauseMedianDb <= -70)) return 'digitalSilence';
  if (digitalShare >= 0.05) return 'meetingFloor';
  if (pauseMedianDb <= -54) return 'studioQuiet';
  if (pauseMedianDb <= -39) return 'roomAmbient';
  return 'loudFloor';
}

/**
 * The issues that made the transcription worse on the benchmark (app WER, clean talk 6.8 %): far/echo 11–41 %, noisy
 * (5 dB) 18 %. Clipping (6.9 %), hum (6.9–7.2 %) and a quiet microphone (6.8–7.0 %) are real but were transcribed
 * through — show them for recordings or an audience, not as a reason for bad subtitles.
 */
export const ISSUES_THAT_HURT_TRANSCRIPTION: readonly MicIssue[] = ['farOrEcho', 'noisy', 'dead', 'hiss'];

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
  /** What the room sounds like while nobody talks (null with too few pauses to tell). */
  floor: Floor | null;
  /** The input was all zeros (or only hiss) for `deadAfterS` inside the window. */
  deadInput: MicIssue | null;
}

/**
 * The issues worth showing in this room, most harmful first. In a quiet floor (studio, room tone, meeting
 * room) "noisy" is the floor itself, not the voice; "far away" still counts. Same rule as the Rust crate's
 * `MicReport::advice_issues`, so every app of the gateway shows the same advice.
 */
export function adviceIssues(r: MicReport): MicIssue[] {
  const quiet = r.floor !== null && r.floor !== 'loudFloor';
  return r.issues.filter((i) => !(quiet && i === 'noisy'));
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
  /** "Sure speech" this quiet is room tone, not a voice (see rust `NOISY_MIN_SPEECH_DB`). */
  noisyMinSpeechDb: -50,
  /** VAD probability that counts as speech for the noisy check (see rust `NOISY_VOICED_PROB`). */
  noisyVoicedProb: 0.85,
  humPeakDb: 8,
  humAudibleDb: -25,
  /** Seconds of digital zeros (or of only hiss) before the input is called dead. */
  deadAfterS: 15,
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
  /**
   * The input itself is unusable: digital zeros or only hiss for `deadAfterS` seconds. The one case `report()`
   * can never show (it needs 8 s of sound, and a dead input sends none), so a live page checks it every frame
   * and restarts the capture.
   */
  silentInput(): MicIssue | null;
  /** Forget everything (another microphone). */
  clear(): void;
}

export function createMicCheck(): MicCheck {
  let frames: Frame[] = [];
  let pauses: number[] = [];
  let zerosS = 0;
  let hissS = 0;
  const keepPauses = MIC_CHECK.humS * SILERO_SAMPLE_RATE;
  const secondsOf = (frame: Float32Array) => frame.length / SILERO_SAMPLE_RATE;
  return {
    push(frame, probability) {
      const prob = probability ?? 0;
      let ms = 0, clipped = 0, loudest = 0, crossings = 0;
      for (let i = 0; i < frame.length; i += 1) {
        const v = frame[i]!;
        ms += v * v;
        if (Math.abs(v) >= 0.98) clipped += 1;
        if (Math.abs(v) > loudest) loudest = Math.abs(v);
        if (i > 0 && (v < 0) !== (frame[i - 1]! < 0)) crossings += 1;
      }
      const db = 10 * Math.log10(Math.max(ms / Math.max(frame.length, 1), 1e-18));
      // A muted or unplugged input (and a wireless receiver missing its transmitter) sends nothing a report
      // could measure, so it is watched here.
      zerosS = loudest <= 1e-6 ? zerosS + secondsOf(frame) : 0;
      const rms = Math.sqrt(ms / Math.max(frame.length, 1));
      const isHiss = prob < 0.1 && rms > 0.05 && frame.length > 1 && crossings / (frame.length - 1) > 0.3;
      hissS = isHiss ? hissS + secondsOf(frame) : 0;
      frames.push({ db, prob, known: probability !== null, clipped });
      if (frames.length > framesIn(MIC_CHECK.windowS)) frames = frames.slice(-framesIn(MIC_CHECK.windowS));
      if (prob < 0.2 && db > -100) {
        for (const s of frame) pauses.push(s);
        if (pauses.length > keepPauses) pauses = pauses.slice(-keepPauses);
      }
    },
    silentInput() {
      if (zerosS >= MIC_CHECK.deadAfterS) return 'dead';
      if (hissS >= MIC_CHECK.deadAfterS) return 'hiss';
      return null;
    },
    report() {
      // Digital silence has no level: keep it out of `noiseDb` (as the Rust crate does) but count it for the floor.
      const silentRaw = frames.filter((f) => f.prob < 0.2 && f.db > -100).map((f) => f.db).sort((a, b) => a - b);
      const noiseDb = silentRaw.length >= framesIn(2) ? silentRaw[Math.floor(silentRaw.length / 5)]! : null;
      const gate = noiseDb === null ? -60 : noiseDb + 10;
      // Silero's confidence only where it ran (the RMS gate keeps it off on quiet frames: unknown, not unsure).
      const clear = frames.filter((f) => f.db > gate && f.known);
      const sound = frames.filter((f) => f.db > gate || f.prob >= 0.5);
      if (sound.length < framesIn(MIC_CHECK.minSoundS)) return null;
      const speechDb = median(sound.map((f) => f.db));
      // What the room does while nobody talks: pause median (digital has no level) + digital share.
      let floor: Floor | null = null;
      if (silentRaw.length >= framesIn(2)) {
        const levels = [...silentRaw].sort((a, b) => a - b);
        const pauses = frames.filter((f) => f.prob < 0.2).length || 1;
        const digital = frames.filter((f) => f.prob < 0.2 && f.db <= -100).length;
        floor = floorOf(levels[Math.floor(levels.length / 2)]!, digital / pauses);
      }
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
      if (!humming && voicedDb !== null && noiseDb !== null
        && voicedDb >= MIC_CHECK.noisyMinSpeechDb && voicedDb - noiseDb < MIC_CHECK.noisySnrDb) {
        issues.push('noisy');
      }
      if (humming) issues.push('hum');
      return { speechDb, noiseDb, vadConfidence, clippedShare, hum, issues, floor, deadInput: this.silentInput() };
    },
    clear() {
      frames = [];
      pauses = [];
      zerosS = 0;
      hissS = 0;
    },
  };
}
