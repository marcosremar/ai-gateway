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
  ToolDescriptor as HttpToolDescriptor,
  ToolsResult as HttpToolsResult,
} from '../sdk/node';

// ── Unified Gateway API ──────────────────────────────────────────────────────
export { createGateway } from './modules/create-gateway';
export type { GatewayConfig } from './modules/create-gateway';
export type { Gateway } from './modules/gateway-api';
export type { GatewayStorage } from './modules/storage';

// ── Autoscaler Factory ──────────────────────────────────────────────────────
export { createAutoscaler } from './modules/factory';

// ── Gateway Singleton (legacy — prefer createGateway) ────────────────────────
export { initGateway, getGateway, resetGateway } from './modules/gateway';
export type { InitGatewayOptions } from './modules/gateway';

// ── Built-in Adapters ──────────────────────────────────────────────────────
export { InMemoryStateAdapter } from './modules/adapters/in-memory-state';
export { RedisStateAdapter } from './modules/adapters/redis-state';
export type { RedisLike } from './modules/adapters/redis-state';

// ── Autoscaler Types ────────────────────────────────────────────────────────
export type {
  AutoScaleRoute,
  GpuBootState,
  GpuInstance,
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
  WorkloadSpec,
} from './modules/types';
export { DEFAULT_STAGE_TIMEOUTS, resolveStageTimeouts } from './modules/types';

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
} from './modules/deps';

// ── GPU Provider types ──────────────────────────────────────────────────────
export type {
  ProviderCredentials,
  InstanceSpec,
  GpuProviderClient,
  MonitorableProvider,
  OnInstancePersist,
} from './modules/gpu-providers/types';

// ── GPU Provider base class ─────────────────────────────────────────────────
/** @internal Base class for GPU providers — use AIClient.deploy()/destroyInstance() instead. */
export { AbstractGpuProvider, FetchError, TIMEOUTS } from './modules/gpu-providers/abstract-provider';
export type { AbstractGpuProviderOptions } from './modules/gpu-providers/abstract-provider';

// ── GPU Provider Registry (used internally by AIClient + Autoscaler) ────────
export { GpuProviderRegistry } from './modules/gpu-providers/registry';

// NOTE: Individual GPU provider classes (RunpodClient, TensordockClient, VastClient, ModalClient)
// are intentionally NOT exported from the public API. They are implementation details.
// Use AIClient.deploy() / destroyInstance() / waitForHealth() for GPU lifecycle management.
// For advanced use (autoscaler factory), import from '@ai-gateway/gpu-providers' directly.

// ── Autoscaler Config Loader ─────────────────────────────────────────────────
export { loadAutoscalerConfig } from './modules/autoscaler/config-loader';

// ── Autoscaler core (advanced use) ──────────────────────────────────────────
export { probeGpuHealth, probeGpuHealthSsh } from './modules/autoscaler/health';
export { PROVIDER_BOOT_SECS } from './modules/factory';
export { MAX_BOOT_FAILURES, BOOT_COOLDOWN_BASE_MS, BOOT_COOLDOWN_MAX_MS, StageTimeoutError } from './modules/autoscaler/engine';
export type { AutoscalerEngineOptions } from './modules/autoscaler/engine';
export { handleBootTimeout } from './modules/autoscaler/boot-timeout';
export { probeAllTiers, processHealthResults } from './modules/autoscaler/health-checker';
export { buildDecision } from './modules/autoscaler/decision-builder';
export { defaultLogger } from './modules/logger';
export { LATENCY_BREACH_COUNT, computeP95, countRecentBreaches } from './modules/autoscaler/latency-tracker';
export { runWatchdogCycle, startBackgroundTicker } from './modules/autoscaler/watchdog';
export { StatePersistence } from './modules/autoscaler/state-persistence';
export { runCostMonitorCycle, startCostMonitorTicker, _resetStaleTracking } from './modules/autoscaler/cost-monitor';
export type {
  ProviderAccount,
  OrphanedInstance,
  CostMonitorReport,
  CostMonitorDeps,
  WasteType,
} from './modules/autoscaler/cost-monitor';

// ── GPU Lifecycle Logger ──────────────────────────────────────────────────
export { noopLifecycleLogger } from './modules/autoscaler/lifecycle-logger';
export type { GpuLifecycleLogger, GpuLifecycleLogEntry } from './modules/autoscaler/lifecycle-logger';

// ── Tier Lifecycle Management ────────────────────────────────────────────
export type { TierActionResult, TierDetail } from './modules/autoscaler/tier-lifecycle';

// ── Benchmark Tracking ──────────────────────────────────────────────────
export { BenchmarkTracker } from './modules/tracking/benchmark-tracker';
export type {
  BootBenchmark,
  InferenceBenchmark,
  BenchmarkStats,
  BenchmarkSummary,
  BenchmarkTrend,
} from './modules/tracking/benchmark-tracker';

// ── Observability Hooks (F8) ──────────────────────────────────────────────
export { emitHook } from './modules/hooks';
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
} from './modules/hooks';

// ── Health-Aware Load Balancing (F10) ─────────────────────────────────────
export { LoadBalancer } from './modules/autoscaler/load-balancer';
export type { LoadBalanceStrategy, TierLatencyMetrics } from './modules/autoscaler/load-balancer';

// ── Declarative Fallback Chains (F1) ──────────────────────────────────────
export { resolveDeclarativeChain, findChainForStage } from './modules/providers/declarative-chain';
export type { FallbackChainConfig, FallbackChainEntry, ResolvedChain } from './modules/providers/declarative-chain';

// ── Spend Tracking (F9) ──────────────────────────────────────────────────
export { SpendTracker } from './modules/tracking/spend-tracker';
export type { SpendRecord, SpendSummary, BudgetConfig, BudgetStatus } from './modules/tracking/spend-tracker';
export { DEFAULT_PRICING_TABLE, lookupPricing, estimateRequestCost } from './modules/tracking/pricing';
export type { ModelPricing } from './modules/tracking/pricing';
export { createCostAnomalyDetector } from './modules/tracking/cost-anomaly-detector';
export type { CostAnomaly, CostAnomalyDetectorConfig } from './modules/tracking/cost-anomaly-detector';

// ── Predictive Pre-Warm (F4) ─────────────────────────────────────────────
export {
  recordUsageForPrediction,
  shouldPreWarm,
  runPredictiveWarmupForUser,
  startPredictiveWarmupTicker,
} from './modules/autoscaler/predictive-warmup';
export type { PredictiveWarmupConfig, PredictiveWarmupDeps } from './modules/autoscaler/predictive-warmup';

// ── AI Provider types ──────────────────────────────────────────────────────
export { AIProviderRegistry } from './modules/providers/registry';
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
  RealtimeSdpConfig,
  RealtimeSession,
  RealtimeTransport,
  ImageRequest,
  ImageResponse,
  OmniRequest,
  OmniResponse,
  AIProviderSettings,
} from './modules/providers/types';
export { withProviderFallback, isRetryableError, isContextWindowError, getCooldownState } from './modules/providers/fallback';
export type { FallbackEntry, FallbackOptions } from './modules/providers/fallback';
export { buildFallbackChain, resolveApiKey, getSystemLlmEntryFromSettings, getSystemSttEntryFromSettings } from './modules/providers/chain-builder';
export type { SavedProfile, PipelineStageConfig, UserProviderSettings } from './modules/providers/chain-builder';
export { ProviderClassification } from './modules/providers/classification';

// ── OpenAI-Compatible Base Classes ──────────────────────────────────────────
export { OpenAICompatSTTProvider } from './modules/providers/openai-compat';
export { OpenAICompatTTSProvider } from './modules/providers/openai-compat';
export { OpenAICompatLLMProvider } from './modules/providers/openai-compat';
export { OpenAICompatEmbeddingProvider } from './modules/providers/openai-compat';
export type { OpenAICompatSTTConfig, OpenAICompatTTSConfig, OpenAICompatLLMConfig, OpenAICompatEmbeddingConfig } from './modules/providers/openai-compat';
export type { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse } from './modules/providers/openai-compat';
export { detectAudioFormat, prepareAudioFile } from './modules/providers/openai-compat';

// ── Groq Provider ───────────────────────────────────────────────────────────
export { groqSTT, groqTTS, groqLLM } from './modules/providers/groq';
export { GROQ_STT_MODELS, GROQ_TTS_MODELS, GROQ_TTS_VOICES, GROQ_LLM_MODELS } from './modules/providers/groq';

// ── Ollama Provider (Local) ─────────────────────────────────────────────────
export { ollamaLLM, ollamaSTT, OllamaLLMProvider, OllamaSTTProvider } from './modules/providers/ollama';
export { OLLAMA_STT_MODELS, OLLAMA_LLM_MODELS } from './modules/providers/ollama';

// ── OpenRouter Provider ─────────────────────────────────────────────────────
export { openrouterLLM, openrouterImage, OpenRouterImageProvider } from './modules/providers/openrouter';
export { OPENROUTER_LLM_MODELS, OPENROUTER_IMAGE_MODELS } from './modules/providers/openrouter';

// ── Z.AI Provider (Zhipu — GLM-4.6 / GLM-4.5V) ──────────────────────────────
export { zaiLLM, ZAI_LLM_MODELS, ZAI_VISION_MODELS } from './modules/providers/zai';

// ── Cloud Provider Health Probes ───────────────────────────────────────────
export { probeCloudProvider, probeAllCloudProviders } from './modules/providers/cloud-health';
export type { CloudProbeResult } from './modules/providers/cloud-health';

// ── Provider Errors ────────────────────────────────────────────────────────
export { PROVIDER_LABELS, BILLING_URLS, buildProviderError, extractErrorStatus, extractErrorMessage, CreditExhaustedError } from './modules/providers/errors';

// ── Credit Block Tracking ──────────────────────────────────────────────────
export { CreditBlockTracker, defaultCreditBlockTracker, hashApiKey } from './modules/providers/credit-block';

// ── Voice Catalog ──────────────────────────────────────────────────────────
export type { VoiceGender, VoiceSlot, ProviderVoice, ProviderVoiceCatalog, VoiceMapping, VoiceMappingConfig } from './modules/providers/voice-catalog';
export {
  VOICE_SLOTS, OPENAI_VOICE_CATALOG, KOKORO_VOICE_CATALOG, QWEN3_VOICE_CATALOG,
  SKYPILOT_VOICE_CATALOG, MOSS_TTS_VOICE_CATALOG, MODAL_VOICE_CATALOG,
  getAllVoiceCatalogs, getVoiceCatalog, getVoicesForProviderModel,
  getLanguagesFromCatalog, filterVoicesByLanguage, getDefaultVoiceMappings, resolveVoiceSlot,
} from './modules/providers/voice-catalog';

// ── OpenAI Providers ───────────────────────────────────────────────────────
export { OpenAISTTProvider } from './modules/providers/openai/openai-stt';
export { OpenAITTSProvider } from './modules/providers/openai/openai-tts';
export { OpenAIRealtimeProvider, openaiRealtime } from './modules/providers/openai/openai-realtime';
export { OpenAIOmniProvider } from './modules/providers/openai/openai-omni';

// ── OpenAI Model Constants ─────────────────────────────────────────────────
export { OPENAI_STT_MODELS, OPENAI_TTS_MODELS, OPENAI_OMNI_MODELS, OPENAI_REALTIME_MODELS, OPENAI_VOICES } from './modules/providers/openai/models';

// ── OpenAI Image Provider ───────────────────────────────────────────────────
export { openaiImage, OpenAIImageProvider } from './modules/providers/openai/openai-image';
export { OPENAI_IMAGE_MODELS } from './modules/providers/openai/models';

// ── Fireworks Provider ──────────────────────────────────────────────────────
export { fireworksSTT, fireworksLLM, fireworksImage, FireworksImageProvider } from './modules/providers/fireworks';
export { FIREWORKS_STT_MODELS, FIREWORKS_LLM_MODELS, FIREWORKS_IMAGE_MODELS } from './modules/providers/fireworks';

// ── Modal Provider (MOSS-TTS) ──────────────────────────────────────────────
export { ModalTTSProvider, modalTTS, MODAL_TTS_MODELS } from './modules/providers/modal';

// ── Self-Hosted Providers ───────────────────────────────────────────────────
export { SelfHostedSTTProvider, SelfHostedTTSProvider, SelfHostedLLMProvider } from './modules/providers/self-hosted/self-hosted-provider';

// ── AIClient ───────────────────────────────────────────────────────────────
export { createAIClient, AIClient } from './modules/client';
export {
  VOICE_PROFILE,
  CHAT_PROFILE,
  STT_PROFILE,
  TTS_PROFILE,
  LLM_PROFILE,
  IMAGE_PROFILE,
  SYSTEM_PROFILE,
  SPEECH_TO_SPEECH_PROFILE,
  resolveProfile,
  mergeProfiles,
} from './modules/client';
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
  WorkloadLaunchResult,
  GpuTransport,
  GpuPipelineResponse,
  GpuHealthResponse,
  /** @deprecated Use pipeline() instead of pipelineStream(). */
  PipelineEvent,
  /** @deprecated Use pipeline() instead of pipelineStream(). */
  PipelineStage,
} from './modules/client';

// ── Browser SDK (SpeechClient) ──────────────────────────────────────────
// NOTE: SpeechClient and streaming transports are legacy. Server-side code
// should use AIClient.pipeline() or POST /v1/speech (JSON, transport-transparent).
export { SpeechClient } from './modules/browser';
/** @deprecated Streaming transports removed from proxy. Use POST /v1/speech. */
export { WebSocketTransport, SSETransport, WebRTCTransport, TypedEmitter } from './modules/browser';
export { SpeechSDKError, createLogger as createSDKLogger, setLogLevel, setLogHandler } from './modules/browser';
export type {
  SpeechClientConfig, SpeechResponse, ProtocolId, SpeechClientEventMap,
  SDKMetrics, ModelLoadStatus, CircuitBreakerConfig, SpeechErrorCode,
  DiscoveryResponse,
} from './modules/browser';

// ── Benchmarking ──────────────────────────────────────────────────────
export { runHealthCheck, runSSEBench, makeTestWav } from './modules/benchmarking/bench';
export type { ProtoResult, HealthResult } from './modules/benchmarking/bench';
export { runCliBench, runWSBench, runWebRTCBench, buildTtfaTable, WEBRTC_BENCH_PY } from './modules/benchmarking/cli-bench';
export type { CliBenchResult } from './modules/benchmarking/cli-bench';

// ── Auth ──────────────────────────────────────────────────────────────
export { signGpuToken, verifyGpuToken } from './modules/auth/gpu-token';
export type { GpuTokenPayload } from './modules/auth/gpu-token';

// ── Infra (SkyPilot/SSH/SCP utilities) ────────────────────────────────
export {
  execAsync, SKY_BIN, getSkySSHArgs, sshCmd, sshExec, sshExecSilent,
  scpToCluster, checkBackendHealthSSH, skyGetClusterIP, skySpawn,
  stripAnsi, sshOpts, sshCmdAsync,
} from './modules/infra/gpu-backend';

// ── WS Bench Client ──────────────────────────────────────────────────
export { WS_CLIENT_PY } from './modules/benchmarking/ws-bench-client';

// ── Route Handlers ────────────────────────────────────────────────────
export { handleAutoscalerGet, handleAutoscalerAction } from './modules/handlers/autoscaler-handler';
export { handleModalApps, handleModalStop } from './modules/handlers/modal-handler';
export type { HandlerDeps, HandlerResult } from './modules/handlers/types';
export { ok, err } from './modules/handlers/types';
export { createCredentialResolver } from './modules/handlers/credential-resolver';
export { AutoscalerSettingsSchema, AutoscalerTierSchema } from './modules/handlers/autoscaler-schemas';
export type { AutoscalerSettings } from './modules/handlers/autoscaler-schemas';

// ── Vault (Secret Management) ──────────────────────────────────────────
export { Vault, FileVaultStore, initVaultFromEnv, getVault, setVault, resetVault } from './modules/vault';
export type { VaultConfig, EncryptedBlob } from './modules/vault';

// ── Embedding Providers ──────────────────────────────────────────────
export { openaiEmbedding, OPENAI_EMBEDDING_MODELS } from './modules/providers/openai/openai-embedding';
export { openrouterEmbedding } from './modules/providers/openrouter/openrouter-embedding';
export { fireworksEmbedding } from './modules/providers/fireworks/fireworks-embedding';

// ── Reranking Providers ──────────────────────────────────────────────
export type { RerankProvider, RerankRequest, RerankResponse, RerankResult } from './modules/providers/rerank';
export { OpenRouterRerankProvider, openrouterRerank } from './modules/providers/rerank';
export { FireworksRerankProvider, fireworksRerank } from './modules/providers/rerank';

// ── Observability ──────────────────────────────────────────────────
export { mergeHooks } from './modules/observability';
export { createLangfuseHooks } from './modules/observability';
export { createWebhookHooks } from './modules/observability';
export { createConsoleHooks } from './modules/observability';
export type { ObservabilityConfig, LangfuseConfig, WebhookConfig } from './modules/observability';

// ── Alerting ──────────────────────────────────────────────────────
export { AlertRouter } from './modules/alerting';
export { createAlertingHooks } from './modules/alerting';
export { SlackAlertChannel } from './modules/alerting';
export { DiscordAlertChannel } from './modules/alerting';
export { GenericWebhookAlertChannel } from './modules/alerting';
export type { AlertChannel, AlertPayload, AlertSeverity, AlertRouterOptions } from './modules/alerting';

// ── Response Caching ──────────────────────────────────────────────
export { ResponseCache } from './modules/caching';
export { withCache } from './modules/caching';
export type { WithCacheOptions, CacheConfig, CacheStats } from './modules/caching';

// ── Streaming STT Router ─────────────────────────────────────────────
export { StreamingSTTRouter, StreamingSTTBackend } from './modules/streaming-stt';
export type { StreamingSTTConfig, StreamingSTTProvider, StreamingSTTStatus, StreamingSTTEvent } from './modules/streaming-stt';

// ── OpenAI-Compatible Proxy ──────────────────────────────────────────
export { createProxyServer, startProxy } from './modules/proxy';
export { RateLimiter } from './modules/proxy';
export type { ProxyConfig, ProviderMapping, ProxyRequest, ProxyResponse } from './modules/proxy';

// ── Rule-Based Guardrails ─────────────────────────────────────────────
export { GuardrailEngine } from './modules/gateway/guardrails';
export type {
  GuardrailEngineConfig,
  GuardrailRule,
  GuardrailAction,
  GuardrailHook,
  EngineResult,
  RuleResult,
  RegexMatchRule,
  JsonSchemaRule,
  ContainsCodeRule,
  WebhookRule,
  NotNullRule,
  ModelWhitelistRule,
} from './modules/gateway/guardrails';

// ── HTTP SDK (typed client for consuming the REST API) ────────────────
export { GatewaySDK } from './modules/sdk';
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
} from './modules/sdk';

// ── Language Detection ─────────────────────────────────────────────────────
export { detectLanguage, detectLanguageWithSwap, SUPPORTED_LANGUAGES } from './modules/language-detect';
export type { LanguageDetectResult } from './modules/language-detect';


// ── Database abstraction ──────────────────────────────────────────────────────
export type {
  DatabaseEnvironment,
  DatabaseConfig,
  NeonProject,
  NeonBranch,
  NeonDatabase,
  NeonEndpoint,
  BackupType,
  BackupInfo,
  BackupOptions,
  BackupResult,
  RestoreOptions,
  QueryResult,
} from './modules/database/index';
export { DatabaseError } from './modules/database/index';
export {
  detectEnvironment,
  isPooledUrl,
  buildConnectionConfig,
  buildPrismaUrl,
  getUnpooledUrl,
  getPooledUrl,
} from './modules/database/index';
export type { SqlDriver } from './modules/database/index';
export { createSqlDriver, createNeonDriver, createPgDriver } from './modules/database/index';
export { NeonManagementClient } from './modules/database/index';
export { BackupService } from './modules/database/index';
export { DatabaseService, createDatabaseService, getDatabase } from './modules/database/index';
