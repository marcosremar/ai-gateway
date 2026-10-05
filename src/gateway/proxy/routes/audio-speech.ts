/**
 * POST /v1/audio/speech — TTS
 */

import type { TTSProvider } from '../../providers/cloud/types';
import type { ProxyRequest, ProxyResponse, StageRoutes } from '../types';
import { CooldownTracker } from '../../providers/cloud/fallback';
import { createLogger } from '../../../logger';
import {
  errorResponse, normalizeTargets, providerUnavailableResponse, redactSecrets, routeRequest,
} from '../provider-routing';
import type { CircuitBreakerRegistry } from '../../providers/cloud/circuit-breaker';

const ttsCooldownTracker = new CooldownTracker();

const log = createLogger('audio-speech');

export async function handleAudioSpeech(
  req: ProxyRequest,
  ttsProviders: StageRoutes<TTSProvider>,
  unavailable?: Record<string, string[]>,
  circuitBreakers?: CircuitBreakerRegistry,
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
  if (body.response_format !== undefined && (typeof body.response_format !== 'string' || !validFormats.includes(body.response_format))) {
    return { status: 400, body: { error: { message: `response_format must be one of: ${validFormats.join(', ')}`, type: 'invalid_request_error' } } };
  }

  const model = body.model;
  const targets = normalizeTargets(ttsProviders[model]);
  if (targets.length === 0) {
    if (unavailable?.[model]) return providerUnavailableResponse('tts', model, unavailable[model]);
    return { status: 404, body: { error: { message: `TTS model "${model}" not found`, type: 'invalid_request_error' } } };
  }

  try {
    const { result, headers } = await routeRequest(
      targets,
      (t) => t.provider.synthesize({
        model: t.model ?? model,
        input: body.input as string,
        // Voices are provider-specific: a fallback uses `fallback_voice` from the request, else its configured voice.
        voice: (t.providerId !== targets[0].providerId && typeof body.fallback_voice === 'string' && body.fallback_voice)
          || t.voice || (body.voice as string),
        responseFormat: (body.response_format as string) as 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm' | undefined || 'mp3',
        speed: body.speed as number | undefined,
      }),
      { stage: 'tts', timeoutMs: 15_000, retriesPerProvider: 1, cooldownTracker: ttsCooldownTracker, breakers: circuitBreakers },
    );

    return {
      status: 200,
      headers: { 'Content-Type': result.contentType, ...headers },
      body: result.audio,
    };
  } catch (err) {
    log.error(`TTS error for model ${model}: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    return errorResponse(err, 'tts', model);
  }
}
