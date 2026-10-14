import { describe, expect, it } from 'vitest';
import { classWindowEndsAt, deployBlockers } from '../../scripts/deploy-prod';

const ready = { duringClass: false, dirty: '', head: 'a1b2c3', originMain: 'a1b2c3' };

describe('deploy:prod class window (Mon–Thu 16:40–20:30 Europe/Paris)', () => {
  it.each([
    ['Mon 16:39 CEST', '2026-10-12T14:39:00Z', false],
    ['Mon 16:40 CEST', '2026-10-12T14:40:00Z', true],
    ['Mon 20:29 CEST', '2026-10-12T18:29:00Z', true],
    ['Mon 20:30 CEST', '2026-10-12T18:30:00Z', false],
    ['Thu 19:00 CEST', '2026-10-15T17:00:00Z', true],
    ['Fri 18:00 CEST', '2026-10-16T16:00:00Z', false],
    ['Sun 18:00 CEST', '2026-10-18T16:00:00Z', false],
    ['Mon 16:39 CET, week before the spring change', '2026-03-23T15:39:00Z', false],
    ['Mon 16:40 CET, week before the spring change', '2026-03-23T15:40:00Z', true],
    ['Sun 18:00 on the spring change day', '2026-03-29T16:00:00Z', false],
    ['Mon 16:39 CEST, day after the spring change', '2026-03-30T14:39:00Z', false],
    ['Mon 16:40 CEST, day after the spring change', '2026-03-30T14:40:00Z', true],
    ['Mon 20:30 CEST, day after the spring change', '2026-03-30T18:30:00Z', false],
    ['Sun 18:00 on the autumn change day', '2026-10-25T17:00:00Z', false],
    ['Mon 15:40 CET, day after the autumn change (14:40 UTC was 16:40 the week before)', '2026-10-26T14:40:00Z', false],
    ['Mon 16:40 CET, day after the autumn change', '2026-10-26T15:40:00Z', true],
    ['Mon 20:29 CET, day after the autumn change', '2026-10-26T19:29:00Z', true],
    ['Mon 20:30 CET, day after the autumn change', '2026-10-26T19:30:00Z', false],
  ])('%s → blocked %s', (_label, iso, blocked) => {
    expect(classWindowEndsAt(Date.parse(iso)) !== null).toBe(blocked);
    expect(deployBlockers({ ...ready, now: Date.parse(iso) }).length > 0).toBe(blocked);
  });

  it('names the end of the window and the override', () => {
    const [message] = deployBlockers({ ...ready, now: Date.parse('2026-10-12T16:00:00Z') });
    expect(message).toContain('20:30 Paris');
    expect(message).toContain('--during-class');
  });

  it('--during-class lifts only the class check', () => {
    const now = Date.parse('2026-10-12T16:00:00Z');
    expect(deployBlockers({ ...ready, now, duringClass: true })).toEqual([]);
    expect(deployBlockers({ ...ready, now, duringClass: true, dirty: ' M serve.ts', originMain: 'ffffff' })).toHaveLength(2);
  });

  it('refuses a dirty tree or a HEAD that is not origin/main outside class', () => {
    const now = Date.parse('2026-10-16T16:00:00Z');
    expect(deployBlockers({ ...ready, now, dirty: '?? notes.md' })[0]).toContain('not clean');
    expect(deployBlockers({ ...ready, now, originMain: 'ffffff' })[0]).toContain('is not origin/main');
  });
});
