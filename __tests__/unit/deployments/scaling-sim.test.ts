import { describe, expect, it } from 'vitest';
import { simulateClass, summaryRow, table, type ClassResult } from '../../../scripts/scaling-sim/engine';
import { CLASS_SCENARIOS } from '../../../scripts/scaling-sim/scenarios';

const results = new Map<string, Promise<ClassResult>>();
const run = (key: string) => {
  if (!results.has(key)) results.set(key, simulateClass(CLASS_SCENARIOS[key]));
  return results.get(key)!;
};
const creates = (r: ClassResult) => r.events.filter(e => e.type === 'create');

describe('scaling simulator: today\'s rule', () => {
  it('summary table of every scenario', async () => {
    const rows = [];
    for (const key of Object.keys(CLASS_SCENARIOS)) rows.push(summaryRow(key, await run(key)));
    await expect(`${table(rows)}\n`).toMatchFileSnapshot('./fixtures/scaling-sim/today.txt');
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
