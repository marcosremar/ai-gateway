import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import { createProxyServer } from '../../../src/proxy/server';
import { createTelemetryRoutes, eventToSpan, parseTime } from '../../../src/telemetry/http';
import { TelemetryIngest } from '../../../src/telemetry/ingest';
import { TelemetryStore } from '../../../src/telemetry/store';
import { edgeTelemetrySignature } from '../../../src/telemetry/auth';
import { emitGatewayEvent, setGatewayTelemetrySink } from '../../../src/telemetry/emit';
import { deploymentLogToTelemetry } from '../../../src/telemetry/gateway-events';
import { outgoingTraceHeaders, parseTraceparent, traceOfRequest } from '../../../src/telemetry/trace-context';
import { withLogContext } from '../../../src/logger';
import { runTargets } from '../../../src/gateway/proxy/provider-routing';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { applySttFilter } from '../../../src/gateway/proxy/routes/stt-filter';
import type { TelemetryEvent } from '../../../src/telemetry/contract';
import { authDeps, DEP_TOKEN, ev, sessionToken, TRACE } from './_helpers';

describe('telemetry over HTTP (proxy public + admin routes)', () => {
  let server: Server;
  let base: string;
  let store: TelemetryStore;

  beforeEach(async () => {
    store = new TelemetryStore();
    const ingest = new TelemetryIngest(store);
    const routes = createTelemetryRoutes({ store, ingest, auth: authDeps(), isAdminToken: (t) => t === 'admin-key' });
    server = createProxyServer({
      apiKeys: ['app-key:parle', 'admin-key:ops'], providers: {},
      publicRoutes: routes.publicRoutes, customRoutes: routes.adminRoutes,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(() => { server.close(); });

  const post = (body: unknown, headers: Record<string, string>) => fetch(`${base}/v1/telemetry/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  it('a browser session token is accepted without an app key (the route authenticates itself)', async () => {
    const res = await post({ events: [ev()] }, { Authorization: `Bearer ${sessionToken({ sid: 's-http' })}`, Origin: 'https://parle.app' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 1 });
    expect(store.rows()[0]).toMatchObject({ sessionId: 's-http', app: 'parle', source: 'browser' });
  });

  it('a beacon (text/plain, token in the body) is accepted', async () => {
    const res = await fetch(`${base}/v1/telemetry/events`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ token: sessionToken({}), events: [ev({ event: 'rt.session.end' })] }),
    });
    expect(res.status).toBe(200);
    expect(store.rows()[0]).toMatchObject({ event: 'rt.session.end' });
  });

  it('the edge signs with HMAC(replicaToken) + X-Aigw-Replica', async () => {
    const ok = await post({ events: [ev({ source: 'edge' })] }, { Authorization: `Bearer ${edgeTelemetrySignature(DEP_TOKEN)}`, 'X-Aigw-Replica': 'r-1' });
    expect(ok.status).toBe(200);
    const bad = await post({ events: [ev()] }, { Authorization: `Bearer ${edgeTelemetrySignature('wrong')}`, 'X-Aigw-Replica': 'r-1' });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ code: 'bad_edge_signature' });
  });

  it('refuses an oversized body with 413 and bad JSON with 400, never 500', async () => {
    const big = await post({ events: [ev({ attrs: { pad: 'x'.repeat(70_000) } })] }, { Authorization: 'Bearer app-key' });
    expect(big.status).toBe(413);
    const notJson = await fetch(`${base}/v1/telemetry/events`, { method: 'POST', headers: { Authorization: 'Bearer app-key' }, body: '{' });
    expect(notJson.status).toBe(400);
  });

  it('query routes need an admin key; timeline/summary/events/stats answer', async () => {
    await post({ events: [ev({ sessionId: 's1', durMs: 120 }), ev({ sessionId: 's1', level: 'warn', event: 'rt.ladder.fallback' })] }, { Authorization: 'Bearer app-key' });
    const get = (path: string, key: string) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${key}` } });
    expect((await get('/v1/telemetry/timeline?sessionId=s1', 'app-key')).status).toBe(403);
    const t = await (await get('/v1/telemetry/timeline?sessionId=s1', 'admin-key')).json() as { events: unknown[]; clocks: object };
    expect(t.events).toHaveLength(2);
    const s = await (await get('/v1/telemetry/summary?since=1h&groupBy=event', 'admin-key')).json() as { groups: Array<{ key: string }> };
    expect(s.groups.map(g => g.key).sort()).toEqual(['rt.ice.connected', 'rt.ladder.fallback']);
    expect((await get('/v1/telemetry/summary?groupBy=nope', 'admin-key')).status).toBe(400);
    const e = await (await get('/v1/telemetry/events?level=warn', 'admin-key')).json() as { events: unknown[] };
    expect(e.events).toHaveLength(1);
    const stats = await (await get('/v1/telemetry/stats', 'admin-key')).json() as { rows: number };
    expect(stats.rows).toBe(2);
    expect((await get('/v1/telemetry/timeline', 'admin-key')).status).toBe(400);
  });

  it('echoes X-Aigw-Trace-Id: the caller trace when it sends traceparent, a new one otherwise', async () => {
    const withParent = await fetch(`${base}/v1/telemetry/stats`, {
      headers: { Authorization: 'Bearer admin-key', traceparent: `00-${TRACE}-00f067aa0ba902b7-01` },
    });
    expect(withParent.headers.get('x-aigw-trace-id')).toBe(TRACE);
    const fresh = await fetch(`${base}/v1/telemetry/stats`, { headers: { Authorization: 'Bearer admin-key' } });
    expect(fresh.headers.get('x-aigw-trace-id')).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh.headers.get('x-aigw-trace-id')).not.toBe(TRACE);
  });
});

describe('trace context', () => {
  it('parses W3C traceparent and rejects invalid ones', () => {
    expect(parseTraceparent(`00-${TRACE}-00f067aa0ba902b7-01`)).toEqual({ traceId: TRACE, parentSpanId: '00f067aa0ba902b7', sampled: true });
    expect(parseTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`)).toBeNull();
    expect(parseTraceparent(`ff-${TRACE}-00f067aa0ba902b7-01`)).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
    expect(traceOfRequest({ 'x-aigw-trace-id': TRACE }).traceId).toBe(TRACE);
  });

  it('propagates a child traceparent of the current request to upstreams', () => {
    expect(outgoingTraceHeaders()).toEqual({});
    const headers = withLogContext({ traceId: TRACE }, () => outgoingTraceHeaders());
    const parsed = parseTraceparent(headers.traceparent);
    expect(parsed?.traceId).toBe(TRACE);
  });
});

describe('gateway events', () => {
  const seen: TelemetryEvent[] = [];
  beforeEach(() => { seen.length = 0; setGatewayTelemetrySink((e) => seen.push(e)); });
  afterEach(() => setGatewayTelemetrySink(null));

  it('emitGatewayEvent carries the request trace, or a fresh one in background loops; no sink = no-op', () => {
    withLogContext({ traceId: TRACE }, () => emitGatewayEvent('route.served', { attrs: { provider: 'groq', skip: undefined } }));
    emitGatewayEvent('autoscale.decision');
    expect(seen[0]).toMatchObject({ source: 'gateway', level: 'info', event: 'route.served', traceId: TRACE, attrs: { provider: 'groq' } });
    expect(seen[0]!.attrs).not.toHaveProperty('skip');
    expect(seen[1]!.traceId).toMatch(/^[0-9a-f]{32}$/);
    setGatewayTelemetrySink(null);
    expect(() => emitGatewayEvent('x.y')).not.toThrow();
    setGatewayTelemetrySink(() => { throw new Error('sink down'); });
    expect(() => emitGatewayEvent('x.y')).not.toThrow();
  });

  it('maps controller log lines to autoscale/replica events', () => {
    deploymentLogToTelemetry('deployments: autoscale', { deployment: 'speech', desired: 2, reason: 'pressure', blockedBy: null });
    deploymentLogToTelemetry('deployments: replica ready', { deployment: 'speech', id: 'r-1', bootMs: 95_000 });
    deploymentLogToTelemetry('deployments: create failed', { deployment: 'speech', error: 'out of stock' });
    deploymentLogToTelemetry('some other line', { deployment: 'speech' });
    expect(seen.map(e => [e.event, e.level])).toEqual([['autoscale.decision', 'info'], ['replica.ready', 'info'], ['replica.create_failed', 'error']]);
    expect(seen[0]).toMatchObject({ deployment: 'speech', attrs: { desired: 2, reason: 'pressure', blockedBy: null } });
    expect(seen[1]).toMatchObject({ replicaId: 'r-1', durMs: 95_000 });
  });

  it('routing emits fallback, then served (with the deployment of a deployment link)', async () => {
    const targets = [
      { providerId: 'deployment:speech', provider: {}, model: 'whisper' },
      { providerId: 'openrouter', provider: {}, model: 'whisper-1' },
    ];
    const out = await withLogContext({ traceId: TRACE }, () => runTargets(targets, async (t) => {
      if (t.providerId === 'openrouter') return 'ok';
      throw Object.assign(new Error('replica down'), { status: 502 });
    }, { stage: 'stt', breakers: new CircuitBreakerRegistry() }));
    expect(out.result).toBe('ok');
    const names = seen.map(e => e.event);
    expect(names).toContain('route.fallback');
    expect(names[names.length - 1]).toBe('route.served');
    expect(seen.find(e => e.event === 'route.fallback')).toMatchObject({ deployment: 'speech', level: 'warn', traceId: TRACE, attrs: { stage: 'stt', status: 502 } });
    expect(seen.find(e => e.event === 'route.served')).toMatchObject({ attrs: { provider: 'openrouter', attempt: 1, failedBefore: 1 } });
  });

  it('routing with nothing left emits route.unavailable', async () => {
    await expect(runTargets([{ providerId: 'groq', provider: {} }], async () => { throw Object.assign(new Error('x'), { status: 503 }); },
      { stage: 'chat', breakers: new CircuitBreakerRegistry() })).rejects.toThrow();
    expect(seen.map(e => e.event)).toEqual(['route.fallback', 'route.unavailable']);
  });

  it('the STT filter reports codes and lengths, never the filtered text', () => {
    applySttFilter({ text: 'Merci d\'avoir regardé cette vidéo', no_speech_prob: 0.95, segments: [] } as never, 'fr');
    const hit = seen.find(e => e.event === 'stt.filtered');
    expect(hit).toBeDefined();
    expect(JSON.stringify(hit)).not.toMatch(/regard/);
    expect(hit!.attrs).toMatchObject({ language: 'fr', emptied: true });
    expect(typeof hit!.attrs!.rawLength).toBe('number');
  });
});

describe('http helpers', () => {
  it('parseTime understands relative, epoch and ISO', () => {
    expect(parseTime('1h', 10_000_000)).toBe(10_000_000 - 3_600_000);
    expect(parseTime('1759800000000', 0)).toBe(1759800000000);
    expect(parseTime('2026-10-07T00:00:00Z', 0)).toBe(Date.parse('2026-10-07T00:00:00Z'));
    expect(parseTime('bogus', 0)).toBeUndefined();
  });

  it('eventToSpan maps an event to an OTLP span of its duration', () => {
    const span = eventToSpan({ seq: 1, ts: 5000, rxTs: 5000, source: 'edge', level: 'error', event: 'turn.done', traceId: TRACE, durMs: 1000, sessionId: 's' });
    expect(span).toMatchObject({ traceId: TRACE, operation: 'turn.done', startTime: 4000, tags: { duration_ms: 1000, 'session.id': 's' } });
    expect(span.events[0]!.name).toBe('exception');
  });
});
