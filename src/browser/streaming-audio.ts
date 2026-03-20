/**
 * StreamingAudioPlayer — plays WAV chunks progressively via Web Audio API
 * and exposes a MediaStream for real-time lip-sync (HeadAudio).
 *
 * Each chunk is expected to be a complete WAV with a 44-byte header.
 * The player strips headers, decodes PCM to Float32, and schedules
 * seamless playback using AudioBufferSourceNodes.
 */

import { createLogger } from './logger';

const log = createLogger('StreamingAudio');

/** WAV format info parsed from the first chunk's header. */
interface WavFormat {
  sampleRate: number;
  bitsPerSample: number;
  numChannels: number;
  bytesPerSample: number;
}

export class StreamingAudioPlayer {
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  /** Time (in AudioContext seconds) at which the next chunk should start. */
  private nextStartTime = 0;
  /** Whether we've scheduled the first chunk (need to set nextStartTime). */
  private started = false;

  private format: WavFormat | null = null;
  private destroyed = false;
  private ended = false;

  /** Total PCM samples scheduled so far (for duration tracking). */
  private totalSamplesScheduled = 0;

  /** Callbacks */
  onStarted: (() => void) | null = null;
  onEnded: (() => void) | null = null;

  /** Number of active source nodes (for end detection). */
  private activeSources = 0;
  private endCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** Track all scheduled source nodes so they can be stopped on destroy. */
  private sourceNodes: AudioBufferSourceNode[] = [];

  /**
   * Initialize the audio context and nodes.
   * Must be called before feedChunk (lazy-init on first chunk is also fine).
   */
  init(): void {
    if (this.audioCtx) return;

    this.audioCtx = new AudioContext();
    this.gainNode = this.audioCtx.createGain();
    this.destinationNode = this.audioCtx.createMediaStreamDestination();

    // Route: source → gain → destination (for MediaStream)
    // Also connect gain → audioCtx.destination (for speaker output)
    this.gainNode.connect(this.destinationNode);
    this.gainNode.connect(this.audioCtx.destination);

    this.started = false;
    this.ended = false;
    this.nextStartTime = 0;
    this.totalSamplesScheduled = 0;
    this.activeSources = 0;
    this.sourceNodes = [];

    log.debug('initialized, sampleRate:', this.audioCtx.sampleRate);
  }

  /**
   * Set playback volume (1.0 = normal, 2.0 = 2x louder, etc.).
   * Applies immediately to current and future chunks.
   */
  setVolume(value: number): void {
    if (this.gainNode && this.audioCtx) {
      this.gainNode.gain.setValueAtTime(value, this.audioCtx.currentTime);
    }
  }

  /**
   * Get the MediaStream for HeadAudio lip-sync.
   * Returns null if not initialized.
   */
  getMediaStream(): MediaStream | null {
    return this.destinationNode?.stream ?? null;
  }

  /**
   * Feed a WAV chunk for progressive playback.
   * Each chunk must have a 44-byte WAV header.
   */
  feedChunk(chunk: Uint8Array): void {
    if (this.destroyed) return;
    if (chunk.length <= 44) {
      log.debug('skipping tiny chunk:', chunk.length, 'bytes');
      return;
    }

    // Lazy init
    if (!this.audioCtx) this.init();

    // Parse format from first chunk
    if (!this.format) {
      this.format = this.parseWavHeader(chunk);
      if (!this.format) {
        log.warn('failed to parse WAV header, skipping chunk');
        return;
      }
      log.debug('format:', this.format.sampleRate, 'Hz,', this.format.bitsPerSample, 'bit,', this.format.numChannels, 'ch');
    }

    // Extract PCM data (skip 44-byte header)
    const pcmData = chunk.slice(44);
    if (pcmData.length === 0) return;

    // Convert PCM to Float32
    const float32 = this.pcmToFloat32(pcmData, this.format);
    if (float32.length === 0) return;

    // Schedule playback
    this.scheduleBuffer(float32, this.format);
  }

  /**
   * Signal that no more chunks will arrive.
   * The player will fire onEnded after all scheduled buffers finish.
   */
  finalize(): void {
    // The end detection happens via activeSources count
    // If all sources already ended (or no chunks were ever scheduled), fire now
    if (this.activeSources === 0) {
      this.fireEnded();
    }
    // Otherwise, the last source's onended will trigger it
  }

  /**
   * Stop playback and clean up all resources.
   */
  destroy(): void {
    log.debug('destroy() called, activeSources:', this.activeSources, 'sourceNodes:', this.sourceNodes.length);
    this.destroyed = true;
    if (this.endCheckTimer) {
      clearTimeout(this.endCheckTimer);
      this.endCheckTimer = null;
    }
    // Immediately mute to prevent any audible glitch before disconnecting
    if (this.gainNode && this.audioCtx) {
      try {
        this.gainNode.gain.setValueAtTime(0, this.audioCtx.currentTime);
      } catch { /* context may be closed */ }
    }
    // Stop all scheduled source nodes immediately (prevents lingering audio)
    for (const src of this.sourceNodes) {
      try { src.stop(); } catch { /* already stopped */ }
    }
    this.sourceNodes = [];
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    if (this.destinationNode) {
      this.destinationNode.disconnect();
      this.destinationNode = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(e => console.warn('[audio] context close failed:', e instanceof Error ? e.message : e));
      this.audioCtx = null;
    }
    this.format = null;
    this.started = false;
    this.activeSources = 0;
  }

  /** Current approximate playback duration scheduled (seconds). */
  get scheduledDuration(): number {
    if (!this.format) return 0;
    return this.totalSamplesScheduled / this.format.sampleRate;
  }

  // ── Private ──────────────────────────────────────────────────────────

  private parseWavHeader(chunk: Uint8Array): WavFormat | null {
    if (chunk.length < 44) return null;
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    // Verify RIFF header
    const riff = String.fromCharCode(chunk[0], chunk[1], chunk[2], chunk[3]);
    if (riff !== 'RIFF') {
      log.warn('not a RIFF header:', riff);
      return null;
    }

    // Verify WAVE descriptor at offset 8
    const wave = String.fromCharCode(chunk[8], chunk[9], chunk[10], chunk[11]);
    if (wave !== 'WAVE') {
      log.warn('not a WAVE file:', wave);
      return null;
    }

    const numChannels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);

    return {
      sampleRate,
      bitsPerSample,
      numChannels,
      bytesPerSample: bitsPerSample / 8,
    };
  }

  private pcmToFloat32(pcm: Uint8Array, format: WavFormat): Float32Array {
    const { bitsPerSample, bytesPerSample } = format;
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const numSamples = Math.floor(pcm.length / bytesPerSample);
    const float32 = new Float32Array(numSamples);

    if (bitsPerSample === 16) {
      for (let i = 0; i < numSamples; i++) {
        const sample = view.getInt16(i * 2, true);
        float32[i] = sample / 32768;
      }
    } else if (bitsPerSample === 24) {
      for (let i = 0; i < numSamples; i++) {
        const offset = i * 3;
        const sample = (view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getInt8(offset + 2) << 16));
        float32[i] = sample / 8388608;
      }
    } else if (bitsPerSample === 32) {
      // Assume 32-bit float PCM
      for (let i = 0; i < numSamples; i++) {
        float32[i] = view.getFloat32(i * 4, true);
      }
    } else {
      log.warn('unsupported bitsPerSample:', bitsPerSample);
      return new Float32Array(0);
    }

    return float32;
  }

  private scheduleBuffer(float32: Float32Array, format: WavFormat): void {
    if (!this.audioCtx || !this.gainNode) return;
    const ctx = this.audioCtx;
    const gain = this.gainNode;

    // AudioContext sampleRate may differ from source — create buffer at source rate
    // and let the browser resample
    const buffer = ctx.createBuffer(
      format.numChannels,
      Math.floor(float32.length / format.numChannels),
      format.sampleRate,
    );

    // Fill channel data (handle mono/stereo)
    const framesPerChannel = buffer.length;
    if (format.numChannels === 1) {
      buffer.getChannelData(0).set(float32.subarray(0, framesPerChannel));
    } else {
      // Interleaved → deinterleaved
      for (let ch = 0; ch < format.numChannels; ch++) {
        const channelData = buffer.getChannelData(ch);
        for (let i = 0; i < framesPerChannel; i++) {
          channelData[i] = float32[i * format.numChannels + ch];
        }
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);

    // Schedule the chunk
    if (!this.started) {
      // First chunk: start slightly ahead of currentTime to avoid glitches
      this.nextStartTime = ctx.currentTime + 0.02;
      this.started = true;
      log.debug('first chunk, starting at', this.nextStartTime.toFixed(3));
      this.onStarted?.();
    }

    source.start(this.nextStartTime);
    this.activeSources++;
    this.sourceNodes.push(source);

    const chunkDuration = buffer.duration;
    this.nextStartTime += chunkDuration;
    this.totalSamplesScheduled += framesPerChannel;

    source.onended = () => {
      this.activeSources--;
      // Remove from tracked nodes
      const idx = this.sourceNodes.indexOf(source);
      if (idx >= 0) this.sourceNodes.splice(idx, 1);
      if (this.activeSources === 0) {
        // Small delay to check if more chunks arrive
        this.endCheckTimer = setTimeout(() => {
          if (this.activeSources === 0 && !this.destroyed) {
            this.fireEnded();
          }
        }, 200);
      }
    };
  }

  private fireEnded(): void {
    if (this.ended) return;
    this.ended = true;
    log.debug('playback ended, total duration:', this.scheduledDuration.toFixed(2), 's');
    this.onEnded?.();
  }
}
