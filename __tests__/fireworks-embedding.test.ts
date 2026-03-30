/**
 * Tests for src/providers/fireworks/fireworks-embedding.ts
 * Covers: singleton export configuration.
 */
import { describe, it, expect } from 'vitest';
import { fireworksEmbedding } from '../src/providers/fireworks/fireworks-embedding';

describe('fireworksEmbedding', () => {
  it('is exported as a singleton', () => {
    expect(fireworksEmbedding).toBeDefined();
  });

  it('has correct providerId', () => {
    expect(fireworksEmbedding.providerId).toBe('fireworks');
  });

  it('has name Fireworks Embedding', () => {
    expect(fireworksEmbedding.name).toBe('Fireworks Embedding');
  });

  it('has isConfigured method', () => {
    expect(typeof fireworksEmbedding.isConfigured).toBe('function');
  });

  it('has embed method', () => {
    expect(typeof fireworksEmbedding.embed).toBe('function');
  });

  it('isConfigured returns false when no env key set', () => {
    const saved = process.env.FIREWORKS_API_KEY;
    delete process.env.FIREWORKS_API_KEY;
    expect(fireworksEmbedding.isConfigured()).toBe(false);
    if (saved !== undefined) process.env.FIREWORKS_API_KEY = saved;
  });

  it('isConfigured returns true when env key is set', () => {
    const saved = process.env.FIREWORKS_API_KEY;
    process.env.FIREWORKS_API_KEY = 'fw-test-key';
    expect(fireworksEmbedding.isConfigured()).toBe(true);
    if (saved !== undefined) process.env.FIREWORKS_API_KEY = saved;
    else delete process.env.FIREWORKS_API_KEY;
  });
});
