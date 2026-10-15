import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import { audioComplete, TtsCache, ttsCacheFromEnv, type TtsCacheOptions } from '../../src/gateway/proxy/tts-cache';
import { handleAudioSpeech, type SpeechCache } from '../../src/gateway/proxy/routes/audio-speech';
import { createProxyServer } from '../../src/proxy/server';
import { CircuitBreakerRegistry } from '../../src/gateway/providers/cloud/circuit-breaker';
import { setGatewayTelemetrySink } from '../../src/telemetry/emit';
import type { TelemetryEvent } from '../../src/telemetry/contract';
import type { TTSProvider, TTSRequest, TTSResponse } from '../../src/gateway/providers/cloud/types';
import { renderStatus } from '../../src/admin-page/pages';
import { recommendations, scopeToApp } from '../../src/admin-page';
import { demoSnapshot } from '../__fixtures__/admin-snapshot';

const MB = 1024 * 1024;
const T0 = Date.parse('2026-10-13T10:00:00Z');
const speech = (n = 4_000) => Buffer.alloc(n, 7);
const wav = (amplitude: number, samples = 8_000) => {
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin(i / 5) * amplitude), 44 + i * 2);
  return b;
};

function fakeTts(id: string, answer: (req: TTSRequest) => TTSResponse | Promise<TTSResponse>) {
  const calls: TTSRequest[] = [];
  const provider = {
    providerId: id, isConfigured: () => true, getModels: () => [], getVoices: () => [],
    async synthesize(req: TTSRequest) { calls.push(req); return answer(req); },
    synthesizeStream: () => Promise.reject(new Error('unused')),
  } as unknown as TTSProvider;
  return { provider, calls };
}

const cacheWith = (over: Partial<TtsCacheOptions> = {}, clock = { now: T0 }) =>
  new TtsCache({ maxBytes: 4 * MB, maxEntryBytes: MB, ttlMs: 3_600_000, diskMaxBytes: 0, now: () => clock.now, ...over });

const request = (input: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  method: 'POST', url: '/v1/audio/speech', headers, body: { model: 'x-tts', input, voice: 'pm_alex', ...extra }, rawBody: Buffer.alloc(0),
});

const dirs: string[] = [];
afterEach(async () => {
  setGatewayTelemetrySink(null);
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('TTS cache in the route', () => {
  const route = (provider: TTSProvider, id = 'openrouter') => ({ 'x-tts': [{ providerId: id, provider, model: 'kokoro' }] });
  const breakers = () => new CircuitBreakerRegistry();

  it('misses then hits the same line, normalised, and still tells which provider made it', async () => {
    const { provider, calls } = fakeTts('openrouter', () => ({ audio: speech(), contentType: 'audio/mpeg' }));
    const cache = cacheWith();
    const sc: SpeechCache = { cache, scope: 'parle', gpuOnly: false };
    const first = await handleAudioSpeech(request('Bom dia, tudo bem?'), route(provider), undefined, breakers(), sc);
    expect(first.headers).toMatchObject({ 'X-Gateway-Cache': 'miss', 'X-Gateway-Provider': 'openrouter:kokoro' });
    const second = await handleAudioSpeech(request('  Bom  dia, tudo bem? '), route(provider), undefined, breakers(), sc);
    expect(second).toMatchObject({ status: 200, headers: { 'X-Gateway-Cache': 'hit', 'X-Gateway-Provider': 'openrouter:kokoro', 'Content-Type': 'audio/mpeg' } });
    expect((second.body as Buffer).equals(speech())).toBe(true);
    expect(calls).toHaveLength(1);
    await handleAudioSpeech(request('Bom dia, tudo bem?', {}, { speed: 1.2 }), route(provider), undefined, breakers(), sc);
    await handleAudioSpeech(request('Bom dia, tudo bem?', {}, { voice: 'pf_dora' }), route(provider), undefined, breakers(), sc);
    expect(calls).toHaveLength(3);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 3, byApp: { parle: { hits: 1, misses: 3 } } });
  });

  it('never gives one app the audio of another', async () => {
    const { provider, calls } = fakeTts('openrouter', () => ({ audio: speech(), contentType: 'audio/mpeg' }));
    const cache = cacheWith();
    await handleAudioSpeech(request('Olá'), route(provider), undefined, breakers(), { cache, scope: 'parle', gpuOnly: false });
    const other = await handleAudioSpeech(request('Olá'), route(provider), undefined, breakers(), { cache, scope: 'babelcast', gpuOnly: false });
    expect(other.headers).toMatchObject({ 'X-Gateway-Cache': 'miss' });
    expect(calls).toHaveLength(2);
  });

  it('Cache-Control: no-store goes straight to the provider and stores nothing', async () => {
    const { provider, calls } = fakeTts('openrouter', () => ({ audio: speech(), contentType: 'audio/mpeg' }));
    const cache = cacheWith();
    const sc = { cache, scope: 'parle', gpuOnly: false };
    expect((await handleAudioSpeech(request('Olá', { 'cache-control': 'no-store' }), route(provider), undefined, breakers(), sc)).headers)
      .toMatchObject({ 'X-Gateway-Cache': 'bypass' });
    expect((await handleAudioSpeech(request('Olá'), route(provider), undefined, breakers(), sc)).headers).toMatchObject({ 'X-Gateway-Cache': 'miss' });
    expect(calls).toHaveLength(2);
    expect(cache.stats().bypassed).toBe(1);
  });

  it('does not keep silent or tiny audio, nor the cloud voice of an app that needs its GPU', async () => {
    const quiet = fakeTts('openrouter', () => ({ audio: wav(10), contentType: 'audio/wav' }));
    const cache = cacheWith();
    const sc = { cache, scope: 'parle', gpuOnly: false };
    await handleAudioSpeech(request('Olá', {}, { response_format: 'wav', stream: false }), route(quiet.provider), undefined, breakers(), sc);
    await handleAudioSpeech(request('Olá', {}, { response_format: 'wav', stream: false }), route(quiet.provider), undefined, breakers(), sc);
    expect(quiet.calls).toHaveLength(2);
    expect(audioComplete(speech(100), 'audio/mpeg')).toBe(false);
    expect(audioComplete(wav(4_000), 'audio/wav')).toBe(true);
    const gpu = fakeTts('deployment:speech', () => { throw Object.assign(new Error('replica down'), { status: 503 }); });
    const cloud = fakeTts('openrouter', () => ({ audio: speech(), contentType: 'audio/mpeg' }));
    const chain = { 'x-tts': [{ providerId: 'deployment:speech', provider: gpu.provider, model: 'qwen' }, { providerId: 'openrouter', provider: cloud.provider, model: 'kokoro' }] };
    const gpuApp = { cache, scope: 'parle', gpuOnly: true };
    const degraded = await handleAudioSpeech(request('Bom dia'), chain, undefined, breakers(), gpuApp);
    expect(degraded.headers).toMatchObject({ 'X-Gateway-Provider': 'openrouter:kokoro', 'X-Gateway-Cache': 'miss' });
    expect((await handleAudioSpeech(request('Bom dia'), chain, undefined, breakers(), gpuApp)).headers).toMatchObject({ 'X-Gateway-Cache': 'miss' });
    expect(cloud.calls).toHaveLength(2);
  });

  it('keeps a streamed answer only once it arrived whole', async () => {
    const body = wav(4_000);
    const streamed = fakeTts('openrouter', () => ({
      audio: Buffer.alloc(0), contentType: 'audio/wav',
      stream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(body.subarray(0, 4_000)); c.enqueue(body.subarray(4_000)); c.close(); } }),
    }));
    const cache = cacheWith();
    const sc = { cache, scope: 'parle', gpuOnly: false };
    const cut = await handleAudioSpeech(request('Bom dia', {}, { response_format: 'wav' }), route(streamed.provider), undefined, breakers(), sc);
    const reader = cut.stream!.getReader();
    await reader.read();
    await reader.cancel();
    expect((await handleAudioSpeech(request('Bom dia', {}, { response_format: 'wav' }), route(streamed.provider), undefined, breakers(), sc)).headers)
      .toMatchObject({ 'X-Gateway-Cache': 'miss' });
    const whole = await handleAudioSpeech(request('Boa tarde', {}, { response_format: 'wav' }), route(streamed.provider), undefined, breakers(), sc);
    await new Response(whole.stream!).arrayBuffer();
    const hit = await handleAudioSpeech(request('Boa tarde', {}, { response_format: 'wav' }), route(streamed.provider), undefined, breakers(), sc);
    expect(hit.headers).toMatchObject({ 'X-Gateway-Cache': 'hit' });
    expect((hit.body as Buffer).equals(body)).toBe(true);
  });
});

describe('TTS cache store', () => {
  it('evicts the least recently used line when the memory cap is passed', async () => {
    const cache = cacheWith({ maxBytes: 10_000 });
    const put = (k: string) => cache.put(k, { audio: speech(4_000), contentType: 'audio/mpeg', provider: 'p', synthMs: 500 });
    put('a');
    put('b');
    await cache.get('a');
    put('c');
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('a')).not.toBeNull();
    expect(await cache.get('c')).not.toBeNull();
    expect(cache.stats()).toMatchObject({ entries: 2, evictions: 1, bytes: 8_000 });
    expect(cache.put('big', { audio: speech(2 * MB), contentType: 'audio/mpeg', provider: 'p', synthMs: 1 })).toBe(false);
  });

  it('forgets a line after its TTL, and the disk tier survives a restart within its own cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tts-cache-'));
    dirs.push(dir);
    const clock = { now: T0 };
    const first = cacheWith({ dir, diskMaxBytes: 9_000 }, clock);
    first.put('a', { audio: speech(4_000), contentType: 'audio/mpeg', provider: 'deployment:speech', synthMs: 900 });
    first.put('b', { audio: speech(4_000), contentType: 'audio/mpeg', provider: 'deployment:speech', synthMs: 900 });
    await new Promise(r => setTimeout(r, 50));
    clock.now += 1_000;
    first.put('c', { audio: speech(4_000), contentType: 'audio/mpeg', provider: 'deployment:speech', synthMs: 900 });
    await new Promise(r => setTimeout(r, 50));
    const restarted = cacheWith({ dir, diskMaxBytes: 9_000 }, clock);
    await restarted.load();
    expect(restarted.stats().diskBytes).toBeLessThanOrEqual(9_000);
    expect(await restarted.get('c')).toMatchObject({ provider: 'deployment:speech', synthMs: 900 });
    clock.now += 3_600_001;
    expect(await restarted.get('c')).toBeNull();
    expect(ttsCacheFromEnv({ TTS_CACHE: '0' }, dir)).toBeNull();
    expect(ttsCacheFromEnv({ TTS_CACHE_MEMORY_MB: '8', TTS_CACHE_DISK_MB: '0' }, dir)!.stats()).toMatchObject({ maxBytes: 8 * MB, diskMaxBytes: 0, ttlHours: 24 });
  });
});

describe('TTS cache through the proxy', () => {
  let server: Server | null = null;
  afterEach(() => { server?.close(); server = null; });

  it('a hit is still a served call for telemetry and the usage hook, with X-Gateway-Cache: hit', async () => {
    const events: TelemetryEvent[] = [];
    setGatewayTelemetrySink(e => events.push(e));
    const { provider, calls } = fakeTts('openrouter', () => ({ audio: speech(), contentType: 'audio/mpeg' }));
    const inferences: number[] = [];
    server = createProxyServer({
      apiKeys: ['app-key:parle'],
      providers: { tts: { 'x-tts': [{ providerId: 'openrouter', provider, model: 'kokoro' }] } } as never,
      ttsCache: { cache: cacheWith(), requiresGpu: () => false },
      onInference: (e) => { inferences.push(e.status); },
    });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/audio/speech`;
    const say = () => fetch(url, { method: 'POST', headers: { Authorization: 'Bearer app-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'x-tts', input: 'Olá', voice: 'pm_alex' }) });
    expect((await say()).headers.get('x-gateway-cache')).toBe('miss');
    const hit = await say();
    expect(hit.headers.get('x-gateway-cache')).toBe('hit');
    expect(Buffer.from(await hit.arrayBuffer()).length).toBe(4_000);
    expect(calls).toHaveLength(1);
    expect(inferences).toEqual([200, 200]);
    expect(events.filter(e => e.event === 'route.served').map(e => e.attrs?.provider)).toEqual(['openrouter', 'cache']);
  });
});

describe('TTS cache in the panel', () => {
  it('shows the hit rate and the synthesis avoided on Gastos, suggests more memory when it is full, and an app sees only itself', () => {
    const s = demoSnapshot(T0, 'bad');
    const html = renderStatus('n', s, { now: T0, csrf: 'c', actor: 'marcos', message: null, app: null, page: 'gastos' });
    const section = html.slice(html.indexOf('<section id="cachevoz"'), html.indexOf('</section>', html.indexOf('<section id="cachevoz"')));
    expect(section).toContain('Cache de voz (TTS)');
    expect(section).toMatch(/Acertos<\/span><b>44,3%/);
    expect(section).toContain('Babelcast');
    const reco = recommendations({ s, now: T0, csrf: '', app: null, view: null }).find(r => r.id === 'tts-cache')!;
    expect(reco.title).toBe('Cache de voz evita 44,3% das sínteses');
    expect(reco.action).toEqual({ text: 'TTS_CACHE_MEMORY_MB=128 (hoje 64)' });
    const own = renderStatus('n', scopeToApp(s, 'parle'), { now: T0, csrf: 'c', actor: 'parle', message: null, app: null, page: 'gastos', view: { id: 'parle', canPark: false } });
    expect(own).toMatch(/Acertos<\/span><b>53,1%/);
    expect(own).not.toContain('Babelcast');
  });
});
