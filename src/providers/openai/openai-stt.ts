/**
 * OpenAI STT (Speech-to-Text) Provider
 *
 * Supports: whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe, gpt-4o-transcribe-diarize
 */

import OpenAI from 'openai';
import type { ProviderId, ModelInfo, STTProvider, STTRequest, STTResponse } from '../types';
import { OPENAI_STT_MODELS } from './models';
import { prepareAudioFile } from '../openai-compat/audio-utils';

export class OpenAISTTProvider implements STTProvider {
  readonly providerId: ProviderId = 'openai';
  private client: OpenAI | null = null;

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('[OpenAI STT] OPENAI_API_KEY environment variable is not set');
      this.client = new OpenAI({ apiKey });
    }
    return this.client;
  }

  withApiKey(apiKey: string): OpenAISTTProvider {
    const provider = new OpenAISTTProvider();
    provider.client = new OpenAI({ apiKey });
    return provider;
  }

  getModels(): ModelInfo[] {
    return OPENAI_STT_MODELS;
  }

  isConfigured(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  async transcribe(request: STTRequest): Promise<STTResponse> {
    const client = this.getClient();
    const model = request.model || 'gpt-4o-transcribe';
    const file = await prepareAudioFile(request.audio);

    const params: OpenAI.Audio.TranscriptionCreateParams = {
      file,
      model,
      ...(request.language && { language: request.language }),
      ...(request.prompt && { prompt: request.prompt }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    };

    if (model === 'whisper-1') {
      params.response_format = (request.responseFormat as OpenAI.Audio.TranscriptionCreateParams['response_format']) || 'verbose_json';
    } else {
      params.response_format = request.responseFormat === 'text' ? 'text' : 'json';
    }

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
