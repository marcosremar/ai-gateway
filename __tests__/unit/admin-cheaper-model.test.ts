import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MODEL_PRICES_MAX_AGE_MS, MODEL_PRICES_URL, createModelPrices, parseModelPrices, type ModelPrice } from '../../src/admin-page/model-prices';
import { cheaperModelRules, priceRatio } from '../../src/admin-page/savings-rules';
import { COST_DAYS, linkCosts } from '../../src/admin-page/traffic';
import { eurPerMonth, pageOf, recommendations } from '../../src/admin-page/recommendations';
import { renderStatus } from '../../src/admin-page/pages';
import { scopeToApp, type AdminSnapshot } from '../../src/admin-page';
import type { ModelRoutesSpec, RouteEntrySpec } from '../../src/config/serve-providers';
import type { StoredTelemetryEvent } from '../../src/telemetry/contract';
import { EUR_TO_USD } from '../../src/deployments/vast-backend';
import { demoSnapshot } from '../__fixtures__/admin-snapshot';

const NOW = Date.parse('2026-10-13T10:00:00Z');
const P = (prompt: number, completion: number): ModelPrice => ({ prompt, completion });
const PRICES: Record<string, ModelPrice> = {
  big: P(0.000003, 0.000015), small: P(0.000001, 0.000005), mixed: P(0.000001, 0.00002),
  'tts-a': P(0.00002, 0), 'tts-b': P(0.000005, 0), 'stt-a': P(0.0000075, 0), 'stt-b': P(0.0000025, 0),
};
const LIST = { data: [{ id: 'big', pricing: { prompt: '0.000003', completion: '0.000015' } }, { id: 'small', pricing: { prompt: '0.000001', completion: '0.000005' } }] };
const or = (model: string, extra: Partial<RouteEntrySpec> = {}): RouteEntrySpec => ({ provider: 'openrouter', model, ...extra });

function snap(app: string, routes: ModelRoutesSpec, costs: Record<string, number>): AdminSnapshot {
  const s = demoSnapshot(NOW, 'warn');
  return { ...s, apps: [{ id: app, profile: null, status: null, routes }], modelPrices: { at: new Date(NOW).toISOString(), models: PRICES }, traffic: { ...s.traffic!, costs: { [app]: costs } } };
}
const rules = (s: AdminSnapshot) => cheaperModelRules({ s, now: NOW, csrf: '', app: null, view: null });
const cheaper = (s: AdminSnapshot, view: { id: string; canPark: boolean } | null = null) =>
  recommendations({ s, now: NOW, csrf: '', app: null, view }).filter(r => r.id.startsWith('cheaper-model:'));

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aigw-prices-'));
  dirs.push(dir);
  return join(dir, 'model-prices.json');
}

describe('OpenRouter price list', () => {
  it('reads the per-token price strings, keeps a free model, drops variable (-1), missing or malformed prices and ignores unknown fields', () => {
    const body = {
      data: [
        { id: 'a/b', name: 'A', pricing: { prompt: '0.0000003', completion: '0.0000025', web_search: '0.014', overrides: [{ min_prompt_tokens: 1, prompt: '1' }] } },
        { id: 'free:free', pricing: { prompt: '0', completion: '0' } },
        { id: 'num', pricing: { prompt: 0.000002, completion: 0 } },
        { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
        { id: 'half', pricing: { prompt: '0.000001' } },
        { id: 'blank', pricing: { prompt: '', completion: '0' } },
        { id: 'words', pricing: { prompt: 'abc', completion: '0' } },
        { id: 'nulls', pricing: { prompt: null, completion: null } },
        { id: 'nopricing' },
        { pricing: { prompt: '1', completion: '1' } },
        null,
      ],
    };
    expect(parseModelPrices(body)).toEqual({ 'a/b': P(0.0000003, 0.0000025), 'free:free': P(0, 0), num: P(0.000002, 0) });
    expect(() => parseModelPrices({})).toThrow();
    expect(() => parseModelPrices(null)).toThrow();
  });

  it('refreshes once a day from the public list without a key, caches it in the state dir and loads it back after a restart', async () => {
    const path = await stateDir();
    const clock = { now: NOW };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchList = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(LIST));
    }) as typeof fetch;
    const store = createModelPrices({ path, fetch: fetchList, now: () => clock.now });
    expect(store.snapshot()).toBeNull();
    expect(await store.tick()).toBe(true);
    expect(calls.map(c => c.url)).toEqual([MODEL_PRICES_URL]);
    expect(MODEL_PRICES_URL.startsWith('https://openrouter.ai/api/v1/models')).toBe(true);
    expect(new Headers(calls[0]!.init?.headers).has('authorization')).toBe(false);
    expect(store.snapshot()).toEqual({ at: new Date(NOW).toISOString(), models: { big: PRICES.big, small: PRICES.small } });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(store.snapshot());

    clock.now += MODEL_PRICES_MAX_AGE_MS - 1;
    expect(await store.tick()).toBe(false);
    const restarted = createModelPrices({ path, fetch: fetchList, now: () => clock.now });
    await restarted.load();
    expect(restarted.snapshot()).toEqual(store.snapshot());
    expect(await restarted.tick()).toBe(false);
    expect(calls).toHaveLength(1);
    clock.now += 1;
    expect(await restarted.tick()).toBe(true);
    expect(calls).toHaveLength(2);
    expect(restarted.snapshot()!.at).toBe(new Date(clock.now).toISOString());

    const empty = createModelPrices({ path: join(path, '..', 'none.json') });
    await empty.load();
    expect(empty.snapshot()).toBeNull();
  });

  it('keeps the last prices when a refresh fails and tries again at the next check', async () => {
    const path = await stateDir();
    const clock = { now: NOW };
    let mode: 'ok' | 'http' | 'throw' | 'junk' | 'empty' = 'ok';
    const fetchList = (async () => {
      if (mode === 'throw') throw new Error('offline');
      if (mode === 'http') return new Response('down', { status: 503 });
      if (mode === 'junk') return new Response('<html>');
      return new Response(JSON.stringify(mode === 'empty' ? { data: [] } : LIST));
    }) as typeof fetch;
    const logs: string[] = [];
    const store = createModelPrices({ path, fetch: fetchList, now: () => clock.now, log: msg => logs.push(msg) });
    expect(await store.refresh()).toBe(true);
    const first = store.snapshot();
    for (const m of ['http', 'throw', 'junk', 'empty'] as const) {
      mode = m;
      clock.now += MODEL_PRICES_MAX_AGE_MS;
      expect(await store.tick()).toBe(false);
      expect(store.snapshot()).toEqual(first);
    }
    expect(logs.filter(l => l.includes('keeping the last prices'))).toHaveLength(4);
    const reloaded = createModelPrices({ path });
    await reloaded.load();
    expect(reloaded.snapshot()).toEqual(first);
    mode = 'ok';
    expect(await store.tick()).toBe(true);
    expect(store.snapshot()!.at).toBe(new Date(clock.now).toISOString());
  });
});

describe('cloud cost per link', () => {
  it('sums usage.cost per app and link over the last days, without rows of other events, of no app or older', () => {
    const row = (minutesAgo: number, app: string | undefined, model: string, costUsd: number, event = 'usage.cost'): StoredTelemetryEvent => ({
      seq: 0, rxTs: NOW - minutesAgo * 60_000, ts: NOW - minutesAgo * 60_000, source: 'gateway', level: 'info', event, traceId: '1'.repeat(32),
      ...(app ? { app } : {}), attrs: { stage: 'chat', provider: 'openrouter', model, costUsd },
    });
    const rows = [
      row((COST_DAYS + 1) * 1440, 'parle', 'big', 5), row((COST_DAYS - 1) * 1440, 'parle', 'big', 1.5), row(60, 'parle', 'big', 0.5), row(30, 'parle', 'small', 0.25),
      row(20, 'babelcast', 'big', 2), row(10, undefined, 'big', 9), row(5, 'parle', 'big', 3, 'route.served'), row(1, 'parle', 'big', -1),
    ].map((r, seq) => ({ ...r, seq }));
    expect(linkCosts(rows, NOW)).toEqual({ parle: { 'chat|openrouter:big': 2, 'chat|openrouter:small': 0.25 }, babelcast: { 'chat|openrouter:big': 2 } });
  });
});

describe('cheaper equivalent model suggestion', () => {
  it('suggests the cheaper link of the same equivalent group, with the monthly saving from the measured cost', () => {
    const routes = { chat: { 'parle-chat': [{ provider: 'deployment', deployment: 'speech-stack' }, or('big', { equivalent: 'conversa' }), or('small', { equivalent: 'conversa' })] } };
    const list = rules(snap('parle', routes, { 'chat|openrouter:big': 14 }));
    expect(list).toHaveLength(1);
    const r = list[0]!;
    expect(priceRatio(PRICES.big!, PRICES.small!)).toBeCloseTo(1 / 3, 9);
    const eur = (14 * (30 / COST_DAYS) * (2 / 3)) / EUR_TO_USD;
    expect(r).toMatchObject({
      id: 'cheaper-model:parle:chat:parle-chat', level: 'ok', title: 'Modelo equivalente mais barato em parle-chat: small',
      action: { text: 'PUT /v1/apps/parle/routes: em parle-chat, openrouter:small antes de openrouter:big' },
    });
    expect(r.saving!.perMonth).toBeCloseTo(eur, 9);
    expect(eurPerMonth(r)).toBeCloseTo(eur, 9);
    expect(r.why).toContain('grupo conversa');
    expect(r.saw).toContain('custou US$');
    expect(pageOf(r)).toBe('/admin/servicos#garantia');

    expect(rules(snap('parle', routes, {}))).toEqual([]);
    expect(rules(snap('parle', routes, { 'chat|openrouter:big': 0.2 }))).toEqual([]);
    expect(rules({ ...snap('parle', routes, { 'chat|openrouter:big': 14 }), modelPrices: null })).toEqual([]);
  });

  it('never crosses groups and never suggests a link that is not cheaper on both input and output', () => {
    const chat = (...entries: RouteEntrySpec[]) => ({ chat: { c: entries } });
    const cost = { 'chat|openrouter:big': 70, 'chat|openrouter:small': 70 };
    expect(rules(snap('a', chat(or('big', { equivalent: 'x' }), or('small', { equivalent: 'y' })), cost))).toEqual([]);
    expect(rules(snap('a', chat(or('big'), or('small')), cost))).toEqual([]);
    expect(rules(snap('a', chat(or('big', { equivalent: 'x' }), or('mixed', { equivalent: 'x' })), cost))).toEqual([]);
    expect(rules(snap('a', chat(or('small', { equivalent: 'x' }), or('big', { equivalent: 'x' })), cost))).toEqual([]);
    expect(rules(snap('a', chat(or('big', { equivalent: 'x' }), or('unpriced', { equivalent: 'x' })), cost))).toEqual([]);
  });

  it('never offers a GPU deployment or a link without an OpenRouter price, even with the same model id and group', () => {
    const routes = { chat: { c: [or('big', { equivalent: 'x' }), { provider: 'deployment', deployment: 'speech-stack', model: 'small', equivalent: 'x' }, { provider: 'groq', model: 'small', equivalent: 'x' }] } };
    expect(rules(snap('a', routes, { 'chat|openrouter:big': 70, 'chat|deployment:speech-stack:small': 70, 'chat|groq:small': 70 }))).toEqual([]);
  });

  it('TTS: only the same voice identity, never another voice, another gender table or the voice the request picks', () => {
    const tts = (...entries: RouteEntrySpec[]) => ({ tts: { 'parle-tts': entries } });
    const cost = { 'tts|openrouter:tts-a': 70 };
    const rafa = { feminine: 'pf_dora', masculine: 'pm_alex' };
    expect(rules(snap('parle', tts(or('tts-a', { equivalent: 'v', voice: 'pm_alex' }), or('tts-b', { equivalent: 'v', voice: 'pf_dora' })), cost))).toEqual([]);
    expect(rules(snap('parle', tts(or('tts-a', { voice: 'pm_alex' }), or('tts-b', { voice: 'pm_alex' })), cost))).toEqual([]);
    expect(rules(snap('parle', tts(or('tts-a', { equivalent: 'v', voices: rafa }), or('tts-b', { equivalent: 'v', voices: { feminine: 'pf_dora', masculine: 'pf_dora' } })), cost))).toEqual([]);
    expect(rules(snap('parle', tts(or('tts-a', { equivalent: 'v' }), or('tts-b', { equivalent: 'v' })), cost))).toEqual([]);
    expect(rules(snap('parle', tts(or('tts-a', { equivalent: 'v', voices: rafa }), or('tts-b', { equivalent: 'v', voices: rafa })), cost)).map(r => r.id)).toEqual(['cheaper-model:parle:tts:parle-tts']);
    const same = rules(snap('parle', tts(or('tts-a', { equivalent: 'v', voice: 'pm_alex' }), or('tts-b', { equivalent: 'v', voice: 'pm_alex' })), cost));
    expect(same.map(r => r.why)).toEqual([expect.stringContaining('grupo v, voz pm_alex')]);
  });

  it('STT: only links of the same language capability', () => {
    const stt = (...entries: RouteEntrySpec[]) => ({ stt: { s: entries } });
    const cost = { 'stt|openrouter:stt-a': 70 };
    expect(rules(snap('a', stt(or('stt-a'), or('stt-b')), cost)).map(r => r.id)).toEqual(['cheaper-model:a:stt:s']);
    expect(rules(snap('a', stt(or('stt-a', { language: 'pt' }), or('stt-b', { language: 'fr' })), cost))).toEqual([]);
    expect(rules(snap('a', stt(or('stt-a'), or('stt-b', { language: 'pt' })), cost))).toEqual([]);
  });

  it('gives an app session only its own suggestion and its own dismissals', () => {
    const s = demoSnapshot(NOW, 'warn');
    s.apps = s.apps.map(a => (a.id === 'babelcast'
      ? { ...a, routes: { chat: { 'babel-chat': [or('google/gemini-2.5-flash', { equivalent: 'c' }), or('google/gemini-2.5-flash-lite', { equivalent: 'c' })] } } } : a));
    s.traffic!.costs!.babelcast = { 'chat|openrouter:google/gemini-2.5-flash': 7 };
    expect(cheaper(s).map(r => r.id).sort()).toEqual(['cheaper-model:babelcast:chat:babel-chat', 'cheaper-model:parle:chat:parle-chat']);
    const scoped = scopeToApp(s, 'parle');
    expect(Object.keys(scoped.traffic!.costs!)).toEqual(['parle']);
    expect(cheaper(scoped, { id: 'parle', canPark: true }).map(r => r.id)).toEqual(['cheaper-model:parle:chat:parle-chat']);
    const hidden = { 'cheaper-model:parle:chat:parle-chat': NOW + 1000, 'cheaper-model:babelcast:chat:babel-chat': NOW + 1000 };
    expect(Object.keys(scopeToApp({ ...s, dismissed: hidden }, 'parle').dismissed!)).toEqual(['cheaper-model:parle:chat:parle-chat']);
    expect(cheaper({ ...s, dismissed: hidden })).toEqual([]);
  });

  it('shows one such suggestion with its saving on the overview of the warn demo, and none in the green demo', () => {
    const list = cheaper(demoSnapshot(NOW, 'warn'));
    expect(list.map(r => r.id)).toEqual(['cheaper-model:parle:chat:parle-chat']);
    expect(list[0]!.saving!.perMonth).toBeCloseTo((0.017 * 24 * COST_DAYS * (30 / COST_DAYS) * (1 - 1 / 3)) / EUR_TO_USD, 6);
    const html = renderStatus('n', demoSnapshot(NOW, 'warn'), { now: NOW, csrf: 'c', actor: 'marcos', message: null, app: null, page: 'geral' });
    expect(html).toContain('Modelo equivalente mais barato em parle-chat: google/gemini-2.5-flash-lite');
    expect(html).toContain('PUT /v1/apps/parle/routes: em parle-chat, openrouter:google/gemini-2.5-flash-lite antes de openrouter:google/gemini-2.5-flash');
    expect(html).toMatch(/~€\s7,77\/mês/);
    expect(cheaper(demoSnapshot(NOW, 'ok'))).toEqual([]);
  });
});
