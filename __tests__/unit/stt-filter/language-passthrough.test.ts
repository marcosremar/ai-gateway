/**
 * STT routed to a GPU deployment (speech-stack replica): the detected `language` (ISO-639-1), `duration` and `segments`
 * reach a client that asked for `verbose_json` — ucast's automatic FR↔EN direction swap reads `language`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentSTTProvider } from '../../../src/deployments/inference-providers';
import { applyWhisperMeta, toIsoLanguage } from '../../../src/gateway/providers/cloud/stt-segments';
import { _resetSttCache, handleAudioTranscriptions } from '../../../src/gateway/proxy/routes/audio-transcriptions';
import type { ProxyRequest } from '../../../src/gateway/proxy/types';
import type { STTResponse } from '../../../src/gateway/providers/cloud/types';

const lease = { machine: { ip: '10.0.0.1' }, token: 't', done: () => {} };
const controller = { get: () => ({}), acquire: async () => lease, wake: () => null } as never;

/** What docker/speech-stack/server.py answers on /v1/audio/transcriptions (stt_batch.py `_one`), whatever the format. */
const SPEECH_STACK = { text: 'Bonjour à tous, merci d’être venus.', language: 'fr', duration: 2.48,
  no_speech_prob: 0.01, avg_logprob: -0.21, compression_ratio: 1.1, audio_ms: 3, ms: 180 };

const req = (body: Record<string, unknown>, raw = Buffer.from([1, 2, 3])): ProxyRequest =>
  ({ method: 'POST', url: '/v1/audio/transcriptions', headers: {}, body, rawBody: raw });

function deployment(answer: Record<string, unknown>) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
  const provider = new DeploymentSTTProvider(controller, 'babelcast-speech', { fetchImpl: fetchImpl as never });
  return { fetchImpl, routes: { 'babelcast-stt': provider } as never };
}

beforeEach(() => { _resetSttCache(); delete process.env.STT_HALLUCINATION_FILTER; });

describe('toIsoLanguage', () => {
  it.each([
    ['fr', 'fr'], ['FR', 'fr'], ['fr-FR', 'fr'], ['pt_BR', 'pt'], ['french', 'fr'], ['French', 'fr'], [' english ', 'en'],
    ['portuguese', 'pt'], ['lao', 'lo'], ['haitian creole', 'ht'], ['cantonese', 'yue'], ['haw', 'haw'],
  ])('%j → %j', (input, out) => expect(toIsoLanguage(input)).toBe(out));

  it('keeps an unknown value as sent and drops empty / non-strings', () => {
    expect(toIsoLanguage('Klingon')).toBe('Klingon');
    expect(toIsoLanguage('')).toBeUndefined();
    expect(toIsoLanguage('  ')).toBeUndefined();
    expect(toIsoLanguage(null)).toBeUndefined();
    expect(toIsoLanguage(3)).toBeUndefined();
  });
});

describe('applyWhisperMeta', () => {
  it('reads language (normalized) and duration', () => {
    const r: STTResponse = { text: 'x' };
    applyWhisperMeta(r, { text: 'x', language: 'french', duration: 1.5 });
    expect(r).toEqual({ text: 'x', language: 'fr', duration: 1.5 });
  });
  it('plain {text} adds nothing; bad duration ignored', () => {
    const r: STTResponse = { text: 'x' };
    applyWhisperMeta(r, { text: 'x', duration: 'long', language: '' });
    applyWhisperMeta(r, null);
    expect(r).toEqual({ text: 'x' });
  });
});

describe('DeploymentSTTProvider: language/duration', () => {
  it('reads what the speech-stack replica returns', async () => {
    const { routes } = deployment(SPEECH_STACK);
    const r = await (routes as Record<string, DeploymentSTTProvider>)['babelcast-stt'].transcribe({ audio: Buffer.from([1]), model: 'm', wantSegments: true });
    expect(r).toMatchObject({ text: SPEECH_STACK.text, language: 'fr', duration: 2.48, no_speech_prob: 0.01 });
  });
  it('a replica answering a Whisper name gets ISO-639-1', async () => {
    const { routes } = deployment({ text: 'Hello there, how was the meeting today?', language: 'english', duration: 1 });
    const r = await (routes as Record<string, DeploymentSTTProvider>)['babelcast-stt'].transcribe({ audio: Buffer.from([1]), model: 'm' });
    expect(r.language).toBe('en');
  });
});

describe('STT route over a deployment', () => {
  it('verbose_json: language + duration pass through (no segments when the replica sends none)', async () => {
    const { routes } = deployment(SPEECH_STACK);
    const res = await handleAudioTranscriptions(req({ model: 'babelcast-stt', response_format: 'verbose_json' }), routes);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: SPEECH_STACK.text, language: 'fr', duration: 2.48 });
  });

  it('verbose_json: segments pass through when the replica sends them', async () => {
    const segments = [{ id: 0, start: 0, end: 1.2, text: 'Hello there, how was the meeting today?', no_speech_prob: 0.01, avg_logprob: -0.2, compression_ratio: 1 }];
    const { routes } = deployment({ text: 'Hello there, how was the meeting today?', language: 'English', duration: 1.2, segments });
    const res = await handleAudioTranscriptions(req({ model: 'babelcast-stt', response_format: 'verbose_json' }), routes);
    expect(res.body).toEqual({ text: 'Hello there, how was the meeting today?', language: 'en', duration: 1.2, segments });
  });

  it('a cache hit answers verbose_json with the same metadata', async () => {
    const { routes, fetchImpl } = deployment(SPEECH_STACK);
    await handleAudioTranscriptions(req({ model: 'babelcast-stt', response_format: 'verbose_json' }), routes);
    const hit = await handleAudioTranscriptions(req({ model: 'babelcast-stt', response_format: 'verbose_json' }), routes);
    expect(hit.headers?.['X-Cache']).toBe('HIT');
    expect(hit.body).toEqual({ text: SPEECH_STACK.text, language: 'fr', duration: 2.48 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('json (default) stays {text} only', async () => {
    const { routes } = deployment(SPEECH_STACK);
    const res = await handleAudioTranscriptions(req({ model: 'babelcast-stt' }), routes);
    expect(res.body).toEqual({ text: SPEECH_STACK.text });
    expect(Object.keys(res.body as object)).toEqual(['text']);
  });

  it('a text-only replica keeps the old answer under verbose_json', async () => {
    const { routes } = deployment({ text: 'Bonjour, je voudrais un café crème.' });
    const res = await handleAudioTranscriptions(req({ model: 'babelcast-stt', response_format: 'verbose_json' }), routes);
    expect(Object.keys(res.body as object)).toEqual(['text']);
  });
});
