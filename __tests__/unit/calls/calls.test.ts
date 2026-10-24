import { describe, expect, it } from 'vitest';
import { CallsService, type Caller, type CallsBackend, type LivekitServer, type RoomLoad } from '../../../src/calls/service';
import { classOpenFor, isRunning, railwayPower, redeployTarget, type RailwayDeployment } from '../../../src/calls';

const OWN: LivekitServer = { url: 'wss://own.example', apiKey: 'k', apiSecret: 's' };
const CLOUD: LivekitServer = { url: 'wss://cloud.example', apiKey: 'ck', apiSecret: 'cs' };
const APP: Caller = { user: 'parle', admin: false, countsAsUse: true };
const DEV: Caller = { user: 'parle-dev', admin: false, countsAsUse: false };
const ADMIN: Caller = { user: 'root', admin: true, countsAsUse: true };
const MIN = 60_000;
const TOKEN = { app: 'parle', room: 'r1', identity: 'alice' };

function setup(o: { cloud?: boolean; classOpen?: boolean; budget?: number } = {}) {
  let t = Date.UTC(2026, 9, 21, 10);
  const load: { own: RoomLoad | null; cloud: RoomLoad } = { own: { rooms: 0, participants: 0, egress: 0 }, cloud: { rooms: 0, participants: 0, egress: 0 } };
  const calls = { start: 0, stop: 0 };
  const backend: CallsBackend = {
    probe: async (server) => {
      if (server === CLOUD) return load.cloud;
      if (!load.own) throw new Error('down');
      return load.own;
    },
    sign: async (server, grant) => `${server.apiKey}:${grant.room}:${grant.identity}`,
  };
  const power = {
    start: async () => { calls.start++; return ['livekit', 'livekit-egress']; },
    stop: async () => { calls.stop++; load.own = null; return ['livekit-egress', 'livekit']; },
  };
  const logs: string[] = [];
  const service = new CallsService({
    app: 'parle', own: OWN, cloud: o.cloud ? CLOUD : null, backend, power, classOpen: () => o.classOpen ?? false,
    idleMinutes: 15, cloudBudgetMinutes: o.budget ?? 420, now: () => t, log: (m) => logs.push(m),
  });
  return { service, load, calls, logs, advance: (ms: number) => { t += ms; } };
}

describe('calls token', () => {
  it('own ready → a token of the own server', async () => {
    const { service } = setup({ cloud: true });
    const out = await service.token(APP, TOKEN);
    expect(out).toMatchObject({ server: 'own', url: OWN.url, token: 'k:r1:alice', room: 'r1' });
  });

  it('own down → wakes it and answers with the Cloud reserve', async () => {
    const { service, load, calls, logs } = setup({ cloud: true });
    load.own = null;
    const out = await service.token(APP, TOKEN);
    expect(out).toMatchObject({ server: 'cloud', url: CLOUD.url, token: 'ck:r1:alice' });
    expect(calls.start).toBe(1);
    expect(logs).toEqual(['calls.wake', 'calls.cloud']);
  });

  it('own down with no Cloud or reserve denied → 503 call_starting with retryAfterMs', async () => {
    for (const [cloud, body] of [[false, TOKEN], [true, { ...TOKEN, reserve: 'deny' }]] as const) {
      const { service, load } = setup({ cloud });
      load.own = null;
      await expect(service.token(APP, body)).rejects.toMatchObject({ status: 503, type: 'call_starting', extra: { retryAfterMs: 5000 } });
    }
  });

  it('the Cloud counts participant-minutes and stops at the monthly ceiling', async () => {
    const { service, load, advance } = setup({ cloud: true, budget: 1 });
    load.own = null;
    expect((await service.token(APP, TOKEN)).server).toBe('cloud');
    load.cloud = { rooms: 1, participants: 2, egress: 0 };
    await service.tick();
    advance(MIN);
    await service.tick();
    expect(service.cloudMinutesLeft()).toBe(0);
    await expect(service.token(APP, TOKEN)).rejects.toMatchObject({ status: 503 });
  });

  it('the dev key gets the own server when ready, never wakes it and never gets the Cloud', async () => {
    const { service, load, calls, advance } = setup({ cloud: true });
    expect((await service.token(DEV, TOKEN)).server).toBe('own');
    load.own = null;
    advance(6_000);
    await expect(service.token(DEV, TOKEN)).rejects.toMatchObject({ status: 503 });
    expect(calls.start).toBe(0);
  });

  it('validates the request and the app', async () => {
    const { service } = setup();
    await expect(service.token(APP, { ...TOKEN, room: 'a b' })).rejects.toMatchObject({ status: 400 });
    await expect(service.token(APP, { ...TOKEN, ttlSeconds: 14_401 })).rejects.toMatchObject({ status: 400 });
    await expect(service.token(APP, { ...TOKEN, app: 'babelcast' })).rejects.toMatchObject({ status: 404 });
    await expect(service.token({ user: 'babelcast', admin: false, countsAsUse: true }, TOKEN)).rejects.toMatchObject({ status: 403 });
  });
});

describe('calls idle and class window', () => {
  it('parks after 15 min without anyone, not before; a participant renews the clock', async () => {
    const { service, load, calls, advance } = setup();
    advance(14 * MIN);
    await service.tick();
    expect(calls.stop).toBe(0);
    load.own = { rooms: 1, participants: 2, egress: 0 };
    await service.tick();
    load.own = { rooms: 0, participants: 0, egress: 0 };
    advance(14 * MIN);
    await service.tick();
    expect(calls.stop).toBe(0);
    advance(1 * MIN);
    await service.tick();
    expect(calls.stop).toBe(1);
    expect((await service.health()).own.phase).toBe('parked');
  });

  it('an active egress keeps it up too', async () => {
    const { service, load, calls, advance } = setup();
    load.own = { rooms: 1, participants: 0, egress: 1 };
    advance(30 * MIN);
    await service.tick();
    expect(calls.stop).toBe(0);
  });

  it('inside the class window it never parks and a parked server is woken', async () => {
    const { service, load, calls, advance } = setup({ classOpen: true });
    advance(60 * MIN);
    await service.tick();
    expect(calls.stop).toBe(0);
    load.own = null;
    await service.tick();
    expect(calls.start).toBe(1);
    expect((await service.health()).own.phase).toBe('waking');
  });

  it('parle has no declared window any more: it is never open (GPUs on demand only, owner 24/10/2026)', () => {
    const open = classOpenFor('parle');
    expect(open(Date.parse('2026-10-21T15:00:00Z'))).toBe(false);
    expect(open(Date.parse('2026-10-21T10:00:00Z'))).toBe(false);
    expect(open(Date.parse('2026-10-24T15:00:00Z'))).toBe(false);
  });
});

describe('calls wake and park', () => {
  it('the dev key does not wake; the app key does, once while it boots', async () => {
    const { service, load, calls } = setup();
    load.own = null;
    expect(await service.wake(DEV)).toEqual({ phase: 'down' });
    expect(calls.start).toBe(0);
    expect(await service.wake(APP)).toEqual({ phase: 'waking' });
    expect(await service.wake(APP)).toEqual({ phase: 'waking' });
    expect(calls.start).toBe(1);
    load.own = { rooms: 0, participants: 0, egress: 0 };
    expect((await service.health()).own.phase).toBe('ready');
  });

  it('park refuses with a participant in a room, a dev key and the class window for an app key', async () => {
    const { service, load, calls } = setup();
    load.own = { rooms: 1, participants: 1, egress: 0 };
    await expect(service.park(ADMIN)).rejects.toMatchObject({ status: 409, type: 'in_use' });
    await expect(service.park(DEV)).rejects.toMatchObject({ status: 403 });
    load.own = { rooms: 0, participants: 0, egress: 0 };
    expect(await service.park(APP)).toMatchObject({ phase: 'parked' });
    expect(calls.stop).toBe(1);
    const inClass = setup({ classOpen: true });
    await expect(inClass.service.park(APP)).rejects.toMatchObject({ status: 409, type: 'class_window' });
    expect(await inClass.service.park(ADMIN)).toMatchObject({ phase: 'parked' });
  });
});

describe('railway power', () => {
  const dep = (id: string, status: string, stopped = false, digest = true): RailwayDeployment =>
    ({ id, status, deploymentStopped: stopped, meta: digest ? { imageDigest: 'sha256:x' } : {} });

  function fakeRailway(lists: Record<string, RailwayDeployment[]>) {
    const mutations: string[] = [];
    const graphql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
      if (query.includes('project(id')) {
        return { project: { environments: { edges: [{ node: { id: 'env', name: 'production' } }] }, services: { edges: Object.keys(lists).map(n => ({ node: { id: n, name: n } })) } } } as T;
      }
      if (query.includes('deployments(input')) {
        const input = variables.input as { serviceId: string };
        return { deployments: { edges: lists[input.serviceId]!.map(node => ({ node })) } } as T;
      }
      mutations.push(`${query.match(/(deployment\w+)/)![1]} ${String(variables.id)}`);
      return {} as T;
    };
    return { mutations, power: railwayPower({ graphql, token: 't', projectId: 'p', environment: 'production', services: ['livekit', 'livekit-egress'] }) };
  }

  it('stops the running deployments, egress first', async () => {
    const { mutations, power } = fakeRailway({ livekit: [dep('l2', 'SUCCESS'), dep('l1', 'REMOVED', true)], 'livekit-egress': [dep('e1', 'SUCCESS')] });
    expect(await power.stop()).toEqual(['livekit-egress', 'livekit']);
    expect(mutations).toEqual(['deploymentStop e1', 'deploymentStop l2']);
  });

  it('redeploys the last built image of a stopped service only', async () => {
    const { mutations, power } = fakeRailway({
      livekit: [dep('l3', 'FAILED', true, false), dep('l2', 'REMOVED', true)], 'livekit-egress': [dep('e1', 'SUCCESS')],
    });
    expect(await power.start()).toEqual(['livekit']);
    expect(mutations).toEqual(['deploymentRedeploy l2']);
  });

  it('running and redeploy target rules', () => {
    expect(isRunning(dep('a', 'SUCCESS'))).toBe(true);
    expect(isRunning(dep('a', 'SUCCESS', true))).toBe(false);
    expect(isRunning(dep('a', 'CRASHED'))).toBe(false);
    expect(redeployTarget([dep('a', 'FAILED', true, false)])?.id).toBe('a');
    expect(redeployTarget([])).toBeNull();
  });
});
