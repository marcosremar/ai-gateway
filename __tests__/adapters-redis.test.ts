import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisStateAdapter } from '../src/adapters/redis-state';
import type { RedisLike } from '../src/adapters/redis-state';

function createMockRedis(): RedisLike & { _store: Record<string, string>; _lists: Record<string, string[]>; _hashes: Record<string, Record<string, string>> } {
  const store: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const hashes: Record<string, Record<string, string>> = {};

  return {
    _store: store,
    _lists: lists,
    _hashes: hashes,

    async get(key: string) {
      return store[key] ?? null;
    },

    async set(key: string, value: string, ...args: unknown[]) {
      store[key] = value;
      if (args[0] === 'EX') {
        // TTL is handled by redis; we just store the value
      }
      return 'OK';
    },

    async del(...args: unknown[]) {
      const key = args[0] as string;
      delete store[key];
      delete lists[key];
      delete hashes[key];
      return 1;
    },

    async scan(cursor: string, ...args: unknown[]) {
      const matchIdx = args.indexOf('MATCH');
      const pattern = matchIdx >= 0 ? (args[matchIdx + 1] as string) : '*';
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      const matched = Object.keys(store).filter(k => regex.test(k));
      return ['0', matched] as [string, string[]];
    },

    async rpush(key: string, ...values: unknown[]) {
      if (!lists[key]) lists[key] = [];
      lists[key].push(...values.map(String));
      return lists[key].length;
    },

    async ltrim(key: string, start: number, stop: number) {
      if (lists[key]) {
        const end = stop === -1 ? lists[key].length : stop + 1;
        lists[key] = lists[key].slice(start, end);
      }
      return 'OK';
    },

    async lrange(key: string, start: number, stop: number) {
      const list = lists[key] ?? [];
      const end = stop === -1 ? list.length : stop + 1;
      return list.slice(start, end);
    },

    async hset(key: string, ...args: unknown[]) {
      if (!hashes[key]) hashes[key] = {};
      if (args.length === 1 && typeof args[0] === 'object') {
        Object.assign(hashes[key], args[0]);
      } else {
        hashes[key][args[0] as string] = args[1] as string;
      }
      return 1;
    },

    async hdel(key: string, ...fields: unknown[]) {
      const field = fields[0] as string;
      if (hashes[key]) {
        delete hashes[key][field];
      }
      return 1;
    },

    async hgetall(key: string) {
      return hashes[key] ?? {};
    },
  };
}

describe('RedisStateAdapter', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let adapter: RedisStateAdapter;

  beforeEach(() => {
    redis = createMockRedis();
    adapter = new RedisStateAdapter(redis);
  });

  it('get returns null for missing key', async () => {
    expect(await adapter.get('nope')).toBeNull();
  });

  it('set + get round-trip', async () => {
    await adapter.set('k1', 'v1');
    expect(await adapter.get('k1')).toBe('v1');
  });

  it('set with TTL passes EX to redis.set', async () => {
    const spy = vi.spyOn(redis, 'set');
    await adapter.set('k1', 'v1', 300);
    expect(spy).toHaveBeenCalledWith('k1', 'v1', 'EX', 300);
    spy.mockRestore();
  });

  it('del removes key', async () => {
    await adapter.set('k1', 'v1');
    expect(await adapter.get('k1')).toBe('v1');
    await adapter.del('k1');
    expect(await adapter.get('k1')).toBeNull();
  });

  it('scan uses redis scan', async () => {
    await adapter.set('user:1', 'a');
    await adapter.set('user:2', 'b');
    await adapter.set('session:1', 'c');

    let foundKeys: string[] = [];
    const count = await adapter.scan('user:*', (keys) => { foundKeys = keys; });
    expect(count).toBe(2);
    expect(foundKeys.sort()).toEqual(['user:1', 'user:2']);
  });

  it('rpush + lrange list operations', async () => {
    await adapter.rpush('mylist', 'a');
    await adapter.rpush('mylist', 'b');
    await adapter.rpush('mylist', 'c');
    const items = await adapter.lrange('mylist', 0, -1);
    expect(items).toEqual(['a', 'b', 'c']);
  });

  it('ltrim trims list', async () => {
    await adapter.rpush('mylist', 'a');
    await adapter.rpush('mylist', 'b');
    await adapter.rpush('mylist', 'c');
    await adapter.rpush('mylist', 'd');
    await adapter.ltrim('mylist', 1, 2);
    const items = await adapter.lrange('mylist', 0, -1);
    expect(items).toEqual(['b', 'c']);
  });

  it('hset + hgetall hash operations', async () => {
    await adapter.hset('myhash', 'field1', 'val1');
    await adapter.hset('myhash', 'field2', 'val2');
    const data = await adapter.hgetall('myhash');
    expect(data).toEqual({ field1: 'val1', field2: 'val2' });
  });

  it('hdel deletes hash field', async () => {
    await adapter.hset('myhash', 'f1', 'v1');
    await adapter.hset('myhash', 'f2', 'v2');
    await adapter.hdel('myhash', 'f1');
    const data = await adapter.hgetall('myhash');
    expect(data).toEqual({ f2: 'v2' });
  });
});
