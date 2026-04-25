import { describe, it, expect } from 'vitest';
import {
  buildProviderError,
  CreditExhaustedError,
  extractErrorStatus,
  extractErrorMessage,
  BILLING_URLS,
} from '../../src/providers/errors';

describe('buildProviderError()', () => {
  it('should include billing URL for openai on 429', () => {
    const result = buildProviderError('openai', 429, 'rate limit');
    expect(result.status).toBe(429);
    expect(result.message).toContain(BILLING_URLS.openai);
    expect(result.message).toContain('OpenAI');
  });

  it('should have correct message for 401', () => {
    const result = buildProviderError('groq', 401, 'bad key');
    expect(result.status).toBe(401);
    expect(result.message).toContain('Invalid or expired API key');
    expect(result.message).toContain('Groq');
  });

  it('should return generic message for 500', () => {
    const result = buildProviderError('openai', 500, 'some internal error');
    expect(result.status).toBe(500);
    expect(result.message).toContain('some internal error');
  });

  it('should include timeout text for timeout-like errors', () => {
    const result = buildProviderError('openai', 408, 'request took too long');
    expect(result.status).toBe(408);
    expect(result.message).toContain('timed out');
  });

  it('should detect timeout from rawMessage with "timeout"', () => {
    const result = buildProviderError('openai', 500, 'connection timeout');
    expect(result.status).toBe(408);
    expect(result.message).toContain('timed out');
  });
});

describe('CreditExhaustedError', () => {
  it('should include billing URLs', () => {
    const err = new CreditExhaustedError(['openai', 'groq']);
    expect(err.status).toBe(402);
    expect(err.billingUrls.openai).toBe(BILLING_URLS.openai);
    expect(err.billingUrls.groq).toBe(BILLING_URLS.groq);
    expect(err.message).toContain('Credits exhausted');
    expect(err.providers).toEqual(['openai', 'groq']);
  });
});

describe('extractErrorStatus()', () => {
  it('should return status from error object', () => {
    expect(extractErrorStatus({ status: 429 })).toBe(429);
  });

  it('should return undefined for object without status', () => {
    expect(extractErrorStatus({ message: 'nope' })).toBeUndefined();
  });

  it('should return undefined for null', () => {
    expect(extractErrorStatus(null)).toBeUndefined();
  });
});

describe('extractErrorMessage()', () => {
  it('should return message from Error instances', () => {
    expect(extractErrorMessage(new Error('test msg'), 'fallback')).toBe('test msg');
  });

  it('should return fallback for non-Error values', () => {
    expect(extractErrorMessage('string', 'fallback')).toBe('fallback');
    expect(extractErrorMessage(null, 'fallback')).toBe('fallback');
    expect(extractErrorMessage(42, 'fallback')).toBe('fallback');
  });
});
