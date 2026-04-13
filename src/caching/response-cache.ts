/**
 * ResponseCache — cache AI provider responses with TTL, keyed by request hash.
 * Uses StateStore (KvStore) for storage.
 * 
 * Supports per-request cache options (similar to Cloudflare cf-aig-cache headers):
 *   - enabled: override global cache setting
 *   - ttl: custom TTL for this specific request
 *   - cacheKey: custom cache key override
 */

import { createHash } from 'crypto';
import type { KvStore } from '../deps';
import type { CacheConfig, CacheStats, CacheRequestOptions, CacheMetadata } from './types';

export class ResponseCache {
  private store: KvStore;
  private defaultTtlMs: number;
  private prefix: string;
  private semanticEnabled: boolean;
  private similarityThreshold: number;
  private _hits = 0;
  private _misses = 0;
  private _total = 0;
  private _size = 0;
  private _evictions = 0;
  private maxSize: number;
  private accessOrder: string[] = [];

  constructor(store: KvStore, opts?: CacheConfig) {
    this.store = store;
    this.defaultTtlMs = opts?.defaultTtlMs ?? 300_000;
    this.prefix = opts?.prefix ?? 'cache:';
    this.semanticEnabled = opts?.semantic ?? false;
    this.similarityThreshold = opts?.similarityThreshold ?? 0.9;
    this.maxSize = opts?.maxSize ?? 10000;
    this._evictions = 0;
  }

  /** Build a deterministic cache key from request params */
  buildKey(params: { provider: string; model: string; messages?: unknown[]; input?: unknown; temperature?: number; dimensions?: number }): string {
    let serialized: string;
    try {
      // Sort keys for deterministic hashing (prevents cache splits from key reordering)
      serialized = JSON.stringify({
        p: params.provider,
        m: params.model,
        msgs: params.messages,
        inp: params.input,
        t: params.temperature,
        d: params.dimensions,
      });
    } catch {
      // Non-serializable input (circular refs, etc.) — use provider+model only
      serialized = `${params.provider}:${params.model}:fallback`;
    }
    const hash = createHash('sha256').update(serialized).digest('hex');
    return `${this.prefix}${hash}`;
  }

  /** Build custom key from explicit string (for override) */
  buildCustomKey(key: string): string {
    return `${this.prefix}custom:${createHash('sha256').update(key).digest('hex')}`;
  }

  /**
   * Get cached value with optional per-request options.
   * Similar to Cloudflare's cf-aig-cache header behavior.
   */
  async get<T>(key: string, options?: CacheRequestOptions): Promise<T | null> {
    this._total++;
    
    // Check if cache is disabled for this specific request
    if (options?.enabled === false) {
      this._misses++;
      return null;
    }

    const raw = await this.store.get(key);
    if (!raw) {
      this._misses++;
      return null;
    }
    this._hits++;
    try {
      const envelope = JSON.parse(raw) as { data: T; metadata: CacheMetadata };
      if (envelope.metadata.expiresAt && Date.now() > envelope.metadata.expiresAt) {
        await this.store.del(key);
        this._misses++;
        this._hits--;
        this._removeFromAccessOrder(key);
        return null;
      }

      const idx = this.accessOrder.indexOf(key);
      if (idx !== -1) {
        this.accessOrder.splice(idx, 1);
      }
      this.accessOrder.push(key);

      return envelope.data;
    } catch {
      return null;
    }
  }

  /**
   * Set cached value with optional per-request TTL override.
   * Similar to Cloudflare's cf-aig-cache-ttl header.
   */
  async set<T>(key: string, value: T, ttlMs?: number, metadata?: Partial<CacheMetadata>): Promise<void> {
    if (this._size >= this.maxSize && !this.accessOrder.includes(key)) {
      while (this.accessOrder.length > 0 && this._size >= this.maxSize) {
        const oldestKey = this.accessOrder.shift();
        if (oldestKey) {
          await this.store.del(oldestKey);
          this._size--;
          this._evictions++;
        }
      }
    }

    this.accessOrder.push(key);
    this._size++;

    const ttl = ttlMs ?? this.defaultTtlMs;
    const now = Date.now();
    const envelope = {
      data: value,
      metadata: {
        cachedAt: now,
        expiresAt: now + ttl,
        ...metadata,
      },
    };
    const ttlSecs = Math.ceil(ttl / 1000);
    await this.store.set(key, JSON.stringify(envelope), ttlSecs);
  }

  private _removeFromAccessOrder(key: string): void {
    const idx = this.accessOrder.indexOf(key);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
      this._size--;
    }
  }

  /**
   * Invalidate a specific key
   */
  async invalidateKey(key: string): Promise<void> {
    await this.store.del(key);
    this._removeFromAccessOrder(key);
  }

  /**
   * Check if semantic caching is enabled
   */
  isSemanticEnabled(): boolean {
    return this.semanticEnabled;
  }

  /**
   * Get similarity threshold for semantic matching
   */
  getSimilarityThreshold(): number {
    return this.similarityThreshold;
  }

  async invalidate(pattern: string): Promise<number> {
    let count = 0;
    await this.store.scan(`${this.prefix}${pattern}`, async (keys) => {
      await Promise.all(keys.map((k) => this.store.del(k)));
      count += keys.length;
      return true;
    });
    return count;
  }

  /**
   * Invalidate all cache entries for a specific provider
   * @returns Number of keys invalidated
   */
  async invalidateProvider(provider: string): Promise<number> {
    return this.invalidate(`p:${provider}*`);
  }

  /**
   * Invalidate all cache entries for a specific model
   * @returns Number of keys invalidated
   */
  async invalidateModel(provider: string, model: string): Promise<number> {
    return this.invalidate(`p:${provider}:m:${model}*`);
  }

  stats(): CacheStats {
    const total = this._hits + this._misses;
    return { 
      hits: this._hits, 
      misses: this._misses,
      hitRate: total > 0 ? (this._hits / total) * 100 : 0,
      total,
      size: this._size,
      evictions: this._evictions,
    };
  }

  /** Reset stats */
  resetStats(): void {
    this._hits = 0;
    this._misses = 0;
    this._total = 0;
    this._evictions = 0;
  }
}
