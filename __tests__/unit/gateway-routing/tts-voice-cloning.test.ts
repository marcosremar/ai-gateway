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
function replica(opts: { catalog?: boolean } = {}) {
  const speechBodies: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn<FetchImpl>(async (url, init) => {
    if (url.endsWith('/refs/voices.json')) {
      return opts.catalog === false ? new Response('not found', { status: 404 }) : Response.json(CATALOG);
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

  it('client extras (ref_audio, ref_text, task_type, language, stream_format) are forwarded intact', async () => {
    const r = replica();
    const dep = new DeploymentTTSProvider(controller(), 'parle-qwen-tts', { fetchImpl: r.fetchImpl as never });
    await handleAudioSpeech(req({
      model: 'parle-tts', input: 'Salut', voice: 'custom', response_format: 'wav',
      task_type: 'Base', ref_audio: 'data:audio/wav;base64,UklGRg==', ref_text: 'Bonjour.', language: 'fr', stream_format: 'audio', x_custom: 1,
    }), chain(dep, kokoro()), undefined, new CircuitBreakerRegistry());
    expect(r.speechBodies[0]).toMatchObject({
      task_type: 'Base', ref_audio: 'data:audio/wav;base64,UklGRg==', ref_text: 'Bonjour.', language: 'French', stream_format: 'audio', x_custom: 1,
    });
    expect(r.speechBodies[0]).not.toHaveProperty('voice');
    // An explicit ref_audio skips the catalog lookup.
    expect(r.fetchImpl.mock.calls.some(([u]) => String(u).endsWith('/refs/voices.json'))).toBe(false);
  });

  it('a replica without catalog gets the request as sent (OpenAI / CustomVoice shape); mp3 is not streamed', async () => {
    const r = replica({ catalog: false });
    const dep = new DeploymentTTSProvider(controller(), 'qwen3-tts', { fetchImpl: r.fetchImpl as never });
    const res = await handleAudioSpeech(req({ model: 'parle-tts', input: 'Hi', voice: 'vivian', response_format: 'mp3' }),
      chain(dep, kokoro()), undefined, new CircuitBreakerRegistry());
    expect(res.status).toBe(200);
    expect(res.stream).toBeUndefined();
    expect(r.speechBodies[0]).toEqual({ model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', input: 'Hi', voice: 'vivian', response_format: 'mp3' });
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
