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
  /** Target volume (saved for fade-in). */
  private targetVolume = 1;

  /** Callbacks */
  onStarted: (() => void) | null = null;
  onEnded: (() => void) | null = null;

  /** Number of active source nodes (for end detection). */
  private activeSources = 0;
  private endCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** Track all scheduled source nodes so they can be stopped on destroy. */
  private sourceNodes: AudioBufferSourceNode[] = [];

  /** Web Worker for off-main-thread PCM decoding. */
  private decodeWorker: Worker | null = null;
  private workerBlobUrl: string | null = null;
  private workerMsgId = 0;
  private workerCallbacks = new Map<number, (float32: Float32Array) => void>();

  /**
   * Initialize the audio context and nodes.
   * Must be called before feedChunk (lazy-init on first chunk is also fine).
   */
  init(): void {
    if (this.audioCtx) return;

    this.audioCtx = new AudioContext();
    this.gainNode = this.audioCtx.createGain();
    // Start at zero to prevent any click/pop on AudioContext creation
    this.gainNode.gain.setValueAtTime(0, this.audioCtx.currentTime);
    this.destinationNode = this.audioCtx.createMediaStreamDestination();

    // Route: source → gain → speakers (volume-controlled)
    //         source → destinationNode (unity gain for lip-sync MediaStream)
    // This keeps the MediaStream at natural volume so HeadAudio gets
    // consistent amplitude regardless of the user's volume setting.
    this.gainNode.connect(this.audioCtx.destination);
    // Lip-sync stream: bypass gainNode — connect sources directly at unity gain
    // We'll connect sources to destinationNode in scheduleBuffer instead.

    this.started = false;
    this.ended = false;
    this.nextStartTime = 0;
    this.totalSamplesScheduled = 0;
    this.activeSources = 0;
    this.sourceNodes = [];

    // Spin up decode Worker (offloads pcmToFloat32 off main thread)
    this.initWorker();

    log.debug('initialized, sampleRate:', this.audioCtx.sampleRate);
  }

  /** Create Web Worker for PCM decoding using inline blob (avoids separate file). */
  private initWorker(): void {
    if (this.decodeWorker) return;
    try {
      const code = `self.onmessage=function(e){var d=e.data,p=d.pcm,b=d.bitsPerSample,bs=d.bytesPerSample,id=d.id;var v=new DataView(p.buffer,p.byteOffset,p.byteLength);var n=Math.floor(p.length/bs);var f=new Float32Array(n);if(b===16){for(var i=0;i<n;i++)f[i]=v.getInt16(i*2,true)/32768}else if(b===24){for(var i=0;i<n;i++){var o=i*3;f[i]=(v.getUint8(o)|(v.getUint8(o+1)<<8)|(v.getInt8(o+2)<<16))/8388608}}else if(b===32){for(var i=0;i<n;i++)f[i]=v.getFloat32(i*4,true)}self.postMessage({float32:f,id:id},[f.buffer])}`;
      const blob = new Blob([code], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      this.workerBlobUrl = blobUrl;
      this.decodeWorker = new Worker(blobUrl);
      this.decodeWorker.onmessage = (e: MessageEvent) => {
        const { float32, id } = e.data as { float32: Float32Array; id: number };
        const cb = this.workerCallbacks.get(id);
        if (cb) {
          this.workerCallbacks.delete(id);
          cb(float32);
        }
      };
    } catch {
      log.debug('Worker unavailable, falling back to main-thread decode');
      this.decodeWorker = null;
    }
  }

  /** Decode PCM via Worker (async) or fall back to main-thread sync. */
  private decodePCM(pcm: Uint8Array, format: WavFormat): Promise<Float32Array> {
    if (this.decodeWorker) {
      return new Promise((resolve) => {
        const id = ++this.workerMsgId;
        this.workerCallbacks.set(id, resolve);
        // Transfer pcm buffer to worker (zero-copy)
        const copy = pcm.slice(); // copy because original may be reused
        this.decodeWorker!.postMessage(
          { pcm: copy, bitsPerSample: format.bitsPerSample, bytesPerSample: format.bytesPerSample, id },
          [copy.buffer] as unknown as Transferable[],
        );
      });
    }
    // Fallback: main-thread decode
    return Promise.resolve(this.pcmToFloat32(pcm, format));
  }

  /**
   * Set playback volume (1.0 = normal, 2.0 = 2x louder, etc.).
   * Applies immediately to current and future chunks.
   */
  setVolume(value: number): void {
    this.targetVolume = value;
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
   * Disconnect from default speakers (for VR spatial audio routing).
   * Audio still flows to the MediaStream destination for lip-sync.
   */
  disconnectSpeakers(): void {
    if (this.gainNode && this.audioCtx) {
      try { this.gainNode.disconnect(this.audioCtx.destination); } catch { /* not connected */ }
    }
  }

  /**
   * Reconnect to default speakers (when exiting VR).
   */
  reconnectSpeakers(): void {
    if (this.gainNode && this.audioCtx) {
      try { this.gainNode.connect(this.audioCtx.destination); } catch { /* already connected */ }
    }
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

    // Decode PCM to Float32 (off main thread via Worker when available)
    const fmt = this.format;
    this.decodePCM(pcmData, fmt).then((float32) => {
      if (this.destroyed || float32.length === 0) return;
      this.scheduleBuffer(float32, fmt);
    });
  }

  /**
   * Signal that no more chunks will arrive.
   * Applies a short fade-out to prevent click/pop at the end,
   * then fires onEnded after all scheduled buffers finish.
   */
  finalize(): void {
    // Apply fade-out ramp before the last scheduled audio ends.
    // This prevents the click/pop when audio abruptly stops.
    if (this.gainNode && this.audioCtx && this.nextStartTime > this.audioCtx.currentTime) {
      const fadeOutMs = 0.02; // 20ms
      const endTime = this.nextStartTime;
      this.gainNode.gain.setValueAtTime(this.targetVolume, Math.max(endTime - fadeOutMs, this.audioCtx.currentTime));
      this.gainNode.gain.linearRampToValueAtTime(0, endTime);
    }

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
    // Terminate decode worker
    if (this.decodeWorker) {
      this.decodeWorker.terminate();
      this.decodeWorker = null;
      this.workerCallbacks.clear();
    }
    if (this.workerBlobUrl) {
      URL.revokeObjectURL(this.workerBlobUrl);
      this.workerBlobUrl = null;
    }
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

    // Apply PCM-level fade-in on the first chunk to eliminate click/pop.
    // TTS models (Kokoro, etc.) often start with high-amplitude samples.
    // Modifying the buffer directly ensures both speakers and lip-sync
    // MediaStream receive the faded audio.
    if (!this.started) {
      const fadeInSamples = Math.min(Math.floor(format.sampleRate * 0.015), framesPerChannel); // 15ms
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const channelData = buffer.getChannelData(ch);
        for (let i = 0; i < fadeInSamples; i++) {
          channelData[i] *= i / fadeInSamples;
        }
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    // Also connect to MediaStream destination at unity gain for lip-sync analysis
    if (this.destinationNode) {
      source.connect(this.destinationNode);
    }

    // Schedule the chunk
    if (!this.started) {
      // First chunk: start slightly ahead of currentTime to avoid glitches
      this.nextStartTime = ctx.currentTime + 0.05;
      this.started = true;

      // Ramp gain from 0 to target as an extra safety net
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(this.targetVolume, this.nextStartTime);

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
