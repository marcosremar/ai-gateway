/**
 * Self-hosted providers (Vast.ai, TensorDock, RunPod).
 * Uses OpenAI SDK with a dynamic endpoint. No API key required for inference.
 * The endpoint is set at runtime via withEndpoint().
 */

import OpenAI from 'openai';
import type { ProviderId, ModelInfo, STTProvider, STTRequest, STTResponse, TTSProvider, TTSRequest, TTSResponse, TTSAudioFormat, VoiceInfo, LLMProvider, ChatRequest, ChatResponse } from '../types';
import { prepareAudioFile } from '../openai-compat/audio-utils';

const FORMAT_TO_CONTENT_TYPE: Record<TTSAudioFormat, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

// ---------------------------------------------------------------------------
// Self-Hosted STT
// ---------------------------------------------------------------------------

export class SelfHostedSTTProvider implements STTProvider {
  readonly providerId: ProviderId;
  private endpoint: string | null = null;
  private client: OpenAI | null = null;

  constructor(providerId: ProviderId) {
    this.providerId = providerId;
  }

  withEndpoint(url: string): SelfHostedSTTProvider {
    const provider = new SelfHostedSTTProvider(this.providerId);
    provider.endpoint = url.replace(/\/+$/, '');
    provider.client = new OpenAI({
      apiKey: 'not-needed',
      baseURL: `${provider.endpoint}/v1`,
    });
    return provider;
  }

  private getClient(): OpenAI {
    if (!this.client || !this.endpoint) {
      throw new Error(`[${this.providerId} STT] Endpoint not configured. Call withEndpoint() first.`);
    }
    return this.client;
  }

  getModels(): ModelInfo[] { return []; }
  isConfigured(): boolean { return !!this.endpoint; }

  async transcribe(request: STTRequest): Promise<STTResponse> {
    const client = this.getClient();
    const file = await prepareAudioFile(request.audio);

    const params: OpenAI.Audio.TranscriptionCreateParams = {
      file,
      model: request.model || 'whisper-1',
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
    return response;
  }
}

// ---------------------------------------------------------------------------
// Self-Hosted TTS
// ---------------------------------------------------------------------------

export class SelfHostedTTSProvider implements TTSProvider {
  readonly providerId: ProviderId;
  private endpoint: string | null = null;
  private client: OpenAI | null = null;

  constructor(providerId: ProviderId) {
    this.providerId = providerId;
  }

  withEndpoint(url: string): SelfHostedTTSProvider {
    const provider = new SelfHostedTTSProvider(this.providerId);
    provider.endpoint = url.replace(/\/+$/, '');
    provider.client = new OpenAI({
      apiKey: 'not-needed',
      baseURL: `${provider.endpoint}/v1`,
    });
    return provider;
  }

  private getClient(): OpenAI {
    if (!this.client || !this.endpoint) {
      throw new Error(`[${this.providerId} TTS] Endpoint not configured. Call withEndpoint() first.`);
    }
    return this.client;
  }

  getModels(): ModelInfo[] { return []; }
  getVoices(): VoiceInfo[] { return []; }
  isConfigured(): boolean { return !!this.endpoint; }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    const client = this.getClient();
    const format = request.responseFormat || 'mp3';

    const response = await client.audio.speech.create({
      model: request.model || 'tts-1',
      input: request.input,
      voice: request.voice as OpenAI.Audio.SpeechCreateParams['voice'] || 'alloy',
      response_format: format as OpenAI.Audio.SpeechCreateParams['response_format'],
      ...(request.speed && { speed: request.speed }),
    });

    const arrayBuffer = await response.arrayBuffer();
    return { audio: Buffer.from(arrayBuffer), contentType: FORMAT_TO_CONTENT_TYPE[format] || 'audio/mpeg' };
  }

  async synthesizeStream(request: TTSRequest): Promise<ReadableStream<Uint8Array>> {
    const client = this.getClient();
    const format = request.responseFormat || 'mp3';

    const response = await client.audio.speech.create({
      model: request.model || 'tts-1',
      input: request.input,
      voice: request.voice as OpenAI.Audio.SpeechCreateParams['voice'] || 'alloy',
      response_format: format as OpenAI.Audio.SpeechCreateParams['response_format'],
      ...(request.speed && { speed: request.speed }),
    });

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

// ---------------------------------------------------------------------------
// Self-Hosted LLM
// ---------------------------------------------------------------------------

export class SelfHostedLLMProvider implements LLMProvider {
  readonly providerId: ProviderId;
  private endpoint: string | null = null;
  private client: OpenAI | null = null;

  constructor(providerId: ProviderId) {
    this.providerId = providerId;
  }

  withEndpoint(url: string): SelfHostedLLMProvider {
    const provider = new SelfHostedLLMProvider(this.providerId);
    provider.endpoint = url.replace(/\/+$/, '');
    provider.client = new OpenAI({
      apiKey: 'not-needed',
      baseURL: `${provider.endpoint}/v1`,
    });
    return provider;
  }

  withApiKey(apiKey: string): SelfHostedLLMProvider {
    return this; // Self-hosted doesn't use API keys
  }

  withConfig(opts: { apiKey: string; baseURL?: string }): SelfHostedLLMProvider {
    if (opts.baseURL) return this.withEndpoint(opts.baseURL);
    return this;
  }

  private getClient(): OpenAI {
    if (!this.client || !this.endpoint) {
      throw new Error(`[${this.providerId} LLM] Endpoint not configured. Call withEndpoint() first.`);
    }
    return this.client;
  }

  isConfigured(): boolean { return !!this.endpoint; }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const client = this.getClient();

    const completion = await client.chat.completions.create({
      model: request.model || '',
      messages: request.messages,
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
