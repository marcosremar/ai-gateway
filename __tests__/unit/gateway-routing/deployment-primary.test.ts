/**
 * The gateway routes: self-hosted deployment first, OpenRouter as the fallback of each stage.
 * Deployment replicas and OpenRouter are fakes (fake controller + fake fetch); nothing leaves the process.
 */
import { describe, expect, it, vi } from 'vitest';
import { DeploymentError } from '../../../src/deployments/controller';
import { DeploymentLLMProvider, DeploymentSTTProvider, DeploymentTTSProvider } from '../../../src/deployments/inference-providers';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { CooldownTracker } from '../../../src/gateway/providers/cloud/fallback';
import { handleChatCompletions } from '../../../src/gateway/proxy/routes/chat-completions';
import { handleAudioSpeech } from '../../../src/gateway/proxy/routes/audio-speech';
import { handleAudioTranscriptions, _resetSttCache } from '../../../src/gateway/proxy/routes/audio-transcriptions';
import type { ProxyRequest, RouteTarget } from '../../../src/gateway/proxy/types';
import type { LLMProvider, STTProvider, TTSProvider } from '../../../src/gateway/providers/cloud/types';

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

function fakeController(opts: { cold?: boolean; exists?: boolean } = {}) {
  const lease = { machine: { id: 'm1', ip: '10.0.0.9:8000' }, token: 'replica-token', done: vi.fn() };
  return {
    lease,
    get: vi.fn(() => (opts.exists === false ? null : ({} as never))),
    wake: vi.fn(),
    acquire: vi.fn(async () => {
      if (opts.cold) throw new DeploymentError(503, "deployment 'parle-speech': replicas are starting", 30);
      return lease as never;
    }),
  };
}

const delta = (content: string) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const STREAM_END = [
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
  '[DONE]',
];

function sseReplica(events: unknown[], gapMs = 0, end: unknown[] | 'cut' = STREAM_END): Response {
  const enc = new TextEncoder();
  const queue = [...events, ...(end === 'cut' ? [] : end)];
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (queue.length === 0) return end === 'cut' ? controller.error(new TypeError('terminated')) : controller.close();
      if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
      const event = queue.shift();
      controller.enqueue(enc.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`));
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

function cloudLLM(impl: () => Promise<{ content: string; model: string }>, configured = true): LLMProvider & { chat: ReturnType<typeof vi.fn> } {
  return { providerId: 'openrouter', isConfigured: () => configured, chat: vi.fn(impl) };
}

const chatReq = (model: string, extra: Record<string, unknown> = {}): ProxyRequest => ({
  method: 'POST', url: '/v1/chat/completions', headers: {}, rawBody: Buffer.alloc(0),
  body: { model, messages: [{ role: 'user', content: 'oi' }], ...extra },
});

function chatChain(dep: LLMProvider, or: LLMProvider): Record<string, Array<RouteTarget<LLMProvider>>> {
  return {
    'parle-llm': [
      { providerId: 'deployment:parle-speech', provider: dep, model: 'qwen3.5-9b' },
      { providerId: 'openrouter', provider: or, model: 'qwen/qwen3.5-9b' },
    ],
  };
}

async function chat(dep: LLMProvider, or: LLMProvider, extra: Record<string, unknown> = {}, breakers = new CircuitBreakerRegistry()) {
  return handleChatCompletions(chatReq('parle-llm', extra), {}, undefined, undefined, undefined, undefined, undefined,
    { chatRoutes: chatChain(dep, or), circuitBreakers: breakers, cooldownTracker: new CooldownTracker() });
}

describe('chat: deployment primary, OpenRouter fallback', () => {
  it('uses the deployment when its replica answers', async () => {
    const ctl = fakeController();
    const fetchImpl = vi.fn<FetchImpl>(async () => Response.json({ model: 'qwen3.5-9b', choices: [{ message: { content: 'olá' } }] }));
    const or = cloudLLM(async () => ({ content: 'never', model: 'x' }));
    const res = await chat(new DeploymentLLMProvider(ctl, 'parle-speech', { fetchImpl: fetchImpl as never }), or);
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Gateway-Provider']).toBe('deployment:parle-speech');
    expect(res.headers?.['X-Gateway-Fallback']).toBeUndefined();
    expect(fetchImpl.mock.calls[0][0]).toBe('http://10.0.0.9:8000/v1/chat/completions');
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>)['X-Aigw-Token']).toBe('replica-token');
    expect(or.chat).not.toHaveBeenCalled();
  });

  it('cold deployment (503): wakes it and answers from OpenRouter in the same call, without retrying it', async () => {
    const ctl = fakeController({ cold: true });
    const or = cloudLLM(async () => ({ content: 'from openrouter', model: 'qwen/qwen3.5-9b' }));
    const res = await chat(new DeploymentLLMProvider(ctl, 'parle-speech'), or);
    expect(res.status).toBe(200);
    expect(ctl.acquire).toHaveBeenCalledTimes(1);
    expect(ctl.acquire.mock.calls[0][1]).toEqual({ waitMs: 0, stage: 'chat' });
    expect(ctl.wake).toHaveBeenCalledWith('parle-speech');
    expect(or.chat).toHaveBeenCalledWith(expect.objectContaining({ model: 'qwen/qwen3.5-9b' }));
    expect(res.headers).toMatchObject({
      'X-Gateway-Provider': 'openrouter:qwen/qwen3.5-9b',
      'X-Gateway-Fallback': 'cold',
      'X-Gateway-Fallback-From': 'deployment:parle-speech',
    });
  });

  it('replica 5xx → OpenRouter, reason 5xx', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => new Response('boom', { status: 500 }));
    const or = cloudLLM(async () => ({ content: 'ok', model: 'm' }));
    const res = await chat(new DeploymentLLMProvider(fakeController(), 'parle-speech', { fetchImpl: fetchImpl as never }), or);
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Gateway-Fallback']).toBe('5xx');
  });

  it('replica timeout / dropped connection → OpenRouter', async () => {
    for (const [error, code] of [[Object.assign(new Error('t'), { name: 'TimeoutError' }), 'timeout'], [new TypeError('fetch failed'), 'unreachable']] as const) {
      const ctl = fakeController();
      const fetchImpl = vi.fn<FetchImpl>(async () => { throw error; });
      const or = cloudLLM(async () => ({ content: 'ok', model: 'm' }));
      const res = await chat(new DeploymentLLMProvider(ctl, 'parle-speech', { fetchImpl: fetchImpl as never }), or);
      expect(res.status).toBe(200);
      expect(res.headers?.['X-Gateway-Fallback']).toBe(code);
      // A timeout is a busy replica, not a broken one (QA 2026-10-07); only the dropped connection is a strike.
      expect(ctl.lease.done).toHaveBeenCalledWith(code === 'timeout' ? 'timeout' : true);
    }
  });

  it('OpenRouter without key → 503 provider_unavailable naming OPENROUTER_API_KEY', async () => {
    const res = await chat(new DeploymentLLMProvider(fakeController({ cold: true }), 'parle-speech'), cloudLLM(async () => ({ content: '', model: '' }), false));
    expect(res.status).toBe(503);
    const err = (res.body as { error: { type: string; message: string } }).error;
    expect(err.type).toBe('provider_unavailable');
    expect(err.message).toContain('OPENROUTER_API_KEY is not set');
    expect(err.message).toContain('deployment:parle-speech failed (HTTP 503)');
  });

  it('OpenRouter 401 after a cold deployment → 503 naming both', async () => {
    const or = cloudLLM(async () => { throw Object.assign(new Error('No auth credentials found'), { status: 401 }); });
    const res = await chat(new DeploymentLLMProvider(fakeController({ cold: true }), 'parle-speech'), or);
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain('openrouter failed (HTTP 401)');
  });

  it('streaming: a cold deployment falls back before the first token and the headers say so', async () => {
    const or: LLMProvider = {
      providerId: 'openrouter', isConfigured: () => true, chat: vi.fn(),
      async *chatStream() { yield 'olá'; yield ' mundo'; },
    };
    const res = await chat(new DeploymentLLMProvider(fakeController({ cold: true }), 'parle-speech'), or, { stream: true });
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Gateway-Fallback']).toBe('cold');
    const text = await new Response(res.stream).text();
    expect(text).toContain('olá');
    expect(text).toContain('[DONE]');
  });

  it('streaming: the deployment answers token by token, each delta relayed when it arrives', async () => {
    const ctl = fakeController();
    const fetchImpl = vi.fn<FetchImpl>(async () => sseReplica(['Bom ', 'dia! ', 'Tudo ', 'bem?'].map(delta), 30));
    const or = cloudLLM(async () => ({ content: 'never', model: 'x' }));
    const t0 = Date.now();
    const res = await chat(new DeploymentLLMProvider(ctl, 'parle-speech', { fetchImpl: fetchImpl as never }), or,
      { stream: true, stream_options: { include_usage: true } });
    expect(res.headers?.['X-Gateway-Provider']).toBe('deployment:parle-speech');
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toMatchObject({ stream: true, model: 'qwen3.5-9b' });
    const arrivals: Array<{ at: number; text: string }> = [];
    const reader = res.stream!.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arrivals.push({ at: Date.now() - t0, text: new TextDecoder().decode(value) });
    }
    const content = arrivals.filter((a) => /"content":"[^"]/.test(a.text));
    expect(content.map((a) => JSON.parse(a.text.slice(6)).choices[0].delta.content)).toEqual(['Bom ', 'dia! ', 'Tudo ', 'bem?']);
    expect(content[3].at - content[0].at).toBeGreaterThanOrEqual(60);
    expect(content[0].at).toBeLessThan(arrivals[arrivals.length - 1].at - 60);
    const text = arrivals.map((a) => a.text).join('');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(ctl.lease.done).toHaveBeenCalledTimes(1);
    expect(ctl.lease.done).toHaveBeenCalledWith(false);
    expect(or.chat).not.toHaveBeenCalled();
  });

  const streamingOpenRouter = (): LLMProvider => ({
    providerId: 'openrouter', isConfigured: () => true, chat: vi.fn(),
    async *chatStream() { yield 'da nuvem'; },
  });
  const stalled = { error: { message: "chat upstream stalled: TimeoutError('no data for 8.0 s')", type: 'upstream_error', code: 'upstream_stalled' } };

  it('streaming: an SSE error event before the first token fails the deployment, OpenRouter answers, the stage gets a strike', async () => {
    const ctl = fakeController();
    const fetchImpl = vi.fn<FetchImpl>(async () => sseReplica([stalled], 0, []));
    const res = await chat(new DeploymentLLMProvider(ctl, 'parle-speech', { fetchImpl: fetchImpl as never }), streamingOpenRouter(), { stream: true });
    expect(res.headers).toMatchObject({
      'X-Gateway-Provider': 'openrouter:qwen/qwen3.5-9b', 'X-Gateway-Fallback': 'error', 'X-Gateway-Fallback-From': 'deployment:parle-speech',
    });
    const text = await new Response(res.stream).text();
    expect(text).toContain('da nuvem');
    expect(text).not.toContain('upstream stalled');
    expect(ctl.acquire.mock.calls[0][1]).toMatchObject({ stage: 'chat' });
    expect(ctl.lease.done).toHaveBeenCalledTimes(1);
    expect(ctl.lease.done).toHaveBeenCalledWith('errored');
  });

  it('streaming: an SSE error event after the first token ends the answer as an error, never as content, and counts against the replica', async () => {
    const ctl = fakeController();
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    const fetchImpl = vi.fn<FetchImpl>(async () => sseReplica([delta('Bom '), stalled], 0, []));
    const dep = new DeploymentLLMProvider(ctl, 'parle-speech', { fetchImpl: fetchImpl as never });
    const res = await chat(dep, streamingOpenRouter(), { stream: true }, breakers);
    expect(res.headers?.['X-Gateway-Provider']).toBe('deployment:parle-speech');
    const events = (await new Response(res.stream).text()).trim().split('\n\n').map((e) => JSON.parse(e.slice(6)));
    expect(events.map((e) => e.choices?.[0]?.delta?.content).filter(Boolean)).toEqual(['Bom ']);
    expect(events[events.length - 1]).toEqual({ error: { message: expect.stringContaining('upstream stalled'), type: 'server_error' } });
    expect(ctl.lease.done).toHaveBeenCalledTimes(1);
    expect(ctl.lease.done).toHaveBeenCalledWith('errored');
    const next = await chat(dep, streamingOpenRouter(), { stream: true }, breakers);
    expect(next.headers?.['X-Gateway-Fallback']).toBe('circuit_open');
  });

  it('streaming: a replica body cut mid-answer ends with an error event and a failed lease', async () => {
    const ctl = fakeController();
    const fetchImpl = vi.fn<FetchImpl>(async () => sseReplica([delta('Bom ')], 0, 'cut'));
    const res = await chat(new DeploymentLLMProvider(ctl, 'parle-speech', { fetchImpl: fetchImpl as never }), streamingOpenRouter(), { stream: true });
    const text = await new Response(res.stream).text();
    expect(text).toContain('"content":"Bom "');
    expect(text).toContain('"error"');
    expect(text).not.toContain('[DONE]');
    expect(ctl.lease.done).toHaveBeenCalledTimes(1);
    expect(ctl.lease.done).toHaveBeenCalledWith(true);
  });

  it('deployment circuit opens after repeated failures and the next requests go straight to OpenRouter', async () => {
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeoutMs: 60_000 });
    const fetchImpl = vi.fn<FetchImpl>(async () => new Response('down', { status: 502 }));
    const dep = new DeploymentLLMProvider(fakeController(), 'parle-speech', { fetchImpl: fetchImpl as never });
    const or = cloudLLM(async () => ({ content: 'ok', model: 'm' }));
    for (let i = 0; i < 2; i++) await chat(dep, or, {}, breakers);
    const calls = fetchImpl.mock.calls.length;
    const res = await chat(dep, or, {}, breakers);
    expect(fetchImpl.mock.calls.length).toBe(calls);
    expect(res.headers?.['X-Gateway-Fallback']).toBe('circuit_open');
  });
});

describe('STT and TTS: deployment primary, OpenRouter fallback', () => {
  const cloudTTS = (impl: () => Promise<{ audio: Buffer; contentType: string }>): TTSProvider & { synthesize: ReturnType<typeof vi.fn> } => ({
    providerId: 'openrouter', isConfigured: () => true, getModels: () => [], getVoices: () => [], synthesizeStream: vi.fn(), synthesize: vi.fn(impl),
  });

  it('TTS: deployment answers audio with its own content type', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/wav' } }));
    const dep = new DeploymentTTSProvider(fakeController(), 'parle-qwen-tts', { fetchImpl: fetchImpl as never });
    const res = await handleAudioSpeech(
      { method: 'POST', url: '/v1/audio/speech', headers: {}, rawBody: Buffer.alloc(0), body: { model: 'parle-tts', input: 'oi', voice: 'vivian' } },
      { 'parle-tts': [{ providerId: 'deployment:parle-qwen-tts', provider: dep, model: 'Qwen/Qwen3-TTS' }] },
      undefined, new CircuitBreakerRegistry(),
    );
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({ 'Content-Type': 'audio/wav', 'X-Gateway-Provider': 'deployment:parle-qwen-tts' });
    const speechCall = fetchImpl.mock.calls.find(([u]) => String(u).endsWith('/v1/audio/speech'))!;
    expect(JSON.parse(String(speechCall[1]?.body))).toMatchObject({ model: 'Qwen/Qwen3-TTS', voice: 'vivian' });
  });

  it('TTS: streamed PCM reaches the client chunk by chunk, as the replica produces it', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => {
      let sent = 0;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent++ === 4) return controller.close();
          await new Promise((resolve) => setTimeout(resolve, 30));
          controller.enqueue(new Uint8Array(480));
        },
      }), { headers: { 'content-type': 'audio/pcm' } });
    });
    const dep = new DeploymentTTSProvider(fakeController(), 'parle-qwen-tts', { fetchImpl: fetchImpl as never });
    const res = await handleAudioSpeech(
      { method: 'POST', url: '/v1/audio/speech', headers: {}, rawBody: Buffer.alloc(0),
        body: { model: 'parle-tts', input: 'oi', voice: 'x', response_format: 'pcm', ref_audio: 'data:audio/wav;base64,UklGRg==', ref_text: 't' } },
      { 'parle-tts': [{ providerId: 'deployment:parle-qwen-tts', provider: dep, model: 'Qwen/Qwen3-TTS' }] },
      undefined, new CircuitBreakerRegistry(),
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({ stream: true, stream_format: 'audio' });
    const arrivals: number[] = [];
    const reader = res.stream!.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      arrivals.push(Date.now());
    }
    expect(arrivals).toHaveLength(4);
    expect(arrivals[3] - arrivals[0]).toBeGreaterThanOrEqual(60);
  });

  it('TTS: cold deployment → OpenRouter with the fallback voice', async () => {
    const or = cloudTTS(async () => ({ audio: Buffer.from([9]), contentType: 'audio/mpeg' }));
    const res = await handleAudioSpeech(
      { method: 'POST', url: '/v1/audio/speech', headers: {}, rawBody: Buffer.alloc(0), body: { model: 'parle-tts', input: 'oi', voice: 'vivian', fallback_voice: 'pm_alex' } },
      { 'parle-tts': [
        { providerId: 'deployment:parle-qwen-tts', provider: new DeploymentTTSProvider(fakeController({ cold: true }), 'parle-qwen-tts') },
        { providerId: 'openrouter', provider: or, model: 'hexgrad/kokoro-82m', voice: 'pf_dora' },
      ] },
      undefined, new CircuitBreakerRegistry(),
    );
    expect(res.status).toBe(200);
    expect(or.synthesize).toHaveBeenCalledWith(expect.objectContaining({ model: 'hexgrad/kokoro-82m', voice: 'pm_alex' }));
    expect(res.headers).toMatchObject({ 'X-Gateway-Provider': 'openrouter:hexgrad/kokoro-82m', 'X-Gateway-Fallback': 'cold' });
  });

  it('STT: replica 5xx → OpenRouter transcribes', async () => {
    _resetSttCache();
    const fetchImpl = vi.fn<FetchImpl>(async () => new Response('err', { status: 503 }));
    const or: STTProvider = { providerId: 'openrouter', isConfigured: () => true, getModels: () => [], transcribe: vi.fn(async () => ({ text: 'bom dia' })) };
    const res = await handleAudioTranscriptions(
      { method: 'POST', url: '/v1/audio/transcriptions', headers: {}, rawBody: Buffer.from('RIFFxxxx'), body: { model: 'parle-stt' } },
      { 'parle-stt': [
        { providerId: 'deployment:parle-speech', provider: new DeploymentSTTProvider(fakeController(), 'parle-speech', { fetchImpl: fetchImpl as never }), model: 'whisper-large-v3-turbo' },
        { providerId: 'openrouter', provider: or, model: 'openai/whisper-large-v3-turbo' },
      ] },
      undefined, new CircuitBreakerRegistry(),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'bom dia' });
    expect(res.headers).toMatchObject({ 'X-Gateway-Provider': 'openrouter:openai/whisper-large-v3-turbo', 'X-Gateway-Fallback': '5xx' });
  });

  it('a deployment that does not exist is skipped as not configured', async () => {
    const dep = new DeploymentSTTProvider(fakeController({ exists: false }), 'nope');
    expect(dep.isConfigured()).toBe(false);
  });
});

describe('chat chain edges', () => {
  const ok = (providerId: string, content: string): LLMProvider => ({ providerId, isConfigured: () => true, chat: vi.fn(async () => ({ content, model: 'm' })) });

  it('the OpenRouter dynamic route also gets the generic fallback after it', async () => {
    const or: LLMProvider = { providerId: 'openrouter', isConfigured: () => true, chat: vi.fn(async () => { throw Object.assign(new Error('rate'), { status: 429 }); }) };
    const groq = ok('groq', 'from groq');
    const res = await handleChatCompletions(chatReq('mistralai/some-model'), {}, undefined, undefined,
      [{ providerId: 'groq', model: 'llama-3.3-70b-versatile', provider: groq }], undefined,
      [{ providerId: 'openrouter', provider: or, acceptsModel: (m) => m.includes('/') }],
      { circuitBreakers: new CircuitBreakerRegistry(), cooldownTracker: new CooldownTracker() });
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({ 'X-Gateway-Provider': 'groq:llama-3.3-70b-versatile', 'X-Gateway-Fallback': 'rate_limited' });
  });

  it('a known model with no configured provider answers 503 with the reasons, an unknown one 404', async () => {
    const unavailable = { 'llama-3.3-70b-versatile': ['groq: GROQ_API_KEY is not set'] };
    const known = await handleChatCompletions(chatReq('llama-3.3-70b-versatile'), {}, undefined, undefined, undefined, undefined, undefined, { unavailable });
    expect(known.status).toBe(503);
    expect(JSON.stringify(known.body)).toContain('GROQ_API_KEY is not set');
    const unknown = await handleChatCompletions(chatReq('gpt-4o'), {}, undefined, undefined, undefined, undefined, undefined, { unavailable });
    expect(unknown.status).toBe(404);
  });
});
