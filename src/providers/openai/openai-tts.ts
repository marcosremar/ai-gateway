/**
 * OpenAI TTS (Text-to-Speech) Provider
 *
 * Supports: gpt-4o-mini-tts, tts-1, tts-1-hd
 */

import OpenAI from 'openai';
import type { ProviderId, ModelInfo, TTSAudioFormat, TTSProvider, TTSRequest, TTSResponse, VoiceInfo } from '../types';
import { OPENAI_TTS_MODELS, OPENAI_VOICES } from './models';

const FORMAT_TO_CONTENT_TYPE: Record<TTSAudioFormat, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

export class OpenAITTSProvider implements TTSProvider {
  readonly providerId: ProviderId = 'openai';
  private client: OpenAI | null = null;
  private readonly voiceIds: Set<string>;

  constructor() {
    this.voiceIds = new Set(OPENAI_VOICES.map(v => v.id));
  }

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('[OpenAI TTS] OPENAI_API_KEY environment variable is not set');
      this.client = new OpenAI({ apiKey });
    }
    return this.client;
  }

  /** Validate voice against known OpenAI voices; fallback to 'coral' for unknown names. */
  private resolveVoice(requested?: string): string {
    if (requested && this.voiceIds.has(requested)) return requested;
    return 'coral';
  }

  withApiKey(apiKey: string): OpenAITTSProvider {
    const provider = new OpenAITTSProvider();
    provider.client = new OpenAI({ apiKey });
    return provider;
  }

  getModels(): ModelInfo[] { return OPENAI_TTS_MODELS; }
  getVoices(): VoiceInfo[] { return OPENAI_VOICES; }
  isConfigured(): boolean { return !!process.env.OPENAI_API_KEY; }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    const client = this.getClient();
    const format = request.responseFormat || 'mp3';

    const params: OpenAI.Audio.SpeechCreateParams = {
      model: request.model || 'gpt-4o-mini-tts-2025-03-20',
      input: request.input,
      voice: this.resolveVoice(request.voice) as OpenAI.Audio.SpeechCreateParams['voice'],
      response_format: format as OpenAI.Audio.SpeechCreateParams['response_format'],
      ...(request.speed && { speed: request.speed }),
      ...(request.instructions && { instructions: request.instructions }),
    };

    const response = await client.audio.speech.create(params);
    const arrayBuffer = await response.arrayBuffer();
    return { audio: Buffer.from(arrayBuffer), contentType: FORMAT_TO_CONTENT_TYPE[format] || 'audio/mpeg' };
  }

  async synthesizeStream(request: TTSRequest): Promise<ReadableStream<Uint8Array>> {
    const client = this.getClient();
    const format = request.responseFormat || 'mp3';

    const params: OpenAI.Audio.SpeechCreateParams = {
      model: request.model || 'gpt-4o-mini-tts-2025-03-20',
      input: request.input,
      voice: this.resolveVoice(request.voice) as OpenAI.Audio.SpeechCreateParams['voice'],
      response_format: format as OpenAI.Audio.SpeechCreateParams['response_format'],
      ...(request.speed && { speed: request.speed }),
      ...(request.instructions && { instructions: request.instructions }),
    };

    const response = await client.audio.speech.create(params);

    if (response.body) {
      return response.body as unknown as ReadableStream<Uint8Array>;
    }

    const arrayBuffer = await response.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    return new ReadableStream({
      start(controller) { controller.enqueue(uint8); controller.close(); },
    });
  }
}
