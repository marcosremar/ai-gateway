/**
 * Tests for autoscaler/state-persistence.ts
 * - StatePersistence.persistTierStates()
 * - StatePersistence.loadPersistedTierStates()
 * - StatePersistence.findUsersWithActiveGpus()
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StatePersistence } from '../src/autoscaler/state-persistence';
import type { KvStore } from '../src/deps';
import type { GpuTierState, IdleTierState, BootingTierState, ReadyTierState } from '../src/types';

function makeKvStore() {
  const kvs = new Map<string, string>();
  const store: KvStore & { kvs: Map<string, string> } = {
    kvs,
    async get(key) { return kvs.get(key) ?? null; },
    async set(key, value, _ttl) { kvs.set(key, value); },
    async del(key) { kvs.delete(key); },
    async scan(pattern, callback) {
      const prefix = pattern.replace('*', '');
      const matching = [...kvs.keys()].filter(k => k.startsWith(prefix));
      if (callback) {
        callback(matching);
      }
      return matching.length;
    },
  };
  return store;
}

const silentLogger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeIdle(tierIndex: number, extra: Partial<IdleTierState> = {}): IdleTierState {
  return { state: 'idle', tierIndex, ...extra };
}

function makeBooting(tierIndex: number, extra: Partial<BootingTierState> = {}): BootingTierState {
  return {
    state: 'booting',
    tierIndex,
    endpoint: `http://endpoint-${tierIndex}:8000`,
    bootTriggeredAt: Date.now() - 30000,
    trigger: 'sessions',
    prevBootFailCount: 0,
    ...extra,
  };
}

function makeReady(tierIndex: number, extra: Partial<ReadyTierState> = {}): ReadyTierState {
  return {
    state: 'ready',
    tierIndex,
    endpoint: `http://endpoint-${tierIndex}:8000`,
    lastHealthyAt: Date.now(),
    ...extra,
  };
}

describe('StatePersistence', () => {
  let store: ReturnType<typeof makeKvStore>;
  let persistence: StatePersistence;

  beforeEach(() => {
    store = makeKvStore();
    persistence = new StatePersistence(store, silentLogger);
  });

  describe('persistTierStates()', () => {
    it('deletes key when all states are idle', async () => {
      // First persist a non-idle state
      await persistence.persistTierStates('user-1', [makeReady(0)]);
      expect(store.kvs.has('gpu:tiers:user-1')).toBe(true);

      // Now set all to idle — should delete
      await persistence.persistTierStates('user-1', [makeIdle(0)]);
      expect(store.kvs.has('gpu:tiers:user-1')).toBe(false);
    });

    it('deletes key when states array is empty', async () => {
      await persistence.persistTierStates('user-1', [makeReady(0)]);
      await persistence.persistTierStates('user-1', []);
      expect(store.kvs.has('gpu:tiers:user-1')).toBe(false);
    });

    it('persists booting state', async () => {
      const booting = makeBooting(0, { discoveredInstanceId: 'pod-123', sshHost: '10.0.0.1', sshPort: 22 });
      await persistence.persistTierStates('user-1', [booting]);

      const raw = store.kvs.get('gpu:tiers:user-1');
      expect(raw).toBeDefined();
      const parsed = JSON.parse(raw!);
      expect(parsed[0].state).toBe('booting');
      expect(parsed[0].tierIndex).toBe(0);
      expect(parsed[0].discoveredInstanceId).toBe('pod-123');
      expect(parsed[0].sshHost).toBe('10.0.0.1');
      expect(parsed[0].sshPort).toBe(22);
    });

    it('persists ready state', async () => {
      const ready = makeReady(1, { activeGpuType: 'RTX3090', trigger: 'latency', bootedAt: Date.now() - 60000 });
      await persistence.persistTierStates('user-1', [ready]);

      const raw = store.kvs.get('gpu:tiers:user-1');
      const parsed = JSON.parse(raw!);
      expect(parsed[0].state).toBe('ready');
      expect(parsed[0].activeGpuType).toBe('RTX3090');
      expect(parsed[0].trigger).toBe('latency');
      expect(parsed[0].bootedAt).toBeDefined();
    });

    it('persists mixed states', async () => {
      const states: GpuTierState[] = [makeIdle(0), makeBooting(1), makeReady(2)];
      await persistence.persistTierStates('user-1', states);

      const raw = store.kvs.get('gpu:tiers:user-1');
      const parsed = JSON.parse(raw!);
      expect(parsed).toHaveLength(3);
      expect(parsed.find((s: Record<string, unknown>) => s.tierIndex === 0).state).toBe('idle');
      expect(parsed.find((s: Record<string, unknown>) => s.tierIndex === 1).state).toBe('booting');
      expect(parsed.find((s: Record<string, unknown>) => s.tierIndex === 2).state).toBe('ready');
    });

    it('does not throw on store errors', async () => {
      const errorStore: KvStore = {
        async get(key) { return null; },
        async set() { throw new Error('set error'); },
        async del() {},
        async scan() { return []; },
      };
      const errorPersistence = new StatePersistence(errorStore, silentLogger);
      await expect(errorPersistence.persistTierStates('user-1', [makeBooting(0)])).resolves.toBeUndefined();
    });
  });

  describe('loadPersistedTierStates()', () => {
    it('returns null when no persisted state', async () => {
      const result = await persistence.loadPersistedTierStates('user-1');
      expect(result).toBeNull();
    });

    it('loads booting state', async () => {
      const booting = makeBooting(0, { discoveredInstanceId: 'pod-abc' });
      await persistence.persistTierStates('user-1', [booting]);

      const loaded = await persistence.loadPersistedTierStates('user-1');
      expect(loaded).not.toBeNull();
      expect(loaded![0].state).toBe('booting');
      expect((loaded![0] as BootingTierState).discoveredInstanceId).toBe('pod-abc');
    });

    it('loads ready state', async () => {
      const ready = makeReady(1, { activeGpuType: 'A100', sshHost: '192.168.1.1', sshPort: 2222 });
      await persistence.persistTierStates('user-1', [ready]);

      const loaded = await persistence.loadPersistedTierStates('user-1');
      expect(loaded![0].state).toBe('ready');
      const r = loaded![0] as ReadyTierState;
      expect(r.activeGpuType).toBe('A100');
      expect(r.sshHost).toBe('192.168.1.1');
      expect(r.sshPort).toBe(2222);
    });

    it('loads idle state', async () => {
      // Persist a booting+idle mix (idle won't be stored if all idle, but direct set covers it)
      const states: GpuTierState[] = [makeIdle(0, { bootFailCount: 2, cooldownUntil: Date.now() + 60000, unhealthy: true }), makeBooting(1)];
      await persistence.persistTierStates('user-1', states);

      const loaded = await persistence.loadPersistedTierStates('user-1');
      const idle = loaded!.find(s => s.state === 'idle') as IdleTierState;
      expect(idle).toBeDefined();
      expect(idle.bootFailCount).toBe(2);
      expect(idle.unhealthy).toBe(true);
    });

    it('handles corrupted JSON gracefully', async () => {
      store.kvs.set('gpu:tiers:user-1', 'not-valid-json');
      const result = await persistence.loadPersistedTierStates('user-1');
      expect(result).toBeNull();
      // Should also delete the corrupted key
      expect(store.kvs.has('gpu:tiers:user-1')).toBe(false);
    });

    it('returns null for empty array', async () => {
      store.kvs.set('gpu:tiers:user-1', JSON.stringify([]));
      const result = await persistence.loadPersistedTierStates('user-1');
      expect(result).toBeNull();
    });

    it('returns null on store error', async () => {
      const errorStore: KvStore = {
        async get() { throw new Error('get error'); },
        async set() {},
        async del() {},
        async scan() { return []; },
      };
      const errorPersistence = new StatePersistence(errorStore, silentLogger);
      const result = await errorPersistence.loadPersistedTierStates('user-1');
      expect(result).toBeNull();
    });

    it('defaults tierIndex to 0 for legacy entries', async () => {
      // Inject entry without tierIndex
      store.kvs.set('gpu:tiers:user-1', JSON.stringify([{
        state: 'ready',
        endpoint: 'http://endpoint:8000',
        lastHealthyAt: Date.now(),
        // No tierIndex
      }]));

      const loaded = await persistence.loadPersistedTierStates('user-1');
      expect(loaded![0].tierIndex).toBe(0);
    });
  });

  describe('findUsersWithActiveGpus()', () => {
    it('returns empty array when no keys', async () => {
      const result = await persistence.findUsersWithActiveGpus();
      expect(result).toEqual([]);
    });

    it('returns user IDs for matching keys', async () => {
      await persistence.persistTierStates('user-1', [makeBooting(0)]);
      await persistence.persistTierStates('user-2', [makeReady(0)]);

      const result = await persistence.findUsersWithActiveGpus();
      expect(result).toContain('user-1');
      expect(result).toContain('user-2');
    });

    it('does not return other keys', async () => {
      store.kvs.set('other:prefix:data', 'value');
      await persistence.persistTierStates('user-1', [makeBooting(0)]);

      const result = await persistence.findUsersWithActiveGpus();
      expect(result).toEqual(['user-1']);
    });

    it('returns empty array on scan error', async () => {
      const errorStore: KvStore = {
        async get() { return null; },
        async set() {},
        async del() {},
        async scan() { throw new Error('scan error'); },
      };
      const errorPersistence = new StatePersistence(errorStore, silentLogger);
      const result = await errorPersistence.findUsersWithActiveGpus();
      expect(result).toEqual([]);
    });
  });
});
