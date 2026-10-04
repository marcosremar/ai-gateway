import { describe, expect, it } from 'vitest';
import { desiredReplicas, planReplicas, type ObservedReplica } from '../../../src/deployments/planner';
import { buildSpec } from '../../../src/deployments/spec';
import type { DeploymentSpec } from '../../../src/deployments/types';

const MIN = 60_000;
const NOW = 10_000_000;

function spec(over: Partial<DeploymentSpec> = {}): DeploymentSpec {
  return { ...buildSpec('tts', { image: 'a/b:1', port: 8000 }, { profiles: new Map() }), ...over };
}

function replica(id: string, over: Partial<ObservedReplica> & { state?: string; age?: number } = {}): ObservedReplica {
  const { state = 'running', age = 5 * MIN, ...rest } = over;
  return {
    machine: { id, deployment: 'tts', ip: '1.2.3.4', state, createdAt: NOW - age, zone: 'fr-par-2', machineType: 'L4-1-24G', pricePerHour: 0.8 },
    everReady: true, readyNow: true, failures: 0, inflight: 0, ...rest,
  };
}

const base = { inflight: 0, waiting: 0, lastRequestAt: null, aboveSince: null, now: NOW };

describe('desiredReplicas', () => {
  it('scales to zero when idle with minReplicas 0', () => {
    expect(desiredReplicas({ ...base, spec: spec({ minReplicas: 0 }) })).toBe(0);
  });

  it('keeps one replica while a request happened within idleMinutes', () => {
    const s = spec({ minReplicas: 0, idleMinutes: 15 });
    expect(desiredReplicas({ ...base, spec: s, lastRequestAt: NOW - 14 * MIN })).toBe(1);
    expect(desiredReplicas({ ...base, spec: s, lastRequestAt: NOW - 16 * MIN })).toBe(0);
  });

  it('a waiting request wakes a scaled-to-zero deployment', () => {
    expect(desiredReplicas({ ...base, spec: spec(), waiting: 1 })).toBe(1);
  });

  it('adds replicas by load and respects maxReplicas', () => {
    const s = spec({ maxReplicas: 3, targetInflightPerReplica: 4 });
    expect(desiredReplicas({ ...base, spec: s, inflight: 5 })).toBe(2);
    expect(desiredReplicas({ ...base, spec: s, inflight: 50 })).toBe(3);
  });

  it('keeps minActiveReplicas while in use (redundancy), back to minReplicas when idle', () => {
    const s = spec({ minReplicas: 0, maxReplicas: 3, minActiveReplicas: 2, idleMinutes: 15 });
    expect(desiredReplicas({ ...base, spec: s, lastRequestAt: NOW - MIN })).toBe(2);
    expect(desiredReplicas({ ...base, spec: s, lastRequestAt: NOW - 20 * MIN })).toBe(0);
  });

  it('never goes below minReplicas, and paused means zero', () => {
    expect(desiredReplicas({ ...base, spec: spec({ minReplicas: 2, maxReplicas: 3 }) })).toBe(2);
    expect(desiredReplicas({ ...base, spec: spec({ minReplicas: 2, maxReplicas: 3, paused: true }) })).toBe(0);
  });
});

describe('planReplicas', () => {
  it('creates the missing replicas', () => {
    const plan = planReplicas({ ...base, spec: spec({ minReplicas: 2, maxReplicas: 2 }), replicas: [replica('a')] });
    expect(plan.create).toBe(1);
    expect(plan.release).toEqual([]);
  });

  it('replaces halted, boot-timeout, unhealthy and too-old replicas', () => {
    const s = spec({ minReplicas: 4, maxReplicas: 4, bootTimeoutMinutes: 30, maxHours: 12 });
    const plan = planReplicas({
      ...base, spec: s, replicas: [
        replica('halted', { state: 'stopped in place' }),
        replica('stuck', { everReady: false, readyNow: false, age: 31 * MIN }),
        replica('sick', { readyNow: false, failures: 3 }),
        replica('old', { age: 12 * 60 * MIN }),
        replica('booting', { everReady: false, readyNow: false, age: 10 * MIN }),
        replica('blip', { readyNow: false, failures: 1 }),
      ],
    });
    expect(plan.release.map(r => [r.id, r.reason])).toEqual([
      ['halted', 'halted'], ['stuck', 'boot-timeout'], ['sick', 'unhealthy'], ['old', 'max-hours'],
    ]);
    expect(plan.create).toBe(2); // 2 live (booting, blip) of 4 desired
  });

  it('waits scaleDownDelaySeconds before removing surplus while active, then removes the idle one', () => {
    const s = spec({ minReplicas: 0, maxReplicas: 3, targetInflightPerReplica: 4, scaleDownDelaySeconds: 300 });
    const replicas = [replica('a', { inflight: 1 }), replica('b'), replica('c')];
    const first = planReplicas({ ...base, spec: s, replicas, inflight: 1, lastRequestAt: NOW });
    expect(first.release).toEqual([]);
    expect(first.aboveSince).toBe(NOW);
    const later = planReplicas({ ...base, spec: s, replicas, inflight: 1, lastRequestAt: NOW, aboveSince: NOW - 301_000 });
    expect(later.release.map(r => r.id).sort()).toEqual(['b', 'c']);
    expect(later.release.every(r => r.reason === 'scale-down')).toBe(true);
  });

  it('removes booting replicas before ready ones and never one with requests in flight', () => {
    const s = spec({ minReplicas: 1, maxReplicas: 3, scaleDownDelaySeconds: 0 });
    const plan = planReplicas({
      ...base, spec: s, lastRequestAt: NOW, inflight: 1,
      replicas: [replica('busy', { inflight: 1 }), replica('ready'), replica('boot', { everReady: false, readyNow: false })],
    });
    expect(plan.release.map(r => r.id)).toEqual(['boot', 'ready']);
  });

  it('going idle scales down to minReplicas at once', () => {
    const s = spec({ minReplicas: 0, idleMinutes: 15, scaleDownDelaySeconds: 3600 });
    const plan = planReplicas({ ...base, spec: s, lastRequestAt: NOW - 20 * MIN, replicas: [replica('a'), replica('b')] });
    expect(plan.desired).toBe(0);
    expect(plan.release.map(r => r.id).sort()).toEqual(['a', 'b']);
  });

  it('paused releases everything', () => {
    const plan = planReplicas({ ...base, spec: spec({ minReplicas: 1, paused: true }), replicas: [replica('a', { inflight: 2 })] });
    expect(plan.release).toEqual([{ id: 'a', reason: 'paused' }]);
  });
});
