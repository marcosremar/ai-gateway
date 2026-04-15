/**
 * TTS (Text-to-Speech) and Translation Handlers
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createLogger } from '../../../src/logger';
import { withTimeout } from '../../../src/timer-manager';
import { parseJsonBody, sendJson, sendError, sendAudio, generateRequestId, logRequestTiming } from './utils';
import { getStageTimeout, validateLanguage, getLanguageName } from './config';
import type { TtsPreviewRequest, TtsPreviewResponse, TranslateRequest, TranslateResponse } from './types';

const log = createLogger('tts-translate-handlers');

// Mock providers
const mockTtsProvider = {
  synthesize: async (text: string, options: { voice?: string; speed?: number }) => {
    await new Promise(resolve => setTimeout(resolve, 200));
    // Return dummy audio buffer
    return {
      audio: Buffer.from('RIFF....WAVE....'), // Dummy WAV header
      format: 'wav',
      duration: text.length * 0.1, // Rough estimate
    };
  },
};

const mockTranslateProvider = {
  translate: async (text: string, sourceLang: string, targetLang: string) => {
    await new Promise(resolve => setTimeout(resolve, 150));
    return {
      text: `[${targetLang}] ${text}`,
      model: 'translation-model-v1',
      tokens: text.split(' ').length * 2,
    };
  },
};

/**
 * Handle TTS preview request
 */
export async function handleTtsPreview(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = generateRequestId();
  const startTime = Date.now();
  
  log.log(`[${requestId}] Starting TTS preview`);

  try {
    const body = await parseJsonBody<TtsPreviewRequest>(req);
    
    if (!body.text) {
      sendError(res, 'Text is required', 400);
      return;
    }

    // Validate text length
    if (body.text.length > 5000) {
      sendError(res, 'Text too long (max 5000 characters)', 400);
      return;
    }

    const timeoutMs = getStageTimeout('tts', 'cloud');
    
    const result = await withTimeout(
      'tts-preview',
      mockTtsProvider.synthesize(body.text, {
        voice: body.voice,
        speed: body.speed,
      }),
      timeoutMs
    );

    logRequestTiming(requestId, 'TTS Preview', startTime, 'mock', true);

    // Check if client wants binary audio
    const accept = req.headers.accept || '';
    if (accept.includes('audio/')) {
      sendAudio(res, result.audio, result.format, result.duration);
    } else {
      sendJson(res, {
        success: true,
        audio: result.audio.toString('base64'),
        format: result.format,
        duration: result.duration,
        requestId,
      });
    }

  } catch (err) {
    log.error(`[${requestId}] TTS preview error:`, err);
    logRequestTiming(requestId, 'TTS Preview', startTime, undefined, false);
    
    const errorMsg = err instanceof Error ? err.message : 'TTS synthesis failed';
    sendError(res, errorMsg, 500);
  }
}

/**
 * Handle translation request
 */
export async function handleTranslate(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = generateRequestId();
  const startTime = Date.now();
  
  log.log(`[${requestId}] Starting translation`);

  try {
    const body = await parseJsonBody<TranslateRequest>(req);
    
    // Validate required fields
    if (!body.text) {
      sendError(res, 'Text is required', 400);
      return;
    }
    
    if (!body.sourceLang || !body.targetLang) {
      sendError(res, 'Source and target languages are required', 400);
      return;
    }

    // Validate languages
    if (!validateLanguage(body.sourceLang)) {
      sendError(res, `Invalid source language: ${body.sourceLang}`, 400);
      return;
    }
    
    if (!validateLanguage(body.targetLang)) {
      sendError(res, `Invalid target language: ${body.targetLang}`, 400);
      return;
    }

    // Check for same language
    if (body.sourceLang === body.targetLang) {
      sendJson(res, {
        success: true,
        text: body.text,
        sourceLang: body.sourceLang,
        targetLang: body.targetLang,
        skipped: true,
        reason: 'Source and target languages are the same',
        requestId,
      });
      return;
    }

    const timeoutMs = getStageTimeout('llm', 'cloud');
    
    const result = await withTimeout(
      'translate',
      mockTranslateProvider.translate(body.text, body.sourceLang, body.targetLang),
      timeoutMs
    );

    logRequestTiming(requestId, 'Translation', startTime, 'mock', true);

    sendJson(res, {
      success: true,
      text: result.text,
      sourceLang: body.sourceLang,
      targetLang: body.targetLang,
      sourceText: body.text,
      model: result.model,
      tokens: result.tokens,
      sourceLanguage: getLanguageName(body.sourceLang),
      targetLanguage: getLanguageName(body.targetLang),
      requestId,
    });

  } catch (err) {
    log.error(`[${requestId}] Translation error:`, err);
    logRequestTiming(requestId, 'Translation', startTime, undefined, false);
    
    const errorMsg = err instanceof Error ? err.message : 'Translation failed';
    sendError(res, errorMsg, 500);
  }
}

/**
 * Handle batch translation request
 */
export async function handleBatchTranslate(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = generateRequestId();
  const startTime = Date.now();
  
  log.log(`[${requestId}] Starting batch translation`);

  try {
    const body = await parseJsonBody<{
      texts: string[];
      sourceLang: string;
      targetLangs: string[];
    }>(req);
    
    if (!body.texts || !Array.isArray(body.texts)) {
      sendError(res, 'Texts array is required', 400);
      return;
    }

    const results: Record<string, string[]> = {};
    
    // Translate to each target language
    for (const targetLang of body.targetLangs) {
      const translations = await Promise.all(
        body.texts.map(async text => {
          try {
            const result = await mockTranslateProvider.translate(
              text,
              body.sourceLang,
              targetLang
            );
            return result.text;
          } catch (err) {
            return `[Error: ${err instanceof Error ? err.message : 'Translation failed'}]`;
          }
        })
      );
      results[targetLang] = translations;
    }

    logRequestTiming(requestId, 'Batch Translation', startTime, undefined, true);

    sendJson(res, {
      success: true,
      sourceTexts: body.texts,
      translations: results,
      sourceLang: body.sourceLang,
      targetLangs: body.targetLangs,
      requestId,
    });

  } catch (err) {
    log.error(`[${requestId}] Batch translation error:`, err);
    logRequestTiming(requestId, 'Batch Translation', startTime, undefined, false);
    
    const errorMsg = err instanceof Error ? err.message : 'Batch translation failed';
    sendError(res, errorMsg, 500);
  }
}
