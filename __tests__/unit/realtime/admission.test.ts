/**
 * Admission of realtime sessions (src/realtime/service.ts, admission.ts): transport order, replica choice by free
 * slots, ownership, no-wake, the 503 that sends the client down the ladder, budget, token contents.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeSessionConfig, deriveRealtimeKey, externalLoadOf, orderTransports, pickReplica, sessionCharge, verifySessionToken,
} from '../../../src/realtime';
import { _resetExternalLoad } from '../../../src/realtime/external-load';
import { fakeController, REPLICA_TOKEN, startFakeEdge, type FakeEdge } from './_fakes';
import { startGateway, type TestGateway } from './_gateway';

const CONFIG = { system: 'Tu es Lia.', messages: [{ role: 'assistant', content: 'Bom dia!' }], voice: 'lia', language: 'pt', deployment: 'speech' };

describe('orderTransports / pickReplica / sessionCharge', () => {
  it('orders the ladder, honours prefer, refuses unknown names and sessions without an edge transport', () => {
    expect(orderTransports(undefined, undefined)).toEqual({ order: ['webrtc', 'ws', 's2s-stream', 'post'] });
    expect(orderTransports(['ws', 'webrtc', 'ws'], 'webrtc')).toEqual({ order: ['webrtc', 'ws'] });
    expect(orderTransports(['post'], 'ws')).toEqual({ order: ['ws', 'post'] });
    expect(orderTransports(['webrtc', 'udp'], undefined)).toHaveProperty('error');
    expect(orderTransports(['s2s-stream', 'post'], undefined)).toHaveProperty('error');
    expect(orderTransports([], undefined)).toHaveProperty('error');
  });

  it('picks the replica with the most free slots after pending admissions, speaking a wanted transport', () => {
    const st = (active: number, max: number, transports: Array<'webrtc' | 'ws'> = ['webrtc', 'ws']) => ({ active, max, available: max - active, transports, udpPorts: null });
    const a = { id: 'a', base: 'http://a', status: st(2, 8), pending: 0 };
    const b = { id: 'b', base: 'http://b', status: st(1, 8), pending: 3 };
    const c = { id: 'c', base: 'http://c', status: st(0, 16, ['ws']), pending: 0 };
    expect(pickReplica([a, b], ['webrtc'])!.id).toBe('a');
    expect(pickReplica([a, b, c], ['webrtc'])!.id).toBe('a');
    expect(pickReplica([a, b, c], ['ws'])!.id).toBe('c');
    expect(pickReplica([{ ...a, pending: 6 }], ['webrtc'])).toBeNull();
    expect(sessionCharge(600)).toBe(40);
    expect(sessionCharge(61, 2)).toBe(4);
  });
});

describe('POST /v1/realtime/sessions', () => {
  let edge: FakeEdge;
  let gw: TestGateway;
  beforeEach(async () => { _resetExternalLoad(); edge = await startFakeEdge(); });
  afterEach(async () => { await gw?.close(); await edge.close(); });

  it('admits on a ready replica with free slots and returns token, transports in order, TURN credentials, limits', async () => {
    const { controller } = fakeController({ replicas: [{ id: 'r1', ip: edge.host }] });
    gw = await startGateway(controller);
    const res = await gw.create({ config: CONFIG, prefer: 'webrtc' });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.sessionId).toMatch(/^rt_[0-9a-f]{32}$/);
    expect(body.transports.map((t: { type: string }) => t.type)).toEqual(['webrtc', 'ws', 's2s-stream', 'post']);
    expect(body.transports[0].offerUrl).toBe(`${gw.url}/v1/realtime/sessions/${body.sessionId}/offer`);
    expect(body.transports[1].url).toBe(`${gw.url.replace('http', 'ws')}/v1/realtime/ws?token=${body.token}`);
    expect(body.transports[0].iceServers).toEqual([
      { urls: ['stun:stun.l.google.com:19302'] },
      expect.objectContaining({ urls: ['turn:198.51.100.7:3478?transport=udp'], username: expect.stringMatching(new RegExp(`:${body.sessionId}$`)) }),
    ]);
    const verdict = verifySessionToken(body.token, deriveRealtimeKey(REPLICA_TOKEN), Math.floor(Date.now() / 1000));
    expect('claims' in verdict).toBe(true);
    const claims = (verdict as { claims: Record<string, any> }).claims;
    expect(claims).toMatchObject({ sid: body.sessionId, app: 'parle', dep: 'speech', rep: 'r1' });
    expect(claims.exp - claims.iat).toBe(600);
    expect(decodeSessionConfig(claims.cfg)).toEqual(CONFIG);
    expect(body.limits).toMatchObject({ maxSessionSeconds: 600, requestsCharged: 40, replica: { active: 0, max: 8, pending: 1 } });
    expect(gw.charged).toEqual([['parle', 40]]);
    expect(externalLoadOf('speech')).toMatchObject({ active: 0, max: 8, replicas: 1 });
  });

  it('only offers the edge transports the replica speaks', async () => {
    edge.status = { active: 0, max: 4, transports: ['ws'] };
    const { controller } = fakeController({ replicas: [{ id: 'r1', ip: edge.host }] });
    gw = await startGateway(controller);
    const body = await (await gw.create({ config: CONFIG, transports: ['webrtc', 'ws', 'post'] })).json() as Record<string, any>;
    expect(body.transports.map((t: { type: string }) => t.type)).toEqual(['ws', 'post']);
  });

  it('counts admitted-but-unconnected sessions against the slots (a class arriving at once)', async () => {
    edge.status = { active: 0, max: 2, transports: ['webrtc', 'ws'] };
    const { controller } = fakeController({ replicas: [{ id: 'r1', ip: edge.host }] });
    gw = await startGateway(controller);
    expect((await gw.create({ config: CONFIG })).status).toBe(200);
    expect((await gw.create({ config: CONFIG })).status).toBe(200);
    const third = await gw.create({ config: CONFIG });
    expect(third.status).toBe(503);
    expect(third.headers.get('retry-after')).toBe('2');
    expect(await third.json()).toMatchObject({ error: { code: 'saturated' }, fallback: { transport: 's2s-stream', url: '/v1/s2s' } });
    expect(gw.charged).toHaveLength(2);
  });

  it('cold deployment: wakes it and answers 503 + Retry-After + fallback at once', async () => {
    const { controller, state } = fakeController({ replicas: [{ id: 'r1', ip: edge.host, phase: 'booting' }] });
    gw = await startGateway(controller);
    const res = await gw.create({ config: CONFIG });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.json()).toMatchObject({ error: { code: 'cold' }, fallback: { transport: 's2s-stream' } });
    expect(state.woken).toBe(1);
    expect(gw.charged).toEqual([]);
  });

  it('no-wake: a cold deployment is not woken', async () => {
    const { controller, state } = fakeController({ replicas: [] });
    gw = await startGateway(controller);
    const res = await gw.create({ config: CONFIG }, { noWake: true });
    expect(res.status).toBe(503);
    expect((await res.json() as { error: { message: string } }).error.message).toMatch(/no-wake/);
    expect(state.woken).toBe(0);
  });

  it('replicas without the edge (status 404) → 503 unsupported with the fallback; draining replicas are skipped', async () => {
    edge.status = null;
    const { controller } = fakeController({ replicas: [{ id: 'r1', ip: edge.host }, { id: 'r2', ip: '127.0.0.1:1', draining: true }] });
    gw = await startGateway(controller);
    const res = await gw.create({ config: CONFIG });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'unsupported' }, fallback: { url: '/v1/s2s' } });
  });

  it("ownership: an app key cannot open sessions on another app's deployment; admin can; unknown key is refused", async () => {
    const { controller } = fakeController({ replicas: [{ id: 'r1', ip: edge.host }] });
    gw = await startGateway(controller);
    expect((await gw.create({ config: CONFIG }, { key: 'key-other' })).status).toBe(403);
    expect((await gw.create({ config: { ...CONFIG, deployment: 'nope' } })).status).toBe(403);
    const admin = await gw.create({ config: CONFIG }, { key: 'key-admin' });
    expect(admin.status).toBe(200);
    expect((await admin.json() as { limits: { requestsCharged: number } }).limits.requestsCharged).toBe(0);
    expect((await gw.create({ config: { ...CONFIG, deployment: 'nope' } }, { key: 'key-admin' })).status).toBe(404);
    expect((await gw.create({ config: CONFIG }, { key: 'bad' })).status).toBe(401);
  });

  it('budget denial, oversize config and bad bodies', async () => {
    const { controller } = fakeController({ replicas: [{ id: 'r1', ip: edge.host }] });
    gw = await startGateway(controller, { deny: { status: 429, type: 'budget_exceeded', message: 'over', retryAfterSeconds: 99 } });
    const denied = await gw.create({ config: CONFIG });
    expect(denied.status).toBe(429);
    expect(denied.headers.get('retry-after')).toBe('99');
    const big = await gw.create({ config: { ...CONFIG, system: 'x'.repeat(7000) } });
    expect(big.status).toBe(413);
    expect((await gw.create({ transports: ['webrtc'] })).status).toBe(400);
    expect((await gw.create({ config: CONFIG, transports: ['carrier-pigeon'] })).status).toBe(400);
  });
});
