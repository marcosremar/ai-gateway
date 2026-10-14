import { describe, expect, it } from 'vitest';
import { parseMachineInput, VAST_VM_IMAGE } from '../../../src/machines/spec';
import { VastMachineBackend } from '../../../src/machines/backends';
import { VastDeploymentBackend } from '../../../src/deployments/vast-backend';
import { LIMITS } from './_fake-machines';

const body = { machineType: 'any', maxUsdPerHour: 0.5, maxHours: 2, vm: true, sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMmmGMMUe9ZZ9tf/pxQtrW2xAMrHKtxA79baTWEjc0jq me' };

describe('vast KVM machines', () => {
  it('vm rents a vast KVM host with the vast VM image and refuses other images and providers', () => {
    expect(parseMachineInput(body, LIMITS).request).toMatchObject({ provider: 'vast', vm: true, image: VAST_VM_IMAGE });
    expect(() => parseMachineInput({ ...body, image: 'ubuntu:24.04' }, LIMITS)).toThrow(/vastai\/kvm/);
    expect(() => parseMachineInput({ ...body, provider: 'runpod' }, LIMITS)).toThrow(/vast/);
  });

  it('the market search keeps VM hosts and drops the GPU filter for any', () => {
    const search = new VastDeploymentBackend({ apiKey: 'k' } as never).searchBody({ machineType: 'any', vm: true, maxEurPerHour: 1 } as never, 0.95);
    expect(search.vms_enabled).toEqual({ eq: true });
    expect(search.gpu_name).toBeUndefined();
  });

  it('puts the ssh key on the account before renting and never on the instance', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string, init: { method: string }) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      const json = init.method === 'PUT' ? { success: true, new_contract: 7 } : init.method === 'GET' ? { keys: [] } : {};
      return new Response(JSON.stringify(json));
    };
    const market = { currentKey: 'k', pickOffers: async () => [{ id: 1, dph_total: 0.2, reliability2: 1, inet_down: 1000 }] };
    const backend = new VastMachineBackend(market as never, fetchImpl as never);
    await backend.create({ machineId: 'm-1', namespace: 'ns', request: parseMachineInput(body, LIMITS).request });
    expect(calls.findIndex(c => c.startsWith('POST') && c.endsWith('/ssh/'))).toBeLessThan(calls.findIndex(c => c.startsWith('PUT')));
    expect(calls.some(c => c.includes('/instances/'))).toBe(false);
  });
});
