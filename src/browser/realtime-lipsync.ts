/**
 * RealtimeLipsyncAnalyser — Real-time viseme estimation from a MediaStream.
 *
 * Uses an AnalyserNode (FFT) to map audio frequency bands to viseme morph
 * target values each frame. Returns the same shape as VisemeRenderer.compute()
 * so the avatar render loop can consume it identically.
 *
 * Designed for WebRTC audio tracks where we don't have pre-computed viseme
 * timelines — only the live audio signal.
 */

// The 14 viseme names matching the avatar's morph targets
const VISEME_NAMES = ['aa','E','I','O','U','PP','SS','TH','DD','FF','kk','RR','CH','sil'] as const;

/** Frequency band boundaries in Hz for formant analysis */
const BANDS = {
  fundamental: [80, 300],   // Voice F0
  f1:          [300, 900],  // First formant — vowel openness
  f2:          [900, 2500], // Second formant — vowel frontness
  sibilance:   [2500, 4000],// Sibilants: s, z, sh
  highFreq:    [4000, 8000],// Fricatives, aspirants
} as const;

/** Minimum RMS energy to consider as speech (below = silence) */
const SILENCE_THRESHOLD = 0.008;

/** Smoothing factor for tracking speech (1 - e^(-35 * dt) at 60fps ≈ 0.44) */
const TRACK_RATE = -35;
/** Faster decay when silent (1 - e^(-60 * dt) at 60fps ≈ 0.63) */
const DECAY_RATE = -60;
/** Jaw smoothing rate */
const JAW_TRACK_RATE = -22;
const JAW_DECAY_RATE = -40;

export class RealtimeLipsyncAnalyser {
  private _ctx: AudioContext | null = null;
  private _source: MediaStreamAudioSourceNode | null = null;
  private _analyser: AnalyserNode | null = null;
  // Explicit <ArrayBuffer> (not ArrayBufferLike) — AnalyserNode's
  // getFloatFrequencyData/getFloatTimeDomainData reject SharedArrayBuffer-backed
  // typed arrays. Keeping them as plain Float32Array defaults to the generic
  // ArrayBufferLike which is a type error in TS 5.7+.
  private _freqData: Float32Array<ArrayBuffer> | null = null;
  private _timeData: Float32Array<ArrayBuffer> | null = null;
  private _values: Record<string, number> = {};
  private _active = false;
  private _sampleRate = 48000;
  private _binHz = 0;
  private _ownCtx = false;

  constructor(stream: MediaStream, existingCtx?: AudioContext) {
    try {
      if (existingCtx && existingCtx.state !== 'closed') {
        this._ctx = existingCtx;
        this._ownCtx = false;
      } else {
        this._ctx = new AudioContext({ sampleRate: 48000 });
        this._ownCtx = true;
      }

      this._sampleRate = this._ctx.sampleRate;
      this._source = this._ctx.createMediaStreamSource(stream);

      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = 2048;
      this._analyser.smoothingTimeConstant = 0.6;

      this._source.connect(this._analyser);
      // Don't connect to destination — we don't want to double-play audio

      const bufLen = this._analyser.frequencyBinCount;
      this._freqData = new Float32Array(bufLen);
      this._timeData = new Float32Array(this._analyser.fftSize);
      this._binHz = this._sampleRate / this._analyser.fftSize;

      this._active = true;
    } catch (err) {
      console.warn('[RealtimeLipsyncAnalyser] Failed to initialize:', err);
      this._active = false;
    }
  }

  get isActive(): boolean { return this._active; }

  /**
   * Analyse current audio frame and return morph target values.
   * Call once per render frame.
   * @param dt - frame delta time in seconds
   * @returns morph values: { viseme_aa: 0-1, ..., jawOpen: 0-1 }
   */
  analyse(dt: number): Record<string, number> {
    if (!this._active || !this._analyser || !this._freqData || !this._timeData) {
      return this._decay(dt);
    }

    // Read frequency and time-domain data
    this._analyser.getFloatFrequencyData(this._freqData);
    this._analyser.getFloatTimeDomainData(this._timeData);

    // Compute RMS energy
    let sumSq = 0;
    for (let i = 0; i < this._timeData.length; i++) {
      sumSq += this._timeData[i] * this._timeData[i];
    }
    const rms = Math.sqrt(sumSq / this._timeData.length);

    // Silent — decay all values
    if (rms < SILENCE_THRESHOLD) {
      return this._decay(dt);
    }

    // Compute band energies (convert dB to linear, sum, normalize)
    const bandEnergy = {
      fundamental: this._getBandEnergy(BANDS.fundamental[0], BANDS.fundamental[1]),
      f1: this._getBandEnergy(BANDS.f1[0], BANDS.f1[1]),
      f2: this._getBandEnergy(BANDS.f2[0], BANDS.f2[1]),
      sibilance: this._getBandEnergy(BANDS.sibilance[0], BANDS.sibilance[1]),
      highFreq: this._getBandEnergy(BANDS.highFreq[0], BANDS.highFreq[1]),
    };

    // Normalize band energies relative to total
    const total = bandEnergy.fundamental + bandEnergy.f1 + bandEnergy.f2
                + bandEnergy.sibilance + bandEnergy.highFreq + 0.0001;

    const f1Ratio = bandEnergy.f1 / total;
    const f2Ratio = bandEnergy.f2 / total;
    const sibRatio = bandEnergy.sibilance / total;
    const hiRatio = bandEnergy.highFreq / total;

    // Energy-based intensity (0-1, louder = wider mouth)
    const intensity = Math.min(1, rms / 0.15);

    // Map to viseme targets
    const targets: Record<string, number> = {};
    let jawTarget = 0;

    // Vowels — from formant ratios
    // aa: high F1, low-mid F2 (open back: "ah")
    targets['viseme_aa'] = Math.min(1, f1Ratio * 3.5 * (1 - f2Ratio * 1.5)) * intensity * 0.7;
    // E: mid F1, high F2 (front mid: "eh")
    targets['viseme_E'] = Math.min(1, f1Ratio * 2.0 * f2Ratio * 3.0) * intensity * 0.6;
    // I: low F1, very high F2 (front close: "ee")
    targets['viseme_I'] = Math.min(1, (1 - f1Ratio * 2) * f2Ratio * 3.5) * intensity * 0.5;
    // O: mid F1, low F2 (back rounded: "oh")
    targets['viseme_O'] = Math.min(1, f1Ratio * 2.0 * (1 - f2Ratio * 2.5)) * intensity * 0.6;
    // U: low F1, mid F2 (close back: "oo")
    targets['viseme_U'] = Math.min(1, (1 - f1Ratio * 2.5) * (1 - f2Ratio * 1.5)) * intensity * 0.4;

    // Consonants — from sibilance and high-frequency energy
    // SS: strong sibilance (s, z)
    targets['viseme_SS'] = Math.min(1, sibRatio * 4.0) * intensity * 0.5;
    // CH: sibilance + high freq (sh, ch)
    targets['viseme_CH'] = Math.min(1, sibRatio * 2.0 * hiRatio * 4.0) * intensity * 0.4;
    // FF: high freq, low sibilance (f, v)
    targets['viseme_FF'] = Math.min(1, hiRatio * 3.5 * (1 - sibRatio * 2)) * intensity * 0.4;
    // TH: mid sibilance (th)
    targets['viseme_TH'] = Math.min(1, sibRatio * 2.0 * (1 - hiRatio * 2)) * intensity * 0.3;
    // PP: low energy with fundamental (p, b, m — bilabials)
    targets['viseme_PP'] = Math.min(1, (1 - f1Ratio * 2) * (1 - sibRatio * 3) * 0.5) * intensity * 0.4;
    // DD: moderate energy, dominant F1 (d, t, n)
    targets['viseme_DD'] = Math.min(1, f1Ratio * 2.5 * (1 - sibRatio * 2)) * intensity * 0.3;
    // kk: low F2, moderate F1 (k, g)
    targets['viseme_kk'] = Math.min(1, (1 - f2Ratio * 2.5) * f1Ratio * 1.5) * intensity * 0.3;
    // RR: moderate all bands (r, l)
    targets['viseme_RR'] = Math.min(1, f1Ratio * 1.5 * f2Ratio * 1.5) * intensity * 0.3;
    // sil: inverse of total energy
    targets['viseme_sil'] = Math.max(0, (1 - intensity) * 0.3);

    // Jaw coupling (same ratios as VisemeRenderer)
    const vowelJaw = Math.max(
      targets['viseme_aa'] * 0.5,
      targets['viseme_O'] * 0.5,
      targets['viseme_E'] * 0.5,
      targets['viseme_I'] * 0.5,
      targets['viseme_U'] * 0.5,
    );
    const consonantJaw = Math.max(
      targets['viseme_SS'] * 0.2,
      targets['viseme_TH'] * 0.2,
      targets['viseme_FF'] * 0.2,
      targets['viseme_RR'] * 0.2,
    );
    jawTarget = Math.max(vowelJaw, consonantJaw);

    // Apply exponential smoothing (matching VisemeRenderer._smooth)
    return this._smooth(targets, jawTarget, dt, false);
  }

  destroy(): void {
    this._active = false;
    if (this._source) {
      try { this._source.disconnect(); } catch { /* ok */ }
      this._source = null;
    }
    if (this._analyser) {
      try { this._analyser.disconnect(); } catch { /* ok */ }
      this._analyser = null;
    }
    if (this._ownCtx && this._ctx) {
      try { this._ctx.close(); } catch { /* ok */ }
    }
    this._ctx = null;
    this._freqData = null;
    this._timeData = null;
    this._values = {};
  }

  // ── Internal helpers ──

  /** Get linear energy sum for a frequency band */
  private _getBandEnergy(lowHz: number, highHz: number): number {
    if (!this._freqData) return 0;
    const startBin = Math.floor(lowHz / this._binHz);
    const endBin = Math.min(Math.ceil(highHz / this._binHz), this._freqData.length - 1);
    let energy = 0;
    for (let i = startBin; i <= endBin; i++) {
      // Convert dB (typically -100 to 0) to linear energy
      const db = this._freqData[i];
      energy += Math.pow(10, db / 20);
    }
    return energy / Math.max(1, endBin - startBin + 1);
  }

  /** Decay all values toward zero */
  private _decay(dt: number): Record<string, number> {
    const d = Math.exp(-12 * dt);
    const result: Record<string, number> = {};
    for (const v of VISEME_NAMES) {
      const key = 'viseme_' + v;
      const cur = this._values[key] || 0;
      const next = cur > 0.005 ? cur * d : 0;
      this._values[key] = next;
      result[key] = next;
    }
    const jawCur = this._values['jawOpen'] || 0;
    const jawNext = jawCur > 0.005 ? jawCur * d : 0;
    this._values['jawOpen'] = jawNext;
    result['jawOpen'] = jawNext;
    return result;
  }

  /** Exponential smoothing matching VisemeRenderer pattern */
  private _smooth(targets: Record<string, number>, jawTarget: number, dt: number, isDecay: boolean): Record<string, number> {
    const sf = 1 - Math.exp((isDecay ? DECAY_RATE : TRACK_RATE) * dt);
    const sfJaw = 1 - Math.exp((isDecay ? JAW_DECAY_RATE : JAW_TRACK_RATE) * dt);
    const result: Record<string, number> = {};

    for (const v of VISEME_NAMES) {
      const key = 'viseme_' + v;
      const target = targets[key] || 0;
      const cur = this._values[key] || 0;
      let next = cur + (target - cur) * sf;
      if (next < 0.005) next = 0;
      this._values[key] = next;
      result[key] = next;
    }

    const jawCur = this._values['jawOpen'] || 0;
    const jawNext = jawCur + (jawTarget - jawCur) * sfJaw;
    this._values['jawOpen'] = jawNext;
    result['jawOpen'] = jawNext;
    return result;
  }
}
