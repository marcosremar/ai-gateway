/**
 * OpenAI-compatible TTS base class.
 * Any provider with an OpenAI-compatible /audio/speech endpoint
 * can use this by providing { providerId, baseURL, envKey, models, voices }.
 */

import OpenAI from 'openai';
import type { ProviderId, ModelInfo, TTSAudioFormat, TTSProvider, TTSRequest, TTSResponse, VoiceInfo } from '../types';
import { getOrCreateClient } from './client-cache';

const FORMAT_TO_CONTENT_TYPE: Record<TTSAudioFormat, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

export interface OpenAICompatTTSConfig {
  providerId: ProviderId;
  baseURL: string;
  envKey: string;
  models: ModelInfo[];
  voices: VoiceInfo[];
  defaultModel?: string;
  defaultVoice?: string;
  defaultFormat?: TTSAudioFormat;
  /** When set, only these formats are accepted. If the request asks for a
   *  format not in this list (e.g. 'mp3' but the model only supports 'wav'),
   *  the provider silently falls back to `defaultFormat`. */
  allowedFormats?: TTSAudioFormat[];
  /** Send the requested voice as-is (aggregators whose voices depend on the model, e.g. OpenRouter). */
  passthroughVoices?: boolean;
}

export class OpenAICompatTTSProvider implements TTSProvider {
  readonly providerId: ProviderId;
  protected client: OpenAI | null = null;
  private readonly config: OpenAICompatTTSConfig;
  private readonly voiceIds: Set<string>;

  constructor(config: OpenAICompatTTSConfig) {
    this.config = config;
    this.providerId = config.providerId;
    this.voiceIds = new Set(config.voices.map((v) => v.id));
  }

  /** Return the requested voice if this provider supports it, otherwise the default. */
  private resolveVoice(requested?: string): string {
    if (requested && (this.config.passthroughVoices || this.voiceIds.has(requested))) return requested;
    return this.config.defaultVoice || 'alloy';
  }

  /** True when the client was built from an explicit key (withApiKey/withConfig): never swapped for the env key. */
  private pinnedClient = false;

  /**
   * The key is read from the environment on EVERY call, so a key rotated at runtime (KeyManager reload) is used by
   * the next request. Clients are shared per baseURL + key hash (client-cache), so this costs a hash lookup.
   */
  protected getClient(): OpenAI {
    if (this.client && this.pinnedClient) return this.client;
    const apiKey = process.env[this.config.envKey];
    if (!apiKey) throw new Error(`[${this.config.providerId} TTS] ${this.config.envKey} is not set`);
    this.client = getOrCreateClient(this.config.baseURL, apiKey);
    return this.client;
  }

  withApiKey(apiKey: string): OpenAICompatTTSProvider {
    const provider = new OpenAICompatTTSProvider(this.config);
    provider.pinnedClient = true;
    provider.client = new OpenAI({ apiKey, baseURL: this.config.baseURL });
    return provider;
  }

  getModels(): ModelInfo[] { return this.config.models; }
  getVoices(): VoiceInfo[] { return this.config.voices; }
  isConfigured(): boolean { return !!process.env[this.config.envKey]; }

  private resolveFormat(requested?: TTSAudioFormat): TTSAudioFormat {
    const fmt = requested || this.config.defaultFormat || 'mp3';
    const allowed = this.config.allowedFormats;
    return (allowed && !allowed.includes(fmt)) ? (this.config.defaultFormat || 'wav') : fmt;
  }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    const client = this.getClient();
    const format = this.resolveFormat(request.responseFormat);

    const params: OpenAI.Audio.SpeechCreateParams = {
      model: request.model || this.config.defaultModel || this.config.models[0]?.id,
      input: request.input,
      voice: this.resolveVoice(request.voice) as OpenAI.Audio.SpeechCreateParams['voice'],
      response_format: format as OpenAI.Audio.SpeechCreateParams['response_format'],
      ...(request.speed && { speed: request.speed }),
      ...(request.instructions && { instructions: request.instructions }),
    };

    const response = await client.audio.speech.create(params, request.signal ? { signal: request.signal } : undefined);
    const arrayBuffer = await response.arrayBuffer();
    return { audio: Buffer.from(arrayBuffer), contentType: FORMAT_TO_CONTENT_TYPE[format] || 'audio/mpeg' };
  }

  async synthesizeStream(request: TTSRequest): Promise<ReadableStream<Uint8Array>> {
    const client = this.getClient();
    const format = this.resolveFormat(request.responseFormat);

    const params: OpenAI.Audio.SpeechCreateParams = {
      model: request.model || this.config.defaultModel || this.config.models[0]?.id,
      input: request.input,
      voice: this.resolveVoice(request.voice) as OpenAI.Audio.SpeechCreateParams['voice'],
      response_format: format as OpenAI.Audio.SpeechCreateParams['response_format'],
      ...(request.speed && { speed: request.speed }),
      ...(request.instructions && { instructions: request.instructions }),
    };

    const response = await client.audio.speech.create(params, request.signal ? { signal: request.signal } : undefined);

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
