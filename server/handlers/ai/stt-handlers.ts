/**
 * STT (Speech-to-Text) Handlers
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createLogger } from '../../../src/logger';
import { withTimeout } from '../../../src/timer-manager';
import { parseJsonBody, sendJson, sendError, generateRequestId, logRequestTiming, filterHallucinations } from './utils';
import { parseRawBody } from './utils';
import { getStageTimeout, HALLUCINATION_FILTER_CONFIG } from './config';
import type { TranscribeRequest, TranscribeResponse } from './types';

const log = createLogger('stt-handlers');

// Mock providers (in production, import from actual providers)
const mockSttProvider = {
  transcribe: async (audio: Buffer, options: { language?: string }) => {
    // Simulate STT processing
    await new Promise(resolve => setTimeout(resolve, 100));
    return {
      text: 'This is a test transcription',
      language: options.language || 'en',
      confidence: 0.95,
    };
  },
};

/**
 * Handle single transcription request
 */
export async function handleTranscribe(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = generateRequestId();
  const startTime = Date.now();

  log.log(`[${requestId}] Starting transcription`);

  try {
    // Parse request
    let audio: Buffer | undefined;
    let language: string | undefined;
    let prompt: string | undefined;

    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('multipart/form-data')) {
      // Parse multipart
      const body = await parseRawBody(req);
      // Simple multipart parsing
      const boundary = contentType.split('boundary=')[1];
      const parts = body.toString().split(`--${boundary}`);

      for (const part of parts) {
        if (part.includes('name="file"')) {
          const binaryStart = part.indexOf('\r\n\r\n') + 4;
          const binaryEnd = part.lastIndexOf('\r\n');
          audio = Buffer.from(part.slice(binaryStart, binaryEnd), 'binary');
        } else if (part.includes('name="language"')) {
          const valueStart = part.indexOf('\r\n\r\n') + 4;
          const valueEnd = part.lastIndexOf('\r\n');
          language = part.slice(valueStart, valueEnd).trim();
        }
      }
    } else {
      // Parse JSON
      const body = await parseJsonBody<{ audio: string; language?: string }>(req);
      audio = Buffer.from(body.audio, 'base64');
      language = body.language;
    }

    if (!audio) {
      sendError(res, 'No audio provided', 400);
      return;
    }

    // Get timeout
    const timeoutMs = getStageTimeout('stt', 'cloud');

    // Perform transcription with timeout
    const result = await withTimeout(
      'stt-transcribe',
      mockSttProvider.transcribe(audio, { language }),
      timeoutMs
    );

    // Filter hallucinations
    const filtered = filterHallucinations(result.text, HALLUCINATION_FILTER_CONFIG);

    logRequestTiming(requestId, 'STT', startTime, 'mock', true);

    sendJson(res, {
      success: true,
      text: filtered.text,
      language: result.language,
      confidence: result.confidence,
      filtered: filtered.filtered,
      requestId,
    });

  } catch (err) {
    log.error(`[${requestId}] Transcription error:`, err);
    logRequestTiming(requestId, 'STT', startTime, undefined, false);

    const errorMsg = err instanceof Error ? err.message : 'Transcription failed';
    sendError(res, errorMsg, 500);
  }
}

/**
 * Handle ensemble transcription (multiple providers)
 */
export async function handleEnsembleTranscribe(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = generateRequestId();
  const startTime = Date.now();

  log.log(`[${requestId}] Starting ensemble transcription`);

  try {
    // Parse request
    const body = await parseJsonBody<{ audio: string; language?: string; providers?: string[] }>(req);
    const audio = Buffer.from(body.audio, 'base64');
    const providers = body.providers || ['groq', 'deepgram'];

    if (!audio) {
      sendError(res, 'No audio provided', 400);
      return;
    }

    // Race multiple providers
    const timeoutMs = getStageTimeout('stt', 'cloud');

    const results = await Promise.allSettled(
      providers.map(async provider => {
        const providerStart = Date.now();
        try {
          const result = await withTimeout(
            `stt-${provider}`,
            mockSttProvider.transcribe(audio, { language: body.language }),
            timeoutMs
          );
          return {
            provider,
            result,
            duration: Date.now() - providerStart,
            success: true,
          };
        } catch (err) {
          return {
            provider,
            result: null,
            duration: Date.now() - providerStart,
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }
      })
    );

    // Find best result
    const successful = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter(r => r.success);

    if (successful.length === 0) {
      sendError(res, 'All providers failed', 500, {
        results: results.map(r =>
          r.status === 'fulfilled' ? r.value : { status: 'rejected', reason: r.reason }
        ),
      });
      return;
    }

    // Use result with highest confidence
    const best = successful.reduce((prev, current) =>
      (current.result.confidence || 0) > (prev.result.confidence || 0) ? current : prev
    );

    // Filter hallucinations
    const filtered = filterHallucinations(best.result.text, HALLUCINATION_FILTER_CONFIG);

    logRequestTiming(requestId, 'Ensemble STT', startTime, best.provider, true);

    sendJson(res, {
      success: true,
      text: filtered.text,
      language: best.result.language,
      confidence: best.result.confidence,
      provider: best.provider,
      duration: best.duration,
      allResults: successful.map(s => ({
        provider: s.provider,
        text: s.result.text,
        confidence: s.result.confidence,
        duration: s.duration,
      })),
      requestId,
    });

  } catch (err) {
    log.error(`[${requestId}] Ensemble transcription error:`, err);
    logRequestTiming(requestId, 'Ensemble STT', startTime, undefined, false);

    const errorMsg = err instanceof Error ? err.message : 'Ensemble transcription failed';
    sendError(res, errorMsg, 500);
  }
}
