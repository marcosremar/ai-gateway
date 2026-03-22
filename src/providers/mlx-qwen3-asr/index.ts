/**
 * MLX Qwen3-ASR Provider — local STT inference via mlx-qwen3-asr server.
 *
 * Runs on Apple Silicon using MLX (Metal GPU). Exposes OpenAI-compatible
 * /v1/audio/transcriptions endpoint.
 *
 * Install:  pip install "mlx-qwen3-asr[serve]"
 * Start:    mlx-qwen3-asr serve --model mlx-community/Qwen3-ASR-0.6B-4bit --port 8765
 *
 * Supports 4-bit quantization (55x realtime) and fp16 (12x realtime).
 * 30 languages including Portuguese. WER: 3.9% (1.7B) / 6.2% (0.6B) on FLEURS pt.
 */

import OpenAI from 'openai';
import type {
  ProviderId,
  ModelInfo,
  STTProvider,
  STTRequest,
  STTResponse,
} from '../types';
import { prepareAudioFile } from '../openai-compat/audio-utils';
import { MLX_QWEN3_ASR_MODELS } from './models';

const DEFAULT_BASE_URL = 'http://localhost:8765/v1';

export class MlxQwen3AsrProvider implements STTProvider {
  readonly providerId: ProviderId = 'mlx-qwen3-asr';
  private client: OpenAI;
  private readonly baseURL: string;
  private readonly _defaultModel: string;
  private readonly models: ModelInfo[];

  constructor(baseURL: string = DEFAULT_BASE_URL, apiKey?: string, defaultModel?: string) {
    this.baseURL = baseURL;
    this._defaultModel = defaultModel || 'qwen3-asr';
    this.models = MLX_QWEN3_ASR_MODELS;
    this.client = new OpenAI({
      apiKey: apiKey || 'not-needed',
      baseURL: this.baseURL,
    });
  }

  getModels(): ModelInfo[] { return this.models; }
  isConfigured(): boolean { return true; }

  withApiKey(apiKey: string): MlxQwen3AsrProvider {
    return new MlxQwen3AsrProvider(this.baseURL, apiKey, this._defaultModel);
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
      response_format: request.responseFormat === 'text' ? 'text' : 'json',
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
    return response;
  }
}

// Singleton instance (with default endpoint)
export const mlxQwen3AsrSTT = new MlxQwen3AsrProvider();

/**
 * Recommended streaming settings for MLX Qwen3-ASR (tested on Apple Silicon M5).
 *
 * Rolling window approach: each request sends the last N chunks together,
 * so the model revises previous text with more context. The last window
 * response IS the final result — no retranscription needed.
 */
export const MLX_QWEN3_ASR_STREAMING_DEFAULTS = {
  /** Minimum chunk audio before sending (bytes, 16kHz 16-bit mono). ~3s */
  minChunkBytes: 96_000,
  /** Maximum chunk audio before force-sending (bytes). ~7s */
  maxChunkBytes: 224_000,
  /** Minimum silence duration to trigger chunk send (seconds). */
  microPauseDuration: 0.5,
  /** Number of recent chunks to include in each rolling window request. */
  rollingWindowSize: 5,
  /** Whether to skip full retranscription (rolling window = final result). */
  skipRetranscription: true,
} as const;

export { MLX_QWEN3_ASR_MODELS } from './models';
