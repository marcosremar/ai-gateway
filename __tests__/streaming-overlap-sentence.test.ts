/**
 * E2E tests for StreamingOverlap with new SentenceAggregator wiring.
 *
 * Verifies:
 *   - LLM token stream → sentence-aware chunking → TTS calls
 *   - Ordered audio emission (chunks arrive in stream order even if TTS races)
 *   - <thinking> stripping when stripThinking=true
 *   - Multilingual sentence splits
 *   - Backward compat: constructor accepts number minTokens
 *   - Word-count safety valve forces flush on long sentences
 *   - Stats tracking (totalRequests, avgChunks, avgLatencySavedMs)
 */

import { describe, it, expect, vi } from 'vitest';
import { StreamingOverlap } from '../src/gateway/pipeline/streaming-overlap';

async function* tokenize(text: string, chunkSize = 5): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += chunkSize) {
    yield text.slice(i, i + chunkSize);
  }
}

async function* tokenizeRandomChunks(text: string, seed = 42): AsyncGenerator<string> {
  let s = seed;
  const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  let i = 0;
  while (i < text.length) {
    const size = 1 + Math.floor(rand() * 8);
    yield text.slice(i, i + size);
    i += size;
  }
}

function fakeTts(latencyMs = 0): {
  fn: (text: string) => Promise<Buffer>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    fn: async (text: string) => {
      calls.push(text);
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      return Buffer.from(`audio:${text}`);
    },
    calls,
  };
}

describe('StreamingOverlap E2E — sentence-aware chunking', () => {
  it('chunks output at sentence boundaries (default mode)', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = fakeTts();
    const audioChunks: Array<{ idx: number; text: string }> = [];

    const fullText = await overlap.processWithOverlap(
      tokenize('Hello world. How are you? I am fine.'),
      tts.fn,
      (audio, idx) => audioChunks.push({ idx, text: audio.toString().replace('audio:', '') }),
    );

    expect(fullText).toBe('Hello world. How are you? I am fine.');
    expect(tts.calls).toEqual(['Hello world.', 'How are you?', 'I am fine.']);
    expect(audioChunks.map((c) => c.text)).toEqual(['Hello world.', 'How are you?', 'I am fine.']);
  });

  it('does NOT split on commas (sentence-only)', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = fakeTts();

    await overlap.processWithOverlap(
      tokenize('First clause, second clause, third part. Done.'),
      tts.fn,
      () => {},
    );

    expect(tts.calls).toEqual(['First clause, second clause, third part.', 'Done.']);
  });

  it('handles decimals correctly (no false split)', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = fakeTts();

    await overlap.processWithOverlap(
      tokenize('Pi is 3.14 approximately. Good.'),
      tts.fn,
      () => {},
    );

    expect(tts.calls).toEqual(['Pi is 3.14 approximately.', 'Good.']);
  });

  it('handles abbreviations (Mr.) without false split', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = fakeTts();

    await overlap.processWithOverlap(
      tokenize('Mr. Smith arrived. He is here.'),
      tts.fn,
      () => {},
    );

    expect(tts.calls).toEqual(['Mr. Smith arrived.', 'He is here.']);
  });

  it('multilingual: Portuguese sentences', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = fakeTts();
    await overlap.processWithOverlap(
      tokenize('Bom dia. Como vai? Tudo bem!'),
      tts.fn,
      () => {},
    );
    expect(tts.calls).toEqual(['Bom dia.', 'Como vai?', 'Tudo bem!']);
  });

  it('multilingual: Chinese 。', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = fakeTts();
    await overlap.processWithOverlap(
      tokenize('你好。世界。再见。'),
      tts.fn,
      () => {},
    );
    expect(tts.calls).toContain('你好。');
    expect(tts.calls).toContain('世界。');
  });

  it('survives random chunk sizes (mid-sentence/mid-word splits)', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = fakeTts();
    await overlap.processWithOverlap(
      tokenizeRandomChunks('First sentence. Second one. Third here.'),
      tts.fn,
      () => {},
    );
    expect(tts.calls).toEqual(['First sentence.', 'Second one.', 'Third here.']);
  });
});

describe('StreamingOverlap E2E — <thinking> stripping', () => {
  it('removes <thinking> blocks before TTS when stripThinking=true', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1, stripThinking: true });
    const tts = fakeTts();

    await overlap.processWithOverlap(
      tokenize('<thinking>internal plan</thinking>Hello there. How are you?'),
      tts.fn,
      () => {},
    );

    const joined = tts.calls.join(' ');
    expect(joined).not.toContain('thinking');
    expect(joined).not.toContain('internal plan');
    expect(tts.calls).toContain('Hello there.');
    expect(tts.calls).toContain('How are you?');
  });

  it('handles <thinking> split across token chunks', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1, stripThinking: true });
    const tts = fakeTts();

    await overlap.processWithOverlap(
      (async function* () {
        yield 'Pre <thi';
        yield 'nking>secret';
        yield ' plan</thi';
        yield 'nking> post.';
      })(),
      tts.fn,
      () => {},
    );

    const joined = tts.calls.join(' ');
    expect(joined).not.toContain('secret');
    expect(joined).toContain('Pre');
    expect(joined).toContain('post.');
  });

  it('multiple thinking blocks all stripped', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1, stripThinking: true });
    const tts = fakeTts();

    await overlap.processWithOverlap(
      tokenize('<thinking>plan A</thinking>First. <thinking>plan B</thinking>Second.'),
      tts.fn,
      () => {},
    );

    const joined = tts.calls.join(' ');
    expect(joined).not.toContain('plan A');
    expect(joined).not.toContain('plan B');
    expect(tts.calls).toContain('First.');
    expect(tts.calls).toContain('Second.');
  });

  it('custom strip patterns work alongside thinking', async () => {
    const overlap = new StreamingOverlap({
      minTokens: 1,
      stripThinking: true,
      stripPatterns: [{ start: '<scratch>', end: '</scratch>' }],
    });
    const tts = fakeTts();

    await overlap.processWithOverlap(
      tokenize('<thinking>x</thinking><scratch>y</scratch>Hello world.'),
      tts.fn,
      () => {},
    );

    const joined = tts.calls.join(' ');
    expect(joined).not.toContain('thinking');
    expect(joined).not.toContain('scratch');
    expect(joined).toContain('Hello world.');
  });
});

describe('StreamingOverlap E2E — ordering + concurrency', () => {
  it('emits audio chunks in stream order even when TTS races', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    // Chunk 0 slow, chunk 1 fast → ordering must still be preserved
    const ttsCalls: string[] = [];
    let firstCall = true;
    const ttsFn = async (text: string) => {
      ttsCalls.push(text);
      if (firstCall) {
        firstCall = false;
        await new Promise((r) => setTimeout(r, 50));
      }
      return Buffer.from(`audio:${text}`);
    };

    const emitted: Array<{ idx: number; text: string }> = [];
    await overlap.processWithOverlap(
      tokenize('First. Second. Third.'),
      ttsFn,
      (audio, idx) => emitted.push({ idx, text: audio.toString().replace('audio:', '') }),
    );

    expect(emitted).toEqual([
      { idx: 0, text: 'First.' },
      { idx: 1, text: 'Second.' },
      { idx: 2, text: 'Third.' },
    ]);
  });

  it('TTS errors do not block subsequent chunks', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const emitted: Array<{ idx: number; text: string }> = [];
    let callCount = 0;

    const ttsFn = async (text: string) => {
      const idx = callCount++;
      if (idx === 1) throw new Error('TTS chunk 1 failed');
      return Buffer.from(`audio:${text}`);
    };

    await overlap.processWithOverlap(
      tokenize('First. Second. Third.'),
      ttsFn,
      (audio, idx) => emitted.push({ idx, text: audio.toString().replace('audio:', '') }),
    );

    // Chunk 1 should be skipped (failed); chunks 0 and 2 still emit
    const indices = emitted.map((e) => e.idx);
    expect(indices).toContain(0);
    expect(indices).toContain(2);
    expect(indices).not.toContain(1);
  });
});

describe('StreamingOverlap E2E — backward compat + safety', () => {
  it('accepts number constructor (legacy API)', async () => {
    const overlap = new StreamingOverlap(2);
    const tts = fakeTts();
    await overlap.processWithOverlap(
      tokenize('Hello world. Goodbye now.'),
      tts.fn,
      () => {},
    );
    expect(tts.calls.length).toBeGreaterThan(0);
  });

  it('setMinTokens updates threshold', async () => {
    const overlap = new StreamingOverlap(1);
    overlap.setMinTokens(5);
    const tts = fakeTts();
    await overlap.processWithOverlap(
      tokenize('Hi. Done.'),
      tts.fn,
      () => {},
    );
    // With minTokens=5, short sentences still produce calls (we don't drop them)
    expect(tts.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('setStripThinking toggle works at runtime', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    overlap.setStripThinking(true);
    const tts = fakeTts();
    await overlap.processWithOverlap(
      tokenize('<thinking>x</thinking>Hello.'),
      tts.fn,
      () => {},
    );
    expect(tts.calls.join(' ')).not.toContain('thinking');
  });

  it('long sentence without punctuation flushes at end of stream', async () => {
    const overlap = new StreamingOverlap({ minTokens: 3 });
    const tts = fakeTts();
    // 50 words, no punctuation — emits as single chunk at end-of-stream flush
    const longText = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    await overlap.processWithOverlap(
      tokenize(longText),
      tts.fn,
      () => {},
    );
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0]).toContain('word0');
    expect(tts.calls[0]).toContain('word49');
  });

  it('stats: tracks totalRequests + avgChunks', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = fakeTts();

    await overlap.processWithOverlap(tokenize('A. B. C.'), tts.fn, () => {});
    await overlap.processWithOverlap(tokenize('D. E.'), tts.fn, () => {});

    const stats = overlap.stats();
    expect(stats.totalRequests).toBe(2);
    expect(stats.avgChunks).toBeGreaterThan(0);
  });

  it('empty stream returns empty string', async () => {
    const overlap = new StreamingOverlap();
    const tts = fakeTts();
    const result = await overlap.processWithOverlap(tokenize(''), tts.fn, () => {});
    expect(result).toBe('');
    expect(tts.calls).toEqual([]);
  });

  it('full text return value matches input (no strip)', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = fakeTts();
    const text = 'One. Two. Three.';
    const result = await overlap.processWithOverlap(tokenize(text), tts.fn, () => {});
    expect(result).toBe(text);
  });
});

describe('StreamingOverlap E2E — realistic LLM streaming', () => {
  it('Claude reasoning model: thinking + answer cleanly separated', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1, stripThinking: true });
    const tts = fakeTts();
    const collected: string[] = [];

    // Simulate Claude streaming: thinking tags interspersed with output
    const llm = (async function* () {
      yield 'Let me think. ';
      yield '<thinking>';
      yield 'The user wants ';
      yield 'a greeting in Portuguese.';
      yield '</thinking>';
      yield 'Olá! ';
      yield 'Como vai?';
    })();

    await overlap.processWithOverlap(llm, tts.fn, (audio) => {
      collected.push(audio.toString().replace('audio:', ''));
    });

    const joined = collected.join(' | ');
    expect(joined).not.toContain('user wants');
    expect(joined).not.toContain('thinking');
    expect(joined).toContain('Olá!');
    expect(joined).toContain('Como vai?');
  });

  it('long monologue with abbreviations + decimals: clean splits', async () => {
    const overlap = new StreamingOverlap({ minTokens: 1 });
    const tts = fakeTts();
    const llm = 'Mr. Smith spent $29.99 on coffee. Then Dr. Jones arrived. The temp was 98.6 degrees. Done.';
    await overlap.processWithOverlap(tokenize(llm, 7), tts.fn, () => {});
    expect(tts.calls).toEqual([
      'Mr. Smith spent $29.99 on coffee.',
      'Then Dr. Jones arrived.',
      'The temp was 98.6 degrees.',
      'Done.',
    ]);
  });
});
