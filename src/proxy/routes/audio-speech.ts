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
  if (!req.body || typeof req.body !== 'object') {
    return { status: 400, body: { error: { message: 'request body is required', type: 'invalid_request_error' } } };
  }
  const body = req.body as Record<string, unknown>;

  if (!body.model || typeof body.model !== 'string') {
    return { status: 400, body: { error: { message: 'model is required', type: 'invalid_request_error' } } };
  }
  if (!body.input || typeof body.input !== 'string') {
    return { status: 400, body: { error: { message: 'input text is required', type: 'invalid_request_error' } } };
  }
  if (!body.voice || typeof body.voice !== 'string') {
    return { status: 400, body: { error: { message: 'voice is required', type: 'invalid_request_error' } } };
  }
  if (body.input.length > 4096) {
    return { status: 400, body: { error: { message: 'input text exceeds 4096 characters', type: 'invalid_request_error' } } };
  }
  if (body.speed !== undefined && (typeof body.speed !== 'number' || body.speed < 0.25 || body.speed > 4.0)) {
    return { status: 400, body: { error: { message: 'speed must be between 0.25 and 4.0', type: 'invalid_request_error' } } };
  }
  const validFormats = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'];
  if (body.response_format && !validFormats.includes(body.response_format)) {
    return { status: 400, body: { error: { message: `response_format must be one of: ${validFormats.join(', ')}`, type: 'invalid_request_error' } } };
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
    console.error(`[audio-speech] TTS error for model ${body.model}:`, err);
    return {
      status: 500,
      body: { error: { message: 'Speech synthesis failed', type: 'server_error' } },
    };
  }
}
