import { describe, expect, it } from 'vitest';
import { parseMachineInput } from '../../../src/machines/spec';
import { VastMachineBackend } from '../../../src/machines/backends';
import { LIMITS } from './_fake-machines';

const body = { machineType: 'RTX 3060', maxUsdPerHour: 0.3, maxHours: 1, image: 'ubuntu:24.04' };

describe('machines chosen by CPU and RAM', () => {
  it('minGpuFrac is validated, forces vast and skips sliced offers', async () => {
    expect(parseMachineInput({ ...body, minGpuFrac: 1 }, LIMITS).request).toMatchObject({ provider: 'vast', minGpuFrac: 1 });
    expect(() => parseMachineInput({ ...body, minGpuFrac: 0 }, LIMITS)).toThrow(/minGpuFrac/);
    expect(() => parseMachineInput({ ...body, provider: 'runpod', minGpuFrac: 1 }, LIMITS)).toThrow(/vast/);
    const asked: Array<Record<string, unknown>> = [];
    const market = { currentKey: 'k', pickOffers: async (spec: Record<string, unknown>) => { asked.push(spec); return []; } };
    await new VastMachineBackend(market as never).quote(parseMachineInput({ ...body, minGpuFrac: 1 }, LIMITS).request);
    expect(asked[0]).toMatchObject({ minGpuFrac: 1 });
  });

  it('minCpuCores/minRamGb send a cheapest request to vast and are refused on scaleway and runpod', () => {
    expect(parseMachineInput({ ...body, minCpuCores: 32, minRamGb: 64 }, LIMITS).request).toMatchObject({ provider: 'vast', minCpuCores: 32, minRamGb: 64 });
    expect(parseMachineInput(body, LIMITS).request.provider).toBe('cheapest');
    expect(() => parseMachineInput({ ...body, provider: 'scaleway', minCpuCores: 32 }, LIMITS)).toThrow(/vast/);
    expect(() => parseMachineInput({ ...body, provider: 'runpod', minRamGb: 64 }, LIMITS)).toThrow(/vast/);
    expect(() => parseMachineInput({ ...body, minCpuCores: 0 }, LIMITS)).toThrow(/minCpuCores/);
  });

  it('the vast machine backend asks the market for hosts with those cores and that RAM', async () => {
    const asked: Array<Record<string, unknown>> = [];
    const market = { currentKey: 'k', pickOffers: async (spec: Record<string, unknown>) => { asked.push(spec); return []; } };
    const backend = new VastMachineBackend(market as never);
    await backend.quote(parseMachineInput({ ...body, minCpuCores: 32, minRamGb: 64 }, LIMITS).request);
    expect(asked[0]).toMatchObject({ minCpuCores: 32, minRamGb: 64 });
  });
});

describe('several GPU types in one request', () => {
  it('alsoMachineTypes is validated and forces vast', () => {
    const r = parseMachineInput({ ...body, machineType: 'RTX A4000', alsoMachineTypes: ['RTX 3060', 'RTX 3070', 'RTX A4000', 'RTX 3060'] }, LIMITS).request;
    expect(r).toMatchObject({ provider: 'vast', alsoMachineTypes: ['RTX 3060', 'RTX 3070'] });
    expect(() => parseMachineInput({ ...body, alsoMachineTypes: 'RTX 3060' }, LIMITS)).toThrow(/alsoMachineTypes/);
    expect(() => parseMachineInput({ ...body, alsoMachineTypes: ['a', 'b', 'c', 'd', 'e', 'f'] }, LIMITS)).toThrow(/at most 5/);
    expect(() => parseMachineInput({ ...body, provider: 'scaleway', machineType: 'RTX A4000', alsoMachineTypes: ['RTX 3060'] }, LIMITS)).toThrow(/vast/);
  });

  it('merges the offers of every type, cheapest first, and survives one type failing', async () => {
    const offer = (id: number, dph: number) => ({ id, dph_total: dph, direct_port_count: 99 });
    const market = {
      currentKey: 'k',
      pickOffers: async (spec: { machineType: string }) => {
        if (spec.machineType === 'RTX 3070') throw new Error('vast down for this type');
        return spec.machineType === 'RTX A4000' ? [offer(1, 0.15), offer(2, 0.2)] : [offer(3, 0.08), offer(4, 0.12)];
      },
    };
    const backend = new VastMachineBackend(market as never);
    const req = parseMachineInput({ ...body, machineType: 'RTX A4000', maxUsdPerHour: 0.16, alsoMachineTypes: ['RTX 3060', 'RTX 3070'] }, LIMITS).request;
    expect((await backend.offers(req) as Array<{ id: number }>).map(o => o.id)).toEqual([3, 4, 1]);
    expect(await backend.quote(req)).toBe(0.08);
  });
});
