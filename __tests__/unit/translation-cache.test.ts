// ── Translation Cache & System Prompt — unit suite ───────────────────────────
// Covers:
//   • LRUCache — get/set/has/peek/delete/clear/size/entries, LRU eviction
//   • getCachedTranslation / setCachedTranslation — hit, miss, TTL expiry
//   • getTranslationCacheStats — hit/miss counters
//   • adaptiveMaxTokens — all four length thresholds
//   • buildSystemPrompt — all styles, unknown style fallback, source/target injection
//   • resolveVoiceForProfile — passthrough

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LRUCache } from '../../src/gateway/pipeline/translation-cache';
import { buildSystemPrompt, TRANSLATION_STYLES, resolveVoiceForProfile } from '../../src/gateway/pipeline/system-prompt';

// ══════════════════════════════════════════════════════════════════════════════
// LRUCache — class-level tests (no module state, instantiated fresh each time)
// ══════════════════════════════════════════════════════════════════════════════

describe('LRUCache', () => {
  type Entry = { text: string; ts: number };

  function makeCache(maxSize = 3): LRUCache<Entry> {
    return new LRUCache<Entry>(maxSize);
  }

  // ── Initial state ─────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('size is 0', () => {
      expect(makeCache().size).toBe(0);
    });

    it('has() returns false for missing key', () => {
      expect(makeCache().has('k')).toBe(false);
    });

    it('get() returns undefined for missing key', () => {
      expect(makeCache().get('k')).toBeUndefined();
    });

    it('peek() returns undefined for missing key', () => {
      expect(makeCache().peek('k')).toBeUndefined();
    });
  });

  // ── set / get / has ───────────────────────────────────────────────────────

  describe('set / get / has', () => {
    it('set then get returns value', () => {
      const c = makeCache();
      c.set('a', { text: 'hello', ts: 1 });
      expect(c.get('a')).toEqual({ text: 'hello', ts: 1 });
    });

    it('has() returns true after set', () => {
      const c = makeCache();
      c.set('a', { text: 'hello', ts: 1 });
      expect(c.has('a')).toBe(true);
    });

    it('size increments on new keys', () => {
      const c = makeCache(10);
      c.set('a', { text: 'a', ts: 1 });
      c.set('b', { text: 'b', ts: 2 });
      expect(c.size).toBe(2);
    });

    it('set on existing key updates value (no size increase)', () => {
      const c = makeCache(10);
      c.set('a', { text: 'old', ts: 1 });
      c.set('a', { text: 'new', ts: 2 });
      expect(c.size).toBe(1);
      expect(c.get('a')?.text).toBe('new');
    });
  });

  // ── peek vs get (LRU promotion) ───────────────────────────────────────────

  describe('peek vs get (LRU promotion)', () => {
    it('peek does not promote to MRU', () => {
      const c = makeCache(3);
      c.set('a', { text: 'a', ts: 1 });
      c.set('b', { text: 'b', ts: 2 });
      c.set('c', { text: 'c', ts: 3 });
      // Peek 'a' — should NOT promote it
      c.peek('a');
      // Insert 'd' — should evict LRU which is still 'a'
      c.set('d', { text: 'd', ts: 4 });
      expect(c.has('a')).toBe(false);
    });

    it('get promotes to MRU, protecting from eviction', () => {
      const c = makeCache(3);
      c.set('a', { text: 'a', ts: 1 });
      c.set('b', { text: 'b', ts: 2 });
      c.set('c', { text: 'c', ts: 3 });
      // Get 'a' — promotes to MRU
      c.get('a');
      // Insert 'd' — should evict LRU which is now 'b'
      c.set('d', { text: 'd', ts: 4 });
      expect(c.has('a')).toBe(true);
      expect(c.has('b')).toBe(false);
    });
  });

  // ── LRU eviction ─────────────────────────────────────────────────────────

  describe('LRU eviction', () => {
    it('evicts the least recently used key when full', () => {
      const c = makeCache(3);
      c.set('a', { text: 'a', ts: 1 });
      c.set('b', { text: 'b', ts: 2 });
      c.set('c', { text: 'c', ts: 3 });
      // 'd' should evict 'a' (oldest)
      c.set('d', { text: 'd', ts: 4 });
      expect(c.has('a')).toBe(false);
      expect(c.has('b')).toBe(true);
      expect(c.has('c')).toBe(true);
      expect(c.has('d')).toBe(true);
    });

    it('size never exceeds maxSize', () => {
      const c = makeCache(2);
      c.set('a', { text: 'a', ts: 1 });
      c.set('b', { text: 'b', ts: 2 });
      c.set('c', { text: 'c', ts: 3 });
      expect(c.size).toBe(2);
    });

    it('re-setting an existing key moves it to MRU, evicts real LRU', () => {
      const c = makeCache(3);
      c.set('a', { text: 'a', ts: 1 });
      c.set('b', { text: 'b', ts: 2 });
      c.set('c', { text: 'c', ts: 3 });
      // Re-insert 'a' — moves to MRU
      c.set('a', { text: 'a-new', ts: 5 });
      // 'd' should now evict 'b' (LRU)
      c.set('d', { text: 'd', ts: 6 });
      expect(c.has('b')).toBe(false);
      expect(c.has('a')).toBe(true);
    });
  });

  // ── delete / clear ────────────────────────────────────────────────────────

  describe('delete / clear', () => {
    it('delete returns true for existing key', () => {
      const c = makeCache();
      c.set('a', { text: 'a', ts: 1 });
      expect(c.delete('a')).toBe(true);
    });

    it('delete returns false for missing key', () => {
      expect(makeCache().delete('nope')).toBe(false);
    });

    it('deleted key is no longer findable', () => {
      const c = makeCache();
      c.set('a', { text: 'a', ts: 1 });
      c.delete('a');
      expect(c.has('a')).toBe(false);
      expect(c.get('a')).toBeUndefined();
    });

    it('size decrements after delete', () => {
      const c = makeCache(10);
      c.set('a', { text: 'a', ts: 1 });
      c.set('b', { text: 'b', ts: 2 });
      c.delete('a');
      expect(c.size).toBe(1);
    });

    it('clear empties the cache', () => {
      const c = makeCache(10);
      c.set('a', { text: 'a', ts: 1 });
      c.set('b', { text: 'b', ts: 2 });
      c.clear();
      expect(c.size).toBe(0);
      expect(c.has('a')).toBe(false);
    });
  });

  // ── entries ───────────────────────────────────────────────────────────────

  describe('entries()', () => {
    it('iterates all key/value pairs', () => {
      const c = makeCache(10);
      c.set('x', { text: 'xv', ts: 1 });
      c.set('y', { text: 'yv', ts: 2 });
      const pairs = [...c.entries()];
      expect(pairs).toHaveLength(2);
      const keys = pairs.map(([k]) => k);
      expect(keys).toContain('x');
      expect(keys).toContain('y');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Module-level translation cache functions
// Uses vi.resetModules() + dynamic import to get clean module state each test.
// ══════════════════════════════════════════════════════════════════════════════

describe('translation-cache module functions', () => {
  let mod: typeof import('../../src/gateway/pipeline/translation-cache');

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    mod = await import('../../src/gateway/pipeline/translation-cache');
  });

  afterEach(() => {
    mod.stopTranslationCacheSweep();
    vi.useRealTimers();
  });

  // ── Initial stats ─────────────────────────────────────────────────────────

  describe('getTranslationCacheStats — initial state', () => {
    it('cacheHits starts at 0', () => {
      expect(mod.getTranslationCacheStats().cacheHits).toBe(0);
    });

    it('cacheMisses starts at 0', () => {
      expect(mod.getTranslationCacheStats().cacheMisses).toBe(0);
    });

    it('cacheSize starts at 0', () => {
      expect(mod.getTranslationCacheStats().cacheSize).toBe(0);
    });
  });

  // ── setCachedTranslation / getCachedTranslation ───────────────────────────

  describe('getCachedTranslation — miss', () => {
    it('returns null for unknown key', () => {
      expect(mod.getCachedTranslation('hello', 'fr', 'en')).toBeNull();
    });

    it('increments cacheMisses on miss', () => {
      mod.getCachedTranslation('hello', 'fr', 'en');
      expect(mod.getTranslationCacheStats().cacheMisses).toBe(1);
    });

    it('does not increment cacheHits on miss', () => {
      mod.getCachedTranslation('hello', 'fr', 'en');
      expect(mod.getTranslationCacheStats().cacheHits).toBe(0);
    });
  });

  describe('getCachedTranslation — hit', () => {
    it('returns cached translation', () => {
      mod.setCachedTranslation('hello', 'fr', 'en', 'bonjour');
      expect(mod.getCachedTranslation('hello', 'fr', 'en')).toBe('bonjour');
    });

    it('increments cacheHits on hit', () => {
      mod.setCachedTranslation('hello', 'fr', 'en', 'bonjour');
      mod.getCachedTranslation('hello', 'fr', 'en');
      expect(mod.getTranslationCacheStats().cacheHits).toBe(1);
    });

    it('does not increment cacheMisses on hit', () => {
      mod.setCachedTranslation('hello', 'fr', 'en', 'bonjour');
      mod.getCachedTranslation('hello', 'fr', 'en');
      expect(mod.getTranslationCacheStats().cacheMisses).toBe(0);
    });
  });

  describe('getCachedTranslation — key composition', () => {
    it('different srcLang produces cache miss', () => {
      mod.setCachedTranslation('hello', 'fr', 'en', 'bonjour');
      expect(mod.getCachedTranslation('hello', 'de', 'en')).toBeNull();
    });

    it('different tgtLang produces cache miss', () => {
      mod.setCachedTranslation('hello', 'fr', 'en', 'bonjour');
      expect(mod.getCachedTranslation('hello', 'fr', 'es')).toBeNull();
    });

    it('different style produces cache miss', () => {
      mod.setCachedTranslation('hello', 'fr', 'en', 'bonjour', 'default');
      expect(mod.getCachedTranslation('hello', 'fr', 'en', 'academic')).toBeNull();
    });

    it('same key with default style matches explicit default', () => {
      mod.setCachedTranslation('hello', 'fr', 'en', 'bonjour');
      expect(mod.getCachedTranslation('hello', 'fr', 'en', 'default')).toBe('bonjour');
    });
  });

  describe('getCachedTranslation — TTL expiry', () => {
    it('returns null after TTL expires (30 minutes)', () => {
      mod.setCachedTranslation('hello', 'fr', 'en', 'bonjour');
      // Advance past 30-minute TTL
      vi.advanceTimersByTime(30 * 60 * 1000 + 1);
      expect(mod.getCachedTranslation('hello', 'fr', 'en')).toBeNull();
    });

    it('increments cacheMisses when TTL-expired entry is accessed', () => {
      mod.setCachedTranslation('hello', 'fr', 'en', 'bonjour');
      vi.advanceTimersByTime(30 * 60 * 1000 + 1);
      mod.getCachedTranslation('hello', 'fr', 'en');
      expect(mod.getTranslationCacheStats().cacheMisses).toBe(1);
    });

    it('returns hit for entry just within TTL', () => {
      mod.setCachedTranslation('hello', 'fr', 'en', 'bonjour');
      vi.advanceTimersByTime(30 * 60 * 1000 - 1);
      expect(mod.getCachedTranslation('hello', 'fr', 'en')).toBe('bonjour');
    });
  });

  describe('setCachedTranslation — size tracking', () => {
    it('cacheSize increments after set', () => {
      mod.setCachedTranslation('a', 'fr', 'en', 'alpha');
      expect(mod.getTranslationCacheStats().cacheSize).toBe(1);
    });

    it('same key overwrites without growing size', () => {
      mod.setCachedTranslation('a', 'fr', 'en', 'first');
      mod.setCachedTranslation('a', 'fr', 'en', 'second');
      expect(mod.getTranslationCacheStats().cacheSize).toBe(1);
    });

    it('multiple distinct keys grow size', () => {
      mod.setCachedTranslation('a', 'fr', 'en', 'alpha');
      mod.setCachedTranslation('b', 'fr', 'en', 'beta');
      expect(mod.getTranslationCacheStats().cacheSize).toBe(2);
    });
  });

  describe('hit/miss counter accumulation', () => {
    it('accumulates hits and misses across calls', () => {
      mod.setCachedTranslation('x', 'fr', 'en', 'ex');
      mod.getCachedTranslation('x', 'fr', 'en'); // hit
      mod.getCachedTranslation('y', 'fr', 'en'); // miss
      mod.getCachedTranslation('z', 'fr', 'en'); // miss
      const stats = mod.getTranslationCacheStats();
      expect(stats.cacheHits).toBe(1);
      expect(stats.cacheMisses).toBe(2);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// adaptiveMaxTokens
// ══════════════════════════════════════════════════════════════════════════════

describe('adaptiveMaxTokens', () => {
  let adaptiveMaxTokens: (text: string) => number;

  beforeEach(async () => {
    vi.resetModules();
    const m = await import('../../src/gateway/pipeline/translation-cache');
    adaptiveMaxTokens = m.adaptiveMaxTokens;
  });

  it('returns 60 for very short text (< 20 chars)', () => {
    expect(adaptiveMaxTokens('hi')).toBe(60);
    expect(adaptiveMaxTokens('a'.repeat(19))).toBe(60);
  });

  it('returns 100 for short text (20–49 chars)', () => {
    expect(adaptiveMaxTokens('a'.repeat(20))).toBe(100);
    expect(adaptiveMaxTokens('a'.repeat(49))).toBe(100);
  });

  it('returns 150 for medium text (50–149 chars)', () => {
    expect(adaptiveMaxTokens('a'.repeat(50))).toBe(150);
    expect(adaptiveMaxTokens('a'.repeat(149))).toBe(150);
  });

  it('returns 200 for long text (>= 150 chars)', () => {
    expect(adaptiveMaxTokens('a'.repeat(150))).toBe(200);
    expect(adaptiveMaxTokens('a'.repeat(500))).toBe(200);
  });

  it('boundary: length 19 → 60, length 20 → 100', () => {
    expect(adaptiveMaxTokens('a'.repeat(19))).toBe(60);
    expect(adaptiveMaxTokens('a'.repeat(20))).toBe(100);
  });

  it('boundary: length 49 → 100, length 50 → 150', () => {
    expect(adaptiveMaxTokens('a'.repeat(49))).toBe(100);
    expect(adaptiveMaxTokens('a'.repeat(50))).toBe(150);
  });

  it('boundary: length 149 → 150, length 150 → 200', () => {
    expect(adaptiveMaxTokens('a'.repeat(149))).toBe(150);
    expect(adaptiveMaxTokens('a'.repeat(150))).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// buildSystemPrompt / resolveVoiceForProfile (system-prompt.ts)
// ══════════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt', () => {
  it('includes source and target language', () => {
    const p = buildSystemPrompt('French', 'English');
    expect(p).toContain('French');
    expect(p).toContain('English');
    expect(p).toContain('Translate from French to English');
  });

  it('default style uses default prompt template', () => {
    const p = buildSystemPrompt('French', 'English');
    expect(p).toContain(TRANSLATION_STYLES.default);
  });

  it('explicit default style matches omitted style', () => {
    expect(buildSystemPrompt('fr', 'en', 'default')).toBe(buildSystemPrompt('fr', 'en'));
  });

  it('academic style uses academic prompt template', () => {
    const p = buildSystemPrompt('German', 'English', 'academic');
    expect(p).toContain(TRANSLATION_STYLES.academic);
    expect(p).toContain('Translate from German to English');
  });

  it('casual style uses casual prompt template', () => {
    const p = buildSystemPrompt('Spanish', 'English', 'casual');
    expect(p).toContain(TRANSLATION_STYLES.casual);
  });

  it('news style uses news prompt template', () => {
    const p = buildSystemPrompt('Italian', 'English', 'news');
    expect(p).toContain(TRANSLATION_STYLES.news);
  });

  it('unknown style falls back to default template', () => {
    const p = buildSystemPrompt('zh', 'en', 'pirate');
    expect(p).toContain(TRANSLATION_STYLES.default);
    expect(p).toContain('Translate from zh to en');
  });

  it('result starts with the style prompt followed by the language line', () => {
    const p = buildSystemPrompt('French', 'English', 'casual');
    const [stylePart, langPart] = p.split('\n');
    expect(stylePart).toBe(TRANSLATION_STYLES.casual);
    expect(langPart).toBe('Translate from French to English.');
  });
});

describe('resolveVoiceForProfile', () => {
  it('returns speaker unchanged (passthrough)', () => {
    expect(resolveVoiceForProfile('Ryan', false)).toBe('Ryan');
    expect(resolveVoiceForProfile('Vivian', true)).toBe('Vivian');
  });

  it('handles empty string without throwing', () => {
    expect(() => resolveVoiceForProfile('', false)).not.toThrow();
  });
});
