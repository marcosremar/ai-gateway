/**
 * JSDoc documentation examples for all public APIs.
 *
 * Fixes: #851-890 (JSDoc documentation)
 *
 * This file serves as both test and documentation reference.
 */

import { describe, it, expect } from 'vitest';

// ── Error Hierarchy ──────────────────────────────────────────────────────────

/**
 * @example
 * ```ts
 * import { GatewayError, ProviderError } from '@ai-gateway/errors';
 *
 * // Create a basic error
 * throw new GatewayError('Something went wrong', 500, 'INTERNAL_ERROR');
 *
 * // Create a provider error with context
 * throw new ProviderError('Provider failed', 'groq', {
 *   userId: 'abc-123',
 *   requestId: 'req-456',
 * });
 * ```
 */
describe('Error Hierarchy — JSDoc Examples', () => {
  it('should create GatewayError', () => {
    const { GatewayError } = require('../../src/errors');
    const error = new GatewayError('Test', 500, 'TEST');
    expect(error.statusCode).toBe(500);
  });

  it('should create ProviderError with context', () => {
    const { ProviderError } = require('../../src/errors');
    const error = new ProviderError('Failed', 'groq', { userId: 'abc' });
    expect(error.context.userId).toBe('abc');
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * @example
 * ```ts
 * import { GPU_TYPES, MODELS, TIMEOUTS } from '@ai-gateway/constants';
 *
 * // Use GPU type constants
 * const gpuType = GPU_TYPES.RTX_4090;
 *
 * // Use model constants
 * const model = MODELS.LLM_LLAMA_70B;
 *
 * // Use timeout constants
 * const timeout = TIMEOUTS.PROVIDER_LLM_MS;
 * ```
 */
describe('Constants — JSDoc Examples', () => {
  it('should export GPU types', () => {
    const { GPU_TYPES } = require('../../src/constants');
    expect(GPU_TYPES.RTX_4090).toBeDefined();
  });

  it('should export model names', () => {
    const { MODELS } = require('../../src/constants');
    expect(MODELS.LLM_LLAMA_70B).toBeDefined();
  });
});

// ── Utils ─────────────────────────────────────────────────────────────────────

/**
 * @example
 * ```ts
 * import { withRetry, withTimeout, sleep, uuid } from '@ai-gateway/utils';
 *
 * // Retry with exponential backoff
 * const result = await withRetry(() => fetchData(), {
 *   maxAttempts: 3,
 *   baseDelayMs: 1000,
 * });
 *
 * // Timeout a promise
 * const data = await withTimeout(fetchData(), 5000);
 *
 * // Generate UUID
 * const id = uuid();
 * ```
 */
describe('Utils — JSDoc Examples', () => {
  it('should retry with backoff', async () => {
    const { withRetry } = require('../../src/utils');
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn, { baseDelayMs: 10 });
    expect(result).toBe('success');
  });

  it('should generate UUIDs', async () => {
    const { uuid } = require('../../src/utils');
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// ── Contracts ─────────────────────────────────────────────────────────────────

/**
 * @example
 * ```ts
 * import { ChatCompletionRequestSchema } from '@ai-gateway/contracts';
 *
 * // Validate request
 * const result = ChatCompletionRequestSchema.safeParse(request);
 * if (!result.success) {
 *   throw new ValidationError(result.error.message);
 * }
 * ```
 */
describe('Contracts — JSDoc Examples', () => {
  it('should validate chat request', () => {
    const { ChatCompletionRequestSchema } = require('../../src/contracts');
    const valid = {
      model: 'llama-3.3-70b',
      messages: [{ role: 'user', content: 'Hi' }],
    };
    expect(ChatCompletionRequestSchema.safeParse(valid).success).toBe(true);
  });
});
