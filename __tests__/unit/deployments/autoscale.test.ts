/**
 * Pressure autoscaling rules (src/deployments/autoscale.ts), their spec fields, and the controller surface they add:
 * overflow spill (`saturated`), 429 as pressure, `POST …/warm`, and the `autoscale` explanation in the view.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  localClock, p95, pressureDecision, replicaCapacity, scheduleFloor, warmFloor, type PressureInput,
} from '../../../src/deployments/autoscale';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { DeploymentLLMProvider } from '../../../src/deployments/inference-providers';
import { buildSpec, SpecError } from '../../../src/deployments/spec';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import type { DeploymentSpec } from '../../../src/deployments/types';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { CooldownTracker } from '../../../src/gateway/providers/cloud/fallback';
import type { LLMProvider } from '../../../src/gateway/providers/cloud/types';
import { handleChatCompletions } from '../../../src/gateway/proxy/routes/chat-completions';
import { FakeCloud, until } from './_fake-cloud';

const spec = (over: Record<string, unknown> = {}): DeploymentSpec =>
  buildSpec('speech', { image: 'a/b:1', port: 8000, maxReplicas: 3, targetInflightPerReplica: 8, ...over }, { profiles: new Map() });

const NOW = Date.parse('2026-10-07T08:00:00Z');
const input = (over: Partial<PressureInput> = {}): PressureInput => ({
  spec: spec(), load: 0, live: 1, booting: 0, p95Ms: null, errorRate: 0, samples: 0, active: true, now: NOW,
  state: { highSince: null, desired: 1 }, ...over,
});

describe('pressureDecision', () => {
  it('scales out at 75 % of capacity only after the window, one step at a time', () => {
    const first = pressureDecision(input({ load: 7 }));
    expect(first.desired).toBe(1);
    expect(first.highSince).toBe(NOW);
    const later = pressureDecision(input({ load: 7, now: NOW + 20_000, state: first }));
    expect(later.desired).toBe(2);
    expect(later.reason).toMatch(/load 7 > 75% of 1×8/);
  });

  it('a load at 75 % or below is not pressure', () => {
    expect(pressureDecision(input({ load: 6, now: NOW + 60_000, state: { highSince: NOW, desired: 1 } })).desired).toBe(1);
  });

  it('booting replicas count as capacity: latency alone asks nothing more while one boots', () => {
    const slow = { p95Ms: 5_000, samples: 20, spec: spec({ autoscale: { latencyP95Ms: 2_000 } }) };
    expect(pressureDecision(input({ ...slow, load: 8, live: 2, booting: 1, now: NOW + 30_000, state: { highSince: NOW, desired: 2 } })).desired).toBe(2);
    expect(pressureDecision(input({ ...slow, load: 5, live: 1, now: NOW + 30_000, state: { highSince: NOW, desired: 1 } })).desired).toBe(2);
    // …but load beyond ready + booting capacity still does.
    expect(pressureDecision(input({ load: 20, live: 2, booting: 1, now: NOW + 30_000, state: { highSince: NOW, desired: 2 } })).desired).toBe(3);
  });

  it('timeouts / 429s above the error rate are pressure (with enough samples)', () => {
    const errs = { load: 5, errorRate: 0.3, now: NOW + 30_000, state: { highSince: NOW, desired: 1 } };
    expect(pressureDecision(input({ ...errs, samples: 20 })).desired).toBe(2);
    expect(pressureDecision(input({ ...errs, samples: 2 })).desired).toBe(1);
  });

  it('hysteresis: scales in only when the load fits one replica fewer at 50 %', () => {
    const two = { live: 2, state: { highSince: null, desired: 2 } };
    expect(pressureDecision(input({ ...two, load: 6 })).desired).toBe(2);
    expect(pressureDecision(input({ ...two, load: 4 })).desired).toBe(1);
  });

  it('at maxReplicas it says so and asks nothing more; idle asks nothing', () => {
    const d = pressureDecision(input({ load: 40, live: 3, state: { highSince: NOW, desired: 3 } }));
    expect(d).toMatchObject({ desired: 3, capped: true });
    expect(pressureDecision(input({ active: false, load: 40 })).desired).toBe(0);
  });

  it('p95 and the replica capacity', () => {
    expect(p95([])).toBeNull();
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(replicaCapacity(spec())).toBe(12);
    expect(replicaCapacity(spec({ autoscale: { maxInflightFactor: 1 } }))).toBe(8);
  });
});

describe('warm floors', () => {
  const sched = [{ days: [3], start: '09:50', end: '11:00', timeZone: 'Europe/Paris', minReplicas: 2 }]; // Wednesday
  it('schedule windows in a time zone, days, overnight windows', () => {
    expect(localClock(NOW, 'Europe/Paris')).toEqual({ day: 3, minutes: 600 }); // 08:00Z = 10:00 Paris, Wednesday
    expect(scheduleFloor(sched, NOW)).toBe(2);
    expect(scheduleFloor(sched, NOW + 24 * 3_600_000)).toBe(0); // Thursday
    expect(scheduleFloor([{ start: '22:00', end: '02:00', minReplicas: 1 }], Date.parse('2026-10-07T01:00:00Z'))).toBe(1);
    expect(scheduleFloor([{ days: [2], start: '22:00', end: '02:00', minReplicas: 1 }], Date.parse('2026-10-07T01:00:00Z'))).toBe(1); // started Tuesday
  });
  it('the client window and the schedule: whichever asks more, never above maxReplicas, gone when expired', () => {
    const s = spec({ warmSchedule: sched });
    expect(warmFloor(s, { replicas: 3, until: NOW + 1 }, NOW)).toBe(3);
    expect(warmFloor(s, { replicas: 9, until: NOW + 1 }, NOW)).toBe(3);
    expect(warmFloor(s, { replicas: 3, until: NOW }, NOW)).toBe(2);
  });
  it('spec validation', () => {
    expect(() => spec({ warmSchedule: [{ start: '9:00', end: '10:00', minReplicas: 1 }] })).toThrow(SpecError);
    expect(() => spec({ warmSchedule: [{ start: '09:00', end: '10:00', minReplicas: 1, timeZone: 'Mars/Base' }] })).toThrow(/time ?zone/i);
    expect(() => spec({ autoscale: { scaleOutAt: 0.5, scaleInAt: 0.6 } })).toThrow(/hysteresis/);
    expect(() => spec({ autoscale: { nope: 1 } })).toThrow(/unknown field/);
    expect(spec({ autoscale: { latencyP95Ms: 2500 } }).autoscale).toEqual({ latencyP95Ms: 2500 });
  });
});

// ── Controller surface ──────────────────────────────────────────────────────

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

async function setup() {
  const cloud = new FakeCloud();
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20, maxTotalReplicas: 6,
  });
  controllers.push(controller);
  clouds.push(cloud);
  await controller.init();
  controller.start();
  return { controller, cloud };
}

describe('controller: overflow, warm, explanation', () => {
  it('every replica at capacity: the overflow spills to the fallback at once (`saturated`, neutral), the replica keeps its work', async () => {
    const x = await setup();
    await x.controller.put('speech', { profile: 'cpu-echo', maxReplicas: 1, targetInflightPerReplica: 2, autoscale: { maxInflightFactor: 1 } });
    x.controller.wake('speech');
    await until(() => x.controller.get('speech')!.status === 'ready');
    const held = [await x.controller.acquire('speech'), await x.controller.acquire('speech')];
    const fallback: LLMProvider = { providerId: 'openrouter', isConfigured: () => true, chat: async () => ({ content: 'reserva', model: 'm' }) } as never;
    const t0 = Date.now();
    const res = await handleChatCompletions(
      { method: 'POST', url: '/v1/chat/completions', headers: {}, rawBody: Buffer.alloc(0), body: { model: 'parle-llm', messages: [{ role: 'user', content: 'oi' }] } },
      {}, undefined, undefined, undefined, undefined, undefined,
      { chatRoutes: { 'parle-llm': [{ providerId: 'deployment:speech', provider: new DeploymentLLMProvider(x.controller, 'speech'), model: 'q' },
        { providerId: 'openrouter', provider: fallback, model: 'm' }] }, circuitBreakers: new CircuitBreakerRegistry(), cooldownTracker: new CooldownTracker() },
    );
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Gateway-Fallback']).toBe('saturated');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(x.controller.get('speech')!.inflight).toBe(2);
    for (const l of held) l.done(false);
  });

  it('a waiting invoke takes the slot a finished request frees (bounded queue in the gateway, not on the GPU)', async () => {
    const x = await setup();
    await x.controller.put('speech', { profile: 'cpu-echo', maxReplicas: 1, targetInflightPerReplica: 1, autoscale: { maxInflightFactor: 1 } });
    x.controller.wake('speech');
    await until(() => x.controller.get('speech')!.status === 'ready');
    const first = await x.controller.acquire('speech');
    const second = x.controller.acquire('speech', { waitMs: 2_000 });
    setTimeout(() => first.done(false), 50);
    const lease = await second;
    expect(lease.machine.id).toBe(first.machine.id);
    lease.done(false);
  });

  it('POST-like warm: keeps N replicas for the window, validates, park ends it; the view explains the count', async () => {
    const x = await setup();
    await x.controller.put('speech', { profile: 'cpu-echo', maxReplicas: 2 });
    await expect(x.controller.warm('speech', 5, 10)).rejects.toThrow(/0–2/);
    await expect(x.controller.warm('speech', 1, 0)).rejects.toThrow(/untilMinutes/);
    const v = await x.controller.warm('speech', 2, 10);
    expect(v.warm?.replicas).toBe(2);
    await until(() => x.cloud.created.length === 2);
    await until(() => x.controller.get('speech')!.autoscale.reason === 'warm floor 2');
    expect(x.controller.get('speech')!.autoscale).toMatchObject({ desired: 2, floor: 2, blockedBy: null });
    const parked = await x.controller.park('speech');
    expect(parked.warm).toBeNull();
    await until(() => x.cloud.machines.size === 0, 3000);
  });

  it('a 429 from the replica is pressure and a busy mark, never a strike', async () => {
    const x = await setup();
    await x.controller.put('speech', { profile: 'cpu-echo', maxReplicas: 1 });
    x.controller.wake('speech');
    await until(() => x.controller.get('speech')!.status === 'ready');
    const llm = new DeploymentLLMProvider(x.controller, 'speech', {
      fetchImpl: (async () => new Response('{"error":"queue full"}', { status: 429 })) as never,
    });
    for (let i = 0; i < 6; i++) await llm.chat({ model: 'm', messages: [{ role: 'user', content: 'oi' }] }).catch(() => null);
    const v = x.controller.get('speech')!;
    expect(v.replicas[0].busy).toBe(true);
    expect(v.replicas[0].phase).toBe('ready');
    await until(() => x.controller.get('speech')!.autoscale.errorRate === 1);
  });
});
