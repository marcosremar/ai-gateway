/**
 * Viewer analytics events of the live rooms (src/rooms/events.ts): batch validation, rate limit, file store and
 * retention, aggregation, and the HTTP routes (public POST, admin GET + /v1/rooms-analytics).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  EventRateLimiter, FileEventStore, MAX_EVENTS_PER_BATCH, MemoryEventStore, RoomEvents, aggregateEvents, parseEventBatch, percentiles,
  type ViewerEventRecord,
} from '../../../src/rooms/events';
import { createRooms, roomsConfigFromEnv } from '../../../src/rooms';

const V = 'v_0123456789abcdef01234567';
const S = 's_abcdef0123456789abcdef01';
const DAY = 86_400_000;

describe('rooms events: batch validation', () => {
  it('keeps whitelisted fields only, drops unknown types and invalid fields, validates setting values', () => {
    const b = parseEventBatch({
      viewerId: V, sessionId: S, events: [
        { t: 1, type: 'join', ua: 'chrome', os: 'android', device: 'mobile', vw: 412, vh: 860, ref: 'qr', returning: false, ip: '1.2.3.4', lang: 'pt-BR', langs: ['pt-BR', 'en', 7],
          settings: { lang: 'en', mode: 'bilingual', size: 2, dub: false, secret: 'x' } },
        { t: 2, type: 'setting', key: 'mode', value: 'full', from: 'sheet' },
        { t: 3, type: 'setting', key: 'mode', value: 'karaoke' },
        { t: 4, type: 'setting', key: 'lang', value: 'en<script>' },
        { t: 5, type: 'hack', anything: 1 },
        { type: 'leave' },
        { t: 6, type: 'sample', textDelayMs: 1800, driftMs: -40, gaps: 2, visible: 'yes' },
        { t: 7, type: 'audio', action: 'explode' },
      ],
    });
    expect(b.dropped).toBe(5);
    expect(b.events.map(e => e.type)).toEqual(['join', 'setting', 'sample']);
    expect(b.events[0]!.data).toEqual({
      ua: 'chrome', os: 'android', device: 'mobile', vw: 412, vh: 860, lang: 'pt-BR', langs: ['pt-BR', 'en'], ref: 'qr', returning: false,
      settings: { lang: 'en', mode: 'bilingual', dub: false, size: 2 },
    });
    expect(b.events[0]!.data).not.toHaveProperty('ip');
    expect(b.events[2]!.data).toEqual({ textDelayMs: 1800, driftMs: -40, gaps: 2 });
  });

  it('rejects a bad envelope', () => {
    expect(() => parseEventBatch(null)).toThrow(/JSON object/);
    expect(() => parseEventBatch({ viewerId: 'x', sessionId: S, events: [] })).toThrow(/viewerId/);
    expect(() => parseEventBatch({ viewerId: V, sessionId: V, events: [] })).toThrow(/sessionId/);
    expect(() => parseEventBatch({ viewerId: V, sessionId: S, events: {} })).toThrow(/array/);
    const many = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) => ({ t: i, type: 'ui', action: 'copy' }));
    expect(() => parseEventBatch({ viewerId: V, sessionId: S, events: many })).toThrow(/at most/);
  });
});

describe('rooms events: rate limit', () => {
  it('limits batches per viewer and per IP within a minute, then lets them through again', () => {
    const clock = { now: 0 };
    const rl = new EventRateLimiter(2, 3, () => clock.now);
    rl.admit('v_a', '10.0.0.1');
    rl.admit('v_a', '10.0.0.1');
    expect(() => rl.admit('v_a', '10.0.0.1')).toThrow(/too many/);
    rl.admit('v_b', '10.0.0.1');
    expect(() => rl.admit('v_c', '10.0.0.1')).toThrow(/too many/); // IP budget
    rl.admit('v_c', '10.0.0.2');
    clock.now = 60_000;
    rl.admit('v_a', '10.0.0.1');
    expect(rl.ipKey('10.0.0.1')).not.toContain('10.0.0.1');
  });
});

describe('rooms events: store and retention', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'room-events-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const rec = (ts: number, code = 'ABCDEF', type: ViewerEventRecord['type'] = 'ui'): ViewerEventRecord =>
    ({ ts, t: ts, code, viewerId: V, sessionId: S, type, data: { action: 'copy' } });

  it('files per UTC day and room, reads back by room and in total, expires whole days past the retention', async () => {
    const store = new FileEventStore(dir);
    const d0 = Date.UTC(2026, 0, 1, 12);
    await store.append([rec(d0), rec(d0 + 1, 'ZZZZZZ'), rec(d0 + 2 * DAY), rec(d0 + 400 * DAY)]);
    expect(readdirSync(dir).sort()).toEqual(['2026-01-01', '2026-01-03', '2027-02-05']);
    expect(readFileSync(join(dir, '2026-01-01', 'ABCDEF.jsonl'), 'utf8')).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect((await store.read('ABCDEF', 0)).length).toBe(3);
    expect((await store.read('ABCDEF', d0 + DAY)).length).toBe(2);
    expect((await store.readAll(0)).length).toBe(4);
    // 365-day retention seen from d0 + 400 days: the first two days go, the last stays.
    const events = new RoomEvents({ store, retentionMs: 365 * DAY, now: () => d0 + 400 * DAY, sweepIntervalMs: 0 });
    expect(await events.sweep()).toBe(2);
    expect(readdirSync(dir)).toEqual(['2027-02-05']);
    events.stop();
  });

  it('memory store sweeps the same way', async () => {
    const store = new MemoryEventStore();
    await store.append([rec(0), rec(10 * DAY)]);
    expect(await store.sweep(5 * DAY)).toBe(1);
    expect(store.records.length).toBe(1);
  });

  it('reads ROOM_EVENTS_RETENTION_DAYS (default 365)', () => {
    expect(roomsConfigFromEnv({}).eventsRetentionMs).toBe(365 * DAY);
    expect(roomsConfigFromEnv({ ROOM_EVENTS_RETENTION_DAYS: '730' }).eventsRetentionMs).toBe(730 * DAY);
    expect(roomsConfigFromEnv({ ROOM_EVENTS_RETENTION_DAYS: 'nope' }).eventsRetentionMs).toBe(365 * DAY);
  });
});

describe('rooms events: aggregation', () => {
  const ev = (sessionId: string, viewerId: string, t: number, type: ViewerEventRecord['type'], data: Record<string, unknown>, code = 'ABCDEF'): ViewerEventRecord =>
    ({ ts: t, t, code, viewerId, sessionId, type, data });

  it('counts viewers/sessions, watch time, final language/mode per session, delays and drift percentiles', () => {
    const recs = [
      ev('s_1', 'v_a', 0, 'join', { device: 'mobile', ua: 'chrome', ref: 'qr', returning: false, settings: { lang: 'en', mode: 'translation' } }),
      ev('s_1', 'v_a', 5_000, 'setting', { key: 'lang', value: 'es', from: 'toolbar' }),
      ev('s_1', 'v_a', 6_000, 'setting', { key: 'dub', value: true, from: 'toolbar' }),
      ev('s_1', 'v_a', 30_000, 'sample', { textDelayMs: 1000, voiceDelayMs: 3000, driftMs: 10, gaps: 1, gapMs: 200, drops: 0 }),
      ev('s_1', 'v_a', 60_000, 'sample', { textDelayMs: 2000, voiceDelayMs: 4000, driftMs: 30, gaps: 0, gapMs: 0, drops: 2 }),
      ev('s_1', 'v_a', 61_000, 'leave', { durationMs: 61_000, visibleMs: 50_000 }),
      ev('s_2', 'v_b', 0, 'join', { device: 'desktop', ua: 'safari', ref: 'direct', returning: true, settings: { lang: 'en', mode: 'full' } }),
      ev('s_2', 'v_b', 19_000, 'sample', { textDelayMs: 9000 }),
      ev('s_2', 'v_b', 3_000, 'audio', { action: 'decode_error' }),
      ev('s_3', 'v_b', 0, 'join', { device: 'desktop', settings: { lang: 'en', mode: 'translation' } }, 'ZZZZZZ'),
    ];
    const a = aggregateEvents(recs, 0, 100_000);
    expect(a).toMatchObject({
      events: 10, rooms: 2, viewers: 2, sessions: 3, returningViewers: 1,
      devices: { mobile: 1, desktop: 2 }, browsers: { chrome: 1, safari: 1 }, referrers: { qr: 1, direct: 1 },
      languages: { es: 1, en: 2 }, modes: { translation: 2, full: 1 }, dubbingSessions: 1,
      settingChanges: { lang: 1, dub: 1 },
      textDelayMs: { n: 3, p50: 2000, p95: 9000 }, voiceDelayMs: { n: 2, p50: 3000, p95: 4000 }, driftMs: { n: 2, p50: 10, p95: 30 },
      audio: { gaps: 1, gapMs: 200, drops: 2, decodeErrors: 1 },
    });
    // s_1 left after 61 s; s_2 has no leave: last − first = 19 s; s_3 a single event = 0.
    expect(a.avgWatchMs).toBe(Math.round((61_000 + 19_000 + 0) / 3));
  });

  it('percentiles: nearest rank', () => {
    expect(percentiles([])).toEqual({ n: 0, p50: null, p95: null });
    expect(percentiles(Array.from({ length: 100 }, (_, i) => i + 1))).toEqual({ n: 100, p50: 50, p95: 95 });
  });
});

describe('rooms events: HTTP', () => {
  const KEYS: Record<string, { userId: string; admin: boolean }> = { 'key-admin': { userId: 'admin', admin: true }, 'key-user': { userId: 'u', admin: false } };
  let server: Server;
  let url: string;
  let rooms: ReturnType<typeof createRooms>;

  beforeEach(async () => {
    rooms = createRooms({
      env: {}, config: { dir: null, publicHost: '' }, keyUser: (t) => KEYS[t] ?? null, userOf: () => 'u', sweepIntervalMs: 0,
    });
    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/rooms') { void rooms.route.handler(req, res); return; }
      res.writeHead(404); res.end();
    });
    rooms.mount(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    rooms.stop();
    server.closeAllConnections?.();
    await new Promise<void>(r => server.close(() => r()));
  });

  const json = { 'Content-Type': 'application/json' };
  const batch = (events: unknown[], viewerId = V) => JSON.stringify({ viewerId, sessionId: S, events });

  it('accepts batches for an existing room, rate-limits, and serves them back only to an admin key', async () => {
    const created = await fetch(`${url}/v1/rooms`, { method: 'POST', headers: json, body: JSON.stringify({ languages: ['en'] }) });
    const { code } = await created.json() as { code: string };
    const post = (body: string, c = code) => fetch(`${url}/v1/rooms/${c}/events`, { method: 'POST', headers: { ...json, 'X-Forwarded-For': '203.0.113.9' }, body });

    const ok = await post(batch([{ t: 1, type: 'join', device: 'mobile', settings: { lang: 'en', mode: 'translation' } }, { t: 2, type: 'nope' }]));
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ accepted: 1, dropped: 1 });
    expect((await post(batch([]), 'ZZZZZZ')).status).toBe(404);
    expect((await post('{"viewerId":1}')).status).toBe(400);
    expect((await post('x'.repeat(70_000))).status).toBe(413);

    for (let i = 0; i < 29; i++) await post(batch([{ t: 10 + i, type: 'ui', action: 'copy' }]));
    const limited = await post(batch([{ t: 99, type: 'ui', action: 'copy' }]));
    expect(limited.status).toBe(429);

    const get = (key?: string, path = `/v1/rooms/${code}/events`) => fetch(`${url}${path}`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
    expect((await get()).status).toBe(401);
    expect((await get('key-user')).status).toBe(403);
    const list = await (await get('key-admin')).json() as { count: number; events: ViewerEventRecord[] };
    expect(list.count).toBe(30);
    expect(list.events[0]).toMatchObject({ code, viewerId: V, sessionId: S, type: 'join', data: { device: 'mobile' } });
    expect(JSON.stringify(list)).not.toContain('203.0.113.9');

    expect((await get('key-user', '/v1/rooms-analytics')).status).toBe(403);
    const a = await (await get('key-admin', `/v1/rooms-analytics?days=7&code=${code.toLowerCase()}`)).json() as Record<string, unknown>;
    expect(a).toMatchObject({ rooms: 1, viewers: 1, sessions: 1, languages: { en: 1 }, modes: { translation: 1 } });
    expect((await get('key-admin', '/v1/rooms-analytics?code=bad!')).status).toBe(400);
  });
});
