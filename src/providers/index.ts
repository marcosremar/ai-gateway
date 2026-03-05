// Barrel file for @parle/ai-gateway/providers

// ── Registry ──────────────────────────────────────────────────────────────
export { AIProviderRegistry } from './registry';

// ── Types ─────────────────────────────────────────────────────────────────
export type {
  ProviderId,
  AIProviderId,
  ProviderCapability,
  ProviderDescriptor,
  ModelInfo,
  STTProvider,
  TTSProvider,
  LLMProvider,
  RealtimeProvider,
  ImageProvider,
  OmniProvider,
  STTRequest,
  STTResponse,
  TTSRequest,
  TTSResponse,
  TTSAudioFormat,
  VoiceInfo,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  RealtimeSessionConfig,
  RealtimeSession,
  RealtimeTransport,
  ImageRequest,
  ImageResponse,
  OmniRequest,
  OmniResponse,
  AIProviderSettings,
} from './types';

// ── Fallback ──────────────────────────────────────────────────────────────
export { withProviderFallback, isRetryableError, isContextWindowError, isTimeoutError, getCooldownState } from './fallback';
export type { FallbackEntry, FallbackOptions } from './fallback';

// ── Chain Builder ─────────────────────────────────────────────────────────
export { buildFallbackChain, resolveApiKey, getSystemLlmEntryFromSettings, getSystemSttEntryFromSettings } from './chain-builder';
export type { SavedProfile, PipelineStageConfig, UserProviderSettings } from './chain-builder';

// ── Classification ────────────────────────────────────────────────────────
export { ProviderClassification } from './classification';

// ── Declarative Chain ─────────────────────────────────────────────────────
export { resolveDeclarativeChain, findChainForStage } from './declarative-chain';
export type { FallbackChainConfig, FallbackChainEntry, ResolvedChain } from './declarative-chain';

// ── Errors ────────────────────────────────────────────────────────────────
export { PROVIDER_LABELS, BILLING_URLS, buildProviderError, extractErrorStatus, extractErrorMessage, CreditExhaustedError } from './errors';

// ── Credit Block ──────────────────────────────────────────────────────────
export { CreditBlockTracker, defaultCreditBlockTracker, hashApiKey } from './credit-block';

// ── Voice Catalog ─────────────────────────────────────────────────────────
export type { VoiceGender, VoiceSlot, ProviderVoice, ProviderVoiceCatalog, VoiceMapping, VoiceMappingConfig } from './voice-catalog';
export {
  VOICE_SLOTS, OPENAI_VOICE_CATALOG, KOKORO_VOICE_CATALOG, QWEN3_VOICE_CATALOG,
  SKYPILOT_VOICE_CATALOG, MOSS_TTS_VOICE_CATALOG, MODAL_VOICE_CATALOG,
  getAllVoiceCatalogs, getVoiceCatalog, getVoicesForProviderModel,
  getLanguagesFromCatalog, filterVoicesByLanguage, getDefaultVoiceMappings, resolveVoiceSlot,
} from './voice-catalog';

// ── OpenAI-Compatible Base Classes ────────────────────────────────────────
export { OpenAICompatSTTProvider, OpenAICompatTTSProvider, OpenAICompatLLMProvider } from './openai-compat';
export type { OpenAICompatSTTConfig, OpenAICompatTTSConfig, OpenAICompatLLMConfig } from './openai-compat';
export { detectAudioFormat, prepareAudioFile } from './openai-compat';

// ── Groq ──────────────────────────────────────────────────────────────────
export { groqSTT, groqTTS, groqLLM } from './groq';
export { GROQ_STT_MODELS, GROQ_TTS_MODELS, GROQ_TTS_VOICES, GROQ_LLM_MODELS } from './groq';

// ── OpenRouter ────────────────────────────────────────────────────────────
export { openrouterLLM, openrouterImage, OpenRouterImageProvider } from './openrouter';
export { OPENROUTER_LLM_MODELS, OPENROUTER_IMAGE_MODELS } from './openrouter';

// ── OpenAI ────────────────────────────────────────────────────────────────
export { OpenAISTTProvider } from './openai/openai-stt';
export { OpenAITTSProvider } from './openai/openai-tts';
export { OpenAIRealtimeProvider } from './openai/openai-realtime';
export { OpenAIOmniProvider } from './openai/openai-omni';
export { OPENAI_STT_MODELS, OPENAI_TTS_MODELS, OPENAI_OMNI_MODELS, OPENAI_REALTIME_MODELS, OPENAI_VOICES, OPENAI_IMAGE_MODELS } from './openai/models';
export { openaiImage, OpenAIImageProvider } from './openai/openai-image';

// ── Fireworks ─────────────────────────────────────────────────────────────
export { fireworksSTT, fireworksLLM, fireworksImage, FireworksImageProvider } from './fireworks';
export { FIREWORKS_STT_MODELS, FIREWORKS_LLM_MODELS, FIREWORKS_IMAGE_MODELS } from './fireworks';

// ── Modal (MOSS-TTS) ──────────────────────────────────────────────────────
export { ModalTTSProvider, modalTTS, MODAL_TTS_MODELS } from './modal';

// ── Self-Hosted ───────────────────────────────────────────────────────────
export { SelfHostedSTTProvider, SelfHostedTTSProvider, SelfHostedLLMProvider } from './self-hosted/self-hosted-provider';
