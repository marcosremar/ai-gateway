/**
 * Deepgram STT Provider — Nova-3 batch transcription.
 * Uses Deepgram's REST API (not OpenAI-compatible format).
 */

import type { ProviderId, ModelInfo, STTProvider, STTRequest, STTResponse } from '../types';
import { makeProviderError } from '../provider-error';


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

/**
 * Build the Deepgram query string from an STTRequest. Pure + exported for unit
 * testing (the transcribe() path does live fetch). Fixes:
 *   - #368: word timestamps come from Nova by default — do NOT toggle the
 *     unrelated `punctuate` knob when wordTimestamps is requested.
 *   - #369: `smart_format` is opt-in (request.smartFormat) instead of forced,
 *     so it can't silently rewrite numbers/dates and break term matching.
 */
export function buildDeepgramParams(request: STTRequest): URLSearchParams {
  const model = request.model || 'nova-3';
  const params = new URLSearchParams({ model });
  if (request.smartFormat) params.set('smart_format', 'true');
  if (request.language) params.set('language', request.language);
  if (request.vad?.endpointingMs !== undefined) {
    params.set('endpointing', String(Math.max(0, request.vad.endpointingMs)));
  }
  if (request.vad?.vadEvents) params.set('vad_events', 'true');
  if (request.vad?.utteranceEndMs !== undefined) {
    params.set('utterance_end_ms', String(Math.max(0, request.vad.utteranceEndMs)));
  }
  if (request.vad?.interimResults) params.set('interim_results', 'true');
  return params;
}

export class DeepgramSTTProvider implements STTProvider {
  readonly providerId: ProviderId = 'deepgram';

  getModels(): ModelInfo[] { return DEEPGRAM_MODELS; }
  isConfigured(): boolean { return !!process.env.DEEPGRAM_API_KEY; }

  async transcribe(request: STTRequest): Promise<STTResponse> {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) throw new Error('[deepgram] DEEPGRAM_API_KEY is not set');

    const params = buildDeepgramParams(request);

    const audioBuffer = request.audio instanceof Blob
      ? Buffer.from(await request.audio.arrayBuffer())
      : request.audio;

    const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'audio/wav',
      },
      body: audioBuffer as unknown as BodyInit,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      // Throw with a real numeric `.status` (#371) so the fallback layer
      // classifies 429/5xx reliably instead of regex-scraping the message.
      throw makeProviderError('deepgram', res.status, errText.slice(0, 200));
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
