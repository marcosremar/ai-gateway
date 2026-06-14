// ── BabelCast Gateway — Speculative Translation Cache ─────────────────────────
// Starts translating partial ASR text BEFORE the final transcript arrives.
// If the final ASR result is similar enough to the speculated partial,
// the cached translation is reused — saving the full LLM round-trip latency.

import { createLogger } from '../../logger';

const log = createLogger('speculative-cache');

const MAX_SPECULATIONS = 20;
const EXPIRY_MS = 10_000; // auto-expire after 10s

// ── Levenshtein edit distance ────────────────────────────────────────────────

function editDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  // Use single-row DP to save memory
  let prev = new Uint16Array(lb + 1);
  let curr = new Uint16Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

// ── Types ────────────────────────────────────────────────────────────────────

interface SpeculationEntry {
  partialText: string;
  normalizedPartial: string;
  translationPromise: Promise<string>;
  translatedText?: string;
  startedAt: number;
  resolved: boolean;
}

// ── SpeculativeCache ─────────────────────────────────────────────────────────

export class SpeculativeCache {
  private pending = new Map<string, SpeculationEntry>();
  // #36 — optional per-session ring of recent speculations. With the default
  // ring size of 1 the cache keeps ONLY the latest partial per session
  // (identical to the original overwrite behaviour). When `setRingSize(n>1)` is
  // used, the last `n` partials per session are retained so a final transcript
  // that matches an EARLIER partial (rapid 200ms partials overwrite faster than
  // the final arrives) can still hit instead of being discarded. Only populated
  // when the ring is enabled, so the default path allocates nothing extra.
  private rings = new Map<string, SpeculationEntry[]>();
  private _ringSize = 1;
  private _total = 0;
  private _hits = 0;
  private _misses = 0;
  // Speculative spend tracking (#37): every speculate() launches a background
  // LLM call that is wasted when the speculation isn't reused or fails. Without
  // these counters operators can't tell whether speculation saves more than it
  // costs.
  private _speculations = 0;       // total background translations launched
  private _speculationsFailed = 0; // background translations that errored/emptied
  private _speculationsWasted = 0; // launched but never turned into a hit

  /** Normalize text for similarity comparison. */
  private normalize(text: string): string {
    return text.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  /**
   * Set how many recent partials to retain per session (#36). 1 (default) =
   * legacy overwrite behaviour. n>1 keeps a small ring so the final transcript
   * can match an earlier partial that a later partial would have overwritten.
   * Shrinking the ring does not retroactively trim existing rings.
   */
  setRingSize(n: number): void {
    this._ringSize = Math.max(1, Math.floor(n) || 1);
  }

  /**
   * Start a speculative translation for a partial ASR result.
   * The translateFn should use the same LLM routing as the normal pipeline.
   */
  speculate(sessionId: string, partialText: string, translateFn: (text: string) => Promise<string>): void {
    const trimmed = partialText.trim();
    if (!trimmed) return;

    // Evict expired entries first
    this.evictExpired();

    // If we already have a speculation for this session with the same text, skip.
    // With a ring, "already have" means any retained partial matches (#36).
    const existing = this.pending.get(sessionId);
    if (existing && existing.partialText === trimmed) return;
    if (this._ringSize > 1) {
      const ring = this.rings.get(sessionId);
      if (ring && ring.some(e => e.partialText === trimmed)) return;
    }

    // LRU eviction: remove oldest if at capacity AND this is a new session
    // (overwriting an existing session does not increase size, so no eviction needed)
    if (!this.pending.has(sessionId) && this.pending.size >= MAX_SPECULATIONS) {
      const oldestKey = this.pending.keys().next().value;
      if (oldestKey) {
        this.pending.delete(oldestKey);
        log.log(`Evicted oldest entry (sessionId=${oldestKey})`);
      }
    }

    this._speculations++; // #37 — count the wasted-unless-reused background call
    const entry: SpeculationEntry = {
      partialText: trimmed,
      normalizedPartial: this.normalize(trimmed),
      translationPromise: translateFn(trimmed).then(result => {
        entry.translatedText = result;
        entry.resolved = true;
        if (!result) this._speculationsFailed++; // empty result is effectively wasted
        return result;
      }).catch(err => {
        log.warn(`Background translation failed: ${err instanceof Error ? err.message : err}`);
        entry.resolved = true;
        this._speculationsFailed++; // #37
        return '';
      }),
      startedAt: Date.now(),
      resolved: false,
    };

    this.pending.set(sessionId, entry);
    // #36 — when the ring is enabled, retain the last N partials per session so
    // the final can match an earlier one a later partial would have overwritten.
    if (this._ringSize > 1) {
      const ring = this.rings.get(sessionId) ?? [];
      ring.push(entry);
      while (ring.length > this._ringSize) ring.shift();
      this.rings.set(sessionId, ring);
    }
    log.log(`Started for session=${sessionId} partial="${trimmed.slice(0, 60)}"`);
  }

  /**
   * Check if a usable speculation exists for the final ASR text.
   * Returns the cached translation if similar enough, null otherwise.
   *
   * Similarity algorithm:
   * 1. finalText.startsWith(partial) -> match (prefix match)
   * 2. finalText.includes(partial) AND length ratio >= minConfidence -> match
   * 3. Levenshtein ratio >= minConfidence -> match
   */
  async resolve(sessionId: string, finalText: string, minConfidence: number): Promise<string | null> {
    this._total++;

    const normalizedFinal = this.normalize(finalText);
    const entry = this.selectEntry(sessionId, normalizedFinal, minConfidence);

    if (!entry) {
      this._misses++;
      return null;
    }

    // Clean up this session's speculations regardless of outcome.
    this.pending.delete(sessionId);
    this.rings.delete(sessionId);

    const normalizedPartial = entry.normalizedPartial;

    // Skip if partial is empty or too short to be meaningful
    if (normalizedPartial.length < 3) {
      this._misses++;
      this._speculationsWasted++; // #37 — the background call won't be reused
      log.log(`MISS — partial too short (${normalizedPartial.length} chars) session=${sessionId}`);
      return null;
    }

    // Check similarity
    const isSimilar = this.checkSimilarity(normalizedPartial, normalizedFinal, minConfidence);

    if (!isSimilar) {
      this._misses++;
      this._speculationsWasted++; // #37 — speculated text didn't match the final
      log.log(`MISS — partial="${entry.partialText.slice(0, 40)}" final="${finalText.slice(0, 40)}" session=${sessionId}`);
      return null;
    }

    // Wait for the translation to complete (it may already be done)
    const t0 = Date.now();
    try {
      const translation = await entry.translationPromise;
      if (!translation) {
        this._misses++;
        log.log(`MISS — translation was empty session=${sessionId}`);
        return null;
      }

      const savedMs = Date.now() - t0;
      const totalMs = Date.now() - entry.startedAt;
      this._hits++;
      log.log(`HIT — saved ${savedMs}ms (speculation ran ${totalMs}ms) session=${sessionId} partial="${entry.partialText.slice(0, 40)}" final="${finalText.slice(0, 40)}"`);
      return translation;
    } catch {
      this._misses++;
      return null;
    }
  }

  /**
   * Pick the speculation entry to resolve against the final (#36). Default
   * (ring size 1): the single latest `pending` entry — byte-for-byte the legacy
   * behaviour. With a ring: prefer the newest retained partial that is actually
   * similar to the final, so an earlier partial a later one would have
   * overwritten can still hit. If none match, fall back to the newest entry so
   * the downstream miss-accounting (too-short / not-similar) is unchanged.
   */
  private selectEntry(sessionId: string, normalizedFinal: string, minConfidence: number): SpeculationEntry | undefined {
    if (this._ringSize > 1) {
      const ring = this.rings.get(sessionId);
      if (ring && ring.length > 0) {
        for (let i = ring.length - 1; i >= 0; i--) {
          const e = ring[i];
          if (e.normalizedPartial.length >= 3 &&
              this.checkSimilarity(e.normalizedPartial, normalizedFinal, minConfidence)) {
            return e;
          }
        }
        return ring[ring.length - 1]; // newest; downstream reports the miss reason
      }
    }
    return this.pending.get(sessionId);
  }

  /** Check if partial and final texts are similar enough. */
  private checkSimilarity(normalizedPartial: string, normalizedFinal: string, minConfidence: number): boolean {
    // 1. Exact prefix match — high confidence
    if (normalizedFinal.startsWith(normalizedPartial)) {
      return true;
    }

    // 2. Containment + length ratio
    const lengthRatio = normalizedPartial.length / normalizedFinal.length;
    if (normalizedFinal.includes(normalizedPartial) && lengthRatio >= minConfidence) {
      return true;
    }

    // 3. Levenshtein-based similarity ratio
    const maxLen = Math.max(normalizedPartial.length, normalizedFinal.length);
    if (maxLen === 0) return false;

    // Early-exit before the O(la*lb) DP (#35): the edit distance is at least the
    // absolute length difference, so similarity = 1 - dist/maxLen is at most
    // 1 - |la-lb|/maxLen. If that ceiling is already below minConfidence the DP
    // cannot possibly pass — skip it. This is the common case for a partial that
    // is far shorter than the final.
    const lenDiff = Math.abs(normalizedPartial.length - normalizedFinal.length);
    if (1 - lenDiff / maxLen < minConfidence) {
      return false;
    }

    const dist = editDistance(normalizedPartial, normalizedFinal);
    const similarity = 1 - (dist / maxLen);
    if (similarity >= minConfidence) {
      return true;
    }

    return false;
  }

  /** Clear all speculations for a session. */
  clear(sessionId: string): void {
    this.pending.delete(sessionId);
    this.rings.delete(sessionId); // #36
  }

  /** Remove expired entries. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.pending) {
      if (now - entry.startedAt > EXPIRY_MS) {
        this.pending.delete(key);
      }
    }
    // #36 — expire ring entries too; drop the session's ring once all stale.
    if (this._ringSize > 1) {
      for (const [key, ring] of this.rings) {
        const live = ring.filter(e => now - e.startedAt <= EXPIRY_MS);
        if (live.length === 0) this.rings.delete(key);
        else if (live.length !== ring.length) this.rings.set(key, live);
      }
    }
  }

  /** Stats for monitoring. */
  stats(): {
    total: number; hits: number; misses: number; hitRate: number; pendingCount: number;
    speculations: number; speculationsFailed: number; speculationsWasted: number; wasteRate: number;
  } {
    this.evictExpired();
    return {
      total: this._total,
      hits: this._hits,
      misses: this._misses,
      hitRate: this._total > 0 ? this._hits / this._total : 0,
      pendingCount: this.pending.size,
      // #37 — speculative spend: launched vs failed vs never-reused.
      speculations: this._speculations,
      speculationsFailed: this._speculationsFailed,
      speculationsWasted: this._speculationsWasted,
      wasteRate: this._speculations > 0 ? this._speculationsWasted / this._speculations : 0,
    };
  }
}

// ── Module-level singleton ──────────────────────────────────────────────────

export const speculativeCache = new SpeculativeCache();
