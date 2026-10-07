/**
 * Autoscaling simulation bench (scripts/autoscale-sim/): the real controller on a virtual clock, a simulated cloud
 * (9 min boots, LLM-like slow-down past 8 parallel requests, health check timing out at 12) and closed-loop clients.
 * Each scenario asserts replica counts over time, that no busy-but-healthy replica is killed, that scaling does not
 * flap, that the overflow is answered by the fallback (no 5xx), that scale-in drains, and zero replicas after idle.
 * The timelines are printed (`console.info`) for the report; `bun scripts/autoscale-sim/run.ts` prints the same.
 */
import { describe, expect, it } from 'vitest';
import { formatTimeline, simulate, type SimResult } from '../../../scripts/autoscale-sim/engine';
import { SCENARIOS } from '../../../scripts/autoscale-sim/scenarios';

const results = new Map<string, Promise<SimResult>>();
function run(key: keyof typeof SCENARIOS): Promise<SimResult> {
  if (!results.has(key)) {
    results.set(key, simulate(SCENARIOS[key]).then((r) => {
      console.info(formatTimeline(`${key}: ${SCENARIOS[key].name}`, r.rows));
      return r;
    }));
  }
  return results.get(key)!;
}

/** Seconds since the scenario start of a scale event. */
const startOf = (key: keyof typeof SCENARIOS) => SCENARIOS[key].start ?? Date.parse('2026-10-07T08:00:00Z');
const sec = (key: keyof typeof SCENARIOS, t: number) => Math.round((t - startOf(key)) / 1000);
const row = (r: SimResult, t: string, deployment = 'speech') => r.rows.find(x => x.t === t && x.deployment === deployment)!;
const creates = (r: SimResult, d = 'speech') => r.events.filter(e => e.type === 'create' && e.deployment === d);
const releases = (r: SimResult, d = 'speech') => r.events.filter(e => e.type === 'release' && e.deployment === d);

function common(r: SimResult): void {
  for (const s of Object.values(r.served)) expect(s.failed).toBe(0); // the fallback answered every overflow: no 5xx
  expect(r.killedBusy).toEqual([]); // no replica released with requests in flight (drain-timeout aside)
  expect(r.events.filter(e => e.reason === 'unhealthy' || e.reason === 'boot-timeout')).toEqual([]);
}

describe('autoscale simulation', () => {
  it('ramp 4 → 8 → 16 → 25: scales out early (75 % sustained 20 s), never flaps, back to zero', async () => {
    const r = await run('ramp');
    common(r);
    expect(creates(r)).toHaveLength(2);
    // Load 8 starts at 150 s; 8 > 75 % × 8 for 20 s → second replica asked at ~170 s, before the first is even ready.
    expect(sec('ramp', creates(r)[1].t)).toBeLessThanOrEqual(200);
    expect(row(r, '12:00').ready).toBe(2);
    expect(row(r, '12:00').blockedBy).toBe('maxReplicas 2');
    expect(releases(r).every(e => sec('ramp', e.t) >= 26 * 60)).toBe(true); // nothing released while loaded
    expect(row(r, '30:00').ready + row(r, '30:00').booting).toBe(0);
  });

  it('spike 0 → 25 cold: both replicas at once, overflow to the fallback, sustained 25 holds, decay keeps 2 until load fits 1', async () => {
    const r = await run('spike');
    common(r);
    expect(creates(r)).toHaveLength(2);
    expect(sec('spike', creates(r)[1].t) - 60).toBeLessThanOrEqual(5);
    expect(row(r, '05:00').fallback).toBeGreaterThan(0); // cold: the fallback serves
    for (const t of ['11:00', '15:00', '20:00']) expect(row(r, t).ready).toBe(2); // sustained 25 for 20 min
    expect(row(r, '23:00').ready).toBe(2); // load 6 > 50 % of one replica: hysteresis keeps 2
    expect(releases(r).every(e => sec('spike', e.t) >= 24 * 60)).toBe(true);
    expect(row(r, '28:00').ready).toBe(0);
  });

  it('flapping load around the threshold: one scale-out, no scale-in while it hovers', async () => {
    const r = await run('flapping');
    common(r);
    expect(r.events.length).toBeLessThanOrEqual(2);
    expect(releases(r)).toEqual([]);
  });

  it('scale-in drains: the surplus replica stops taking requests and is released empty', async () => {
    const r = await run('drain');
    common(r);
    expect(r.rows.some(x => x.draining > 0)).toBe(true);
    const first = releases(r)[0];
    expect(first.reason).toBe('scale-down');
    expect(first.inflight).toBe(0);
    expect(sec('drain', first.t)).toBeGreaterThanOrEqual(15 * 60 + 60); // after scaleDownDelaySeconds of low load
    expect(row(r, '20:00').ready).toBe(1);
  });

  it('a replica crash mid-load: replaced after the liveness grace, the busy survivor is never touched', async () => {
    const r = await run('crash');
    expect(r.served.speech.failed).toBe(0);
    expect(r.killedBusy).toEqual([]);
    const dead = releases(r).filter(e => e.reason === 'unhealthy');
    expect(dead).toHaveLength(1);
    expect(sec('crash', dead[0].t) - 20 * 60).toBeLessThanOrEqual(60);
    expect(creates(r)).toHaveLength(3);
    expect(row(r, '31:00').ready).toBe(2);
  });

  it('cap / € contention: the idle deployment yields its replica to the one under pressure', async () => {
    const r = await run('contention');
    common(r);
    const reclaimed = releases(r, 'tts').filter(e => e.reason === 'reclaimed');
    expect(reclaimed).toHaveLength(1);
    expect(sec('contention', reclaimed[0].t)).toBeGreaterThanOrEqual(12 * 60);
    expect(row(r, '22:00').ready).toBe(2);
    expect(creates(r, 'tts')).toHaveLength(1); // no ping-pong: the donor does not come back without a request
  });

  it('warm-up schedule: replicas boot at 08:10, the class at 08:20 never touches the fallback', async () => {
    const r = await run('schedule');
    common(r);
    expect(row(r, '10:00', 'speech').booting).toBe(2);
    expect(r.fallbackByMinute.speech.slice(20, 44).reduce((a, b) => a + (b ?? 0), 0)).toBe(0);
    expect(row(r, '50:00').ready).toBe(0); // the window ended and the class left: back to zero
  });

  it('POST /warm before a class: no fallback once the class starts, normal rules after the window', async () => {
    const r = await run('warmEndpoint');
    common(r);
    expect(r.fallbackByMinute.speech.slice(12, 30).reduce((a, b) => a + (b ?? 0), 0)).toBe(0);
    expect(row(r, '40:00').ready).toBe(0);
  });
  // D1 (live QA 2026-10-07): the 2nd replica was asked but every create failed `out of stock` for 17 min; with the
  // hysteresis on the live count, `desired` stayed 2 at load 3–4 and the back-off kept retrying the create.
  it('out of stock under rising then falling load: the pending create is cancelled once the pressure is gone', async () => {
    const r = await run('stockOutRiseFall');
    common(r);
    const failed = r.events.filter(e => e.type === 'create-failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const t of ['11:00', '14:00', '17:00']) {
      expect(row(r, t).desired).toBe(2);
      expect(row(r, t).blockedBy).toMatch(/^out of stock since \d\d:\d\d:\d\dZ: \d+ creates? failed, next try/);
    }
    expect(row(r, '19:00').desired).toBe(1); // load 4 fits one replica at 50 %: the 2nd is no longer wanted
    expect(row(r, '19:00').reason).toMatch(/pending create of 1 cancelled/);
    expect(row(r, '19:00').blockedBy).toBe('');
    expect(failed.every(e => sec('stockOutRiseFall', e.t) < 18 * 60 + 60)).toBe(true); // no retry without pressure
    expect(creates(r)).toHaveLength(1); // stock back at 24:00 with load 4: no L40S created for nothing
    for (const t of ['20:00', '25:00', '30:00']) expect(row(r, t).ready).toBe(1); // the serving replica is kept
    // While asked and waiting, the reason says so instead of a window count that re-arms every 20 s.
    expect(r.rows.filter(x => x.t >= '12:00' && x.t <= '17:00').some(x => /asked, waiting for 1/.test(x.reason))).toBe(true);
  });

  it('out of stock, then stock comes back: the 2nd replica is created at the next try and serves', async () => {
    const r = await run('stockOutRecovers');
    common(r);
    expect(r.events.filter(e => e.type === 'create-failed').length).toBeGreaterThan(0);
    expect(creates(r)).toHaveLength(2);
    const second = sec('stockOutRecovers', creates(r)[1].t);
    expect(second).toBeGreaterThanOrEqual(16 * 60);
    expect(second).toBeLessThanOrEqual(16 * 60 + 300); // the back-off ladder caps the wait at its current step
    expect(row(r, '30:00').ready).toBe(2);
    expect(row(r, '30:00').blockedBy).toBe('maxReplicas 2');
  });

  // D4 (live QA 2026-10-07): at 16 / 25 concurrent on one L40S the fixed 1.5 s hedge ran ~60 % of the requests twice.
  it.each([['hedge16', 'hedge16Fixed'], ['hedge25', 'hedge25Fixed']] as const)(
    'adaptive hedge (%s): far fewer double runs than the fixed hedge, no worse p95, no 5xx',
    async (adaptiveKey, fixedKey) => {
      const [a, f] = await Promise.all([run(adaptiveKey), run(fixedKey)]);
      common(a);
      common(f);
      expect(f.doubleRuns.speech).toBeGreaterThan(1000); // the defect, reproduced
      expect(a.doubleRuns.speech).toBeLessThanOrEqual(f.doubleRuns.speech / 20);
      expect(a.latency.speech.p95).toBeLessThanOrEqual(f.latency.speech.p95);
      // Calls to the fallback (spilled + hedged; with this model every hedged GPU call still won) do not grow either.
      const fallbackCalls = (r: SimResult) => r.served.speech.fallback + r.doubleRuns.speech;
      expect(fallbackCalls(a)).toBeLessThan(fallbackCalls(f));
    },
  );
});
