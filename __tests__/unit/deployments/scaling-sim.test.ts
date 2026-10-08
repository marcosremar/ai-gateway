import { describe, expect, it } from 'vitest';
import { simulateClass, summaryRow, table, type ClassResult, type SimMode } from '../../../scripts/scaling-sim/engine';
import { CLASS_SCENARIOS } from '../../../scripts/scaling-sim/scenarios';

const results = new Map<string, Promise<ClassResult>>();
const run = (key: string, mode: SimMode = 'today') => {
  const id = `${mode}/${key}`;
  if (!results.has(id)) results.set(id, simulateClass(CLASS_SCENARIOS[key], { mode }));
  return results.get(id)!;
};
const summary = async (mode: SimMode) => {
  const rows = [];
  for (const key of Object.keys(CLASS_SCENARIOS)) rows.push(summaryRow(key, await run(key, mode)));
  return `${table(rows)}\n`;
};
const creates = (r: ClassResult) => r.events.filter(e => e.type === 'create');

describe('scaling simulator: today\'s rule', () => {
  it('summary table of every scenario', async () => {
    await expect(await summary('today')).toMatchFileSnapshot('./fixtures/scaling-sim/today.txt');
  });

  it('a 1 s blip of two requests starts a replica that serves nothing', async () => {
    const r = await run('blip-below-threshold');
    expect(creates(r).map(e => e.s)).toEqual([0, 1220]);
    expect(r.wastedStarts).toBe(1);
    expect(r.turns.fallback).toBe(0);
  });

  it('eight steady students on a ceiling of eight start a second replica without any blip', async () => {
    const r = await run('sporadic-blip');
    expect(creates(r).map(e => e.s)).toEqual([0, 720]);
    expect(r.firstExcessAt).toBe(1200);
    expect(r.wastedStarts).toBe(1);
  });

  it('a burst of 24 simultaneous turns scales out within one tick', async () => {
    const r = await run('burst');
    expect(creates(r).filter(e => e.s >= 670 && e.s <= 690)).toHaveLength(3);
    expect(r.peakReplicas).toBe(4);
  });

  it('cold class of 24: one more replica per boot, every seat taken only after half an hour', async () => {
    const r = await run('class-arrival');
    expect(creates(r).map(e => e.s)).toEqual([0, 627, 1257, 1880]);
    expect(r.excessEndsAt).toBe(1868);
    expect(r.wastedStarts).toBe(1);
    expect(r.fallbackStudentMinutes).toBeGreaterThan(24 * 37 / 2);
  });

  it('refused creates leave the class on the fallback, never without an answer', async () => {
    const quota = await run('quota-full');
    expect(creates(quota)).toHaveLength(1);
    expect(quota.events.filter(e => e.type === 'create-failed').every(e => e.reason === 'quotas_exceeded')).toBe(true);
    expect(quota.turns.refused).toBe(0);
    const stock = await run('out-of-stock-then-back');
    expect(creates(stock).filter(e => e.s >= 15 * 60).length).toBeGreaterThan(0);
    expect(stock.turns.refused).toBe(0);
  });

  it('the class ends: zero replicas after the idle window', async () => {
    const r = await run('drop-to-zero');
    expect(r.zeroAfterEnd).toBeGreaterThanOrEqual(120);
    expect(r.zeroAfterEnd).toBeLessThanOrEqual(300);
  });

  it('without a fallback the same turns are refused', async () => {
    const r = await simulateClass(CLASS_SCENARIOS['quota-full'], { fallback: false });
    expect(r.turns.fallback).toBe(0);
    expect(r.turns.refused).toBe((await run('quota-full')).turns.fallback);
  });
});

describe('scaling simulator: the scaling block', () => {
  it.each(['economy', 'balanced', 'fast'] as const)('summary table of every scenario, %s', async (mode) => {
    await expect(await summary(mode)).toMatchFileSnapshot(`./fixtures/scaling-sim/${mode}.txt`);
  });

  it.each(['sporadic-blip', 'sporadic-blip-repeated', 'blip-below-threshold'])('%s: economy and balanced start nothing, the blip goes to the fallback', async (key) => {
    for (const mode of ['economy', 'balanced'] as const) {
      const r = await run(key, mode);
      expect(creates(r).map(e => e.s)).toEqual([0]);
      expect(r.fallbackStudentMinutes).toBeLessThan(1);
      expect(r.turns.refused).toBe(0);
    }
    const fast = await run(key, 'fast');
    expect(creates(fast).map(e => e.s)).toEqual([0, 680]);
    expect(fast.turns.fallback).toBeLessThanOrEqual((await run(key, 'balanced')).turns.fallback);
  });

  it('class of 24: three replicas asked within two minutes in balanced, three after ~3 min in economy, a fourth as spare in fast', async () => {
    const balanced = await run('class-arrival', 'balanced');
    expect(creates(balanced).map(e => e.s)).toEqual([0, 75, 115]);
    expect(balanced.wastedStarts).toBe(0);
    expect(balanced.excessEndsAt).toBeLessThan(13 * 60);
    expect(creates(await run('class-arrival', 'economy')).map(e => e.s)).toEqual([0, 169, 169]);
    expect(creates(await run('class-arrival', 'fast'))).toHaveLength(4);
    expect(balanced.fallbackStudentMinutes).toBeLessThan((await run('class-arrival')).fallbackStudentMinutes * 0.6);
  });

  it('burst of 24 simultaneous turns: balanced and fast size to it within a tick, economy only after 15 min of bursts', async () => {
    for (const mode of ['balanced', 'fast'] as const) expect(creates(await run('burst', mode)).map(e => e.s)).toEqual([0, 670, 670]);
    const economy = await run('burst', 'economy');
    expect(creates(economy).map(e => e.s)).toEqual([0, 1580]);
    expect(economy.turns.refused).toBe(0);
  });

  it('slow growth: balanced starts on the trend before the ceiling is reached', async () => {
    const balanced = await run('slow-growth', 'balanced');
    expect(creates(balanced)[1].s).toBe(180);
    expect(balanced.fallbackStudentMinutes).toBeLessThan((await run('slow-growth', 'economy')).fallbackStudentMinutes / 4);
  });

  it('two classes five minutes apart: the replicas stay through the break and the second class never touches the fallback', async () => {
    const r = await run('two-classes-back-to-back', 'balanced');
    expect(creates(r)).toHaveLength(3);
    expect(r.fallbackStudentMinutes).toBe((await run('class-arrival', 'balanced')).fallbackStudentMinutes);
  });

  it.each(['economy', 'balanced', 'fast'] as const)('%s: no session is cut and no turn goes unanswered in any scenario', async (mode) => {
    for (const key of Object.keys(CLASS_SCENARIOS)) {
      const r = await run(key, mode);
      expect([key, r.sessionsCut, r.turns.refused]).toEqual([key, 0, 0]);
      expect(r.zeroAfterEnd).not.toBeNull();
    }
  });

  it('parked replicas resume for the second class in three minutes', async () => {
    const r = await simulateClass(CLASS_SCENARIOS['two-classes-back-to-back'], { mode: 'balanced', idleAction: 'stop' });
    expect(r.starts.filter(x => x.kind === 'resume').map(x => x.at)).toEqual([2565, 2565]);
    expect(r.events.filter(e => e.type === 'create')).toHaveLength(3);
  });

  it('monthly budget spent mid-class: seated students finish, the next class is answered by the fallback, nothing new starts', async () => {
    const r = await simulateClass(CLASS_SCENARIOS['two-classes-back-to-back'], { mode: 'balanced', budget: { eurPerMonth: 1.5 } });
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toMatch(/^1300s deployments: monthly budget spent, new load goes to the fallback/);
    expect(creates(r)).toHaveLength(3);
    expect(r.sessionsCut).toBe(0);
    expect(r.turns.refused).toBe(0);
    expect(r.events.filter(e => e.type === 'release').map(e => e.s)).toEqual([2220, 2220, 2220]);
    expect(r.fallbackStudentMinutes).toBeGreaterThan(24 * 37);
  });

  it('without the session signal the waiting students are invisible: only requests that reach the controller count', async () => {
    const r = await simulateClass(CLASS_SCENARIOS['class-arrival'], { mode: 'balanced', sessionSignal: false });
    expect(creates(r)).toHaveLength(1);
    expect(creates(await simulateClass(CLASS_SCENARIOS.burst, { mode: 'balanced', sessionSignal: false })).map(e => e.s)).toEqual([0, 670, 670]);
  });
});
