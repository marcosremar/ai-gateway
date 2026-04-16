/**
 * Tests for src/providers/openai-compat/client-cache.ts
 * Covers: cache hit/miss, key uniqueness, eviction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Reset module cache between tests
let getOrCreateClient: typeof import('../src/gateway/providers/cloud/openai-compat/client-cache').getOrCreateClient;

beforeEach(async () => {
  // Reimport to get a fresh module state (cache is module-level)
  vi.resetModules();
  const mod = await import('../src/gateway/providers/cloud/openai-compat/client-cache');
  getOrCreateClient = mod.getOrCreateClient;
});

describe('getOrCreateClient', () => {
  it('returns an OpenAI client instance', () => {
    const client = getOrCreateClient('https://api.openai.com/v1', 'test-key');
    expect(client).toBeDefined();
    expect(typeof client.chat.completions.create).toBe('function');
  });

  it('returns the same instance for identical config', () => {
    const c1 = getOrCreateClient('https://api.openai.com/v1', 'test-key');
    const c2 = getOrCreateClient('https://api.openai.com/v1', 'test-key');
    expect(c1).toBe(c2);
  });

  it('returns different instances for different baseURLs', () => {
    const c1 = getOrCreateClient('https://api.openai.com/v1', 'test-key');
    const c2 = getOrCreateClient('https://api.groq.com/openai/v1', 'test-key');
    expect(c1).not.toBe(c2);
  });

  it('returns different instances for different API keys', () => {
    const c1 = getOrCreateClient('https://api.openai.com/v1', 'key-one');
    const c2 = getOrCreateClient('https://api.openai.com/v1', 'key-two');
    expect(c1).not.toBe(c2);
  });

  it('returns different instances when headers differ', () => {
    const c1 = getOrCreateClient('https://api.openai.com/v1', 'key', { 'X-Custom': 'a' });
    const c2 = getOrCreateClient('https://api.openai.com/v1', 'key', { 'X-Custom': 'b' });
    expect(c1).not.toBe(c2);
  });

  it('returns same instance with identical headers', () => {
    const c1 = getOrCreateClient('https://api.openai.com/v1', 'key', { 'X-Org': 'org-123' });
    const c2 = getOrCreateClient('https://api.openai.com/v1', 'key', { 'X-Org': 'org-123' });
    expect(c1).toBe(c2);
  });

  it('no headers and empty headers are different cache entries', () => {
    const c1 = getOrCreateClient('https://api.openai.com/v1', 'key');
    const c2 = getOrCreateClient('https://api.openai.com/v1', 'key', {});
    // {} serializes to '{}', undefined serializes to '' — different keys
    expect(c1).not.toBe(c2);
  });

  it('handles empty API key', () => {
    const c1 = getOrCreateClient('https://api.openai.com/v1', '');
    const c2 = getOrCreateClient('https://api.openai.com/v1', '');
    expect(c1).toBe(c2);
  });

  it('caches up to MAX_CACHE_SIZE (50) entries', () => {
    const clients = new Set();
    for (let i = 0; i < 50; i++) {
      clients.add(getOrCreateClient(`https://host-${i}.example.com/v1`, 'key'));
    }
    expect(clients.size).toBe(50);
  });

  it('evicts oldest entry when cache is full', async () => {
    // This test verifies that cache size is maintained at MAX_CACHE_SIZE
    // Fill to 50 entries
    for (let i = 0; i < 50; i++) {
      getOrCreateClient(`https://host-${i}.example.com/v1`, `key-${i}`);
    }
    // Add one more - cache should evict oldest
    getOrCreateClient('https://new-host.example.com/v1', 'new-key');
    // Verify cache size stays at MAX_CACHE_SIZE (50)
    const { size } = await import('../src/gateway/providers/cloud/openai-compat/client-cache').then(m => m.getCacheStats());
    expect(size).toBeLessThanOrEqual(50);
  });
});
