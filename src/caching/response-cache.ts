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
  /**
   * Per-key metadata index — maps the hashed cache key back to the
   * (provider, model) it was built from. Populated by buildKey() so that
   * invalidateProvider/invalidateModel can resolve which hashed keys to
   * delete (the SHA256 hash itself carries no decodable provider/model
   * information). Cleaned up when the entry is removed from accessOrder.
   */
  private _keyMeta: Map<string, { provider: string; model: string }> = new Map();

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
    const key = `${this.prefix}${hash}`;
    // Record provider/model so invalidateProvider/invalidateModel can find this key.
    // Bounded by maxSize — prune oldest entries when index outgrows the store cap.
    if (params.provider) {
      this._keyMeta.set(key, { provider: params.provider, model: params.model ?? '' });
      if (this._keyMeta.size > this.maxSize) {
        const oldest = this._keyMeta.keys().next().value;
        if (oldest) this._keyMeta.delete(oldest);
      }
    }
    return key;
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
    // Only count this as a hit after we've successfully decoded and TTL-checked
    // the envelope. The previous code incremented _hits up front and tried to
    // roll it back, but the JSON.parse catch path skipped the rollback and a
    // corrupted entry permanently inflated the hit ratio.
    try {
      const envelope = JSON.parse(raw) as { data: T; metadata: CacheMetadata };
      if (envelope.metadata.expiresAt && Date.now() > envelope.metadata.expiresAt) {
        await this.store.del(key);
        this._misses++;
        // Drop both index structures so a subsequent invalidateProvider/Model
        // doesn't see stale meta and so _size doesn't drift on long-running
        // processes (TTL-expired entries that were never re-set would leak).
        this._removeFromAccessOrder(key);
        this._keyMeta.delete(key);
        return null;
      }

      const idx = this.accessOrder.indexOf(key);
      if (idx !== -1) {
        this.accessOrder.splice(idx, 1);
      }
      this.accessOrder.push(key);

      this._hits++;
      return envelope.data;
    } catch {
      this._misses++;
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
          this._keyMeta.delete(oldestKey);
          this._size--;
          this._evictions++;
        }
      }
    }

    // Remove old position if this is an overwrite (prevents _size double-counting)
    const existingIdx = this.accessOrder.indexOf(key);
    if (existingIdx !== -1) {
      this.accessOrder.splice(existingIdx, 1);
    } else {
      this._size++;
    }
    this.accessOrder.push(key);

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
      // Guard against underflow: _size is the number of entries in accessOrder
      // (single source of truth). When called against a key that's already
      // gone (e.g. evicted by Redis TTL externally) this branch is skipped,
      // but if internal logic ever drifts, never go negative.
      if (this._size > 0) this._size--;
    }
  }

  /**
   * Invalidate a specific key
   */
  async invalidateKey(key: string): Promise<void> {
    await this.store.del(key);
    this._removeFromAccessOrder(key);
    this._keyMeta.delete(key);
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
    const keys: string[] = [];
    await this.store.scan(`${this.prefix}${pattern}`, (k) => { keys.push(...k); });
    if (keys.length > 0) {
      await Promise.all(keys.map((k) => this.store.del(k)));
      // Update in-memory tracking to stay consistent with the store
      for (const k of keys) {
        this._removeFromAccessOrder(k);
        this._keyMeta.delete(k);
      }
      count = keys.length;
    }
    return count;
  }

  /**
   * Invalidate all cache entries for a specific provider.
   * Uses the in-memory metadata index built by buildKey() — cache keys
   * are SHA256 hashes that don't encode provider name, so a store-side
   * scan pattern can never match them.
   * @returns Number of keys invalidated
   */
  async invalidateProvider(provider: string): Promise<number> {
    const matched: string[] = [];
    for (const [key, meta] of this._keyMeta) {
      if (meta.provider === provider) matched.push(key);
    }
    if (matched.length === 0) return 0;
    await Promise.all(matched.map((k) => this.store.del(k)));
    for (const k of matched) {
      this._removeFromAccessOrder(k);
      this._keyMeta.delete(k);
    }
    return matched.length;
  }

  /**
   * Invalidate all cache entries for a specific model.
   * @returns Number of keys invalidated
   */
  async invalidateModel(provider: string, model: string): Promise<number> {
    const matched: string[] = [];
    for (const [key, meta] of this._keyMeta) {
      if (meta.provider === provider && meta.model === model) matched.push(key);
    }
    if (matched.length === 0) return 0;
    await Promise.all(matched.map((k) => this.store.del(k)));
    for (const k of matched) {
      this._removeFromAccessOrder(k);
      this._keyMeta.delete(k);
    }
    return matched.length;
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
