/**
 * POST /v1/audio/transcriptions — STT
 */

import type { STTProvider } from '../../providers/types';
import type { ProxyRequest, ProxyResponse } from '../types';
import { withProxyRetry } from './retry';

export async function handleAudioTranscriptions(
  req: ProxyRequest,
  sttProviders: Record<string, STTProvider>,
): Promise<ProxyResponse> {
  // For multipart/form-data, the body should already be parsed
  // In practice, audio transcriptions need raw binary + model field
  const body = req.body as {
    model: string;
    language?: string;
    prompt?: string;
    response_format?: string;
  };

  if (!body.model) {
    return { status: 400, body: { error: { message: 'model is required', type: 'invalid_request_error' } } };
  }

  const provider = sttProviders[body.model];
  if (!provider) {
    return { status: 404, body: { error: { message: `STT model "${body.model}" not found`, type: 'invalid_request_error' } } };
  }

  try {
    const result = await withProxyRetry(
      provider.providerId,
      body.model,
      () => provider.transcribe({
        audio: req.rawBody,
        model: body.model,
        language: body.language,
        prompt: body.prompt,
        responseFormat: body.response_format as 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt',
      }),
      'STT',
    );

    return {
      status: 200,
      body: { text: result.text },
    };
  } catch (err) {
    return {
      status: 500,
      body: { error: { message: String(err), type: 'server_error' } },
    };
  }
}
