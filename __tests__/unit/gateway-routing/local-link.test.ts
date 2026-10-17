import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServeProviders, equivalenceGroup, parseModelRoutes, type ServeInstances } from '../../../src/config/serve-providers';
import { withCloudFallback } from '../../../src/config/cloud-fallback';
import { stageChainsReport } from '../../../src/config/stage-chains';
import { AppError, AppRegistry, MemoryAppStore } from '../../../src/deployments/apps';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import {
  LOCAL_LINK_MAX_BYTES, localLinkFetch, localLinkId, localLinkProvider, localLinkRefusal, parseLinkBaseUrl,
} from '../../../src/gateway/providers/cloud/openai-compat/local-link';
import { localSpeechExtras } from '../../../src/gateway/providers/cloud/openai-compat/local-link';
import { WAV_HEADER_BYTES } from '../../../src/gateway/providers/cloud/openai-compat/openai-compat-tts';
import type { LLMProvider, STTProvider, TTSProvider, TTSRequest } from '../../../src/gateway/providers/cloud/types';
import { handleAudioSpeech } from '../../../src/gateway/proxy/routes/audio-speech';
import { breakerKey, failureCode, providerHeader, routeRequest, type RouteTarget } from '../../../src/gateway/proxy/provider-routing';
import { setGatewayTelemetrySink } from '../../../src/telemetry/emit';
import type { TelemetryEvent } from '../../../src/telemetry/contract';
import { fallbackLinks, probeLink, probeWav } from '../../../src/telemetry/fallback-probe';
import { services } from '../../../src/admin-page/guarantee';
import type { AdminSnapshot } from '../../../src/admin-page';
import { cheaperModelRules } from '../../../src/admin-page/savings-rules';

const RAILWAY = { RAILWAY_ENVIRONMENT: 'production' };
const p = (providerId: string) => ({ providerId, isConfigured: () => true }) as never;
const instances = (): ServeInstances => ({
  chat: { groq: p('groq'), openrouter: p('openrouter') },
  stt: { groq: p('groq'), openrouter: p('openrouter') },
  tts: { groq: p('groq'), openrouter: p('openrouter') },
});

interface Seen { path: string; auth: string | undefined; host: string | undefined; body: string }
const seen: Seen[] = [];
/** A streamed TTS answer (model `chunked`) holds its last chunk until the test calls this. */
let releaseLast: (() => void) | null = null;
const lastChunkHeld = () => new Promise<void>((resolve) => { releaseLast = resolve; });
const FIRST_CHUNK = 4_800;
const LAST_CHUNK = 9_600;
let server: Server;
let base = '';

const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
});

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    seen.push({ path: req.url ?? '', auth: req.headers.authorization, host: req.headers.host, body });
    if (req.url?.startsWith('/broken/')) { res.writeHead(500).end('{"error":{"message":"down"}}'); return; }
    if (req.url?.endsWith('/chat/completions')) {
      const json = JSON.parse(body) as { model: string; stream?: boolean };
      if (!json.stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          id: 'c1', object: 'chat.completion', created: 0, model: json.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ content: 'o' }, null));
      res.write(chunk({ content: 'k' }, null));
      res.end(`${chunk({}, 'stop')}data: [DONE]\n\n`);
      return;
    }
    if (req.url?.endsWith('/audio/transcriptions')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: 'bom dia', language: 'pt', duration: 0.6 }));
      return;
    }
    if (req.url?.endsWith('/audio/speech')) {
      const { model } = JSON.parse(body) as { model: string };
      const wav = probeWav();
      if (model === 'chunked') {
        // Like the parle Mac stack: the WAV header at once, then each synthesized chunk, no content-length.
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.write(wav.subarray(0, WAV_HEADER_BYTES));
        const held = lastChunkHeld();
        setTimeout(() => {
          res.write(Buffer.alloc(FIRST_CHUNK, 1));
          void held.then(() => res.end(Buffer.alloc(LAST_CHUNK, 2)));
        }, 20);
        return;
      }
      if (model === 'header-only') { res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav.subarray(0, WAV_HEADER_BYTES)); return; }
      if (model === 'json') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"detail":"model loading, try again"}'); return; }
      res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
afterEach(() => { seen.length = 0; setGatewayTelemetrySink(null); releaseLast?.(); releaseLast = null; });

const entry = (extra: Record<string, unknown> = {}) => ({ provider: 'openai-compatible', baseUrl: `${base}/v1`, model: 'qwen2.5-7b', ...extra });

describe('parsing a route entry with a baseUrl', () => {
  it('keeps baseUrl (normalized) and apiKeyEnv; the key value itself is never in the route', () => {
    const { routes, errors } = parseModelRoutes(JSON.stringify({ chat: { 'mac-llm': [
      { provider: 'openai-compatible', baseUrl: 'http://localhost:8080/v1/', model: 'qwen2.5-7b', apiKeyEnv: 'LOCAL_LLM_KEY' },
    ] } }));
    expect(errors).toEqual([]);
    expect(routes.chat?.['mac-llm']).toEqual([{ provider: 'openai-compatible', baseUrl: 'http://localhost:8080/v1', model: 'qwen2.5-7b', apiKeyEnv: 'LOCAL_LLM_KEY' }]);
  });

  it.each([
    ['not a URL', 'localhost:8080 v1'],
    ['another scheme', 'ftp://localhost/v1'],
    ['credentials in the URL', 'http://user:secret@localhost:8080/v1'],
    ['a token in the query', 'http://localhost:8080/v1?key=abc'],
    ['no baseUrl', undefined],
  ])('refuses %s', (_why, baseUrl) => {
    const { routes, errors } = parseModelRoutes(JSON.stringify({ stt: { s: [{ provider: 'openai-compatible', baseUrl, model: 'whisper' }] } }));
    expect(errors).toEqual(['MODEL_ROUTES.stt.s: invalid entry skipped']);
    expect(routes.stt).toBeUndefined();
  });

  it('refuses an apiKeyEnv outside LOCAL_* (no route may send OPENROUTER_API_KEY to its own server) and the string form', () => {
    expect(parseModelRoutes(JSON.stringify({ chat: { c: [entry({ apiKeyEnv: 'OPENROUTER_API_KEY' })] } })).errors).toHaveLength(1);
    expect(parseModelRoutes(JSON.stringify({ chat: { c: ['openai-compatible:qwen'] } })).errors).toHaveLength(1);
    expect(parseLinkBaseUrl('https://mac.tail1234.ts.net/v1')).toBe('https://mac.tail1234.ts.net/v1');
  });
});

describe('writing a route with a baseUrl', () => {
  it('an app key is refused with 403 and nothing is saved; an admin key writes it, with the cloud fallback appended', async () => {
    const apps = new AppRegistry(new MemoryAppStore());
    const body = { chat: { 'mac-llm': [entry()] } };
    const err = await apps.putRoutes('parle', body, { restrictedTo: () => true }).catch(e => e as AppError);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(403);
    expect((err as AppError).message).toMatch(/only an admin key/);
    expect(apps.get('parle')).toBeNull();
    const { routes, cloudFallbackAdded } = await apps.putRoutes('parle', body);
    expect(routes.chat?.['mac-llm']?.map(e => e.provider)).toEqual(['openai-compatible', 'openrouter']);
    expect(cloudFallbackAdded.map(a => a.alias)).toEqual(['mac-llm']);
  });
});

describe('SSRF: what a link may point at', () => {
  it.each([
    'http://10.0.0.5:8080/v1', 'http://172.16.3.4/v1', 'http://192.168.1.20:1234/v1', 'http://127.0.0.1:8080/v1', 'http://localhost:11434/v1',
    'http://[::1]:8080/v1', 'http://169.254.169.254/v1', 'http://metadata.google.internal/v1', 'http://[fd00::1]/v1', 'http://0x7f000001/v1',
  ])('the published gateway refuses %s', (url) => {
    expect(localLinkRefusal(url, RAILWAY)).toMatch(/private, loopback, link-local or metadata/);
  });

  it('allows an allowlisted host on the published gateway, and anything on a local gateway', () => {
    const env = { ...RAILWAY, LOCAL_LINK_ALLOW: 'mac.tail1234.ts.net, 100.101.102.103' };
    expect(localLinkRefusal('http://100.101.102.103:8080/v1', env)).toBeNull();
    expect(localLinkRefusal('https://mac.tail1234.ts.net/v1', env)).toBeNull();
    expect(localLinkRefusal('http://127.0.0.1:8080/v1', {})).toBeNull();
    expect(localLinkRefusal('https://llm.example.com/v1', RAILWAY)).toBeNull();
  });

  it('a private link is not mounted on Railway, its reason is reported, and the cloud fallback still answers', () => {
    const { providers, chains } = buildServeProviders({
      instances: instances(), env: RAILWAY, openrouter: { state: 'valid' },
      appRoutes: { chat: { 'mac-llm': [{ provider: 'openai-compatible', baseUrl: 'http://192.168.1.20:8080/v1', model: 'qwen' }] } },
    });
    expect(providers.chatRoutes?.['mac-llm']?.map(t => t.providerId)).toEqual(['openrouter']);
    expect(providers.unavailable?.chat?.['mac-llm']?.[0]).toMatch(/^local:192\.168\.1\.20:8080\/qwen: 192\.168\.1\.20 is a private/);
    expect(chains.chat['mac-llm']?.[0]).toMatchObject({ target: 'local:192.168.1.20:8080/qwen', notMounted: expect.stringMatching(/private/) });
  });

  it('resolves the host at call time: a name that rebinds to a private address is refused before any request', async () => {
    const answers = [[{ address: '93.184.216.34', family: 4 }], [{ address: '10.0.0.7', family: 4 }]];
    const calls: Array<{ url: string; host: string | null; redirect?: RequestRedirect }> = [];
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), host: new Headers(init.headers).get('host'), redirect: init.redirect });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const guarded = localLinkFetch(RAILWAY, { lookupAll: async () => answers.shift() ?? [], fetchImpl });
    await guarded('http://llm.example.com:8080/v1/chat/completions', { method: 'POST' });
    expect(calls).toEqual([{ url: 'http://93.184.216.34:8080/v1/chat/completions', host: 'llm.example.com:8080', redirect: 'error' }]);
    const err = await guarded('http://llm.example.com:8080/v1/chat/completions').catch(e => e as Error);
    expect(err.message).toMatch(/llm\.example\.com resolves to 10\.0\.0\.7/);
    expect(failureCode(err)).toBe('blocked');
    expect(calls).toHaveLength(1);
    await expect(localLinkFetch(RAILWAY, { lookupAll: async () => [], fetchImpl })('http://gone.example.com/v1/x')).rejects.toThrow(/does not resolve/);
    await expect(localLinkFetch(RAILWAY, { lookupAll: async () => [{ address: 'fd12::3', family: 6 }], fetchImpl })('http://api.railway.internal/v1/x'))
      .rejects.toThrow(/resolves to fd12::3/);
  });

  it('an allowlisted tunnel host is reached as named (it may resolve to a tailnet address); off Railway nothing is resolved', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: URL) => { urls.push(String(url)); return new Response('{}'); }) as unknown as typeof fetch;
    const never = async () => { throw new Error('resolved'); };
    await localLinkFetch({ ...RAILWAY, LOCAL_LINK_ALLOW: 'mac.tail1234.ts.net' }, { lookupAll: never, fetchImpl })('https://mac.tail1234.ts.net/v1/models');
    await localLinkFetch({}, { lookupAll: never, fetchImpl })('http://127.0.0.1:8080/v1/models');
    expect(urls).toEqual(['https://mac.tail1234.ts.net/v1/models', 'http://127.0.0.1:8080/v1/models']);
  });

  it('a provider call through a rebinding host fails with code blocked (the chain moves on)', async () => {
    const chat = localLinkProvider('chat', { baseUrl: 'http://evil.example.com/v1', model: 'm' }, RAILWAY, {
      lookupAll: async () => [{ address: '169.254.169.254', family: 4 }],
    }) as LLMProvider;
    const err = await chat.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }).catch(e => e as Error);
    expect(failureCode(err)).toBe('blocked');
    expect(seen).toEqual([]);
  });

  it('caps the answer size, declared or streamed', async () => {
    const big = (async () => new Response('x', { headers: { 'content-length': String(LOCAL_LINK_MAX_BYTES + 1) } })) as unknown as typeof fetch;
    await expect(localLinkFetch({}, { fetchImpl: big })('http://127.0.0.1/v1/x')).rejects.toThrow(/above/);
    const mb = new Uint8Array(1024 * 1024);
    let sent = 0;
    const endless = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(c) { sent++; c.enqueue(mb); },
    }))) as unknown as typeof fetch;
    const res = await localLinkFetch({}, { fetchImpl: endless })('http://127.0.0.1/v1/x');
    await expect(res.arrayBuffer()).rejects.toThrow(/above/);
    expect(sent).toBeLessThan(60);
  });
});

describe('chat, STT and TTS through an OpenAI-compatible server (local gateway)', () => {
  const env = { LOCAL_LLM_KEY: 'k-local-test' };
  const mount = () => buildServeProviders({
    instances: instances(), env, openrouter: { state: 'valid' },
    appRoutes: {
      chat: { 'mac-llm': [entry({ apiKeyEnv: 'LOCAL_LLM_KEY' })] },
      stt: { 'mac-stt': [entry({ model: 'whisper-1' })] },
      tts: { 'mac-tts': [entry({ model: 'kokoro', voice: 'af_heart' })] },
    },
  });

  it('chat, not streamed and streamed, carries the key from the named env var', async () => {
    const target = mount().providers.chatRoutes!['mac-llm']![0]!;
    expect(target.providerId).toBe(`${localLinkId(`${base}/v1`, 'qwen2.5-7b')}`);
    const full = await target.provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: target.model! });
    expect(full.content).toBe('ok');
    const tokens: string[] = [];
    for await (const t of target.provider.chatStream!({ messages: [{ role: 'user', content: 'hi' }], model: target.model! })) tokens.push(t);
    expect(tokens.slice(0, 2)).toEqual(['o', 'k']);
    expect(seen.map(s => s.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
    expect(seen.every(s => s.auth === 'Bearer k-local-test')).toBe(true);
    expect(JSON.parse(seen[1]!.body)).toMatchObject({ model: 'qwen2.5-7b', stream: true });
  });

  it('STT and TTS hit /v1/audio/transcriptions and /v1/audio/speech with the link model and voice', async () => {
    const { providers } = mount();
    const stt = providers.stt!['mac-stt']![0]! as RouteTarget<STTProvider>;
    expect((await stt.provider.transcribe({ audio: probeWav(), model: stt.model! })).text).toBe('bom dia');
    const tts = providers.tts!['mac-tts']![0]! as RouteTarget<TTSProvider>;
    const audio = await tts.provider.synthesize({ input: 'Bom dia.', model: tts.model!, voice: tts.voice ?? '', responseFormat: 'wav' });
    expect(audio.audio.length).toBeGreaterThan(1000);
    expect(seen.map(s => s.path)).toEqual(['/v1/audio/transcriptions', '/v1/audio/speech']);
    expect(seen[0]!.body).toContain('whisper-1');
    expect(JSON.parse(seen[1]!.body)).toMatchObject({ model: 'kokoro', voice: 'af_heart' });
    expect(seen.every(s => s.auth === 'Bearer local')).toBe(true);
  });

  it('a link whose apiKeyEnv is not set is not mounted, and says which variable', () => {
    const { providers } = buildServeProviders({
      instances: instances(), env: {}, openrouter: { state: 'valid' }, appRoutes: { chat: { 'mac-llm': [entry({ apiKeyEnv: 'LOCAL_LLM_KEY' })] } },
    });
    expect(providers.unavailable?.chat?.['mac-llm']?.[0]).toMatch(/LOCAL_LLM_KEY is not set/);
  });

  it('the cloud fallback is still appended after the link (a local link is not a cloud link)', () => {
    const { routes, added } = withCloudFallback({ chat: { 'mac-llm': [entry()] }, stt: { s: [entry(), { provider: 'groq', model: 'whisper-large-v3' }] } });
    expect(routes.chat?.['mac-llm']?.map(e => e.provider)).toEqual(['openai-compatible', 'openrouter']);
    expect(added.map(a => a.alias)).toEqual(['mac-llm']);
    expect(mount().providers.chatRoutes!['mac-llm']!.map(t => t.providerId.split(':')[0])).toEqual(['local', 'openrouter']);
  });
});

describe('same treatment as other links', () => {
  it('its own breaker per stage + baseUrl + model, and telemetry names it local:<host>/<model>', async () => {
    const events: TelemetryEvent[] = [];
    setGatewayTelemetrySink(e => { events.push(e); });
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeoutMs: 30_000 });
    const { providers } = buildServeProviders({
      instances: instances(), env: {}, openrouter: { state: 'valid' },
      appRoutes: { chat: { a: [entry({ baseUrl: `${base}/broken/v1` }), entry()] } },
    });
    const [broken, good] = providers.chatRoutes!.a! as Array<RouteTarget<LLMProvider>>;
    expect(broken!.providerId).toMatch(/^local:127\.0\.0\.1:\d+\/broken\/qwen2\.5-7b$/);
    const goodId = localLinkId(`${base}/v1`, 'qwen2.5-7b');
    expect(good!.providerId).toBe(goodId);
    const call = () => routeRequest([broken!, good!], (t, signal) => t.provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: t.model!, signal }),
      { stage: 'chat', breakers, timeoutMs: 5_000 });
    for (let i = 0; i < 2; i++) expect((await call()).headers['X-Gateway-Provider']).toBe(goodId);
    expect(breakers.peek(breakerKey('chat', broken!))?.isOpen()).toBe(true);
    expect(breakers.peek(breakerKey('chat', good!))?.isOpen()).toBe(false);
    expect(breakerKey('chat', good!)).toBe(`chat:${goodId}`);
    expect(breakerKey('stt', good!)).not.toBe(breakerKey('chat', good!));
    expect(events.filter(e => e.event === 'route.served').map(e => e.attrs?.provider)).toEqual([goodId, goodId]);
    expect(events.find(e => e.event === 'route.fallback')?.attrs?.provider).toBe(broken!.providerId);
  });

  it('reorder and cheaper-model groups: a link joins another only with an explicit equivalent', () => {
    expect(equivalenceGroup('stt', { provider: 'openai-compatible', baseUrl: 'http://h/v1' }, 'whisper')).toBe('link:http://h/v1|whisper');
    expect(equivalenceGroup('stt', { provider: 'groq' }, 'whisper')).toBe('stt:multi');
    expect(equivalenceGroup('stt', { provider: 'openai-compatible', baseUrl: 'http://h/v1', equivalent: 'whisper-v3' }, 'w'))
      .toBe(equivalenceGroup('stt', { provider: 'groq', equivalent: 'whisper-v3' }, 'whisper-large-v3'));
    const s = {
      modelPrices: { models: { 'qwen/qwen-2.5-7b-instruct': { prompt: 1e-6, completion: 2e-6 } } },
      apps: [{ id: 'mac', profile: null, routes: { chat: { c: [
        { provider: 'openrouter', model: 'qwen/qwen-2.5-7b-instruct', equivalent: 'qwen-7b' },
        { provider: 'openai-compatible', baseUrl: 'http://h:8080/v1', model: 'qwen2.5-7b', equivalent: 'qwen-7b' },
      ] } } }],
      traffic: { costs: { mac: { 'chat|openrouter:qwen/qwen-2.5-7b-instruct': 40 } } },
    } as unknown as AdminSnapshot;
    const [reco] = cheaperModelRules({ s } as never);
    expect(reco?.action).toEqual({ text: 'PUT /v1/apps/mac/routes: em c, local:h:8080/qwen2.5-7b antes de openrouter:qwen/qwen-2.5-7b-instruct' });
  });

  it('the fallback probe checks it (content check included) and «Garantia do serviço» shows it as local', async () => {
    const built = buildServeProviders({ instances: instances(), env: {}, openrouter: { state: 'valid' }, appRoutes: { chat: { 'mac-llm': [entry()] } } });
    const links = fallbackLinks(built.chains, built.providers);
    const local = links.find(l => l.providerId.startsWith('local:'))!;
    expect(local.target).toBe(localLinkId(`${base}/v1`, 'qwen2.5-7b'));
    expect(local.target).toBe(built.chains.chat['mac-llm']![0]!.target);
    const result = await probeLink(local);
    expect(result).toMatchObject({ ok: true, content: 'ok', target: local.target });
    const cloud = 'openrouter:google/gemini-2.5-flash-lite';
    const report = stageChainsReport({ chat: { 'mac-llm': built.chains.chat['mac-llm']! } }, {}).stages.chat!['mac-llm']!;
    expect(report.links.map(l => l.target)).toEqual([local.target, cloud]);
    const snapshot = {
      apps: [{ id: 'mac', profile: null, stages: { chat: ['mac-llm'] } }], gpus: [], chains: { chat: { 'mac-llm': report } },
      reserves: { intervalMinutes: 15, links: [result, { ...result, target: cloud, providerId: 'openrouter' }] },
    } as unknown as AdminSnapshot;
    const [svc] = services(snapshot, null, Date.now());
    expect(svc?.links.map(l => l.kind)).toEqual(['local', 'cloud']);
    expect(svc?.verdict).toBe('garantido');
    expect(providerHeader({ providerId: local.providerId, model: 'qwen2.5-7b' })).toBe(local.target);
  });
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return Buffer.concat(chunks);
    chunks.push(value);
  }
}

const ttsLink = (model = 'kokoro') => buildServeProviders({
  instances: instances(), env: {}, openrouter: { state: 'valid' }, appRoutes: { tts: { 'mac-tts': [entry({ model })] } },
}).providers.tts!['mac-tts']![0]! as RouteTarget<TTSProvider>;

/** The cloud fallback of a TTS chain, recording what it was asked. */
function cloudTts() {
  const cloud = vi.fn(async (_r: TTSRequest) => ({ audio: probeWav(), contentType: 'audio/wav' }));
  const provider = { providerId: 'openrouter', isConfigured: () => true, getModels: () => [], getVoices: () => [], synthesize: cloud };
  return { cloud, fallback: { providerId: 'openrouter', model: 'hexgrad/kokoro-82m', provider } as unknown as RouteTarget<TTSProvider> };
}

const speak = (t: RouteTarget<TTSProvider>, extra: Partial<TTSRequest> = {}) =>
  t.provider.synthesize({ input: 'Bonjour.', model: t.model!, voice: 'ff_siwis', responseFormat: 'wav', ...extra });

describe('TTS on a local link: the language goes along (QA parle 16/10/2026: French arrived as Portuguese)', () => {
  it('only the client language is an extra field of a local link, trimmed, as written', () => {
    expect(localSpeechExtras({ language: ' fr ', ref_audio: 'data:audio/wav;base64,UklGRg==', task_type: 'Base', stream_format: 'sse' }))
      .toEqual({ language: 'fr' });
    expect(localSpeechExtras({ language: 'pt-BR' })).toEqual({ language: 'pt-BR' });
    expect(localSpeechExtras({ language: 'French' })).toEqual({ language: 'French' });
    for (const language of [undefined, '', '  ', 42, ['fr'], 'x'.repeat(36)]) expect(localSpeechExtras({ language })).toEqual({});
    expect(localSpeechExtras(undefined)).toEqual({});
  });

  it('the server gets `language` in the OpenAI speech body, and no other client extra', async () => {
    await speak(ttsLink(), { extra: { language: 'fr', ref_audio: 'data:audio/wav;base64,UklGRg==', task_type: 'Base' } });
    const sent = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(sent).toMatchObject({ model: 'kokoro', input: 'Bonjour.', voice: 'ff_siwis', response_format: 'wav', language: 'fr' });
    expect(Object.keys(sent).sort()).toEqual(['input', 'language', 'model', 'response_format', 'voice']);
    await speak(ttsLink());
    expect(JSON.parse(seen[1]!.body)).not.toHaveProperty('language');
  });

  it('POST /v1/audio/speech: a French request reaches the local link with its language; the cloud fallback never sees it', async () => {
    const local = ttsLink();
    const { cloud, fallback } = cloudTts();
    const body = { model: 'mac-tts', input: 'Bonjour, vous voulez du pain ?', voice: 'ff_siwis', response_format: 'wav', language: 'fr' };
    const res = await handleAudioSpeech({ method: 'POST', url: '/v1/audio/speech', headers: {}, rawBody: Buffer.alloc(0), body },
      { 'mac-tts': [local, fallback] } as never);
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Gateway-Provider']).toBe(local.providerId);
    await readAll(res.stream!);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ language: 'fr', input: 'Bonjour, vous voulez du pain ?' });
    expect(cloud).not.toHaveBeenCalled();
  });
});

describe('TTS on a local link streams a wav/pcm answer from its first audio chunk', () => {
  it('synthesize resolves with the first chunk while the server still holds the rest (before: the whole WAV was read first)', async () => {
    const pending = speak(ttsLink('chunked'), { stream: true });
    const first = await Promise.race([pending, new Promise<'buffered'>(r => setTimeout(() => r('buffered'), 2_000))]);
    expect(first).not.toBe('buffered');
    const res = first as Awaited<typeof pending>;
    expect(res.contentType).toBe('audio/wav');
    expect(res.audio.length).toBe(0);
    const reader = res.stream!.getReader();
    let got = 0;
    while (got <= WAV_HEADER_BYTES) got += (await reader.read()).value!.byteLength;
    expect(got).toBe(WAV_HEADER_BYTES + FIRST_CHUNK); // header + first chunk, the last one still held by the server
    releaseLast!();
    for (let r = await reader.read(); !r.done; r = await reader.read()) got += r.value.byteLength;
    expect(got).toBe(WAV_HEADER_BYTES + FIRST_CHUNK + LAST_CHUNK);
  });

  it('without `stream` (or for mp3) the answer is read whole, as before', async () => {
    const whole = await speak(ttsLink());
    expect(whole.stream).toBeUndefined();
    expect(whole.audio.length).toBe(probeWav().length);
    const mp3 = await speak(ttsLink(), { stream: true, responseFormat: 'mp3' });
    expect(mp3.stream).toBeUndefined();
  });

  it('a header with no audio, or a JSON body, is a failure (code empty), never a mute success', async () => {
    const headerOnly = await speak(ttsLink('header-only'), { stream: true }).catch(e => e as Error);
    expect(failureCode(headerOnly)).toBe('empty');
    expect(headerOnly.message).toMatch(/ended with no audio \(44 bytes\)/);
    const json = await speak(ttsLink('json'), { stream: true }).catch(e => e as Error);
    expect(failureCode(json)).toBe('empty');
    expect(json.message).toMatch(/answered JSON, not audio/);
  });

  it('POST /v1/audio/speech: a local link that ends with no audio falls back to the cloud, which answers', async () => {
    const { cloud, fallback } = cloudTts();
    const body = { model: 'mac-tts', input: 'Bonjour.', voice: 'ff_siwis', response_format: 'wav', language: 'fr' };
    const res = await handleAudioSpeech({ method: 'POST', url: '/v1/audio/speech', headers: {}, rawBody: Buffer.alloc(0), body },
      { 'mac-tts': [ttsLink('header-only'), fallback] } as never);
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Gateway-Provider']).toBe('openrouter:hexgrad/kokoro-82m');
    expect(cloud.mock.calls[0]![0].extra).toBeUndefined();
  });
});
