/**
 * GroqSttAdapter — bridges the existing Groq provider (src/gateway/providers/cloud/groq)
 * to the domain-level SttPort.
 *
 * Demonstrates the adapter pattern: the use case depends only on SttPort,
 * but production wiring uses this adapter to get real transcription.
 */

import type { SttPort, TranscribeRequest, Transcription } from '../ports/stt-port';

/**
 * Minimal interface the adapter needs from the existing Groq provider.
 * Kept loose so we don't couple to the full Groq class surface.
 */
export interface GroqSttClient {
  transcribe(request: {
    audio: Buffer;
    model: string;
    language?: string;
  }): Promise<{
    text: string;
    language?: string;
    duration?: number;
  }>;
}

export class GroqSttAdapter implements SttPort {
  constructor(
    private readonly client: GroqSttClient,
    private readonly defaultModel: string = 'whisper-large-v3-turbo',
  ) {}

  async transcribe(request: TranscribeRequest): Promise<Transcription> {
    const startedAt = Date.now();
    const raw = await this.client.transcribe({
      audio: request.audio,
      model: this.defaultModel,
      language: request.language === 'auto' ? undefined : request.language,
    });
    return {
      text: raw.text,
      language: raw.language,
      latencyMs: Date.now() - startedAt,
      model: this.defaultModel,
    };
  }
}
