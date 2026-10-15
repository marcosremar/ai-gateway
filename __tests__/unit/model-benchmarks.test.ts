import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminGate } from '../../src/config/admin-gate';
import { createProxyServer } from '../../src/gateway/proxy/server';
import { benchmarkId, rankBenchmarks, type ModelBenchmark } from '../../src/model-benchmarks/benchmark';
import { createModelBenchmarkRoutes } from '../../src/model-benchmarks/routes';
import { ModelBenchmarkStore } from '../../src/model-benchmarks/store';

const base = {
  task: 'stt' as const, dataset: 'elevenlabs-pt-l2-v1', measuredAt: '2026-10-10T12:00:00Z', n: 100, rulerVersion: 'r1',
  werConsensus: null, fidelity: null, ttftP95Ms: 900, ttftStreaming: false, latencyP50Ms: 500, latencyP95Ms: 900, emptyRate: 0,
};

function row(over: Partial<ModelBenchmark> & { provider: string; model: string; werSilver: number; ttftP50Ms: number; costPer1kUsd: number }): ModelBenchmark {
  const b = { ...base, ...over };
  return { ...b, id: benchmarkId(b) };
}

describe('rankBenchmarks', () => {
  it('weights min-max components; fidelity null in any row moves its weight to the others', () => {
    const a = row({ provider: 'groq', model: 'a', werSilver: 0.1, ttftP50Ms: 300, costPer1kUsd: 0.2 });
    const b = row({ provider: 'openrouter', model: 'b', werSilver: 0.2, ttftP50Ms: 100, costPer1kUsd: 0.1 });
    const [first, second] = rankBenchmarks([a, b]);
    expect(first.model).toBe('a');
    expect(first.score).toBeCloseTo(0.35 / 0.65);
    expect(second.score).toBeCloseTo(0.3 / 0.65);
  });

  it('uses fidelity (higher is better) when every row has it, and werConsensus only when every row has it', () => {
    const a = row({ provider: 'p', model: 'a', werSilver: 0.1, werConsensus: 0.3, fidelity: 0.5, ttftP50Ms: 100, costPer1kUsd: 0.1 });
    const b = row({ provider: 'p', model: 'b', werSilver: 0.3, werConsensus: 0.1, fidelity: 0.9, ttftP50Ms: 100, costPer1kUsd: 0.1 });
    const [first] = rankBenchmarks([a, b]);
    expect(first.model).toBe('b');
    expect(first.score).toBeCloseTo(1);
    const c = { ...b, werConsensus: null, id: 'c' };
    const ranked = rankBenchmarks([c, a]);
    expect(ranked.map(r => [r.model, r.score])).toEqual([['a', expect.closeTo(0.65)], ['b', expect.closeTo(0.65)]]);
  });

  it('penalises emptyRate above 5 % by (1 - emptyRate)', () => {
    const a = row({ provider: 'p', model: 'a', werSilver: 0.1, ttftP50Ms: 100, costPer1kUsd: 0.1, emptyRate: 0.2 });
    const b = row({ provider: 'p', model: 'b', werSilver: 0.1, ttftP50Ms: 100, costPer1kUsd: 0.1, emptyRate: 0.05 });
    const ranked = rankBenchmarks([a, b]);
    expect(ranked.map(r => [r.model, r.score])).toEqual([['b', 1], ['a', expect.closeTo(0.8)]]);
  });

  it('breaks a tie by the lower WER', () => {
    const a = row({ provider: 'p', model: 'a', werSilver: 0.2, ttftP50Ms: 100, costPer1kUsd: 0.2 });
    const b = row({ provider: 'p', model: 'b', werSilver: 0.1, ttftP50Ms: 300, costPer1kUsd: 0.1 });
    const ranked = rankBenchmarks([a, b], { accuracy: 0, fidelity: 0, ttft: 0.5, cost: 0.5 });
    expect(ranked[0].score).toBeCloseTo(ranked[1].score);
    expect(ranked[0].model).toBe('b');
  });
});

describe('ModelBenchmarkStore', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });

  it('upserts by id, writes atomically and reloads', async () => {
    dir = await mkdtemp(join(tmpdir(), 'bench-'));
    const path = join(dir, 'model-benchmarks.json');
    const store = new ModelBenchmarkStore(path);
    await store.load();
    const a = row({ provider: 'groq', model: 'a', werSilver: 0.1, ttftP50Ms: 100, costPer1kUsd: 0.1 });
    await store.upsert([a, row({ provider: 'groq', model: 'b', werSilver: 0.2, ttftP50Ms: 100, costPer1kUsd: 0.1 })]);
    await store.upsert([{ ...a, werSilver: 0.05 }]);
    expect(store.list()).toHaveLength(2);
    expect(JSON.parse(await readFile(path, 'utf8')).benchmarks).toHaveLength(2);
    await store.upsert([{ ...a, werSilver: 0.06 }]);
    expect(JSON.parse(await readFile(`${path}.bak`, 'utf8')).benchmarks[0].werSilver).toBe(0.05);
    const reloaded = new ModelBenchmarkStore(path);
    await reloaded.load();
    expect(reloaded.list({ task: 'stt', dataset: 'elevenlabs-pt-l2-v1' }).find(b => b.id === a.id)?.werSilver).toBe(0.06);
    expect(reloaded.list({ dataset: 'other' })).toEqual([]);
    expect(reloaded.rankOrder('stt', 'elevenlabs-pt-l2-v1')).toEqual(new Map([['groq:a', 0], ['groq:b', 1]]));
  });

  it('recovers from the backup when the main file is corrupt', async () => {
    dir = await mkdtemp(join(tmpdir(), 'bench-'));
    const path = join(dir, 'model-benchmarks.json');
    const store = new ModelBenchmarkStore(path);
    await store.upsert([row({ provider: 'groq', model: 'a', werSilver: 0.1, ttftP50Ms: 100, costPer1kUsd: 0.1 })]);
    await store.upsert([row({ provider: 'groq', model: 'b', werSilver: 0.1, ttftP50Ms: 100, costPer1kUsd: 0.1 })]);
    await writeFile(path, '{not json');
    const reloaded = new ModelBenchmarkStore(path);
    await reloaded.load();
    expect(reloaded.recovered).toBeTruthy();
    expect(reloaded.list()).toHaveLength(1);
  });
});

describe('admin benchmark routes', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve(); server = null; }));

  async function start(store: ModelBenchmarkStore, onChange: () => void): Promise<string> {
    server = createProxyServer({
      apiKeys: ['admin-key:sandbox', 'user-key:alice'],
      providers: {},
      customRoutes: createModelBenchmarkRoutes({ store, gate: new AdminGate({ actorOf: (t) => (t === 'admin-key' ? 'sandbox' : null) }), onChange }),
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/admin/benchmarks`;
  }

  const input = (model: string, werSilver: number) => ({
    ...base, provider: 'openrouter', model, werSilver, ttftP50Ms: 200, costPer1kUsd: 0.1,
  });
  const admin = { Authorization: 'Bearer admin-key', 'Content-Type': 'application/json' };

  it('needs the admin key; POST upserts one or many, GET filters, ranking orders with scores, DELETE removes', async () => {
    const onChange = vi.fn();
    const url = await start(new ModelBenchmarkStore(null), onChange);
    expect((await fetch(url, { headers: { Authorization: 'Bearer user-key' } })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer user-key' }, body: JSON.stringify(input('x', 0.1)) })).status).toBe(403);

    const one = await fetch(url, { method: 'POST', headers: admin, body: JSON.stringify(input('openai/whisper-large-v3-turbo', 0.2)) });
    expect(one.status).toBe(200);
    const many = await fetch(url, { method: 'POST', headers: admin, body: JSON.stringify({ benchmarks: [input('openai/whisper-large-v3-turbo', 0.3), { ...input('m2', 0.1), dataset: 'other' }] }) });
    expect((await many.json()).saved).toHaveLength(2);
    expect(onChange).toHaveBeenCalledTimes(2);

    const all = await (await fetch(url, { headers: admin })).json();
    expect(all.benchmarks).toHaveLength(2);
    const filtered = await (await fetch(`${url}?task=stt&dataset=elevenlabs-pt-l2-v1`, { headers: admin })).json();
    expect(filtered.benchmarks.map((b: ModelBenchmark) => [b.model, b.werSilver])).toEqual([['openai/whisper-large-v3-turbo', 0.3]]);

    await fetch(url, { method: 'POST', headers: admin, body: JSON.stringify(input('m3', 0.1)) });
    const ranking = await (await fetch(`${url}/ranking?task=stt&dataset=elevenlabs-pt-l2-v1`, { headers: admin })).json();
    expect(ranking.ranking.map((r: { model: string; score: number }) => [r.model, r.score])).toEqual([['m3', 1], ['openai/whisper-large-v3-turbo', expect.closeTo(0.3 / 0.65)]]);
    expect((await fetch(`${url}/ranking?task=stt`, { headers: admin })).status).toBe(400);

    const bad = await fetch(url, { method: 'POST', headers: admin, body: JSON.stringify({ ...input('m4', 1.5) }) });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain('werSilver');

    const id = ranking.ranking[0].id as string;
    expect((await fetch(`${url}?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: admin })).status).toBe(200);
    expect((await fetch(`${url}?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: admin })).status).toBe(404);
  });
});
