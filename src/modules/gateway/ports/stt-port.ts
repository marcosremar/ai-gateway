/**
 * SttPort — Speech-to-Text capability port.
 *
 * Domain-level contract for transcription. Implementations (Groq, Fireworks,
 * GPU Whisper, etc.) are adapters that implement this port. Use cases depend
 * on this port, never on concrete providers.
 */

export interface TranscribeRequest {
  /** Raw audio buffer (WAV/MP3/etc.) */
  audio: Buffer;
  /** ISO 639-1 language code hint. `'auto'` = detect. */
  language?: string;
  /** Optional prompt for STT context (some providers). */
  prompt?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

export interface Transcription {
  /** Transcribed text. */
  text: string;
  /** Detected language (ISO 639-1). */
  language?: string;
  /** Confidence score 0-1 (if provider returns one). */
  confidence?: number;
  /** Latency in ms, measured by the adapter. */
  latencyMs: number;
  /** Model identifier used by the adapter. */
  model?: string;
}

export interface SttPort {
  transcribe(request: TranscribeRequest): Promise<Transcription>;
}
