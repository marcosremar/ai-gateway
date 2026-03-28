import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { probeCloudProvider, probeAllCloudProviders } from '../src/providers/cloud-health';

describe('probeCloudProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('returns no health endpoint for provider without one', async () => {
    const result = await probeCloudProvider('ollama' as any, 'key');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('No health endpoint for ollama');
  });

  it('returns ok:true on successful fetch', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({ ok: true } as Response);
    const result = await probeCloudProvider('groq', 'gsk_test');
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('groq');
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns ok:false on network error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('Network failure'));
    const result = await probeCloudProvider('openai', 'sk_test');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Network failure');
  });

  it('returns ok:false on timeout', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    vi.mocked(globalThis.fetch).mockRejectedValue(abortError);
    const result = await probeCloudProvider('fireworks', 'fw_test', 1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('aborted');
  });

  it('uses Token header for deepgram, Bearer for others', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValue({ ok: true } as Response);

    await probeCloudProvider('deepgram', 'dg_key');
    const deepgramCall = mockFetch.mock.calls[0]!;
    expect((deepgramCall[1] as Record<string, any>).headers).toEqual({ Authorization: 'Token dg_key' });

    mockFetch.mockClear();
    await probeCloudProvider('groq', 'gq_key');
    const groqCall = mockFetch.mock.calls[0]!;
    expect((groqCall[1] as Record<string, any>).headers).toEqual({ Authorization: 'Bearer gq_key' });
  });
});

describe('probeAllCloudProviders', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true } as Response));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('returns empty array for empty keys', async () => {
    const result = await probeAllCloudProviders({});
    expect(result).toEqual([]);
  });

  it('probes groq + openai and returns 2 results', async () => {
    const result = await probeAllCloudProviders({
      groq: 'gsk_test',
      openai: 'sk_test',
    });
    expect(result).toHaveLength(2);
    const providers = result.map(r => r.provider);
    expect(providers).toContain('groq');
    expect(providers).toContain('openai');
  });

  it('ignores providers without health endpoints', async () => {
    const result = await probeAllCloudProviders({
      ollama: 'fake',
      groq: 'gsk_test',
    });
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe('groq');
  });

  it('skips providers with null or empty apiKey', async () => {
    const result = await probeAllCloudProviders({
      groq: '',
      openai: null as any,
      fireworks: 'fw_key',
    });
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe('fireworks');
  });
});
