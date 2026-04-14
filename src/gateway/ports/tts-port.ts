/**
 * TtsPort — Text-to-Speech capability port.
 *
 * Domain-level contract for speech synthesis. Supports optional voice cloning
 * via a reference audio + transcript pair.
 */

export interface SynthesizeRequest {
  text: string;
  /** Voice identifier (provider-specific, e.g. 'autumn', 'clone:user42'). */
  voice: string;
  /** ISO 639-1 language code. */
  language?: string;
  /** Optional reference for voice cloning. */
  clone?: {
    referenceAudio: Buffer;
    referenceTranscript: string;
  };
  /** Output format. */
  format?: 'wav' | 'mp3' | 'pcm';
  timeoutMs?: number;
}

export interface SynthesizedAudio {
  audio: Buffer;
  format: 'wav' | 'mp3' | 'pcm';
  sampleRate: number;
  durationMs?: number;
  latencyMs: number;
  model?: string;
}

export interface TtsPort {
  synthesize(request: SynthesizeRequest): Promise<SynthesizedAudio>;
}
