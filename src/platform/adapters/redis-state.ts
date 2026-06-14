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
  /** Set/refresh a key TTL — used by hset to mirror per-hash expiry. */
  expire(key: string, ttlSecs: number): Promise<unknown>;
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

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.redis.lrange(key, start, stop);
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
    const all = await this.redis.hgetall(key);
    const entries = Object.entries(all).slice(0, limit);
    return Object.fromEntries(entries);
  }

  async hincrby(key: string, field: string, increment: number): Promise<void> {
    await this.redis.hincrby(key, field, increment);
  }
}
