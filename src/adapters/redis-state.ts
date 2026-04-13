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

  async scan(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
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

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.redis.hset(key, field, value);
  }

  async hdel(key: string, field: string): Promise<void> {
    await this.redis.hdel(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.redis.hgetall(key);
  }

  async hincrby(key: string, field: string, increment: number): Promise<void> {
    await this.redis.hincrby(key, field, increment);
  }
}
