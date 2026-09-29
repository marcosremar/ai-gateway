/**
 * RunPod REST v1 + GPU catalog for callers with their own create policy: one patient wait on 429 within the
 * Retry-After budget, pod operations, create outcome without a retry loop, and the pod readiness wait.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRunpodRest, runpodRetryAfterS, runpodTime, waitForRunpodPod, type RunpodPod } from '../../src/gateway/providers/gpu/runpod/rest';

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

function rest(responses: Response[]) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const sleeps: number[] = [];
  const r = createRunpodRest({
    apiKey: 'k', sleep: async (ms) => { sleeps.push(ms); },
    fetch: vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), method: init.method ?? 'GET', body: init.body as string | undefined });
      const next = responses.shift();
      if (!next) throw new Error('unexpected call');
      return next;
    }),
  });
  return { r, calls, sleeps };
}

describe('runpod rest', () => {
  it('waits once on a 429 whose Retry-After fits the budget, and hands back a longer one', async () => {
    const fits = rest([reply('', 429, { 'retry-after': '3' }), reply([{ id: 'p1' }])]);
    expect(await fits.r.listPods()).toEqual([{ id: 'p1' }]);
    expect(fits.sleeps).toEqual([3000]);
    const long = rest([reply('', 429, { 'retry-after': '90' })]);
    expect(await long.r.listPods()).toBeNull();
    expect(long.sleeps).toEqual([]);
    const none = rest([reply('', 429)]);
    expect(await none.r.listPods()).toBeNull();
  });

  it('delete: 404 is deleted, other errors throw; stop/start return the status', async () => {
    const { r, calls } = rest([reply('', 404), reply('', 500), reply('', 200), reply('', 200)]);
    await expect(r.deletePod('p1')).resolves.toBeUndefined();
    await expect(r.deletePod('p1')).rejects.toThrow(/HTTP 500/);
    expect(await r.stopPod('p1')).toBe(200);
    expect(await r.startPod('p1', { PUBLIC_KEY: 'ssh-ed25519 AAA' })).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://rest.runpod.io/v1', '')}`)).toEqual([
      'DELETE /pods/p1', 'DELETE /pods/p1', 'POST /pods/p1/stop', 'POST /pods/p1/start',
    ]);
    expect(JSON.parse(calls[3]!.body!)).toEqual({ env: { PUBLIC_KEY: 'ssh-ed25519 AAA' } });
  });

  it('create: one attempt, the pod or the status with a body cut to 160 chars and the Retry-After', async () => {
    const { r, sleeps } = rest([
      reply({ id: 'p9', costPerHr: 0.2 }, 201),
      reply('x'.repeat(400), 500),
      reply('', 429, { 'retry-after': '5' }),
    ]);
    expect(await r.createPod({ name: 'a' })).toMatchObject({ ok: true, pod: { id: 'p9' } });
    const failed = await r.createPod({ name: 'a' });
    expect(failed).toMatchObject({ ok: false, status: 500 });
    expect(failed.ok === false && failed.body.length).toBe(160);
    expect(await r.createPod({ name: 'a' })).toMatchObject({ ok: false, status: 429, retryAfterS: 5 });
    expect(sleeps).toEqual([]);
  });

  it('GPU catalog keeps priced types only', async () => {
    const { r } = rest([reply({ data: { gpuTypes: [
      { id: 'NVIDIA GeForce RTX 3070', displayName: 'RTX 3070', memoryInGb: 8, communityCloud: true,
        lowestPrice: { uninterruptablePrice: 0.13, stockStatus: 'High' } },
      { id: 'NVIDIA A100', displayName: 'A100', memoryInGb: 80, lowestPrice: { uninterruptablePrice: null } },
    ] } })]);
    expect(await r.gpuTypes()).toEqual([{ id: 'NVIDIA GeForce RTX 3070', displayName: 'RTX 3070', memoryInGb: 8, pricePerHr: 0.13,
      stockStatus: 'High', communityCloud: true, secureCloud: false }]);
  });

  it('parses Retry-After seconds and Go-format times', () => {
    expect(runpodRetryAfterS(new Headers({ 'retry-after': '4' }))).toBe(4);
    expect(runpodRetryAfterS({ 'retry-after': '' })).toBeNull();
    expect(runpodTime('2026-09-22 20:21:47.876 +0000 UTC')).toBe(Date.parse('2026-09-22T20:21:47.876Z'));
    expect(runpodTime('garbage')).toBeNull();
  });
});

describe('waitForRunpodPod', () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

  it('polls until the check passes; a non-2xx read is just not yet', async () => {
    const reads: Array<RunpodPod | null> = [null, { id: 'p', desiredStatus: 'RUNNING' }, { id: 'p', desiredStatus: 'RUNNING', publicIp: '1.2.3.4' }];
    const out = await waitForRunpodPod({ getPod: async () => ({ status: 200, pod: reads.shift() ?? null }) }, 'p',
      async (pod) => (pod.publicIp ? pod.publicIp : null), { deadline: 60_000, ...clock() });
    expect(out).toBe('1.2.3.4');
  });

  it('a ghost pod throws at once; the deadline ends the wait', async () => {
    await expect(waitForRunpodPod({ getPod: async () => ({ status: 200, pod: { desiredStatus: 'RUNNING' } }) }, 'p', async () => null,
      { deadline: 600_000, ghost: (_pod, elapsed) => elapsed >= 9000, ...clock() })).rejects.toThrow(/fantasma/);
    await expect(waitForRunpodPod({ getPod: async () => ({ status: 500, pod: null }) }, 'p', async () => 'x', { deadline: 9000, ...clock() }))
      .rejects.toThrow(/sem SSH/);
  });
});
