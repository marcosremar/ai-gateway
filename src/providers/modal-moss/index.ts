/**
 * Modal MOSS-TTS Provider
 *
 * Uses OpenMOSS-Team/MOSS-TTS deployed on Modal.com serverless GPU.
 * Auto-detects language from text, supports voice cloning with reference audio.
 * No API key required — public endpoint.
 *
 * Voice ID format: moss-{lang}  e.g. "moss-pt", "moss-en" (language hint, model auto-detects)
 * Endpoint: POST /api/text  { text, reference_audio? }
 * Returns:  { audio (base64 WAV), sample_rate, duration_seconds, generation_time }
 */

import type { ProviderId, ModelInfo, TTSProvider, TTSRequest, TTSResponse, VoiceInfo } from '../types';

const DEFAULT_ENDPOINT =
  'https://marcosremar--babelcast-moss-tts-serve.modal.run';

const SUPPORTED_LANGUAGES = [
  'pt', 'en', 'es', 'fr', 'de', 'it', 'ja', 'zh', 'ko', 'ru', 'ar', 'tr',
  'nl', 'pl', 'sv', 'da', 'fi', 'no', 'cs', 'el',
];

function parseVoiceId(voiceId: string): { language: string } {
  const match = voiceId.match(/^moss-([a-z]{2})/);
  return { language: match?.[1] || 'en' };
}

export const MODAL_MOSS_TTS_MODELS: ModelInfo[] = [
  {
    id: 'moss-tts',
    name: 'MOSS-TTS',
    description: 'MOSS-TTS — auto language detection, voice cloning with reference audio',
    capability: 'tts',
    isDefault: true,
  },
];

export class ModalMossTTSProvider implements TTSProvider {
  readonly providerId: ProviderId = 'modal-moss';
  private endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = endpoint || process.env.MOSS_TTS_URL || DEFAULT_ENDPOINT;
  }

  getModels(): ModelInfo[] { return MODAL_MOSS_TTS_MODELS; }
  getVoices(): VoiceInfo[] {
    return SUPPORTED_LANGUAGES.map(lang => ({
      id: `moss-${lang}`,
      name: `MOSS ${lang.toUpperCase()}`,
    }));
  }
  isConfigured(): boolean { return true; }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    const res = await fetch(`${this.endpoint}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: request.input,
        ...(request.referenceAudio && { reference_audio: request.referenceAudio }),
        ...(request.refText && { ref_text: request.refText }),
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

export const modalMossTTS = new ModalMossTTSProvider();
