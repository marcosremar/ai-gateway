// ── BabelCast Gateway — Translation LRU Cache ────────────────────────────────
// Meetings have many repeated phrases ("thank you", "can you hear me?").
// Cache avoids redundant LLM calls for identical text+lang pairs.

import { createLogger } from '../../logger';

const log = createLogger('translation-cache');

// ── LRU Cache ───────────────────────────────────────────────────────────────

export class LRUCache<V = { text: string; ts: number }> {
  private cache = new Map<string, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): V | undefined {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key)!;
    // Move to end (mark as most recently used)
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  /** Read without promoting LRU position. Use when the caller may reject
   *  the entry (e.g. TTL check) — avoids polluting MRU end with stale keys. */
  peek(key: string): V | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Delete least recently used (first key in Map)
      const firstKey = this.cache.keys().next().value!;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  get size(): number {
    return this.cache.size;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  entries(): IterableIterator<[string, V]> {
    return this.cache.entries();
  }
}

// ── Translation-specific cache instance ─────────────────────────────────────

const TRANSLATION_CACHE_MAX = 256;
const TRANSLATION_CACHE_TTL_MS = 30 * 60_000; // 30 minutes — meetings last hours

interface CacheEntry {
  text: string;
  ts: number;
}

const translationCache = new LRUCache<CacheEntry>(TRANSLATION_CACHE_MAX);

// Cache hit/miss counters for metrics
let cacheHits = 0;
let cacheMisses = 0;

export function getTranslationCacheStats() {
  return { cacheHits, cacheMisses, cacheSize: translationCache.size };
}

// Periodic sweep: remove expired entries every 5 minutes
let translationCacheSweepTimer: ReturnType<typeof setInterval> | null = null;

export function startTranslationCacheSweep(): void {
  if (translationCacheSweepTimer) return;
  translationCacheSweepTimer = setInterval(() => {
    const now = Date.now();
    let swept = 0;
    for (const [key, entry] of translationCache.entries()) {
      if (now - entry.ts > TRANSLATION_CACHE_TTL_MS) {
        translationCache.delete(key);
        swept++;
      }
    }
    if (swept > 0) log.log(`Swept ${swept} expired translation entries`);
  }, 5 * 60_000);
  // Unref so this timer doesn't keep short-lived processes (CLI, tests) alive.
  // Long-running gateway server unaffected — Node only exits when ALL refs
  // drop, and the HTTP server keeps a ref while listening.
  translationCacheSweepTimer.unref?.();
}

export function stopTranslationCacheSweep(): void {
  if (translationCacheSweepTimer) {
    clearInterval(translationCacheSweepTimer);
    translationCacheSweepTimer = null;
  }
}

// Start sweep on import (same as original)
startTranslationCacheSweep();

export function getCachedTranslation(text: string, srcLang: string, tgtLang: string, style = 'default'): string | null {
  const key = `${srcLang}|${tgtLang}|${style}|${text}`;
  // Peek first so an expired entry doesn't get LRU-promoted ahead of valid
  // ones. Previous code called .get() (which promotes), then checked TTL —
  // expired entries kept getting bumped to MRU end and evicted younger
  // valid entries during long meetings.
  const entry = translationCache.peek(key);
  if (!entry) { cacheMisses++; return null; }
  if (Date.now() - entry.ts > TRANSLATION_CACHE_TTL_MS) {
    translationCache.delete(key);
    cacheMisses++;
    return null;
  }
  // Now that TTL passed, do the real .get() to promote LRU position.
  translationCache.get(key);
  cacheHits++;
  return entry.text;
}

export function setCachedTranslation(text: string, srcLang: string, tgtLang: string, translated: string, style = 'default'): void {
  const key = `${srcLang}|${tgtLang}|${style}|${text}`;
  translationCache.set(key, { text: translated, ts: Date.now() });
}

/** Adaptive maxTokens: short inputs need fewer tokens, saving LLM generation time. */
export function adaptiveMaxTokens(inputText: string): number {
  const len = inputText.length;
  if (len < 20) return 60;
  if (len < 50) return 100;
  if (len < 150) return 150;
  return 200;
}
