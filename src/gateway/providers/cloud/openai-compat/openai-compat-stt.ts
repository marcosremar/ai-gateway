/**
 * OpenAI-compatible STT base class.
 * Any provider with an OpenAI-compatible /audio/transcriptions endpoint
 * can use this by providing { providerId, baseURL, envKey, models }.
 */

import OpenAI from 'openai';
import type { ProviderId, ModelInfo, STTProvider, STTRequest, STTResponse, STTSegment } from '../types';
import { prepareAudioFile } from './audio-utils';
import { GATEWAY_SDK_MAX_RETRIES, getOrCreateClient } from './client-cache';

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

  /** True when the client was built from an explicit key (withApiKey/withConfig): never swapped for the env key. */
  private pinnedClient = false;

  /**
   * The key is read from the environment on EVERY call, so a key rotated at runtime (KeyManager reload) is used by
   * the next request. Clients are shared per baseURL + key hash (client-cache), so this costs a hash lookup.
   */
  protected getClient(): OpenAI {
    if (this.client && this.pinnedClient) return this.client;
    const apiKey = process.env[this.config.envKey];
    if (!apiKey) throw new Error(`[${this.config.providerId} STT] ${this.config.envKey} is not set`);
    this.client = getOrCreateClient(this.config.baseURL, apiKey);
    return this.client;
  }

  withApiKey(apiKey: string): OpenAICompatSTTProvider {
    const provider = new OpenAICompatSTTProvider(this.config);
    provider.pinnedClient = true;
    provider.client = new OpenAI({ apiKey, baseURL: this.config.baseURL, maxRetries: GATEWAY_SDK_MAX_RETRIES });
    return provider;
  }

  getModels(): ModelInfo[] { return this.config.models; }
  isConfigured(): boolean { return !!process.env[this.config.envKey]; }

  async transcribe(request: STTRequest): Promise<STTResponse> {
    // Validate audio buffer before sending to API
    const audioLen = Buffer.isBuffer(request.audio) ? request.audio.length
      : request.audio instanceof Blob ? request.audio.size : 0;
    if (audioLen === 0) {
      return { text: '', timing: { total_ms: 0 } };
    }

    const client = this.getClient();
    const model = request.model || this.config.defaultModel || this.config.models[0]?.id;
    const file = await prepareAudioFile(request.audio);

    // Always prefer verbose_json to get segment-level metadata (no_speech_prob, compression_ratio, avg_logprob)
    // for hallucination filtering. Only fall back to 'json' for models that don't support it.
    const responseFormat: 'text' | 'json' | 'verbose_json' =
      request.responseFormat === 'text' ? 'text'
        : (model.includes('transcribe') ? 'json' : 'verbose_json');

    const params: OpenAI.Audio.TranscriptionCreateParams = {
      file,
      model,
      ...(request.language && { language: request.language }),
      ...(request.prompt && { prompt: request.prompt }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      response_format: responseFormat,
      // `timestamp_granularities` is only accepted alongside response_format
      // 'verbose_json' — sending it with 'json'/'text' makes OpenAI reject the
      // whole request (HTTP 400). Gate it on the *effective* format, not an
      // unrelated static config field.
      ...(request.wordTimestamps && responseFormat === 'verbose_json' && { timestamp_granularities: ['word'] }),
    };

    const t0 = Date.now();
    const transcription = await client.audio.transcriptions.create(params, request.signal ? { signal: request.signal } : undefined);
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

    // Extract per-segment Whisper metadata from verbose_json (no_speech_prob, compression_ratio, avg_logprob)
    const rawObj = transcription as unknown as Record<string, unknown>;
    if ('segments' in rawObj && Array.isArray(rawObj.segments)) {
      const segments: STTSegment[] = [];
      for (const seg of rawObj.segments as Record<string, unknown>[]) {
        if (typeof seg.text === 'string') {
          segments.push({
            id: typeof seg.id === 'number' ? seg.id : segments.length,
            start: typeof seg.start === 'number' ? seg.start : 0,
            end: typeof seg.end === 'number' ? seg.end : 0,
            text: seg.text,
            avg_logprob: typeof seg.avg_logprob === 'number' ? seg.avg_logprob : 0,
            compression_ratio: typeof seg.compression_ratio === 'number' ? seg.compression_ratio : 0,
            no_speech_prob: typeof seg.no_speech_prob === 'number' ? seg.no_speech_prob : 0,
          });
        }
      }
      if (segments.length > 0) {
        response.segments = segments;
        // Compute aggregate metrics (weighted average by segment duration)
        let totalDur = 0;
        let wLogprob = 0, wCompression = 0, wNoSpeech = 0;
        for (const s of segments) {
          const dur = Math.max(s.end - s.start, 0.01);
          totalDur += dur;
          wLogprob += s.avg_logprob * dur;
          wCompression += s.compression_ratio * dur;
          wNoSpeech += s.no_speech_prob * dur;
        }
        if (totalDur > 0) {
          response.avg_logprob = Math.round((wLogprob / totalDur) * 1000) / 1000;
          response.compression_ratio = Math.round((wCompression / totalDur) * 1000) / 1000;
          response.no_speech_prob = Math.round((wNoSpeech / totalDur) * 1000) / 1000;
        }
      }
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
