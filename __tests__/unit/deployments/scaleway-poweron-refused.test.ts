import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScalewayClient } from '../../../src/cpu-providers/scaleway-client';
import { placeReplica } from '../../../src/deployments/placement-walk';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { ScalewayDeploymentBackend } from '../../../src/deployments/scaleway-backend';
import { buildSpec } from '../../../src/deployments/spec';

const OUT_OF_STOCK = '{"type":"out_of_stock","message":"out of stock","resource":"L40S-1-48G"}';
const QUOTA = '{"type":"quotas_exceeded","message":"Quota exceeded for this resource.","resource":"cp_servers_type_L40S_1_48G","quota":0,"current":0}';
const PRICES = { 'L40S-1-48G': 1.4, 'L4-1-24G': 0.75, 'H100-1-80G': 2.73 };
const profiles = new Map(BUILTIN_PROFILES.map(p => [p.name, p]));
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

interface Cloud { refusal: [number, string]; acceptedPowerOns: number; calls: string[]; lines: string[] }

function cloud(refusal: [number, string], acceptedPowerOns: number): Cloud {
  const state: Cloud = { refusal, acceptedPowerOns, calls: [], lines: [] };
  const powerOns = new Map<string, number>();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace(/^.*\/zones\/[^/]+/, '').replace(/\?.*$/, '');
    const body = typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) as Record<string, string> : {};
    state.calls.push(`${method} ${path}${body.action ? ` ${body.action}` : ''}`);
    if (path === '/products/servers') return json({ servers: Object.fromEntries(Object.entries(PRICES).map(([type, price]) => [type, { hourly_price: price }])) });
    if (path === '/security_groups') return json({ security_groups: [{ id: 'sg-1', name: 'aigw-test-gateway-only' }] });
    if (method === 'POST' && path === '/servers') {
      return json({ server: { id: `srv-${body.commercial_type}`, name: 't', state: 'stopped', commercial_type: body.commercial_type } });
    }
    const id = /^\/servers\/([^/]+)/.exec(path)?.[1] ?? '';
    const refused = id === 'srv-L40S-1-48G';
    if (body.action === 'poweron' && refused) {
      powerOns.set(id, (powerOns.get(id) ?? 0) + 1);
      return powerOns.get(id)! > state.acceptedPowerOns ? new Response(state.refusal[1], { status: state.refusal[0] }) : json({ task: { status: 'pending' } });
    }
    if (method === 'GET' && id) {
      return json({ server: { id, name: 't', state: refused ? 'stopped' : 'starting', commercial_type: id.slice(4), public_ips: [{ address: '51.15.0.1', family: 'inet' }] } });
    }
    return json({});
  }));
  return state;
}

async function place(state: Cloud) {
  const logger = Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (line: string) => state.lines.push(line)]));
  const client = new ScalewayClient({ logger: logger as never });
  client.startPollMs = 0;
  const backend = new ScalewayDeploymentBackend('scw-secret', { projectId: 'proj-1', client });
  const spec = buildSpec('s', {
    image: 'me/app:1', port: 8000, minReplicas: 1, maxReplicas: 1, maxEurPerHour: 2, machineType: 'L40S-1-48G', zone: 'fr-par-2',
    placements: [{ machineType: 'L4-1-24G' }],
  }, { profiles });
  return placeReplica({
    spec, backendFor: () => backend,
    create: (on, placed) => on.createReplica({ spec: placed, replicaToken: 't'.repeat(32), namespace: 'test', cloudInit: '#!/bin/bash\ntrue' }),
  });
}

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('scaleway: a power-on refused at create', () => {
  for (const [name, accepted] of [['answered 412 at once', 0], ['accepted, the server still stopped, 412 when asked again', 1]] as const) {
    it(`out of stock, ${name}: not ready, the reason logged, the server deleted, the next placement tried`, async () => {
      const state = cloud([412, OUT_OF_STOCK], accepted);
      const placed = await place(state);

      expect(placed.machine).toMatchObject({ machineType: 'L4-1-24G', state: 'booting', pricePerHour: 0.7875 });
      expect(placed.placement).toContain('L40S-1-48G out of stock in fr-par-2');
      expect(state.calls.filter(c => c === 'POST /servers/srv-L40S-1-48G/action poweron')).toHaveLength(accepted + 1);
      expect(state.calls).toContain('POST /servers/srv-L40S-1-48G/action terminate');
      expect(state.calls).not.toContain('POST /servers/srv-L4-1-24G/action terminate');
      const refusal = state.lines.find(l => l.includes('srv-L40S-1-48G exists but did not start'));
      expect(refusal).toContain('out_of_stock');
      expect(state.lines.filter(l => l.includes('Server ready'))).toEqual([expect.stringContaining('srv-L4-1-24G')]);
    });
  }

  it('over quota at the power-on: the machine type is skipped like a quota refusal at the create', async () => {
    const state = cloud([403, QUOTA], 0);
    const placed = await place(state);

    expect(placed.machine.machineType).toBe('L4-1-24G');
    expect(placed.placement).toContain('quota reached for L40S-1-48G on scaleway');
    expect(state.calls).toContain('POST /servers/srv-L40S-1-48G/action terminate');
  });

  it('a server that stays stopped although every power-on is accepted fails the create and is deleted', async () => {
    const state = cloud([412, OUT_OF_STOCK], Infinity);
    const client = new ScalewayClient({ logger: { log: () => {}, warn: (line: string) => state.lines.push(line), error: () => {} } as never });
    client.startPollMs = 0;
    const waited = vi.spyOn(Date, 'now');
    let now = 0;
    waited.mockImplementation(() => (now += 30_000));

    await expect(client.createInstance({ region: 'fr-par-2', commercialType: 'L40S-1-48G', imageId: 'img', projectId: 'proj-1' }, { apiKey: 'k' }))
      .rejects.toThrow(/still stopped 120 s after its power-on/);
    waited.mockRestore();
    expect(state.calls).toContain('POST /servers/srv-L40S-1-48G/action terminate');
    expect(state.lines.some(l => l.includes('Server ready'))).toBe(false);
  });

  it('the ready line shows the catalog price of a type the client has no table price for', async () => {
    const state = cloud([412, OUT_OF_STOCK], 0);
    const client = new ScalewayClient({ logger: { log: (line: string) => state.lines.push(line), warn: () => {}, error: () => {} } as never });

    const made = await client.createInstance({ region: 'fr-par-2', commercialType: 'H100-1-80G', imageId: 'img', projectId: 'proj-1' }, { apiKey: 'k' });
    await client.createInstance({ region: 'fr-par-2', commercialType: 'UNLISTED-1', imageId: 'img', projectId: 'proj-1' }, { apiKey: 'k' });

    expect((made.providerMeta as { pricePerHr: number }).pricePerHr).toBe(2.73);
    expect(state.lines.filter(l => l.includes('Server ready')).map(l => /\((.*)\)$/.exec(l)?.[1])).toEqual(['€2.73/hr', 'price unknown']);
  });
});
