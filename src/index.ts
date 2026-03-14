// @parle/ai-gateway — Unified AI Gateway + GPU autoscaler

// ── HTTP Client SDK ─────────────────────────────────────────────────────────
export { GatewayHttpClient, GatewayHttpError, CircuitOpenError as HttpCircuitOpenError } from '../sdk/node';
export { CircuitBreaker as HttpCircuitBreaker } from '../sdk/node';
export type {
  GatewayHttpClientConfig,
  RetryConfig,
  CircuitBreakerConfig as HttpCircuitBreakerConfig,
  TimeoutConfig,
  HealthStatus,
  ComponentHealth,
  GatewayMetrics,
  TranscribeResult as HttpTranscribeResult,
  TranslateResult as HttpTranslateResult,
  PipelineResult as HttpPipelineResult,
  PipelineOptions as HttpPipelineOptions,
  PipelineTiming as HttpPipelineTiming,
  DeployOptions as HttpDeployOptions,
  GpuStatus as HttpGpuStatus,
} from '../sdk/node';

// ── Unified Gateway API ──────────────────────────────────────────────────────
export { createGateway } from './create-gateway';
export type { GatewayConfig } from './create-gateway';
export type { Gateway } from './gateway-api';
export type { GatewayStorage } from './storage';

// ── Autoscaler Factory ──────────────────────────────────────────────────────
export { createAutoscaler } from './factory';
export type { Autoscaler, CreateAutoscalerOptions } from './factory';

// ── Gateway Singleton (legacy — prefer createGateway) ────────────────────────
export { initGateway, getGateway, resetGateway } from './gateway';
export type { InitGatewayOptions } from './gateway';

// ── Built-in Adapters ──────────────────────────────────────────────────────
export { InMemoryStateAdapter } from './adapters/in-memory-state';
export { RedisStateAdapter } from './adapters/redis-state';
export type { RedisLike } from './adapters/redis-state';

// ── Autoscaler Types ────────────────────────────────────────────────────────
export type {
  AutoScaleRoute,
  GpuBootState,
  ScaleTrigger,
  GpuProvider,
  StageTimeouts,
  GpuTierConfig,
  AutoScalerConfig,
  GpuTierState,
  IdleTierState,
  BootingTierState,
  ReadyTierState,
  AutoScaleDecision,
  DeploySessionRecord,
} from './types';
export { DEFAULT_STAGE_TIMEOUTS, resolveStageTimeouts } from './types';

// ── DI Interfaces ────────────────────────────────────────────────────────────
export type {
  AutoscalerDeps,
  SettingsStore,
  StateStore,
  KvStore,
  ListStore,
  HashStore,
  SessionResolver,
  Logger,
  CredentialStore,
  LifecycleLogStore,
  UserRoleResolver,
  BenchmarkStore,
  UsageLogStore,
  VaultStore,
} from './deps';

// ── GPU Provider types ──────────────────────────────────────────────────────
export type {
  ProviderCredentials,
  GpuInstance,
  InstanceSpec,
  GpuProviderClient,
  MonitorableProvider,
  OnInstancePersist,
} from './gpu-providers/types';

// ── GPU Provider base class ─────────────────────────────────────────────────
/** @internal Base class for GPU providers — use AIClient.deploy()/destroyInstance() instead. */
export { AbstractGpuProvider, FetchError, TIMEOUTS } from './gpu-providers/abstract-provider';
export type { AbstractGpuProviderOptions } from './gpu-providers/abstract-provider';

// ── GPU Provider Registry (used internally by AIClient + Autoscaler) ────────
export { GpuProviderRegistry } from './gpu-providers/registry';

// NOTE: Individual GPU provider classes (RunpodClient, TensordockClient, VastClient, ModalClient)
// are intentionally NOT exported from the public API. They are implementation details.
// Use AIClient.deploy() / destroyInstance() / waitForHealth() for GPU lifecycle management.
// For advanced use (autoscaler factory), import from '@ai-gateway/gpu-providers' directly.

// ── Autoscaler Config Loader ─────────────────────────────────────────────────
export { loadAutoscalerConfig } from './autoscaler/config-loader';

// ── Autoscaler core (advanced use) ──────────────────────────────────────────
export { probeGpuHealth, probeGpuHealthSsh } from './autoscaler/health';
export { PROVIDER_BOOT_SECS } from './factory';
export { MAX_BOOT_FAILURES, BOOT_COOLDOWN_BASE_MS, BOOT_COOLDOWN_MAX_MS, StageTimeoutError } from './autoscaler/engine';
export type { AutoscalerEngineOptions } from './autoscaler/engine';
export { handleBootTimeout } from './autoscaler/boot-timeout';
export { probeAllTiers, processHealthResults } from './autoscaler/health-checker';
export { buildDecision } from './autoscaler/decision-builder';
export { defaultLogger } from './logger';
export { LATENCY_BREACH_COUNT, computeP95, countRecentBreaches } from './autoscaler/latency-tracker';
export { runWatchdogCycle, startBackgroundTicker } from './autoscaler/watchdog';
export { StatePersistence } from './autoscaler/state-persistence';
export { runCostMonitorCycle, startCostMonitorTicker, _resetStaleTracking } from './autoscaler/cost-monitor';
export type {
  ProviderAccount,
  OrphanedInstance,
  CostMonitorReport,
  CostMonitorDeps,
  WasteType,
} from './autoscaler/cost-monitor';

// ── GPU Lifecycle Logger ──────────────────────────────────────────────────
export { noopLifecycleLogger } from './autoscaler/lifecycle-logger';
export type { GpuLifecycleLogger, GpuLifecycleLogEntry } from './autoscaler/lifecycle-logger';

// ── Tier Lifecycle Management ────────────────────────────────────────────
export type { TierActionResult, TierDetail } from './autoscaler/tier-lifecycle';

// ── Benchmark Tracking ──────────────────────────────────────────────────
export { BenchmarkTracker } from './tracking/benchmark-tracker';
export type {
  BootBenchmark,
  InferenceBenchmark,
  BenchmarkStats,
  BenchmarkSummary,
  BenchmarkTrend,
} from './tracking/benchmark-tracker';

// ── Observability Hooks (F8) ──────────────────────────────────────────────
export { emitHook } from './hooks';
export type {
  GatewayHooks,
  RequestStartEvent,
  RequestEndEvent,
  FallbackEvent,
  ScaleUpEvent,
  ScaleDownEvent,
  CostAlertEvent,
  HealthChangeEvent,
  ErrorEvent,
} from './hooks';

// ── Health-Aware Load Balancing (F10) ─────────────────────────────────────
export { LoadBalancer } from './autoscaler/load-balancer';
export type { LoadBalanceStrategy, TierLatencyMetrics } from './autoscaler/load-balancer';

// ── Declarative Fallback Chains (F1) ──────────────────────────────────────
export { resolveDeclarativeChain, findChainForStage } from './providers/declarative-chain';
export type { FallbackChainConfig, FallbackChainEntry, ResolvedChain } from './providers/declarative-chain';

// ── Spend Tracking (F9) ──────────────────────────────────────────────────
export { SpendTracker } from './tracking/spend-tracker';
export type { SpendRecord, SpendSummary, BudgetConfig, BudgetStatus } from './tracking/spend-tracker';
export { DEFAULT_PRICING_TABLE, lookupPricing, estimateRequestCost } from './tracking/pricing';
export type { ModelPricing } from './tracking/pricing';
export { createCostAnomalyDetector } from './tracking/cost-anomaly-detector';
export type { CostAnomaly, CostAnomalyDetectorConfig } from './tracking/cost-anomaly-detector';

// ── Predictive Pre-Warm (F4) ─────────────────────────────────────────────
export {
  recordUsageForPrediction,
  shouldPreWarm,
  runPredictiveWarmupForUser,
  startPredictiveWarmupTicker,
} from './autoscaler/predictive-warmup';
export type { PredictiveWarmupConfig, PredictiveWarmupDeps } from './autoscaler/predictive-warmup';

// ── AI Provider types ──────────────────────────────────────────────────────
export { AIProviderRegistry } from './providers/registry';
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
} from './providers/types';
export { withProviderFallback, isRetryableError, isContextWindowError, getCooldownState } from './providers/fallback';
export type { FallbackEntry, FallbackOptions } from './providers/fallback';
export { buildFallbackChain, resolveApiKey, getSystemLlmEntryFromSettings, getSystemSttEntryFromSettings } from './providers/chain-builder';
export type { SavedProfile, PipelineStageConfig, UserProviderSettings } from './providers/chain-builder';
export { ProviderClassification } from './providers/classification';

// ── OpenAI-Compatible Base Classes ──────────────────────────────────────────
export { OpenAICompatSTTProvider } from './providers/openai-compat';
export { OpenAICompatTTSProvider } from './providers/openai-compat';
export { OpenAICompatLLMProvider } from './providers/openai-compat';
export { OpenAICompatEmbeddingProvider } from './providers/openai-compat';
export type { OpenAICompatSTTConfig, OpenAICompatTTSConfig, OpenAICompatLLMConfig, OpenAICompatEmbeddingConfig } from './providers/openai-compat';
export type { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse } from './providers/openai-compat';
export { detectAudioFormat, prepareAudioFile } from './providers/openai-compat';

// ── Groq Provider ───────────────────────────────────────────────────────────
export { groqSTT, groqTTS, groqLLM } from './providers/groq';
export { GROQ_STT_MODELS, GROQ_TTS_MODELS, GROQ_TTS_VOICES, GROQ_LLM_MODELS } from './providers/groq';

// ── Ollama Provider (Local) ─────────────────────────────────────────────────
export { ollamaLLM, ollamaSTT, OllamaLLMProvider, OllamaSTTProvider } from './providers/ollama';
export { OLLAMA_STT_MODELS, OLLAMA_LLM_MODELS } from './providers/ollama';

// ── OpenRouter Provider ─────────────────────────────────────────────────────
export { openrouterLLM, openrouterImage, OpenRouterImageProvider } from './providers/openrouter';
export { OPENROUTER_LLM_MODELS, OPENROUTER_IMAGE_MODELS } from './providers/openrouter';

// ── Cloud Provider Health Probes ───────────────────────────────────────────
export { probeCloudProvider, probeAllCloudProviders } from './providers/cloud-health';
export type { CloudProbeResult } from './providers/cloud-health';

// ── Provider Errors ────────────────────────────────────────────────────────
export { PROVIDER_LABELS, BILLING_URLS, buildProviderError, extractErrorStatus, extractErrorMessage, CreditExhaustedError } from './providers/errors';

// ── Credit Block Tracking ──────────────────────────────────────────────────
export { CreditBlockTracker, defaultCreditBlockTracker, hashApiKey } from './providers/credit-block';

// ── Voice Catalog ──────────────────────────────────────────────────────────
export type { VoiceGender, VoiceSlot, ProviderVoice, ProviderVoiceCatalog, VoiceMapping, VoiceMappingConfig } from './providers/voice-catalog';
export {
  VOICE_SLOTS, OPENAI_VOICE_CATALOG, KOKORO_VOICE_CATALOG, QWEN3_VOICE_CATALOG,
  SKYPILOT_VOICE_CATALOG, MOSS_TTS_VOICE_CATALOG, MODAL_VOICE_CATALOG,
  getAllVoiceCatalogs, getVoiceCatalog, getVoicesForProviderModel,
  getLanguagesFromCatalog, filterVoicesByLanguage, getDefaultVoiceMappings, resolveVoiceSlot,
} from './providers/voice-catalog';

// ── OpenAI Providers ───────────────────────────────────────────────────────
export { OpenAISTTProvider } from './providers/openai/openai-stt';
export { OpenAITTSProvider } from './providers/openai/openai-tts';
export { OpenAIRealtimeProvider } from './providers/openai/openai-realtime';
export { OpenAIOmniProvider } from './providers/openai/openai-omni';

// ── OpenAI Model Constants ─────────────────────────────────────────────────
export { OPENAI_STT_MODELS, OPENAI_TTS_MODELS, OPENAI_OMNI_MODELS, OPENAI_REALTIME_MODELS, OPENAI_VOICES } from './providers/openai/models';

// ── OpenAI Image Provider ───────────────────────────────────────────────────
export { openaiImage, OpenAIImageProvider } from './providers/openai/openai-image';
export { OPENAI_IMAGE_MODELS } from './providers/openai/models';

// ── Fireworks Provider ──────────────────────────────────────────────────────
export { fireworksSTT, fireworksLLM, fireworksImage, FireworksImageProvider } from './providers/fireworks';
export { FIREWORKS_STT_MODELS, FIREWORKS_LLM_MODELS, FIREWORKS_IMAGE_MODELS } from './providers/fireworks';

// ── Modal Provider (MOSS-TTS) ──────────────────────────────────────────────
export { ModalTTSProvider, modalTTS, MODAL_TTS_MODELS } from './providers/modal';

// ── Self-Hosted Providers ───────────────────────────────────────────────────
export { SelfHostedSTTProvider, SelfHostedTTSProvider, SelfHostedLLMProvider } from './providers/self-hosted/self-hosted-provider';

// ── AIClient ───────────────────────────────────────────────────────────────
export { createAIClient, AIClient } from './client';
export {
  VOICE_PROFILE,
  CHAT_PROFILE,
  STT_PROFILE,
  TTS_PROFILE,
  LLM_PROFILE,
  IMAGE_PROFILE,
  SYSTEM_PROFILE,
  resolveProfile,
  mergeProfiles,
} from './client';
export type {
  AIProfile,
  PresetName,
  StageConfig,
  AIClientOptions,
  TranscribeResult,
  ChatResult,
  SynthesizeResult,
  ImageResult,
  OmniResult,
  RealtimeResult,
  PipelineResult,
  DeployResult,
  GpuTransport,
  GpuPipelineResponse,
  GpuHealthResponse,
  /** @deprecated Use pipeline() instead of pipelineStream(). */
  PipelineEvent,
  /** @deprecated Use pipeline() instead of pipelineStream(). */
  PipelineStage,
} from './client';

// ── Browser SDK (SpeechClient) ──────────────────────────────────────────
// NOTE: SpeechClient and streaming transports are legacy. Server-side code
// should use AIClient.pipeline() or POST /v1/speech (JSON, transport-transparent).
export { SpeechClient } from './browser';
/** @deprecated Streaming transports removed from proxy. Use POST /v1/speech. */
export { WebSocketTransport, SSETransport, WebRTCTransport, TypedEmitter } from './browser';
export { SpeechSDKError, createLogger as createSDKLogger, setLogLevel, setLogHandler } from './browser';
export type {
  SpeechClientConfig, SpeechResponse, ProtocolId, SpeechClientEventMap,
  SDKMetrics, ModelLoadStatus, CircuitBreakerConfig, SpeechErrorCode,
  DiscoveryResponse,
} from './browser';

// ── Benchmarking ──────────────────────────────────────────────────────
export { runHealthCheck, runSSEBench, makeTestWav } from './benchmarking/bench';
export type { ProtoResult, HealthResult } from './benchmarking/bench';
export { runCliBench, runWSBench, runWebRTCBench, buildTtfaTable, WEBRTC_BENCH_PY } from './benchmarking/cli-bench';
export type { CliBenchResult } from './benchmarking/cli-bench';

// ── Auth ──────────────────────────────────────────────────────────────
export { signGpuToken, verifyGpuToken } from './auth/gpu-token';
export type { GpuTokenPayload } from './auth/gpu-token';

// ── Infra (SkyPilot/SSH/SCP utilities) ────────────────────────────────
export {
  execAsync, SKY_BIN, getSkySSHArgs, sshCmd, sshExec, sshExecSilent,
  scpToCluster, checkBackendHealthSSH, skyGetClusterIP, skySpawn,
  stripAnsi, sshOpts, sshCmdAsync,
} from './infra/gpu-backend';

// ── WS Bench Client ──────────────────────────────────────────────────
export { WS_CLIENT_PY } from './benchmarking/ws-bench-client';

// ── Route Handlers ────────────────────────────────────────────────────
export { handleAutoscalerGet, handleAutoscalerAction } from './handlers/autoscaler-handler';
export { handleModalApps, handleModalStop } from './handlers/modal-handler';
export type { HandlerDeps, HandlerResult } from './handlers/types';
export { ok, err } from './handlers/types';
export { createCredentialResolver, PROVIDER_KEY_MAP, PROVIDER_ENV_MAP } from './handlers/credential-resolver';
export { AutoscalerSettingsSchema, AutoscalerTierSchema } from './handlers/autoscaler-schemas';
export type { AutoscalerSettings } from './handlers/autoscaler-schemas';

// ── Vault (Secret Management) ──────────────────────────────────────────
export { Vault } from './vault';
export type { VaultConfig, EncryptedBlob } from './vault';

// ── Embedding Providers ──────────────────────────────────────────────
export { openaiEmbedding, OPENAI_EMBEDDING_MODELS } from './providers/openai/openai-embedding';
export { openrouterEmbedding } from './providers/openrouter/openrouter-embedding';
export { fireworksEmbedding } from './providers/fireworks/fireworks-embedding';

// ── Reranking Providers ──────────────────────────────────────────────
export type { RerankProvider, RerankRequest, RerankResponse, RerankResult } from './providers/rerank';
export { OpenRouterRerankProvider, openrouterRerank } from './providers/rerank';
export { FireworksRerankProvider, fireworksRerank } from './providers/rerank';

// ── Observability ──────────────────────────────────────────────────
export { mergeHooks } from './observability';
export { createLangfuseHooks } from './observability';
export { createWebhookHooks } from './observability';
export { createConsoleHooks } from './observability';
export type { ObservabilityConfig, LangfuseConfig, WebhookConfig } from './observability';

// ── Alerting ──────────────────────────────────────────────────────
export { AlertRouter } from './alerting';
export { createAlertingHooks } from './alerting';
export { SlackAlertChannel } from './alerting';
export { DiscordAlertChannel } from './alerting';
export { GenericWebhookAlertChannel } from './alerting';
export type { AlertChannel, AlertPayload, AlertSeverity, AlertRouterOptions } from './alerting';

// ── Response Caching ──────────────────────────────────────────────
export { ResponseCache } from './caching';
export { withCache } from './caching';
export type { WithCacheOptions, CacheConfig, CacheStats } from './caching';

// ── Streaming STT Router ─────────────────────────────────────────────
export { StreamingSTTRouter, StreamingSTTBackend } from './streaming-stt';
export type { StreamingSTTConfig, StreamingSTTProvider, StreamingSTTStatus, StreamingSTTEvent } from './streaming-stt';

// ── OpenAI-Compatible Proxy ──────────────────────────────────────────
export { createProxyServer, startProxy } from './proxy';
export { RateLimiter } from './proxy';
export type { ProxyConfig, ProviderMapping, ProxyRequest, ProxyResponse } from './proxy';

// ── HTTP SDK (typed client for consuming the REST API) ────────────────
export { GatewaySDK } from './sdk';
export {
  GatewayError as SDKGatewayError,
  type GatewayConfig as SDKGatewayConfig,
  type TranscribeResponse as SDKTranscribeResponse,
  type TranslateResponse as SDKTranslateResponse,
  type PipelineResponse as SDKPipelineResponse,
  type PipelineOptions as SDKPipelineOptions,
  type GpuStatus as SDKGpuStatus,
  type DeployOptions as SDKDeployOptions,
  type DeployResponse as SDKDeployResponse,
} from './sdk';

// ── Language Detection ─────────────────────────────────────────────────────
export { detectLanguage, detectLanguageWithSwap, SUPPORTED_LANGUAGES } from './language-detect';
export type { LanguageDetectResult } from './language-detect';
