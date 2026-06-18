/**
 * OpenAI TTS (Text-to-Speech) Provider
 *
 * Supports: gpt-4o-mini-tts, tts-1, tts-1-hd
 */

import OpenAI from 'openai';
import type { ProviderId, ModelInfo, TTSAudioFormat, TTSProvider, TTSRequest, TTSResponse, VoiceInfo } from '../types';
import { OPENAI_TTS_MODELS, OPENAI_VOICES, getVoicesForModel } from './models';

const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts-2025-03-20';

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

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('[OpenAI TTS] OPENAI_API_KEY environment variable is not set');
      this.client = new OpenAI({ apiKey });
    }
    return this.client;
  }

  /** Validate the requested voice against the voices the *target model* actually
   *  supports; fall back to 'coral' (valid on every OpenAI TTS model) otherwise.
   *  Voices like ballad/verse/marin/cedar only exist on gpt-4o-mini-tts — sending
   *  them to tts-1 / tts-1-hd is a 400, so this must be per-model, not the union
   *  of all voice ids. */
  private resolveVoice(requested: string | undefined, model: string): string {
    if (requested && getVoicesForModel(model).some(v => v.id === requested)) return requested;
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

    const model = request.model || DEFAULT_TTS_MODEL;
    const params: OpenAI.Audio.SpeechCreateParams = {
      model,
      input: request.input,
      voice: this.resolveVoice(request.voice, model) as OpenAI.Audio.SpeechCreateParams['voice'],
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

    const model = request.model || DEFAULT_TTS_MODEL;
    const params: OpenAI.Audio.SpeechCreateParams = {
      model,
      input: request.input,
      voice: this.resolveVoice(request.voice, model) as OpenAI.Audio.SpeechCreateParams['voice'],
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
