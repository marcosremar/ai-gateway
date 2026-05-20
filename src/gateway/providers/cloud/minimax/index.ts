/**
 * Minimax TTS Provider — speech-02 family (turbo/hd) via Minimax HTTP API.
 *
 * Endpoint: POST https://api.minimax.io/v1/t2a_v2
 * Auth:     Authorization: Bearer <MINIMAX_API_KEY>
 * Response: JSON { data: { audio: <hex-string>, status }, ... }
 *           — audio field is hex-encoded bytes in requested format.
 *
 * Voices: 40+ Portuguese system voices (Portuguese_Narrator, ...).
 * Call /v1/get_voice with body {"voice_type":"system"} to list.
 */

import type { ProviderId, ModelInfo, TTSProvider, TTSRequest, TTSResponse, VoiceInfo } from '../types';

const DEFAULT_BASE = process.env.MINIMAX_API_BASE || 'https://api.minimax.io';

export const MINIMAX_TTS_MODELS: ModelInfo[] = [
  { id: 'speech-02-turbo', name: 'Speech 02 Turbo', description: 'Minimax fast TTS (low latency)', capability: 'tts', isDefault: true },
  { id: 'speech-02-hd',    name: 'Speech 02 HD',    description: 'Minimax high-quality TTS',       capability: 'tts' },
  { id: 'speech-2.6-turbo',name: 'Speech 2.6 Turbo',description: 'Minimax 2.6 fast',               capability: 'tts' },
  { id: 'speech-2.6-hd',   name: 'Speech 2.6 HD',   description: 'Minimax 2.6 hd',                 capability: 'tts' },
];

// Curated Portuguese-friendly defaults. Full list available via /v1/get_voice.
const KNOWN_VOICES: VoiceInfo[] = [
  { id: 'Portuguese_Narrator',              name: 'Narrator',               description: 'Neutral PT narrator' },
  { id: 'Portuguese_CaptivatingStoryteller',name: 'Captivating Storyteller',description: 'Female PT storyteller (host A)' },
  { id: 'Portuguese_ThoughtfulMan',         name: 'Thoughtful Man',         description: 'Male PT thoughtful (host B)' },
  { id: 'Portuguese_ConfidentWoman',        name: 'Confident Woman',        description: 'Female PT confident' },
  { id: 'Portuguese_Steadymentor',          name: 'Steady Mentor',          description: 'Male PT mentor' },
  { id: 'Portuguese_SereneWoman',           name: 'Serene Woman',           description: 'Female PT serene' },
  { id: 'Portuguese_Jovialman',             name: 'Jovial Man',             description: 'Male PT jovial' },
];

const FORMAT_TO_CT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
  flac: 'audio/flac',
};

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

export class MinimaxTTSProvider implements TTSProvider {
  readonly providerId: ProviderId = 'minimax';
  private apiKey: string | null = null;
  private base: string;

  constructor(base?: string) {
    this.base = (base || DEFAULT_BASE).replace(/\/$/, '');
  }

  private getApiKey(): string {
    if (this.apiKey) return this.apiKey;
    const key = process.env.MINIMAX_API_KEY;
    if (!key) throw new Error('[minimax] MINIMAX_API_KEY is not set');
    return key;
  }

  withApiKey(apiKey: string): MinimaxTTSProvider {
    const p = new MinimaxTTSProvider(this.base);
    p.apiKey = apiKey;
    return p;
  }

  getModels(): ModelInfo[] { return MINIMAX_TTS_MODELS; }
  getVoices(): VoiceInfo[] { return KNOWN_VOICES; }
  isConfigured(): boolean { return !!(this.apiKey || process.env.MINIMAX_API_KEY); }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    const apiKey = this.getApiKey();
    const model = request.model || 'speech-02-turbo';
    const voice = request.voice || 'Portuguese_Narrator';
    const format = (request.responseFormat || 'mp3').toLowerCase();
    const sampleRate = format === 'wav' || format === 'pcm' ? 24000 : 32000;

    const res = await fetch(`${this.base}/v1/t2a_v2`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        text: request.input,
        stream: false,
        voice_setting: {
          voice_id: voice,
          speed: request.speed ?? 1.0,
          vol: 1.0,
          pitch: 0,
          emotion: 'neutral',
        },
        audio_setting: {
          sample_rate: sampleRate,
          bitrate: 128000,
          format,
          channel: 1,
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw Object.assign(new Error(`[minimax] HTTP ${res.status}: ${body.slice(0, 300)}`), { status: res.status });
    }

    const data = await res.json() as { data?: { audio?: string; status?: number }; base_resp?: { status_code?: number; status_msg?: string } };
    const code = data.base_resp?.status_code;
    if (code && code !== 0) {
      const msg = data.base_resp?.status_msg ?? 'unknown';
      throw Object.assign(new Error(`[minimax] code ${code}: ${msg}`), { status: code === 2056 ? 429 : 502 });
    }
    const hex = data.data?.audio;
    if (!hex) throw new Error('[minimax] empty audio in response');
    return {
      audio: hexToBuffer(hex),
      contentType: FORMAT_TO_CT[format] ?? 'audio/mpeg',
      raw: data,
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

export const minimaxTTS = new MinimaxTTSProvider();
