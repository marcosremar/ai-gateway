/**
 * Deepgram STT Provider — Nova-3 batch transcription.
 * Uses Deepgram's REST API (not OpenAI-compatible format).
 */

import type { ProviderId, ModelInfo, STTProvider, STTRequest, STTResponse } from '../types';


interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

interface DeepgramAlternative {
  transcript: string;
  confidence: number;
  words?: DeepgramWord[];
}

interface DeepgramResponse {
  results?: {
    channels?: Array<{
      alternatives?: DeepgramAlternative[];
    }>;
  };
}

const DEEPGRAM_MODELS: ModelInfo[] = [
  { id: 'nova-3', name: 'Nova-3', description: 'Deepgram Nova-3 — best accuracy + low latency', capability: 'stt', isDefault: true },
  { id: 'nova-2', name: 'Nova-2', description: 'Deepgram Nova-2 — previous generation', capability: 'stt' },
];

export class DeepgramSTTProvider implements STTProvider {
  readonly providerId: ProviderId = 'deepgram';

  getModels(): ModelInfo[] { return DEEPGRAM_MODELS; }
  isConfigured(): boolean { return !!process.env.DEEPGRAM_API_KEY; }

  async transcribe(request: STTRequest): Promise<STTResponse> {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) throw new Error('[deepgram] DEEPGRAM_API_KEY is not set');

    const model = request.model || 'nova-3';
    const params = new URLSearchParams({ model, smart_format: 'true' });
    if (request.language) params.set('language', request.language);
    if (request.wordTimestamps) params.set('punctuate', 'true');

    const audioBuffer = request.audio instanceof Blob
      ? Buffer.from(await request.audio.arrayBuffer())
      : request.audio;

    const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'audio/wav',
      },
      body: audioBuffer,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`[deepgram] HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json() as DeepgramResponse;
    const alt = data.results?.channels?.[0]?.alternatives?.[0];
    const transcript = alt?.transcript ?? '';
    const response: STTResponse = { text: transcript, raw: data };

    // Deepgram always returns word-level timestamps in alternatives
    if (alt?.words && alt.words.length > 0) {
      response.words = alt.words.map((w) => ({
        word: w.word,
        start: w.start,
        end: w.end,
      }));
    }

    return response;
  }
}

export const deepgramSTT = new DeepgramSTTProvider();
