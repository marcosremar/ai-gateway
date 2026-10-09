import { describe, expect, it } from 'vitest';
import { ApiKeyRegistry } from '../../src/gateway/proxy/middleware/api-keys';

describe('audit 2026-10-09: an entry with an empty key', () => {
  it('never authenticates a request that sends no key', () => {
    const registry = new ApiKeyRegistry(':parle,real-key-0123456789:other');
    expect(registry.resolve('')).toBeNull();
    expect(registry.validate('')).toBe(false);
    expect(registry.resolve('real-key-0123456789')?.userId).toBe('other');
  });

  it('leaves the registry empty when it is the only entry', () => {
    expect(new ApiKeyRegistry(':parle').size).toBe(0);
  });
});
