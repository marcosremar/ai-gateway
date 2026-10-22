/**
 * OpenAI-compatible TTS base class.
 * Any provider with an OpenAI-compatible /audio/speech endpoint
 * can use this by providing { providerId, baseURL, envKey, models, voices }.
 */

import OpenAI from 'openai';
import type { ProviderId, ModelInfo, TTSAudioFormat, TTSProvider, TTSRequest, TTSResponse, VoiceInfo } from '../types';
import { GATEWAY_SDK_MAX_RETRIES, getOrCreateClient } from './client-cache';
import { emitGatewayEvent, gatewayTelemetryEnabled } from '../../../../telemetry/emit';

export const GENERATION_LOOKUP_MS = [2_000, 10_000, 30_000];

async function generationCost(client: OpenAI, id: string): Promise<number | null> {
  const body = await client.get<unknown>('/generation', { query: { id }, timeout: 10_000, maxRetries: 0 });
  const cost = (body as { data?: { total_cost?: unknown } } | null)?.data?.total_cost;
  return typeof cost === 'number' && cost > 0 ? cost : null;
}

export function reportTtsCost(client: OpenAI, provider: string, model: string, input: string, generationId: string | null, waits = GENERATION_LOOKUP_MS): void {
  if (!gatewayTelemetryEnabled()) return;
  const [wait, ...rest] = generationId ? waits : [];
  if (wait === undefined) {
    emitGatewayEvent('usage.cost', { attrs: { stage: 'tts', provider, model, chars: input.length } });
    return;
  }
  const retry = () => reportTtsCost(client, provider, model, input, generationId, rest);
  setTimeout(() => {
    generationCost(client, generationId!).then(costUsd => (costUsd ? emitGatewayEvent('usage.cost', { attrs: { stage: 'tts', provider, model, costUsd } }) : retry()), retry);
  }, wait).unref?.();
}

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
  pcmAsWavRate?: number;
  /**
   * With `request.stream` and a wav/pcm answer, pass the body on as the server sends it, from its first audio chunk
   * (`untilFirstAudio`), instead of reading the whole sentence first. For a server that synthesizes chunk by chunk (a
   * local link: Kokoro-FastAPI, the parle Mac stack) the client's first byte then arrives with the first chunk. Cloud
   * providers keep the whole answer (an error mid-body could not fall back any more).
   */
  streamAudio?: boolean;
}

/** Bytes of a canonical WAV header (RIFF + fmt + data): what a streamed WAV sends before its first sample. */
export const WAV_HEADER_BYTES = 44;

const noAudio = (label: string, why: string) => Object.assign(new Error(`${label}: ${why}`), { status: 502, gatewayCode: 'empty' });

/**
 * Holds a streamed answer until it carries more than `headerBytes` (a WAV header alone is not audio), then passes it on
 * chunk by chunk as it arrives. An answer that ends before any sample fails with code `empty`, so the chain moves on
 * instead of the client getting a mute turn (an answer without audio is never a success). Resolving at the first audio
 * chunk makes the attempt timeout and the hedge measure time to first audio, not the time of the whole sentence.
 */
async function untilFirstAudio(body: ReadableStream<Uint8Array>, headerBytes: number, label: string): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const held: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= headerBytes) {
      const { value, done } = await reader.read();
      if (done) throw noAudio(label, `the answer ended with no audio (${size} bytes)`);
      if (value?.byteLength) { held.push(value); size += value.byteLength; }
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }
  return new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of held) controller.enqueue(chunk); },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close(); else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

function wavHeader(rate: number, dataBytes: number): Buffer {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(Math.min(0xffffffff, dataBytes + 36), 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(dataBytes, 40);
  return head;
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
    provider.client = new OpenAI({ apiKey, baseURL: this.config.baseURL, maxRetries: GATEWAY_SDK_MAX_RETRIES });
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

  /**
   * Fields outside the OpenAI speech API that this provider's server reads, merged into the request body. None by
   * default: OpenAI refuses an unknown field. A local link sends the client's `language` (local-link.ts).
   */
  protected bodyExtras(_request: TTSRequest): Record<string, unknown> {
    return {};
  }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    const client = this.getClient();
    const asWav = request.responseFormat === 'wav' && !!this.config.pcmAsWavRate && !this.config.allowedFormats?.includes('wav');
    const format = asWav ? 'pcm' : this.resolveFormat(request.responseFormat);

    const params: OpenAI.Audio.SpeechCreateParams = {
      model: request.model || this.config.defaultModel || this.config.models[0]?.id,
      input: request.input,
      voice: this.resolveVoice(request.voice) as OpenAI.Audio.SpeechCreateParams['voice'],
      response_format: format as OpenAI.Audio.SpeechCreateParams['response_format'],
      ...(request.speed && { speed: request.speed }),
      ...(request.instructions && { instructions: request.instructions }),
      ...this.bodyExtras(request),
    };

    const response = await client.audio.speech.create(params, request.signal ? { signal: request.signal } : undefined);
    reportTtsCost(client, this.providerId, params.model, request.input, response.headers.get('x-generation-id'));
    if (asWav) {
      const rate = Number(/rate=(\d+)/.exec(response.headers.get('content-type') ?? '')?.[1]) || this.config.pcmAsWavRate!;
      if (request.stream && response.body) {
        if (this.config.streamAudio && (response.headers.get('content-type') ?? '').includes('json')) {
          throw noAudio(this.providerId, `the server answered JSON, not audio: ${(await response.text().catch(() => '')).slice(0, 200)}`);
        }
        const raw = response.body as unknown as ReadableStream<Uint8Array>;
        // A server that streams (`streamAudio`): resolve at its first PCM bytes, so the attempt timeout and the hedge
        // measure time to first audio — a stuck synthesis falls back instead of handing the client a silent stream.
        const body = this.config.streamAudio ? await untilFirstAudio(raw, 0, this.providerId) : raw;
        const reader = body.getReader();
        let sentHead = false;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!sentHead) { sentHead = true; controller.enqueue(wavHeader(rate, 0xffffffff)); return; }
            const { value, done } = await reader.read();
            if (done) controller.close(); else controller.enqueue(value);
          },
          cancel: (reason) => reader.cancel(reason),
        });
        return { audio: Buffer.alloc(0), contentType: 'audio/wav', stream };
      }
      const pcm = Buffer.from(await response.arrayBuffer());
      return { audio: Buffer.concat([wavHeader(rate, pcm.length), pcm]), contentType: 'audio/wav' };
    }
    const contentType = FORMAT_TO_CONTENT_TYPE[format] || 'audio/mpeg';
    if (this.config.streamAudio && request.stream && response.body && (format === 'wav' || format === 'pcm')) {
      if ((response.headers.get('content-type') ?? '').includes('json')) {
        throw noAudio(this.providerId, `the server answered JSON, not audio: ${(await response.text().catch(() => '')).slice(0, 200)}`);
      }
      const body = response.body as unknown as ReadableStream<Uint8Array>;
      return { audio: Buffer.alloc(0), contentType, stream: await untilFirstAudio(body, format === 'wav' ? WAV_HEADER_BYTES : 0, this.providerId) };
    }
    const arrayBuffer = await response.arrayBuffer();
    return { audio: Buffer.from(arrayBuffer), contentType };
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
      ...this.bodyExtras(request),
    };

    const response = await client.audio.speech.create(params, request.signal ? { signal: request.signal } : undefined);
    reportTtsCost(client, this.providerId, params.model, request.input, response.headers.get('x-generation-id'));

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
