/**
 * Modal TTS Provider (MOSS-TTS-Realtime)
 *
 * Uses the MOSS-TTS-Realtime model deployed on Modal.com.
 * Supports 20 languages and voice cloning with reference audio.
 * No API key required — public endpoint.
 *
 * Voice ID format: moss-{lang}  e.g. "moss-pt", "moss-en"
 * Endpoint: POST /api/text  { text, language, temperature, top_p, top_k, reference_audio? }
 * Returns:  { audio (base64 WAV), sample_rate, duration_seconds, generation_time }
 */

import type { ProviderId, ModelInfo, TTSProvider, TTSRequest, TTSResponse, VoiceInfo } from '../types';

const DEFAULT_ENDPOINT =
  'https://marcosremar--moss-tts-realtime-mossttsrealtime-serve.modal.run';

function parseVoiceId(voiceId: string): { language: string } {
  const match = voiceId.match(/^moss-([a-z]{2})/);
  return { language: match?.[1] || 'pt' };
}

export const MODAL_TTS_MODELS: ModelInfo[] = [
  {
    id: 'moss-tts-realtime',
    name: 'MOSS-TTS-Realtime 1.7B',
    description: 'MOSS-TTS-Realtime - 20 idiomas, voice cloning, alta qualidade',
    capability: 'tts',
    isDefault: true,
  },
];

export class ModalTTSProvider implements TTSProvider {
  readonly providerId: ProviderId = 'modal';
  private endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = endpoint || process.env.MOSS_TTS_URL || DEFAULT_ENDPOINT;
  }

  getModels(): ModelInfo[] { return MODAL_TTS_MODELS; }
  getVoices(): VoiceInfo[] { return []; }
  isConfigured(): boolean { return true; }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    const { language } = parseVoiceId(request.voice ?? 'moss-pt');

    const res = await fetch(`${this.endpoint}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: request.input,
        language,
        temperature: 0.8,
        top_p: 0.6,
        top_k: 30,
        ...(request.referenceAudio && { reference_audio: request.referenceAudio }),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(
        new Error(`MOSS-TTS error (${res.status}): ${body}`),
        { status: res.status },
      );
    }

    const data = await res.json();
    return {
      audio: Buffer.from(data.audio, 'base64'),
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

export const modalTTS = new ModalTTSProvider();
