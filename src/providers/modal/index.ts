/**
 * Modal TTS Provider (Qwen3-TTS)
 *
 * Uses Qwen3-TTS deployed on Modal.com serverless GPU (L40S).
 * OpenAI-compatible endpoint — POST /v1/audio/speech
 * No API key required — public endpoint.
 *
 * Valid voices: aiden, dylan, eric, ono_anna, ryan, serena, sohee, uncle_fu, vivian
 * Endpoint: POST /v1/audio/speech  { model, input, voice, response_format }
 * Returns:  WAV audio bytes
 */

import type { ProviderId, ModelInfo, TTSProvider, TTSRequest, TTSResponse, VoiceInfo } from '../types';

const DEFAULT_ENDPOINT =
  'https://marcosremar--babelcast-tts-serve.modal.run';

const VALID_VOICES = ['aiden', 'dylan', 'eric', 'ono_anna', 'ryan', 'serena', 'sohee', 'uncle_fu', 'vivian'];

export const MODAL_TTS_MODELS: ModelInfo[] = [
  {
    id: 'qwen3-tts',
    name: 'Qwen3-TTS 0.6B',
    description: 'Qwen3-TTS CustomVoice — high quality multilingual TTS on Modal GPU',
    capability: 'tts',
    isDefault: true,
  },
];

export class ModalTTSProvider implements TTSProvider {
  readonly providerId: ProviderId = 'modal';
  private endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = endpoint || process.env.MODAL_TTS_URL || DEFAULT_ENDPOINT;
  }

  getModels(): ModelInfo[] { return MODAL_TTS_MODELS; }
  getVoices(): VoiceInfo[] {
    return VALID_VOICES.map(v => ({ id: v, name: v }));
  }
  isConfigured(): boolean { return true; }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    const voice = VALID_VOICES.includes(request.voice ?? '') ? request.voice! : 'serena';

    const res = await fetch(`${this.endpoint}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3-tts',
        input: request.input,
        voice,
        response_format: 'wav',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(
        new Error(`Modal TTS error (${res.status}): ${body}`),
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

export const modalTTS = new ModalTTSProvider();
