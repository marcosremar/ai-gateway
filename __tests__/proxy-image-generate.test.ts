import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleImageGenerate, handleImageInpaint } from '../src/proxy/routes/images';
import type { ProxyRequest } from '../src/proxy/types';

// Mock SSRF guard so inpaint tests don't do real DNS lookups
const mockIsPrivateUrlResolved = vi.fn().mockResolvedValue(false);
vi.mock('../src/gateway/pipeline/ssrf-protection', () => ({
  isPrivateUrlResolved: (...args: unknown[]) => mockIsPrivateUrlResolved(...args),
  isPrivateUrl: () => false,
  validateEndpointUrl: () => {},
}));

function makeReq(body: Record<string, unknown>): ProxyRequest {
  return { method: 'POST', url: '/v1/images/generate', headers: {}, body, rawBody: Buffer.alloc(0) };
}

const mockProvider = {
  providerId: 'test' as const,
  generate: vi.fn().mockResolvedValue({
    image: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    contentType: 'image/png',
  }),
  isConfigured: vi.fn().mockReturnValue(true),
};

describe('handleImageGenerate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider.isConfigured.mockReturnValue(true);
  });

  it('returns 501 when no provider configured', async () => {
    const res = await handleImageGenerate(makeReq({ prompt: 'a cat' }), undefined);
    expect(res.status).toBe(501);
  });

  it('returns 503 when provider is not configured (missing API key)', async () => {
    mockProvider.isConfigured.mockReturnValue(false);
    const res = await handleImageGenerate(makeReq({ prompt: 'a cat' }), mockProvider as any);
    expect(res.status).toBe(503);
  });

  it('returns 400 when body is not an object', async () => {
    const req: ProxyRequest = { method: 'POST', url: '/v1/images/generate', headers: {}, body: null, rawBody: Buffer.alloc(0) };
    const res = await handleImageGenerate(req, mockProvider as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 when prompt is missing', async () => {
    const res = await handleImageGenerate(makeReq({ width: 512, height: 512 }), mockProvider as any);
    expect(res.status).toBe(400);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toContain('prompt');
  });

  it('returns 400 when prompt is not a string', async () => {
    const res = await handleImageGenerate(makeReq({ prompt: 42 }), mockProvider as any);
    expect(res.status).toBe(400);
  });

  it('returns 200 with image bytes on valid request', async () => {
    const res = await handleImageGenerate(makeReq({ prompt: 'a cat' }), mockProvider as any);
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Buffer);
    expect((res.headers as Record<string, string>)['Content-Type']).toBe('image/png');
  });

  it('passes prompt to provider.generate', async () => {
    await handleImageGenerate(makeReq({ prompt: 'a blue dragon' }), mockProvider as any);
    expect(mockProvider.generate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a blue dragon' }),
    );
  });

  it('passes optional params to provider.generate', async () => {
    await handleImageGenerate(
      makeReq({ prompt: 'a cat', model: 'flux', width: 1024, height: 768, steps: 30, seed: 42 }),
      mockProvider as any,
    );
    expect(mockProvider.generate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'flux', width: 1024, height: 768, steps: 30, seed: 42 }),
    );
  });

  it('returns 500 when provider.generate throws', async () => {
    mockProvider.generate.mockRejectedValueOnce(new Error('upstream error'));
    const res = await handleImageGenerate(makeReq({ prompt: 'a cat' }), mockProvider as any);
    expect(res.status).toBe(500);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toBe('upstream error');
  });

  it('propagates provider error status', async () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    mockProvider.generate.mockRejectedValueOnce(err);
    const res = await handleImageGenerate(makeReq({ prompt: 'a cat' }), mockProvider as any);
    expect(res.status).toBe(429);
  });
});

describe('handleImageInpaint', () => {
  const validBody = {
    prompt: 'fill in the floor',
    imageUrl: 'https://cdn.example.com/photo.jpg',
    maskUrl: 'https://cdn.example.com/mask.png',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider.isConfigured.mockReturnValue(true);
    mockIsPrivateUrlResolved.mockResolvedValue(false);
  });

  it('returns 501 when no provider', async () => {
    const res = await handleImageInpaint(makeReq(validBody), undefined);
    expect(res.status).toBe(501);
  });

  it('returns 503 when provider not configured', async () => {
    mockProvider.isConfigured.mockReturnValue(false);
    const res = await handleImageInpaint(makeReq(validBody), mockProvider as any);
    expect(res.status).toBe(503);
  });

  it('returns 400 when body is not an object', async () => {
    const req: ProxyRequest = { method: 'POST', url: '/v1/images/inpaint', headers: {}, body: null, rawBody: Buffer.alloc(0) };
    const res = await handleImageInpaint(req, mockProvider as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 when prompt is missing', async () => {
    const res = await handleImageInpaint(
      makeReq({ imageUrl: validBody.imageUrl, maskUrl: validBody.maskUrl }),
      mockProvider as any,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when imageUrl is missing', async () => {
    const res = await handleImageInpaint(
      makeReq({ prompt: 'fill', maskUrl: validBody.maskUrl }),
      mockProvider as any,
    );
    expect(res.status).toBe(400);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toContain('imageUrl');
  });

  it('returns 400 when maskUrl is missing', async () => {
    const res = await handleImageInpaint(
      makeReq({ prompt: 'fill', imageUrl: validBody.imageUrl }),
      mockProvider as any,
    );
    expect(res.status).toBe(400);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toContain('maskUrl');
  });

  it('returns 400 when imageUrl resolves to private address (SSRF)', async () => {
    mockIsPrivateUrlResolved.mockResolvedValueOnce(true);
    const res = await handleImageInpaint(makeReq(validBody), mockProvider as any);
    expect(res.status).toBe(400);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toMatch(/SSRF/i);
  });

  it('returns 400 when maskUrl resolves to private address (SSRF)', async () => {
    // imageUrl passes, maskUrl triggers SSRF
    mockIsPrivateUrlResolved
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const res = await handleImageInpaint(makeReq(validBody), mockProvider as any);
    expect(res.status).toBe(400);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toMatch(/SSRF/i);
  });

  it('returns 200 with image on valid request', async () => {
    const res = await handleImageInpaint(makeReq(validBody), mockProvider as any);
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Buffer);
    expect((res.headers as Record<string, string>)['Content-Type']).toBe('image/png');
  });

  it('passes imageUrl and maskUrl to provider.generate', async () => {
    await handleImageInpaint(makeReq(validBody), mockProvider as any);
    expect(mockProvider.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: validBody.imageUrl,
        maskUrl: validBody.maskUrl,
      }),
    );
  });

  it('returns 500 when provider.generate throws', async () => {
    mockProvider.generate.mockRejectedValueOnce(new Error('inpaint failed'));
    const res = await handleImageInpaint(makeReq(validBody), mockProvider as any);
    expect(res.status).toBe(500);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toBe('inpaint failed');
  });
});
