import { DeploymentController, type ControllerOptions, type Lease } from '../../src/deployments/controller';
import { MemoryDeploymentStore } from '../../src/deployments/store';
import { L40S_MODEL, SimClock, SimCloud, SimProbe, type ScaleEvent } from '../autoscale-sim/engine';

export interface Student {
  arrive: number;
  leave: number;
  transport: 'realtime' | 'http';
  turnEvery: number;
  jitter: number;
  turnSeconds: number;
  firstTurnAfter?: number;
}

export interface SimParams {
  bootSeconds: number;
  resumeSeconds: number;
  ceiling: number;
  price: number;
  maxReplicas: number;
  idleMinutes: number;
  idleAction: 'delete' | 'stop';
  wastedBelow: number;
  fallback: boolean;
  seed: number;
}

export const DEFAULT_PARAMS: SimParams = {
  bootSeconds: 600, resumeSeconds: 180, ceiling: 8, price: 1.47, maxReplicas: 4, idleMinutes: 2, idleAction: 'delete',
  wastedBelow: 20, fallback: true, seed: 1,
};

export interface ClassScenario {
  name: string;
  durationMin: number;
  students: Student[];
  requests?: (s: number) => number;
  requestSeconds?: number;
  wakeAtStart?: boolean;
  outOfStock?: Array<[number, number]>;
  quotaFull?: Array<[number, number]>;
  params?: Partial<SimParams>;
  spec?: Record<string, unknown>;
  controller?: Partial<ControllerOptions>;
}

export interface TimelineRow {
  t: string; students: number; slotted: number; onFallback: number; requests: number;
  ready: number; booting: number; draining: number; parked: number; desired: number; reason: string; blockedBy: string;
}

export interface ReplicaStart { id: string; at: number; kind: 'create' | 'resume'; turns: number }

export interface ClassResult {
  scenario: string;
  params: SimParams;
  rows: TimelineRow[];
  events: Array<ScaleEvent & { s: number }>;
  replicas: string;
  peakReplicas: number;
  replicaMinutes: number;
  eur: number;
  turns: { gpu: number; fallback: number; refused: number };
  fallbackStudentMinutes: number;
  starts: ReplicaStart[];
  wastedStarts: number;
  firstExcessAt: number | null;
  triggerAt: number | null;
  excessEndsAt: number | null;
  timeToCapacity: number | null;
  zeroAfterEnd: number | null;
  sessionsCut: number;
}

export const SIM_START = Date.parse('2026-10-07T08:00:00Z');
const NAME = 'speech';
const TICK_SECONDS = 20;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Seat { student: Student; rand: () => number; present: boolean; gone: boolean; slot: Lease | null; nextTurn: number }
interface Short { end: number; lease: Lease | null; anonymous: boolean }

export function specOf(p: SimParams, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    image: 'ghcr.io/parle/speech-stack:1', port: 8000, machineType: 'L40S-1-48G', zone: 'fr-par-2', gpu: true,
    minReplicas: 0, maxReplicas: p.maxReplicas, targetInflightPerReplica: p.ceiling, autoscale: { maxInflightFactor: 1 },
    idleMinutes: p.idleMinutes, idleAction: p.idleAction, bootTimeoutMinutes: 30, maxEurPerHour: Math.max(2, p.price),
    coldStartWaitSeconds: 0, ...extra,
  };
}

export async function simulateClass(scenario: ClassScenario, overrides: Partial<SimParams> = {}): Promise<ClassResult> {
  const p: SimParams = { ...DEFAULT_PARAMS, ...scenario.params, ...overrides };
  const clock = new SimClock(SIM_START);
  const model = { ...L40S_MODEL, bootMs: p.bootSeconds * 1000, resumeMs: p.resumeSeconds * 1000, price: p.price };
  const cloud = new SimCloud(clock, model, () => 0);
  const window = ([a, b]: [number, number]): [number, number] => [SIM_START + a * 60_000, SIM_START + b * 60_000];
  cloud.stockOut = (scenario.outOfStock ?? []).map(window);
  cloud.quotaFull = (scenario.quotaFull ?? []).map(window);
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe: new SimProbe(cloud, clock, model, () => 0), namespace: 'sim',
    now: clock.now, ...scenario.controller,
  });
  await controller.init();
  await controller.put(NAME, specOf(p, scenario.spec));
  if (scenario.wakeAtStart) controller.wake(NAME);

  const seats: Seat[] = scenario.students.map((student, i) => ({
    student, rand: mulberry32(p.seed * 7919 + i), present: false, gone: false, slot: null, nextTurn: 0,
  }));
  const shorts: Short[] = [];
  const starts: ReplicaStart[] = [];
  const turns = { gpu: 0, fallback: 0, refused: 0 };
  const rows: TimelineRow[] = [];
  const perMinute: number[] = [];
  const requestSeconds = scenario.requestSeconds ?? 2;
  const loadEnds = Math.max(0, ...scenario.students.map(s => s.leave));
  let seenEvents = 0;
  let replicaSeconds = 0;
  let fallbackStudentSeconds = 0;
  let sessionsCut = 0;
  let firstExcessAt: number | null = null;
  let lastExcessAt: number | null = null;
  let zeroAt: number | null = null;
  let peakReplicas = 0;

  const settle = async () => {
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 50; i++) await Promise.resolve();
      await (controller as unknown as { reconciling: Promise<void> | null }).reconciling;
    }
  };
  const acquire = async (): Promise<Lease | null> => {
    try { return await controller.acquire(NAME, { waitMs: 0 }); } catch { return null; }
  };
  const admit = async (): Promise<Lease | null> => {
    const free = controller.get(NAME)!.replicas.some(r => r.phase === 'ready' && !r.draining && r.inflight < p.ceiling);
    if (free) return acquire();
    controller.wake(NAME);
    return null;
  };
  const served = (id: string) => {
    turns.gpu++;
    const start = starts.findLast(x => x.id === id);
    if (start) start.turns++;
  };
  const spilled = (studentSeconds: number) => {
    if (p.fallback) turns.fallback++; else turns.refused++;
    fallbackStudentSeconds += studentSeconds;
  };
  const billing = () => [...cloud.machines.values()].filter(m => m.machine.state !== 'stopped').length;

  for (let s = 0; s <= scenario.durationMin * 60; s++) {
    if (s > 0) clock.t += 1000;
    let excess = false;
    for (let i = shorts.length - 1; i >= 0; i--) {
      if (shorts[i].end > clock.t) continue;
      shorts[i].lease?.done();
      shorts.splice(i, 1);
    }
    for (const seat of seats) {
      if (seat.present && s >= seat.student.leave) {
        seat.slot?.done();
        seat.slot = null;
        seat.present = false;
        seat.gone = true;
      }
      if (seat.slot && cloud.machines.get(seat.slot.machine.id)?.machine.state !== 'running') {
        seat.slot.done('cancelled');
        seat.slot = null;
        sessionsCut++;
      }
      if (!seat.present && !seat.gone && s >= seat.student.arrive) {
        seat.present = true;
        seat.nextTurn = s + (seat.student.firstTurnAfter ?? Math.floor(seat.rand() * seat.student.turnEvery));
        if (seat.student.transport === 'realtime') seat.slot = await admit();
      }
      if (!seat.present || seat.nextTurn > s) continue;
      const { student } = seat;
      if (student.transport === 'realtime') {
        seat.slot ??= await admit();
        if (seat.slot) served(seat.slot.machine.id);
        else { spilled(0); excess = true; }
      } else {
        const lease = await acquire();
        if (lease) { served(lease.machine.id); shorts.push({ end: clock.t + student.turnSeconds * 1000, lease, anonymous: false }); }
        else { spilled(student.turnEvery); excess = true; }
      }
      seat.nextTurn += Math.max(1, Math.round(student.turnEvery + (seat.rand() * 2 - 1) * student.jitter));
    }
    const wanted = scenario.requests?.(s) ?? 0;
    for (let open = shorts.filter(x => x.anonymous).length; open < wanted; open++) {
      const lease = await acquire();
      if (lease) served(lease.machine.id);
      else { spilled(requestSeconds); excess = true; }
      shorts.push({ end: clock.t + requestSeconds * 1000, lease, anonymous: true });
    }
    await settle();
    if (s % TICK_SECONDS === 0) { await controller.reconcile(); await settle(); }
    for (; seenEvents < cloud.events.length; seenEvents++) {
      const e = cloud.events[seenEvents];
      if (e.type === 'create' || e.type === 'start') starts.push({ id: e.id, at: s, kind: e.type === 'create' ? 'create' : 'resume', turns: 0 });
    }

    const present = seats.filter(x => x.present);
    const slotless = present.filter(x => x.student.transport === 'realtime' && !x.slot).length;
    fallbackStudentSeconds += slotless;
    if (slotless > 0) excess = true;
    if (excess) { firstExcessAt ??= s; lastExcessAt = s; }
    const running = billing();
    replicaSeconds += running;
    peakReplicas = Math.max(peakReplicas, running);
    if (s >= loadEnds && wanted === 0 && running === 0) zeroAt ??= s;
    if (running > 0) zeroAt = null;
    if (s % 60 === 0) {
      perMinute.push(running);
      const v = controller.get(NAME)!;
      rows.push({
        t: `${String(Math.floor(s / 60)).padStart(2, '0')}:00`, students: present.length,
        slotted: present.filter(x => x.slot).length, onFallback: slotless, requests: wanted,
        ready: v.replicas.filter(r => r.phase === 'ready' && !r.draining).length,
        booting: v.replicas.filter(r => r.phase === 'booting').length,
        draining: v.replicas.filter(r => r.draining).length,
        parked: v.replicas.filter(r => r.providerState === 'stopped').length,
        desired: v.autoscale.desired, reason: v.autoscale.reason, blockedBy: v.autoscale.blockedBy ?? '',
      });
    }
  }

  const events = cloud.events.map(e => ({ ...e, s: Math.round((e.t - SIM_START) / 1000) }));
  const excessEndsAt = lastExcessAt == null || lastExcessAt >= loadEnds - 1 ? null : lastExcessAt + 1;
  const triggerAt = firstExcessAt == null ? null : starts.find(x => x.at >= firstExcessAt!)?.at ?? null;
  return {
    scenario: scenario.name, params: p, rows, events,
    replicas: perMinute.map((n, m) => (m === 0 || n !== perMinute[m - 1] ? `${m}m:${n}` : '')).filter(Boolean).join(' '),
    peakReplicas,
    replicaMinutes: Math.round(replicaSeconds / 6) / 10,
    eur: Math.round(replicaSeconds * p.price / 36) / 100,
    turns,
    fallbackStudentMinutes: Math.round(fallbackStudentSeconds / 6) / 10,
    starts,
    wastedStarts: starts.filter(x => x.turns < p.wastedBelow).length,
    firstExcessAt, triggerAt, excessEndsAt,
    timeToCapacity: triggerAt != null && excessEndsAt != null && excessEndsAt > triggerAt ? excessEndsAt - triggerAt : null,
    zeroAfterEnd: zeroAt == null ? null : zeroAt - loadEnds,
    sessionsCut,
  };
}

export function table(rows: Array<Record<string, string | number | null>>): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v: string | number | null) => (v == null ? '-' : String(v));
  const width = cols.map(c => Math.max(c.length, ...rows.map(r => cell(r[c]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(width[i])).join(' | ').trimEnd();
  return [line(cols), width.map(w => '-'.repeat(w)).join('-|-'), ...rows.map(r => line(cols.map(c => cell(r[c]))))].join('\n');
}

export function summaryRow(key: string, r: ClassResult): Record<string, string | number | null> {
  return {
    scenario: key,
    'starts@s': r.starts.map(x => (x.kind === 'resume' ? `${x.at}r` : x.at)).join(',') || '-',
    wasted: r.wastedStarts,
    replicas: r.replicas,
    'repl-min': r.replicaMinutes,
    eur: r.eur.toFixed(2),
    'gpu turns': r.turns.gpu,
    'fb turns': r.turns.fallback,
    'fb stud-min': r.fallbackStudentMinutes,
    'excess@s': r.firstExcessAt,
    'trigger@s': r.triggerAt,
    'to capacity s': r.timeToCapacity,
    'zero after end s': r.zeroAfterEnd,
    cut: r.sessionsCut,
    refused: r.turns.refused,
  };
}
