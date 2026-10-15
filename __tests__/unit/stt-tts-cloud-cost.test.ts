import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpenAICompatSTTProvider } from '../../src/gateway/providers/cloud/openai-compat/openai-compat-stt';
import { GENERATION_LOOKUP_MS, OpenAICompatTTSProvider, reportTtsCost } from '../../src/gateway/providers/cloud/openai-compat/openai-compat-tts';
import { setGatewayTelemetrySink } from '../../src/telemetry/emit';
import type { StoredTelemetryEvent, TelemetryEvent } from '../../src/telemetry/contract';
import { withLogContext } from '../../src/logger';
import { CLOUD_PRICES, usageCost, type ModelPrice } from '../../src/admin-page/model-prices';
import { SpendLedger } from '../../src/deployments/spend-ledger';
import { cheaperModelRules } from '../../src/admin-page/savings-rules';
import { COST_DAYS, linkCosts } from '../../src/admin-page/traffic';
import { renderStatus } from '../../src/admin-page/pages';
import type { AdminSnapshot } from '../../src/admin-page';
import type { ModelRoutesSpec, RouteEntrySpec } from '../../src/config/serve-providers';
import { EUR_TO_USD } from '../../src/deployments/vast-backend';
import { demoSnapshot } from '../__fixtures__/admin-snapshot';

const NOW = Date.parse('2026-10-13T10:00:00Z');
const seen: Array<[TelemetryEvent, string | undefined]> = [];
const dirs: string[] = [];
afterEach(async () => {
  seen.length = 0;
  setGatewayTelemetrySink(null);
  vi.useRealTimers();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
const listen = () => setGatewayTelemetrySink((e, caller) => seen.push([e, caller]));
const costs = () => seen.filter(([e]) => e.event === 'usage.cost').map(([e]) => e.attrs);

function wav(seconds: number, rate = 16_000): Buffer {
  const data = Math.round(seconds * rate) * 2;
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(data + 36, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data, 40);
  return Buffer.concat([head, Buffer.alloc(data)]);
}

function stt(providerId: 'groq' | 'openrouter', answer: unknown) {
  const p = new OpenAICompatSTTProvider({ providerId, baseURL: 'https://upstream.invalid/v1', envKey: 'UNUSED_TEST_KEY', models: [] }).withApiKey('fake');
  (p as unknown as { client: unknown }).client = { audio: { transcriptions: { create: async () => answer } } };
  return p;
}

function tts(providerId: 'groq' | 'openrouter', generationId: string | null, get: (path: string, opts: { query: { id: string } }) => Promise<unknown>) {
  const p = new OpenAICompatTTSProvider({ providerId, baseURL: 'https://upstream.invalid/v1', envKey: 'UNUSED_TEST_KEY', models: [], voices: [], passthroughVoices: true }).withApiKey('fake');
  const create = async () => new Response(Buffer.from('mp3'), { headers: generationId ? { 'x-generation-id': generationId } : {} });
  (p as unknown as { client: unknown }).client = { audio: { speech: { create } }, get };
  return p;
}

describe('measured units of an STT or TTS call', () => {
  it('STT: the cost OpenRouter reports when there is one, else the audio seconds from the answer or from the WAV header', async () => {
    listen();
    await withLogContext({ userId: 'parle' }, () => stt('openrouter', { text: 'bom dia', usage: { seconds: 3, cost: 0.0000225 } })
      .transcribe({ audio: wav(3), model: 'openai/whisper-large-v3' }));
    await stt('groq', { text: 'bom dia', duration: 2.5 }).transcribe({ audio: wav(3), model: 'whisper-large-v3' });
    await stt('groq', { text: 'bom dia' }).transcribe({ audio: wav(4.2), model: 'whisper-large-v3' });
    await stt('groq', 'bom dia').transcribe({ audio: new Blob([new Uint8Array(wav(1.5))]), model: 'whisper-large-v3', responseFormat: 'text' });
    await vi.waitFor(() => expect(costs()).toHaveLength(4));
    expect(costs()).toEqual([
      { stage: 'stt', provider: 'openrouter', model: 'openai/whisper-large-v3', costUsd: 0.0000225 },
      { stage: 'stt', provider: 'groq', model: 'whisper-large-v3', audioSeconds: 2.5 },
      { stage: 'stt', provider: 'groq', model: 'whisper-large-v3', audioSeconds: 4.2 },
      { stage: 'stt', provider: 'groq', model: 'whisper-large-v3', audioSeconds: 1.5 },
    ]);
    expect(seen[0]![1]).toBe('parle');
  });

  it('TTS: the input characters at once when the answer carries no generation id', async () => {
    listen();
    const get = vi.fn();
    await tts('groq', null, get).synthesize({ input: 'Bom dia, tudo bem?', voice: 'autumn', model: 'canopylabs/orpheus-v1-english' });
    expect(costs()).toEqual([{ stage: 'tts', provider: 'groq', model: 'canopylabs/orpheus-v1-english', chars: 18 }]);
    expect(get).not.toHaveBeenCalled();
  });

  it('TTS on OpenRouter: the actual cost of the generation, looked up after the answer and off the request path', async () => {
    vi.useFakeTimers();
    listen();
    const get = vi.fn(async (_path: string, _opts: { query: { id: string } }) => ({ data: { id: 'gen-7', total_cost: 0.000081 } }));
    await tts('openrouter', 'gen-7', get).synthesize({ input: 'Bom dia!', voice: 'pm_alex', model: 'hexgrad/kokoro-82m' });
    expect(costs()).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GENERATION_LOOKUP_MS[0]!);
    expect(get).toHaveBeenCalledWith('/generation', expect.objectContaining({ query: { id: 'gen-7' } }));
    expect(costs()).toEqual([{ stage: 'tts', provider: 'openrouter', model: 'hexgrad/kokoro-82m', costUsd: 0.000081 }]);
  });

  it('TTS on OpenRouter: retries the lookup, then falls back to the characters, and keeps the caller of the request', async () => {
    listen();
    let calls = 0;
    const client = { get: async () => { calls++; if (calls === 1) throw Object.assign(new Error('not found'), { status: 404 }); return { data: { total_cost: 0 } }; } };
    await withLogContext({ userId: 'babelcast' }, async () => reportTtsCost(client as never, 'openrouter', 'hexgrad/kokoro-82m', 'Olá', 'gen-8', [1, 1]));
    await vi.waitFor(() => expect(costs()).toHaveLength(1));
    expect(calls).toBe(2);
    expect(costs()).toEqual([{ stage: 'tts', provider: 'openrouter', model: 'hexgrad/kokoro-82m', chars: 3 }]);
    expect(seen[0]![1]).toBe('babelcast');
  });
});

describe('price × units', () => {
  const PRICES: Record<string, ModelPrice> = {
    'openai/whisper-large-v3': { prompt: 0.0000075, completion: 0 }, 'hexgrad/kokoro-82m': { prompt: 0.00000062, completion: 0 },
    'google/gemini-tts': { prompt: 0.0000005, completion: 0.000006 },
  };

  it('keeps the actual cost, else prices the seconds or characters, with the provider minimum', () => {
    expect(usageCost({ stage: 'stt', provider: 'openrouter', model: 'openai/whisper-large-v3', costUsd: 0.0002, audioSeconds: 3 }, PRICES)).toEqual({ usd: 0.0002, estimated: false });
    expect(usageCost({ stage: 'stt', provider: 'openrouter', model: 'openai/whisper-large-v3', audioSeconds: 12 }, PRICES)!.usd).toBeCloseTo(12 * 0.0000075, 12);
    expect(usageCost({ stage: 'tts', provider: 'openrouter', model: 'hexgrad/kokoro-82m', chars: 1000 }, PRICES)).toEqual({ usd: 1000 * 0.00000062, estimated: true });
    expect(usageCost({ stage: 'stt', provider: 'groq', model: 'whisper-large-v3', audioSeconds: 30 }, PRICES)!.usd).toBeCloseTo(30 * 0.111 / 3600, 12);
    expect(usageCost({ stage: 'stt', provider: 'groq', model: 'whisper-large-v3', audioSeconds: 2 }, PRICES)!.usd).toBeCloseTo(10 * 0.111 / 3600, 12);
    expect(usageCost({ stage: 'tts', provider: 'groq', model: 'canopylabs/orpheus-v1-english', chars: 500 }, PRICES)!.usd).toBeCloseTo(500 * 22 / 1e6, 12);
    expect(Object.values(CLOUD_PRICES).every(p => p.source?.startsWith('https://'))).toBe(true);
  });

  it('an unknown price is unknown, never zero: no price, token-priced audio, or no units', () => {
    expect(usageCost({ stage: 'stt', provider: 'fireworks', model: 'whisper-v3', audioSeconds: 5 }, PRICES)).toBeNull();
    expect(usageCost({ stage: 'tts', provider: 'openrouter', model: 'unlisted/tts', chars: 20 }, PRICES)).toBeNull();
    expect(usageCost({ stage: 'tts', provider: 'openrouter', model: 'google/gemini-tts', chars: 20 }, PRICES)).toBeNull();
    expect(usageCost({ stage: 'stt', provider: 'openrouter', model: 'openai/whisper-large-v3' }, PRICES)).toBeNull();
  });
});

describe('spend ledger per stage', () => {
  it('keeps actual, estimated and unknown apart per app, day and stage, and the day total of the cloud', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aigw-ledger-'));
    dirs.push(dir);
    const path = join(dir, 'spend-ledger.json');
    const ledger = new SpendLedger({ path, now: () => NOW, deployments: () => [], ownerOf: () => null });
    ledger.cloud('parle', 0.02);
    ledger.cloud('parle', 0.001, 'stt');
    ledger.cloud('parle', 0.0004, 'tts', true);
    ledger.cloud('parle', 0.0006, 'tts', true);
    ledger.cloud('parle', null, 'tts');
    ledger.cloud('parle', null, 'tts');
    ledger.cloud('parle', 0, 'stt');
    ledger.cloud('parle', Number.NaN, 'stt');
    await ledger.flush();
    const reloaded = new SpendLedger({ path, now: () => NOW, deployments: () => [], ownerOf: () => null });
    await reloaded.load();
    for (const l of [ledger, reloaded]) {
      expect(l.view().days[0]!.apps.parle).toEqual({
        gpuEur: 0, requests: 0, tokens: 0, cloudUsd: 0.022,
        stages: { chat: { usd: 0.02 }, stt: { usd: 0.001 }, tts: { estimatedUsd: 0.001, unknown: 2 } },
      });
    }
  });

  it('shows the estimated part and the calls of unknown cost on the spend page, never as zero', () => {
    const html = renderStatus('n', demoSnapshot(NOW, 'warn'), { now: NOW, csrf: 'c', actor: 'marcos', message: null, app: null, page: 'gastos' });
    expect(html).toContain('Nuvem por etapa · 30 dias');
    expect(html).toMatch(/nuvem US\$\s[\d,]+ · [\d.]+ pedidos<\/small><small>US\$\s[\d,]+ estimado/);
    expect(html).toMatch(/[\d.]+ com custo desconhecido/);
    expect(html).toMatch(/Texto → fala<\/div><\/td><td class="n" data-l="Informado"><div class="v">—<\/div><\/td><td class="n" data-l="Estimado"><div class="v">—<\/div><\/td><td class="n" data-l="Chamadas sem preço"><div class="v">[\d.]+<small>custo desconhecido/);
  });
});

describe('cheaper equivalent STT and TTS links', () => {
  const PRICES: Record<string, ModelPrice> = {
    'openai/whisper-large-v3': { prompt: 0.0000075, completion: 0 }, 'openai/whisper-large-v3-turbo': { prompt: 0.00000333, completion: 0 },
    'openai/gpt-4o-transcribe': { prompt: 0.00005, completion: 0.00001 },
    'tts-a': { prompt: 0.00002, completion: 0 }, 'tts-b': { prompt: 0.000005, completion: 0 },
  };
  const link = (provider: string, model: string, extra: Partial<RouteEntrySpec> = {}): RouteEntrySpec => ({ provider, model, ...extra });
  const gpu: RouteEntrySpec = { provider: 'deployment', deployment: 'speech-stack' };
  const rules = (routes: ModelRoutesSpec, linkCost: Record<string, number>, estimated: Record<string, number> = {}) => {
    const s = demoSnapshot(NOW, 'warn');
    const snap: AdminSnapshot = {
      ...s, apps: [{ id: 'a', profile: null, status: null, routes }], modelPrices: { at: new Date(NOW).toISOString(), models: PRICES },
      traffic: { ...s.traffic!, costs: { a: linkCost }, estimatedCosts: { a: estimated } },
    };
    return cheaperModelRules({ s: snap, now: NOW, csrf: '', app: null, view: null });
  };

  it('STT: a cheaper link of the same language on another provider, with the estimated cost labelled and the saving from it', () => {
    const list = rules({ stt: { s: [gpu, link('groq', 'whisper-large-v3'), link('openrouter', 'openai/whisper-large-v3')] } }, { 'stt|groq:whisper-large-v3': 7 }, { 'stt|groq:whisper-large-v3': 7 });
    expect(list).toHaveLength(1);
    const ratio = 0.0000075 / (0.111 / 3600);
    expect(list[0]).toMatchObject({
      id: 'cheaper-model:a:stt:s', title: 'Modelo equivalente mais barato em s: openai/whisper-large-v3',
      action: { text: 'PUT /v1/apps/a/routes: em s, openrouter:openai/whisper-large-v3 antes de groq:whisper-large-v3' },
    });
    expect(list[0]!.saving!.perMonth).toBeCloseTo((7 * (30 / COST_DAYS) * (1 - ratio)) / EUR_TO_USD, 9);
    expect(list[0]!.saw).toContain('(estimado)');
    expect(list[0]!.saw).toContain('por hora de áudio');
    expect(rules({ stt: { s: [link('groq', 'whisper-large-v3'), link('openrouter', 'openai/whisper-large-v3')] } }, { 'stt|groq:whisper-large-v3': 7 }, { 'stt|groq:whisper-large-v3': 2 })[0]!.saw)
      .toMatch(/US\$\s2,00 estimado/);
  });

  it('STT: never across languages, never to a link priced by another unit, never from or to a GPU or an unpriced link', () => {
    const cost = { 'stt|openrouter:openai/whisper-large-v3': 70, 'stt|fireworks:whisper-v3': 70, 'stt|openrouter:openai/gpt-4o-transcribe': 70 };
    expect(rules({ stt: { s: [link('openrouter', 'openai/whisper-large-v3', { language: 'pt' }), link('openrouter', 'openai/whisper-large-v3-turbo', { language: 'fr' })] } }, cost)).toEqual([]);
    expect(rules({ stt: { s: [link('openrouter', 'openai/gpt-4o-transcribe'), link('openrouter', 'openai/whisper-large-v3-turbo')] } }, cost)).toEqual([]);
    expect(rules({ stt: { s: [link('fireworks', 'whisper-v3'), link('openrouter', 'openai/whisper-large-v3-turbo')] } }, cost)).toEqual([]);
    expect(rules({ stt: { s: [link('openrouter', 'openai/whisper-large-v3'), { ...gpu, model: 'openai/whisper-large-v3-turbo' }] } }, cost)).toEqual([]);
    expect(rules({ stt: { s: [link('openrouter', 'openai/whisper-large-v3'), link('openrouter', 'openai/whisper-large-v3-turbo')] } }, cost).map(r => r.id)).toEqual(['cheaper-model:a:stt:s']);
  });

  it('TTS: only inside the same voice identity; another voice, a request-picked voice or the GPU voice never changes', () => {
    const cost = { 'tts|openrouter:tts-a': 70 };
    const rafa = { feminine: 'pf_dora', masculine: 'pm_alex' };
    const route = (...entries: RouteEntrySpec[]) => ({ tts: { 'parle-tts': entries } });
    expect(rules(route(gpu, link('openrouter', 'tts-a', { equivalent: 'v', voice: 'pm_alex' }), link('openrouter', 'tts-b', { equivalent: 'v', voice: 'pf_dora' })), cost)).toEqual([]);
    expect(rules(route(link('openrouter', 'tts-a', { equivalent: 'v', voices: rafa }), link('openrouter', 'tts-b', { equivalent: 'v', voices: { ...rafa, masculine: 'pm_santa' } })), cost)).toEqual([]);
    expect(rules(route(link('openrouter', 'tts-a', { equivalent: 'v' }), link('openrouter', 'tts-b', { equivalent: 'v' })), cost)).toEqual([]);
    expect(rules(route(link('openrouter', 'tts-a', { equivalent: 'v', voice: 'pm_alex' }), { ...gpu, model: 'tts-b', equivalent: 'v', voice: 'pm_alex' }), cost)).toEqual([]);
    const same = rules(route(gpu, link('openrouter', 'tts-a', { equivalent: 'v', voice: 'pm_alex' }), link('openrouter', 'tts-b', { equivalent: 'v', voice: 'pm_alex' })), cost);
    expect(same.map(r => r.id)).toEqual(['cheaper-model:a:tts:parle-tts']);
    expect(same[0]!.saw).toContain('por milhão de caracteres');
    expect(same[0]!.why).toContain('voz pm_alex');
  });

  it('sums the estimated part of each link apart from the total', () => {
    const row = (seq: number, attrs: StoredTelemetryEvent['attrs']): StoredTelemetryEvent => ({
      seq, rxTs: NOW - 60_000, ts: NOW - 60_000, source: 'gateway', level: 'info', event: 'usage.cost', traceId: '1'.repeat(32), app: 'parle', attrs,
    });
    const rows = [
      row(0, { stage: 'tts', provider: 'openrouter', model: 'k', costUsd: 0.5 }), row(1, { stage: 'tts', provider: 'openrouter', model: 'k', costUsd: 0.25, estimated: true }),
      row(2, { stage: 'tts', provider: 'openrouter', model: 'k', costUnknown: true }),
    ];
    expect(linkCosts(rows, NOW)).toEqual({ parle: { 'tts|openrouter:k': 0.75 } });
    expect(linkCosts(rows, NOW, true)).toEqual({ parle: { 'tts|openrouter:k': 0.25 } });
  });

  it('shows the STT suggestion of the warn demo with its estimated cost', () => {
    const html = renderStatus('n', demoSnapshot(NOW, 'warn'), { now: NOW, csrf: 'c', actor: 'marcos', message: null, app: null, page: 'geral' });
    expect(html).toContain('Modelo equivalente mais barato em babel-stt: openai/whisper-large-v3');
    expect(html).toContain('PUT /v1/apps/babelcast/routes: em babel-stt, openrouter:openai/whisper-large-v3 antes de groq:whisper-large-v3');
    expect(html).toMatch(/whisper-large-v3 custou US\$\s[\d,]+ \(estimado\)/);
  });
});
