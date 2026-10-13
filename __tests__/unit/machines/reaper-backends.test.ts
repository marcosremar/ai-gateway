import { describe, expect, it } from 'vitest';
import { RunpodMachineBackend, ScalewayMachineBackend, VastMachineBackend } from '../../../src/machines/backends';
import { ownedMachinesFromGateway, reapMachines } from '../../../src/machines/reaper';
import { FakeMachineCloud, request } from './_fake-machines';

const NOW = Date.UTC(2026, 9, 10, 12);
const MIN = 60_000;

describe('external reaper over machines', () => {
  const setup = () => {
    const vast = new FakeMachineCloud('vast', () => NOW);
    const scw = new FakeMachineCloud('scaleway', () => NOW);
    const old = vast.add('prod', 'm-000000000001', NOW - 45 * MIN);
    const young = vast.add('prod', 'm-000000000002', NOW - 5 * MIN);
    const known = scw.add('prod', 'm-000000000003', NOW - 60 * MIN);
    const ancient = scw.add('prod', 'm-000000000004', NOW - 80 * 60 * MIN);
    const foreign = vast.add('dev-x', 'm-000000000005', NOW - 100 * 60 * MIN);
    return { vast, scw, old, young, known, ancient, foreign };
  };
  const base = { namespace: 'prod', now: () => NOW, sleep: async () => {}, probes: 2 };

  it('gateway down: every machine of the namespace past the minimum age goes, other namespaces stay', async () => {
    const s = setup();
    const r = await reapMachines({ ...base, backends: [s.vast, s.scw], gatewayUp: async () => false });
    expect(r.mode).toBe('gateway-down');
    expect(s.vast.released).toEqual([s.old.providerId]);
    expect(s.scw.released.sort()).toEqual([s.known.providerId, s.ancient.providerId].sort());
    expect(s.vast.machines.has(s.foreign.providerId)).toBe(true);
  });

  it('gateway up: releases what the gateway does not own, and anything past the lifetime even if owned', async () => {
    const s = setup();
    const owned = { ids: new Set(['m-000000000003', 'm-000000000004']) };
    const r = await reapMachines({ ...base, backends: [s.vast, s.scw], gatewayUp: async () => true, owned: async () => owned });
    expect(r.mode).toBe('cross-check');
    expect(s.vast.released).toEqual([s.old.providerId]);
    expect(s.scw.released).toEqual([s.ancient.providerId]);
  });

  it('gateway up with no trusted list: only the lifetime rule; a failing provider list spares nothing else; dry run releases nothing', async () => {
    const s = setup();
    s.vast.failList = true;
    const r = await reapMachines({ ...base, backends: [s.vast, s.scw], gatewayUp: async () => true, owned: async () => ({ skip: 'nope' }) });
    expect(r).toMatchObject({ mode: 'lifetime-only', skipped: 'nope', failed: ['list:vast'] });
    expect(s.scw.released).toEqual([s.ancient.providerId]);
    const dry = setup();
    const d = await reapMachines({ ...base, backends: [dry.vast], gatewayUp: async () => false, dryRun: true });
    expect(d.planned).toHaveLength(1);
    expect(dry.vast.released).toEqual([]);
  });

  it('trusts only the full admin list of the same namespace', async () => {
    const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const call = (fetchImpl: typeof fetch) => ownedMachinesFromGateway({ gatewayUrl: 'https://gw', adminKey: 'k', namespace: 'prod', fetchImpl });
    expect(await call(answer({ namespace: 'prod', scope: 'owner', machines: [] }))).toHaveProperty('skip');
    expect(await call(answer({ namespace: 'dev', scope: 'all', machines: [] }))).toHaveProperty('skip');
    expect(await call(answer({}, 404))).toHaveProperty('skip');
    const ok = await call(answer({ namespace: 'prod', scope: 'all', machines: [{ id: 'm-1', status: 'running' }, { id: 'm-2', status: 'released' }] }));
    expect(ok).toEqual({ ids: new Set(['m-1']) });
  });
});

describe('machine backends never see deployment replicas', () => {
  it('scaleway: tags its machines aigw-machine/aigw-mns/aigw-mid, opens only the asked ports, lists only its namespace', async () => {
    const created: Array<Record<string, unknown>> = [];
    const groups: Array<{ name: string; rules: unknown }> = [];
    const server = (tags: string[]) => ({ instanceId: `fr-par-2/${tags.join('.')}`, ipAddress: '51.1.1.1', providerMeta: { tags, state: 'running', createdAt: new Date(NOW).toISOString() } });
    const client = {
      getHourlyPrice: async () => 0.5,
      defaultProjectId: async () => 'proj',
      listSecurityGroups: async () => [],
      createSecurityGroup: async (_z: string, _c: unknown, o: { name: string; rules: unknown }) => { groups.push(o); return 'sg-1'; },
      createInstance: async (spec: Record<string, unknown>) => { created.push(spec); return server(spec.tags as string[]); },
      listInstancesByTag: async () => [
        server(['aigw-machine', 'aigw-mns-prod', 'aigw-mid-m-1']),
        server(['aigw-deploy', 'aigw-ns-prod', 'aigw-dep-tts']),
        server(['aigw-machine', 'aigw-mns-other', 'aigw-mid-m-2']),
      ],
      releaseInstance: async () => {},
    };
    const b = new ScalewayMachineBackend(client as never, () => 'scw-secret', () => undefined);
    const m = await b.create({ machineId: 'm-1', namespace: 'prod', request: request({ provider: 'scaleway', machineType: 'L4-1-24G', maxUsdPerHour: 1, sshPublicKey: 'ssh-ed25519 AAAA', ports: [{ protocol: 'udp', port: 50000, to: 50010 }] }) });
    expect(created[0].tags).toEqual(['aigw-machine', 'aigw-mns-prod', 'aigw-mid-m-1']);
    expect(String(created[0].cloudInit)).toContain('--gpus all');
    expect(groups[0].rules).toEqual([{ protocol: 'TCP', port: 22 }, { protocol: 'UDP', port: 50000, portTo: 50010 }]);
    expect(m.usdPerHour).toBe(0.6);
    expect((await b.list('prod')).map(x => x.machineId)).toEqual(['m-1']);
    await expect(b.create({ machineId: 'm-9', namespace: 'prod', request: request({ provider: 'scaleway', maxUsdPerHour: 0.5 }) })).rejects.toThrow(/out_of_stock/);
  });

  it('vast: rents under the cap with label aigw-m:<ns>:<id>, maps each port, ignores deployment labels', async () => {
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes('/asks/')) return new Response(JSON.stringify({ success: true, new_contract: 77 }));
      return new Response(JSON.stringify({ instances: [
        { id: 77, label: 'aigw-m:prod:m-1', actual_status: 'running', public_ipaddr: '1.2.3.4', ports: { '22/tcp': [{ HostPort: '41000' }] }, dph_total: 0.3, start_date: NOW / 1000 },
        { id: 78, label: 'aigw:prod:tts', actual_status: 'running' },
        { id: 79, label: 'aigw-m:dev:m-2', actual_status: 'running' },
      ] }));
    };
    const market = { currentKey: 'vast-key', pickOffers: async () => [
      { id: 1, dph_total: 0.9, reliability2: 1, inet_down: 900, direct_port_count: 10 },
      { id: 2, dph_total: 0.3, reliability2: 1, inet_down: 900, direct_port_count: 1 },
      { id: 3, dph_total: 0.35, reliability2: 1, inet_down: 900, direct_port_count: 10 },
    ] };
    const b = new VastMachineBackend(market as never, fetchImpl as never);
    const req = request({ maxUsdPerHour: 0.5, sshPublicKey: 'ssh-ed25519 AAAA', ports: [{ protocol: 'udp', port: 7000 }] });
    expect(await b.quote(req)).toBe(0.35);
    const m = await b.create({ machineId: 'm-1', namespace: 'prod', request: req });
    const rent = calls.find(c => c.url.includes('/asks/'))!;
    expect(rent.url).toContain('/asks/3/');
    expect(rent.body).toMatchObject({ label: 'aigw-m:prod:m-1', image: req.image });
    expect(rent.body!.env).toMatchObject({ '-p 22:22': '1', '-p 7000:7000/udp': '1' });
    expect(m).toMatchObject({ providerId: '77', usdPerHour: 0.35 });
    expect(await b.list('prod')).toEqual([expect.objectContaining({ machineId: 'm-1', ip: '1.2.3.4', ports: { '22/tcp': 41000 } })]);
  });

  it('runpod: names the pod aigw-m:<ns>:<id>, passes the SSH key, releases a pod priced over the cap', async () => {
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
    let price = 0.4;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/pods') && init?.method === 'POST') return new Response(JSON.stringify({ id: 'pod-1', name: 'aigw-m:prod:m-1', costPerHr: price, desiredStatus: 'RUNNING' }));
      if (init?.method === 'DELETE') return new Response('{}');
      return new Response(JSON.stringify([{ id: 'pod-1', name: 'aigw-m:prod:m-1', desiredStatus: 'RUNNING', publicIp: '9.9.9.9', portMappings: { 22: 10022 } }, { id: 'pod-2', name: 'parle-x' }]));
    };
    const b = new RunpodMachineBackend(() => 'rp-key', fetchImpl);
    const req = request({ provider: 'runpod', machineType: 'NVIDIA RTX A4000', sshPublicKey: 'ssh-ed25519 AAAA' });
    await b.create({ machineId: 'm-1', namespace: 'prod', request: req });
    const create = calls.find(c => c.method === 'POST')!;
    expect(create.body).toMatchObject({ name: 'aigw-m:prod:m-1', gpuTypeIds: ['NVIDIA RTX A4000'], ports: ['22/tcp'], env: { PUBLIC_KEY: 'ssh-ed25519 AAAA' } });
    expect(await b.list('prod')).toEqual([expect.objectContaining({ machineId: 'm-1', ip: '9.9.9.9', ports: { '22/tcp': 10022 } })]);
    price = 0.9;
    await expect(b.create({ machineId: 'm-2', namespace: 'prod', request: req })).rejects.toThrow(/above the cap/);
    expect(calls.some(c => c.method === 'DELETE')).toBe(true);
  });
});
