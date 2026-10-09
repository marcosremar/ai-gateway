/**
 * POST /v1/audio/speech — TTS
 */

import { hedgeCapOf } from '../internal-subrequest';
import type { TTSProvider } from '../../providers/cloud/types';
import type { ProxyRequest, ProxyResponse, StageRoutes } from '../types';
import { CooldownTracker } from '../../providers/cloud/fallback';
import { createLogger } from '../../../logger';
import { qwenTokenCap } from '../../../deployments/inference-providers';
import {
  errorResponse, normalizeTargets, providerUnavailableResponse, redactSecrets, routeRequest, stageBudgetMs,
} from '../provider-routing';
import type { CircuitBreakerRegistry } from '../../providers/cloud/circuit-breaker';

const ttsCooldownTracker = new CooldownTracker();

const log = createLogger('audio-speech');

const FORWARDED_EXTRAS = ['task_type', 'ref_audio', 'ref_text', 'language', 'stream_format', 'instructions'];

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

  if (body.ref_audio !== undefined && (typeof body.ref_audio !== 'string' || !body.ref_audio.startsWith('data:'))) {
    return { status: 400, body: { error: { message: 'ref_audio must be inline audio (a data: URI), never a URL', type: 'invalid_request_error' } } };
  }

  const model = body.model;
  const targets = normalizeTargets(ttsProviders[model]);
  if (targets.length === 0) {
    if (unavailable?.[model]) return providerUnavailableResponse('tts', model, unavailable[model]);
    return { status: 404, body: { error: { message: `TTS model "${model}" not found`, type: 'invalid_request_error' } } };
  }

  const extra: Record<string, unknown> = Object.fromEntries(FORWARDED_EXTRAS.filter(k => body[k] !== undefined).map(k => [k, body[k]]));
  const asked = body.max_new_tokens;
  if (typeof asked === 'number' && Number.isInteger(asked) && asked > 0 && asked <= qwenTokenCap(String(body.input))) extra.max_new_tokens = asked;
  const format = (body.response_format as string | undefined) || 'mp3';
  // wav/pcm can be streamed (first bytes before the whole sentence); `stream: false` turns it off.
  const stream = (format === 'wav' || format === 'pcm') && body.stream !== false;

  try {
    const { result, headers } = await routeRequest(
      targets,
      (t, signal) => t.provider.synthesize({
        signal,
        ...(t.providerId.startsWith('deployment:') ? { extra } : {}),
        stream,
        model: t.model ?? model,
        input: body.input as string,
        // Voices are provider-specific. A target with `voiceFor` (stock voice by gender) picks its own; otherwise a
        // fallback uses `fallback_voice` from the request (unless `fixedVoice`), else its configured voice.
        voice: t.voiceFor?.({
          voice: body.voice as string, ...(typeof body.fallback_voice === 'string' ? { fallbackVoice: body.fallback_voice } : {}),
        }) ?? ((t !== targets[0] && !t.fixedVoice && typeof body.fallback_voice === 'string' && body.fallback_voice)
          || t.voice || (body.voice as string)),
        responseFormat: format as 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm',
        speed: body.speed as number | undefined,
      }),
      { stage: 'tts', signal: req.signal, timeoutMs: 15_000, budgetMs: stageBudgetMs('tts'), hedgeCapMs: hedgeCapOf(req.headers), retriesPerProvider: 1, cooldownTracker: ttsCooldownTracker, breakers: circuitBreakers, notMounted: unavailable?.[model] },
    );

    if (result.stream) {
      return { status: 200, headers: { 'Content-Type': result.contentType, ...headers }, body: null, stream: result.stream };
    }
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
