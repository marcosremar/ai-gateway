/**
 * ElevenLabs Scribe STT Provider — high-accuracy multilingual transcription.
 * Uses ElevenLabs REST API (multipart/form-data, NOT OpenAI-compatible).
 */

import type { ProviderId, ModelInfo, STTProvider, STTRequest, STTResponse } from '../types';

interface ScribeWord {
  text: string;
  start: number;
  end: number;
  type?: string;
  speaker_id?: string;
}

interface ScribeResponse {
  text: string;
  language_code?: string;
  language_probability?: number;
  words?: ScribeWord[];
}

const ELEVENLABS_STT_MODELS: ModelInfo[] = [
  {
    id: 'scribe_v2',
    name: 'Scribe v2',
    description: 'ElevenLabs Scribe v2 — highest accuracy STT (2.3% WER)',
    capability: 'stt',
    isDefault: true,
    metadata: {
      benchmarks: {
        en: { wer: 2.3, corpus: 'aa-wer-v2', samples: 'n/a' },
        fr: { wer: 3.1, corpus: 'aa-wer-v2', samples: 'n/a' },
        pt: { wer: 3.5, corpus: 'aa-wer-v2', samples: 'n/a' },
      },
      pricePerHour: '$0.40',
    },
  },
  {
    id: 'scribe_v1',
    name: 'Scribe v1',
    description: 'ElevenLabs Scribe v1 — previous generation',
    capability: 'stt',
  },
];

export class ElevenLabsSTTProvider implements STTProvider {
  readonly providerId: ProviderId = 'elevenlabs';
  private apiKey: string | null = null;

  private getApiKey(): string {
    if (this.apiKey) return this.apiKey;
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('[elevenlabs] ELEVENLABS_API_KEY is not set');
    return key;
  }

  withApiKey(apiKey: string): ElevenLabsSTTProvider {
    const provider = new ElevenLabsSTTProvider();
    provider.apiKey = apiKey;
    return provider;
  }

  getModels(): ModelInfo[] { return ELEVENLABS_STT_MODELS; }
  isConfigured(): boolean { return !!(this.apiKey || process.env.ELEVENLABS_API_KEY); }

  async transcribe(request: STTRequest): Promise<STTResponse> {
    const apiKey = this.getApiKey();
    const model = request.model || 'scribe_v2';

    const audioBuffer = request.audio instanceof Blob
      ? Buffer.from(await request.audio.arrayBuffer())
      : request.audio;

    // Build multipart form data manually using Blob API (works in Bun)
    const formData = new FormData();
    formData.append('model_id', model);
    formData.append('file', new Blob([audioBuffer as BlobPart], { type: 'audio/wav' }), 'audio.wav');
    if (request.language) {
      formData.append('language_code', request.language);
    }
    if (request.wordTimestamps) {
      formData.append('timestamps_granularity', 'word');
    }

    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
      },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`[elevenlabs] HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json() as ScribeResponse;
    const response: STTResponse = { text: data.text || '', raw: data };

    if (data.language_code) {
      response.language = data.language_code;
    }

    if (data.words && data.words.length > 0) {
      response.words = data.words
        .filter(w => w.type !== 'spacing')
        .map(w => ({ word: w.text, start: w.start, end: w.end }));
    }

    return response;
  }
}

export const elevenlabsSTT = new ElevenLabsSTTProvider();
export { ELEVENLABS_STT_MODELS };
