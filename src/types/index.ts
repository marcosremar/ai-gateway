/**
 * Shared types barrel export.
 *
 * All public types from the library are re-exported here so consumers
 * can import everything from a single path:
 *
 * ```typescript
 * import type { GatewayConfig, ProviderStatus, SpeechResponse } from '@parle/ai-gateway/types';
 * ```
 */

// Errors
export type { ErrorContext } from '../errors';
export {
  GatewayError,
  ProviderError,
  ProviderTimeoutError,
  ProviderRateLimitError,
  ProviderAuthError,
  CreditExhaustedError,
  GPUNotReadyError,
  GPUBootError,
  GPUHealthError,
  PipelineError,
  ConfigError,
  ValidationError,
  AuthError,
  ForbiddenError,
  BudgetExceededError,
  NotFoundError,
  InternalError,
  DatabaseError,
} from '../errors';

// Constants
export {
  GPU_TYPES,
  GPU_ARCHITECTURES,
  PROVIDER_IDS,
  GPU_PROVIDER_IDS,
  MODELS,
  PIPELINE_STAGES,
  HTTP_STATUS,
  AUTOSCALER,
  DOCKER_IMAGES,
  DOWNLOAD,
  PROXY,
  SECURITY,
  LANGUAGES,
} from '../constants';
export type { GpuType, ProviderId, PipelineStage } from '../constants';

// Contracts
export type {
  SpeechQuery,
  SpeechResponse,
  TranscriptionRequest,
  TranscriptionResponse,
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  TTSRequest,
  TTSResponse,
  GpuDeployRequest,
  GpuStatusResponse,
  ProviderConfig,
  ErrorResponse,
} from '../contracts';
export {
  SpeechQuerySchema,
  SpeechResponseSchema,
  TranscriptionRequestSchema,
  TranscriptionResponseSchema,
  ChatMessageSchema,
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  TTSRequestSchema,
  TTSResponseSchema,
  GpuDeployRequestSchema,
  GpuStatusResponseSchema,
  ProviderConfigSchema,
  ApiKeysUpdateRequestSchema,
  ErrorResponseSchema,
} from '../contracts';

// Config
export type { GatewayConfig } from '../config';

// Hooks
export type { GatewayHooks } from '../hooks';

// Storage
export type { GatewayStorage } from '../storage';

// Observability
export type { OtelConfig, SpanContext, Span } from '../observability/otel';
export { SPAN_NAMES } from '../observability/otel';
export type { SpanName } from '../observability/otel';

// Webhooks
export type { WebhookEvent, WebhookConfig } from '../webhooks';
export { WEBHOOK_EVENTS } from '../webhooks';
export type { WebhookEventType } from '../webhooks';

// Status page
export type {
  SystemStatus,
  ProviderStatus,
  GpuStatus,
  RequestStats,
  BudgetInfo,
} from '../middleware/status-page';

// RBAC
export type { RoleMapping, EndpointRoleMap } from '../middleware/rbac';
export { ROLES, ROLE_NAMES } from '../middleware/rbac';
export type { Role } from '../middleware/rbac';

// Audit
export type { AuditEvent, AuditLoggerOptions } from '../audit';
export { AUDIT_EVENTS } from '../audit';
export type { AuditEventType } from '../audit';

// Memory watcher
export type { MemoryStats, MemoryWatcherConfig } from '../memory-watcher';

// Connection pool
export type { PoolConfig, PoolStats } from '../connection-pool';

// Lazy provider
export type { LazyProvider, ProviderFactory } from '../lazy-provider';

// Chaos
export type { ChaosConfig } from '../chaos';

// Profiler
export type { ProfilerConfig } from '../profiler';

// Utils
export type { RetryOptions } from '../utils';
