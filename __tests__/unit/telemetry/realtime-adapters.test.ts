import { describe, expect, it, vi } from 'vitest';
import { createTelemetry } from '../../../sdk/browser/telemetry';
import { realtimeSinkToTelemetry, sessionResolverFrom, toContractTs } from '../../../src/telemetry/adapters';
import { authenticateTelemetry } from '../../../src/telemetry/auth';
import { TelemetryIngest } from '../../../src/telemetry/ingest';
import { TelemetryStore } from '../../../src/telemetry/store';
import { traceOfRequest } from '../../../src/telemetry/trace-context';
import { authDeps, sessionToken, TRACE } from './_helpers';

/** Copy of the realtime SDK's `RealtimeTelemetry` (sdk/browser/realtime/telemetry.ts, branch realtime-control). */
interface RealtimeTelemetry {
  readonly traceId: string;
  readonly traceparent: string;
  emit(event: string, fields?: { level?: 'debug' | 'info' | 'warn' | 'error'; turnId?: string; durMs?: number; attrs?: Record<string, unknown> }): void;
  bind(sessionId: string, token: string, ingestUrl: string | null): void;
  flush(): Promise<void>;
  close(): void;
}

describe('realtime integration', () => {
  it('the shared browser emitter satisfies RealtimeTelemetry and only sends once bound', async () => {
    const calls: Array<{ url: string; init: RequestInit & { headers: Record<string, string> } }> = [];
    const fetchImpl = vi.fn(async (url: string, init: never) => { calls.push({ url, init }); return new Response('{}'); });
    const rt: RealtimeTelemetry = createTelemetry({ fetch: fetchImpl as unknown as typeof fetch, target: null });
    expect(rt.traceparent).toMatch(new RegExp(`^00-${rt.traceId}-[0-9a-f]{16}-01$`));
    rt.emit('rt.session.request', { attrs: { transport: 'webrtc', transcript: 'bonjour', sdp: { x: 1 }, textLen: 7 } });
    await rt.flush();
    expect(calls).toHaveLength(0); // no ingest URL yet: kept
    rt.bind('sess-7', 'the.session.jwt', 'https://gw.test/v1/telemetry/events');
    rt.emit('rt.ice.connected', { turnId: 't1', durMs: 420 });
    await rt.flush();
    expect(calls[0]!.url).toBe('https://gw.test/v1/telemetry/events');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer the.session.jwt');
    const events = JSON.parse(String(calls[0]!.init.body)).events;
    expect(events.map((e: { sessionId: string }) => e.sessionId)).toEqual(['sess-7', 'sess-7']);
    expect(events[0].attrs).toEqual({ transport: 'webrtc', textLen: 7 });
  });

  it('realtime gateway events (ISO ts) land in the store through the sink adapter', () => {
    const store = new TelemetryStore();
    const sink = realtimeSinkToTelemetry(new TelemetryIngest(store));
    sink({ ts: '2026-10-07T10:00:00.000Z', source: 'gateway', level: 'warn', event: 'rt.edge.unreachable', traceId: TRACE, sessionId: 's1', durMs: 3000 });
    expect(store.rows()[0]).toMatchObject({ ts: Date.parse('2026-10-07T10:00:00.000Z'), event: 'rt.edge.unreachable', sessionId: 's1' });
    expect(toContractTs('garbage')).toBeGreaterThan(0);
  });

  it('an injected session resolver wins; a refusal falls back to the built-in verifier', () => {
    const resolver = sessionResolverFrom({
      resolveToken: (t: string) => (t === 'live.token.x' ? { claims: { sid: 'S', app: 'A', dep: 'D', rep: 'R' } } : { status: 410 }),
    });
    expect(authenticateTelemetry({ authorization: 'Bearer live.token.x' }, authDeps({ resolveSessionToken: resolver })))
      .toEqual({ kind: 'session', app: 'A', sessionId: 'S', deployment: 'D', replicaId: 'R' });
    // Replica gone (410 in realtime): still verified here, so the session's last batch lands.
    expect(authenticateTelemetry({ authorization: `Bearer ${sessionToken({ sid: 'gone' })}` }, authDeps({ resolveSessionToken: resolver })))
      .toMatchObject({ kind: 'session', sessionId: 'gone' });
  });

  it('reads ?traceparent= on WebSocket upgrades', () => {
    expect(traceOfRequest({}, `/v1/realtime/ws?x=1&traceparent=00-${TRACE}-00f067aa0ba902b7-01`).traceId).toBe(TRACE);
  });
});
