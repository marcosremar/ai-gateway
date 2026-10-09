import { describe, expect, it, vi } from 'vitest';
import { handleAudioSpeech } from '../../../src/gateway/proxy/routes/audio-speech';
import type { TTSProvider } from '../../../src/gateway/providers/cloud/types';
import type { ProxyRequest } from '../../../src/gateway/proxy/types';

const req = (body: Record<string, unknown>): ProxyRequest => ({ method: 'POST', url: '/v1/audio/speech', headers: {}, rawBody: Buffer.alloc(0), body });

function deployment() {
  const synthesize = vi.fn(async (_r: { extra?: Record<string, unknown> }) => ({ audio: Buffer.from([1]), contentType: 'audio/wav' }));
  const provider = { providerId: 'deployment:tts', isConfigured: () => true, getModels: () => [], getVoices: () => [], synthesize } as unknown as TTSProvider;
  return { synthesize, routes: { 'parle-tts': [{ providerId: 'deployment:tts', provider }] } };
}

const base = { model: 'parle-tts', input: 'Bom dia', voice: 'br-f-01', response_format: 'mp3' };

describe('audit 2026-10-09 #17: /v1/audio/speech forwards only known TTS fields to the replica', () => {
  it('a ref_audio URL (fetched from inside the replica) is refused with 400', async () => {
    const d = deployment();
    for (const ref_audio of ['http://169.254.169.254/latest/meta-data/', 'https://evil.example/a.wav', 'file:///etc/passwd', 42]) {
      const res = await handleAudioSpeech(req({ ...base, ref_audio }), d.routes as never);
      expect(res.status).toBe(400);
    }
    expect(d.synthesize).not.toHaveBeenCalled();
  });

  it('unknown fields are dropped; the documented ones (inline ref_audio included) still reach the replica', async () => {
    const d = deployment();
    const res = await handleAudioSpeech(req({
      ...base, ref_audio: 'data:audio/wav;base64,UklGRg==', ref_text: 'Olá.', task_type: 'Base', language: 'pt', stream_format: 'audio',
      speaker_embedding_url: 'http://10.0.0.1/', max_new_tokens: 999999, __proto__x: 1,
    }), d.routes as never);
    expect(res.status).toBe(200);
    expect(d.synthesize.mock.calls[0]![0].extra).toEqual({
      ref_audio: 'data:audio/wav;base64,UklGRg==', ref_text: 'Olá.', task_type: 'Base', language: 'pt', stream_format: 'audio',
    });
  });
});
