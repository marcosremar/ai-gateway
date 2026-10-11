import { describe, expect, it } from 'vitest';
import { parseMachineInput } from '../../../src/machines/spec';
import { VastMachineBackend } from '../../../src/machines/backends';
import { LIMITS } from './_fake-machines';

const body = { machineType: 'RTX 3060', maxUsdPerHour: 0.3, maxHours: 1, image: 'ubuntu:24.04' };

describe('machines chosen by CPU and RAM', () => {
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
