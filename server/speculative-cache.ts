// ── BabelCast Gateway — Speculative Translation Cache ─────────────────────────
// Starts translating partial ASR text BEFORE the final transcript arrives.
// If the final ASR result is similar enough to the speculated partial,
// the cached translation is reused — saving the full LLM round-trip latency.

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
  private _total = 0;
  private _hits = 0;
  private _misses = 0;

  /** Normalize text for similarity comparison. */
  private normalize(text: string): string {
    return text.toLowerCase().trim().replace(/\s+/g, ' ');
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

    // If we already have a speculation for this session with the same text, skip
    const existing = this.pending.get(sessionId);
    if (existing && existing.partialText === trimmed) return;

    // LRU eviction: remove oldest if at capacity
    if (this.pending.size >= MAX_SPECULATIONS) {
      const oldestKey = this.pending.keys().next().value;
      if (oldestKey) {
        this.pending.delete(oldestKey);
        console.log(`[speculation] Evicted oldest entry (sessionId=${oldestKey})`);
      }
    }

    const entry: SpeculationEntry = {
      partialText: trimmed,
      normalizedPartial: this.normalize(trimmed),
      translationPromise: translateFn(trimmed).then(result => {
        entry.translatedText = result;
        entry.resolved = true;
        return result;
      }).catch(err => {
        console.warn(`[speculation] Background translation failed: ${err instanceof Error ? err.message : err}`);
        entry.resolved = true;
        return '';
      }),
      startedAt: Date.now(),
      resolved: false,
    };

    this.pending.set(sessionId, entry);
    console.log(`[speculation] Started for session=${sessionId} partial="${trimmed.slice(0, 60)}"`);
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
    const entry = this.pending.get(sessionId);
    this._total++;

    if (!entry) {
      this._misses++;
      return null;
    }

    // Clean up this entry regardless of outcome
    this.pending.delete(sessionId);

    const normalizedFinal = this.normalize(finalText);
    const normalizedPartial = entry.normalizedPartial;

    // Skip if partial is empty or too short to be meaningful
    if (normalizedPartial.length < 3) {
      this._misses++;
      console.log(`[speculation] MISS — partial too short (${normalizedPartial.length} chars) session=${sessionId}`);
      return null;
    }

    // Check similarity
    const isSimilar = this.checkSimilarity(normalizedPartial, normalizedFinal, minConfidence);

    if (!isSimilar) {
      this._misses++;
      console.log(`[speculation] MISS — partial="${entry.partialText.slice(0, 40)}" final="${finalText.slice(0, 40)}" session=${sessionId}`);
      return null;
    }

    // Wait for the translation to complete (it may already be done)
    const t0 = Date.now();
    try {
      const translation = await entry.translationPromise;
      if (!translation) {
        this._misses++;
        console.log(`[speculation] MISS — translation was empty session=${sessionId}`);
        return null;
      }

      const savedMs = Date.now() - t0;
      const totalMs = Date.now() - entry.startedAt;
      this._hits++;
      console.log(`[speculation] HIT — saved ${savedMs}ms (speculation ran ${totalMs}ms) session=${sessionId} partial="${entry.partialText.slice(0, 40)}" final="${finalText.slice(0, 40)}"`);
      return translation;
    } catch {
      this._misses++;
      return null;
    }
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
  }

  /** Remove expired entries. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.pending) {
      if (now - entry.startedAt > EXPIRY_MS) {
        this.pending.delete(key);
      }
    }
  }

  /** Stats for monitoring. */
  stats(): { total: number; hits: number; misses: number; hitRate: number; pendingCount: number } {
    this.evictExpired();
    return {
      total: this._total,
      hits: this._hits,
      misses: this._misses,
      hitRate: this._total > 0 ? this._hits / this._total : 0,
      pendingCount: this.pending.size,
    };
  }
}

// ── Module-level singleton ──────────────────────────────────────────────────

export const speculativeCache = new SpeculativeCache();
