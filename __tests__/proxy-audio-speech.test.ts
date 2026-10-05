import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAudioSpeech } from '../src/proxy/routes/audio-speech';
import type { ProxyRequest } from '../src/proxy/types';

function makeReq(body: Record<string, unknown>): ProxyRequest {
  return { method: 'POST', url: '/v1/audio/speech', headers: {}, body, rawBody: Buffer.alloc(0) };
}

const mockTtsProvider = {
  providerId: 'test' as const,
  synthesize: vi.fn().mockResolvedValue({ audio: Buffer.from([1, 2, 3]), contentType: 'audio/mp3' }),
  synthesizeStream: vi.fn(),
  getModels: vi.fn().mockReturnValue([]),
  getVoices: vi.fn().mockReturnValue([]),
  isConfigured: () => true,
};

const providers = { 'test-model': mockTtsProvider } as any;

describe('handleAudioSpeech', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validBody = { model: 'test-model', input: 'hello world', voice: 'alloy' };

  it('returns 400 when model is missing', async () => {
    const res = await handleAudioSpeech(makeReq({ input: 'hi', voice: 'alloy' }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when model is not a string', async () => {
    const res = await handleAudioSpeech(makeReq({ model: 123, input: 'hi', voice: 'alloy' }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when input is missing', async () => {
    const res = await handleAudioSpeech(makeReq({ model: 'test-model', voice: 'alloy' }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when input is not a string', async () => {
    const res = await handleAudioSpeech(makeReq({ model: 'test-model', input: 123, voice: 'alloy' }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when voice is missing', async () => {
    const res = await handleAudioSpeech(makeReq({ model: 'test-model', input: 'hi' }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when voice is not a string', async () => {
    const res = await handleAudioSpeech(makeReq({ model: 'test-model', input: 'hi', voice: 42 }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when input exceeds 4096 characters', async () => {
    const res = await handleAudioSpeech(makeReq({ ...validBody, input: 'a'.repeat(4097) }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when speed is below 0.25', async () => {
    const res = await handleAudioSpeech(makeReq({ ...validBody, speed: 0.1 }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when speed exceeds 4.0', async () => {
    const res = await handleAudioSpeech(makeReq({ ...validBody, speed: 5.0 }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when speed is not a number', async () => {
    const res = await handleAudioSpeech(makeReq({ ...validBody, speed: 'fast' }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid response_format', async () => {
    const res = await handleAudioSpeech(makeReq({ ...validBody, response_format: 'xyz' }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 404 when model not found', async () => {
    const res = await handleAudioSpeech(makeReq({ model: 'nonexistent', input: 'hi', voice: 'alloy' }), providers);
    expect(res.status).toBe(404);
  });

  it('returns 200 with audio on valid request', async () => {
    const res = await handleAudioSpeech(makeReq(validBody), providers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(Buffer.from([1, 2, 3]));
    expect(res.headers).toEqual({ 'Content-Type': 'audio/mp3', 'X-Gateway-Provider': 'test' });
  });

  it('calls provider.synthesize with correct args', async () => {
    await handleAudioSpeech(makeReq(validBody), providers);
    expect(mockTtsProvider.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'test-model', input: 'hello world', voice: 'alloy' }),
    );
  });

  it('passes response_format to provider (defaults to mp3)', async () => {
    await handleAudioSpeech(makeReq(validBody), providers);
    expect(mockTtsProvider.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ responseFormat: 'mp3' }),
    );
  });

  it('passes custom response_format to provider', async () => {
    await handleAudioSpeech(makeReq({ ...validBody, response_format: 'wav' }), providers);
    expect(mockTtsProvider.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ responseFormat: 'wav' }),
    );
  });

  it('passes speed to provider', async () => {
    await handleAudioSpeech(makeReq({ ...validBody, speed: 1.5 }), providers);
    expect(mockTtsProvider.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ speed: 1.5 }),
    );
  });

  it('returns 503 provider_unavailable naming the provider when it throws', async () => {
    mockTtsProvider.synthesize.mockRejectedValue(new Error('tts fail'));
    const res = await handleAudioSpeech(makeReq(validBody), providers);
    mockTtsProvider.synthesize.mockResolvedValue({ audio: Buffer.from([1, 2, 3]), contentType: 'audio/mp3' });
    expect(res.status).toBe(503);
    expect((res.body as { error: { type: string; message: string } }).error.type).toBe('provider_unavailable');
    expect((res.body as { error: { message: string } }).error.message).toContain('test failed: tts fail');
  });

  it('accepts valid formats: mp3, opus, aac, flac, wav, pcm', async () => {
    const formats = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'];
    for (const fmt of formats) {
      mockTtsProvider.synthesize.mockResolvedValueOnce({ audio: Buffer.from([1]), contentType: `audio/${fmt}` });
      const res = await handleAudioSpeech(makeReq({ ...validBody, response_format: fmt }), providers);
      expect(res.status).toBe(200);
    }
  });
});
