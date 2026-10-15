import type { ClassScenario, Student } from './engine';

const TURN = { turnEvery: 15, jitter: 5, turnSeconds: 2 };

function group(n: number, from: number, over: number, until: number, extra: Partial<Student> = {}): Student[] {
  return Array.from({ length: n }, (_, i) => ({
    arrive: from + Math.floor((i * over) / n), leave: until, transport: 'realtime' as const, ...TURN, ...extra,
  }));
}

const during = (windows: Array<[number, number]>, n: number) => (s: number) => (windows.some(([from, len]) => s >= from && s < from + len) ? n : 0);

const WARM = 660;

const classOf24 = () => group(24, 0, 120, 37 * 60);

export const CLASS_SCENARIOS: Record<string, ClassScenario> = {
  'class-arrival': {
    name: '24 students join over 2 min, 35-minute block, leave together',
    durationMin: 60,
    students: classOf24(),
  },
  'sporadic-blip': {
    name: 'warm replica, 8 steady students, 2 extra requests for 3 s once (minute 20)',
    durationMin: 55,
    wakeAtStart: true,
    students: group(8, WARM, 30, 40 * 60),
    requests: during([[1200, 3]], 2),
    requestSeconds: 1,
  },
  'sporadic-blip-repeated': {
    name: 'warm replica, 8 steady students, 2 extra requests for 1–5 s every 4 min',
    durationMin: 55,
    wakeAtStart: true,
    students: group(8, WARM, 30, 40 * 60),
    requests: during([[900, 1], [1140, 3], [1380, 5], [1620, 1], [1860, 3], [2100, 5]], 2),
    requestSeconds: 1,
  },
  'blip-below-threshold': {
    name: 'warm replica, 5 steady students (below the 75 % line), 2 extra requests for 1 s once (minute 20)',
    durationMin: 55,
    wakeAtStart: true,
    students: group(5, WARM, 30, 40 * 60),
    requests: during([[1200, 1]], 2),
    requestSeconds: 1,
  },
  burst: {
    name: 'warm replica, 24 students on HTTP turns, everyone speaks at the same instant every 20 s for 25 min',
    durationMin: 55,
    wakeAtStart: true,
    students: group(24, WARM, 0, WARM + 25 * 60, { transport: 'http', turnEvery: 20, jitter: 0, firstTurnAfter: 10 }),
  },
  'slow-growth': {
    name: 'one more student every 90 s up to 20, all leave at minute 45',
    durationMin: 65,
    students: group(20, 0, 20 * 90, 45 * 60),
  },
  'drop-to-zero': {
    name: '16 students for 20 min, then the class ends',
    durationMin: 50,
    students: group(16, 0, 30, 20 * 60),
  },
  'quota-full': {
    name: 'class of 24, every create after the first refused by the account quota',
    durationMin: 60,
    students: classOf24(),
    quotaFull: [[0.1, 60]],
  },
  'out-of-stock-then-back': {
    name: 'class of 24, out of stock from second 6 to minute 15',
    durationMin: 60,
    students: classOf24(),
    outOfStock: [[0.1, 15]],
  },
  'two-classes-back-to-back': {
    name: 'class of 24 (0–37 min), 5 min break, second class of 24 (42–79 min)',
    durationMin: 100,
    students: [...classOf24(), ...group(24, 42 * 60, 120, 79 * 60)],
  },
  'hundred-students': {
    name: '100 students join over 5 min, 35-minute block (gateway guards: 6 replicas, €6/h)',
    durationMin: 65,
    students: group(100, 0, 300, 40 * 60),
    params: { maxReplicas: 6 },
  },
};
