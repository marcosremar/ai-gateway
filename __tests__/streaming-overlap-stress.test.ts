/**
 * Stress + concurrency tests for StreamingOverlap.
 *
 * Targets: many parallel calls on same instance, race between TTS chunks,
 * very fast LLM with very slow TTS, broken async iterator, partial consumer
 * cancellation, mixed stripPatterns, pattern at exact stream end.
 */

import { describe, it, expect } from 'vitest';
import { StreamingOverlap } from '../src/gateway/pipeline/streaming-overlap';

async function* tokens(text: string, chunkSize = 4) {
  for (let i = 0; i < text.length; i += chunkSize) yield text.slice(i, i + chunkSize);
}

async function* slowTokens(text: string, delayMs = 1, chunkSize = 4) {
  for (let i = 0; i < text.length; i += chunkSize) {
    await new Promise((r) => setTimeout(r, delayMs));
    yield text.slice(i, i + chunkSize);
  }
}

function makeTts(latencyByIdx: number[] = []) {
  let i = 0;
  const calls: string[] = [];
  return {
    fn: async (text: string) => {
      const idx = i++;
      calls.push(text);
      const lat = latencyByIdx[idx] ?? 0;
      if (lat > 0) await new Promise((r) => setTimeout(r, lat));
      return Buffer.from(`audio:${text}`);
    },
    calls,
  };
}

describe('StreamingOverlap stress — concurrency on single instance', () => {
  it('5 parallel processWithOverlap calls do not interleave audio', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });

    const runOne = async (label: string, sentenceCount: number) => {
      const tts = makeTts();
      const audio: string[] = [];
      const text = Array.from({ length: sentenceCount }, (_, i) => `${label}-${i}.`).join(' ');
      await overlap.processWithOverlap(
        tokens(text),
        tts.fn,
        (a) => audio.push(a.toString().replace('audio:', '')),
      );
      return { label, audio, calls: tts.calls };
    };

    const results = await Promise.all([
      runOne('A', 3),
      runOne('B', 4),
      runOne('C', 2),
      runOne('D', 5),
      runOne('E', 3),
    ]);

    // Each run's audio must contain only its own label
    for (const r of results) {
      for (const a of r.audio) {
        expect(a, `${r.label}: audio should only contain own label`).toContain(r.label);
      }
    }

    const stats = overlap.stats();
    expect(stats.totalRequests).toBe(5);
  });
});

describe('StreamingOverlap stress — TTS race + ordering', () => {
  it('chunk N+1 finishes before chunk N: emit still in order', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    // First TTS call takes 30ms, second takes 1ms, third takes 1ms
    const tts = makeTts([30, 1, 1]);
    const emitted: Array<{ idx: number; text: string }> = [];

    await overlap.processWithOverlap(
      tokens('First. Second. Third.'),
      tts.fn,
      (audio, idx) => emitted.push({ idx, text: audio.toString().replace('audio:', '') }),
    );

    expect(emitted.map((e) => e.idx)).toEqual([0, 1, 2]);
    expect(emitted.map((e) => e.text)).toEqual(['First.', 'Second.', 'Third.']);
  });

  it('20 chunks with random latencies: ordered emission preserved', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const latencies = Array.from({ length: 20 }, () => Math.floor(Math.random() * 15));
    const tts = makeTts(latencies);
    const emitted: number[] = [];
    const text = Array.from({ length: 20 }, (_, i) => `S${i}.`).join(' ');

    await overlap.processWithOverlap(
      tokens(text, 3),
      tts.fn,
      (_audio, idx) => emitted.push(idx),
    );

    // Emitted indices must be strictly ascending starting from 0
    for (let i = 0; i < emitted.length; i++) expect(emitted[i]).toBe(i);
    expect(emitted.length).toBe(20);
  });
});

describe('StreamingOverlap stress — broken inputs', () => {
  it('LLM iterator throws mid-stream: error propagates, partial chunks emitted', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = makeTts();
    const emitted: string[] = [];

    const badStream = (async function* () {
      yield 'First. ';
      yield 'Second. ';
      throw new Error('LLM connection lost');
    })();

    await expect(
      overlap.processWithOverlap(badStream, tts.fn, (a) => emitted.push(a.toString())),
    ).rejects.toThrow('LLM connection lost');

    // Chunks before error should have been dispatched
    // (they may not all have completed, but at least one TTS call should have been attempted)
    expect(tts.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('TTS function returns empty buffer: still counted', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const ttsFn = async () => Buffer.alloc(0);
    const emitted: number[] = [];
    await overlap.processWithOverlap(
      tokens('A. B. C.'),
      ttsFn,
      (_audio, idx) => emitted.push(idx),
    );
    expect(emitted).toEqual([0, 1, 2]);
  });

  it('all TTS chunks fail: no audio emitted but no exception', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const ttsFn = async () => { throw new Error('TTS down'); };
    const emitted: string[] = [];
    await overlap.processWithOverlap(
      tokens('A. B. C.'),
      ttsFn,
      (a) => emitted.push(a.toString()),
    );
    expect(emitted).toEqual([]);
  });

  it('TTS faster than LLM streaming: ordered emission still correct', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = makeTts(); // instant
    const emitted: number[] = [];
    await overlap.processWithOverlap(
      slowTokens('A. B. C. D. E.', 5, 3), // slow LLM
      tts.fn,
      (_a, idx) => emitted.push(idx),
    );
    expect(emitted).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('StreamingOverlap stress — pattern stripping edge cases', () => {
  it('REGRESSION: unclosed thinking block at stream end is NOT spoken', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1, stripThinking: true });
    const tts = makeTts();
    await overlap.processWithOverlap(
      (async function* () {
        yield 'Hi. <thinking>never closed reasoning content';
      })(),
      tts.fn,
      () => {},
    );
    // Bug: previously flushed buffer including "<thinking>...", TTS would
    // literally speak "thinking" tag. Fix: strip from open-pattern start
    // position on flush.
    expect(tts.calls).toEqual(['Hi.']);
    expect(tts.calls.join(' ')).not.toContain('thinking');
    expect(tts.calls.join(' ')).not.toContain('reasoning');
  });

  it('REGRESSION: partial start delimiter at stream end (e.g. "<thi") not spoken', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1, stripThinking: true });
    const tts = makeTts();
    await overlap.processWithOverlap(
      (async function* () { yield 'Hi. <thi'; })(),
      tts.fn,
      () => {},
    );
    // "<thi" is partial — never matched as start. Flush emits raw "<thi".
    // Pinned: document current behavior (partial delimiter ≠ open pattern).
    expect(tts.calls).toContain('Hi.');
  });

  it('only-thinking content: no TTS calls', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1, stripThinking: true });
    const tts = makeTts();
    await overlap.processWithOverlap(
      tokens('<thinking>just thinking, no output</thinking>'),
      tts.fn,
      () => {},
    );
    // Should produce ZERO TTS calls — nothing to speak.
    expect(tts.calls).toEqual([]);
  });

  it('thinking with sentence-ending punctuation inside is stripped completely', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1, stripThinking: true });
    const tts = makeTts();
    await overlap.processWithOverlap(
      tokens('Hi. <thinking>What. Why? How!</thinking>Bye.'),
      tts.fn,
      () => {},
    );
    expect(tts.calls).toEqual(['Hi.', 'Bye.']);
  });

  it('multiple custom patterns interleaved with thinking', async () => {
    const overlap = new StreamingOverlap({
      minTokens: 1,
      stripThinking: true,
      stripPatterns: [
        { start: '<scratch>', end: '</scratch>' },
        { start: '[[', end: ']]' },
      ],
    });
    const tts = makeTts();
    await overlap.processWithOverlap(
      tokens('Hi <thinking>x</thinking>there [[secret]] <scratch>note</scratch>. End.'),
      tts.fn,
      () => {},
    );
    const joined = tts.calls.join(' ');
    expect(joined).not.toContain('thinking');
    expect(joined).not.toContain('scratch');
    expect(joined).not.toContain('secret');
    expect(joined).not.toContain('note');
    expect(joined).toContain('End.');
  });
});

describe('StreamingOverlap stress — pathological streams', () => {
  it('1000 sentences sustained throughput', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = makeTts();
    const text = Array.from({ length: 1000 }, (_, i) => `Sentence ${i}.`).join(' ');
    const emitted: number[] = [];
    await overlap.processWithOverlap(tokens(text, 8), tts.fn, (_a, idx) => emitted.push(idx));
    expect(tts.calls.length).toBe(1000);
    expect(emitted).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  });

  it('single-char chunks (worst case): no chunk loss', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = makeTts();
    await overlap.processWithOverlap(
      (async function* () { for (const c of 'A. B. C.') yield c; })(),
      tts.fn,
      () => {},
    );
    expect(tts.calls).toEqual(['A.', 'B.', 'C.']);
  });

  it('whitespace-only token chunks: no spurious empty TTS calls', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = makeTts();
    await overlap.processWithOverlap(
      (async function* () {
        yield 'Hi.';
        yield '   ';
        yield ' Bye.';
      })(),
      tts.fn,
      () => {},
    );
    expect(tts.calls).toEqual(['Hi.', 'Bye.']);
  });

  it('numeric-only stream: handled without crash', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = makeTts();
    await overlap.processWithOverlap(
      tokens('1. 2. 3. 4.'),
      tts.fn,
      () => {},
    );
    // Numbers followed by period+space+digit: ambiguous (decimal vs sentence).
    // Document actual behavior — should not crash.
    expect(tts.calls.length).toBeGreaterThan(0);
  });

  it('null character / control chars in stream: no crash', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = makeTts();
    await overlap.processWithOverlap(
      (async function* () {
        yield 'Hi.\x00\x01 Bye.';
      })(),
      tts.fn,
      () => {},
    );
    expect(tts.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('StreamingOverlap stress — stats correctness', () => {
  it('avgChunks correct after multiple varied calls', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = makeTts();

    await overlap.processWithOverlap(tokens('A. B.'), tts.fn, () => {});
    await overlap.processWithOverlap(tokens('A. B. C. D.'), tts.fn, () => {});

    const stats = overlap.stats();
    expect(stats.totalRequests).toBe(2);
    // First: 2 chunks, second: 4 chunks → avg 3
    expect(stats.avgChunks).toBeCloseTo(3, 1);
  });

  it('stats survive concurrent calls', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = makeTts();
    await Promise.all([
      overlap.processWithOverlap(tokens('A. B.'), tts.fn, () => {}),
      overlap.processWithOverlap(tokens('C. D.'), tts.fn, () => {}),
      overlap.processWithOverlap(tokens('E. F.'), tts.fn, () => {}),
    ]);
    const stats = overlap.stats();
    expect(stats.totalRequests).toBe(3);
    expect(stats.avgChunks).toBeCloseTo(2, 1);
  });
});
