/**
 * State Adapters — Integration Tests
 *
 * Tests InMemoryStateAdapter operations (KV, list, hash).
 * No external dependencies required.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStateAdapter } from '../src/adapters';

describe('InMemoryStateAdapter', () => {
  let store: InstanceType<typeof InMemoryStateAdapter>;

  beforeEach(() => {
    store = new InMemoryStateAdapter();
  });

  describe('KV operations', () => {
    it('get returns null for missing key', async () => {
      expect(await store.get('missing')).toBeNull();
    });

    it('set and get roundtrip', async () => {
      await store.set('key1', 'value1');
      expect(await store.get('key1')).toBe('value1');
    });

    it('del removes key', async () => {
      await store.set('key2', 'val2');
      await store.del('key2');
      expect(await store.get('key2')).toBeNull();
    });

    it('set overwrites existing value', async () => {
      await store.set('key3', 'old');
      await store.set('key3', 'new');
      expect(await store.get('key3')).toBe('new');
    });

    it('scan matches prefix pattern', async () => {
      await store.set('user:1:name', 'Alice');
      await store.set('user:2:name', 'Bob');
      await store.set('session:1', 'active');

      const userKeys = await store.scan('user:*');
      expect(userKeys).toContain('user:1:name');
      expect(userKeys).toContain('user:2:name');
      expect(userKeys).not.toContain('session:1');
    });

    it('scan returns empty for no matches', async () => {
      await store.set('foo', 'bar');
      const result = await store.scan('nope:*');
      expect(result).toEqual([]);
    });
  });

  describe('List operations', () => {
    it('rpush and lrange', async () => {
      await store.rpush('list1', 'a');
      await store.rpush('list1', 'b');
      await store.rpush('list1', 'c');

      const all = await store.lrange('list1', 0, -1);
      expect(all).toEqual(['a', 'b', 'c']);
    });

    it('lrange with bounds', async () => {
      await store.rpush('list2', 'x');
      await store.rpush('list2', 'y');
      await store.rpush('list2', 'z');

      const first = await store.lrange('list2', 0, 0);
      expect(first).toEqual(['x']);

      const firstTwo = await store.lrange('list2', 0, 1);
      expect(firstTwo).toEqual(['x', 'y']);
    });

    it('lrange with negative index', async () => {
      await store.rpush('list-neg', 'a');
      await store.rpush('list-neg', 'b');
      await store.rpush('list-neg', 'c');

      const last = await store.lrange('list-neg', -1, -1);
      expect(last).toEqual(['c']);

      const lastTwo = await store.lrange('list-neg', -2, -1);
      expect(lastTwo).toEqual(['b', 'c']);
    });

    it('ltrim trims list', async () => {
      for (const v of ['a', 'b', 'c', 'd', 'e']) {
        await store.rpush('list3', v);
      }
      await store.ltrim('list3', 0, 2);
      const result = await store.lrange('list3', 0, -1);
      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('empty list returns empty array', async () => {
      expect(await store.lrange('empty', 0, -1)).toEqual([]);
    });
  });

  describe('Hash operations', () => {
    it('hset and hgetall', async () => {
      await store.hset('hash1', 'field1', 'value1');
      const all = await store.hgetall('hash1');
      expect(all).toEqual({ field1: 'value1' });
    });

    it('hgetall returns all fields', async () => {
      await store.hset('hash2', 'a', '1');
      await store.hset('hash2', 'b', '2');
      await store.hset('hash2', 'c', '3');

      const all = await store.hgetall('hash2');
      expect(all).toEqual({ a: '1', b: '2', c: '3' });
    });

    it('hgetall returns empty object for missing hash', async () => {
      expect(await store.hgetall('nope')).toEqual({});
    });

    it('hdel removes a field', async () => {
      await store.hset('hash3', 'keep', '1');
      await store.hset('hash3', 'remove', '2');
      await store.hdel('hash3', 'remove');

      const all = await store.hgetall('hash3');
      expect(all).toEqual({ keep: '1' });
    });

    it('hset overwrites field', async () => {
      await store.hset('hash4', 'f', 'old');
      await store.hset('hash4', 'f', 'new');

      const all = await store.hgetall('hash4');
      expect(all).toEqual({ f: 'new' });
    });
  });
});
