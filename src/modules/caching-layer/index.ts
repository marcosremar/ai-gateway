/**
 * Response caching layer — eliminates redundant computations.
 *
 * Fixes: #576-600 (caching & optimization)
 *
 * Usage:
 * ```ts
 * import { createCache, cached, memoize } from './caching-layer';
 *
 * // TTL-based cache
 * const cache = createCache({ ttlMs: 5000 });
 *
 * const result = await cached(cache, 'gpu-status', () => computeGpuStatus());
 *
 * // Memoize expensive function
 * const memoizedFn = memoize(expensiveFunction, { maxSize: 100 });
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('caching');

export interface CacheOptions {
  /** Time-to-live in ms (default: 60_000) */
  ttlMs?: number;
  /** Max number of entries (default: 1000) */
  maxSize?: number;
  /** Called when entry is evicted */
  onEvict?: (key: string, value: unknown) => void;
}

const DEFAULT_OPTIONS: Required<CacheOptions> = {
  ttlMs: 60_000,
  maxSize: 1000,
  onEvict: () => {},
};

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  accessCount: number;
  createdAt: number;
}

/**
 * In-memory cache with TTL and size limits.
 */
export class Cache<K = string, V = unknown> {
  private entries = new Map<K, CacheEntry<V>>();
  private options: Required<CacheOptions>;

  constructor(options: CacheOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Get a cached value — returns null if expired or missing */
  get(key: K): V | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.options.onEvict(key as string, entry.value);
      return null;
    }

    entry.accessCount++;
    return entry.value;
  }

  /** Set a cached value */
  set(key: K, value: V, ttlMs?: number): void {
    // Evict if at capacity
    if (this.entries.size >= this.options.maxSize) {
      this.evictOne();
    }

    this.entries.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.options.ttlMs),
      accessCount: 0,
      createdAt: Date.now(),
    });
  }

  /** Get or compute — caches the result */
  async getOrCompute(key: K, compute: () => Promise<V>, ttlMs?: number): Promise<V> {
    const cached = this.get(key);
    if (cached !== null) return cached;

    const value = await compute();
    this.set(key, value, ttlMs);
    return value;
  }

  /** Check if key exists and is not expired */
  has(key: K): boolean {
    return this.get(key) !== null;
  }

  /** Delete a specific entry */
  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (entry) {
      this.options.onEvict(key as string, entry.value);
    }
    return this.entries.delete(key);
  }

  /** Clear all entries */
  clear(): void {
    this.entries.clear();
  }

  /** Get cache statistics */
  getStats(): { size: number; maxSize: number; hitRate?: number } {
    return {
      size: this.entries.size,
      maxSize: this.options.maxSize,
    };
  }

  /** Evict expired entries */
  evictExpired(): number {
    let count = 0;
    const now = Date.now();

    for (const [key, entry] of this.entries.entries()) {
      if (now > entry.expiresAt) {
        this.options.onEvict(key as string, entry.value);
        this.entries.delete(key);
        count++;
      }
    }

    if (count > 0) {
      log.log({ count }, 'Evicted expired entries');
    }

    return count;
  }

  /** Get all keys */
  keys(): K[] {
    return Array.from(this.entries.keys());
  }

  /** Get number of entries */
  get size(): number {
    return this.entries.size;
  }

  /** Evict least recently used entry */
  private evictOne(): void {
    let oldestKey: K | undefined;
    let oldestTime = Infinity;

    for (const [key, entry] of this.entries.entries()) {
      if (entry.accessCount < oldestTime) {
        oldestTime = entry.accessCount;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      const entry = this.entries.get(oldestKey)!;
      this.options.onEvict(oldestKey as string, entry.value);
      this.entries.delete(oldestKey);
    }
  }
}

/**
 * Create a cache instance.
 */
export function createCache(options?: CacheOptions): Cache<string, unknown> {
  return new Cache(options);
}

/**
 * Execute a function with caching.
 *
 * @example
 * ```ts
 * const result = await cached(cache, 'gpu-status', () => computeGpuStatus());
 * ```
 */
export async function cached<T>(
  cache: Cache<string, T>,
  key: string,
  compute: () => Promise<T>,
  ttlMs?: number,
): Promise<T> {
  return cache.getOrCompute(key as string, compute, ttlMs);
}

/**
 * Memoize a function with caching.
 *
 * @example
 * ```ts
 * const memoizedFn = memoize(expensiveFunction, { maxSize: 100, ttlMs: 30_000 });
 * ```
 */
export function memoize<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult,
  options: CacheOptions = {},
): (...args: TArgs) => TResult {
  const cache = new Cache<string, TResult>(options);

  return (...args: TArgs): TResult => {
    const key = JSON.stringify(args);

    const cached = cache.get(key as string);
    if (cached !== null) return cached;

    const result = fn(...args);
    cache.set(key as string, result);
    return result;
  };
}
