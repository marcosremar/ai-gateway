/**
 * Vast marketplace primitives (search, one accept with every outcome classified, paged inventory, SSH key, destroy,
 * readiness wait). The refusal shapes are the ones the parle test hub observed on the live API.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createVastMarketplace, transientVastError, vastRetryAfterMs, waitForVastInstance, type VastMarketError, type VastMarketInstance,
} from '../../src/gateway/providers/gpu/vast/marketplace';

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function market(responses: Array<Response | (() => Response)>) {
  const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init.headers).get('authorization') });
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return typeof next === 'function' ? next() : next;
  });
  return { calls, m: createVastMarketplace({ apiKey: 'k', fetch }) };
}

const caught = async (work: Promise<unknown>) => (await work.then(() => null, (e: unknown) => e)) as VastMarketError;

describe('vast marketplace', () => {
  it('searches with the caller body and bearer auth', async () => {
    const { calls, m } = market([reply({ offers: [{ id: 1, dph_total: 0.1, gpu_name: 'RTX 3070' }] })]);
    expect(await m.searchOffers({ dph_total: { lte: 0.2 } })).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://console.vast.ai/api/v0/bundles/', method: 'POST', body: { dph_total: { lte: 0.2 } }, auth: 'Bearer k' });
  });

  it('accept: contract, or gone only when the refusal names this ask', async () => {
    const { m } = market([
      reply({ success: true, new_contract: 89 }),
      reply({ success: false, error: 'no_such_ask', ask_id: 7 }, 410),
      reply({ success: false, error: 'invalid_args', msg: 'error 404/3603: no_such_ask  Instance type by id 7 is not available.' }, 400),
      reply({ success: false, error: 'invalid_args', msg: 'error 404/3603: no_such_ask  Instance type by id 8 is not available.' }, 400),
    ]);
    expect(await m.acceptOffer(7, {})).toEqual({ kind: 'created', contractId: 89 });
    expect(await m.acceptOffer(7, {})).toEqual({ kind: 'gone' });
    expect(await m.acceptOffer(7, {})).toEqual({ kind: 'gone' });
    expect(await caught(m.acceptOffer(7, {}))).toMatchObject({ reason: 'UNKNOWN_CREATE_OUTCOME' });
  });

  it('accept: insufficient credit is terminal with nothing created; the endpoint 429 carries its wait', async () => {
    const { m } = market([
      reply({ success: false, error: 'insufficient_credit' }, 400),
      reply({ detail: 'API requests too frequent endpoint threshold=2.0' }, 429, { 'retry-after': '7' }),
    ]);
    expect(await caught(m.acceptOffer(1, {}))).toMatchObject({ noInstanceCreated: true, terminal: true, status: 402, code: 'INSUFFICIENT_CREDIT' });
    expect(await caught(m.acceptOffer(1, {}))).toMatchObject({ noInstanceCreated: true, reason: 'RATE_LIMIT', retryAfterMs: 7000, code: 'CAPACITY_WAIT' });
  });

  it('Retry-After is clamped to [2 s, 60 s] and defaults to 2 s', () => {
    expect(vastRetryAfterMs(null)).toBe(2000);
    expect(vastRetryAfterMs('0')).toBe(2000);
    expect(vastRetryAfterMs('600')).toBe(60_000);
    expect(vastRetryAfterMs('nonsense')).toBe(2000);
  });

  it('lists every page and refuses a repeated token or a malformed row', async () => {
    const { calls, m } = market([
      reply({ instances: [{ id: 1 }], next_token: 'a' }),
      reply({ instances: [{ id: 2 }], next_token: '' }),
    ]);
    expect((await m.listInstances()).map((x) => x.id)).toEqual([1, 2]);
    expect(calls[1]!.url).toContain('after_token=a');
    const loop = market([reply({ instances: [], next_token: 'a' }), reply({ instances: [], next_token: 'a' })]);
    await expect(loop.m.listInstances()).rejects.toThrow(/pagination/);
    const bad = market([reply({ instances: [{ id: 'x' }] })]);
    await expect(bad.m.listInstances()).rejects.toThrow(/invalid Vast inventory/);
  });

  it('destroy treats 404 as gone and an unconfirmed delete as an error; SSH attach needs success', async () => {
    const { m } = market([reply({}, 404), reply({ success: false }), reply({ success: true }), reply({ success: false })]);
    await expect(m.destroyInstance('1')).resolves.toBeUndefined();
    await expect(m.destroyInstance('1')).rejects.toThrow(/not confirmed/);
    await expect(m.attachSshKey('1', 'ssh-ed25519 AAA')).resolves.toBeUndefined();
    await expect(m.attachSshKey('1', 'ssh-ed25519 AAA')).rejects.toThrow(/attachment failed/);
  });

  it('transport and broken JSON are transient, 4xx other than 408/429 are not', async () => {
    const down = createVastMarketplace({ apiKey: 'k', fetch: async () => { throw new Error('ECONNRESET'); } });
    expect(transientVastError(await caught(down.listInstances()))).toBe(true);
    const html = createVastMarketplace({ apiKey: 'k', fetch: async () => new Response('<html>') });
    expect(transientVastError(await caught(html.listInstances()))).toBe(true);
    expect(transientVastError(Object.assign(new Error('x'), { reason: 'HTTP_ERROR', status: 503 }))).toBe(true);
    expect(transientVastError(Object.assign(new Error('x'), { reason: 'HTTP_ERROR', status: 403 }))).toBe(false);
  });
});

describe('waitForVastInstance', () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

  it('backs off on transient inventory failures and returns once the check passes', async () => {
    const c = clock();
    const fleet: Array<VastMarketInstance[] | Error> = [
      Object.assign(new Error('429'), { reason: 'HTTP_ERROR', status: 429 }),
      [{ id: 5, actual_status: 'loading', dph_total: 0.1 }],
      [{ id: 5, actual_status: 'running', dph_total: 0.1 }],
    ];
    const out = await waitForVastInstance(async () => { const next = fleet.shift()!; if (next instanceof Error) throw next; return next; }, '5',
      async (i) => (i.actual_status === 'running' ? 'ok' : null), { deadline: 60_000, maxPerHr: 0.2, ...c });
    expect(out).toBe('ok');
  });

  it('throws when the instance disappears or is repriced over the ceiling', async () => {
    await expect(waitForVastInstance(async () => [], '5', async () => 'x', { deadline: 10_000, ...clock() })).rejects.toThrow(/missing/);
    await expect(waitForVastInstance(async () => [{ id: 5, dph_total: 0.9 }], '5', async () => 'x', { deadline: 10_000, maxPerHr: 0.2, ...clock() }))
      .rejects.toThrow(/price outside policy/);
  });

  it('a check that throws means not yet, and the deadline ends the wait', async () => {
    await expect(waitForVastInstance(async () => [{ id: 5, dph_total: 0.1 }], '5', async () => { throw new Error('chrome not up'); },
      { deadline: 10_000, ...clock() })).rejects.toThrow(/timed out/);
  });
});
