/**
 * The autoscaling scenarios of the simulation bench (`engine.ts`), shared by `run.ts` (prints the timelines) and
 * `__tests__/unit/deployments/autoscale-sim.test.ts` (asserts them).
 */

import { SPEECH_SPEC, type Scenario } from './engine';

const steps = (pairs: Array<[number, number]>) => (s: number) => {
  let c = 0;
  for (const [fromMin, value] of pairs) if (s >= fromMin * 60) c = value;
  return c;
};

export const SCENARIOS: Record<string, Scenario> = {
  ramp: {
    name: 'ramp 4 → 8 → 16 → 25 concurrent over 10 min, then held',
    durationMin: 30,
    loads: [{ name: 'speech', spec: SPEECH_SPEC, concurrency: steps([[0, 4], [2.5, 8], [5, 16], [7.5, 25], [26, 0]]) }],
  },
  spike: {
    name: 'sudden spike 0 → 25 (cold), held 20 min, decay to 0',
    durationMin: 32,
    loads: [{ name: 'speech', spec: SPEECH_SPEC, concurrency: steps([[1, 25], [21, 6], [24, 0]]) }],
  },
  flapping: {
    name: 'load flapping around the scale-out threshold (5 ↔ 7 every 40 s), one replica warm',
    durationMin: 30,
    loads: [{ name: 'speech', spec: SPEECH_SPEC, concurrency: (s) => (s < 60 ? 2 : Math.floor(s / 40) % 2 ? 7 : 5) }],
  },
  drain: {
    name: 'scale-in while requests are in flight: 16 → 3 concurrent (scaleDownDelaySeconds 60), then 0',
    durationMin: 30,
    loads: [{ name: 'speech', spec: { ...SPEECH_SPEC, scaleDownDelaySeconds: 60 }, concurrency: steps([[0, 16], [15, 3], [26, 0]]) }],
    rowEverySeconds: 30,
  },
  crash: {
    name: 'a replica crashes mid-load (16 concurrent, 2 replicas)',
    durationMin: 35,
    loads: [{ name: 'speech', spec: SPEECH_SPEC, concurrency: steps([[0, 16], [32, 0]]) }],
    at: { [20 * 60]: (sim) => { sim.crash('speech'); } },
  },
  contention: {
    name: 'cap / € ceiling contention: an idle TTS holds capacity, speech comes under pressure',
    durationMin: 30,
    controller: { maxTotalReplicas: 2, maxEurPerHour: 3.2 },
    loads: [
      { name: 'tts', spec: { ...SPEECH_SPEC, idleMinutes: 30 }, concurrency: steps([[0, 2], [2, 0]]) },
      { name: 'speech', spec: SPEECH_SPEC, concurrency: steps([[0, 4], [12, 16], [28, 0]]) },
    ],
  },
  schedule: {
    name: 'warm-up schedule 08:10–08:45 UTC (2 replicas) before a class of 16 at 08:20',
    durationMin: 50,
    loads: [{
      name: 'speech',
      spec: { ...SPEECH_SPEC, warmSchedule: [{ start: '08:10', end: '08:45', timeZone: 'UTC', minReplicas: 2 }] },
      concurrency: steps([[20, 16], [44, 0]]),
    }],
  },
  warmEndpoint: {
    name: 'POST /warm {replicas: 2, untilMinutes: 30} at 08:00, class of 16 at 08:12',
    durationMin: 40,
    loads: [{ name: 'speech', spec: SPEECH_SPEC, concurrency: steps([[12, 16], [30, 0]]) }],
    at: { 0: async (sim) => { await sim.controller.warm('speech', 2, 30); } },
  },
};
