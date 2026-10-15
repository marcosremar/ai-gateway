import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildServeProviders, equivalenceGroup, parseModelRoutes, type ServeInstances } from '../../../src/config/serve-providers';
import { withCloudFallback } from '../../../src/config/cloud-fallback';
import { stageChainsReport } from '../../../src/config/stage-chains';
import { AppError, AppRegistry, MemoryAppStore } from '../../../src/deployments/apps';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import {
  LOCAL_LINK_MAX_BYTES, localLinkFetch, localLinkId, localLinkProvider, localLinkRefusal, parseLinkBaseUrl,
} from '../../../src/gateway/providers/cloud/openai-compat/local-link';
import type { LLMProvider, STTProvider, TTSProvider } from '../../../src/gateway/providers/cloud/types';
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
      res.writeHead(200, { 'content-type': 'audio/wav' }).end(probeWav());
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
afterEach(() => { seen.length = 0; setGatewayTelemetrySink(null); });

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
