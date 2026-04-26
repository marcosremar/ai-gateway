/**
 * Bug: RequestCoalescer.buildKey() only hashes
 * { provider, model, messages, temperature }. Two chat requests with
 * different tools / response_format / max_tokens / top_p / seed / stop
 * collide on the same key, so the second request gets the FIRST one's
 * response — even though they semantically expect different outputs
 * (different tools means different tool_calls, different
 * response_format means different shape, etc.).
 *
 * Fix: extend buildKey to incorporate every output-affecting field.
 */
import { describe, it, expect } from 'vitest';
import { RequestCoalescer } from '../../src/gateway/proxy/middleware/request-coalescer';

describe('RequestCoalescer.buildKey — distinguishes by tools / format', () => {
  const coalescer = new RequestCoalescer();
  const baseParams = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0,
  };

  it('produces different keys for requests differing only in tools', () => {
    const k1 = coalescer.buildKey({ ...baseParams, tools: [{ type: 'function', function: { name: 'a' } }] } as any);
    const k2 = coalescer.buildKey({ ...baseParams, tools: [{ type: 'function', function: { name: 'b' } }] } as any);
    expect(k1).not.toBe(null);
    expect(k2).not.toBe(null);
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for requests differing only in response_format', () => {
    const k1 = coalescer.buildKey({ ...baseParams, response_format: { type: 'json_object' } } as any);
    const k2 = coalescer.buildKey({ ...baseParams, response_format: { type: 'text' } } as any);
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for requests differing only in max_tokens', () => {
    const k1 = coalescer.buildKey({ ...baseParams, max_tokens: 100 } as any);
    const k2 = coalescer.buildKey({ ...baseParams, max_tokens: 200 } as any);
    expect(k1).not.toBe(k2);
  });
});
