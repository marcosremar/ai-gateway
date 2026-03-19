/**
 * OpenAI-compatible STT base class.
 * Any provider with an OpenAI-compatible /audio/transcriptions endpoint
 * can use this by providing { providerId, baseURL, envKey, models }.
 */

import OpenAI from 'openai';
import type { ProviderId, ModelInfo, STTProvider, STTRequest, STTResponse } from '../types';
import { prepareAudioFile } from './audio-utils';
import { getOrCreateClient } from './client-cache';

export interface OpenAICompatSTTConfig {
  providerId: ProviderId;
  baseURL: string;
  envKey: string;
  models: ModelInfo[];
  defaultModel?: string;
  /** Override default response_format. Some models (gpt-4o-transcribe) only support 'json'. */
  defaultResponseFormat?: 'json' | 'verbose_json' | 'text';
}

export class OpenAICompatSTTProvider implements STTProvider {
  readonly providerId: ProviderId;
  protected client: OpenAI | null = null;
  private readonly config: OpenAICompatSTTConfig;

  constructor(config: OpenAICompatSTTConfig) {
    this.config = config;
    this.providerId = config.providerId;
  }

  protected getClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env[this.config.envKey];
      if (!apiKey) throw new Error(`[${this.config.providerId} STT] ${this.config.envKey} is not set`);
      this.client = getOrCreateClient(this.config.baseURL, apiKey);
    }
    return this.client;
  }

  withApiKey(apiKey: string): OpenAICompatSTTProvider {
    const provider = new OpenAICompatSTTProvider(this.config);
    provider.client = new OpenAI({ apiKey, baseURL: this.config.baseURL });
    return provider;
  }

  getModels(): ModelInfo[] { return this.config.models; }
  isConfigured(): boolean { return !!process.env[this.config.envKey]; }

  async transcribe(request: STTRequest): Promise<STTResponse> {
    const client = this.getClient();
    const model = request.model || this.config.defaultModel || this.config.models[0]?.id;
    const file = await prepareAudioFile(request.audio);

    const params: OpenAI.Audio.TranscriptionCreateParams = {
      file,
      model,
      ...(request.language && { language: request.language }),
      ...(request.prompt && { prompt: request.prompt }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      response_format: request.responseFormat === 'text' ? 'text'
        : (request.wordTimestamps && this.config.defaultResponseFormat !== 'json')
          ? 'verbose_json'
          : (this.config.defaultResponseFormat ?? 'verbose_json'),
      ...(request.wordTimestamps && this.config.defaultResponseFormat !== 'json' && { timestamp_granularities: ['word'] }),
    };

    const t0 = Date.now();
    const transcription = await client.audio.transcriptions.create(params);
    const total_ms = Date.now() - t0;

    if (typeof transcription === 'string') {
      return { text: transcription, timing: { total_ms } };
    }

    const response: STTResponse = { text: transcription.text, raw: transcription };

    if ('language' in transcription && typeof transcription.language === 'string') {
      response.language = transcription.language;
    }
    if ('duration' in transcription && typeof transcription.duration === 'number') {
      response.duration = transcription.duration;
    }
    if ('words' in transcription && Array.isArray(transcription.words)) {
      response.words = (transcription.words as unknown[])
        .filter((w): w is { word: string; start: number; end: number } =>
          typeof (w as Record<string, unknown>)?.word === 'string' &&
          typeof (w as Record<string, unknown>)?.start === 'number' &&
          typeof (w as Record<string, unknown>)?.end === 'number',
        )
        .map((w) => ({ word: w.word, start: w.start, end: w.end }));
    }

    // Extract server-side processing time if the provider returned it (e.g. our Modal endpoints)
    const raw = transcription as unknown as Record<string, unknown>;
    const server_ms = typeof raw['processing_ms'] === 'number' ? raw['processing_ms'] as number : undefined;

    response.timing = server_ms !== undefined
      ? { total_ms, server_ms, network_ms: total_ms - server_ms }
      : { total_ms };

    return response;
  }
}
