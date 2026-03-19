/**
 * Ollama Provider — local LLM inference via OpenAI-compatible API.
 *
 * Ollama runs at http://localhost:11434 and exposes /v1/chat/completions.
 * No API key is required — we use 'ollama' as a placeholder for the OpenAI SDK.
 *
 * For STT, Ollama itself doesn't support Whisper, but a local faster-whisper-server
 * (https://github.com/fedirz/faster-whisper-server) exposes the same OpenAI-compatible
 * /v1/audio/transcriptions endpoint. Default: http://localhost:8000/v1.
 */

import OpenAI from 'openai';
import type {
  ProviderId,
  ModelInfo,
  STTProvider,
  STTRequest,
  STTResponse,
  LLMProvider,
  ChatRequest,
  ChatResponse,
} from '../types';
import { prepareAudioFile } from '../openai-compat/audio-utils';
import { OLLAMA_STT_MODELS, OLLAMA_LLM_MODELS } from './models';

const OLLAMA_BASE_URL = 'http://localhost:11434/v1';
const WHISPER_SERVER_BASE_URL = 'http://localhost:8000/v1';

// ---------------------------------------------------------------------------
// Ollama LLM Provider
// ---------------------------------------------------------------------------

export class OllamaLLMProvider implements LLMProvider {
  readonly providerId: ProviderId = 'ollama' as ProviderId;
  private client: OpenAI;
  private readonly baseURL: string;
  private readonly _defaultModel: string;

  constructor(baseURL: string = OLLAMA_BASE_URL, defaultModel?: string) {
    this.baseURL = baseURL;
    this._defaultModel = defaultModel || 'llama3.2';
    this.client = new OpenAI({ apiKey: 'ollama', baseURL: this.baseURL });
  }

  isConfigured(): boolean {
    return true; // Ollama doesn't need an API key
  }

  withApiKey(): OllamaLLMProvider {
    return this; // no-op, Ollama doesn't use keys
  }

  withConfig(opts: { apiKey: string; baseURL?: string }): OllamaLLMProvider {
    if (opts.baseURL) {
      return new OllamaLLMProvider(opts.baseURL, this._defaultModel);
    }
    return this;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const completion = await this.client.chat.completions.create({
      model: request.model || this._defaultModel,
      messages: request.messages as Parameters<typeof this.client.chat.completions.create>[0]['messages'],
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
      ...(request.responseFormat && { response_format: request.responseFormat }),
    });

    return {
      content: completion.choices[0]?.message?.content || '',
      model: completion.model,
      usage: completion.usage ? {
        promptTokens: completion.usage.prompt_tokens,
        completionTokens: completion.usage.completion_tokens,
        totalTokens: completion.usage.total_tokens,
      } : undefined,
      raw: completion,
    };
  }
}

// ---------------------------------------------------------------------------
// Local Whisper STT Provider (faster-whisper-server)
// ---------------------------------------------------------------------------

export class OllamaSTTProvider implements STTProvider {
  readonly providerId: ProviderId = 'ollama' as ProviderId;
  private client: OpenAI;
  private readonly baseURL: string;
  private readonly _defaultModel: string;
  private readonly models: ModelInfo[];

  constructor(baseURL: string = WHISPER_SERVER_BASE_URL, defaultModel?: string) {
    this.baseURL = baseURL;
    this._defaultModel = defaultModel || 'whisper-large-v3-turbo';
    this.models = OLLAMA_STT_MODELS;
    this.client = new OpenAI({ apiKey: 'not-needed', baseURL: this.baseURL });
  }

  getModels(): ModelInfo[] { return this.models; }
  isConfigured(): boolean { return true; }

  withApiKey(): OllamaSTTProvider {
    return this; // no-op
  }

  async transcribe(request: STTRequest): Promise<STTResponse> {
    const model = request.model || this._defaultModel;
    const file = await prepareAudioFile(request.audio);

    const params: OpenAI.Audio.TranscriptionCreateParams = {
      file,
      model,
      ...(request.language && { language: request.language }),
      ...(request.prompt && { prompt: request.prompt }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      response_format: request.responseFormat === 'text' ? 'text' : 'verbose_json',
    };

    const transcription = await this.client.audio.transcriptions.create(params);

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

// ---------------------------------------------------------------------------
// Singleton instances (with default endpoints)
// ---------------------------------------------------------------------------

export const ollamaLLM = new OllamaLLMProvider();
export const ollamaSTT = new OllamaSTTProvider();

export { OLLAMA_STT_MODELS, OLLAMA_LLM_MODELS } from './models';
