/**
 * Browser-facing relays with a fake edge: WebRTC signaling (offer / ICE / DELETE, authenticated by the session token,
 * never the gateway key) and the WebSocket relay (frames both ways, close propagation, refusals before handshake).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fakeController, startFakeEdge, type FakeEdge } from './_fakes';
import { startGateway, type TestGateway } from './_gateway';
import { deriveRealtimeKey, signSessionToken } from '../../../src/realtime';
import { REPLICA_TOKEN } from './_fakes';

const CONFIG = { system: 'Tu es Lia.', voice: 'lia', deployment: 'speech' };
const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';

async function session(gw: TestGateway): Promise<{ sessionId: string; token: string; transports: Array<Record<string, string>> }> {
  const res = await gw.create({ config: CONFIG });
  expect(res.status).toBe(200);
  return res.json() as never;
}

describe('signaling relay', () => {
  let edge: FakeEdge;
  let gw: TestGateway;
  let state: ReturnType<typeof fakeController>['state'];
  beforeEach(async () => {
    edge = await startFakeEdge();
    const fc = fakeController({ replicas: [{ id: 'r1', ip: edge.host }] });
    state = fc.state;
    gw = await startGateway(fc.controller);
  });
  afterEach(async () => { await gw.close(); await edge.close(); });

  it('forwards the offer with the replica token and returns the answer; ICE and DELETE use the edge session id', async () => {
    const s = await session(gw);
    const offer = await fetch(s.transports[0]!.offerUrl!, {
      method: 'POST', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp: OFFER, type: 'offer' }),
    });
    expect(offer.status).toBe(200);
    expect(offer.headers.get('access-control-allow-origin')).toBe('*');
    expect(await offer.json()).toEqual({ sdp: 'v=0\r\no=edge answer\r\n', type: 'answer', sessionId: s.sessionId });
    expect(edge.offers[0]).toMatchObject({ body: { sdp: OFFER, type: 'offer', token: s.token }, token: 'replica-token-for-tests' });

    const ice = await fetch(s.transports[0]!.iceUrl!, {
      method: 'POST', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0' } }),
    });
    expect(ice.status).toBe(204);
    expect(edge.ice[0]).toMatchObject({ sessionId: 'edge-1' });

    const del = await fetch(`${gw.url}/v1/realtime/sessions/${s.sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${s.token}` } });
    expect(del.status).toBe(204);
    expect(edge.deleted).toEqual(['edge-1']);
  });

  it('answers the CORS preflight without any key, and accepts the token in the body', async () => {
    const s = await session(gw);
    const pre = await fetch(s.transports[0]!.offerUrl!, { method: 'OPTIONS', headers: { Origin: 'https://school.example', 'Access-Control-Request-Method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    const offer = await fetch(s.transports[0]!.offerUrl!, { method: 'POST', body: JSON.stringify({ sdp: OFFER, token: s.token }) });
    expect(offer.status).toBe(200);
  });

  it('refuses: no token, a token of another session, a gateway key, a forged token, a vanished replica', async () => {
    const a = await session(gw);
    const b = await session(gw);
    const post = (url: string, auth?: string) => fetch(url, {
      method: 'POST', headers: auth ? { Authorization: `Bearer ${auth}` } : {}, body: JSON.stringify({ sdp: OFFER }),
    });
    expect((await post(a.transports[0]!.offerUrl!)).status).toBe(401);
    expect((await post(a.transports[0]!.offerUrl!, b.token)).status).toBe(403);
    expect((await post(a.transports[0]!.offerUrl!, 'key-parle')).status).toBe(401);
    const [h, p] = a.token.split('.');
    expect((await post(a.transports[0]!.offerUrl!, `${h}.${p}.${'A'.repeat(43)}`)).status).toBe(401);
    expect(edge.offers).toHaveLength(0);
    state.replicas = [];
    const gone = await post(a.transports[0]!.offerUrl!, a.token);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ error: { code: 'replica_gone' } });
  });

  it('a full replica (edge 409) reads as saturated; an expired token as token_expired', async () => {
    const s = await session(gw);
    edge.offerStatus = 409;
    const full = await fetch(s.transports[0]!.offerUrl!, { method: 'POST', headers: { Authorization: `Bearer ${s.token}` }, body: JSON.stringify({ sdp: OFFER }) });
    expect(full.status).toBe(503);
    const now = Math.floor(Date.now() / 1000);
    const old = signSessionToken({ sid: s.sessionId, app: 'parle', dep: 'speech', rep: 'r1', cfg: '', iat: now - 700, exp: now - 100 }, deriveRealtimeKey(REPLICA_TOKEN));
    const expired = await fetch(s.transports[0]!.offerUrl!, { method: 'POST', headers: { Authorization: `Bearer ${old}` }, body: JSON.stringify({ sdp: OFFER }) });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ error: { code: 'token_expired' } });
  });

  it('every other path still goes through the proxy auth', async () => {
    expect((await fetch(`${gw.url}/v1/realtime/sessions/rt_whatever12/other`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${gw.url}/v1/chat/completions`, { method: 'POST' })).status).toBe(401);
  });
});

function connect(url: string): Promise<{ ws: WebSocket; messages: Array<string | Buffer>; closed: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: Array<string | Buffer> = [];
    const closed = new Promise<{ code: number; reason: string }>(r => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    ws.on('message', (data, isBinary) => messages.push(isBinary ? data as Buffer : data.toString()));
    ws.on('open', () => resolve({ ws, messages, closed }));
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })));
    ws.on('error', reject);
  });
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); }
};

describe('WebSocket relay', () => {
  let edge: FakeEdge;
  let gw: TestGateway;
  let state: ReturnType<typeof fakeController>['state'];
  beforeEach(async () => {
    edge = await startFakeEdge();
    const fc = fakeController({ replicas: [{ id: 'r1', ip: edge.host }] });
    state = fc.state;
    gw = await startGateway(fc.controller);
  });
  afterEach(async () => { await gw.close(); await edge.close(); });

  it('pipes text and binary frames both ways, untouched', async () => {
    const s = await session(gw);
    const { ws, messages } = await connect(s.transports[1]!.url!);
    await until(() => messages.length >= 1);
    expect(JSON.parse(messages[0] as string)).toEqual({ type: 'ready' });
    ws.send(JSON.stringify({ type: 'end_turn' }));
    const audio = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(640, 7)]);
    ws.send(audio);
    const big = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(70_000, 3)]); // > 64 KiB: 8-byte length frames
    ws.send(big);
    await until(() => messages.length >= 4);
    expect(JSON.parse(messages[1] as string)).toEqual({ type: 'echo', data: '{"type":"end_turn"}' });
    expect(Buffer.compare(messages[2] as Buffer, audio)).toBe(0);
    expect(Buffer.compare(messages[3] as Buffer, big)).toBe(0);
    expect(gw.realtime.relay.active).toBe(1);
    ws.close(1000, 'bye');
    await until(() => gw.realtime.relay.active === 0);
  });

  it('propagates the close of the replica (code and reason) to the browser', async () => {
    const s = await session(gw);
    const { closed, messages } = await connect(s.transports[1]!.url!);
    await until(() => messages.length >= 1 && edge.sockets.length === 1);
    edge.sockets[0]!.close(4001, 'session over');
    expect(await closed).toEqual({ code: 4001, reason: 'session over' });
  });

  it('propagates the browser close to the replica', async () => {
    const s = await session(gw);
    const { ws, messages } = await connect(s.transports[1]!.url!);
    await until(() => messages.length >= 1 && edge.sockets.length === 1);
    const upstreamClosed = new Promise<number>(r => edge.sockets[0]!.on('close', (code) => r(code)));
    ws.close(4002, 'learner left');
    expect(await upstreamClosed).toBe(4002);
  });

  it('refuses before the handshake: bad token 401, replica gone 410, replica refusing 502', async () => {
    const s = await session(gw);
    await expect(connect(`${gw.url.replace('http', 'ws')}/v1/realtime/ws?token=nope`)).rejects.toMatchObject({ status: 401 });
    edge.wsRefuse = true;
    await expect(connect(s.transports[1]!.url!)).rejects.toMatchObject({ status: 502 });
    state.replicas = [];
    await expect(connect(s.transports[1]!.url!)).rejects.toMatchObject({ status: 410 });
    // Other upgrades still reach the proxy's own listener (410 here).
    await expect(connect(`${gw.url.replace('http', 'ws')}/v1/stt/stream`)).rejects.toMatchObject({ status: 410 });
  });
});

describe('trace propagation (correlated telemetry)', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const TP = `00-${TRACE}-00f067aa0ba902b7-01`;
  let edge: FakeEdge;
  let gw: TestGateway;
  beforeEach(async () => {
    edge = await startFakeEdge();
    gw = await startGateway(fakeController({ replicas: [{ id: 'r1', ip: edge.host }] }).controller);
  });
  afterEach(async () => { await gw.close(); await edge.close(); });

  it('admission, signaling and WS keep the browser trace, forward it to the edge, echo X-Aigw-Trace-Id, emit gateway events', async () => {
    const res = await gw.create({ config: CONFIG }, { traceparent: TP });
    expect(res.headers.get('x-aigw-trace-id')).toBe(TRACE);
    const s = await res.json() as { sessionId: string; token: string; traceId: string; telemetryUrl: string; transports: Array<Record<string, string>> };
    expect(s.traceId).toBe(TRACE);
    expect(s.telemetryUrl).toBe(`${gw.url}/v1/telemetry/events`);

    const offer = await fetch(s.transports[0]!.offerUrl!, {
      method: 'POST', headers: { Authorization: `Bearer ${s.token}`, traceparent: TP }, body: JSON.stringify({ sdp: OFFER }),
    });
    expect(offer.headers.get('x-aigw-trace-id')).toBe(TRACE);
    expect(edge.offers[0]!.traceparent).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`));

    const { ws, messages } = await connect(`${s.transports[1]!.url}&traceparent=${TP}`);
    await until(() => messages.length >= 1);
    expect(edge.wsTraceparents[0]).toMatch(new RegExp(`^00-${TRACE}-`));
    ws.close(1000);
    await until(() => gw.events.some(e => e.event === 'ws.close'));

    const names = gw.events.map(e => e.event);
    expect(names).toEqual(expect.arrayContaining(['rt.session.admitted', 'rt.signal.offer', 'ws.open', 'ws.close']));
    expect(gw.events.every(e => e.traceId === TRACE && e.source === 'gateway')).toBe(true);
    expect(gw.events.every(e => typeof e.ts === 'number' && Math.abs(e.ts - Date.now()) < 60_000)).toBe(true);
    // Nothing secret or spoken in the events.
    const flat = JSON.stringify(gw.events);
    expect(flat).not.toContain(s.token);
    expect(flat).not.toContain('Tu es Lia');
    expect(flat).not.toContain('v=0');
  });

  it('a rejection carries the trace too, and a missing traceparent gets a fresh one', async () => {
    edge.status = { active: 8, max: 8, transports: ['webrtc'] };
    const res = await gw.create({ config: CONFIG }, { traceparent: TP });
    expect(res.status).toBe(503);
    expect(gw.events.find(e => e.event === 'rt.session.rejected')).toMatchObject({ traceId: TRACE, attrs: { reason: 'saturated' } });
    const fresh = await gw.create({ config: CONFIG });
    expect(fresh.headers.get('x-aigw-trace-id')).toMatch(/^[0-9a-f]{32}$/);
  });
});
