/**
 * Caching types.
 */

export interface CacheConfig {
  defaultTtlMs?: number; // default 300_000 (5 min)
  prefix?: string;       // key prefix, default 'cache:'
}

export interface CacheStats {
  hits: number;
  misses: number;
}
