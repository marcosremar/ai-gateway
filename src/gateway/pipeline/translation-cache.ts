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

/**
 * Build the cache key (#31). The base key is `src|tgt|style|text`; an optional
 * `paramsKey` (e.g. a temperature/maxTokens bucket) is appended so that two
 * routes generating with DIFFERENT generation params don't share an entry — a
 * truncated translation from a low-maxTokens route would otherwise be served to
 * a request expecting full output. Omit `paramsKey` when the route is
 * deterministic (temp=0, fixed maxTokens) to keep the cache shared.
 */
export function buildTranslationCacheKey(text: string, srcLang: string, tgtLang: string, style = 'default', paramsKey?: string): string {
  const base = `${srcLang}|${tgtLang}|${style}|${text}`;
  return paramsKey ? `${base}|${paramsKey}` : base;
}

export function getCachedTranslation(text: string, srcLang: string, tgtLang: string, style = 'default', paramsKey?: string): string | null {
  const key = buildTranslationCacheKey(text, srcLang, tgtLang, style, paramsKey);
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

export function setCachedTranslation(text: string, srcLang: string, tgtLang: string, translated: string, style = 'default', paramsKey?: string): void {
  const key = buildTranslationCacheKey(text, srcLang, tgtLang, style, paramsKey);
  // Prefer the longer translation for the same key (#32). If a truncated /
  // incomplete translation (e.g. maxTokens too low) landed first, it would
  // otherwise be cached for the full TTL and served to later requests; keep
  // whichever is longer (and refresh ts so it survives the sweep).
  const existing = translationCache.peek(key);
  if (existing && Date.now() - existing.ts <= TRANSLATION_CACHE_TTL_MS && existing.text.length >= translated.length) {
    // Existing is at least as complete and still fresh — promote it, keep it.
    translationCache.get(key);
    return;
  }
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
