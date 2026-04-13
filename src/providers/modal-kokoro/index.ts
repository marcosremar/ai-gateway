/**
 * Modal Kokoro TTS Provider (82M, native PyTorch)
 *
 * #1 open-weights TTS on Artificial Analysis leaderboard (Elo 1060).
 * 54+ voices across 10 languages, 24kHz output, ~35-100x realtime on GPU.
 * OpenAI-compatible endpoint — POST /v1/audio/speech
 * Supports proxy auth via MODAL_PROXY_SECRET env (format: key:secret).
 */

import type { ProviderId, ModelInfo, TTSProvider, TTSRequest, TTSResponse, VoiceInfo } from '../types';
import { KOKORO_VOICE_CATALOG } from '../voice-catalog';

function buildProxyAuthHeaders(): Record<string, string> {
  const token = process.env.MODAL_PROXY_SECRET;
  if (!token) return {};
  const [key, secret] = token.split(':');
  if (!key || !secret) return {};
  return { 'Modal-Key': key, 'Modal-Secret': secret };
}

const DEFAULT_ENDPOINT =
  'https://marcosremar--babelcast-kokoro-kokorotts-serve.modal.run';

export const MODAL_KOKORO_MODELS: ModelInfo[] = [
  {
    id: 'kokoro-82m',
    name: 'Kokoro 82M',
    description: 'Kokoro TTS — #1 open-weights TTS, 54+ voices, 10 languages',
    capability: 'tts',
    isDefault: true,
  },
];

const ALL_VOICE_IDS: string[] = KOKORO_VOICE_CATALOG.models
  .flatMap(m => m.voices.map(v => v.id));

export class ModalKokoroTTSProvider implements TTSProvider {
  readonly providerId: ProviderId = 'modal';
  private endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = endpoint || process.env.MODAL_KOKORO_URL || DEFAULT_ENDPOINT;
  }

  getModels(): ModelInfo[] { return MODAL_KOKORO_MODELS; }

  getVoices(): VoiceInfo[] {
    return KOKORO_VOICE_CATALOG.models.flatMap(m => m.voices);
  }

  isConfigured(): boolean { return true; }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    const rawVoice = (request.voice ?? '').toLowerCase();
    const voice = ALL_VOICE_IDS.includes(rawVoice) ? rawVoice : 'af_heart';

    const res = await fetch(`${this.endpoint}/v1/audio/speech`, {
      method: 'POST',
      headers: { ...buildProxyAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kokoro-82m',
        input: request.input,
        voice,
        speed: request.speed ?? 1.0,
        response_format: 'wav',
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(
        new Error(`Kokoro TTS error (${res.status}): ${body}`),
        { status: res.status },
      );
    }

    const arrayBuf = await res.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuf),
      contentType: 'audio/wav',
    };
  }

  async synthesizeStream(request: TTSRequest): Promise<ReadableStream<Uint8Array>> {
    const result = await this.synthesize(request);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(result.audio));
        controller.close();
      },
    });
  }
}

export const modalKokoroTTS = new ModalKokoroTTSProvider();
