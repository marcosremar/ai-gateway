import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { ownedFromGateway, reapExitCode, reapOrphans, reapSummary } from '../../../src/deployments/reaper';
import { ScalewayDeploymentBackend } from '../../../src/deployments/scaleway-backend';
import { VastDeploymentBackend } from '../../../src/deployments/vast-backend';
import type { ReplicaMachine } from '../../../src/deployments/types';

const NOW = 10_000_000_000;
const HOUR = 3_600_000;
const machine = (id: string, deployment: string, ageHours: number, extra: Partial<ReplicaMachine> = {}): ReplicaMachine => ({
  id, deployment, ip: null, state: 'running', createdAt: NOW - ageHours * HOUR, zone: 'fr-par-2', machineType: 'L4-1-24G', pricePerHour: 0.75, ...extra,
});
type Foreign = ReplicaMachine & { namespace: string };

function backend(own: ReplicaMachine[], foreign: Foreign[]) {
  const released: string[] = [];
  return {
    provider: 'scaleway', released,
    listReplicas: async () => own,
    listForeign: async () => foreign,
    releaseReplica: async (m: ReplicaMachine) => { released.push(m.id); },
  };
}

const up = { namespace: 'prod', now: () => NOW, sleep: async () => {}, gatewayUp: async () => true };
const owned = async () => ({ names: new Set(['tts']), machineTypes: new Set(['L4-1-24G', 'L40S-1-48G']) });
const STOPPED_L4: Foreign = { ...machine('dev-l4', 'bench', 28, { state: 'stopped' }), namespace: 'dev' };

describe('reaper with the gateway up and no cross-check', () => {
  it('lists the machines, releases nothing, and does not look like a clean run', async () => {
    const scw = backend([machine('ghost', 'gone', 300), machine('a', 'tts', 300)], []);
    const r = await reapOrphans({ ...up, backends: [scw] });
    expect(r).toMatchObject({ gatewayUp: true, mode: 'none', seen: 2, planned: [], released: [], skipped: 'no admin key: cross-check off' });
    expect(scw.released).toEqual([]);
    expect(reapExitCode(r)).toBe(3);
    expect(reapSummary(r)).toMatch(/NOT CHECKED \(no admin key: cross-check off\) — 2 machine\(s\) listed, none compared/);
  });

  it('a checked run exits 0, a failed one 1, and a dry run says so', async () => {
    const clean = await reapOrphans({ ...up, backends: [backend([machine('a', 'tts', 300)], [])], owned });
    expect([reapExitCode(clean), reapSummary(clean)]).toEqual([0, 'reaper:']);
    const dry = await reapOrphans({ ...up, backends: [backend([machine('ghost', 'gone', 300)], [])], owned, dryRun: true });
    expect(reapSummary(dry)).toMatch(/DRY RUN, nothing released .* would release 1/);
    expect(reapExitCode({ ...clean, failed: ['x'] })).toBe(1);
  });

  it('the Railway cron applies: its start command carries --apply', () => {
    const config = JSON.parse(readFileSync(join(__dirname, '../../../railway.reaper.json'), 'utf8')) as { deploy: { startCommand: string } };
    expect(config.deploy.startCommand.split(' ')).toContain('--apply');
  });
});

describe('reaper: leftovers of other namespaces', () => {
  it('reports them and alerts when one holds a machine type this namespace needs; never releases them by default', async () => {
    const log = vi.fn();
    const young: Foreign = { ...machine('dev-young', 'bench', 0.2), namespace: 'dev' };
    const cpu: Foreign = { ...machine('dev-cpu', 'echo', 50, { machineType: 'DEV1-S' }), namespace: 'marcos' };
    const scw = backend([machine('a', 'tts', 300)], [STOPPED_L4, young, cpu]);
    const r = await reapOrphans({ ...up, backends: [scw], owned, log });
    expect(r.foreign).toEqual([
      { id: 'dev-l4', provider: 'scaleway', namespace: 'dev', deployment: 'bench', machineType: 'L4-1-24G', zone: 'fr-par-2', state: 'stopped', ageHours: 28, holdsNeededQuota: true },
      { id: 'dev-cpu', provider: 'scaleway', namespace: 'marcos', deployment: 'echo', machineType: 'DEV1-S', zone: 'fr-par-2', state: 'running', ageHours: 50, holdsNeededQuota: false },
    ]);
    expect(scw.released).toEqual([]);
    expect(r.planned).toEqual([]);
    const alerts = log.mock.calls.filter(([msg]) => msg === 'ALERT reaper.foreign_quota_held');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]![1]).toMatchObject({ id: 'dev-l4', namespace: 'dev', protects: 'prod', machineType: 'L4-1-24G' });
  });

  it('without an admin key the needed types are unknown: every leftover is an alert, and the run is still not clean', async () => {
    const log = vi.fn();
    const r = await reapOrphans({ ...up, backends: [backend([], [STOPPED_L4])], log });
    expect(r.foreign[0]).toMatchObject({ id: 'dev-l4', holdsNeededQuota: null });
    expect(log.mock.calls.some(([msg]) => msg === 'ALERT reaper.foreign_quota_held')).toBe(true);
    expect(reapExitCode(r)).toBe(3);
  });

  it('--apply-foreign deletes only the stopped ones past the minimum age, which is never under an hour', async () => {
    const running: Foreign = { ...machine('dev-running', 'bench', 200), namespace: 'dev' };
    const fresh: Foreign = { ...machine('dev-fresh', 'bench', 2, { state: 'stopped in place' }), namespace: 'dev' };
    const scw = backend([], [STOPPED_L4, running, fresh]);
    const r = await reapOrphans({ ...up, backends: [scw], owned, applyForeign: true, dryRun: true });
    expect(scw.released).toEqual(['dev-l4']);
    expect(r.released).toEqual(['scaleway:foreign:dev/dev-l4']);
    expect(r.foreign).toHaveLength(3);

    const floor = backend([], [{ ...machine('dev-30min', 'bench', 0.6, { state: 'stopped' }), namespace: 'dev' }, fresh]);
    await reapOrphans({ ...up, backends: [floor], owned, applyForeign: true, foreignMinAgeMs: 60_000 });
    expect(floor.released).toEqual(['dev-fresh']);
  });

  it('a foreign list that fails is a failed run and spares the namespace\'s own reaping', async () => {
    const scw = { ...backend([machine('ghost', 'gone', 300)], []), listForeign: async () => { throw new Error('503'); } };
    const r = await reapOrphans({ ...up, backends: [scw], owned });
    expect(r.released).toEqual(['ghost']);
    expect(r.failed).toEqual(['list-foreign:scaleway']);
  });

  it('the gateway list tells which machine types the namespace needs (spec and placements)', async () => {
    const fetchImpl = (async () => Response.json({ namespace: 'prod', scope: 'all', deployments: [
      { name: 'tts', spec: { machineType: 'L4-1-24G' } },
      { name: 'speech', spec: { machineType: 'L40S-1-48G', placements: [{ zone: 'fr-par-1' }, { provider: 'vast', machineType: 'RTX 5090' }] } },
    ] })) as unknown as typeof fetch;
    const answer = await ownedFromGateway({ gatewayUrl: 'http://gw', adminKey: 'k', namespace: 'prod', fetchImpl });
    expect(answer).toEqual({ names: new Set(['tts', 'speech']), machineTypes: new Set(['L4-1-24G', 'L40S-1-48G', 'RTX 5090']) });
  });
});

describe('listForeign on the real backends', () => {
  it('Scaleway: every aigw-deploy server of another namespace, with its namespace', async () => {
    const inst = (id: string, ns: string, state: string) => ({
      instanceId: id, status: 'running',
      providerMeta: { tags: ['aigw-deploy', `aigw-ns-${ns}`, 'aigw-dep-bench'], state, zone: 'fr-par-2', commercialType: 'L4-1-24G', createdAt: new Date(NOW - 28 * HOUR).toISOString() },
    });
    const listInstancesByTag = vi.fn(async () => [inst('fr-par-2/own', 'prod', 'running'), inst('fr-par-2/dev', 'dev', 'stopped'), inst('fr-par-2/m', 'marcos-run', 'running')]);
    const scw = new ScalewayDeploymentBackend('k', { client: { listInstancesByTag, getHourlyPrice: async () => null } as never });
    const foreign = await scw.listForeign('prod');
    expect(listInstancesByTag.mock.calls[0]![0]).toBe('aigw-deploy');
    expect(foreign.map(m => [m.id, m.namespace, m.deployment, m.state, m.machineType])).toEqual([
      ['fr-par-2/dev', 'dev', 'bench', 'stopped', 'L4-1-24G'], ['fr-par-2/m', 'marcos-run', 'bench', 'running', 'L4-1-24G'],
    ]);
  });

  it('Vast: every aigw:<ns>:<deployment> instance of another namespace', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ instances: [
      { id: 11, label: 'aigw:prod:parle-speech', actual_status: 'running', start_date: (NOW - HOUR) / 1000, gpu_name: 'RTX 5090' },
      { id: 12, label: 'aigw:dev:old-speech', actual_status: 'exited', start_date: (NOW - 9 * HOUR) / 1000, gpu_name: 'RTX 5090' },
      { id: 13, label: 'someone-else', actual_status: 'running', start_date: NOW / 1000 },
      { id: 14, label: 'aigw:dev:new-speech:a1b2c3', actual_status: 'running', start_date: NOW / 1000 },
      { id: 15, label: 'aigw:prod:parle-tts:d4e5f6', actual_status: 'running', start_date: NOW / 1000 },
    ] }));
    const vast = new VastDeploymentBackend('k', { fetch: fetchImpl as never, now: () => NOW });
    expect((await vast.listForeign('prod')).map(m => [m.id, m.namespace, m.deployment, m.state])).toEqual([
      ['12', 'dev', 'old-speech', 'exited'], ['14', 'dev', 'new-speech', 'running'],
    ]);
    expect((await vast.listReplicas('prod')).map(m => [m.id, m.deployment, m.tokenKey])).toEqual([['11', 'parle-speech', undefined], ['15', 'parle-tts', 'd4e5f6']]);
  });

  it('Vast: a per-replica label aigw:<ns>:<deployment>:<tokenKey> keeps the deployment and the key apart', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ instances: [
      { id: 21, label: 'aigw:prod:parle-speech:k1', actual_status: 'running', start_date: NOW / 1000 },
      { id: 22, label: 'aigw:dev:old-speech:k2', actual_status: 'exited', start_date: NOW / 1000 },
    ] }));
    const vast = new VastDeploymentBackend('k', { fetch: fetchImpl as never, now: () => NOW });
    expect((await vast.listForeign('prod')).map(m => [m.id, m.namespace, m.deployment, m.tokenKey])).toEqual([['22', 'dev', 'old-speech', 'k2']]);
    expect((await vast.listReplicas('prod')).map(m => [m.id, m.deployment, m.tokenKey])).toEqual([['21', 'parle-speech', 'k1']]);
  });
});
