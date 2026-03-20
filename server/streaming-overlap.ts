// ── BabelCast Gateway — Streaming Pipeline Overlap ───────────────────────────
// Accumulates LLM output tokens and triggers TTS when enough tokens are
// available at a sentence/clause boundary. This lets TTS start producing audio
// while the LLM is still generating the rest of the translation.

// ── Types ────────────────────────────────────────────────────────────────────

export interface OverlapStats {
  totalRequests: number;
  avgChunks: number;
  avgLatencySavedMs: number;
}

// ── Sentence-boundary detection ─────────────────────────────────────────────

/** Returns true when `text` ends at a natural break for TTS chunking. */
function isChunkBoundary(text: string, maxWords: number): boolean {
  const trimmed = text.trimEnd();
  // Natural punctuation boundaries
  if (/[.!?,;:\n]$/.test(trimmed)) return true;
  // Safety valve: if we've accumulated 2x the minimum tokens without hitting
  // a boundary, flush anyway to avoid unbounded buffering.
  if (trimmed.split(/\s+/).length >= maxWords) return true;
  return false;
}

// ── StreamingOverlap class ──────────────────────────────────────────────────

export class StreamingOverlap {
  private minTokens: number;
  private _totalRequests = 0;
  private _totalChunks = 0;
  private _totalLatencySavedMs = 0;

  constructor(minTokens = 3) {
    this.minTokens = Math.max(1, minTokens);
  }

  /** Update min tokens from Labs settings. */
  setMinTokens(n: number): void {
    this.minTokens = Math.max(1, n);
  }

  /**
   * Process LLM output as a stream, triggering TTS on chunks.
   *
   * @param llmStream  async iterator of LLM output tokens/chunks
   * @param ttsFn      function to synthesize a text chunk to audio
   * @param onAudioChunk callback when a TTS audio chunk is ready
   * @returns the complete translated text
   */
  async processWithOverlap(
    llmStream: AsyncIterable<string>,
    ttsFn: (text: string) => Promise<Buffer>,
    onAudioChunk: (audio: Buffer, chunkIndex: number) => void,
  ): Promise<string> {
    this._totalRequests++;

    const fullTextParts: string[] = [];
    let buffer = '';
    let chunkIndex = 0;
    const ttsPromises: Promise<void>[] = [];
    const maxWords = this.minTokens * 2;

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
        }
        nextEmitIdx++;
      }
    };

    // Track timing: when did the first TTS fire vs when does the LLM finish?
    let firstTtsFiredAt: number | null = null;
    let llmDoneAt: number | null = null;
    const t0 = Date.now();

    for await (const token of llmStream) {
      buffer += token;
      fullTextParts.push(token);

      // Count words in the buffer
      const wordCount = buffer.trim().split(/\s+/).filter(Boolean).length;

      // Check: enough tokens AND at a boundary?
      if (wordCount >= this.minTokens && isChunkBoundary(buffer, maxWords)) {
        const chunkText = buffer.trim();
        buffer = '';

        if (chunkText) {
          const idx = chunkIndex++;
          if (firstTtsFiredAt === null) firstTtsFiredAt = Date.now();

          // Fire TTS in parallel — deliver chunks in order via emitReady()
          const p = ttsFn(chunkText)
            .then(audio => { completedChunks.set(idx, audio); emitReady(); })
            .catch(err => {
              failedChunks.add(idx); emitReady();
              console.warn(`[overlap] TTS chunk ${idx} failed: ${err instanceof Error ? err.message : err}`);
            });
          ttsPromises.push(p);
        }
      }
    }

    llmDoneAt = Date.now();

    // Flush remaining buffer
    const remaining = buffer.trim();
    if (remaining) {
      const idx = chunkIndex++;
      if (firstTtsFiredAt === null) firstTtsFiredAt = Date.now();

      const p = ttsFn(remaining)
        .then(audio => { completedChunks.set(idx, audio); emitReady(); })
        .catch(err => {
          console.warn(`[overlap] TTS chunk ${idx} (final) failed: ${err instanceof Error ? err.message : err}`);
        });
      ttsPromises.push(p);
    }

    // Wait for all TTS chunks to finish
    await Promise.all(ttsPromises);

    // Compute stats
    this._totalChunks += chunkIndex;
    const fullText = fullTextParts.join('');

    if (firstTtsFiredAt !== null && llmDoneAt !== null && chunkIndex > 1) {
      // Latency saved = time between first TTS fire and LLM completion.
      // Without overlap, TTS wouldn't start until llmDoneAt.
      // With overlap, first TTS chunk was fired at firstTtsFiredAt.
      const savedMs = llmDoneAt - firstTtsFiredAt;
      if (savedMs > 0) {
        this._totalLatencySavedMs += savedMs;
        const totalTokens = fullText.split(/\s+/).filter(Boolean).length;
        const firstChunkTokens = this.minTokens;
        console.log(
          `[overlap] First TTS chunk at LLM token ~${firstChunkTokens}/${totalTokens}` +
          ` — saved ~${savedMs}ms (${chunkIndex} chunks, total LLM time ${llmDoneAt - t0}ms)`,
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
    };
  }
}
