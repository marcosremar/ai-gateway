/**
 * OpenAI-compatible STT base class.
 * Any provider with an OpenAI-compatible /audio/transcriptions endpoint
 * can use this by providing { providerId, baseURL, envKey, models }.
 */

import OpenAI from 'openai';
import type { ProviderId, ModelInfo, STTProvider, STTRequest, STTResponse } from '../types';
import { prepareAudioFile } from './audio-utils';

export interface OpenAICompatSTTConfig {
  providerId: ProviderId;
  baseURL: string;
  envKey: string;
  models: ModelInfo[];
  defaultModel?: string;
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
      this.client = new OpenAI({ apiKey, baseURL: this.config.baseURL });
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
      response_format: request.responseFormat === 'text' ? 'text' : 'verbose_json',
    };

    const transcription = await client.audio.transcriptions.create(params);

    if (typeof transcription === 'string') {
      return { text: transcription };
    }

    const response: STTResponse = { text: transcription.text, raw: transcription };

    if ('language' in transcription && transcription.language) {
      response.language = transcription.language as string;
    }
    if ('duration' in transcription && transcription.duration) {
      response.duration = transcription.duration as number;
    }
    if ('words' in transcription && Array.isArray(transcription.words)) {
      response.words = (transcription.words as Array<{ word: string; start: number; end: number }>).map((w) => ({
        word: w.word, start: w.start, end: w.end,
      }));
    }

    return response;
  }
}
