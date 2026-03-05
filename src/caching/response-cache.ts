/**
 * ResponseCache — cache AI provider responses with TTL, keyed by request hash.
 * Uses StateStore (KvStore) for storage.
 */

import { createHash } from 'crypto';
import type { KvStore } from '../deps';
import type { CacheConfig, CacheStats } from './types';

export class ResponseCache {
  private store: KvStore;
  private defaultTtlMs: number;
  private prefix: string;
  private _hits = 0;
  private _misses = 0;

  constructor(store: KvStore, opts?: CacheConfig) {
    this.store = store;
    this.defaultTtlMs = opts?.defaultTtlMs ?? 300_000;
    this.prefix = opts?.prefix ?? 'cache:';
  }

  /** Build a deterministic cache key from request params */
  buildKey(params: { provider: string; model: string; messages?: unknown[]; input?: unknown; temperature?: number }): string {
    const hash = createHash('sha256')
      .update(JSON.stringify({
        p: params.provider,
        m: params.model,
        msgs: params.messages,
        inp: params.input,
        t: params.temperature,
      }))
      .digest('hex');
    return `${this.prefix}${hash}`;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.store.get(key);
    if (!raw) {
      this._misses++;
      return null;
    }
    this._hits++;
    try {
      const envelope = JSON.parse(raw) as { data: T; expiresAt: number };
      if (envelope.expiresAt && Date.now() > envelope.expiresAt) {
        await this.store.del(key);
        this._misses++;
        this._hits--; // undo the hit count
        return null;
      }
      return envelope.data;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const ttl = ttlMs ?? this.defaultTtlMs;
    const envelope = {
      data: value,
      expiresAt: Date.now() + ttl,
    };
    // ttlSecs for KvStore (Redis TTL is in seconds)
    const ttlSecs = Math.ceil(ttl / 1000);
    await this.store.set(key, JSON.stringify(envelope), ttlSecs);
  }

  async invalidate(pattern: string): Promise<void> {
    const keys = await this.store.scan(`${this.prefix}${pattern}`);
    await Promise.all(keys.map((k) => this.store.del(k)));
  }

  stats(): CacheStats {
    return { hits: this._hits, misses: this._misses };
  }
}
