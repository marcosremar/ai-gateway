/**
 * Modal Voxtral STT Provider
 *
 * Uses mistralai/Voxtral-Mini-3B-2507 — Mistral's open-weights audio model.
 * Apache 2.0 license. Best for French/multilingual, 13 languages.
 * GPU snapshots enabled — ~15-20s cold start after first boot.
 * No API key required — public Modal endpoint.
 */

import type { ProviderId, ModelInfo, STTProvider, STTRequest, STTResponse } from '../types';

const DEFAULT_ENDPOINT =
  'https://marcosremar--babelcast-voxtral-voxtral-serve.modal.run';

export const VOXTRAL_MODELS: ModelInfo[] = [
  {
    id: 'voxtral-mini-3b',
    name: 'Voxtral Mini 3B',
    description: 'Mistral Voxtral-Mini-3B-2507 — multilingual ASR, 13 languages, Apache 2.0',
    capability: 'stt',
    isDefault: true,
  },
];

export class ModalVoxtralSTTProvider implements STTProvider {
  readonly providerId: ProviderId = 'modal-voxtral' as ProviderId;
  private endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = endpoint || process.env.MODAL_VOXTRAL_URL || DEFAULT_ENDPOINT;
  }

  getModels(): ModelInfo[] { return VOXTRAL_MODELS; }
  isConfigured(): boolean { return true; }

  async transcribe(request: STTRequest): Promise<STTResponse> {
    const formData = new FormData();
    const audioBlob = request.audio instanceof Blob
      ? request.audio
      : new Blob([new Uint8Array(request.audio)], { type: 'audio/wav' });
    formData.append('file', audioBlob, 'audio.wav');
    formData.append('language', request.language || 'fr');
    if (request.prompt) formData.append('prompt', request.prompt);

    const res = await fetch(`${this.endpoint}/v1/audio/transcriptions`, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(
        new Error(`Voxtral STT error (${res.status}): ${body}`),
        { status: res.status },
      );
    }

    const data = await res.json() as {
      text: string;
      language: string;
      duration: number;
      processing_ms?: number;
    };
    return {
      text: data.text,
      language: data.language,
      duration: data.duration,
    };
  }
}

export const modalVoxtralSTT = new ModalVoxtralSTTProvider();
