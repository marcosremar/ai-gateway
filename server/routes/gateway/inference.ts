/**
 * Inference routes — AI pipeline endpoints
 *
 * Routes:
 *   GET  /v1/models                  — OpenAI-compatible model catalog
 *   POST /v1/transcribe              — Speech-to-text
 *   POST /v1/transcribe/ensemble     — Ensemble transcription
 *   POST /v1/chat/completions        — LLM chat completions
 *   POST /v1/translate               — Translation
 *   POST /v1/tts/preview             — TTS preview
 *   POST /v1/speech                  — Full STT->LLM->TTS pipeline
 *   POST /v1/detect-language         — Language detection
 *   GET  /v1/auto-swap/status        — Auto-swap provider status
 *   POST /v1/auto-swap/toggle        — Toggle auto-swap
 *   POST /v1/auto-swap/benchmark     — Run auto-swap benchmark
 *   POST /v1/video/generate          — Video generation (wan-i2v GPU)
 *   GET  /v1/playground/catalog      — Playground model catalog
 *   POST /v1/playground/stt          — Playground STT
 *   POST /v1/playground/llm          — Playground LLM
 *   POST /v1/playground/tts          — Playground TTS
 *   POST /v1/playground/pipeline     — Playground full pipeline
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createLogger } from '../../../src/logger';
const log = createLogger('routes/inference');

/**
 * GET /v1/models — OpenAI-compatible model list derived from active app's pipeline chain.
 */
async function handleModels(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const models = new Map<string, { id: string; object: 'model'; created: number; owned_by: string; capability: string }>();

  try {
    const cfg = require('../../config-persistence');
    const app = await cfg.getActiveApp?.();
    const add = (capability: string, providers: Array<{ provider?: string; model?: string }> | undefined) => {
      if (!Array.isArray(providers)) return;
      for (const p of providers) {
        const id = p?.model;
        if (!id || models.has(id)) continue;
        models.set(id, { id, object: 'model', created: now, owned_by: p.provider || 'ai-gateway', capability });
      }
    };
    if (app) {
      add('stt', app.stt);
      add('llm', app.llm);
      add('tts', app.tts);
    }
  } catch (e: any) {
    log.warn(`[/v1/models] config read failed: ${e?.message?.slice(0, 80)}`);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: Array.from(models.values()) }));
}

export function registerInferenceRoutes(handlers: Record<string, Function>): void {
  // OpenAI-compatible model catalog
  handlers['GET /v1/models'] = handleModels;

  // AI handlers (inference endpoints) + Auto-swap
  try {
    const ai = require('../../ai-handlers');
    Object.assign(handlers, {
      // Inference
      'POST /v1/transcribe': ai.handleTranscribe,
      'POST /v1/transcribe/ensemble': ai.handleEnsembleTranscribe,
      'POST /v1/chat/completions': ai.handleChatCompletions,
      'POST /v1/translate': ai.handleTranslate,
      'POST /v1/tts/preview': ai.handleTtsPreview,
      'POST /v1/speech': ai.handlePipeline,
      'POST /v1/detect-language': ai.handleDetectLanguage,
      // Auto-swap
      'GET /v1/auto-swap/status': ai.handleAutoSwapStatus,
      'POST /v1/auto-swap/toggle': ai.handleAutoSwapToggle,
      'POST /v1/auto-swap/benchmark': ai.handleAutoSwapBenchmark,
    });
  } catch { /* ai-handlers module optional — serve.ts proxy can run without them */ }

  // Video generation (wan-i2v GPU)
  try {
    const vh = require('../../video-handlers');
    Object.assign(handlers, {
      'POST /v1/video/generate': vh.handleVideoGenerate,
    });
  } catch (e: any) {
    log.warn(`[routes/inference] video-handlers not loaded: ${e.message?.slice(0, 80)}`);
  }

  // Playground
  try {
    const pg = require('../../playground-handlers');
    Object.assign(handlers, {
      'GET /v1/playground/catalog': pg.handlePlaygroundCatalog,
      'POST /v1/playground/stt': pg.handlePlaygroundStt,
      'POST /v1/playground/llm': pg.handlePlaygroundLlm,
      'POST /v1/playground/tts': pg.handlePlaygroundTts,
      'POST /v1/playground/pipeline': pg.handlePlaygroundPipeline,
    });
  } catch { /* playground handlers are optional — absent module means feature off */ }
}
