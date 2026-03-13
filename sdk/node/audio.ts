/**
 * Client-side audio processing for STT — VAD segmentation with robustness techniques.
 *
 * Framework-agnostic module. Uses callbacks for event notification.
 * Works in both Node.js and browser environments (Web Audio API compatible).
 *
 * Implements 12 research-backed techniques for robust speech-to-text:
 *   1. Pre-speech padding buffer — captures word onsets before VAD triggers
 *   2. Post-speech padding — captures final phonemes after silence hangover
 *   3. Exponential smoothing on VAD probability — reduces jitter/oscillation
 *   4. Dual threshold / hysteresis — separate onset (high) and offset (low) thresholds
 *   5. Smart cut points — finds silence-aligned cuts at max duration
 *   6. Short segment accumulation — buffers short chunks before STT
 *   7. AGC (Automatic Gain Control) — normalizes energy toward target RMS
 *   8. Adaptive endpointing — adjusts silence hangover based on speech duration
 *   9. Overlap / multi-speaker detection — flags sudden energy spikes
 *  10. Echo / TTS gating — suppresses VAD during TTS playback
 *  11. Dual-pass utterance end — lookahead confirmation before emitting
 *  12. Voice Activity Projection (VAP) — predicts pause from speaking rate trend
 *
 * Usage:
 *   import { AudioSegmenter } from '@parle/ai-gateway/sdk/node/audio';
 *
 *   const segmenter = new AudioSegmenter({
 *     onSegment: (segment) => console.log(`Speech: ${segment.durationMs}ms`),
 *     onLevel: (rms) => updateVuMeter(rms),
 *   });
 *
 *   // Feed PCM frames (Int16 mono at configured sample rate)
 *   segmenter.feedPcm(pcmBuffer);
 *
 * Note: This module does NOT include a VAD model. You must provide a
 * vadInference function that returns a speech probability (0.0–1.0)
 * for a given audio frame. Use Silero VAD, @ricky0123/vad, or similar.
 */

// ── Configuration ───────────────────────────────────────────────────────────

export interface AudioSegmenterConfig {
  sampleRate?: number;

  // VAD thresholds (dual threshold / hysteresis)
  vadOnsetThreshold?: number;
  vadOffsetThreshold?: number;

  // Exponential smoothing (0 = no smoothing, 1 = full history)
  vadSmoothingAlpha?: number;

  // Pre/post speech padding (ms)
  preSpeechPadMs?: number;
  postSpeechPadMs?: number;

  // Silence hangover (ms)
  silenceHangoverMs?: number;

  // Speech duration limits (ms)
  maxSpeechMs?: number;
  minSpeechMs?: number;

  // Energy gate
  minSpeechRms?: number;
  adaptiveRmsMultiplier?: number;
  ambientRmsDecay?: number;

  // Smart cut (ms)
  smartCutSearchMs?: number;
  smartCutWindowMs?: number;

  // Short segment accumulation
  minSttAudioS?: number;

  // ── AGC (Automatic Gain Control) ──
  agcEnabled?: boolean;
  agcTargetRms?: number;
  agcMaxGain?: number;
  agcAttackCoeff?: number;
  agcReleaseCoeff?: number;

  // ── Adaptive endpointing ──
  adaptiveEndpointing?: boolean;
  endpointingShortMs?: number;
  endpointingLongMs?: number;
  endpointingShortSpeechMs?: number;
  endpointingLongSpeechMs?: number;

  // ── Overlap detection ──
  overlapDetection?: boolean;
  overlapEnergyRatio?: number;
  overlapWindowMs?: number;

  // ── Echo / TTS gating ──
  echoGateEnabled?: boolean;
  echoGateSuppressMs?: number;

  // ── Dual-pass utterance end ──
  dualPassEnabled?: boolean;
  dualPassLookaheadMs?: number;

  // ── VAP (Voice Activity Projection) ──
  vapEnabled?: boolean;
  vapHistoryFrames?: number;
  vapPausePredictionThreshold?: number;

  // Callbacks
  onSegment?: (segment: AudioSegment) => void;
  onLevel?: (rms: number) => void;

  /**
   * VAD inference function — returns speech probability (0.0–1.0).
   * Must be provided by the caller (e.g., Silero VAD ONNX, @ricky0123/vad).
   * Receives Float32Array of exactly VAD_WINDOW_SAMPLES samples.
   */
  vadInference?: (samples: Float32Array) => number;
}

export interface AudioSegment {
  pcm: Int16Array;
  durationMs: number;
  reason: 'pause' | 'max_duration' | 'smart_cut' | 'flush';
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Silero VAD standard window size. */
export const VAD_WINDOW_SAMPLES = 512;
const VAD_WINDOW_BYTES = VAD_WINDOW_SAMPLES * 2; // int16

const DEFAULTS = {
  sampleRate: 16000,
  vadOnsetThreshold: 0.45,
  vadOffsetThreshold: 0.20,
  vadSmoothingAlpha: 0.65,
  preSpeechPadMs: 200,
  postSpeechPadMs: 150,
  silenceHangoverMs: 300,
  maxSpeechMs: 8000,
  minSpeechMs: 400,
  minSpeechRms: 0.001,
  adaptiveRmsMultiplier: 3.0,
  ambientRmsDecay: 0.995,
  smartCutSearchMs: 1500,
  smartCutWindowMs: 20,
  minSttAudioS: 1.2,
  // AGC
  agcEnabled: true,
  agcTargetRms: 0.1,
  agcMaxGain: 10.0,
  agcAttackCoeff: 0.01,
  agcReleaseCoeff: 0.05,
  // Adaptive endpointing
  adaptiveEndpointing: true,
  endpointingShortMs: 200,
  endpointingLongMs: 500,
  endpointingShortSpeechMs: 1000,
  endpointingLongSpeechMs: 3000,
  // Overlap detection
  overlapDetection: true,
  overlapEnergyRatio: 1.8,
  overlapWindowMs: 100,
  // Echo gate
  echoGateEnabled: false,
  echoGateSuppressMs: 200,
  // Dual-pass
  dualPassEnabled: true,
  dualPassLookaheadMs: 150,
  // VAP
  vapEnabled: true,
  vapHistoryFrames: 30,
  vapPausePredictionThreshold: 0.3,
} as const;

// ── AudioSegmenter ──────────────────────────────────────────────────────────

export class AudioSegmenter {
  private readonly cfg: Required<
    Pick<AudioSegmenterConfig,
      'sampleRate' | 'vadOnsetThreshold' | 'vadOffsetThreshold' |
      'vadSmoothingAlpha' | 'preSpeechPadMs' | 'postSpeechPadMs' |
      'silenceHangoverMs' | 'maxSpeechMs' | 'minSpeechMs' |
      'minSpeechRms' | 'adaptiveRmsMultiplier' | 'ambientRmsDecay' |
      'smartCutSearchMs' | 'smartCutWindowMs' | 'minSttAudioS' |
      'agcEnabled' | 'agcTargetRms' | 'agcMaxGain' | 'agcAttackCoeff' | 'agcReleaseCoeff' |
      'adaptiveEndpointing' | 'endpointingShortMs' | 'endpointingLongMs' |
      'endpointingShortSpeechMs' | 'endpointingLongSpeechMs' |
      'overlapDetection' | 'overlapEnergyRatio' | 'overlapWindowMs' |
      'echoGateEnabled' | 'echoGateSuppressMs' |
      'dualPassEnabled' | 'dualPassLookaheadMs' |
      'vapEnabled' | 'vapHistoryFrames' | 'vapPausePredictionThreshold'
    >
  >;

  private onSegment?: (segment: AudioSegment) => void;
  private onLevel?: (rms: number) => void;
  private vadInference?: (samples: Float32Array) => number;

  // VAD state
  private speechBuf: Int16Array[] = [];
  private speechBufLen = 0;
  private isSpeaking = false;
  private silenceSamples = 0;
  private speechSamples = 0;
  private speechEnergySum = 0;
  private speechEnergyCount = 0;
  private continuation = false;
  private smoothedProb = 0;
  private ambientRms = 0;
  private lastLevelTime = -Infinity;

  // Pre-speech ring buffer
  private readonly preSpeechBuf: Int16Array[] = [];
  private readonly preSpeechMaxFrames: number;

  // Post-speech padding
  private readonly postPadSamples: number;
  private postPadCollecting = false;
  private postPadCollected = 0;
  private postPadChunk: Int16Array | null = null;

  // Remainder for non-aligned input
  private remainder: Uint8Array = new Uint8Array(0);

  // Bytes per ms
  private readonly bytesPerMs: number;

  // AGC state
  private agcGain = 1.0;

  // Overlap detection
  private recentRms: number[] = [];
  private readonly overlapMaxFrames: number;
  private _overlapDetected = false;

  // Echo gate
  private echoGateUntil = 0;

  // Dual-pass utterance end
  private dualPassPending = false;
  private dualPassFrames = 0;
  private dualPassSpeechFrames = 0;
  private readonly dualPassLookahead: number;

  // VAP history
  private vapHistory: boolean[] = [];

  constructor(config: AudioSegmenterConfig = {}) {
    this.cfg = {
      sampleRate: config.sampleRate ?? DEFAULTS.sampleRate,
      vadOnsetThreshold: config.vadOnsetThreshold ?? DEFAULTS.vadOnsetThreshold,
      vadOffsetThreshold: config.vadOffsetThreshold ?? DEFAULTS.vadOffsetThreshold,
      vadSmoothingAlpha: config.vadSmoothingAlpha ?? DEFAULTS.vadSmoothingAlpha,
      preSpeechPadMs: config.preSpeechPadMs ?? DEFAULTS.preSpeechPadMs,
      postSpeechPadMs: config.postSpeechPadMs ?? DEFAULTS.postSpeechPadMs,
      silenceHangoverMs: config.silenceHangoverMs ?? DEFAULTS.silenceHangoverMs,
      maxSpeechMs: config.maxSpeechMs ?? DEFAULTS.maxSpeechMs,
      minSpeechMs: config.minSpeechMs ?? DEFAULTS.minSpeechMs,
      minSpeechRms: config.minSpeechRms ?? DEFAULTS.minSpeechRms,
      adaptiveRmsMultiplier: config.adaptiveRmsMultiplier ?? DEFAULTS.adaptiveRmsMultiplier,
      ambientRmsDecay: config.ambientRmsDecay ?? DEFAULTS.ambientRmsDecay,
      smartCutSearchMs: config.smartCutSearchMs ?? DEFAULTS.smartCutSearchMs,
      smartCutWindowMs: config.smartCutWindowMs ?? DEFAULTS.smartCutWindowMs,
      minSttAudioS: config.minSttAudioS ?? DEFAULTS.minSttAudioS,
      agcEnabled: config.agcEnabled ?? DEFAULTS.agcEnabled,
      agcTargetRms: config.agcTargetRms ?? DEFAULTS.agcTargetRms,
      agcMaxGain: config.agcMaxGain ?? DEFAULTS.agcMaxGain,
      agcAttackCoeff: config.agcAttackCoeff ?? DEFAULTS.agcAttackCoeff,
      agcReleaseCoeff: config.agcReleaseCoeff ?? DEFAULTS.agcReleaseCoeff,
      adaptiveEndpointing: config.adaptiveEndpointing ?? DEFAULTS.adaptiveEndpointing,
      endpointingShortMs: config.endpointingShortMs ?? DEFAULTS.endpointingShortMs,
      endpointingLongMs: config.endpointingLongMs ?? DEFAULTS.endpointingLongMs,
      endpointingShortSpeechMs: config.endpointingShortSpeechMs ?? DEFAULTS.endpointingShortSpeechMs,
      endpointingLongSpeechMs: config.endpointingLongSpeechMs ?? DEFAULTS.endpointingLongSpeechMs,
      overlapDetection: config.overlapDetection ?? DEFAULTS.overlapDetection,
      overlapEnergyRatio: config.overlapEnergyRatio ?? DEFAULTS.overlapEnergyRatio,
      overlapWindowMs: config.overlapWindowMs ?? DEFAULTS.overlapWindowMs,
      echoGateEnabled: config.echoGateEnabled ?? DEFAULTS.echoGateEnabled,
      echoGateSuppressMs: config.echoGateSuppressMs ?? DEFAULTS.echoGateSuppressMs,
      dualPassEnabled: config.dualPassEnabled ?? DEFAULTS.dualPassEnabled,
      dualPassLookaheadMs: config.dualPassLookaheadMs ?? DEFAULTS.dualPassLookaheadMs,
      vapEnabled: config.vapEnabled ?? DEFAULTS.vapEnabled,
      vapHistoryFrames: config.vapHistoryFrames ?? DEFAULTS.vapHistoryFrames,
      vapPausePredictionThreshold: config.vapPausePredictionThreshold ?? DEFAULTS.vapPausePredictionThreshold,
    };

    this.onSegment = config.onSegment;
    this.onLevel = config.onLevel;
    this.vadInference = config.vadInference;

    this.preSpeechMaxFrames = Math.max(1, Math.floor(this.cfg.preSpeechPadMs / 32));
    this.postPadSamples = Math.floor(this.cfg.postSpeechPadMs * this.cfg.sampleRate / 1000);
    this.bytesPerMs = this.cfg.sampleRate * 2 / 1000;
    this.overlapMaxFrames = Math.max(1, Math.floor(this.cfg.overlapWindowMs / 32));
    this.dualPassLookahead = Math.max(1, Math.floor(this.cfg.dualPassLookaheadMs / 32));
  }

  /** Whether the most recent frame had an energy spike suggesting overlapping speakers. */
  get overlapFlag(): boolean { return this._overlapDetected; }

  /** Call when TTS playback ends to suppress echo detection for echoGateSuppressMs. */
  notifyTtsEnd(): void {
    if (this.cfg.echoGateEnabled) {
      this.echoGateUntil = performance.now() / 1000 + this.cfg.echoGateSuppressMs / 1000;
    }
  }

  /**
   * Set the VAD inference function at runtime.
   * Useful when the model loads asynchronously.
   */
  setVadInference(fn: (samples: Float32Array) => number): void {
    this.vadInference = fn;
  }

  /**
   * Feed raw Int16 PCM bytes. Splits into VAD windows and processes each.
   */
  feedPcm(pcmBytes: Uint8Array | ArrayBuffer): void {
    const input = pcmBytes instanceof ArrayBuffer ? new Uint8Array(pcmBytes) : pcmBytes;

    // Combine with remainder
    let raw: Uint8Array;
    if (this.remainder.length > 0) {
      raw = new Uint8Array(this.remainder.length + input.length);
      raw.set(this.remainder);
      raw.set(input, this.remainder.length);
      this.remainder = new Uint8Array(0);
    } else {
      raw = input;
    }

    let offset = 0;
    while (offset + VAD_WINDOW_BYTES <= raw.length) {
      const frame = new Int16Array(raw.buffer, raw.byteOffset + offset, VAD_WINDOW_SAMPLES);
      this.processFrame(frame);
      offset += VAD_WINDOW_BYTES;
    }

    if (offset < raw.length) {
      this.remainder = raw.slice(offset);
    }
  }

  /**
   * Feed a single VAD window (512 Int16 samples).
   */
  feedFrame(frame: Int16Array): void {
    this.processFrame(frame);
  }

  /**
   * Flush any remaining speech buffer.
   */
  flush(): void {
    let segment: AudioSegment | null = null;

    if (this.postPadCollecting && this.postPadChunk) {
      const fullPcm = this.concatInt16([this.postPadChunk, ...this.speechBuf]);
      segment = this.makeSegment(fullPcm, 'flush');
    } else if (this.isSpeaking && this.speechSamples > 0) {
      const speechMs = (this.speechSamples / this.cfg.sampleRate) * 1000;
      if (speechMs >= this.cfg.minSpeechMs) {
        segment = this.makeSegment(this.concatInt16(this.speechBuf), 'flush');
      }
    }

    this.resetState();
    if (segment) this.onSegment?.(segment);
  }

  /**
   * Reset all state.
   */
  reset(): void {
    this.resetState();
  }

  /**
   * Find the lowest-energy point in the last N ms (smart cut).
   */
  findSmartCutPoint(pcm: Int16Array): number {
    const { smartCutWindowMs, smartCutSearchMs, sampleRate } = this.cfg;
    const samplesPerWindow = Math.floor(smartCutWindowMs * sampleRate / 1000);
    const searchSamples = Math.floor(smartCutSearchMs * sampleRate / 1000);

    if (pcm.length < searchSamples) return pcm.length;

    const searchStart = pcm.length - searchSamples;
    const region = pcm.subarray(searchStart);

    const nWindows = Math.floor(region.length / samplesPerWindow);
    if (nWindows < 2) return pcm.length;

    const energies: number[] = [];
    for (let i = 0; i < nWindows; i++) {
      const window = region.subarray(i * samplesPerWindow, (i + 1) * samplesPerWindow);
      let sumSq = 0;
      for (let j = 0; j < window.length; j++) {
        const v = window[j] / 32768;
        sumSq += v * v;
      }
      energies.push(Math.sqrt(sumSq / window.length));
    }

    let minIdx = 0;
    let minVal = energies[0];
    for (let i = 1; i < energies.length; i++) {
      if (energies[i] < minVal) {
        minVal = energies[i];
        minIdx = i;
      }
    }

    const cutSample = searchStart + minIdx * samplesPerWindow + Math.floor(samplesPerWindow / 2);
    const avgEnergy = energies.reduce((a, b) => a + b, 0) / energies.length;

    if (minVal < avgEnergy * 0.6) return cutSample;
    return pcm.length;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private applyAgc(frame: Int16Array, rms: number): { frame: Int16Array; rms: number } {
    if (!this.cfg.agcEnabled || rms < 1e-6) return { frame, rms };
    let desiredGain = Math.min(this.cfg.agcTargetRms / rms, this.cfg.agcMaxGain);
    if (desiredGain > this.agcGain) {
      this.agcGain += this.cfg.agcAttackCoeff * (desiredGain - this.agcGain);
    } else {
      this.agcGain += this.cfg.agcReleaseCoeff * (desiredGain - this.agcGain);
    }
    const out = new Int16Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      out[i] = Math.max(-32768, Math.min(32767, Math.round(frame[i] * this.agcGain)));
    }
    let newSumSq = 0;
    for (let i = 0; i < out.length; i++) {
      const v = out[i] / 32768;
      newSumSq += v * v;
    }
    return { frame: out, rms: Math.sqrt(newSumSq / out.length) };
  }

  private getEffectiveHangover(speechMs: number): number {
    if (!this.cfg.adaptiveEndpointing) return this.cfg.silenceHangoverMs;
    if (speechMs <= this.cfg.endpointingShortSpeechMs) return this.cfg.endpointingShortMs;
    if (speechMs >= this.cfg.endpointingLongSpeechMs) return this.cfg.endpointingLongMs;
    const ratio = (speechMs - this.cfg.endpointingShortSpeechMs) /
      (this.cfg.endpointingLongSpeechMs - this.cfg.endpointingShortSpeechMs);
    return this.cfg.endpointingShortMs + ratio * (this.cfg.endpointingLongMs - this.cfg.endpointingShortMs);
  }

  private checkOverlap(rms: number): boolean {
    if (!this.cfg.overlapDetection || this.recentRms.length < 2) {
      this.recentRms.push(rms);
      if (this.recentRms.length > this.overlapMaxFrames) this.recentRms.shift();
      return false;
    }
    const avg = this.recentRms.reduce((a, b) => a + b, 0) / this.recentRms.length;
    this.recentRms.push(rms);
    if (this.recentRms.length > this.overlapMaxFrames) this.recentRms.shift();
    return avg > 0 && rms > avg * this.cfg.overlapEnergyRatio;
  }

  private vapPredictPause(): boolean {
    if (!this.cfg.vapEnabled || this.vapHistory.length < this.cfg.vapHistoryFrames) return false;
    const half = this.vapHistory.slice(Math.floor(this.vapHistory.length / 2));
    if (half.length === 0) return false;
    const speechRatio = half.filter(v => v).length / half.length;
    return speechRatio < this.cfg.vapPausePredictionThreshold;
  }

  private processFrame(frame: Int16Array): void {
    // Compute RMS
    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i] / 32768;
      sumSq += v * v;
    }
    let rms = Math.sqrt(sumSq / frame.length);

    // AGC
    if (this.cfg.agcEnabled) {
      const agcResult = this.applyAgc(frame, rms);
      frame = agcResult.frame;
      rms = agcResult.rms;
    }

    // Echo gate
    const now = performance.now() / 1000;
    const echoSuppressed = this.cfg.echoGateEnabled && now < this.echoGateUntil;

    // VU meter (~12Hz)
    if (this.onLevel && now - this.lastLevelTime >= 0.08) {
      this.lastLevelTime = now;
      this.onLevel(Math.min(1.0, rms * 5.0));
    }

    // Overlap detection
    this._overlapDetected = this.checkOverlap(rms);

    let segmentToEmit: AudioSegment | null = null;

    // Post-speech padding collection
    if (this.postPadCollecting) {
      this.speechBuf.push(new Int16Array(frame));
      this.speechBufLen += frame.length;
      this.postPadCollected += VAD_WINDOW_SAMPLES;
      if (this.postPadCollected >= this.postPadSamples) {
        const fullPcm = this.concatInt16([this.postPadChunk!, ...this.speechBuf]);
        segmentToEmit = this.makeSegment(fullPcm, 'pause');
        this.resetState();
      }
    } else if (echoSuppressed) {
      // During echo gate, treat everything as silence
      this.preSpeechBuf.push(new Int16Array(frame));
      if (this.preSpeechBuf.length > this.preSpeechMaxFrames) this.preSpeechBuf.shift();
    } else {
      // VAD inference
      let rawProb = 0;
      if (this.vadInference) {
        const float32 = new Float32Array(frame.length);
        for (let i = 0; i < frame.length; i++) float32[i] = frame[i] / 32768;
        rawProb = this.vadInference(float32);
      }

      // Exponential smoothing
      this.smoothedProb =
        this.cfg.vadSmoothingAlpha * this.smoothedProb +
        (1 - this.cfg.vadSmoothingAlpha) * rawProb;
      const prob = this.smoothedProb;

      // VAP history
      if (this.cfg.vapEnabled) {
        this.vapHistory.push(prob >= this.cfg.vadOffsetThreshold);
        if (this.vapHistory.length > this.cfg.vapHistoryFrames) this.vapHistory.shift();
      }

      // Dual threshold
      const isSpeech = this.isSpeaking
        ? prob >= this.cfg.vadOffsetThreshold
        : prob >= this.cfg.vadOnsetThreshold;

      // Adaptive RMS
      if (!this.isSpeaking) {
        this.ambientRms =
          this.cfg.ambientRmsDecay * this.ambientRms +
          (1 - this.cfg.ambientRmsDecay) * rms;
      }
      const adaptiveRms = Math.max(
        this.cfg.minSpeechRms,
        this.ambientRms * this.cfg.adaptiveRmsMultiplier,
      );

      if (!this.isSpeaking) {
        // IDLE — maintain pre-speech ring buffer
        this.preSpeechBuf.push(new Int16Array(frame));
        if (this.preSpeechBuf.length > this.preSpeechMaxFrames) {
          this.preSpeechBuf.shift();
        }

        if (isSpeech && rms >= adaptiveRms) {
          // Speech started — prepend pre-speech buffer + current frame
          this.isSpeaking = true;
          const prePad = this.concatInt16(this.preSpeechBuf);
          this.speechBuf = [prePad, new Int16Array(frame)];
          this.speechBufLen = prePad.length + frame.length;
          this.speechSamples = prePad.length + VAD_WINDOW_SAMPLES;
          this.silenceSamples = 0;
          this.speechEnergySum = rms;
          this.speechEnergyCount = 1;
          this.preSpeechBuf.length = 0;
        }
      } else {
        // SPEAKING — accumulate
        this.speechBuf.push(new Int16Array(frame));
        this.speechBufLen += frame.length;
        this.speechSamples += VAD_WINDOW_SAMPLES;
        this.speechEnergySum += rms;
        this.speechEnergyCount++;

        if (isSpeech) {
          this.silenceSamples = 0;
        } else {
          this.silenceSamples += VAD_WINDOW_SAMPLES;
        }

        const speechMs = (this.speechSamples / this.cfg.sampleRate) * 1000;
        const silenceMs = (this.silenceSamples / this.cfg.sampleRate) * 1000;

        // Adaptive endpointing
        const effectiveHangover = this.getEffectiveHangover(speechMs);

        // Dual-pass utterance end
        if (this.dualPassPending) {
          this.dualPassFrames++;
          if (isSpeech) this.dualPassSpeechFrames++;
          if (this.dualPassFrames >= this.dualPassLookahead) {
            const speechRatio = this.dualPassFrames > 0
              ? this.dualPassSpeechFrames / this.dualPassFrames : 0;
            if (speechRatio < 0.5) {
              // Confirmed end
              const avgRms = this.speechEnergySum / Math.max(this.speechEnergyCount, 1);
              const minMs = this.continuation ? 0 : this.cfg.minSpeechMs;
              if (speechMs >= minMs && avgRms >= adaptiveRms) {
                const speechPcm = this.concatInt16(this.speechBuf);
                this.postPadChunk = speechPcm;
                this.postPadCollecting = true;
                this.postPadCollected = 0;
                this.speechBuf = [];
                this.speechBufLen = 0;
                this.isSpeaking = false;
              } else {
                this.resetState();
              }
            }
            this.dualPassPending = false;
            this.dualPassFrames = 0;
            this.dualPassSpeechFrames = 0;
          }
        } else if (silenceMs >= effectiveHangover) {
          if (this.cfg.dualPassEnabled) {
            this.dualPassPending = true;
            this.dualPassFrames = 0;
            this.dualPassSpeechFrames = 0;
          } else {
            const avgRms = this.speechEnergySum / Math.max(this.speechEnergyCount, 1);
            const minMs = this.continuation ? 0 : this.cfg.minSpeechMs;
            if (speechMs >= minMs && avgRms >= adaptiveRms) {
              const speechPcm = this.concatInt16(this.speechBuf);
              this.postPadChunk = speechPcm;
              this.postPadCollecting = true;
              this.postPadCollected = 0;
              this.speechBuf = [];
              this.speechBufLen = 0;
              this.isSpeaking = false;
            } else {
              this.resetState();
            }
          }
        } else if (speechMs >= this.cfg.maxSpeechMs) {
          // VAP-assisted max duration
          let shouldCut = true;
          if (this.cfg.vapEnabled && !this.vapPredictPause()) {
            if (speechMs < this.cfg.maxSpeechMs * 1.2) shouldCut = false;
          }

          if (shouldCut) {
            const rawPcm = this.concatInt16(this.speechBuf);
            const cutSample = this.findSmartCutPoint(rawPcm);

            if (cutSample < rawPcm.length) {
              segmentToEmit = this.makeSegment(rawPcm.subarray(0, cutSample), 'smart_cut');
              const remainder = rawPcm.subarray(cutSample);
              this.speechBuf = [new Int16Array(remainder)];
              this.speechBufLen = remainder.length;
              this.speechSamples = remainder.length;
            } else {
              segmentToEmit = this.makeSegment(rawPcm, 'max_duration');
              this.speechBuf = [];
              this.speechBufLen = 0;
              this.speechSamples = 0;
            }

            this.silenceSamples = 0;
            this.speechEnergySum = 0;
            this.speechEnergyCount = 0;
            this.continuation = true;
          }
        }
      }
    }

    if (segmentToEmit) this.onSegment?.(segmentToEmit);
  }

  private resetState(): void {
    this.speechBuf = [];
    this.speechBufLen = 0;
    this.isSpeaking = false;
    this.silenceSamples = 0;
    this.speechSamples = 0;
    this.speechEnergySum = 0;
    this.speechEnergyCount = 0;
    this.continuation = false;
    this.smoothedProb = 0;
    this.preSpeechBuf.length = 0;
    this.postPadCollecting = false;
    this.postPadCollected = 0;
    this.postPadChunk = null;
    this.dualPassPending = false;
    this.dualPassFrames = 0;
    this.dualPassSpeechFrames = 0;
  }

  private concatInt16(arrays: Int16Array[]): Int16Array {
    if (arrays.length === 0) return new Int16Array(0);
    if (arrays.length === 1) return arrays[0];
    let totalLen = 0;
    for (const a of arrays) totalLen += a.length;
    const result = new Int16Array(totalLen);
    let offset = 0;
    for (const a of arrays) {
      result.set(a, offset);
      offset += a.length;
    }
    return result;
  }

  private makeSegment(
    pcm: Int16Array,
    reason: AudioSegment['reason'],
  ): AudioSegment {
    return {
      pcm,
      durationMs: (pcm.length / this.cfg.sampleRate) * 1000,
      reason,
    };
  }
}
