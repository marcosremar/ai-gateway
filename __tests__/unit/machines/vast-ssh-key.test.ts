import { describe, expect, it } from 'vitest';
import { parseMachineInput } from '../../../src/machines/spec';
import { VastMachineBackend } from '../../../src/machines/backends';
import { LIMITS } from './_fake-machines';

const KEY = `ssh-ed25519 ${'A'.repeat(68)} agent@test`;
const body = { provider: 'vast', machineType: 'RTX 3060', maxUsdPerHour: 0.3, maxHours: 1, image: 'ubuntu:24.04', sshPublicKey: KEY };
const market = { currentKey: 'k', pickOffers: async () => [{ id: 7, dph_total: 0.1 }] };

function fakeVast(sshReplies: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'PUT') return new Response(JSON.stringify({ success: true, new_contract: 4242 }));
    if (url.endsWith('/ssh/')) {
      const reply = sshReplies.shift() ?? { status: 200, body: { success: true } };
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }
    return new Response('{}');
  };
  return { calls, backend: new VastMachineBackend(market as never, fetchImpl, async () => {}) };
}

const create = (backend: VastMachineBackend) =>
  backend.create({ machineId: 'm1', namespace: 'ns', request: parseMachineInput(body, LIMITS).request });

describe('vast machine ssh key', () => {
  it('attaches the request sshPublicKey to the rented instance through the vast api', async () => {
    const { calls, backend } = fakeVast([]);
    const made = await create(backend);
    expect(made.providerId).toBe('4242');
    const attach = calls.find(c => c.url.endsWith('/instances/4242/ssh/'));
    expect(attach).toMatchObject({ method: 'POST', body: { ssh_key: KEY } });
  });

  it('retries a refused attach and releases the instance when it never sticks', async () => {
    const { calls, backend } = fakeVast([{ status: 500, body: {} }, { status: 200, body: { success: false, msg: 'no' } }, { status: 500, body: {} }]);
    await expect(create(backend)).rejects.toThrow(/ssh key not attached/);
    expect(calls.filter(c => c.url.endsWith('/ssh/'))).toHaveLength(3);
    expect(calls.some(c => c.method === 'DELETE' && c.url.endsWith('/instances/4242/'))).toBe(true);
  });

  it('the onstart keeps the init output in the instance log', async () => {
    const { calls, backend } = fakeVast([]);
    await create(backend);
    expect((calls.find(c => c.method === 'PUT')!.body as { onstart: string }).onstart).toMatch(/tee \/srv\/aigw\/init\.log/);
  });
});
