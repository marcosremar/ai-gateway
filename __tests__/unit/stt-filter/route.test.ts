import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetSttCache, handleAudioTranscriptions } from '../../../src/gateway/proxy/routes/audio-transcriptions';
import { _resetSttFilterStats, sttFilterStats } from '../../../src/gateway/proxy/routes/stt-filter';
import type { ProxyRequest } from '../../../src/gateway/proxy/types';

const req = (body: Record<string, unknown>, raw = Buffer.from([1, 2, 3])): ProxyRequest =>
  ({ method: 'POST', url: '/v1/audio/transcriptions', headers: {}, body, rawBody: raw });

function provider(answer: Record<string, unknown> | ((r: { wantSegments?: boolean }) => Record<string, unknown>)) {
  const transcribe = vi.fn(async (r: { wantSegments?: boolean }) => (typeof answer === 'function' ? answer(r) : answer));
  return { transcribe, p: { 'stt-m': { providerId: 'fake', transcribe, getModels: () => [], isConfigured: () => true } } as never };
}
const seg = (text: string, no_speech_prob: number, avg_logprob = -0.3) => ({ id: 0, start: 0, end: 1, text, no_speech_prob, avg_logprob, compression_ratio: 1.2 });

beforeEach(() => { _resetSttCache(); _resetSttFilterStats(); delete process.env.STT_HALLUCINATION_FILTER; });
afterEach(() => { delete process.env.STT_HALLUCINATION_FILTER; });

describe('STT route: hallucination filter', () => {
  it('drops the live misses of 2026-10-07 by pattern (credit line with a name, ♫ loop)', async () => {
    for (const [text, code] of [[' Legenda por Sônia Ruberti', 'pattern_credits'], [' E aí ♫ E aí E aí E aí E aí E aí E aí', 'music']]) {
      _resetSttCache();
      const { p } = provider({ text });
      const res = await handleAudioTranscriptions(req({ model: 'stt-m', language: 'Portuguese' }), p);
      expect(res.body).toEqual({ text: '' });
      expect(res.headers?.['X-STT-Filtered']).toBe(code);
    }
  });

  it('drops a blocklisted invention on a silent clip (language as full name, as the s2s loopback/parle send it)', async () => {
    const { p } = provider({ text: 'E aí.' });
    const res = await handleAudioTranscriptions(req({ model: 'stt-m', language: 'Portuguese' }), p);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: '' });
    expect(res.headers?.['X-STT-Filtered']).toBe('blocklist');
    expect(res.headers?.['X-STT-Raw-Length']).toBe('5');
    expect(JSON.stringify(res.headers)).not.toMatch(/aí/);
  });

  it('asks the provider for segment metadata and drops on no_speech_prob', async () => {
    const { p, transcribe } = provider({ text: 'Obrigada.', segments: [seg('Obrigada.', 0.92)] });
    const res = await handleAudioTranscriptions(req({ model: 'stt-m', language: 'pt' }), p);
    expect(transcribe.mock.calls[0][0].wantSegments).toBe(true);
    expect(res.body).toEqual({ text: '' });
    expect(res.headers?.['X-STT-Filtered']).toContain('no_speech_prob');
  });

  it('keeps a real sentence and a legit one-word answer', async () => {
    for (const [text, segs] of [['Eu queria um pão, por favor.', [seg('Eu queria um pão, por favor.', 0.01, -0.2)]], ['Sim.', undefined], ['Oi', undefined]] as const) {
      _resetSttCache();
      const { p } = provider({ text, ...(segs ? { segments: segs } : {}) });
      const res = await handleAudioTranscriptions(req({ model: 'stt-m', language: 'pt' }), p);
      expect(res.body).toEqual({ text });
      // On every answer, so a client can count (QA 2026-10-07: absent when kept); before, undefined here.
      expect(res.headers?.['X-STT-Filtered']).toBe('none');
      expect(res.headers?.['X-STT-Raw-Length']).toBe(String(text.length));
      const hit = await handleAudioTranscriptions(req({ model: 'stt-m', language: 'pt' }), p);
      expect(hit.headers?.['X-Cache']).toBe('HIT');
      expect(hit.headers?.['X-STT-Filtered']).toBe('none');
    }
    expect(sttFilterStats().filtered).toBe(0);
  });

  it('keeps the surviving segments when only some are rejected (and passes verbose_json through)', async () => {
    const { p } = provider({ text: 'Bom dia. Obrigado.', language: 'pt', duration: 3,
      segments: [seg('Bom dia.', 0.02), { ...seg(' Obrigado.', 0.95), id: 1, start: 1, end: 2 }] });
    const res = await handleAudioTranscriptions(req({ model: 'stt-m', language: 'pt', response_format: 'verbose_json' }), p);
    const body = res.body as { text: string; segments: Array<{ text: string }> };
    expect(body.text).toBe('Bom dia.');
    expect(body.segments.map(s => s.text)).toEqual(['Bom dia.']);
    expect(res.headers?.['X-STT-Filtered']).toBeDefined();
  });

  it('plain json carries the detected language and its probability when the provider gave them', async () => {
    const { p } = provider({ text: 'Um real e cinquenta.', language: 'fr', language_probability: 0.62, segments: [seg('Um real e cinquenta.', 0.1)] });
    const res = await handleAudioTranscriptions(req({ model: 'stt-m', language: 'pt' }), p);
    expect(res.body).toEqual({ text: 'Um real e cinquenta.', language: 'fr', language_probability: 0.62 });
  });

  it('short real answers the VAD heard survive a high no_speech_prob (large-v3, 2026-10-11)', async () => {
    for (const [text, no_speech_prob, avg_logprob, speech_ms] of [['2', 0.6179, -0.4838, 640], ['R$ 3,00.', 0.7764, -0.1745, 872],
      ['Um real e cinquenta.', 0.65, -0.95, 1938], ['Um real e cinquenta.', 0.2, -1.3, 1938], ['Eu não sei.', 0.45, -0.3, 700]] as const) {
      _resetSttCache();
      const { p } = provider({ text, no_speech_prob, avg_logprob, compression_ratio: 0.5, speech_ms });
      const res = await handleAudioTranscriptions(req({ model: 'stt-m', language: 'pt' }), p);
      expect(res.body).toEqual({ text });
      expect(res.headers?.['X-STT-Filtered']).toBe('none');
    }
  });

  it('silence and noise (no speech for the VAD) are still dropped, and so are voiced inventions', async () => {
    for (const [text, no_speech_prob, avg_logprob, speech_ms] of [['Obrigado.', 0.8117, -0.5309, 0], ['Obrigado.', 0.8117, -0.5309, undefined],
      ['E aí', 0.8966, -0.3213, 0], ['2', 0.6179, -0.4838, undefined], ['Obrigado.', 0.85, -1.3, 300],
      ['Obrigado por assistir!', 0.1, -0.2, 900], [' Legenda por Sônia Ruberti', 0.1, -0.2, 900]] as const) {
      _resetSttCache();
      const { p } = provider({ text, no_speech_prob, avg_logprob, compression_ratio: 0.5, ...(speech_ms === undefined ? {} : { speech_ms }) });
      const res = await handleAudioTranscriptions(req({ model: 'stt-m', language: 'pt' }), p);
      expect(res.body).toEqual({ text: '' });
    }
  });

  it('env STT_HALLUCINATION_FILTER=0 turns it off for everyone', async () => {
    process.env.STT_HALLUCINATION_FILTER = '0';
    const { p, transcribe } = provider({ text: 'E aí.' });
    const res = await handleAudioTranscriptions(req({ model: 'stt-m', language: 'pt' }), p);
    expect(res.body).toEqual({ text: 'E aí.' });
    expect(transcribe.mock.calls[0][0].wantSegments).toBe(false);
    expect(res.headers?.['X-STT-Filtered']).toBe('off');
  });

  it('multipart field filter_hallucinations=false opts one request out (QA) and never poisons the cache', async () => {
    const { p } = provider({ text: 'E aí.' });
    const off = await handleAudioTranscriptions(req({ model: 'stt-m', language: 'pt', filter_hallucinations: 'false' }), p);
    expect(off.body).toEqual({ text: 'E aí.' });
    // same audio, filter on: must not be served the unfiltered cached text
    const on = await handleAudioTranscriptions(req({ model: 'stt-m', language: 'pt' }), p);
    expect(on.body).toEqual({ text: '' });
    expect(on.headers?.['X-Cache']).toBe('MISS');
  });

  it('a filtered answer is never cached: the retry reaches the provider again', async () => {
    const { p, transcribe } = provider({ text: 'E aí.' });
    await handleAudioTranscriptions(req({ model: 'stt-m', language: 'pt' }), p);
    const again = await handleAudioTranscriptions(req({ model: 'stt-m', language: 'pt' }), p);
    expect(again.headers?.['X-Cache']).toBe('MISS');
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it('a kept answer is cached as before', async () => {
    const { p, transcribe } = provider({ text: 'Bom dia.' });
    await handleAudioTranscriptions(req({ model: 'stt-m', language: 'pt' }), p);
    const again = await handleAudioTranscriptions(req({ model: 'stt-m', language: 'pt' }), p);
    expect(again.headers?.['X-Cache']).toBe('HIT');
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('counts filtered answers for /health and logs no transcript', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { lines.push(String(c)); return true; });
    try {
      const { p } = provider({ text: 'Legendas pela comunidade Amara.org' });
      await handleAudioTranscriptions(req({ model: 'stt-m', language: 'pt' }), p);
    } finally { spy.mockRestore(); }
    const s = sttFilterStats();
    expect(s).toMatchObject({ answered: 1, filtered: 1, byReason: { blocklist: 1 }, filteredRate: 1 });
    expect(lines.join('')).not.toMatch(/Amara/i);
  });
});
