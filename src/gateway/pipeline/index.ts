// ── BabelCast Gateway — Pipeline Module Index ────────────────────────────────

export {
  LRUCache,
  getCachedTranslation,
  setCachedTranslation,
  getTranslationCacheStats,
  adaptiveMaxTokens,
  startTranslationCacheSweep,
  stopTranslationCacheSweep,
} from './translation-cache';

export {
  TRANSLATION_STYLES,
  buildSystemPrompt,
  resolveVoiceForProfile,
} from './system-prompt';

export {
  SSRF_BLOCKED_IP_PATTERNS,
  SSRF_BLOCKED_HOSTS,
  isPrivateUrl,
  validateEndpointUrl,
  validateRemoteEndpoint,
} from './ssrf-protection';

export {
  fetchGpuSTT,
  fetchGpuLLM,
  fetchGpuTTS,
} from './gpu-fetch';
export type {
  GpuSTTResult,
  GpuLLMResult,
  GpuTTSResult,
  StageRecorder,
} from './gpu-fetch';

export {
  encodePipelineResponse,
  wantsBinaryAudio,
} from './pipeline-response';
export type {
  SttStageResult,
  LlmStageResult,
  TtsStageResult,
  PipelineResponseBody,
} from './pipeline-response';

export {
  GPU_STT_TIMEOUT_MS,
  GPU_LLM_TIMEOUT_MS,
  GPU_TTS_TIMEOUT_MS,
  GPU_PIPELINE_TIMEOUT_MS,
} from './timeouts';

export {
  storeVoiceReference,
  getVoiceReference,
  clearVoiceReferences,
  getVoiceReferenceCacheSize,
} from './voice-reference-cache';

export { SpeculativeCache, speculativeCache } from './speculative-cache';
export { StreamingOverlap } from './streaming-overlap';
export type { OverlapStats } from './streaming-overlap';
