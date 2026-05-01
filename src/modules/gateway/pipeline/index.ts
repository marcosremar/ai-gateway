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
  isPrivateUrlResolved,
  validateEndpointUrl,
  validateEndpointUrlResolved,
  validateRemoteEndpoint,
  validateRemoteEndpointResolved,
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

export { runPipelineOrchestrator, ewmaRaceOpts } from './pipeline-orchestrator';
export type {
  PipelineCallbacks,
  PipelineOpts,
  PipelineResult,
  PipelineLabsFlags,
  PipelineRouting,
  PipelineSideEffects,
  PipelineStageExecutors,
  PipelineDeps,
} from './pipeline-orchestrator';

export { runSttStage, runLlmStage, runTtsStage } from './hybrid-stages';
export type {
  HybridStagesDeps, HybridStagesClient, HybridStagesModalTTS, PipelineStageParams,
} from './hybrid-stages';

export { generateTtsPreview } from './tts-preview';
export type { TtsPreviewInput, TtsPreviewResult, TtsPreviewDeps } from './tts-preview';

export { resolveChatProvider, buildOpenAiChatResponse } from './chat-completions-service';
export type { ChatProviderAdapter, ChatCompletionsDeps, OpenAiChatResponse } from './chat-completions-service';

export { buildAtomicResponseBody, computeNetworkMs, extractAtomicAudio } from './atomic-response';
export type { AtomicPipelineResult, AtomicResponseBody } from './atomic-response';

export { runTranslateRace, buildTranslatePrompt } from './translate-service';
export type { TranslateServiceInput, TranslateServiceDeps, TranslateServiceResult } from './translate-service';

export { runShadowStage } from './shadow-mode';
export type { ShadowRunDeps } from './shadow-mode';

export { ModalKeepalive } from './modal-keepalive';
export type { ModalKeepaliveOptions } from './modal-keepalive';

export { runFanoutOrchestrator } from './fanout-orchestrator';
export type {
  FanoutOpts,
  FanoutRouting,
  FanoutSideEffects,
  FanoutStageExecutors,
  FanoutDeps,
} from './fanout-orchestrator';

export { PipelinePluginRegistry, pipelinePlugins } from './plugin-registry';
export type {
  PipelinePlugin,
  PluginContext,
  PipelineStage,
  PluginPreSTTHook,
  PluginPostSTTHook,
  PluginPreLLMHook,
  PluginPostLLMHook,
  PluginPreTTSHook,
  PluginPostTTSHook,
} from './plugin-registry';
