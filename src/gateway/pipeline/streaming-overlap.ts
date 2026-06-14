// ── BabelCast Gateway — Streaming Pipeline Overlap ───────────────────────────
// Accumulates LLM output tokens and triggers TTS when a sentence boundary is
// detected. This lets TTS start producing audio while the LLM is still
// generating the rest of the translation.
//
// Sentence detection ported from pipecat (BSD 2-Clause) via SentenceAggregator
// — multilingual punctuation, lookahead disambiguates decimals/abbreviations.
// Optional <thinking>...</thinking> stripping for reasoning models.

import { createLogger } from '../../logger';
import { SentenceAggregator } from '../../llm-context/sentence-aggregator';
import { PatternPairAggregator } from '../../llm-context/pattern-pair-aggregator';

const log = createLogger('streaming-overlap');

// ── Types ────────────────────────────────────────────────────────────────────

export interface OverlapStats {
  totalRequests: number;
  avgChunks: number;
  avgLatencySavedMs: number;
  /**
   * Latency saved on the MOST RECENT overlap (#50): the wall-clock gap between
   * the first TTS chunk firing and the LLM stream completing. NOTE this is a
   * lower-bound proxy for the true sequential-vs-overlap delta (it measures
   * "LLM time that overlapped with TTS", not a measured sequential baseline),
   * so treat the Labs number as "≥ this much saved".
   */
  lastSavedMs: number;
}

/** Default upper bound on words accumulated before a forced first-chunk flush. */
export const DEFAULT_MAX_WORDS = 40;

export interface StreamingOverlapOptions {
  /** Min words before a sentence boundary triggers a TTS chunk. */
  minTokens?: number;
  /**
   * Max words to accumulate before forcing a flush even if no sentence
   * boundary was hit (#51). Without an upper bound, a run of clauses with no
   * terminal punctuation merges into an over-long first chunk and delays
   * first-audio. Default 40.
   */
  maxWords?: number;
  /** Strip <thinking>...</thinking> blocks before TTS (reasoning models). */
  stripThinking?: boolean;
  /** Custom delimited blocks to strip. e.g. [{ start: '<scratch>', end: '</scratch>' }] */
  stripPatterns?: Array<{ start: string; end: string }>;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ── StreamingOverlap class ──────────────────────────────────────────────────

export class StreamingOverlap {
  private minTokens: number;
  private maxWords: number;
  private stripThinking: boolean;
  private extraPatterns: Array<{ start: string; end: string }>;
  private _totalRequests = 0;
  private _totalChunks = 0;
  private _totalLatencySavedMs = 0;
  private _lastSavedMs = 0;

  constructor(minTokensOrOpts: number | StreamingOverlapOptions = 3) {
    const opts: StreamingOverlapOptions =
      typeof minTokensOrOpts === 'number' ? { minTokens: minTokensOrOpts } : minTokensOrOpts;
    this.minTokens = Math.max(1, opts.minTokens ?? 3);
    this.maxWords = Math.max(this.minTokens, opts.maxWords ?? DEFAULT_MAX_WORDS);
    this.stripThinking = opts.stripThinking ?? false;
    this.extraPatterns = opts.stripPatterns ?? [];
  }

  /** Update min tokens from Labs settings. */
  setMinTokens(n: number): void {
    this.minTokens = Math.max(1, n);
    // Keep the max-words flush at or above minTokens so it never fires first.
    if (this.maxWords < this.minTokens) this.maxWords = this.minTokens;
  }

  /** Update the max-words flush cap (#51). */
  setMaxWords(n: number): void {
    this.maxWords = Math.max(this.minTokens, n);
  }

  /**
   * Toggle reasoning-block stripping. Applies to the NEXT processWithOverlap
   * call — in-flight processing keeps the aggregator chosen at start.
   */
  setStripThinking(on: boolean): void {
    this.stripThinking = on;
  }

  /**
   * Process LLM output as a stream, triggering TTS on chunks.
   *
   * @param llmStream  async iterator of LLM output tokens/chunks
   * @param ttsFn      function to synthesize a text chunk to audio
   * @param onAudioChunk callback when a TTS audio chunk is ready
   * @returns the complete (post-strip) translated text
   */
  async processWithOverlap(
    llmStream: AsyncIterable<string>,
    ttsFn: (text: string) => Promise<Buffer>,
    onAudioChunk: (audio: Buffer, chunkIndex: number) => void,
    onChunkSkipped?: (chunkIndex: number, reason: string) => void,
  ): Promise<string> {
    this._totalRequests++;

    const aggregator = this.buildAggregator();
    const isPatternAgg = aggregator instanceof PatternPairAggregator;
    const fullTextParts: string[] = [];
    const ttsPromises: Promise<void>[] = [];
    let chunkIndex = 0;

    // Ordered dispatch: buffer completed TTS chunks and emit in order
    const completedChunks = new Map<number, Buffer>();
    const failedChunks = new Set<number>();
    let nextEmitIdx = 0;

    const emitReady = () => {
      while (completedChunks.has(nextEmitIdx) || failedChunks.has(nextEmitIdx)) {
        if (completedChunks.has(nextEmitIdx)) {
          const audio = completedChunks.get(nextEmitIdx)!;
          completedChunks.delete(nextEmitIdx);
          onAudioChunk(audio, nextEmitIdx);
        } else {
          failedChunks.delete(nextEmitIdx);
          // Notify caller that chunk N was skipped — without this signal,
          // consumers tracking expected chunk count (transcript<->audio
          // alignment, recording/replay) silently lost the slot.
          onChunkSkipped?.(nextEmitIdx, 'tts_failed');
        }
        nextEmitIdx++;
      }
    };

    let firstTtsFiredAt: number | null = null;
    const t0 = Date.now();

    let pending: string[] = [];
    // Running word count of `pending` (#54). Previously countWords(pending.join)
    // re-split the entire buffer on every dispatched aggregation — O(n²) over a
    // long response. Maintain it incrementally instead.
    let pendingWords = 0;
    const resetPending = () => { pending = []; pendingWords = 0; };

    const fire = (text: string) => {
      const idx = chunkIndex++;
      if (firstTtsFiredAt === null) firstTtsFiredAt = Date.now();

      const p = ttsFn(text)
        .then((audio) => { completedChunks.set(idx, audio); emitReady(); })
        .catch((err) => {
          failedChunks.add(idx); emitReady();
          log.warn(`TTS chunk ${idx} failed: ${err instanceof Error ? err.message : err}`);
        });
      ttsPromises.push(p);
    };

    // Defer aggregator-emitted chunks until accumulated word count ≥ minTokens,
    // then fire as one combined chunk. Avoids firing one-word TTS calls when
    // sentences are short ("Hi.", "OK.") — caller wants chunks sized for
    // natural speech, not per-sentence atoms.
    //
    // Upper bound (#51): if accumulated words reach maxWords WITHOUT a sentence
    // boundary, flush anyway so a long run of unterminated clauses doesn't merge
    // into one over-long first chunk that delays first-audio.
    const dispatchChunk = (chunkText: string) => {
      const text = chunkText.trim();
      if (!text) return;
      pending.push(text);
      pendingWords += countWords(text); // #54 — incremental, not full re-split
      if (pendingWords < this.minTokens) return;
      fire(pending.join(' '));
      resetPending();
    };

    // Track words streamed since the last TTS fire so an unterminated run
    // (no sentence boundary) is force-flushed at maxWords (#51).
    let wordsSinceFire = 0;
    const fireCountBefore = () => chunkIndex;

    for await (const token of llmStream) {
      fullTextParts.push(token);
      wordsSinceFire += countWords(token);

      const firedBefore = fireCountBefore();
      for await (const aggregation of aggregator.aggregate(token)) {
        // PatternPairAggregator may yield non-sentence aggregation types
        // (e.g. AGGREGATE actions) — pass through unchanged.
        if (!aggregation.text) continue;
        dispatchChunk(aggregation.text);
      }
      // If a sentence boundary fired this token, reset the run counter.
      if (chunkIndex > firedBefore) wordsSinceFire = 0;

      // #51 — no boundary for a long stretch: force the aggregator to flush its
      // partial so first-audio isn't held hostage by a missing period.
      if (wordsSinceFire >= this.maxWords) {
        const forced = isPatternAgg
          ? await (aggregator as PatternPairAggregator).flush()
          : await (aggregator as SentenceAggregator).flush();
        if (forced?.text) dispatchChunk(forced.text);
        // Flush whatever is pending now, even below minTokens, to release audio.
        if (pending.length > 0) { fire(pending.join(' ')); resetPending(); }
        wordsSinceFire = 0;
      }
    }

    const llmDoneAt = Date.now();

    // Flush remaining buffer
    const tail = isPatternAgg
      ? await (aggregator as PatternPairAggregator).flush()
      : await (aggregator as SentenceAggregator).flush();
    if (tail?.text) {
      const t = tail.text.trim();
      if (t) { pending.push(t); pendingWords += countWords(t); }
    }
    // End-of-stream:
    //   • If accumulated pending reached minTokens, fire as one combined chunk.
    //   • Otherwise fire each atom individually so short sentences ("Hi.",
    //     "Done.") still emit as separate TTS calls instead of one merged blob.
    if (pending.length > 0) {
      if (pendingWords >= this.minTokens) {
        fire(pending.join(' '));
      } else {
        for (const p of pending) if (p) fire(p);
      }
      resetPending();
    }

    await Promise.all(ttsPromises);

    this._totalChunks += chunkIndex;
    const fullText = fullTextParts.join('');

    if (firstTtsFiredAt !== null && chunkIndex > 1) {
      const savedMs = llmDoneAt - firstTtsFiredAt;
      if (savedMs > 0) {
        this._totalLatencySavedMs += savedMs;
        this._lastSavedMs = savedMs; // #50 — expose the per-request value
        const totalTokens = countWords(fullText);
        log.log(
          // Clarify (#50): this is LLM time that overlapped with TTS — a
          // lower bound on the true sequential-vs-overlap saving, not a
          // measured baseline delta.
          `First TTS chunk fired with ~${this.minTokens}/${totalTokens} words` +
          ` — overlapped ~${savedMs}ms of LLM time (${chunkIndex} chunks, total LLM time ${llmDoneAt - t0}ms)`,
        );
      }
    }

    return fullText;
  }

  /** Aggregate stats. */
  stats(): OverlapStats {
    return {
      totalRequests: this._totalRequests,
      avgChunks: this._totalRequests > 0 ? this._totalChunks / this._totalRequests : 0,
      avgLatencySavedMs: this._totalRequests > 0
        ? this._totalLatencySavedMs / this._totalRequests : 0,
      lastSavedMs: this._lastSavedMs, // #50
    };
  }

  private buildAggregator(): SentenceAggregator | PatternPairAggregator {
    const patterns: Array<{ start: string; end: string; type: string }> = [];
    if (this.stripThinking) {
      patterns.push({ start: '<thinking>', end: '</thinking>', type: 'thinking' });
    }
    for (let i = 0; i < this.extraPatterns.length; i++) {
      patterns.push({ start: this.extraPatterns[i].start, end: this.extraPatterns[i].end, type: `custom-${i}` });
    }

    if (patterns.length === 0) return new SentenceAggregator();

    const agg = new PatternPairAggregator();
    for (const p of patterns) agg.addPattern(p.type, p.start, p.end, 'remove');
    return agg;
  }
}
