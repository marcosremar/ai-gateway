# ADR-002: LRU Translation Cache

**Status:** Accepted
**Date:** 2024-02-20
**Deciders:** Marcos

## Context

Meetings and conversations contain many repeated phrases ("thank you", "can you hear me?", "let me share my screen"). Making LLM calls for identical text+language pairs wastes cost and adds latency.

## Decision

Implement an **LRU cache** for translation requests with the following parameters:

```typescript
// From src/providers/translation-cache.ts
const MAX_CACHE_ENTRIES = 256;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
```

**Cache key format:** `${srcLang}|${tgtLang}|${style}|${text}`

## Reasoning

### Why LRU over other eviction policies?
- **SLRU (Segmented LRU)** would be ideal but adds complexity
- **LFU** is expensive to maintain accurately
- **Random** doesn't respect recency
- LRU is simple, O(1) with `Map`, and naturally handles the meeting use case where recent phrases are more likely to repeat

### Why 256 entries?
- Fits comfortably in memory for a single meeting session
- Large enough for a 2-hour meeting with varied vocabulary
- Small enough to avoid memory bloat

### Why 30-minute TTL?
- Meetings typically last hours
- 30 minutes captures "active conversation" window
- Prevents stale translations from persisting across meetings

### Why text + language + style as key?
- Same text in different contexts may need different translation
- Style affects tone (formal vs informal)
- Enables precise matching without false positives

## Additional Feature: Speculative Cache

The cache also handles **speculative translations** — translating partial ASR text *before* the final transcript arrives:

```typescript
// SpeculativeCache uses Levenshtein distance to match partial text
// against previously cached full sentences
```

This reduces perceived latency by ~100-200ms when the user is mid-sentence.

## Alternatives Considered

### No cache
- Simple but wastes LLM calls and money
- Repeated phrases would cost 100% more

### Distributed cache (Redis)
- Overkill for single-instance deployments
- Adds network hop and failure modes
- File-based persistence in `~/.babelcast/` is sufficient

## Consequences

- **Positive:** ~30-50% cost reduction for meetings with repeated phrases
- **Positive:** ~100-200ms latency reduction for cached translations
- **Negative:** Memory overhead (minimal with 256 entries)
- **Negative:** Cache misses on style changes or context shifts

## Monitoring

Cache exposes metrics:
- `translation_cache_hits_total`
- `translation_cache_misses_total`

## Notes

- Cache is in-memory only (not persisted) — intentional for simplicity
- Periodic sweep every 5 minutes removes expired entries
- Thread-safe via mutex for concurrent access
