import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { _setIpSaltForTests, hashIp, scrubAttrs } from '../../../src/telemetry/scrub';
import { percentile, queryEvents, summarize, timeline } from '../../../src/telemetry/query';
import { parseFileRow, TelemetryStore, type NewTelemetryRow } from '../../../src/telemetry/store';
import type { StoredTelemetryEvent } from '../../../src/telemetry/contract';
import { TRACE } from './_helpers';

describe('telemetry scrubber', () => {
  it('drops text-bearing keys with string values but keeps counts under the same words', () => {
    const { attrs, redacted } = scrubAttrs({
      text: 'je voudrais un café', transcript: 'x', prompt: 'p', content: 'c', audioB64: 'AAAA', apiKey: 'k', secret: 's',
      authorization: 'Bearer x', sessionToken: 'abc',
      textLen: 19, promptTokens: 120, audioMs: 900, hasTranscript: true, code: 'ok',
    });
    expect(attrs).toEqual({ textLen: 19, promptTokens: 120, audioMs: 900, hasTranscript: true, code: 'ok' });
    expect(redacted).toBe(9);
  });

  it('drops strings longer than 200 chars and credential-looking values', () => {
    const { attrs, redacted } = scrubAttrs({
      long: 'a'.repeat(201), ok: 'x '.repeat(100), jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJ4In0.sig', bearer: 'Bearer abc',
      sk: 'sk-or-v1-123', hex: 'f'.repeat(40), reason: 'ice_failed',
    });
    expect(attrs).toEqual({ ok: 'x '.repeat(100), reason: 'ice_failed' });
    expect(redacted).toBe(5);
  });

  it('hashes IP addresses instead of storing them raw', () => {
    _setIpSaltForTests('salt');
    const { attrs } = scrubAttrs({ client: '203.0.113.7', peer: '[2001:db8::1]:3478', v4port: '10.0.0.2:5000', time: '12:30:45' });
    expect(attrs!.client).toBe(hashIp('203.0.113.7'));
    expect(String(attrs!.client)).toMatch(/^ip:[0-9a-f]{12}$/);
    expect(String(attrs!.peer)).toMatch(/^ip:/);
    expect(String(attrs!.v4port)).toMatch(/^ip:/);
    expect(attrs!.time).toBe('12:30:45');
  });

  it('caps the number of keys and refuses odd key names and non-scalars', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(scrubAttrs(many).attrs!)).toHaveLength(32);
    const { attrs, redacted } = scrubAttrs({ 'bad key': 1, ['x'.repeat(65)]: 1, obj: { a: 1 } as unknown as string, nan: NaN, n: null });
    expect(attrs).toEqual({ n: null });
    expect(redacted).toBe(4);
  });
});

let seq = 0;
const row = (over: Partial<StoredTelemetryEvent>): StoredTelemetryEvent => ({
  seq: ++seq, ts: 1000, rxTs: 1000, source: 'gateway', level: 'info', event: 'x.y', traceId: TRACE, ...over,
});

describe('telemetry queries', () => {
  const T2 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const rows = (() => {
    seq = 0;
    return [
      row({ source: 'gateway', event: 'route.served', ts: 2000, rxTs: 2000, durMs: 800 }), // trace only, no session
      row({ source: 'browser', event: 'rt.ice.failed', sessionId: 's1', ts: 1500, rxTs: 4500, level: 'warn' }),
      row({ source: 'edge', event: 'vad.segment', sessionId: 's1', turnId: 't1', ts: 1800, rxTs: 1900, durMs: 300, replicaId: 'r1' }),
      row({ source: 'browser', event: 'rt.ladder.fallback', sessionId: 's1', ts: 1500, rxTs: 4500, level: 'warn' }),
      row({ source: 'gateway', event: 'route.served', traceId: T2, ts: 3000, rxTs: 3000, durMs: 100 }),
      row({ source: 'edge', event: 'turn.done', sessionId: 's2', traceId: T2, ts: 3100, rxTs: 3100, durMs: 2000, level: 'error', replicaId: 'r2' }),
    ];
  })();

  it('timeline merges every source of a session, ordered by ts then arrival, with per-source clock lag', () => {
    const t = timeline(rows, { sessionId: 's1' });
    expect(t.events.map(e => e.event)).toEqual(['rt.ice.failed', 'rt.ladder.fallback', 'vad.segment', 'route.served']);
    expect(t.traceIds).toEqual([TRACE]);
    expect(t.clocks.browser).toEqual({ count: 2, lagMsMedian: 3000, lagMsMin: 3000, lagMsMax: 3000 });
    expect(t.clocks.gateway!.lagMsMedian).toBe(0);
    expect(t.note).toMatch(/rxTs/);
  });

  it('timeline by trace pulls in the sessions seen in that trace', () => {
    const t = timeline(rows, { traceId: T2 });
    expect(t.sessionIds).toEqual(['s2']);
    expect(t.events.map(e => e.event)).toEqual(['route.served', 'turn.done']);
  });

  it('summary counts by level and gives p50/p95 of durMs per group', () => {
    const s = summarize(rows, 'source');
    const bySource = Object.fromEntries(s.groups.map(g => [g.key, g]));
    expect(s.total).toBe(6);
    expect(bySource.gateway).toMatchObject({ count: 2, durMs: { count: 2, p50: 100, p95: 800 } });
    expect(bySource.edge).toMatchObject({ count: 2, levels: { debug: 0, info: 1, warn: 0, error: 1 } });
    expect(bySource.browser).toMatchObject({ count: 2, levels: { warn: 2 }, durMs: { count: 0, p50: null, p95: null } });
    const byReplica = summarize(rows, 'replicaId', { level: 'warn' });
    expect(byReplica.groups.map(g => [g.key, g.count])).toEqual([['(none)', 2], ['r2', 1]]);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });

  it('events pages newest first with a cursor, and filters by event prefix', () => {
    const p1 = queryEvents(rows, {}, { limit: 4 });
    expect(p1.events.map(e => e.seq)).toEqual([6, 5, 4, 3]);
    const p2 = queryEvents(rows, {}, { limit: 4, cursor: p1.nextCursor! });
    expect(p2.events.map(e => e.seq)).toEqual([2, 1]);
    expect(p2.nextCursor).toBeNull();
    expect(queryEvents(rows, { event: 'rt.*' }, { order: 'asc' }).events.map(e => e.event)).toEqual(['rt.ice.failed', 'rt.ladder.fallback']);
    expect(queryEvents(rows, { since: 4000 }).events).toHaveLength(2);
  });
});

describe('telemetry store', () => {
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'aigw-tel-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const newRow = (rxTs: number, over: Partial<NewTelemetryRow> = {}): NewTelemetryRow =>
    ({ ts: rxTs, rxTs, source: 'edge', level: 'info', event: 'vad.segment', traceId: TRACE, ...over });

  it('persists day files and reloads them at boot', async () => {
    const dir = tmp();
    const now = Date.parse('2026-10-07T12:00:00Z');
    const a = new TelemetryStore({ dir, now: () => now });
    a.insert([newRow(now, { attrs: { speechMs: 790 }, sessionId: 's1' }), newRow(now - 86_400_000)]);
    await a.flushed();
    expect(readdirSync(dir).sort()).toEqual(['2026-10-06.jsonl', '2026-10-07.jsonl']);
    const b = new TelemetryStore({ dir, now: () => now });
    await b.init();
    expect(b.rows().map(r => r.seq)).toEqual([1, 2]);
    expect(b.rows()[0]).toMatchObject({ sessionId: 's1', attrs: { speechMs: 790 } });
    expect(b.insert([newRow(now)])[0]!.seq).toBe(3);
  });

  it('retention cleanup removes old rows and old day files', async () => {
    const dir = tmp();
    let now = Date.parse('2026-10-01T12:00:00Z');
    const store = new TelemetryStore({ dir, retentionDays: 2, now: () => now });
    store.insert([newRow(now)]);
    now += 86_400_000;
    store.insert([newRow(now)]);
    await store.flushed();
    now += 3 * 86_400_000;
    store.insert([newRow(now)]);
    const out = await store.cleanup();
    expect(out).toEqual({ removedRows: 2, removedFiles: 2 });
    expect(store.size).toBe(1);
    expect(readdirSync(dir)).toEqual(['2026-10-05.jsonl']);
  });

  it('caps rows in memory (oldest out) and counts the evictions', () => {
    const store = new TelemetryStore({ maxRows: 100 });
    for (let i = 0; i < 120; i++) store.insert([newRow(Date.now())]);
    expect(store.size).toBeLessThanOrEqual(110);
    store.insert(Array.from({ length: 5 }, () => newRow(Date.now())));
    expect(store.size).toBe(100);
    expect(store.rows()[0]!.seq).toBe(26);
    expect(store.evictedByCap).toBe(25);
  });

  it('caps disk use by deleting the oldest day files', async () => {
    const dir = tmp();
    const now = Date.parse('2026-10-07T12:00:00Z');
    writeFileSync(join(dir, '2026-10-05.jsonl'), 'x'.repeat(700_000));
    writeFileSync(join(dir, '2026-10-06.jsonl'), 'x'.repeat(700_000));
    writeFileSync(join(dir, '2026-10-07.jsonl'), 'x'.repeat(10));
    const store = new TelemetryStore({ dir, now: () => now, maxDiskBytes: 1024 * 1024 });
    await store.cleanup();
    expect(readdirSync(dir).sort()).toEqual(['2026-10-06.jsonl', '2026-10-07.jsonl']);
  });

  it('writes only contract fields to disk and ignores foreign lines on reload', async () => {
    const dir = tmp();
    const now = Date.parse('2026-10-07T12:00:00Z');
    const store = new TelemetryStore({ dir, now: () => now });
    store.insert([{ ...newRow(now), extra: 'nope' } as unknown as NewTelemetryRow]);
    await store.flushed();
    const line = readFileSync(join(dir, '2026-10-07.jsonl'), 'utf8').trim();
    expect(JSON.parse(line)).not.toHaveProperty('extra');
    expect(parseFileRow('{"garbage":true}')).toBeNull();
    expect(parseFileRow('not json')).toBeNull();
  });
});
