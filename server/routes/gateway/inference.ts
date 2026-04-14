/**
 * Inference routes — AI pipeline endpoints
 *
 * Routes:
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

import { createLogger } from '../../../src/logger';
const log = createLogger('routes/inference');

export function registerInferenceRoutes(handlers: Record<string, Function>): void {
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
