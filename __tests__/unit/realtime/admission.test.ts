/**
 * Admission of realtime sessions (src/realtime/service.ts, admission.ts): transport order, replica choice by free
 * slots, ownership, no-wake, the 503 that sends the client down the ladder, budget, token contents.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeSessionConfig, deriveRealtimeKey, distinctSessions, externalLoadOf, orderTransports, pickReplica, refusedSessions, sessionCharge, verifySessionToken,
} from '../../../src/realtime';
import { _resetExternalLoad } from '../../../src/realtime/external-load';
import { parseEdgeStatus } from '../../../src/realtime/edge-status';
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

  it('a replica shedding load (first audio over the deadline) reports no free slot under its cap: sessions go elsewhere', () => {
    const shedding = parseEdgeStatus({ active: 2, max: 4, available: 0, transports: ['webrtc', 'ws'], firstAudioMaxMs: 2300, shedding: true })!;
    const healthy = parseEdgeStatus({ active: 3, max: 4, available: 1, transports: ['webrtc', 'ws'], firstAudioMaxMs: 1400 })!;
    expect([shedding.available, shedding.firstAudioMaxMs, healthy.firstAudioMaxMs]).toEqual([0, 2300, 1400]);
    expect(parseEdgeStatus({ active: 1, max: 4 })!.firstAudioMaxMs).toBeNull();
    const at = (id: string, status: typeof shedding) => ({ id, base: `http://${id}`, status, pending: 0 });
    expect(pickReplica([at('shedding', shedding), at('healthy', healthy)], ['ws'])!.id).toBe('healthy');
    expect(pickReplica([at('shedding', shedding)], ['ws'])).toBeNull();
  });

  it('prefers the better media path among replicas with a free slot: direct, unprobed, relay, ws; then free slots', () => {
    const on = (id: string, path: 'direct' | 'relay' | 'ws' | 'unknown' | null, active: number, pending = 0) => ({
      id, base: `http://${id}`, pending,
      status: {
        active, max: 8, available: 8 - active, transports: (path === 'ws' ? ['ws'] : ['webrtc', 'ws']) as Array<'webrtc' | 'ws'>, udpPorts: null, probePort: 50100,
        net: path ? { path, udpInbound: 'unknown' as const, publicIp: null, checkedAt: null } : null,
      },
    });
    const ladder = ['webrtc', 'ws'] as const;
    expect(pickReplica([on('ws', 'ws', 0), on('relay', 'relay', 0), on('direct', 'direct', 7)], [...ladder])!.id).toBe('direct');
    expect(pickReplica([on('ws', 'ws', 0), on('relay', 'relay', 6), on('direct', 'direct', 7, 1)], [...ladder])!.id).toBe('relay');
    expect(pickReplica([on('ws', 'ws', 0), on('relay', 'relay', 8), on('direct', 'direct', 8)], [...ladder])!.id).toBe('ws');
    expect(pickReplica([on('relay', 'relay', 0), on('old-edge', null, 5), on('unprobed', 'unknown', 6)], [...ladder])!.id).toBe('old-edge');
    expect(pickReplica([on('d1', 'direct', 5), on('d2', 'direct', 2)], [...ladder])!.id).toBe('d2');
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

  it('counts students, not requests: one session retrying a full replica is one refused session, two are two', async () => {
    edge.status = { active: 8, max: 8, transports: ['webrtc', 'ws'] };
    const { controller } = fakeController({ replicas: [{ id: 'r1', ip: edge.host }] });
    gw = await startGateway(controller);
    const ana = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const rui = '00-1bf7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    for (let i = 0; i < 3; i++) expect((await gw.create({ config: CONFIG }, { traceparent: ana })).status).toBe(503);
    expect((await gw.create({ config: CONFIG }, { traceparent: rui })).status).toBe(503);
    expect(refusedSessions('speech', 60_000)).toBe(2);
    expect(distinctSessions('speech', 60_000)).toBe(2);
    expect(externalLoadOf('speech')).toMatchObject({ active: 8, max: 8 });
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

  it('sessions admitted by a previous gateway process keep the deployment awake (the session table died with it)', async () => {
    const { controller, state } = fakeController({ replicas: [{ id: 'r1', ip: edge.host }] });
    const listed = { ...controller, list: () => [{ name: 'speech' }] as never, specOf: () => ({ realtime: {} }) as never };
    gw = await startGateway(listed, { netProbeMs: 0 });
    await gw.realtime.service.probeAll();
    expect(state.woken).toBe(0);
    edge.status = { ...edge.status!, active: 2 };
    gw.realtime.service.status.invalidate('r1');
    await gw.realtime.service.probeAll();
    expect(state.woken).toBe(1);
  });

  it('a replica with a stage out of rotation takes no new session: the healthy one does, else 503 degraded + fallback', async () => {
    const { controller, state } = fakeController({ replicas: [{ id: 'r1', ip: edge.host, stagesOut: ['tts'] }, { id: 'r2', ip: edge.host }] });
    gw = await startGateway(controller);
    const admitted = await gw.create({ config: CONFIG });
    expect(admitted.status).toBe(200);
    expect((await admitted.json() as { limits: { replica: { pending: number } } }).limits.replica.pending).toBe(1);
    expect(gw.events.find(e => e.event === 'rt.session.admitted')!.attrs).toMatchObject({ replica: 'r2' });

    state.replicas = [{ id: 'r1', ip: edge.host, stagesOut: ['tts'] }];
    const refused = await gw.create({ config: CONFIG });
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('30');
    expect(await refused.json()).toMatchObject({ error: { code: 'degraded', message: expect.stringContaining('tts') }, fallback: { transport: 's2s-stream', url: '/v1/s2s' } });
    expect(state.woken).toBe(0);
    expect(gw.charged).toHaveLength(1);
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

  it('refuses a config without voice (the edge would fail mid-turn with "upstream")', async () => {
    const { controller } = fakeController({ replicas: [{ id: 'r1', ip: edge.host }] });
    gw = await startGateway(controller);
    const { voice: _voice, ...noVoice } = CONFIG;
    const res = await gw.create({ config: noVoice });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect((await gw.create({ config: { ...noVoice, voice: '' } })).status).toBe(400);
    expect((await gw.create({ config: { ...noVoice, voice: { audio: 'a.wav' } } })).status).toBe(400);
    expect((await gw.create({ config: { ...noVoice, voice: { audio: 'a.wav', text: 'ola' } } })).status).toBe(200);
    expect((await gw.create({ config: CONFIG })).status).toBe(200);
  });
});
