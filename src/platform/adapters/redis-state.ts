/**
 * Redis-backed StateStore — works with any ioredis-compatible client.
 *
 * Usage:
 *   import Redis from 'ioredis';
 *   const redis = new Redis();
 *   const store = new RedisStateAdapter(redis);
 */
import type { StateStore } from '../deps';

/** Minimal Redis-compatible interface (ioredis, redis, node-redis, etc.) */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...args: unknown[]): Promise<unknown>;
  scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]>;
  rpush(key: string, ...values: unknown[]): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  hset(key: string, ...args: unknown[]): Promise<unknown>;
  hdel(key: string, ...fields: unknown[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  /** Cursor-based hash scan — used to honor `limit` server-side (#762). */
  hscan?(key: string, cursor: string, ...args: unknown[]): Promise<[string, string[]]>;
  /** Set/refresh a key TTL — used by hset to mirror per-hash expiry. */
  expire(key: string, ttlSecs: number): Promise<unknown>;
}

/**
 * Fold an `HSCAN` reply (flat `[field, value, field, value, ...]`) into an
 * object (#762). Pure + exported so it is unit-testable without Redis. An odd
 * trailing element (malformed reply) is ignored.
 */
export function parseHscanReply(flat: string[], into: Record<string, string> = {}): Record<string, string> {
  for (let i = 0; i + 1 < flat.length; i += 2) {
    into[flat[i]!] = flat[i + 1]!;
  }
  return into;
}

/** StateStore backed by Redis (or any RedisLike client). */
export class RedisStateAdapter implements StateStore {
  constructor(private readonly redis: RedisLike) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSecs?: number): Promise<void> {
    if (ttlSecs) {
      await this.redis.set(key, value, 'EX', ttlSecs);
    } else {
      await this.redis.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async scan(pattern: string, callback?: (keys: string[]) => boolean | void, limit: number = 1000): Promise<number> {
    let cursor = '0';
    let totalKeys = 0;
    // #765: scale COUNT toward the caller's remaining `limit` (capped at a sane
    // upper bound) instead of a flat 100. A 10k scan was doing ~100 round-trips;
    // letting COUNT grow cuts that to ~10 while still bounding per-call work.
    const SCAN_COUNT_CAP = 1000;
    do {
      const batchSize = Math.min(SCAN_COUNT_CAP, limit - totalKeys);
      if (batchSize <= 0) break;
      const [nextCursor, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', batchSize);
      cursor = nextCursor;
      totalKeys += batch.length;
      if (callback && batch.length > 0) {
        const shouldContinue = callback(batch);
        if (shouldContinue === false) break;
      }
    } while (cursor !== '0' && totalKeys < limit);
    return totalKeys;
  }

  async rpush(key: string, value: string): Promise<void> {
    await this.redis.rpush(key, value);
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await this.redis.ltrim(key, start, stop);
  }

  async lrange(key: string, start: number, stop: number, maxElements?: number): Promise<string[]> {
    const out = await this.redis.lrange(key, start, stop);
    // #767: mirror the InMemory guard so the contract holds in prod too.
    if (maxElements !== undefined && out.length > maxElements) {
      throw new Error(`lrange: range returns ${out.length} elements, exceeds maxElements (${maxElements})`);
    }
    return out;
  }

  async hset(key: string, field: string, value: string, ttlSecs?: number): Promise<void> {
    await this.redis.hset(key, field, value);
    // Mirror InMemory adapter semantics — when callers pass ttlSecs the whole
    // hash gets a refreshed expiry. Without this, abandoned hashes (e.g.
    // session heartbeats for users that disappear) accumulate forever.
    if (ttlSecs && ttlSecs > 0 && typeof this.redis.expire === 'function') {
      await this.redis.expire(key, ttlSecs);
    }
  }

  async hdel(key: string, field: string): Promise<void> {
    await this.redis.hdel(key, field);
  }

  async hgetall(key: string, limit: number = 1000): Promise<Record<string, string>> {
    // #762: when the client supports HSCAN, walk the hash with a bounded COUNT
    // and stop once `limit` fields are collected — for a large hash this avoids
    // pulling the entire thing over the wire just to slice it in JS. Falls back
    // to plain HGETALL+slice when HSCAN is unavailable.
    if (typeof this.redis.hscan === 'function') {
      const out: Record<string, string> = {};
      let cursor = '0';
      const COUNT = Math.min(1000, Math.max(1, limit));
      do {
        const [next, flat] = await this.redis.hscan(key, cursor, 'COUNT', COUNT);
        cursor = next;
        parseHscanReply(flat, out);
        if (Object.keys(out).length >= limit) break;
      } while (cursor !== '0');
      const entries = Object.entries(out).slice(0, limit);
      return Object.fromEntries(entries);
    }
    const all = await this.redis.hgetall(key);
    const entries = Object.entries(all).slice(0, limit);
    return Object.fromEntries(entries);
  }

  async hincrby(key: string, field: string, increment: number, ttlSecs?: number): Promise<void> {
    await this.redis.hincrby(key, field, increment);
    // #763: TTL parity with InMemory.hincrby — when callers pass ttlSecs the
    // counter hash gets a refreshed expiry instead of being immortal. Without
    // this, dev (InMemory) and prod (Redis) diverged.
    if (ttlSecs && ttlSecs > 0 && typeof this.redis.expire === 'function') {
      await this.redis.expire(key, ttlSecs);
    }
  }
}
