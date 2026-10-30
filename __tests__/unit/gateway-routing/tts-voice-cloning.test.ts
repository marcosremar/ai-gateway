/**
 * parle-tts through the gateway: the parle deployment runs Qwen3-TTS **Base** (voice cloning). The gateway must
 * turn a cast voice id into task_type/ref_audio/ref_text, forward client extras intact, keep the stream, and give
 * the OpenRouter fallback the client's `fallback_voice`.
 */
import { describe, expect, it, vi } from 'vitest';
import { DeploymentTTSProvider } from '../../../src/deployments/inference-providers';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import type { TTSProvider } from '../../../src/gateway/providers/cloud/types';
import { handleAudioSpeech } from '../../../src/gateway/proxy/routes/audio-speech';
import type { ProxyRequest, RouteTarget } from '../../../src/gateway/proxy/types';

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const CATALOG = {
  model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
  voices: [{ id: 'br-f-01', lang: 'pt-BR', gender: 'feminine', audio: 'http://replica/refs/br-f-01.wav', text: 'Olá, eu sou a Ana.' }],
};

/** `GET /v1/voices` of the speech-stack image (docker/speech-stack/server.py `list_voices`): no audio field. */
const SPEECH_STACK_VOICES = [
  { id: 'br-f-03', lang: 'pt-BR', gender: 'feminine', text: 'Porque há muitas semelhanças Entre as crianças e as flores.' },
  { id: 'br-m-08', lang: 'pt-BR', gender: 'masculine', text: 'Pode pedir à vontade, que a casa é sua.' },
];

function controller(cold = false) {
  const lease = { machine: { id: 'm1', ip: '10.0.0.5' }, token: 'tok', done: vi.fn() };
  return {
    get: vi.fn(() => ({ status: cold ? 'scaled-to-zero' : 'ready' }) as never),
    wake: vi.fn(),
    acquire: vi.fn(async () => {
      if (cold) throw Object.assign(new (await import('../../../src/deployments/controller')).DeploymentError(503, 'starting', 30));
      return lease as never;
    }),
  };
}

/** Fake Base replica: serves its catalog and streams wav for /v1/audio/speech. */
function replica(opts: { catalog?: boolean; speechStack?: boolean } = {}) {
  const speechBodies: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn<FetchImpl>(async (url, init) => {
    if (url.endsWith('/refs/voices.json')) {
      return opts.catalog === false || opts.speechStack ? new Response('not found', { status: 404 }) : Response.json(CATALOG);
    }
    if (url.endsWith('/v1/voices')) {
      return opts.speechStack ? Response.json({ voices: SPEECH_STACK_VOICES }) : new Response('not found', { status: 404 });
    }
    speechBodies.push(JSON.parse(String(init?.body)));
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array([82, 73, 70, 70])); c.enqueue(new Uint8Array([1, 2, 3])); c.close(); },
    });
    return new Response(stream, { headers: { 'content-type': 'audio/wav' } });
  });
  return { fetchImpl, speechBodies };
}

const req = (body: Record<string, unknown>): ProxyRequest => ({ method: 'POST', url: '/v1/audio/speech', headers: {}, rawBody: Buffer.alloc(0), body });

function kokoro(): TTSProvider & { synthesize: ReturnType<typeof vi.fn> } {
  return { providerId: 'openrouter', isConfigured: () => true, getModels: () => [], getVoices: () => [], synthesizeStream: vi.fn(),
    synthesize: vi.fn(async () => ({ audio: Buffer.from([7]), contentType: 'audio/mpeg' })) };
}

function chain(dep: TTSProvider, or: TTSProvider): Record<string, Array<RouteTarget<TTSProvider>>> {
  return { 'parle-tts': [
    { providerId: 'deployment:parle-qwen-tts', provider: dep, model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base' },
    { providerId: 'openrouter', provider: or, model: 'hexgrad/kokoro-82m', voice: 'pf_dora' },
  ] };
}

describe('TTS on a Qwen3-TTS Base deployment', () => {
  it('a cast voice id becomes task_type Base + ref_audio + ref_text from the replica catalog, and the stream reaches the client', async () => {
    const r = replica();
    const dep = new DeploymentTTSProvider(controller(), 'parle-qwen-tts', { fetchImpl: r.fetchImpl as never });
    const or = kokoro();
    const res = await handleAudioSpeech(req({ model: 'parle-tts', input: 'Bom dia', voice: 'br-f-01', fallback_voice: 'pm_alex', response_format: 'wav' }),
      chain(dep, or), undefined, new CircuitBreakerRegistry());
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({ 'Content-Type': 'audio/wav', 'X-Gateway-Provider': 'deployment:parle-qwen-tts' });
    expect(res.stream).toBeDefined();
    expect(new Uint8Array(await new Response(res.stream).arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70, 1, 2, 3]));
    expect(r.speechBodies[0]).toMatchObject({
      model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', input: 'Bom dia', task_type: 'Base', language: 'Portuguese',
      ref_audio: 'http://replica/refs/br-f-01.wav', ref_text: 'Olá, eu sou a Ana.', stream: true, stream_format: 'audio',
    });
    // `voice` next to ref_audio is read by vLLM-Omni as a precomputed speaker (and kills its engine): never sent.
    expect(r.speechBodies[0]).not.toHaveProperty('voice');
    expect(or.synthesize).not.toHaveBeenCalled();
  });

  it('client extras (ref_audio, ref_text, task_type, language, stream_format, x_vector_only_mode, non_streaming_mode) are forwarded intact, extra_params only as in-range sampling knobs; unknown ones are dropped', async () => {
    const r = replica();
    const dep = new DeploymentTTSProvider(controller(), 'parle-qwen-tts', { fetchImpl: r.fetchImpl as never });
    await handleAudioSpeech(req({
      model: 'parle-tts', input: 'Salut', voice: 'custom', response_format: 'wav',
      task_type: 'Base', ref_audio: 'data:audio/wav;base64,UklGRg==', ref_text: 'Bonjour.', language: 'fr', stream_format: 'audio', x_vector_only_mode: true, x_custom: 1,
      non_streaming_mode: true, extra_params: { temperature: 1, top_p: 0.95, top_k: 50.5, seed: 3, repetition_penalty: 9 },
    }), chain(dep, kokoro()), undefined, new CircuitBreakerRegistry());
    expect(r.speechBodies[0]).toMatchObject({
      task_type: 'Base', ref_audio: 'data:audio/wav;base64,UklGRg==', ref_text: 'Bonjour.', language: 'French', stream_format: 'audio', x_vector_only_mode: true,
      non_streaming_mode: true,
    });
    expect(r.speechBodies[0]!.extra_params).toEqual({ temperature: 1, top_p: 0.95 });
    expect(r.speechBodies[0]).not.toHaveProperty('x_custom');
    expect(r.speechBodies[0]).not.toHaveProperty('voice');
    // An explicit ref_audio skips the catalog lookup.
    expect(r.fetchImpl.mock.calls.some(([u]) => String(u).endsWith('/refs/voices.json'))).toBe(false);
  });

  it('a cloning request carries the engine cap max_new_tokens = (3 s + 0.2 s per character) at 12.5 frames/s, unless the client set one', async () => {
    const r = replica();
    const dep = new DeploymentTTSProvider(controller(), 'parle-qwen-tts', { fetchImpl: r.fetchImpl as never });
    await handleAudioSpeech(req({ model: 'parle-tts', input: 'Bom dia!', voice: 'br-f-01', response_format: 'wav' }), chain(dep, kokoro()), undefined, new CircuitBreakerRegistry());
    await handleAudioSpeech(req({ model: 'parle-tts', input: 'a'.repeat(160), voice: 'x', ref_audio: 'data:audio/wav;base64,UklGRg==', ref_text: 'a' }),
      chain(dep, kokoro()), undefined, new CircuitBreakerRegistry());
    await handleAudioSpeech(req({ model: 'parle-tts', input: 'Bom dia!', voice: 'br-f-01', max_new_tokens: 20 }), chain(dep, kokoro()), undefined, new CircuitBreakerRegistry());
    expect(r.speechBodies.map(b => b.max_new_tokens)).toEqual([58, 438, 20]);
  });

  it('a speech-stack replica (parle-speech) clones from its /v1/voices list, the reference on its own refs server', async () => {
    const r = replica({ speechStack: true });
    const dep = new DeploymentTTSProvider(controller(), 'parle-speech', { fetchImpl: r.fetchImpl as never });
    const res = await handleAudioSpeech(req({ model: 'parle-tts', input: 'Bom dia!', voice: 'br-f-03', response_format: 'wav' }),
      chain(dep, kokoro()), undefined, new CircuitBreakerRegistry());
    expect(res.status).toBe(200);
    expect(r.speechBodies[0]).toMatchObject({
      model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', task_type: 'Base', language: 'Portuguese',
      ref_audio: 'http://127.0.0.1:8000/refs/br-f-03.wav', ref_text: 'Porque há muitas semelhanças Entre as crianças e as flores.',
    });
    expect(r.speechBodies[0]).not.toHaveProperty('voice');
    const missing = await handleAudioSpeech(req({ model: 'parle-tts', input: 'Oi', voice: 'pt-PT-1baab6', fallback_voice: 'pf_dora' }),
      chain(dep, kokoro()), undefined, new CircuitBreakerRegistry());
    expect(missing.headers).toMatchObject({ 'X-Gateway-Fallback': 'voice_not_found' });
    expect(r.speechBodies).toHaveLength(1);
  });

  it('kokoro on a speech-stack replica (babelcast-tts-kokoro): the Kokoro voice is sent as is, no clone lookup; cold → cloud Kokoro, same voice', async () => {
    const r = replica({ speechStack: true });
    const dep = new DeploymentTTSProvider(controller(), 'babelcast-speech', { fetchImpl: r.fetchImpl as never });
    const or = kokoro();
    const kokoroChain = (d: TTSProvider) => ({ 'babelcast-tts-kokoro': [
      { providerId: 'deployment:babelcast-speech', provider: d, model: 'kokoro' },
      { providerId: 'openrouter', provider: or, model: 'hexgrad/kokoro-82m' },
    ] });
    const body = { model: 'babelcast-tts-kokoro', input: 'Bom dia!', voice: 'pf_dora', language: 'pt', response_format: 'pcm', stream: true };
    const res = await handleAudioSpeech(req(body), kokoroChain(dep), undefined, new CircuitBreakerRegistry());
    expect(res.headers).toMatchObject({ 'X-Gateway-Provider': 'deployment:babelcast-speech' });
    expect(r.speechBodies[0]).toMatchObject({ model: 'kokoro', input: 'Bom dia!', voice: 'pf_dora', language: 'Portuguese', response_format: 'pcm', stream: true });
    expect(r.speechBodies[0]).not.toHaveProperty('ref_audio');
    expect(r.fetchImpl.mock.calls.some(([u]) => String(u).endsWith('/v1/voices'))).toBe(false);
    expect(or.synthesize).not.toHaveBeenCalled();

    const cold = await handleAudioSpeech(req(body), kokoroChain(new DeploymentTTSProvider(controller(true), 'babelcast-speech')),
      undefined, new CircuitBreakerRegistry());
    expect(cold.headers).toMatchObject({ 'X-Gateway-Provider': 'openrouter:hexgrad/kokoro-82m', 'X-Gateway-Fallback': 'cold' });
    expect(or.synthesize.mock.calls[0][0]).toMatchObject({ model: 'hexgrad/kokoro-82m', voice: 'pf_dora' });
  });

  it('pocket on a speech-stack replica (babelcast-tts-pocket): the language own Pocket voice, no clone lookup; mp3 or an unknown language moves on', async () => {
    const r = replica({ speechStack: true });
    const dep = new DeploymentTTSProvider(controller(), 'babelcast-gpu', { fetchImpl: r.fetchImpl as never });
    const or = kokoro();
    const pocketChain = (d: TTSProvider) => ({ 'babelcast-tts-pocket': [
      { providerId: 'deployment:babelcast-gpu', provider: d, model: 'pocket' },
      { providerId: 'openrouter', provider: or, model: 'hexgrad/kokoro-82m', voice: 'pf_dora' },
    ] });
    const body = { model: 'babelcast-tts-pocket', input: 'Bom dia!', voice: 'Ryan', language: 'Portuguese', response_format: 'wav', stream: true };
    const res = await handleAudioSpeech(req(body), pocketChain(dep), undefined, new CircuitBreakerRegistry());
    expect(res.headers).toMatchObject({ 'X-Gateway-Provider': 'deployment:babelcast-gpu' });
    expect(r.speechBodies[0]).toEqual({ model: 'pocket', input: 'Bom dia!', voice: 'rafael', language: 'pt', response_format: 'wav', stream: true, stream_format: 'audio' });
    expect(r.fetchImpl.mock.calls.some(([u]) => String(u).endsWith('/v1/voices'))).toBe(false);
    await handleAudioSpeech(req({ ...body, voice: 'Vivian', language: 'fr', stream: false }), pocketChain(dep), undefined, new CircuitBreakerRegistry());
    expect(r.speechBodies[1]).toMatchObject({ voice: 'estelle', language: 'fr' });
    expect(or.synthesize).not.toHaveBeenCalled();

    const mp3 = await handleAudioSpeech(req({ ...body, response_format: 'mp3', stream: false }), pocketChain(dep), undefined, new CircuitBreakerRegistry());
    expect(mp3.headers).toMatchObject({ 'X-Gateway-Provider': 'openrouter:hexgrad/kokoro-82m' });
    const ja = await handleAudioSpeech(req({ ...body, language: 'Japanese', stream: false }), pocketChain(dep), undefined, new CircuitBreakerRegistry());
    expect(ja.headers).toMatchObject({ 'X-Gateway-Provider': 'openrouter:hexgrad/kokoro-82m' });
    expect(r.speechBodies).toHaveLength(2);
  });

  it('a CustomVoice replica without catalog gets the request as sent (OpenAI shape), mp3 not in stream mode', async () => {
    const r = replica({ catalog: false });
    const dep = new DeploymentTTSProvider(controller(), 'qwen3-tts', { fetchImpl: r.fetchImpl as never });
    const res = await handleAudioSpeech(req({ model: 'qwen-cv', input: 'Hi', voice: 'vivian', response_format: 'mp3' }),
      { 'qwen-cv': [{ providerId: 'deployment:qwen3-tts', provider: dep, model: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice' }] },
      undefined, new CircuitBreakerRegistry());
    expect(res.status).toBe(200);
    expect(r.speechBodies[0]).toEqual({ model: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', input: 'Hi', voice: 'vivian', response_format: 'mp3' });
  });

  it('a Base deployment without catalog never gets voice-only: falls back with catalog_unavailable', async () => {
    const r = replica({ catalog: false });
    const dep = new DeploymentTTSProvider(controller(), 'parle-qwen-tts', { fetchImpl: r.fetchImpl as never });
    const or = kokoro();
    const res = await handleAudioSpeech(req({ model: 'parle-tts', input: 'Hi', voice: 'br-f-01', fallback_voice: 'pf_dora' }),
      chain(dep, or), undefined, new CircuitBreakerRegistry());
    expect(r.speechBodies).toHaveLength(0);
    expect(res.headers).toMatchObject({ 'X-Gateway-Provider': 'openrouter:hexgrad/kokoro-82m', 'X-Gateway-Fallback': 'catalog_unavailable' });
  });

  it('cold deployment: the OpenRouter fallback speaks with fallback_voice and never sees the Qwen extras', async () => {
    const dep = new DeploymentTTSProvider(controller(true), 'parle-qwen-tts');
    const or = kokoro();
    const res = await handleAudioSpeech(req({ model: 'parle-tts', input: 'Bom dia', voice: 'br-f-01', fallback_voice: 'pm_alex', ref_text: 'x' }),
      chain(dep, or), undefined, new CircuitBreakerRegistry());
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({ 'X-Gateway-Provider': 'openrouter:hexgrad/kokoro-82m', 'X-Gateway-Fallback': 'cold' });
    const sent = or.synthesize.mock.calls[0][0];
    expect(sent).toMatchObject({ model: 'hexgrad/kokoro-82m', voice: 'pm_alex' });
    expect(sent.extra).toBeUndefined();
  });

  it('cold deployment: MAI flash speaks with fallback_voice; Kokoro (last) keeps its own voice when MAI fails', async () => {
    const dep = new DeploymentTTSProvider(controller(true), 'parle-qwen-tts');
    const last = kokoro();
    const maiChain = (m: TTSProvider) => ({ 'parle-tts': [
      { providerId: 'deployment:parle-qwen-tts', provider: dep, model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base' },
      { providerId: 'openrouter:mai', provider: m, model: 'microsoft/mai-voice-2.1-flash', voice: 'pt-BR-Luana:MAI-Voice-2-Flash' },
      { providerId: 'openrouter', provider: last, model: 'hexgrad/kokoro-82m', voice: 'pf_dora', fixedVoice: true },
    ] });
    const body = { model: 'parle-tts', input: 'Bom dia', voice: 'br-m-08', fallback_voice: 'pt-BR-Caio:MAI-Voice-2-Flash' };
    const mai = kokoro();
    const res = await handleAudioSpeech(req(body), maiChain(mai), undefined, new CircuitBreakerRegistry());
    expect(res.headers).toMatchObject({ 'X-Gateway-Provider': 'openrouter:mai:microsoft/mai-voice-2.1-flash' });
    expect(mai.synthesize.mock.calls[0][0]).toMatchObject({ model: 'microsoft/mai-voice-2.1-flash', voice: 'pt-BR-Caio:MAI-Voice-2-Flash' });

    const down = kokoro();
    down.synthesize.mockRejectedValue(Object.assign(new Error('upstream 503'), { status: 503 }));
    const res2 = await handleAudioSpeech(req(body), maiChain(down), undefined, new CircuitBreakerRegistry());
    expect(res2.status).toBe(200);
    expect(res2.headers).toMatchObject({ 'X-Gateway-Provider': 'openrouter:hexgrad/kokoro-82m' });
    expect(last.synthesize.mock.calls.at(-1)?.[0]).toMatchObject({ model: 'hexgrad/kokoro-82m', voice: 'pf_dora' });
  });

  it('a voice missing from a Base catalog is never sent to the replica (it kills vLLM-Omni) → fallback', async () => {
    const r = replica();
    const dep = new DeploymentTTSProvider(controller(), 'parle-qwen-tts', { fetchImpl: r.fetchImpl as never });
    const or = kokoro();
    const res = await handleAudioSpeech(req({ model: 'parle-tts', input: 'x', voice: 'unknown-voice', fallback_voice: 'pf_dora' }),
      chain(dep, or), undefined, new CircuitBreakerRegistry());
    expect(r.speechBodies).toHaveLength(0);
    expect(res.headers).toMatchObject({ 'X-Gateway-Provider': 'openrouter:hexgrad/kokoro-82m', 'X-Gateway-Fallback': 'voice_not_found' });
    expect(JSON.stringify(res.headers)).not.toContain('replica');
  });

  it('a JSON answer from the replica (error / SSE) is not audio → fallback', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async (url) => (String(url).endsWith('/refs/voices.json')
      ? Response.json(CATALOG) : Response.json({ error: 'task_type required' })));
    const dep = new DeploymentTTSProvider(controller(), 'parle-qwen-tts', { fetchImpl: fetchImpl as never });
    const or = kokoro();
    const res = await handleAudioSpeech(req({ model: 'parle-tts', input: 'x', voice: 'br-f-01' }), chain(dep, or), undefined, new CircuitBreakerRegistry());
    expect(res.headers?.['X-Gateway-Provider']).toBe('openrouter:hexgrad/kokoro-82m');
  });
});
