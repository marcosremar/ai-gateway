/**
 * Desktop-app field telemetry (src/app-telemetry, docs/app-telemetry.md) behind a stand-in for the proxy: a node:http
 * server that does the API-key check (401) and dispatches the custom routes, as serve.ts does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AppTelemetryStore, createAppTelemetry, dayOf, parseBatch, sanitizeFields, summarize, type StoredAppEvent,
} from '../../../src/app-telemetry';

const KEYS: Record<string, string> = { 'key-ucast': 'ucast', 'key-admin': 'admin' };
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 10, 12);
const INSTALL = '3f2b8c1e-9d4a-4e6b-8f00-1a2b3c4d5e6f';

interface Gw { url: string; server: Server; tel: ReturnType<typeof createAppTelemetry>; clock: { now: number }; close(): Promise<void> }

const open: Gw[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const g of open.splice(0)) await g.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(opts: { dir?: string | null; env?: Record<string, string> } = {}): Promise<Gw> {
  const clock = { now: T0 };
  const userOf = (t: string) => KEYS[t] ?? null;
  const bearer = (h: unknown) => String(h ?? '').replace(/^Bearer\s+/i, '');
  const tel = createAppTelemetry({
    env: opts.env ?? {},
    store: new AppTelemetryStore({ dir: opts.dir ?? null, retentionDays: Number(opts.env?.APP_TELEMETRY_RETENTION_DAYS ?? 365) }),
    userOf: (req) => userOf(bearer(req.headers.authorization)) ?? 'anonymous',
    isAdminToken: (t) => userOf(t) === 'admin',
    now: () => clock.now,
    sweepIntervalMs: 0,
  });
  const server = createServer((req, res) => {
    if (!userOf(bearer(req.headers.authorization))) { res.writeHead(401); res.end('{"error":"proxy auth"}'); return; }
    const path = (req.url ?? '/').split('?')[0];
    const route = tel.routes.find(r => r.method === req.method && r.path === path);
    if (route) { void route.handler(req, res); return; }
    res.writeHead(404); res.end('{}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const gw: Gw = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, tel, clock,
    close: async () => { tel.stop(); server.closeAllConnections?.(); await new Promise<void>(r => server.close(() => r())); },
  };
  open.push(gw);
  return gw;
}

const post = (gw: Gw, body: unknown, key = 'key-ucast') => fetch(`${gw.url}/v1/telemetry/app/events`, {
  method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const get = (gw: Gw, path: string, key = 'key-admin') => fetch(`${gw.url}${path}`, { headers: { Authorization: `Bearer ${key}` } });

const batch = (events: unknown[], over: Record<string, unknown> = {}) => ({ installId: INSTALL, appVersion: '0.9.3', os: 'windows', events, ...over });
const ev = (kind: string, fields: Record<string, unknown> = {}, ts = T0 - 1000) => ({ ts, kind, fields });

describe('parseBatch / sanitizeFields', () => {
  it('strips transcript text keys at any depth and keeps metrics', () => {
    const b = parseBatch(batch([ev('utterance', {
      total_ms: 800, original: 'o cofre é 4471', translated: 'the safe is 4471', translated_2: 'x', Text: 'y',
      llm: [{ lang: 'en', ms: 300, text: 'leak' }], nested: { transcript: 'leak', ok: true },
    })]), T0);
    const f = b.events[0]!.fields;
    expect(JSON.stringify(f)).not.toMatch(/4471|leak/);
    expect(f).toEqual({ total_ms: 800, llm: [{ lang: 'en', ms: 300 }], nested: { ok: true } });
  });

  it('rejects unknown kinds, long strings, bad envelope, deep nesting', () => {
    expect(() => parseBatch(batch([ev('keylogger')]), T0)).toThrow(/kind/);
    expect(() => parseBatch(batch([ev('error', { code: 'x'.repeat(257) })]), T0)).toThrow(/longer than 256/);
    expect(() => parseBatch(batch([ev('error')], { installId: 'nope' }), T0)).toThrow(/installId/);
    expect(() => parseBatch(batch([ev('error')], { os: 'win dows' }), T0)).toThrow(/os/);
    expect(() => parseBatch(batch([]), T0)).toThrow(/non-empty/);
    expect(() => parseBatch(batch([ev('error', {}, T0 + 3 * DAY)]), T0)).toThrow(/ts/);
    expect(() => sanitizeFields({ a: { b: { c: { d: { e: 1 } } } } })).toThrow(/deeper/);
    expect(sanitizeFields({ a: { b: { c: { d: 1 } } } })).toEqual({ a: { b: { c: { d: 1 } } } });
    expect(sanitizeFields({ a: [{ ms: 1 }] })).toEqual({ a: [{ ms: 1 }] });
  });
});

describe('POST /v1/telemetry/app/events', () => {
  it('needs a gateway key (proxy auth)', async () => {
    const gw = await start();
    expect((await post(gw, batch([ev('app_start')]), 'wrong')).status).toBe(401);
  });

  it('stores a batch durably by receive day, without text, stamped with the key user', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apptel-')); dirs.push(dir);
    const gw = await start({ dir });
    const r = await post(gw, batch([ev('session_start', { dubbing: true, session: 's1' }), ev('utterance', { total_ms: 900, original: 'segredo' })]));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ accepted: 2 });
    expect(readdirSync(dir)).toEqual([`${dayOf(T0)}.jsonl`]);
    const text = readFileSync(join(dir, `${dayOf(T0)}.jsonl`), 'utf8');
    expect(text).not.toContain('segredo');
    const rows = text.trim().split('\n').map(l => JSON.parse(l) as StoredAppEvent);
    expect(rows.map(r => [r.kind, r.app, r.installId, r.rxTs])).toEqual([['session_start', 'ucast', INSTALL, T0], ['utterance', 'ucast', INSTALL, T0]]);
    // A fresh store over the same dir reads it back (survives a restart).
    const again = new AppTelemetryStore({ dir, retentionDays: 365 });
    expect((await again.read(T0 - DAY, T0)).length).toBe(2);
  });

  it('rejects unknown kinds (400), oversize batches (413) and non-JSON (400)', async () => {
    const gw = await start();
    expect((await post(gw, batch([ev('nope')]))).status).toBe(400);
    expect((await post(gw, '{bad')).status).toBe(400);
    const many = Array.from({ length: 501 }, () => ev('app_start'));
    expect((await post(gw, batch(many))).status).toBe(413);
    const big = Array.from({ length: 400 }, () => ev('error', { code: 'c'.repeat(250), stage: 's'.repeat(250), at: 'a'.repeat(250) }));
    expect((await post(gw, batch(big))).status).toBe(413);
    expect(gw.tel.counters.events).toBe(0);
  });

  it('accepts 500 events and throttles a chatty install (429 + Retry-After)', async () => {
    const gw = await start({ env: { APP_TELEMETRY_BATCHES_PER_MIN: '2' } });
    expect((await post(gw, batch(Array.from({ length: 500 }, () => ev('app_start'))))).status).toBe(200);
    expect((await post(gw, batch([ev('app_exit')]))).status).toBe(200);
    const r = await post(gw, batch([ev('app_exit')]));
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('60');
    gw.clock.now += 61_000;
    expect((await post(gw, batch([ev('app_exit')]))).status).toBe(200);
  });
});

describe('admin reads', () => {
  it('refuse non-admin keys', async () => {
    const gw = await start();
    expect((await get(gw, '/v1/telemetry/app/summary', 'key-ucast')).status).toBe(403);
    expect((await get(gw, '/v1/telemetry/app/events', 'key-ucast')).status).toBe(403);
  });

  it('summary: sessions, crashes by location, delay quantiles, error rates, versions, OS, dubbing, swap', async () => {
    const gw = await start();
    const other = '00000000-0000-4000-8000-000000000001';
    await post(gw, batch([
      ev('app_start'),
      ev('session_start', { dubbing: true, session: 'a' }),
      ...[800, 900, 1000, 1200, 4000].map(t => ev('utterance', { session: 'a', total_ms: t, stt_ms: t / 2, llm: [{ ms: 100 }, { ms: t / 4 }], tts_ms: 50 })),
      ev('error', { stage: 'stt', code: 'http_503' }),
      ev('error', { stage: 'stt', code: 'http_503' }),
      ev('direction_changed', { session: 'a' }),
      ev('session_end', { session: 'a', duration_s: 120 }),
      ev('crash', { location: 'src/session.rs:42' }),
    ]));
    await post(gw, batch([
      ev('session_start', { dubbing: false, session: 'b' }),
      ev('crash', { thread: 'pipeline' }),
      ev('crash', { location: 'src/session.rs:42' }),
      ev('gpu_wait', { ms: 30_000, ok: true }),
      ev('gpu_wait', { ms: 90_000, ok: false }),
    ], { installId: other, appVersion: '0.9.4', os: 'macos' }));
    const r = await get(gw, '/v1/telemetry/app/summary?days=7');
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.days).toBe(7);
    expect(s.installs).toBe(2);
    expect(s.sessions).toMatchObject({ started: 2, ended: 1, totalDurationS: 120 });
    expect(s.crashes).toEqual({ total: 3, byLocation: { 'src/session.rs:42': 2, pipeline: 1 } });
    expect(s.utterances).toBe(5);
    expect(s.utteranceDelay.total).toEqual({ count: 5, p50: 1000, p95: 4000 });
    expect(s.utteranceDelay.llm).toEqual({ count: 5, p50: 250, p95: 1000 });
    expect(s.utteranceDelay.tts.p50).toBe(50);
    expect(s.errors).toEqual({ total: 2, perHundredUtterances: 40, byCode: [{ code: 'stt:http_503', count: 2, perHundredUtterances: 40 }] });
    expect(s.versions).toEqual({ '0.9.3': 1, '0.9.4': 1 });
    expect(s.os).toEqual({ windows: 1, macos: 1 });
    expect(s.dubbing).toEqual({ sessions: 1, rate: 0.5 });
    expect(s.swap).toEqual({ events: 1, installs: 1, sessions: 1 });
    expect(s.gpuWait).toMatchObject({ count: 2, failures: 1 });
  });

  it('summary window follows ?days', async () => {
    const gw = await start();
    await post(gw, batch([ev('app_start')]));
    gw.clock.now += 3 * DAY;
    expect((await (await get(gw, '/v1/telemetry/app/summary?days=1')).json()).events).toBe(0);
    expect((await (await get(gw, '/v1/telemetry/app/summary?days=7')).json()).events).toBe(1);
  });

  it('events: filter by installId, kind, since; newest first; bad kind = 400', async () => {
    const gw = await start();
    await post(gw, batch([ev('app_start'), ev('error', { code: 'timeout' })]));
    gw.clock.now += 60_000;
    await post(gw, batch([ev('error', { code: 'http_500' })], { installId: '00000000-0000-4000-8000-000000000002' }));
    const all = await (await get(gw, '/v1/telemetry/app/events?kind=error&since=1h')).json();
    expect(all.events.map((e: StoredAppEvent) => e.fields.code)).toEqual(['http_500', 'timeout']);
    const one = await (await get(gw, `/v1/telemetry/app/events?installId=${INSTALL.toUpperCase()}`)).json();
    expect(one.total).toBe(2);
    const recent = await (await get(gw, `/v1/telemetry/app/events?since=${T0 + 30_000}`)).json();
    expect(recent.total).toBe(1);
    expect((await get(gw, '/v1/telemetry/app/events?kind=bogus')).status).toBe(400);
  });
});

describe('retention', () => {
  it('sweep deletes day files older than the retention', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apptel-')); dirs.push(dir);
    const gw = await start({ dir, env: { APP_TELEMETRY_RETENTION_DAYS: '30' } });
    await post(gw, batch([ev('app_start')]));
    writeFileSync(join(dir, `${dayOf(T0 - 31 * DAY)}.jsonl`), '{}\n');
    writeFileSync(join(dir, `${dayOf(T0 - 29 * DAY)}.jsonl`), '{}\n');
    writeFileSync(join(dir, 'notes.txt'), 'keep');
    expect(await gw.tel.sweep()).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([`${dayOf(T0 - 29 * DAY)}.jsonl`, `${dayOf(T0)}.jsonl`, 'notes.txt'].sort());
  });

  it('defaults to 365 days, TELEMETRY_RETENTION_DAYS then APP_TELEMETRY_RETENTION_DAYS override', async () => {
    const { storeFromEnv } = await import('../../../src/app-telemetry');
    expect(storeFromEnv({ APP_TELEMETRY_DIR: '/x' }).retentionDays).toBe(365);
    expect(storeFromEnv({ APP_TELEMETRY_DIR: '/x', TELEMETRY_RETENTION_DAYS: '90' }).retentionDays).toBe(90);
    expect(storeFromEnv({ APP_TELEMETRY_DIR: '/x', TELEMETRY_RETENTION_DAYS: '90', APP_TELEMETRY_RETENTION_DAYS: '400' }).retentionDays).toBe(400);
  });
});

describe('summarize (pure)', () => {
  it('handles an empty window', () => {
    const s = summarize([], 0, 1);
    expect(s.events).toBe(0);
    expect(s.utteranceDelay.total).toEqual({ count: 0, p50: null, p95: null });
    expect(s.errors.perHundredUtterances).toBeNull();
  });
});
