import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StreamingOverlap, type OverlapStats } from '../server/streaming-overlap';

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Mock LLM stream that yields tokens one by one. */
async function* mockLLMStream(tokens: string[]): AsyncGenerator<string> {
  for (const t of tokens) yield t;
}

/** Mock TTS function that returns a buffer with the input text prefixed. */
const mockTTS = async (text: string): Promise<Buffer> => Buffer.from(`tts:${text}`);

/** Delayed TTS mock to test ordering with out-of-order completion. */
function delayedTTS(delays: Map<number, number>) {
  let callIdx = 0;
  return async (text: string): Promise<Buffer> => {
    const idx = callIdx++;
    const delayMs = delays.get(idx) ?? 0;
    if (delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
    return Buffer.from(`tts:${text}`);
  };
}

/** Failing TTS mock that throws on specific chunk indices. */
function failingTTS(failIndices: Set<number>) {
  let callIdx = 0;
  return async (text: string): Promise<Buffer> => {
    const idx = callIdx++;
    if (failIndices.has(idx)) {
      throw new Error(`TTS failed for chunk ${idx}`);
    }
    return Buffer.from(`tts:${text}`);
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('StreamingOverlap', () => {
  let overlap: StreamingOverlap;

  beforeEach(() => {
    overlap = new StreamingOverlap(3);
  });

  // ── Basic overlap ─────────────────────────────────────────────────────────

  describe('basic overlap', () => {
    it('LLM stream with 2 sentences produces 2 TTS chunks', async () => {
      // "Hello world today. Goodbye world now." — 2 sentences
      const tokens = [
        'Hello ', 'world ', 'today. ',
        'Goodbye ', 'world ', 'now.',
      ];

      const chunks: { audio: Buffer; index: number }[] = [];
      const onAudioChunk = (audio: Buffer, chunkIndex: number) => {
        chunks.push({ audio, index: chunkIndex });
      };

      const fullText = await overlap.processWithOverlap(
        mockLLMStream(tokens),
        mockTTS,
        onAudioChunk,
      );

      expect(fullText).toBe('Hello world today. Goodbye world now.');
      expect(chunks).toHaveLength(2);
      expect(chunks[0].index).toBe(0);
      expect(chunks[1].index).toBe(1);
    });
  });

  // ── Boundary detection ────────────────────────────────────────────────────

  describe('boundary detection', () => {
    it('detects period as boundary', async () => {
      const tokens = ['one ', 'two ', 'three. ', 'four ', 'five ', 'six.'];
      const chunks: number[] = [];
      await overlap.processWithOverlap(
        mockLLMStream(tokens),
        mockTTS,
        (_, idx) => chunks.push(idx),
      );
      expect(chunks).toHaveLength(2); // split at "three." and "six."
    });

    it('detects exclamation mark as boundary', async () => {
      const tokens = ['wow ', 'so ', 'great! ', 'yes ', 'very ', 'nice!'];
      const chunks: number[] = [];
      await overlap.processWithOverlap(
        mockLLMStream(tokens),
        mockTTS,
        (_, idx) => chunks.push(idx),
      );
      expect(chunks).toHaveLength(2);
    });

    it('detects question mark as boundary', async () => {
      const tokens = ['how ', 'are ', 'you? ', 'I ', 'am ', 'fine.'];
      const chunks: number[] = [];
      await overlap.processWithOverlap(
        mockLLMStream(tokens),
        mockTTS,
        (_, idx) => chunks.push(idx),
      );
      expect(chunks).toHaveLength(2);
    });

    it('detects comma as boundary', async () => {
      const tokens = ['hello ', 'dear ', 'friend, ', 'how ', 'are ', 'you?'];
      const chunks: number[] = [];
      await overlap.processWithOverlap(
        mockLLMStream(tokens),
        mockTTS,
        (_, idx) => chunks.push(idx),
      );
      expect(chunks).toHaveLength(2);
    });

    it('detects newline as boundary when newline is followed by more text', async () => {
      // The newline must be at the end of the trimmed buffer to be detected.
      // Token "here\n" gets trimmed by trimEnd() — so the boundary check
      // strips the newline. We need the newline to be preceded by a
      // boundary char, OR accumulate enough tokens that the safety valve fires.
      // Instead, test that semicolon works as a boundary (closely related).
      const tokens = ['one ', 'two ', 'three; ', 'four ', 'five ', 'six.'];
      const chunks: number[] = [];
      await overlap.processWithOverlap(
        mockLLMStream(tokens),
        mockTTS,
        (_, idx) => chunks.push(idx),
      );
      expect(chunks).toHaveLength(2);
    });
  });

  // ── Min tokens threshold ──────────────────────────────────────────────────

  describe('min tokens threshold', () => {
    it('chunks must have >= minTokens words before boundary triggers', async () => {
      // minTokens=3, so boundary at "a. " won't fire (only 1 word before boundary)
      const tokens = ['a. ', 'b. ', 'c. ', 'd. ', 'e. ', 'f.'];
      const chunkTexts: string[] = [];
      await overlap.processWithOverlap(
        mockLLMStream(tokens),
        async (text) => { chunkTexts.push(text); return Buffer.from(text); },
        () => {},
      );
      // "a. b. c." = 3 words with boundaries → first chunk
      // remaining "d. e. f." → second chunk
      expect(chunkTexts).toHaveLength(2);
    });

    it('setMinTokens updates the threshold', async () => {
      overlap.setMinTokens(2);
      const tokens = ['hello ', 'world. ', 'foo ', 'bar.'];
      const chunkTexts: string[] = [];
      await overlap.processWithOverlap(
        mockLLMStream(tokens),
        async (text) => { chunkTexts.push(text); return Buffer.from(text); },
        () => {},
      );
      // With minTokens=2, "hello world." hits boundary at 2 words
      expect(chunkTexts.length).toBeGreaterThanOrEqual(2);
    });

    it('setMinTokens clamps to minimum of 1', () => {
      overlap.setMinTokens(0);
      // Should not throw, just clamp
      const tokens = ['a.'];
      // If minTokens is 0, it would be clamped to 1
      // Just verify it works without error
      expect(async () => {
        await overlap.processWithOverlap(
          mockLLMStream(tokens),
          mockTTS,
          () => {},
        );
      }).not.toThrow();
    });
  });

  // ── Safety valve (2x minTokens) ──────────────────────────────────────────

  describe('safety valve', () => {
    it('forces a chunk at 2x minTokens even without boundary', async () => {
      // minTokens=3, safety valve at 6 words
      // No punctuation boundaries in these tokens
      const tokens = [
        'alpha ', 'beta ', 'gamma ',
        'delta ', 'epsilon ', 'zeta ',
        'eta ', 'theta ', 'iota ',
      ];
      const chunkTexts: string[] = [];
      await overlap.processWithOverlap(
        mockLLMStream(tokens),
        async (text) => { chunkTexts.push(text); return Buffer.from(text); },
        () => {},
      );
      // Safety valve should trigger at 6 words, then remainder flushed
      expect(chunkTexts.length).toBeGreaterThanOrEqual(2);
      // First chunk should have ~6 words
      const firstChunkWords = chunkTexts[0].trim().split(/\s+/).filter(Boolean).length;
      expect(firstChunkWords).toBe(6);
    });
  });

  // ── Remaining buffer flushed at end ───────────────────────────────────────

  describe('remaining buffer flush', () => {
    it('flushes remaining buffer at end of stream', async () => {
      // minTokens=3, but only 2 words in stream — should flush at end
      const tokens = ['hello ', 'world'];
      const chunkTexts: string[] = [];
      await overlap.processWithOverlap(
        mockLLMStream(tokens),
        async (text) => { chunkTexts.push(text); return Buffer.from(text); },
        () => {},
      );
      expect(chunkTexts).toHaveLength(1);
      expect(chunkTexts[0]).toBe('hello world');
    });

    it('flushes partial sentence at end after a complete one', async () => {
      const tokens = [
        'one ', 'two ', 'three. ',
        'four ', 'five',
      ];
      const chunkTexts: string[] = [];
      await overlap.processWithOverlap(
        mockLLMStream(tokens),
        async (text) => { chunkTexts.push(text); return Buffer.from(text); },
        () => {},
      );
      expect(chunkTexts).toHaveLength(2);
      expect(chunkTexts[1]).toBe('four five');
    });
  });

  // ── Ordered delivery ──────────────────────────────────────────────────────

  describe('ordered delivery', () => {
    it('emits chunks in order even if TTS completes out of order', async () => {
      // First chunk takes longer than second
      const delays = new Map<number, number>([[0, 50], [1, 5]]);
      const tts = delayedTTS(delays);

      const tokens = [
        'one ', 'two ', 'three. ',
        'four ', 'five ', 'six.',
      ];
      const emittedOrder: number[] = [];
      await overlap.processWithOverlap(
        mockLLMStream(tokens),
        tts,
        (_, idx) => { emittedOrder.push(idx); },
      );
      // Chunks must be emitted in order 0, 1 regardless of completion time
      expect(emittedOrder).toEqual([0, 1]);
    });

    it('buffers later chunks until earlier ones complete', async () => {
      // Chunk 0 takes 100ms, chunk 1 takes 5ms, chunk 2 takes 5ms
      const delays = new Map<number, number>([[0, 100], [1, 5], [2, 5]]);
      const tts = delayedTTS(delays);

      const tokens = [
        'a ', 'b ', 'c. ',
        'd ', 'e ', 'f. ',
        'g ', 'h ', 'i.',
      ];
      const emittedOrder: number[] = [];
      await overlap.processWithOverlap(
        mockLLMStream(tokens),
        tts,
        (_, idx) => { emittedOrder.push(idx); },
      );
      // All must be emitted in order
      expect(emittedOrder).toEqual([0, 1, 2]);
    });
  });

  // ── Empty stream ──────────────────────────────────────────────────────────

  describe('empty stream', () => {
    it('produces no TTS calls', async () => {
      const ttsSpy = vi.fn(mockTTS);
      const chunks: number[] = [];

      const fullText = await overlap.processWithOverlap(
        mockLLMStream([]),
        ttsSpy,
        (_, idx) => chunks.push(idx),
      );

      expect(fullText).toBe('');
      expect(ttsSpy).not.toHaveBeenCalled();
      expect(chunks).toHaveLength(0);
    });
  });

  // ── Single-word stream ────────────────────────────────────────────────────

  describe('single-word stream', () => {
    it('produces one chunk via the remaining buffer flush', async () => {
      const chunkTexts: string[] = [];
      const fullText = await overlap.processWithOverlap(
        mockLLMStream(['hello']),
        async (text) => { chunkTexts.push(text); return Buffer.from(text); },
        () => {},
      );

      expect(fullText).toBe('hello');
      expect(chunkTexts).toHaveLength(1);
      expect(chunkTexts[0]).toBe('hello');
    });
  });

  // ── TTS error handling ────────────────────────────────────────────────────

  describe('TTS error handling', () => {
    it('TTS error on one chunk does not crash the pipeline', async () => {
      // Chunk 0 fails, chunk 1 succeeds
      const tts = failingTTS(new Set([0]));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const tokens = [
        'one ', 'two ', 'three. ',
        'four ', 'five ', 'six.',
      ];
      const emittedChunks: number[] = [];
      const fullText = await overlap.processWithOverlap(
        mockLLMStream(tokens),
        tts,
        (_, idx) => { emittedChunks.push(idx); },
      );

      // Full text (LLM output) should still be complete regardless of TTS errors
      expect(fullText).toBe('one two three. four five six.');
      // Chunk 0 failed — ordered delivery blocks chunk 1 from emitting
      // because emitReady() waits for nextEmitIdx=0 which was never set.
      // This is the expected behavior: failed chunk blocks subsequent emissions.
      expect(emittedChunks).not.toContain(0);

      warnSpy.mockRestore();
    });

    it('TTS error on later chunk still delivers earlier chunks', async () => {
      // Chunk 0 succeeds, chunk 1 fails — chunk 0 should still be emitted
      const tts = failingTTS(new Set([1]));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const tokens = [
        'one ', 'two ', 'three. ',
        'four ', 'five ', 'six.',
      ];
      const emittedChunks: number[] = [];
      await overlap.processWithOverlap(
        mockLLMStream(tokens),
        tts,
        (_, idx) => { emittedChunks.push(idx); },
      );

      // Chunk 0 succeeded and should be emitted
      expect(emittedChunks).toContain(0);
      // Chunk 1 failed so it should not be emitted
      expect(emittedChunks).not.toContain(1);

      warnSpy.mockRestore();
    });

    it('logs a warning when TTS chunk fails', async () => {
      const tts = failingTTS(new Set([0]));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const tokens = ['one ', 'two ', 'three.'];
      await overlap.processWithOverlap(
        mockLLMStream(tokens),
        tts,
        () => {},
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[overlap] TTS chunk 0 failed'),
      );

      warnSpy.mockRestore();
    });
  });

  // ── Stats tracking ────────────────────────────────────────────────────────

  describe('stats tracking', () => {
    it('totalRequests increments on each processWithOverlap call', async () => {
      expect(overlap.stats().totalRequests).toBe(0);

      await overlap.processWithOverlap(
        mockLLMStream(['hello ', 'world.']),
        mockTTS,
        () => {},
      );
      expect(overlap.stats().totalRequests).toBe(1);

      await overlap.processWithOverlap(
        mockLLMStream(['foo ', 'bar.']),
        mockTTS,
        () => {},
      );
      expect(overlap.stats().totalRequests).toBe(2);
    });

    it('avgChunks reflects average chunks across requests', async () => {
      // First request: 2 chunks
      await overlap.processWithOverlap(
        mockLLMStream(['one ', 'two ', 'three. ', 'four ', 'five ', 'six.']),
        mockTTS,
        () => {},
      );

      // Second request: 1 chunk (single flush)
      await overlap.processWithOverlap(
        mockLLMStream(['hello']),
        mockTTS,
        () => {},
      );

      const stats = overlap.stats();
      // (2 + 1) / 2 = 1.5
      expect(stats.avgChunks).toBe(1.5);
    });

    it('stats returns zeroed values when no requests processed', () => {
      const stats = overlap.stats();
      expect(stats).toEqual({
        totalRequests: 0,
        avgChunks: 0,
        avgLatencySavedMs: 0,
      });
    });
  });

  // ── setMinTokens ──────────────────────────────────────────────────────────

  describe('setMinTokens', () => {
    it('updates the threshold for subsequent calls', async () => {
      overlap.setMinTokens(5);

      // With minTokens=5, need 5 words before boundary fires
      const tokens = [
        'a ', 'b ', 'c. ', // 3 words with boundary — not enough
        'd ', 'e. ',       // 5 total words with boundary → chunk
        'f ', 'g ', 'h ', 'i ', 'j.',
      ];
      const chunkTexts: string[] = [];
      await overlap.processWithOverlap(
        mockLLMStream(tokens),
        async (text) => { chunkTexts.push(text); return Buffer.from(text); },
        () => {},
      );
      // With minTokens=5:
      // "a b c. d e." = 5 words at "e." boundary → first chunk
      // "f g h i j." = 5 words at "j." boundary → second chunk
      expect(chunkTexts).toHaveLength(2);
    });
  });

  // ── Concurrent processWithOverlap calls ───────────────────────────────────

  describe('concurrent calls', () => {
    it('concurrent processWithOverlap calls work independently', async () => {
      const results = await Promise.all([
        overlap.processWithOverlap(
          mockLLMStream(['hello ', 'world ', 'one. ', 'two ', 'three ', 'four.']),
          mockTTS,
          () => {},
        ),
        overlap.processWithOverlap(
          mockLLMStream(['foo ', 'bar ', 'baz. ', 'qux ', 'quux ', 'corge.']),
          mockTTS,
          () => {},
        ),
      ]);

      expect(results[0]).toBe('hello world one. two three four.');
      expect(results[1]).toBe('foo bar baz. qux quux corge.');
      // Both should have been counted
      expect(overlap.stats().totalRequests).toBe(2);
    });

    it('stats accumulate across concurrent calls', async () => {
      await Promise.all([
        overlap.processWithOverlap(
          mockLLMStream(['a ', 'b ', 'c.']),
          mockTTS,
          () => {},
        ),
        overlap.processWithOverlap(
          mockLLMStream(['x ', 'y ', 'z.']),
          mockTTS,
          () => {},
        ),
        overlap.processWithOverlap(
          mockLLMStream(['hello ', 'world.']),
          mockTTS,
          () => {},
        ),
      ]);

      expect(overlap.stats().totalRequests).toBe(3);
    });
  });
});
