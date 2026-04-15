/**
 * AI Handlers — Modular Implementation
 * 
 * Split from the original 1422-line ai-handlers.ts into focused modules:
 * - types.ts: TypeScript interfaces
 * - config.ts: Configuration and timeouts
 * - utils.ts: Utility functions
 * - stt-handlers.ts: Speech-to-text handlers
 * - tts-translate-handlers.ts: TTS and translation handlers
 */

// Types
export type {
  TranscribeRequest,
  TranscribeResponse,
  TranslateRequest,
  TranslateResponse,
  TtsPreviewRequest,
  TtsPreviewResponse,
  PipelineRequest,
  PipelineResponse,
  ChatCompletionRequest,
  ChatCompletionResponse,
  VoiceProfile,
  AutoSwapConfig,
  AnalyticsResponse,
  HttpHandler,
  TimeoutConfig,
} from './types';

// Config
export {
  DEFAULT_TIMEOUTS,
  GPU_TIMEOUTS,
  CLOUD_TIMEOUTS,
  HALLUCINATION_FILTER_CONFIG,
  ENSEMBLE_STT_PROVIDERS,
  PROVIDER_PRIORITY,
  adaptiveTimeout,
  getStageTimeout,
  validateLanguage,
  getLanguageName,
} from './config';

// Utils
export {
  parseJsonBody,
  parseRawBody,
  extractAudioFromMultipart,
  sendJson,
  sendError,
  sendAudio,
  generateRequestId,
  logRequestTiming,
  filterHallucinations,
  createSseStream,
  parseQueryParams,
  wantsStream,
  wantsBinaryAudio,
} from './utils';

// STT Handlers
export {
  handleTranscribe,
  handleEnsembleTranscribe,
} from './stt-handlers';

// TTS and Translation Handlers
export {
  handleTtsPreview,
  handleTranslate,
  handleBatchTranslate,
} from './tts-translate-handlers';
