import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelemetry, newTraceId, traceparentOf, type TelemetryEmitterOptions } from '../../../sdk/browser/telemetry';
import { createServerTelemetry } from '../../../sdk/node/telemetry';
import { TelemetryEventSchema } from '../../../src/telemetry/schema';

type Call = { url: string; init: RequestInit & { headers: Record<string, string> } };

function fakeFetch(statuses: number[] = []) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: Call['init']) => {
    calls.push({ url, init });
    const status = statuses.length ? statuses.shift()! : 200;
    return new Response('{}', { status });
  });
  return { fn: fn as unknown as typeof fetch, calls, bodies: () => calls.map(c => JSON.parse(String(c.init.body)).events as Array<Record<string, unknown>>) };
}

class FakeTarget {
  private handlers = new Map<string, Array<(e: Event) => void>>();
  addEventListener(type: string, fn: (e: Event) => void) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: (e: Event) => void) { this.handlers.set(type, (this.handlers.get(type) ?? []).filter(f => f !== fn)); }
  fire(type: string, extra: Record<string, unknown> = {}) { for (const fn of this.handlers.get(type) ?? []) fn(Object.assign(new Event(type), extra)); }
  count(type: string) { return this.handlers.get(type)?.length ?? 0; }
}

const make = (over: Partial<TelemetryEmitterOptions> = {}) => {
  const f = fakeFetch();
  const target = new FakeTarget();
  const t = createTelemetry({ endpoint: 'https://gw.test/', token: 'session.jwt.token', sessionId: 's-1', fetch: f.fn, target, ...over });
  return { t, f, target };
};

describe('browser telemetry emitter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('emits contract-valid events with the session context and a stable trace id', async () => {
    const { t, f } = make();
    t.setContext({ turnId: 't-1' });
    t.emit('rt.ladder.fallback', { level: 'warn', durMs: 12.4, attrs: { from: 'webrtc', to: 'ws', obj: undefined } });
    await t.flush();
    expect(f.calls[0]!.url).toBe('https://gw.test/v1/telemetry/events');
    expect(f.calls[0]!.init.headers.Authorization).toBe('Bearer session.jwt.token');
    expect(f.calls[0]!.init.headers.traceparent).toMatch(new RegExp(`^00-${t.traceId}-[0-9a-f]{16}-01$`));
    const [e] = f.bodies()[0]!;
    expect(TelemetryEventSchema.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({ source: 'browser', level: 'warn', event: 'rt.ladder.fallback', traceId: t.traceId, sessionId: 's-1', turnId: 't-1', durMs: 12, attrs: { from: 'webrtc', to: 'ws' } });
  });

  it('flushes every 5 s, and immediately at maxBatch events', async () => {
    const { t, f } = make({ maxBatch: 3 });
    t.emit('vad.segment');
    expect(f.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.calls).toHaveLength(1);
    t.emit('vad.segment'); t.emit('vad.segment'); t.emit('vad.segment');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(2);
    expect(f.bodies()[1]).toHaveLength(3);
  });

  it('bounded queue: drops the oldest, counts them and reports one telemetry.dropped event', async () => {
    const { t, f } = make({ maxQueue: 3, maxBatch: 50 });
    for (let i = 0; i < 5; i++) t.emit('vad.segment', { attrs: { i } });
    expect(t.stats.dropped).toBe(2);
    await t.flush();
    const sent = f.bodies()[0]!;
    expect(sent[0]).toMatchObject({ event: 'telemetry.dropped', level: 'warn', attrs: { count: 2 } });
    expect(sent.slice(1).map(e => (e.attrs as { i: number }).i)).toEqual([2, 3, 4]);
  });

  it('keeps the batch on 503/429/network errors and drops it on 4xx', async () => {
    const f = fakeFetch([503, 200, 400]);
    const t = createTelemetry({ endpoint: 'https://gw.test', token: 'x.y.z', fetch: f.fn, target: null });
    t.emit('turn.done');
    await t.flush();
    expect(t.stats.queued).toBe(1);
    await t.flush();
    expect(t.stats.sent).toBe(1);
    t.emit('turn.done');
    await t.flush();
    expect(t.stats.failed).toBe(1);
    expect(t.stats.queued).toBe(0);
  });

  it('never throws into the app (fetch throwing, bad names, token getter throwing)', async () => {
    const t = createTelemetry({
      endpoint: 'https://gw.test', target: null,
      fetch: (() => { throw new Error('offline'); }) as unknown as typeof fetch,
      token: () => { throw new Error('no session'); },
    });
    expect(() => t.emit('Bad Name')).not.toThrow();
    expect(() => t.emit('rt.ice.failed')).not.toThrow();
    await expect(t.flush()).resolves.toBeUndefined();
    expect(t.stats.queued).toBe(1);
  });

  it('on pagehide sends a beacon (text/plain, token in the body) and falls back to fetch keepalive', async () => {
    const beacons: Array<{ url: string; body: string; type: string }> = [];
    let accept = true;
    const sendBeacon = vi.fn((url: string, data: Blob | string) => {
      if (!accept) return false;
      void (data as Blob).text().then(body => beacons.push({ url, body, type: (data as Blob).type }));
      return true;
    });
    const { t, f, target } = make({ sendBeacon });
    t.emit('rt.session.end');
    target.fire('pagehide');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(0);
    expect(beacons[0]!.url).toBe('https://gw.test/v1/telemetry/events');
    expect(beacons[0]!.type).toBe('text/plain;charset=utf-8');
    expect(JSON.parse(beacons[0]!.body)).toMatchObject({ token: 'session.jwt.token', events: [{ event: 'rt.session.end' }] });

    accept = false; // beacon refused (queue full / too large) → keepalive fetch with the Authorization header
    t.emit('rt.session.end');
    target.fire('pagehide');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.init.keepalive).toBe(true);
    expect(f.calls[0]!.init.headers.Authorization).toBe('Bearer session.jwt.token');
  });

  it('captures window errors only when the app opts in, without the message text', async () => {
    const off = make();
    expect(off.target.count('error')).toBe(0);
    const on = make({ captureErrors: true });
    on.target.fire('error', { error: { name: 'TypeError', message: 'student said bonjour' }, filename: 'https://app/x/main.js?v=1', lineno: 3, colno: 9 });
    on.target.fire('unhandledrejection', { reason: { name: 'AbortError' } });
    await on.t.flush();
    const sent = on.f.bodies()[0]!;
    expect(sent.map(e => e.attrs)).toEqual([
      { kind: 'error', name: 'TypeError', file: 'main.js', line: 3, col: 9 },
      { kind: 'unhandledrejection', name: 'AbortError' },
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/bonjour/);
    await on.t.close();
    expect(on.target.count('error')).toBe(0);
  });

  it('splits large queues into batches under the server limits', async () => {
    const { t, f } = make({ maxBatch: 100, maxQueue: 1000 });
    for (let i = 0; i < 250; i++) t.emit('vad.segment', { attrs: { pad: 'x'.repeat(190) } });
    await t.flush();
    for (const body of f.calls.map(c => String(c.init.body))) expect(Buffer.byteLength(body)).toBeLessThanOrEqual(64 * 1024);
    expect(f.bodies().flat()).toHaveLength(250);
    expect(Math.max(...f.bodies().map(b => b.length))).toBeLessThanOrEqual(100);
  });

  it('trace helpers make W3C ids', () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(traceparentOf('4bf92f3577b34da6a3ce929d0e0e4736')).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
  });
});

describe('node server telemetry', () => {
  it('authenticates with the app key, never beacons, and sends the declared source', async () => {
    const f = fakeFetch();
    const t = createServerTelemetry({ endpoint: 'https://gw.test', apiKey: 'app-key', source: 'model', fetch: f.fn, flushOnExit: false });
    t.emit('turn.done', { sessionId: 's-9', durMs: 2300 });
    await t.close();
    const own = createServerTelemetry({ endpoint: 'https://gw.test', apiKey: 'app-key', fetch: f.fn, flushOnExit: false });
    own.emit('lesson.started');
    await own.close();
    expect(f.bodies()[1]![0]).toMatchObject({ source: 'app', event: 'lesson.started' });
    expect(f.calls[0]!.init.headers.Authorization).toBe('Bearer app-key');
    expect(f.bodies()[0]![0]).toMatchObject({ source: 'model', sessionId: 's-9', durMs: 2300 });
  });
});
