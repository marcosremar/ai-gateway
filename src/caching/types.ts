/**
 * Caching types.
 */

export interface CacheConfig {
  defaultTtlMs?: number; // default 300_000 (5 min)
  prefix?: string;       // key prefix, default 'cache:'
  /** Enable semantic caching (requires embedding provider) */
  semantic?: boolean;
  /** Similarity threshold for semantic cache (0-1) */
  similarityThreshold?: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** Hit rate as percentage */
  hitRate: number;
  /** Total requests processed */
  total: number;
}

/**
 * Per-request cache options (similar to cf-aig-cache headers)
 */
export interface CacheRequestOptions {
  /** Override global cache enabled setting */
  enabled?: boolean;
  /** Custom TTL in seconds for this request */
  ttl?: number;
  /** Custom cache key override */
  cacheKey?: string;
  /** Store payload in logs (default: true) */
  storePayload?: boolean;
}

/**
 * Cache entry metadata for debugging/audit
 */
export interface CacheMetadata {
  cachedAt: number;
  expiresAt: number;
  provider: string;
  model: string;
  size?: number; // response size in bytes
}
