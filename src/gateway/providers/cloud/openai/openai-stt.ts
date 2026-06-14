/**
 * OpenAI STT (Speech-to-Text) Provider
 *
 * Supports: whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe, gpt-4o-transcribe-diarize
 */

import OpenAI from 'openai';
import type { ProviderId, ModelInfo, STTProvider, STTRequest, STTResponse } from '../types';
import { OPENAI_STT_MODELS } from './models';
import { prepareAudioFile } from '../openai-compat/audio-utils';
import { getOrCreateClient } from '../openai-compat/client-cache';

/** OpenAI API base used for the shared client-cache key. */
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Default OpenAI STT model when the caller doesn't specify one. The mini
 * transcription model is materially cheaper per minute than gpt-4o-transcribe
 * (#367). Exported as a pure helper so the default can be unit-tested without
 * constructing the OpenAI SDK client.
 */
export const DEFAULT_OPENAI_STT_MODEL = 'gpt-4o-mini-transcribe';
export function resolveOpenAISttModel(requested?: string): string {
  return requested || DEFAULT_OPENAI_STT_MODEL;
}

export class OpenAISTTProvider implements STTProvider {
  readonly providerId: ProviderId = 'openai';
  private client: OpenAI | null = null;

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('[OpenAI STT] OPENAI_API_KEY environment variable is not set');
      // Route through the shared client cache (#373) so OpenAI STT + TTS +
      // embeddings sharing the same key reuse one connection pool instead of
      // each opening its own (extra TLS handshakes on cold start).
      this.client = getOrCreateClient(OPENAI_BASE_URL, apiKey);
    }
    return this.client;
  }

  withApiKey(apiKey: string): OpenAISTTProvider {
    const provider = new OpenAISTTProvider();
    provider.client = getOrCreateClient(OPENAI_BASE_URL, apiKey);
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
    // Default to the cheaper mini transcription model (#367). gpt-4o-transcribe
    // is the priciest per-minute option; callers can still opt up by passing
    // request.model explicitly. Large per-minute STT savings for the common path.
    const model = resolveOpenAISttModel(request.model);
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
      if (request.wordTimestamps) {
        (params as unknown as Record<string, unknown>).timestamp_granularities = ['word'];
      }
    } else {
      // gpt-4o-transcribe models only support 'json' | 'text' — no word timestamps
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
