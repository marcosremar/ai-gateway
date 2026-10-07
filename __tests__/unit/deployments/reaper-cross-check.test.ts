/**
 * External reaper (src/deployments/reaper.ts, scripts/reap-orphans.ts), 2026-10-07: before, it acted only when the
 * gateway's /health was down. Now, with the gateway UP, it cross-checks the provider machines (Scaleway tags, Vast
 * labels) against the gateway's own `GET /v1/deployments` and releases machines (and Scaleway IPs / security groups)
 * that no deployment owns past a grace; it is a dry run unless asked to apply.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { ownedFromGateway, reapOrphans, type NetworkResource, type NetworkSweeper } from '../../../src/deployments/reaper';
import { ScalewayNetworkSweeper } from '../../../src/deployments/scaleway-leftovers';
import { ScalewayDeploymentBackend } from '../../../src/deployments/scaleway-backend';
import { VastDeploymentBackend } from '../../../src/deployments/vast-backend';
import { DeploymentController } from '../../../src/deployments/controller';
import { createDeploymentRoutes, HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import type { ReplicaMachine } from '../../../src/deployments/types';
import { FakeCloud } from './_fake-cloud';

const NOW = 10_000_000_000;
const MIN = 60_000;
const machine = (id: string, deployment: string, ageMin: number): ReplicaMachine => ({
  id, deployment, ip: null, state: 'running', createdAt: NOW - ageMin * MIN, zone: 'fr-par-2', machineType: 'L4-1-24G', pricePerHour: 0.75,
});

function backend(provider: string, machines: ReplicaMachine[]) {
  const released: string[] = [];
  return {
    provider, released,
    listReplicas: async (ns: string) => (ns === 'prod' ? machines : []),
    releaseReplica: async (m: ReplicaMachine) => { released.push(m.id); },
  };
}

const up = { namespace: 'prod', now: () => NOW, sleep: async () => {}, probes: 4, gatewayUp: async () => true };

describe('reaper, gateway up: cross-check against GET /v1/deployments', () => {
  it('releases only machines of no deployment, older than the grace, on every provider', async () => {
    const scw = backend('scaleway', [machine('owned', 'tts', 300), machine('ghost', 'deleted-dep', 45), machine('young-ghost', 'deleted-dep', 5)]);
    const vast = backend('vast', [machine('vast-ghost', 'old-speech', 120), machine('vast-owned', 'parle-speech', 120)]);
    const r = await reapOrphans({ ...up, backends: [scw, vast], owned: async () => ({ names: new Set(['tts', 'parle-speech']) }) });
    expect(r).toMatchObject({ gatewayUp: true, mode: 'cross-check', dryRun: false, seen: 5, failed: [] });
    expect(scw.released).toEqual(['ghost']);
    expect(vast.released).toEqual(['vast-ghost']);
    expect(r.planned).toEqual(['scaleway:ghost', 'vast:vast-ghost']);
  });

  it('honours a custom grace', async () => {
    const scw = backend('scaleway', [machine('ghost', 'x', 10)]);
    await reapOrphans({ ...up, backends: [scw], graceMs: 5 * MIN, owned: async () => ({ names: new Set() }) });
    expect(scw.released).toEqual(['ghost']);
  });

  it('an untrusted or failed deployments answer skips the cross-check: nothing released', async () => {
    for (const owned of [async () => ({ skip: 'not the full admin list' }), async () => { throw new Error('ECONNRESET'); }]) {
      const scw = backend('scaleway', [machine('ghost', 'x', 300)]);
      const r = await reapOrphans({ ...up, backends: [scw], owned });
      expect(r).toMatchObject({ gatewayUp: true, mode: 'none', released: [] });
      expect(r.skipped).toBeTruthy();
      expect(scw.released).toEqual([]);
    }
  });

  it('without an admin key (no `owned`) the gateway-up run does nothing, as before', async () => {
    const scw = backend('scaleway', [machine('ghost', 'x', 300)]);
    const r = await reapOrphans({ ...up, backends: [scw] });
    expect(r).toMatchObject({ mode: 'none', released: [] });
    expect(scw.released).toEqual([]);
  });

  it('a provider whose list fails is reported and the other still reaped', async () => {
    const vast = backend('vast', [machine('vast-ghost', 'gone', 120)]);
    const broken = { provider: 'scaleway', listReplicas: async () => { throw new Error('HTTP 503'); }, releaseReplica: vi.fn() };
    const r = await reapOrphans({ ...up, backends: [broken, vast], owned: async () => ({ names: new Set() }) });
    expect(r.failed).toEqual(['list:scaleway']);
    expect(vast.released).toEqual(['vast-ghost']);
  });

  it('network leftovers: unused IPs/groups of a deployment the gateway lacks go; owned, in use, shared or young stay', async () => {
    const res = (kind: NetworkResource['kind'], id: string, deployment: string | null, inUse: boolean, ageMin: number | null): NetworkResource => ({
      kind, id, zone: 'fr-par-2', deployment, inUse, createdAt: ageMin === null ? null : NOW - ageMin * MIN, label: id,
    });
    const released: string[] = [];
    const sweeper: NetworkSweeper = {
      provider: 'scaleway',
      listNetwork: async () => ({ resources: [
        res('ip', 'ip-gone', 'livekit-old', false, null),
        res('ip', 'ip-owned', 'livekit', false, null), // exposed deployment scaled to zero keeps its IP
        res('ip', 'ip-attached', 'livekit-old', true, null),
        res('security-group', 'sg-gone', 'livekit-old', false, 90),
        res('security-group', 'sg-young', 'livekit-old', false, 5),
        res('security-group', 'sg-shared', null, false, 900), // aigw-<ns>-gateway-only
      ], errors: ['scaleway:pl-waw-3: HTTP 503'] }),
      releaseNetwork: async (r) => { released.push(r.id); },
    };
    const r = await reapOrphans({ ...up, backends: [], networks: [sweeper], owned: async () => ({ names: new Set(['livekit']) }) });
    expect(released).toEqual(['ip-gone', 'sg-gone']);
    expect(r.released).toEqual(['scaleway:ip:fr-par-2/ip-gone', 'scaleway:security-group:fr-par-2/sg-gone']);
    expect(r.failed).toEqual(['list-network:scaleway:pl-waw-3: HTTP 503']);
  });

  it('gateway down never touches network resources (it cannot know which deployments exist)', async () => {
    const sweeper = { listNetwork: vi.fn(async () => ({ resources: [], errors: [] })), releaseNetwork: vi.fn() };
    await reapOrphans({ ...up, gatewayUp: async () => false, backends: [], networks: [sweeper] });
    expect(sweeper.listNetwork).not.toHaveBeenCalled();
  });
});

describe('reaper dry run', () => {
  it('reports what it would release and releases nothing (gateway down and up)', async () => {
    const down = backend('scaleway', [machine('old', 'tts', 60)]);
    const r1 = await reapOrphans({ ...up, gatewayUp: async () => false, backends: [down], dryRun: true });
    expect(r1).toMatchObject({ mode: 'gateway-down', dryRun: true, planned: ['scaleway:old'], released: [] });
    expect(down.released).toEqual([]);
    const ghost = backend('vast', [machine('ghost', 'gone', 60)]);
    const r2 = await reapOrphans({ ...up, backends: [ghost], dryRun: true, owned: async () => ({ names: new Set() }) });
    expect(r2).toMatchObject({ mode: 'cross-check', planned: ['vast:ghost'], released: [] });
    expect(ghost.released).toEqual([]);
  });
});

describe('reaper over the real Vast backend (labels aigw:<ns>:<deployment>)', () => {
  it('lists only its namespace by label and deletes the orphan instance', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url.replace('https://console.vast.ai/api/v0', '')}`);
      if ((init?.method ?? 'GET') === 'GET') {
        return Response.json({ instances: [
          { id: 11, label: 'aigw:prod:old-speech', actual_status: 'exited', start_date: (NOW - 120 * MIN) / 1000 },
          { id: 12, label: 'aigw:prod:parle-speech', actual_status: 'running', start_date: (NOW - 120 * MIN) / 1000 },
          { id: 13, label: 'aigw:staging:old-speech', actual_status: 'running', start_date: (NOW - 120 * MIN) / 1000 },
          { id: 14, label: 'someone-else', actual_status: 'running', start_date: (NOW - 120 * MIN) / 1000 },
        ] });
      }
      return Response.json({ success: true });
    });
    const vast = new VastDeploymentBackend('k', { fetch: fetchImpl as never, now: () => NOW });
    const r = await reapOrphans({ ...up, backends: [vast], owned: async () => ({ names: new Set(['parle-speech']) }) });
    expect(r).toMatchObject({ seen: 2, released: ['11'], failed: [] });
    expect(calls).toEqual(['GET /instances/', 'DELETE /instances/11/']);
  });
});

describe('ScalewayNetworkSweeper', () => {
  it('reads tagged IPs and groups per zone, re-checks the tag, deletes with 404 as done', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${url.replace('https://api.scaleway.com/instance/v1', '')}`);
      expect((init?.headers as Record<string, string>)['X-Auth-Token']).toBe('secret');
      if (init?.method === 'DELETE') return new Response('', { status: 404 });
      if (url.includes('/ips?')) {
        return Response.json({ ips: [
          { id: 'ip1', address: '51.0.0.1', tags: ['aigw-deploy', 'aigw-ns-prod', 'aigw-dep-rtc'], server: null },
          { id: 'ip2', address: '51.0.0.2', tags: ['aigw-deploy', 'aigw-ns-prod', 'aigw-dep-rtc'], server: { id: 's1' } },
          { id: 'ip3', address: '51.0.0.3', tags: ['other'] },
        ] });
      }
      return Response.json({ security_groups: [
        { id: 'sg1', name: 'aigw-prod-rtc', tags: ['aigw-deploy', 'aigw-ns-prod', 'aigw-dep-rtc'], servers: [], creation_date: '2026-10-01T00:00:00Z' },
        { id: 'sg2', name: 'aigw-prod-gateway-only', tags: ['aigw-deploy', 'aigw-ns-prod'], servers: [{ id: 's1' }] },
      ] });
    });
    const sweeper = new ScalewayNetworkSweeper('secret', { zones: ['fr-par-2'], projectId: 'p1', fetch: fetchImpl as never });
    const { resources, errors } = await sweeper.listNetwork('prod');
    expect(errors).toEqual([]);
    expect(resources).toEqual([
      { kind: 'ip', id: 'ip1', zone: 'fr-par-2', deployment: 'rtc', inUse: false, createdAt: null, label: 'ip 51.0.0.1 (fr-par-2)' },
      { kind: 'ip', id: 'ip2', zone: 'fr-par-2', deployment: 'rtc', inUse: true, createdAt: null, label: 'ip 51.0.0.2 (fr-par-2)' },
      { kind: 'security-group', id: 'sg1', zone: 'fr-par-2', deployment: 'rtc', inUse: false, createdAt: Date.parse('2026-10-01T00:00:00Z'), label: 'security group aigw-prod-rtc (fr-par-2)' },
      { kind: 'security-group', id: 'sg2', zone: 'fr-par-2', deployment: null, inUse: true, createdAt: null, label: 'security group aigw-prod-gateway-only (fr-par-2)' },
    ]);
    expect(seen[0]).toBe('GET /zones/fr-par-2/ips?tags=aigw-ns-prod&per_page=100&project=p1');
    await sweeper.releaseNetwork(resources[0]!);
    expect(seen.at(-1)).toBe('DELETE /zones/fr-par-2/ips/ip1');
  });

  it('a zone that fails is reported, not fatal', async () => {
    const sweeper = new ScalewayNetworkSweeper('s', { zones: ['fr-par-1'], fetch: (async () => new Response('', { status: 503 })) as never });
    const out = await sweeper.listNetwork('prod');
    expect(out.resources).toEqual([]);
    expect(out.errors[0]).toContain('scaleway:fr-par-1');
  });
});

describe('Scaleway backend for the reaper', () => {
  it('awaitVolumes: the reaper waits for the SBS volumes (its process exits right after); the gateway does not', async () => {
    const client = { releaseInstance: vi.fn(async () => {}) } as never;
    await new ScalewayDeploymentBackend('k', { client, awaitVolumes: true }).releaseReplica(machine('fr-par-2/x', 'a', 1));
    await new ScalewayDeploymentBackend('k', { client }).releaseReplica(machine('fr-par-2/y', 'a', 1));
    const calls = (client as { releaseInstance: ReturnType<typeof vi.fn> }).releaseInstance.mock.calls;
    expect(calls[0]![2]).toEqual({ awaitVolumes: true });
    expect(calls[1]![2]).toEqual({ awaitVolumes: false });
  });
});

describe('ownedFromGateway', () => {
  const servers: Server[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(r => s.close(r)); } });

  async function gateway() {
    const controller = new DeploymentController({ backend: new FakeCloud(), store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'prod' });
    await controller.init();
    await controller.put('tts', { profile: 'cpu-echo' });
    controller.stop();
    const handler = createDeploymentRoutes({
      controller, isAdmin: req => req.headers.authorization === 'Bearer admin', userOf: req => (req.headers.authorization === 'Bearer app' ? 'site-a' : 'owner'),
    });
    const server = createServer((req, res) => { if (!handler(req, res, (req.url ?? '').split('?')[0]!, req.method ?? 'GET')) { res.writeHead(404); res.end(); } });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('trusts only the full admin list of the same namespace', async () => {
    const url = await gateway();
    expect(await ownedFromGateway({ gatewayUrl: url, adminKey: 'admin', namespace: 'prod' })).toEqual({ names: new Set(['tts']) });
    // An app key sees its own app's deployments only: never read as "the rest does not exist".
    expect(await ownedFromGateway({ gatewayUrl: url, adminKey: 'app', namespace: 'prod' })).toMatchObject({ skip: expect.stringContaining('full admin list') });
    expect(await ownedFromGateway({ gatewayUrl: url, adminKey: 'admin', namespace: 'staging' })).toMatchObject({ skip: expect.stringContaining("is not 'staging'") });
  });

  it('a gateway build without `scope`, or a non-2xx, is a skip', async () => {
    const old = (async () => Response.json({ namespace: 'prod', deployments: [] })) as never;
    expect(await ownedFromGateway({ gatewayUrl: 'http://gw', adminKey: 'a', namespace: 'prod', fetchImpl: old })).toHaveProperty('skip');
    const denied = (async () => new Response('', { status: 401 })) as never;
    expect(await ownedFromGateway({ gatewayUrl: 'http://gw', adminKey: 'a', namespace: 'prod', fetchImpl: denied })).toEqual({ skip: 'GET /v1/deployments answered HTTP 401' });
  });
});
