import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkloadRegistry } from '../src/workloads/registry';
import type { Workload, WorkloadDriver, WorkloadConfig, WorkloadEvent } from '../src/workloads/types';

function createMockDriver(type: 'gpu' | 'bot' | 'db' = 'gpu'): WorkloadDriver {
  return {
    type,
    deploy: vi.fn().mockImplementation(async (name: string) => ({
      id: WorkloadRegistry.newId(),
      type,
      name,
      status: 'deploying' as const,
      provider: 'test',
      costPerHr: 0,
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
    stop: vi.fn().mockImplementation(async (w: Workload) => ({
      ...w,
      status: 'stopped' as const,
      updatedAt: Date.now(),
    })),
    start: vi.fn().mockImplementation(async (w: Workload) => ({
      ...w,
      status: 'running' as const,
      updatedAt: Date.now(),
    })),
    terminate: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockImplementation(async (w: Workload) => w),
  };
}

function makeWorkload(overrides: Partial<Workload> = {}): Workload {
  return {
    id: 'w-1',
    type: 'gpu',
    name: 'test-workload',
    status: 'running',
    provider: 'runpod',
    costPerHr: 0.5,
    metadata: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('WorkloadRegistry', () => {
  let registry: WorkloadRegistry;

  beforeEach(() => {
    registry = new WorkloadRegistry();
  });

  describe('driver registration', () => {
    it('registers a driver', () => {
      const driver = createMockDriver();
      registry.registerDriver(driver);
      expect(() => registry.deploy('test', { type: 'gpu' })).not.toThrow();
    });

    it('throws on deploy without driver', async () => {
      await expect(
        registry.deploy('test', { type: 'bot', botKind: 'teams' }),
      ).rejects.toThrow('No workload driver registered');
    });
  });

  describe('CRUD', () => {
    it('list returns empty initially', () => {
      expect(registry.list()).toEqual([]);
    });

    it('get returns undefined for unknown id', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('getByName returns matching workload', async () => {
      registry.registerDriver(createMockDriver());
      await registry.deploy('my-gpu', { type: 'gpu' });
      const found = registry.getByName('my-gpu');
      expect(found).toBeDefined();
      expect(found!.name).toBe('my-gpu');
    });

    it('getByName returns undefined for unknown name', () => {
      expect(registry.getByName('unknown')).toBeUndefined();
    });

    it('listByType filters workloads', async () => {
      registry.registerDriver(createMockDriver('gpu'));
      registry.registerDriver(createMockDriver('bot'));
      await registry.deploy('gpu-1', { type: 'gpu' });
      await registry.deploy('bot-1', { type: 'bot' as const, botKind: 'teams' });

      const gpuList = registry.listByType('gpu');
      const botList = registry.listByType('bot');
      expect(gpuList).toHaveLength(1);
      expect(botList).toHaveLength(1);
    });
  });

  describe('deploy', () => {
    it('creates a workload via driver', async () => {
      registry.registerDriver(createMockDriver());
      const w = await registry.deploy('test-wl', { type: 'gpu' });
      expect(w.name).toBe('test-wl');
      expect(w.status).toBe('deploying');
      expect(registry.get(w.id)).toBe(w);
    });

    it('emits created event', async () => {
      registry.registerDriver(createMockDriver());
      const handler = vi.fn();
      registry.onEvent(handler);

      await registry.deploy('test-wl', { type: 'gpu' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'created' }),
      );
    });

    it('rejects duplicate name if not errored', async () => {
      registry.registerDriver(createMockDriver());
      await registry.deploy('dup', { type: 'gpu' });

      await expect(
        registry.deploy('dup', { type: 'gpu' }),
      ).rejects.toThrow('already exists');
    });

    it('replaces errored workload with same name', async () => {
      registry.registerDriver(createMockDriver());
      const errored = makeWorkload({ name: 'dup', status: 'error' });
      registry.import(errored);

      const w = await registry.deploy('dup', { type: 'gpu' });
      expect(w.status).toBe('deploying');
    });
  });

  describe('stop', () => {
    it('stops workload via driver', async () => {
      registry.registerDriver(createMockDriver());
      const w = await registry.deploy('test', { type: 'gpu' });
      const stopped = await registry.stop(w.id);
      expect(stopped.status).toBe('stopped');
    });

    it('emits status_changed event', async () => {
      registry.registerDriver(createMockDriver());
      const handler = vi.fn();
      registry.onEvent(handler);
      const w = await registry.deploy('test', { type: 'gpu' });

      await registry.stop(w.id);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status_changed',
          previousStatus: 'deploying',
        }),
      );
    });

    it('throws for unknown workload', async () => {
      await expect(registry.stop('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('start', () => {
    it('starts workload via driver', async () => {
      registry.registerDriver(createMockDriver());
      const w = await registry.deploy('test', { type: 'gpu' });
      const started = await registry.start(w.id);
      expect(started.status).toBe('running');
    });

    it('throws for unknown workload', async () => {
      await expect(registry.start('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('terminate', () => {
    it('removes workload', async () => {
      registry.registerDriver(createMockDriver());
      const w = await registry.deploy('test', { type: 'gpu' });

      await registry.terminate(w.id);
      expect(registry.get(w.id)).toBeUndefined();
    });

    it('emits terminated event', async () => {
      registry.registerDriver(createMockDriver());
      const handler = vi.fn();
      registry.onEvent(handler);
      const w = await registry.deploy('test', { type: 'gpu' });

      await registry.terminate(w.id);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'terminated' }),
      );
    });

    it('throws for unknown workload', async () => {
      await expect(registry.terminate('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('refreshStatus', () => {
    it('updates status via driver', async () => {
      const driver = createMockDriver();
      driver.status = vi.fn().mockImplementation(async (w: Workload) => ({
        ...w,
        status: 'running' as const,
        updatedAt: Date.now(),
      }));
      registry.registerDriver(driver);
      const w = await registry.deploy('test', { type: 'gpu' });

      const refreshed = await registry.refreshStatus(w.id);
      expect(refreshed.status).toBe('running');
    });

    it('emits event only when status changes', async () => {
      const driver = createMockDriver();
      driver.status = vi.fn().mockImplementation(async (w: Workload) => w);
      registry.registerDriver(driver);
      const handler = vi.fn();
      registry.onEvent(handler);

      const w = await registry.deploy('test', { type: 'gpu' });
      handler.mockClear();

      await registry.refreshStatus(w.id);
      expect(handler).not.toHaveBeenCalled();
    });

    it('throws for unknown workload', async () => {
      await expect(registry.refreshStatus('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('event system', () => {
    it('unsubscribe removes handler', async () => {
      registry.registerDriver(createMockDriver());
      const handler = vi.fn();
      const unsub = registry.onEvent(handler);
      unsub();

      await registry.deploy('test', { type: 'gpu' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('handler errors do not break emit', async () => {
      registry.registerDriver(createMockDriver());
      const badHandler = vi.fn().mockImplementation(() => {
        throw new Error('handler error');
      });
      const goodHandler = vi.fn();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      registry.onEvent(badHandler);
      registry.onEvent(goodHandler);

      await registry.deploy('test', { type: 'gpu' });

      expect(badHandler).toHaveBeenCalled();
      expect(goodHandler).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('import', () => {
    it('imports an externally created workload', () => {
      const w = makeWorkload();
      registry.import(w);
      expect(registry.get('w-1')).toBe(w);
    });
  });

  describe('newId', () => {
    it('generates unique IDs', () => {
      const id1 = WorkloadRegistry.newId();
      const id2 = WorkloadRegistry.newId();
      expect(id1).not.toBe(id2);
    });
  });
});
