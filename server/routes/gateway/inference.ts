/**
 * Inference routes — AI pipeline endpoints
 *
 * Routes (currently registered in ws-server.ts):
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
 *
 * TODO: These routes are currently defined in ws-server.ts.
 * This file will own their registration once ws-server.ts is refactored.
 */

export const routes = {};
