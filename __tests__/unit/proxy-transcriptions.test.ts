import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAudioTranscriptions, _resetSttCache } from '../src/proxy/routes/audio-transcriptions';
import type { ProxyRequest } from '../src/proxy/types';

function makeReq(body: Record<string, unknown>, rawBody = Buffer.from([1, 2, 3])): ProxyRequest {
  return { method: 'POST', url: '/v1/audio/transcriptions', headers: {}, body, rawBody };
}

const mockSttProvider = {
  providerId: 'test' as const,
  transcribe: vi.fn().mockResolvedValue({ text: 'hello world', language: 'en' }),
  getModels: vi.fn().mockReturnValue([]),
  isConfigured: () => true,
};

const providers = { 'test-model': mockSttProvider } as any;

describe('handleAudioTranscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSttCache(); // Clear audio hash cache between tests
  });

  it('returns 400 when model is missing', async () => {
    const res = await handleAudioTranscriptions(makeReq({}), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when model is not a string', async () => {
    const res = await handleAudioTranscriptions(makeReq({ model: 123 }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when audio data is missing (empty rawBody)', async () => {
    const res = await handleAudioTranscriptions(makeReq({ model: 'test-model' }, Buffer.alloc(0)), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when audio exceeds 25MB', async () => {
    const bigAudio = Buffer.alloc(25 * 1024 * 1024 + 1);
    const res = await handleAudioTranscriptions(makeReq({ model: 'test-model' }, bigAudio), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid response_format', async () => {
    const res = await handleAudioTranscriptions(makeReq({ model: 'test-model', response_format: 'bogus' }), providers);
    expect(res.status).toBe(400);
  });

  it('accepts valid response_formats', async () => {
    const formats = ['json', 'text', 'srt', 'verbose_json', 'vtt'];
    for (const fmt of formats) {
      const res = await handleAudioTranscriptions(
        makeReq({ model: 'test-model', response_format: fmt }),
        providers,
      );
      expect(res.status).toBe(200);
    }
  });

  it('returns 404 when model not found', async () => {
    const res = await handleAudioTranscriptions(makeReq({ model: 'nonexistent' }), providers);
    expect(res.status).toBe(404);
  });

  it('returns 200 with text on valid request', async () => {
    const res = await handleAudioTranscriptions(makeReq({ model: 'test-model' }), providers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'hello world' });
  });

  it('calls provider.transcribe with audio buffer', async () => {
    const audioBuf = Buffer.from([10, 20, 30]);
    await handleAudioTranscriptions(makeReq({ model: 'test-model' }, audioBuf), providers);
    expect(mockSttProvider.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ audio: audioBuf, model: 'test-model' }),
    );
  });

  it('passes language and prompt to provider', async () => {
    await handleAudioTranscriptions(makeReq({ model: 'test-model', language: 'en', prompt: 'test' }), providers);
    expect(mockSttProvider.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'en', prompt: 'test' }),
    );
  });

  it('passes responseFormat to provider', async () => {
    await handleAudioTranscriptions(makeReq({ model: 'test-model', response_format: 'srt' }), providers);
    expect(mockSttProvider.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ responseFormat: 'srt' }),
    );
  });

  it('returns 500 when provider throws', async () => {
    mockSttProvider.transcribe.mockRejectedValueOnce(new Error('stt fail'));
    const res = await handleAudioTranscriptions(makeReq({ model: 'test-model' }), providers);
    expect(res.status).toBe(500);
  });
});
