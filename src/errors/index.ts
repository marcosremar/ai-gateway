/**
 * Unified error hierarchy for AI Gateway.
 * All properties are readonly for immutability.
 */

export interface ErrorContext {
  readonly userId?: string;
  readonly providerId?: string;
  readonly requestId?: string;
  readonly endpoint?: string;
  readonly model?: string;
  readonly tier?: number;
  readonly [key: string]: unknown;
}

export class GatewayError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly context: Readonly<ErrorContext>;
  public readonly retryable: boolean;
  public readonly cause?: Error;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    context: ErrorContext = {},
    retryable = false,
    cause?: Error,
  ) {
    super(message);
    this.name = 'GatewayError';
    this.statusCode = statusCode;
    this.code = code;
    this.context = Object.freeze({ ...context });
    this.retryable = retryable;
    this.cause = cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, GatewayError);
  }

  toJSON() {
    return Object.freeze({
      error: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      retryable: this.retryable,
      context: this.context,
      ...(this.cause ? { cause: this.cause.message } : {}),
    });
  }
}

export class ProviderError extends GatewayError {
  constructor(message: string, providerId: string, context: ErrorContext = {}, cause?: Error) {
    super(message, 502, 'PROVIDER_ERROR', { providerId, ...context }, true, cause);
    this.name = 'ProviderError';
  }
}

export class ProviderTimeoutError extends ProviderError {
  public readonly timeoutMs: number;
  constructor(providerId: string, timeoutMs: number, context: ErrorContext = {}) {
    super(`Provider ${providerId} timed out after ${timeoutMs}ms`, providerId, context);
    this.name = 'ProviderTimeoutError';
    this.timeoutMs = timeoutMs;
    Object.defineProperty(this, 'code', { value: 'PROVIDER_TIMEOUT' });
  }
}

export class ProviderRateLimitError extends ProviderError {
  public readonly retryAfterMs?: number;
  constructor(providerId: string, retryAfterMs?: number, context: ErrorContext = {}) {
    super(`Provider ${providerId} rate limited`, providerId, context);
    this.name = 'ProviderRateLimitError';
    this.retryAfterMs = retryAfterMs;
    Object.defineProperty(this, 'code', { value: 'PROVIDER_RATE_LIMITED' });
    Object.defineProperty(this, 'retryable', { value: true });
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(providerId: string, context: ErrorContext = {}) {
    super(`Provider ${providerId} authentication failed`, providerId, context);
    this.name = 'ProviderAuthError';
    Object.defineProperty(this, 'code', { value: 'PROVIDER_AUTH_FAILED' });
    Object.defineProperty(this, 'retryable', { value: false });
  }
}

export class CreditExhaustedError extends ProviderError {
  constructor(providerId: string, context: ErrorContext = {}) {
    super(`Provider ${providerId} credits exhausted`, providerId, context);
    this.name = 'CreditExhaustedError';
    Object.defineProperty(this, 'code', { value: 'CREDIT_EXHAUSTED' });
    Object.defineProperty(this, 'retryable', { value: false });
  }
}

export class GPUNotReadyError extends GatewayError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, 503, 'GPU_NOT_READY', context, true);
    this.name = 'GPUNotReadyError';
  }
}

export class GPUBootError extends GatewayError {
  public readonly tier?: number;
  constructor(message: string, context: ErrorContext = {}, cause?: Error) {
    super(message, 500, 'GPU_BOOT_ERROR', context, true, cause);
    this.name = 'GPUBootError';
    this.tier = context.tier;
  }
}

export class GPUHealthError extends GatewayError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, 503, 'GPU_HEALTH_UNHEALTHY', context, false);
    this.name = 'GPUHealthError';
  }
}

export class PipelineError extends GatewayError {
  public readonly stage: string;
  constructor(stage: string, message: string, context: ErrorContext = {}, cause?: Error) {
    super(`Pipeline stage '${stage}' failed: ${message}`, 500, 'PIPELINE_ERROR', context, true, cause);
    this.name = 'PipelineError';
    this.stage = stage;
  }
}

export class ConfigError extends GatewayError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, 400, 'CONFIG_ERROR', context, false);
    this.name = 'ConfigError';
  }
}

export class ValidationError extends GatewayError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, 422, 'VALIDATION_ERROR', context, false);
    this.name = 'ValidationError';
  }
}

export class AuthError extends GatewayError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, 401, 'AUTH_ERROR', context, false);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends GatewayError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, 403, 'FORBIDDEN', context, false);
    this.name = 'ForbiddenError';
  }
}

export class BudgetExceededError extends GatewayError {
  constructor(budget: number, current: number, context: ErrorContext = {}) {
    super(`Budget exceeded: ${current} > ${budget}`, 429, 'BUDGET_EXCEEDED', context, false);
    this.name = 'BudgetExceededError';
  }
}

export class NotFoundError extends GatewayError {
  constructor(resource: string, context: ErrorContext = {}) {
    super(`${resource} not found`, 404, 'NOT_FOUND', context, false);
    this.name = 'NotFoundError';
  }
}

export class InternalError extends GatewayError {
  constructor(message: string, context: ErrorContext = {}, cause?: Error) {
    super(message, 500, 'INTERNAL_ERROR', context, true, cause);
    this.name = 'InternalError';
  }
}

export class DatabaseError extends GatewayError {
  constructor(message: string, context: ErrorContext = {}, cause?: Error) {
    super(message, 500, 'DATABASE_ERROR', context, true, cause);
    this.name = 'DatabaseError';
  }
}
