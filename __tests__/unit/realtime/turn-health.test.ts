import { createSocket } from 'dgram';
import { createServer, type AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { RealtimeService } from '../../../src/realtime';
import { TurnHealth, allocateRequest, isStunReplyTo, parseTurnUrl, probeTurn, type TurnState } from '../../../src/realtime/turn-health';
import type { EdgeStatus } from '../../../src/realtime/edge-status';
import { fakeController, startFakeEdge, type FakeEdge } from './_fakes';
import { startGateway, type TestGateway } from './_gateway';

const CONFIG = { system: 'S', voice: 'lia', deployment: 'speech' };

function unauthorized(request: Buffer): Buffer {
  const reply = Buffer.from(request.subarray(0, 20));
  reply.writeUInt16BE(0x0113, 0);
  reply.writeUInt16BE(0, 2);
  return reply;
}

describe('TURN check', () => {
  it('parses turn and turns URLs with their default port and transport', () => {
    expect(parseTurnUrl('turn:203.0.113.7:3478?transport=udp')).toMatchObject({ host: '203.0.113.7', port: 3478, transport: 'udp' });
    expect(parseTurnUrl('turn:turn.example.com?transport=tcp')).toMatchObject({ host: 'turn.example.com', port: 3478, transport: 'tcp' });
    expect(parseTurnUrl('turns:turn.example.com:443?transport=tcp')).toMatchObject({ port: 443, transport: 'tls' });
    expect(parseTurnUrl('turns:turn.example.com')).toMatchObject({ port: 5349, transport: 'tls' });
    expect(parseTurnUrl('stun:stun.example.com')).toBeNull();
  });

  it('an Allocate without credentials is answered over UDP and TCP; only a reply with our transaction id counts', async () => {
    const udp = createSocket('udp4');
    const seen: Buffer[] = [];
    udp.on('message', (m, from) => { seen.push(m); udp.send(unauthorized(m), from.port, from.address); });
    await new Promise<void>(r => udp.bind(0, '127.0.0.1', r));
    const tcp = createServer(s => s.on('data', (m: Buffer) => s.write(unauthorized(m))));
    await new Promise<void>(r => tcp.listen(0, '127.0.0.1', r));
    const stranger = createServer(s => s.on('data', () => s.write(Buffer.alloc(20, 7))));
    await new Promise<void>(r => stranger.listen(0, '127.0.0.1', r));
    const port = (s: { address(): unknown }) => (s.address() as AddressInfo).port;
    try {
      expect(await probeTurn(parseTurnUrl(`turn:127.0.0.1:${port(udp)}`)!, 500)).toMatchObject({ ok: true });
      expect(seen[0]!.readUInt16BE(0)).toBe(0x0003);
      expect(seen[0]!.subarray(20)).toEqual(Buffer.from([0, 0x19, 0, 4, 17, 0, 0, 0]));
      expect(await probeTurn(parseTurnUrl(`turn:127.0.0.1:${port(tcp)}?transport=tcp`)!, 500)).toMatchObject({ ok: true });
      expect(await probeTurn(parseTurnUrl(`turn:127.0.0.1:${port(stranger)}?transport=tcp`)!, 500)).toEqual({ ok: false, rttMs: null });
      const closed = port(tcp) === 1 ? 2 : 1;
      expect(await probeTurn(parseTurnUrl(`turn:127.0.0.1:${closed}?transport=tcp`)!, 300)).toEqual({ ok: false, rttMs: null });
      udp.removeAllListeners('message');
      expect(await probeTurn(parseTurnUrl(`turn:127.0.0.1:${port(udp)}`)!, 150)).toEqual({ ok: false, rttMs: null });
    } finally {
      udp.close(); tcp.close(); stranger.close();
    }
    const id = Buffer.alloc(12, 1);
    expect(isStunReplyTo(unauthorized(allocateRequest(id)), id)).toBe(true);
    expect(isStunReplyTo(unauthorized(allocateRequest(Buffer.alloc(12, 2))), id)).toBe(false);
  });

  it('dead after two misses once it has answered; a URL that never answered stays unknown and usable; each change is reported', async () => {
    const up: Record<string, boolean> = { 'turn:a:3478': true, 'turn:b:3478': false };
    const changes: Array<[string, TurnState, TurnState]> = [];
    let now = 1_000;
    const health = new TurnHealth(Object.keys(up), {
      now: () => now, probe: async t => ({ ok: up[t.url]!, rttMs: up[t.url] ? 12 : null }), onChange: (e, previous) => changes.push([e.url, previous, e.state]),
    });
    expect(health.usable()).toEqual(['turn:a:3478', 'turn:b:3478']);
    await health.check();
    expect(health.view()).toEqual([
      { url: 'turn:a:3478', state: 'alive', since: 1_000, checkedAt: 1_000, rttMs: 12, failures: 0 },
      { url: 'turn:b:3478', state: 'unknown', since: 1_000, checkedAt: 1_000, rttMs: null, failures: 1 },
    ]);
    up['turn:a:3478'] = false;
    now = 2_000;
    await health.check();
    expect(health.usable()).toEqual(['turn:a:3478', 'turn:b:3478']);
    now = 3_000;
    await health.check();
    await health.check();
    expect(health.usable()).toEqual(['turn:b:3478']);
    expect(health.view()[0]).toMatchObject({ state: 'dead', since: 3_000, failures: 3 });
    up['turn:a:3478'] = true;
    now = 4_000;
    await health.check();
    expect(health.usable()).toEqual(['turn:a:3478', 'turn:b:3478']);
    expect(changes).toEqual([
      ['turn:a:3478', 'unknown', 'alive'], ['turn:b:3478', 'unknown', 'unknown'], ['turn:a:3478', 'alive', 'dead'], ['turn:a:3478', 'dead', 'alive'],
    ]);
  });
});

describe('TURN health in the gateway', () => {
  let edge: FakeEdge;
  let gw: TestGateway;
  afterEach(async () => { await gw?.close(); await edge?.close(); });

  it('a session gets only the TURN URLs that are not dead; the state and each transition are visible', async () => {
    edge = await startFakeEdge();
    const { controller } = fakeController({ replicas: [{ id: 'r1', ip: edge.host }] });
    const up: Record<string, boolean> = { 'turn:198.51.100.7:3478?transport=udp': true, 'turns:turn.example.com:443?transport=tcp': true };
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    gw = await startGateway(controller, {
      env: { REALTIME_TURN_URLS: Object.keys(up).join(','), REALTIME_TURN_SECRET: 'turn-secret' },
      probeTurnImpl: async t => ({ ok: up[t.url]!, rttMs: 5 }), log: (msg, data) => logs.push([msg, data]),
    });
    const turnUrls = async () => {
      const body = await (await gw.create({ config: CONFIG })).json() as { iceServers: Array<{ urls: string[]; username?: string }> };
      return body.iceServers.find(s => s.username)?.urls ?? [];
    };
    const service = gw.realtime.service;
    expect(service.turnHealth().map(t => t.state)).toEqual(['unknown', 'unknown']);
    await service.checkTurn();
    expect(await turnUrls()).toEqual(Object.keys(up));
    up['turn:198.51.100.7:3478?transport=udp'] = false;
    await service.checkTurn();
    await service.checkTurn();
    expect(await turnUrls()).toEqual(['turns:turn.example.com:443?transport=tcp']);
    expect(service.turnHealth()[0]).toMatchObject({ url: 'turn:198.51.100.7:3478?transport=udp', state: 'dead', failures: 2 });
    expect(service.edgeIceServers('rt_x', 100)[0]!.urls).toEqual(Object.keys(up));
    up['turns:turn.example.com:443?transport=tcp'] = false;
    await service.checkTurn();
    await service.checkTurn();
    expect(await turnUrls()).toEqual([]);
    expect(logs.filter(([m]) => m === 'realtime: turn server').map(([, d]) => [d!.previous, d!.state])).toEqual([
      ['unknown', 'alive'], ['unknown', 'alive'], ['alive', 'dead'], ['alive', 'dead'],
    ]);
    expect(gw.events.filter(e => e.event === 'rt.turn.health' && e.level === 'warn')).toHaveLength(2);
  });
});

describe('media-path re-probe', () => {
  it('a verdict that is not direct is re-probed after 1 min, then 2, … up to the full interval; direct waits the full interval', async () => {
    let now = 1_700_000_000_000;
    let verdict: 'ws' | 'relay' | 'direct' = 'ws';
    const probes: number[] = [];
    let net: EdgeStatus['net'] = { path: 'unknown', udpInbound: 'unknown', publicIp: '203.0.113.9', checkedAt: null };
    const started = now;
    const service = new RealtimeService({
      controller: null, userOf: () => null, isAdmin: () => false, now: () => now, netProbeMs: 0, turnCheckMs: 0, netRecheckMs: 5 * 60_000,
      probeUdpImpl: async () => ({ result: verdict === 'direct' ? 'ok' : 'blocked', rttMs: null, tries: 3 }),
      fetchImpl: (async () => {
        probes.push((now - started) / 1000);
        net = { path: verdict, udpInbound: verdict === 'direct' ? 'ok' : 'blocked', publicIp: '203.0.113.9', checkedAt: now / 1000 };
        return Response.json({ path: verdict, relay: null, reasons: [] });
      }) as unknown as typeof fetch,
    });
    const tick = async (seconds: number) => {
      now = started + seconds * 1000;
      await service.probeNet('speech', { id: 'r1', base: 'http://203.0.113.9:8443' }, { active: 0, max: 8, available: 8, transports: ['ws'], udpPorts: null, probePort: 50100, net }, 'token');
    };
    for (let s = 0; s <= 1200; s += 10) {
      if (s === 500) verdict = 'relay';
      if (s === 800) verdict = 'direct';
      await tick(s);
    }
    expect(probes).toEqual([0, 70, 200, 450, 760, 1070]);
    service.stop();
  });
});
