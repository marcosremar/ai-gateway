import { describe, it, expect } from 'vitest';
import {
  buildProviderError,
  CreditExhaustedError,
  extractErrorStatus,
  extractErrorMessage,
  PROVIDER_LABELS,
  BILLING_URLS,
} from '../src/providers/errors';

describe('PROVIDER_LABELS', () => {
  it('should have labels for all major providers', () => {
    expect(PROVIDER_LABELS.openai).toBe('OpenAI');
    expect(PROVIDER_LABELS.groq).toBe('Groq');
    expect(PROVIDER_LABELS.openrouter).toBe('OpenRouter');
    expect(PROVIDER_LABELS.fireworks).toBe('Fireworks AI');
    expect(PROVIDER_LABELS.modal).toBe('Modal');
  });
});

describe('BILLING_URLS', () => {
  it('should have billing URLs for providers with billing pages', () => {
    expect(BILLING_URLS.openai).toBeTruthy();
    expect(BILLING_URLS.groq).toBeTruthy();
    expect(BILLING_URLS.openrouter).toBeTruthy();
    expect(BILLING_URLS.fireworks).toBeTruthy();
  });
});

describe('buildProviderError()', () => {
  describe('status 429 — quota exceeded', () => {
    it('should return 429 status with billing URL for known provider', () => {
      const result = buildProviderError('openai', 429, 'rate limit exceeded');
      expect(result.status).toBe(429);
      expect(result.message).toContain('OpenAI');
      expect(result.message).toContain(BILLING_URLS.openai);
    });

    it('should return 429 status without billing URL for unknown provider', () => {
      const result = buildProviderError('unknown-provider', 429, 'rate limit');
      expect(result.status).toBe(429);
      expect(result.message).toContain('unknown-provider');
      expect(result.message).not.toContain('undefined');
    });
  });

  describe('status 401 — invalid API key', () => {
    it('should return 401 with appropriate message', () => {
      const result = buildProviderError('groq', 401, 'invalid key');
      expect(result.status).toBe(401);
      expect(result.message).toContain('Groq');
    });
  });

  describe('status 402 — payment required', () => {
    it('should return 402 with billing URL for known provider', () => {
      const result = buildProviderError('openai', 402, 'no credits');
      expect(result.status).toBe(402);
      expect(result.message).toContain('OpenAI');
      expect(result.message).toContain(BILLING_URLS.openai);
    });

    it('should return 402 without billing URL for unknown provider', () => {
      const result = buildProviderError('modal', 402, 'no credits');
      expect(result.status).toBe(402);
      expect(result.message).toContain('Modal');
    });
  });

  describe('status 403 — access denied', () => {
    it('should return 403 with access denied message', () => {
      const result = buildProviderError('openrouter', 403, 'forbidden');
      expect(result.status).toBe(403);
      expect(result.message).toContain('OpenRouter');
    });
  });

  describe('status 404 — model not found', () => {
    it('should return 404 with model not found message', () => {
      const result = buildProviderError('fireworks', 404, 'model not found');
      expect(result.status).toBe(404);
      expect(result.message).toContain('Fireworks AI');
    });
  });

  describe('status 502/503 — service unavailable', () => {
    it('should return 502 with service unavailable message', () => {
      const result = buildProviderError('openai', 502, 'bad gateway');
      expect(result.status).toBe(502);
      expect(result.message).toContain('OpenAI');
    });

    it('should return 503 with service unavailable message', () => {
      const result = buildProviderError('openai', 503, 'service unavailable');
      expect(result.status).toBe(503);
      expect(result.message).toContain('OpenAI');
    });
  });

  describe('timeout detection', () => {
    it('should detect status 408 as timeout', () => {
      const result = buildProviderError('groq', 408, 'timeout');
      expect(result.status).toBe(408);
      expect(result.message).toContain('Groq');
    });

    it('should detect "timeout" keyword in message', () => {
      const result = buildProviderError('openai', 500, 'request timeout occurred');
      expect(result.status).toBe(408);
    });

    it('should detect "ETIMEDOUT" in message', () => {
      const result = buildProviderError('openai', undefined, 'ETIMEDOUT: connection timeout');
      expect(result.status).toBe(408);
    });
  });

  describe('connection error detection', () => {
    it('should detect "fetch failed" in message', () => {
      const result = buildProviderError('openai', undefined, 'fetch failed');
      expect(result.status).toBe(502);
    });

    it('should detect "ECONNREFUSED" in message', () => {
      const result = buildProviderError('openai', undefined, 'ECONNREFUSED connection refused');
      expect(result.status).toBe(502);
    });
  });

  describe('fallback for unknown errors', () => {
    it('should return 500 with raw message for unknown status', () => {
      const result = buildProviderError('openai', undefined, 'some unknown error');
      expect(result.status).toBe(500);
      expect(result.message).toContain('OpenAI');
      expect(result.message).toContain('some unknown error');
    });

    it('should use provider label for known provider', () => {
      const result = buildProviderError('openai', 418, "I'm a teapot");
      expect(result.status).toBe(418);
      expect(result.message).toContain('OpenAI');
    });

    it('should use raw providerId for unknown provider', () => {
      const result = buildProviderError('my-custom-provider', 418, 'teapot');
      expect(result.message).toContain('my-custom-provider');
    });
  });
});

describe('CreditExhaustedError', () => {
  it('should be instanceof Error', () => {
    const err = new CreditExhaustedError(['openai']);
    expect(err instanceof Error).toBe(true);
  });

  it('should have status 402', () => {
    const err = new CreditExhaustedError(['openai']);
    expect(err.status).toBe(402);
  });

  it('should have name CreditExhaustedError', () => {
    const err = new CreditExhaustedError(['openai']);
    expect(err.name).toBe('CreditExhaustedError');
  });

  it('should include providers list', () => {
    const err = new CreditExhaustedError(['openai', 'groq']);
    expect(err.providers).toEqual(['openai', 'groq']);
  });

  it('should include billing URLs for known providers', () => {
    const err = new CreditExhaustedError(['openai', 'groq']);
    expect(err.billingUrls.openai).toBeTruthy();
    expect(err.billingUrls.groq).toBeTruthy();
  });

  it('should include provider labels in message', () => {
    const err = new CreditExhaustedError(['openai', 'groq']);
    expect(err.message).toContain('OpenAI');
    expect(err.message).toContain('Groq');
  });

  it('should include billing URLs in message when available', () => {
    const err = new CreditExhaustedError(['openai']);
    expect(err.message).toContain(BILLING_URLS.openai);
  });

  it('should handle unknown providers gracefully', () => {
    const err = new CreditExhaustedError(['custom-provider']);
    expect(err.providers).toEqual(['custom-provider']);
    expect(err.billingUrls).toEqual({});
    expect(err.message).toContain('custom-provider');
  });

  it('should handle empty providers array', () => {
    const err = new CreditExhaustedError([]);
    expect(err.providers).toEqual([]);
    expect(err.message).toBeTruthy();
  });

  it('should have message without billing URLs for unknown providers', () => {
    const err = new CreditExhaustedError(['custom']);
    expect(err.message).not.toContain('undefined');
  });
});

describe('extractErrorStatus()', () => {
  it('should return status from error object', () => {
    const err = { status: 429 };
    expect(extractErrorStatus(err)).toBe(429);
  });

  it('should return undefined for plain Error', () => {
    const err = new Error('test');
    expect(extractErrorStatus(err)).toBeUndefined();
  });

  it('should return undefined for null', () => {
    expect(extractErrorStatus(null)).toBeUndefined();
  });

  it('should return undefined for string', () => {
    expect(extractErrorStatus('error string')).toBeUndefined();
  });

  it('should return status from OpenAI-SDK-like error', () => {
    const sdkError = { status: 401, message: 'Unauthorized' };
    expect(extractErrorStatus(sdkError)).toBe(401);
  });
});

describe('extractErrorMessage()', () => {
  it('should return message from Error instance', () => {
    const err = new Error('test error');
    expect(extractErrorMessage(err, 'fallback')).toBe('test error');
  });

  it('should return fallback for non-Error values', () => {
    expect(extractErrorMessage('string error', 'fallback')).toBe('fallback');
    expect(extractErrorMessage(42, 'fallback')).toBe('fallback');
    expect(extractErrorMessage(null, 'fallback')).toBe('fallback');
    expect(extractErrorMessage(undefined, 'fallback')).toBe('fallback');
  });

  it('should return fallback for plain object', () => {
    expect(extractErrorMessage({ message: 'test' }, 'fallback')).toBe('fallback');
  });
});
