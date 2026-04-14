/**
 * Tests for error hierarchy module.
 *
 * Fixes: #601-625 (missing test coverage for core modules)
 */

import { describe, it, expect } from 'vitest';
import {
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
} from '../../src/errors';

describe('GatewayError', () => {
  it('should create error with all properties', () => {
    const error = new GatewayError('Test error', 500, 'TEST_ERROR', { userId: 'abc' }, true);

    expect(error.message).toBe('Test error');
    expect(error.statusCode).toBe(500);
    expect(error.code).toBe('TEST_ERROR');
    expect(error.context).toEqual({ userId: 'abc' });
    expect(error.retryable).toBe(true);
    expect(error.name).toBe('GatewayError');
  });

  it('should freeze context', () => {
    const error = new GatewayError('Test', 400, 'TEST', { userId: 'abc' });
    expect(Object.isFrozen(error.context)).toBe(true);
  });

  it('should serialize to JSON', () => {
    const error = new GatewayError('Test', 500, 'TEST');
    const json = error.toJSON();

    expect(json.error).toBe('GatewayError');
    expect(json.code).toBe('TEST');
    expect(json.message).toBe('Test');
    expect(json.statusCode).toBe(500);
    expect(json.retryable).toBe(false);
  });

  it('should include cause in JSON', () => {
    const cause = new Error('Root cause');
    const error = new GatewayError('Test', 500, 'TEST', {}, false, cause);
    const json = error.toJSON();

    expect(json.cause).toBe('Root cause');
  });
});

describe('Provider Errors', () => {
  it('ProviderError should have providerId in context', () => {
    const error = new ProviderError('Failed', 'groq');
    expect(error.context.providerId).toBe('groq');
    expect(error.retryable).toBe(true);
  });

  it('ProviderTimeoutError should have timeoutMs', () => {
    const error = new ProviderTimeoutError('groq', 30_000);
    expect(error.timeoutMs).toBe(30_000);
    expect(error.code).toBe('PROVIDER_TIMEOUT');
    expect(error.message).toContain('30000ms');
  });

  it('ProviderRateLimitError should have retryAfterMs', () => {
    const error = new ProviderRateLimitError('groq', 60_000);
    expect(error.retryAfterMs).toBe(60_000);
    expect(error.code).toBe('PROVIDER_RATE_LIMITED');
    expect(error.retryable).toBe(true);
  });

  it('ProviderAuthError should not be retryable', () => {
    const error = new ProviderAuthError('groq');
    expect(error.code).toBe('PROVIDER_AUTH_FAILED');
    expect(error.retryable).toBe(false);
  });

  it('CreditExhaustedError should not be retryable', () => {
    const error = new CreditExhaustedError('groq');
    expect(error.code).toBe('CREDIT_EXHAUSTED');
    expect(error.retryable).toBe(false);
  });
});

describe('GPU Errors', () => {
  it('GPUNotReadyError should be retryable', () => {
    const error = new GPUNotReadyError('GPU not ready');
    expect(error.statusCode).toBe(503);
    expect(error.retryable).toBe(true);
  });

  it('GPUBootError should have tier', () => {
    const error = new GPUBootError('Boot failed', { tier: 1 });
    expect(error.tier).toBe(1);
    expect(error.retryable).toBe(true);
  });

  it('GPUHealthError should not be retryable', () => {
    const error = new GPUHealthError('Health check failed');
    expect(error.retryable).toBe(false);
  });
});

describe('Pipeline Errors', () => {
  it('PipelineError should have stage', () => {
    const error = new PipelineError('stt', 'STT failed');
    expect(error.stage).toBe('stt');
    expect(error.message).toContain('stt');
    expect(error.retryable).toBe(true);
  });
});

describe('Auth & Validation Errors', () => {
  it('AuthError should be 401', () => {
    const error = new AuthError('Invalid key');
    expect(error.statusCode).toBe(401);
    expect(error.retryable).toBe(false);
  });

  it('ForbiddenError should be 403', () => {
    const error = new ForbiddenError('No access');
    expect(error.statusCode).toBe(403);
  });

  it('ValidationError should be 422', () => {
    const error = new ValidationError('Invalid input');
    expect(error.statusCode).toBe(422);
  });

  it('NotFoundError should be 404', () => {
    const error = new NotFoundError('Resource');
    expect(error.statusCode).toBe(404);
  });
});

describe('Budget & Internal Errors', () => {
  it('BudgetExceededError should be 429', () => {
    const error = new BudgetExceededError(100, 150);
    expect(error.statusCode).toBe(429);
    expect(error.message).toContain('150 > 100');
  });

  it('InternalError should be retryable', () => {
    const error = new InternalError('Something broke');
    expect(error.statusCode).toBe(500);
    expect(error.retryable).toBe(true);
  });

  it('DatabaseError should be retryable', () => {
    const error = new DatabaseError('DB connection lost');
    expect(error.retryable).toBe(true);
  });
});

describe('Error Inheritance', () => {
  it('all errors should be instanceof GatewayError', () => {
    const errors = [
      new ProviderError('test', 'groq'),
      new ProviderTimeoutError('groq', 1000),
      new ProviderRateLimitError('groq'),
      new ProviderAuthError('groq'),
      new CreditExhaustedError('groq'),
      new GPUNotReadyError('test'),
      new GPUBootError('test'),
      new GPUHealthError('test'),
      new PipelineError('stt', 'test'),
      new ConfigError('test'),
      new ValidationError('test'),
      new AuthError('test'),
      new ForbiddenError('test'),
      new BudgetExceededError(100, 200),
      new NotFoundError('test'),
      new InternalError('test'),
      new DatabaseError('test'),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(GatewayError);
    }
  });
});

describe('Immutability', () => {
  it('should not allow mutation of statusCode', () => {
    const error = new GatewayError('Test', 500, 'TEST');
    const original = error.statusCode;
    (error as any).statusCode = 200;
    expect(error.statusCode).toBe(original);
  });

  it('should not allow mutation of context', () => {
    const error = new GatewayError('Test', 500, 'TEST', { userId: 'abc' });
    expect(() => {
      (error.context as any).userId = 'hacked';
    }).toThrow();
  });
});
