import { describe, expect, it } from 'vitest';
import { DECLARED_DEPLOYMENTS } from '../../src/deployments/declared';
import { classWindowEndsAt, deployBlockers } from '../../scripts/deploy-prod';

const ready = { duringClass: false, dirty: '', head: 'a1b2c3', originMain: 'a1b2c3' };

describe('deploy:prod has no class window (GPUs are on demand only, owner 24/10/2026)', () => {
  it('no declared deployment keeps a warm schedule', () => {
    expect(DECLARED_DEPLOYMENTS.filter(d => (d.spec.warmSchedule ?? []).length > 0).map(d => d.name)).toEqual([]);
  });

  it.each([
    ['Mon 16:40 CEST', '2026-10-12T14:40:00Z'],
    ['Mon 20:29 CEST', '2026-10-12T18:29:00Z'],
    ['Thu 19:00 CEST', '2026-10-15T17:00:00Z'],
    ['Mon 16:40 CET, week before the spring change', '2026-03-23T15:40:00Z'],
    ['Mon 16:40 CEST, day after the spring change', '2026-03-30T14:40:00Z'],
    ['Mon 16:40 CET, day after the autumn change', '2026-10-26T15:40:00Z'],
    ['Mon 20:29 CET, day after the autumn change', '2026-10-26T19:29:00Z'],
    ['Fri 18:00 CEST', '2026-10-16T16:00:00Z'],
    ['Sun 18:00 CEST', '2026-10-18T16:00:00Z'],
  ])('%s → never blocked', (_label, iso) => {
    expect(classWindowEndsAt(Date.parse(iso))).toBeNull();
    expect(deployBlockers({ ...ready, now: Date.parse(iso) })).toEqual([]);
  });

  it('--during-class changes nothing about the other checks', () => {
    const now = Date.parse('2026-10-12T16:00:00Z');
    expect(deployBlockers({ ...ready, now, duringClass: true })).toEqual([]);
    expect(deployBlockers({ ...ready, now, duringClass: true, dirty: ' M serve.ts', originMain: 'ffffff' })).toHaveLength(2);
  });

  it('still refuses a dirty tree or a HEAD that is not origin/main, at any hour', () => {
    for (const iso of ['2026-10-12T16:00:00Z', '2026-10-16T16:00:00Z']) {
      const now = Date.parse(iso);
      expect(deployBlockers({ ...ready, now, dirty: '?? notes.md' })[0]).toContain('not clean');
      expect(deployBlockers({ ...ready, now, originMain: 'ffffff' })[0]).toContain('is not origin/main');
    }
  });
});
