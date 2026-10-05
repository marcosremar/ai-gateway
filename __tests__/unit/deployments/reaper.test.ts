import { describe, expect, it } from 'vitest';
import { reapIfGatewayDown } from '../../../src/deployments/reaper';
import type { ReplicaMachine } from '../../../src/deployments/types';

const NOW = 10_000_000;
const machine = (id: string, ageMin: number): ReplicaMachine => ({
  id, deployment: 'tts', ip: null, state: 'running', createdAt: NOW - ageMin * 60_000, zone: 'fr-par-2', machineType: 'L4-1-24G', pricePerHour: 0.75,
});

function backend(machines: ReplicaMachine[], failOn: string[] = []) {
  const released: string[] = [];
  return {
    released,
    listReplicas: async (ns: string) => (ns === 'prod' ? machines : []),
    releaseReplica: async (m: ReplicaMachine) => {
      if (failOn.includes(m.id)) throw new Error('boom');
      released.push(m.id);
    },
  };
}

const base = { namespace: 'prod', now: () => NOW, sleep: async () => {}, probes: 4 };

describe('reapIfGatewayDown', () => {
  it('touches nothing when the gateway answers any probe (a redeploy blip never costs a class its machine)', async () => {
    const b = backend([machine('a', 120)]);
    let calls = 0;
    const r = await reapIfGatewayDown({ ...base, backend: b, gatewayUp: async () => ++calls === 3 });
    expect(r).toMatchObject({ gatewayUp: true, released: [] });
    expect(b.released).toEqual([]);
  });

  it('gateway down on every probe: releases the namespace machines older than the minimum age', async () => {
    const b = backend([machine('old', 45), machine('young', 5)]);
    const r = await reapIfGatewayDown({ ...base, backend: b, gatewayUp: async () => false });
    expect(r).toMatchObject({ gatewayUp: false, seen: 2, released: ['old'], failed: [] });
  });

  it('a probe that throws counts as down; a failed release is reported and the rest still go', async () => {
    const b = backend([machine('a', 60), machine('b', 60)], ['a']);
    const r = await reapIfGatewayDown({ ...base, backend: b, gatewayUp: async () => { throw new Error('ECONNREFUSED'); } });
    expect(r).toMatchObject({ released: ['b'], failed: ['a'] });
  });
});
