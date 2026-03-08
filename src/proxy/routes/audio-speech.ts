/**
 * POST /v1/audio/speech — TTS
 */

import type { TTSProvider } from '../../providers/types';
import type { ProxyRequest, ProxyResponse } from '../types';
import { withProxyRetry } from './retry';

export async function handleAudioSpeech(
  req: ProxyRequest,
  ttsProviders: Record<string, TTSProvider>,
): Promise<ProxyResponse> {
  const body = req.body as {
    model: string;
    input: string;
    voice: string;
    response_format?: string;
    speed?: number;
  };

  if (!body.model || !body.input || !body.voice) {
    return { status: 400, body: { error: { message: 'model, input, and voice are required', type: 'invalid_request_error' } } };
  }

  const provider = ttsProviders[body.model];
  if (!provider) {
    return { status: 404, body: { error: { message: `TTS model "${body.model}" not found`, type: 'invalid_request_error' } } };
  }

  try {
    const result = await withProxyRetry(
      provider.providerId,
      body.model,
      () => provider.synthesize({
        model: body.model,
        input: body.input,
        voice: body.voice,
        responseFormat: (body.response_format as 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm') || 'mp3',
        speed: body.speed,
      }),
      'TTS',
    );

    return {
      status: 200,
      headers: { 'Content-Type': result.contentType },
      body: result.audio,
    };
  } catch (err) {
    return {
      status: 500,
      body: { error: { message: String(err), type: 'server_error' } },
    };
  }
}
