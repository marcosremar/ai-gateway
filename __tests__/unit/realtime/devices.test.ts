import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { deriveRealtimeKey, signSessionToken, verifySessionToken } from '../../../src/realtime';
import { AppRegistry, MemoryAppStore } from '../../../src/deployments/apps';
import { AppDevices } from '../../../src/deployments/app-devices';
import { fakeController, REPLICA_TOKEN, startFakeEdge, type FakeEdge } from './_fakes';
import { startGateway, type TestGateway } from './_gateway';

const CONFIG = { system: 'Tu es Lia.', voice: 'lia', deployment: 'speech' };
const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';
const PHONE = 'install-7f3a9c21';
const TABLET = 'install-0b5d4e88';

type Session = { sessionId: string; token: string; transports: Array<Record<string, string>> };

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); }
};

describe('realtime sessions and app devices', () => {
  let edge: FakeEdge;
  let gw: TestGateway;
  let apps: AppRegistry;
  let devices: AppDevices;

  beforeEach(async () => {
    edge = await startFakeEdge();
    apps = new AppRegistry(new MemoryAppStore());
    await apps.init();
    devices = new AppDevices(apps, { flushMs: 0 });
    gw = await startGateway(fakeController({ replicas: [{ id: 'r1', ip: edge.host }] }).controller, { devices });
    devices.onBlock = (app, device) => { void gw.realtime.service.endDeviceSessions(app, device); };
  });
  afterEach(async () => { await gw.close(); await edge.close(); });

  const open = async (device?: string): Promise<Session> => {
    const res = await gw.create({ config: CONFIG, ...(device ? { device } : {}) });
    expect(res.status).toBe(200);
    return res.json() as Promise<Session>;
  };
  const claimsOf = (token: string) => {
    const verdict = verifySessionToken(token, deriveRealtimeKey(REPLICA_TOKEN), Math.floor(Date.now() / 1000));
    return (verdict as { claims: Record<string, unknown> }).claims;
  };
  const offer = (s: Session) => fetch(s.transports[0]!.offerUrl!, {
    method: 'POST', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sdp: OFFER, type: 'offer' }),
  });

  it('the device named at admission is signed into the token and recorded for the app; none = the token as before', async () => {
    const withDevice = await open(PHONE);
    expect(claimsOf(withDevice.token)).toMatchObject({ app: 'parle', dev: PHONE });
    expect(Object.keys(claimsOf(withDevice.token))).toEqual(['sid', 'app', 'dep', 'rep', 'cfg', 'dev', 'iat', 'exp']);
    expect(devices.list('parle').devices).toMatchObject([{ id: PHONE, requests: 1, lastKind: 'realtime' }]);
    expect(Object.keys(claimsOf((await open()).token))).toEqual(['sid', 'app', 'dep', 'rep', 'cfg', 'iat', 'exp']);
    expect(devices.list('parle').total).toBe(1);
  });

  it('a blocked device cannot open a session (403 device_blocked, nothing charged); unblocking restores it', async () => {
    await devices.block('parle', PHONE, 'abuse', 'owner');
    const refused = await gw.create({ config: CONFIG, device: PHONE });
    expect(refused.status).toBe(403);
    expect((await refused.json() as Record<string, any>).error).toMatchObject({ code: 'device_blocked' });
    expect(gw.charged).toEqual([]);
    expect(gw.events.at(-1)).toMatchObject({ event: 'rt.session.rejected', attrs: { reason: 'device_blocked' } });
    await open(TABLET);
    await devices.unblock('parle', PHONE, 'owner');
    await open(PHONE);
  });

  it('malformed ids are refused, and requireDevice refuses a session without one', async () => {
    const bad = await gw.create({ config: CONFIG, device: 'sk-live-0123456789' });
    expect(bad.status).toBe(400);
    expect((await bad.json() as Record<string, any>).error.code).toBe('invalid_device');
    expect((await gw.create({ config: CONFIG, device: 42 })).status).toBe(400);
    await apps.setRequireDevice('parle', true);
    const missing = await gw.create({ config: CONFIG });
    expect(missing.status).toBe(403);
    expect((await missing.json() as Record<string, any>).error.code).toBe('device_required');
    await open(PHONE);
  });

  it('blocking ends the open WebRTC session at the edge and refuses every later signaling call of its token', async () => {
    const s = await open(PHONE);
    const other = await open(TABLET);
    expect((await offer(s)).status).toBe(200);
    await devices.block('parle', PHONE, null, 'owner');
    await until(() => edge.deleted.length === 1);
    expect(edge.deleted).toEqual(['edge-1']);
    const again = await offer(s);
    expect(again.status).toBe(403);
    expect((await again.json() as Record<string, any>).error.code).toBe('device_blocked');
    expect((await offer(other)).status).toBe(200);
    expect(gw.events.some(e => e.event === 'rt.session.deleted' && e.attrs?.reason === 'device_blocked')).toBe(true);
  });

  it('an open WebSocket session of a blocked device is closed at its next frame, and cannot reconnect', async () => {
    const s = await open(PHONE);
    const ws = new WebSocket(s.transports[1]!.url!);
    const closed = new Promise<{ code: number; reason: string }>(r => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    const messages: string[] = [];
    ws.on('message', (data) => messages.push(data.toString()));
    await until(() => messages.length >= 1);
    ws.send(JSON.stringify({ type: 'end_turn' }));
    await until(() => messages.length >= 2);

    await devices.block('parle', PHONE, null, 'owner');
    ws.send(Buffer.concat([Buffer.from([0x01]), Buffer.alloc(640, 7)]));
    expect(await closed).toEqual({ code: 1008, reason: 'device_blocked' });
    expect(messages.length).toBe(2);

    const status = await new Promise<number>((resolve) => {
      const retry = new WebSocket(s.transports[1]!.url!);
      retry.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      retry.on('open', () => resolve(101));
      retry.on('error', () => {});
    });
    expect(status).toBe(403);
  });

  it('a token of another gateway process (unknown session) is still refused once its device is blocked', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signSessionToken(
      { sid: 'rt_0123456789abcdef', app: 'parle', dep: 'speech', rep: 'r1', cfg: '', dev: PHONE, iat: now, exp: now + 600 },
      deriveRealtimeKey(REPLICA_TOKEN),
    );
    expect('claims' in gw.realtime.service.resolveToken(token)).toBe(true);
    await devices.block('parle', PHONE, null, 'owner');
    expect(gw.realtime.service.resolveToken(token)).toMatchObject({ status: 403, code: 'device_blocked' });
  });
});
