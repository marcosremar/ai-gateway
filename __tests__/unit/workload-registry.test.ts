/**
 * Unit tests for src/compute/workloads/registry.ts
 *
 * Covers:
 *  - registerDriver / getDriver — happy path, missing driver error
 *  - onEvent — subscribe, unsubscribe (returned disposer), multiple listeners
 *  - emit error isolation — a throwing listener must not prevent subsequent ones
 *  - list / get / getByName / listByType — CRUD reads
 *  - import — seeds external workload directly
 *  - WorkloadRegistry.newId — returns a valid UUID string
 *  - deploy — happy path, emits "created", stores workload
 *  - deploy — duplicate name (non-error status) throws
 *  - deploy — redeployment allowed when existing status is "error"
 *  - deploy — concurrent deploy lock rejects second caller immediately
 *  - deploy — no driver throws
 *  - stop — updates registry, emits "status_changed" with previousStatus
 *  - stop — unknown id throws
 *  - start — updates registry, emits "status_changed"
 *  - start — unknown id throws
 *  - terminate — removes workload, emits "terminated" with status "idle"
 *  - terminate — unknown id throws
 *  - refreshStatus — same status → no event emitted
 *  - refreshStatus — different status → emits "status_changed"
 *  - refreshStatus — unknown id throws
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkloadRegistry } from '../../src/compute/workloads/registry';
import type {
  Workload,
  WorkloadDriver,
  WorkloadConfig,
  WorkloadEvent,
} from '../../src/compute/workloads/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeWorkload(overrides: Partial<Workload> = {}): Workload {
  return {
    id: WorkloadRegistry.newId(),
    type: 'gpu',
    name: 'test-gpu',
    status: 'running',
    provider: 'runpod',
    costPerHr: 0.5,
    metadata: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeDriver(
  type: 'gpu' | 'bot' | 'db' = 'gpu',
  overrides: Partial<Omit<WorkloadDriver, 'type'>> = {},
): WorkloadDriver {
  return {
    type,
    deploy: vi.fn(async (name: string, _config: WorkloadConfig) =>
      makeWorkload({ name, type }),
    ),
    stop: vi.fn(async (w: Workload) => ({ ...w, status: 'stopped' as const })),
    start: vi.fn(async (w: Workload) => ({ ...w, status: 'running' as const })),
    terminate: vi.fn(async (_w: Workload) => undefined),
    status: vi.fn(async (w: Workload) => w),
    ...overrides,
  };
}

// ── registerDriver / getDriver ────────────────────────────────────────────────

describe('registerDriver', () => {
  it('allows a registered driver type to be used in deploy', async () => {
    const reg = new WorkloadRegistry();
    const driver = makeDriver('gpu');
    reg.registerDriver(driver);
    const w = await reg.deploy('my-gpu', { type: 'gpu' });
    expect(w.type).toBe('gpu');
    expect(driver.deploy).toHaveBeenCalledOnce();
  });

  it('overwrites a previously registered driver for the same type', async () => {
    const reg = new WorkloadRegistry();
    const first = makeDriver('gpu');
    const second = makeDriver('gpu');
    reg.registerDriver(first);
    reg.registerDriver(second);
    await reg.deploy('w', { type: 'gpu' });
    expect(second.deploy).toHaveBeenCalledOnce();
    expect(first.deploy).not.toHaveBeenCalled();
  });

  it('throws when no driver is registered for the requested type', async () => {
    const reg = new WorkloadRegistry();
    await expect(reg.deploy('w', { type: 'gpu' })).rejects.toThrow(
      'No workload driver registered for type "gpu"',
    );
  });

  it('supports multiple independent driver types simultaneously', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    reg.registerDriver(makeDriver('bot'));
    const gpu = await reg.deploy('g', { type: 'gpu' });
    const bot = await reg.deploy('b', { type: 'bot', botKind: 'teams' });
    expect(gpu.type).toBe('gpu');
    expect(bot.type).toBe('bot');
  });
});

// ── onEvent / emit ────────────────────────────────────────────────────────────

describe('onEvent', () => {
  it('calls the handler when a workload event is emitted', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    const events: WorkloadEvent[] = [];
    reg.onEvent((e) => events.push(e));
    await reg.deploy('w', { type: 'gpu' });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('created');
  });

  it('returns a disposer that stops future events to that handler', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    const events: WorkloadEvent[] = [];
    const off = reg.onEvent((e) => events.push(e));
    off();
    await reg.deploy('w', { type: 'gpu' });
    expect(events).toHaveLength(0);
  });

  it('notifies all registered listeners', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    const a: WorkloadEvent[] = [];
    const b: WorkloadEvent[] = [];
    reg.onEvent((e) => a.push(e));
    reg.onEvent((e) => b.push(e));
    await reg.deploy('w', { type: 'gpu' });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('isolates throwing listeners so subsequent ones still fire', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    const good: WorkloadEvent[] = [];
    reg.onEvent(() => { throw new Error('oops'); });
    reg.onEvent((e) => good.push(e));
    await reg.deploy('w', { type: 'gpu' });
    expect(good).toHaveLength(1);
  });

  it('removing one listener does not affect others', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    const a: WorkloadEvent[] = [];
    const b: WorkloadEvent[] = [];
    const offA = reg.onEvent((e) => a.push(e));
    reg.onEvent((e) => b.push(e));
    offA();
    await reg.deploy('w', { type: 'gpu' });
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });
});

// ── CRUD reads ────────────────────────────────────────────────────────────────

describe('list / get / getByName / listByType', () => {
  it('list() returns empty array before any workloads are added', () => {
    expect(new WorkloadRegistry().list()).toEqual([]);
  });

  it('get() returns undefined for unknown id', () => {
    expect(new WorkloadRegistry().get('nope')).toBeUndefined();
  });

  it('getByName() returns undefined for unknown name', () => {
    expect(new WorkloadRegistry().getByName('nope')).toBeUndefined();
  });

  it('list() returns all deployed workloads', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    reg.registerDriver(makeDriver('bot'));
    await reg.deploy('g', { type: 'gpu' });
    await reg.deploy('b', { type: 'bot', botKind: 'teams' });
    expect(reg.list()).toHaveLength(2);
  });

  it('get() retrieves a workload by id', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    const w = await reg.deploy('my-gpu', { type: 'gpu' });
    expect(reg.get(w.id)).toMatchObject({ name: 'my-gpu' });
  });

  it('getByName() retrieves a workload by its name', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    await reg.deploy('named-one', { type: 'gpu' });
    expect(reg.getByName('named-one')).toBeDefined();
    expect(reg.getByName('other')).toBeUndefined();
  });

  it('listByType() filters workloads by type', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    reg.registerDriver(makeDriver('bot'));
    await reg.deploy('g1', { type: 'gpu' });
    await reg.deploy('g2', { type: 'gpu' });
    await reg.deploy('b1', { type: 'bot', botKind: 'teams' });
    expect(reg.listByType('gpu')).toHaveLength(2);
    expect(reg.listByType('bot')).toHaveLength(1);
    expect(reg.listByType('db')).toHaveLength(0);
  });
});

// ── import ────────────────────────────────────────────────────────────────────

describe('import', () => {
  it('seeds an externally-created workload into the registry', () => {
    const reg = new WorkloadRegistry();
    const w = makeWorkload({ id: 'ext-1', name: 'external' });
    reg.import(w);
    expect(reg.get('ext-1')).toEqual(w);
  });

  it('overwrites an existing entry with the same id', () => {
    const reg = new WorkloadRegistry();
    const w1 = makeWorkload({ id: 'x', name: 'first' });
    const w2 = makeWorkload({ id: 'x', name: 'second' });
    reg.import(w1);
    reg.import(w2);
    expect(reg.get('x')?.name).toBe('second');
  });

  it('imported workloads appear in list() and listByType()', () => {
    const reg = new WorkloadRegistry();
    reg.import(makeWorkload({ type: 'gpu' }));
    reg.import(makeWorkload({ type: 'bot' }));
    expect(reg.list()).toHaveLength(2);
    expect(reg.listByType('gpu')).toHaveLength(1);
  });
});

// ── WorkloadRegistry.newId ────────────────────────────────────────────────────

describe('WorkloadRegistry.newId', () => {
  it('returns a non-empty string', () => {
    expect(typeof WorkloadRegistry.newId()).toBe('string');
    expect(WorkloadRegistry.newId().length).toBeGreaterThan(0);
  });

  it('returns unique values on successive calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => WorkloadRegistry.newId()));
    expect(ids.size).toBe(20);
  });

  it('matches UUID v4 format', () => {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(WorkloadRegistry.newId()).toMatch(uuidRe);
  });
});

// ── deploy ────────────────────────────────────────────────────────────────────

describe('deploy', () => {
  it('stores the workload returned by the driver', async () => {
    const reg = new WorkloadRegistry();
    const driver = makeDriver('gpu');
    reg.registerDriver(driver);
    const w = await reg.deploy('my-gpu', { type: 'gpu' });
    expect(reg.get(w.id)).toEqual(w);
  });

  it('emits a "created" event with the new workload', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    const events: WorkloadEvent[] = [];
    reg.onEvent((e) => events.push(e));
    const w = await reg.deploy('my-gpu', { type: 'gpu' });
    expect(events[0]).toMatchObject({ type: 'created', workload: { id: w.id } });
  });

  it('passes name and config to the driver', async () => {
    const reg = new WorkloadRegistry();
    const driver = makeDriver('gpu');
    reg.registerDriver(driver);
    const cfg: WorkloadConfig = { type: 'gpu', dockerImage: 'img:latest' };
    await reg.deploy('gpu-1', cfg);
    expect(driver.deploy).toHaveBeenCalledWith('gpu-1', cfg);
  });

  it('throws when a non-error workload with the same name already exists', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    await reg.deploy('dupe', { type: 'gpu' });
    await expect(reg.deploy('dupe', { type: 'gpu' })).rejects.toThrow(
      'Workload "dupe" already exists',
    );
  });

  it('replaces an errored workload with the same name', async () => {
    const reg = new WorkloadRegistry();
    const driver = makeDriver('gpu', {
      deploy: vi.fn(async (name: string) => makeWorkload({ name, type: 'gpu', status: 'error' })),
    });
    reg.registerDriver(driver);
    const first = await reg.deploy('retry', { type: 'gpu' });
    // Second deploy on same name should succeed (first is in error state)
    const second = await reg.deploy('retry', { type: 'gpu' });
    expect(reg.get(first.id)).toBeUndefined(); // old errored entry removed
    expect(reg.get(second.id)).toBeDefined();
  });

  it('throws for concurrent deploys with the same name', async () => {
    const reg = new WorkloadRegistry();
    let resolveFirst!: (w: Workload) => void;
    const driver: WorkloadDriver = {
      type: 'gpu',
      deploy: vi.fn(
        (_name: string, _cfg: WorkloadConfig) =>
          new Promise<Workload>((res) => { resolveFirst = res; }),
      ),
      stop: vi.fn(async (w) => w),
      start: vi.fn(async (w) => w),
      terminate: vi.fn(async () => undefined),
      status: vi.fn(async (w) => w),
    };
    reg.registerDriver(driver);

    const first = reg.deploy('locked', { type: 'gpu' }); // starts, but hangs
    await expect(reg.deploy('locked', { type: 'gpu' })).rejects.toThrow(
      'Workload "locked" is already being deployed',
    );
    // Clean up
    resolveFirst(makeWorkload({ name: 'locked' }));
    await first;
  });

  it('releases the deploy lock after success so re-deploy on error status is allowed', async () => {
    const reg = new WorkloadRegistry();
    let call = 0;
    const driver = makeDriver('gpu', {
      deploy: vi.fn(async (name: string) => {
        call++;
        return makeWorkload({ name, type: 'gpu', status: call === 1 ? 'error' : 'running' });
      }),
    });
    reg.registerDriver(driver);
    await reg.deploy('x', { type: 'gpu' });
    // second call allowed: old entry is error, lock was released
    const second = await reg.deploy('x', { type: 'gpu' });
    expect(second.status).toBe('running');
  });
});

// ── stop ──────────────────────────────────────────────────────────────────────

describe('stop', () => {
  it('updates the registry with the driver result', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    const w = await reg.deploy('w', { type: 'gpu' });
    const stopped = await reg.stop(w.id);
    expect(stopped.status).toBe('stopped');
    expect(reg.get(w.id)?.status).toBe('stopped');
  });

  it('emits "status_changed" with the previous status', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    const w = await reg.deploy('w', { type: 'gpu' });
    const events: WorkloadEvent[] = [];
    reg.onEvent((e) => events.push(e));
    const prevStatus = w.status;
    await reg.stop(w.id);
    const evt = events.find((e) => e.type === 'status_changed');
    expect(evt).toBeDefined();
    expect(evt?.previousStatus).toBe(prevStatus);
    expect(evt?.workload.status).toBe('stopped');
  });

  it('throws for an unknown id', async () => {
    const reg = new WorkloadRegistry();
    await expect(reg.stop('no-such')).rejects.toThrow('not found');
  });
});

// ── start ─────────────────────────────────────────────────────────────────────

describe('start', () => {
  it('updates the registry with the driver result', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    const w = await reg.deploy('w', { type: 'gpu' });
    await reg.stop(w.id);
    await reg.start(w.id);
    expect(reg.get(w.id)?.status).toBe('running');
  });

  it('emits "status_changed"', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    const w = await reg.deploy('w', { type: 'gpu' });
    await reg.stop(w.id);
    const events: WorkloadEvent[] = [];
    reg.onEvent((e) => events.push(e));
    await reg.start(w.id);
    expect(events.some((e) => e.type === 'status_changed')).toBe(true);
  });

  it('throws for an unknown id', async () => {
    const reg = new WorkloadRegistry();
    await expect(reg.start('no-such')).rejects.toThrow('not found');
  });
});

// ── terminate ─────────────────────────────────────────────────────────────────

describe('terminate', () => {
  it('removes the workload from the registry', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    const w = await reg.deploy('w', { type: 'gpu' });
    await reg.terminate(w.id);
    expect(reg.get(w.id)).toBeUndefined();
    expect(reg.list()).toHaveLength(0);
  });

  it('emits "terminated" with status "idle"', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    const w = await reg.deploy('w', { type: 'gpu' });
    const events: WorkloadEvent[] = [];
    reg.onEvent((e) => events.push(e));
    await reg.terminate(w.id);
    const evt = events.find((e) => e.type === 'terminated');
    expect(evt).toBeDefined();
    expect(evt?.workload.status).toBe('idle');
  });

  it('throws for an unknown id', async () => {
    const reg = new WorkloadRegistry();
    await expect(reg.terminate('no-such')).rejects.toThrow('not found');
  });

  it('does not affect other workloads', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    const a = await reg.deploy('a', { type: 'gpu' });
    const b = await reg.deploy('b', { type: 'gpu' });
    await reg.terminate(a.id);
    expect(reg.get(b.id)).toBeDefined();
    expect(reg.list()).toHaveLength(1);
  });
});

// ── refreshStatus ─────────────────────────────────────────────────────────────

describe('refreshStatus', () => {
  it('updates the stored workload with the driver result', async () => {
    const reg = new WorkloadRegistry();
    const updated = makeWorkload({ name: 'w', status: 'stopped' });
    const driver = makeDriver('gpu', {
      status: vi.fn(async (_w: Workload) => updated),
    });
    reg.registerDriver(driver);
    const w = await reg.deploy('w', { type: 'gpu' });
    const refreshed = await reg.refreshStatus(w.id);
    expect(refreshed.status).toBe('stopped');
    expect(reg.get(w.id)?.status).toBe('stopped');
  });

  it('emits "status_changed" only when status differs', async () => {
    const reg = new WorkloadRegistry();
    reg.registerDriver(makeDriver('gpu'));
    const w = await reg.deploy('w', { type: 'gpu' });
    const events: WorkloadEvent[] = [];
    reg.onEvent((e) => events.push(e));
    // status() mock returns same workload (same status) → no event
    await reg.refreshStatus(w.id);
    expect(events.filter((e) => e.type === 'status_changed')).toHaveLength(0);
  });

  it('emits "status_changed" when the status changes', async () => {
    const reg = new WorkloadRegistry();
    const driver = makeDriver('gpu', {
      status: vi.fn(async (w: Workload) => ({ ...w, status: 'stopped' as const })),
    });
    reg.registerDriver(driver);
    const w = await reg.deploy('w', { type: 'gpu' });
    const events: WorkloadEvent[] = [];
    reg.onEvent((e) => events.push(e));
    await reg.refreshStatus(w.id);
    expect(events.some((e) => e.type === 'status_changed')).toBe(true);
  });

  it('throws for an unknown id', async () => {
    const reg = new WorkloadRegistry();
    await expect(reg.refreshStatus('no-such')).rejects.toThrow('not found');
  });

  it('records the previousStatus on the emitted event', async () => {
    const reg = new WorkloadRegistry();
    const driver = makeDriver('gpu', {
      status: vi.fn(async (w: Workload) => ({ ...w, status: 'error' as const })),
    });
    reg.registerDriver(driver);
    const w = await reg.deploy('w', { type: 'gpu' });
    const events: WorkloadEvent[] = [];
    reg.onEvent((e) => events.push(e));
    await reg.refreshStatus(w.id);
    const evt = events.find((e) => e.type === 'status_changed');
    expect(evt?.previousStatus).toBe(w.status);
    expect(evt?.workload.status).toBe('error');
  });
});
