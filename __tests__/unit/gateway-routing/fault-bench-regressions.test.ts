/**
 * Regressions found by the fault bench (scripts/fault-bench, 2026-10-06): the real OpenAI-compat providers and the
 * proxy against a fake upstream that fails on purpose. Each block failed before its fix.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeUpstream, type FakeUpstream } from '../../../scripts/fault-bench/fake-upstream';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { OpenAICompatLLMProvider } from '../../../src/gateway/providers/cloud/openai-compat/openai-compat-llm';
import { clearClientCache } from '../../../src/gateway/providers/cloud/openai-compat/client-cache';
import type { ChatRequest, LLMProvider, STTProvider } from '../../../src/gateway/providers/cloud/types';
import { failureCode, runTargets } from '../../../src/gateway/proxy/provider-routing';
import { handleChatCompletions } from '../../../src/gateway/proxy/routes/chat-completions';
import { handleAudioTranscriptions, _resetSttCache } from '../../../src/gateway/proxy/routes/audio-transcriptions';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import type { ProxyRequest, RouteTarget } from '../../../src/gateway/proxy/types';
import { sseDeltas } from '../../../src/s2s/loopback-stages';
import { createS2SRoute } from '../../../src/s2s/route';
import { request as httpRequest } from 'node:http';

let fake: FakeUpstream;
const KEY_ENV = 'FAULT_BENCH_TEST_KEY';
const provider = () => new OpenAICompatLLMProvider({ providerId: 'openrouter', baseURL: `${fake.url}/or`, envKey: KEY_ENV });
const ask = (model: string, extra: Partial<ChatRequest> = {}): ChatRequest => ({ model, messages: [{ role: 'user', content: 'oi' }], ...extra });

beforeAll(async () => {
  process.env[KEY_ENV] = 'unit-test-provider-key';
  fake = await startFakeUpstream();
});
afterAll(async () => { await fake.close(); delete process.env[KEY_ENV]; });
beforeEach(() => { fake.reset(); clearClientCache(); });

async function drain(gen: AsyncGenerator<string, void, undefined>): Promise<string> {
  let out = '';
  for await (const d of gen) if (!d.startsWith('__usage__:')) out += d;
  return out;
}

describe('8/9) the gateway owns retries: one upstream call per attempt', () => {
  it('a 503 is not retried inside the OpenAI SDK (the chain moves on instead)', async () => {
    fake.setFaults({ m: { kind: 'status', status: 503 } });
    await expect(provider().chat(ask('m'))).rejects.toMatchObject({ status: 503 });
    expect(fake.log()).toHaveLength(1);
  });

  it('a 429 with retry-after 5 fails at once instead of sleeping 5 s on the same provider', async () => {
    fake.setFaults({ m: { kind: 'status', status: 429, headers: { 'retry-after': '5' } } });
    const t0 = Date.now();
    await expect(provider().chat(ask('m'))).rejects.toMatchObject({ status: 429 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(fake.log()).toHaveLength(1);
  });

  it('a streamed request is not retried either', async () => {
    fake.setFaults({ m: { kind: 'status', status: 502 } });
    await expect(drain(provider().chatStream!(ask('m')))).rejects.toMatchObject({ status: 502 });
    expect(fake.log()).toHaveLength(1);
  });
});

describe('5/6/7) a stream that ends without finish_reason is a failure, never a complete answer', () => {
  it('upstream ends cleanly after some deltas without finish_reason / [DONE] → throws', async () => {
    fake.setFaults({ m: { kind: 'end-mid', deltas: 3 } });
    await expect(drain(provider().chatStream!(ask('m')))).rejects.toThrow(/without finish_reason|truncated/i);
  });

  it('upstream silent longer than the provider timeout → throws a timeout (the SDK swallows its own abort)', async () => {
    fake.setFaults({ m: { kind: 'stall-mid', deltas: 2, silentMs: 1500 } });
    await expect(drain(provider().chatStream!(ask('m', { timeoutMs: 400 })))).rejects.toThrow(/timed out/i);
  });

  it('the provider timeout is an idle timeout: a slow but steady stream longer than it completes', async () => {
    fake.setFaults({ m: { kind: 'ok', chunkGapMs: 150, chunks: ['a ', 'b ', 'c ', 'd ', 'e ', 'f '] } });
    expect(await drain(provider().chatStream!(ask('m', { timeoutMs: 400 })))).toBe('a b c d e f ');
  });

  it('a normal stream still completes', async () => {
    expect(await drain(provider().chatStream!(ask('m')))).toBe('Olá, tudo bem com você?');
  });
});

describe('18) the client going away reaches the upstream call', () => {
  it('runTargets: an aborted request signal aborts the attempt and rejects', async () => {
    const seen: AbortSignal[] = [];
    const client = new AbortController();
    const p = runTargets<{ providerId: string }, string>(
      [{ providerId: 'p1', provider: { providerId: 'p1' } }],
      (_t, signal) => { seen.push(signal); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))); },
      { stage: 'test', breakers: new CircuitBreakerRegistry(), signal: client.signal },
    );
    setTimeout(() => client.abort(), 20);
    await expect(p).rejects.toThrow(/client/i);
    expect(seen[0].aborted).toBe(true);
  });

  it('streamed chat: cancelling the response aborts the upstream request while it waits for the next token', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const slow: LLMProvider = {
      providerId: 'openrouter', isConfigured: () => true,
      chat: vi.fn(),
      async *chatStream(req: ChatRequest) {
        upstreamSignal = req.signal;
        yield 'Olá';
        await new Promise<void>((resolve) => { req.signal?.addEventListener('abort', () => resolve()); setTimeout(resolve, 5000); });
        yield 'tarde demais';
      },
    };
    const req: ProxyRequest = { method: 'POST', url: '/v1/chat/completions', headers: {}, rawBody: Buffer.alloc(0),
      body: { model: 'm', stream: true, messages: [{ role: 'user', content: 'oi' }] } };
    const res = await handleChatCompletions(req, {}, undefined, undefined, undefined, undefined, undefined,
      { chatRoutes: { m: [{ providerId: 'openrouter', provider: slow, model: 'm' }] }, circuitBreakers: new CircuitBreakerRegistry() });
    const reader = res.stream!.getReader();
    await reader.read();
    await reader.read();
    const t0 = Date.now();
    await reader.cancel();
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true), { timeout: 1000 });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('proxy server: a client that disconnects aborts the non-streamed upstream call', async () => {
    let aborted = false;
    const waiting: LLMProvider = {
      providerId: 'openrouter', isConfigured: () => true,
      chat: (r: ChatRequest) => new Promise((_, reject) => {
        r.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
      }),
    };
    const server: Server = createProxyServer({ providers: { chatRoutes: { m: [{ providerId: 'openrouter', provider: waiting, model: 'm' }] } } as never });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal,
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'oi' }] }),
    }).catch(() => {});
    await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 1500 });
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('1) a provider that always breaks mid-stream opens its breaker', () => {
  it('three mid-answer errors in a row (threshold 2) → circuit open', async () => {
    const breaking: LLMProvider = {
      providerId: 'openrouter', isConfigured: () => true, chat: vi.fn(),
      async *chatStream() { yield 'Olá'; throw new Error('Provider disconnected unexpectedly'); },
    };
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 2 });
    for (let i = 0; i < 3; i++) {
      const req: ProxyRequest = { method: 'POST', url: '/v1/chat/completions', headers: {}, rawBody: Buffer.alloc(0),
        body: { model: 'm', stream: true, messages: [{ role: 'user', content: `oi ${i}` }] } };
      const res = await handleChatCompletions(req, {}, undefined, undefined, undefined, undefined, undefined,
        { chatRoutes: { m: [{ providerId: 'openrouter', provider: breaking, model: 'm' }] }, circuitBreakers: breakers });
      if (!res.stream) break;
      const text = await new Response(res.stream).text();
      expect(text).toContain('Provider disconnected');
      expect(text).not.toContain('[DONE]');
    }
    expect(breakers.get('openrouter').getStats().state).toBe('open');
  });
});

describe('18) s2s: the client going away aborts the composed turn', () => {
  it('a client that disconnects mid-turn aborts the stage calls', async () => {
    let stageSignal: AbortSignal | undefined;
    const stages = {
      transcribe: (_a: Uint8Array, _c: string, _cfg: unknown, signal: AbortSignal) => {
        stageSignal = signal;
        return new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      },
      chatStream: vi.fn(), speak: vi.fn(),
    };
    const route = createS2SRoute({ controller: null, stagesFor: () => stages as never });
    const server = createServer((req, res) => { void route(req, res); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), 'a.wav');
    form.set('config', '{}');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    await fetch(`http://127.0.0.1:${port}/v1/s2s`, { method: 'POST', body: form, signal: ac.signal }).catch(() => {});
    await vi.waitFor(() => expect(stageSignal?.aborted).toBe(true), { timeout: 1500 });
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('11) a moderation 403 says nothing about the provider health', () => {
  const moderation = () => Object.assign(new Error('403 Your chosen model requires moderation and your input was flagged'), {
    status: 403, error: { code: 403, message: 'flagged', metadata: { reasons: ['violence'], flagged_input: 'x' } },
  });

  it('is classified as `moderation`', () => {
    expect(failureCode(moderation())).toBe('moderation');
    expect(failureCode(Object.assign(new Error('403 forbidden'), { status: 403 }))).toBe('auth');
  });

  it('moves to the next target without counting toward the shared breaker', async () => {
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 2 });
    for (let i = 0; i < 4; i++) {
      const out = await runTargets<{ providerId: string }, string>(
        [{ providerId: 'openrouter', provider: { providerId: 'openrouter' }, model: 'a' }, { providerId: 'groq', provider: { providerId: 'groq' }, model: 'c' }],
        (t) => (t.model === 'a' ? Promise.reject(moderation()) : Promise.resolve('ok')),
        { stage: 'llm', breakers },
      );
      expect(out.result).toBe('ok');
      expect(out.codes.get([...out.codes.keys()][0])).toBe('moderation');
    }
    expect(breakers.get('openrouter').getStats().state).toBe('closed');
    expect(breakers.get('openrouter').getStats().failures).toBe(0);
  });
});

describe('23) the STT cache never keeps an empty transcription', () => {
  const sttReq = (audio: Buffer): ProxyRequest => ({ method: 'POST', url: '/v1/audio/transcriptions', headers: {}, rawBody: audio,
    body: { model: 't-stt', language: 'pt' } });
  const stt = (providerId: string, texts: string[]): STTProvider & { transcribe: ReturnType<typeof vi.fn> } => ({
    providerId, isConfigured: () => true, getModels: () => [],
    transcribe: vi.fn(async () => { const t = texts.length > 1 ? texts.shift()! : texts[0]; if (t === 'FAIL') throw Object.assign(new Error('503'), { status: 503 }); return { text: t }; }),
  }) as never;
  beforeEach(() => _resetSttCache());

  it('an empty transcription is not cached: the same audio is asked again', async () => {
    const p = stt('openrouter', ['', 'bom dia']);
    const routes = { 't-stt': [{ providerId: 'openrouter', provider: p, model: 'sa' }] as Array<RouteTarget<STTProvider>> };
    const audio = Buffer.from('RIFF-audio-1');
    await handleAudioTranscriptions(sttReq(audio), routes, undefined, new CircuitBreakerRegistry());
    const second = await handleAudioTranscriptions(sttReq(audio), routes, undefined, new CircuitBreakerRegistry());
    expect(second.headers?.['X-Cache']).toBe('MISS');
    expect(second.body).toEqual({ text: 'bom dia' });
  });
});

describe('1/6) s2s composed pipeline: an in-band error or a cut stream is not a finished answer', () => {
  const body = (s: string) => (async function* () { yield new TextEncoder().encode(s); })();
  const chunk = (c: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;

  it('an error event from the chat route throws', async () => {
    const it = sseDeltas(body(chunk('Olá') + `data: ${JSON.stringify({ error: { message: 'Provider disconnected', type: 'server_error' } })}\n\n`));
    const got: string[] = [];
    await expect((async () => { for await (const d of it) got.push(d); })()).rejects.toThrow(/Provider disconnected/);
    expect(got).toEqual(['Olá']);
  });

  it('a stream that ends without [DONE] throws', async () => {
    await expect((async () => { for await (const _ of sseDeltas(body(chunk('Olá')))) { /* drain */ } })()).rejects.toThrow(/\[DONE\]/);
  });

  it('a complete stream yields its deltas', async () => {
    const got: string[] = [];
    for await (const d of sseDeltas(body(chunk('Olá') + chunk(' você') + 'data: [DONE]\n\n'))) got.push(d);
    expect(got).toEqual(['Olá', ' você']);
  });
});

describe('21) body over the limit without Content-Length (chunked)', () => {
  it('answers 413, not a reset connection', async () => {
    const server: Server = createProxyServer({ providers: {} as never });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    /* `http.request`, não `fetch`: o servidor responde 413 e fecha enquanto o corpo ainda sobe, e o undici troca a
       resposta por `ECONNRESET` na escrita (corrida que dependia do tempo e falhou na CI). Aqui a resposta chega pelo
       evento `response`, e o erro de escrita depois dela é o esperado. */
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/audio/transcriptions',
        headers: { 'content-type': 'multipart/form-data; boundary=x', 'transfer-encoding': 'chunked' } });
      let answered = false;
      req.on('response', (r) => { answered = true; r.resume(); resolve(r.statusCode ?? 0); });
      req.on('error', (err) => { if (!answered) reject(err); });
      const mb = new Uint8Array(1 << 20);
      let sent = 0;
      const pump = () => {
        while (!answered && sent < 120) { sent++; if (!req.write(mb)) { req.once('drain', pump); return; } }
        if (!answered) req.end();
      };
      pump();
    });
    const res = { status };
    expect(res.status).toBe(413);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }, 30_000);
});
