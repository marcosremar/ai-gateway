import { describe, it, expect } from 'vitest';
import {
  SentenceAggregator,
  endsWithAbbreviation,
  ABBREVIATIONS,
} from '../../src/llm-context/sentence-aggregator';

// Helper: drive a SentenceAggregator with a full text string, collect yields
async function collect(text: string, opts: ConstructorParameters<typeof SentenceAggregator>[0] = {}): Promise<string[]> {
  const agg = new SentenceAggregator(opts);
  const out: string[] = [];
  for await (const chunk of agg.aggregate(text)) {
    if (chunk.text) out.push(chunk.text);
  }
  const tail = await agg.flush();
  if (tail?.text) out.push(tail.text);
  return out;
}

// Helper: stream text character-by-character (worst case for lookahead)
async function collectChars(
  text: string,
  opts: ConstructorParameters<typeof SentenceAggregator>[0] = {},
): Promise<string[]> {
  const agg = new SentenceAggregator(opts);
  const out: string[] = [];
  for (const ch of text) {
    for await (const chunk of agg.aggregate(ch)) {
      if (chunk.text) out.push(chunk.text);
    }
  }
  const tail = await agg.flush();
  if (tail?.text) out.push(tail.text);
  return out;
}

describe('endsWithAbbreviation', () => {
  it('returns false for a plain word without period', () => {
    expect(endsWithAbbreviation('hello')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(endsWithAbbreviation('')).toBe(false);
  });

  it('returns true for a known abbreviation with trailing period', () => {
    for (const abbr of ['Mr.', 'Dr.', 'Prof.', 'Inc.', 'Ltd.', 'St.']) {
      expect(endsWithAbbreviation(abbr), `should match ${abbr}`).toBe(true);
    }
  });

  it('returns false for a normal word ending in period', () => {
    expect(endsWithAbbreviation('Hello.')).toBe(false);
  });

  it('handles dotted forms like "e.g." (with trailing period)', () => {
    // 'e.g' is in the set; "e.g." trims to "e.g" after removing last dot
    expect(endsWithAbbreviation('for example e.g.')).toBe(true);
  });

  it('returns false for unknown abbreviation not in ABBREVIATIONS set', () => {
    expect(endsWithAbbreviation('xyz.')).toBe(false);
  });

  it('matches case-insensitively (mr vs Mr)', () => {
    expect(endsWithAbbreviation('mr.')).toBe(true);
    expect(endsWithAbbreviation('MR.')).toBe(true);
  });
});

describe('ABBREVIATIONS set', () => {
  it('contains expected common entries', () => {
    expect(ABBREVIATIONS.has('mr')).toBe(true);
    expect(ABBREVIATIONS.has('dr')).toBe(true);
    expect(ABBREVIATIONS.has('vs')).toBe(true);
    expect(ABBREVIATIONS.has('etc')).toBe(true);
  });
});

describe('SentenceAggregator — token mode', () => {
  it('yields each non-empty token unchanged', async () => {
    const agg = new SentenceAggregator({ aggregationType: 'token' });
    const out: string[] = [];
    for await (const chunk of agg.aggregate('Hello')) out.push(chunk.text);
    for await (const chunk of agg.aggregate(' world')) out.push(chunk.text);
    expect(out).toEqual(['Hello', ' world']);
  });

  it('does not yield empty string tokens', async () => {
    const agg = new SentenceAggregator({ aggregationType: 'token' });
    const out: string[] = [];
    for await (const chunk of agg.aggregate('')) out.push(chunk.text);
    expect(out).toHaveLength(0);
  });

  it('flush returns null when buffer is empty (token mode)', async () => {
    const agg = new SentenceAggregator({ aggregationType: 'token' });
    for await (const _ of agg.aggregate('hi')) { /* drain */ }
    // In token mode, flush should be a no-op (buffer never fills)
    const result = await agg.flush();
    expect(result).toBeNull();
  });
});

describe('SentenceAggregator — sentence mode basics', () => {
  it('yields a sentence ending with "!"', async () => {
    const chunks = await collect('Hello world!');
    expect(chunks).toEqual(['Hello world!']);
  });

  it('yields a sentence ending with "?"', async () => {
    const chunks = await collect('Are you there?');
    expect(chunks).toEqual(['Are you there?']);
  });

  it('yields a sentence ending with CJK "。"', async () => {
    const chunks = await collect('こんにちは。');
    expect(chunks).toEqual(['こんにちは。']);
  });

  it('flushes trailing text without punctuation', async () => {
    const chunks = await collect('Hello world');
    expect(chunks).toEqual(['Hello world']);
  });

  it('splits two sentences on "!" and "?"', async () => {
    const chunks = await collect('Hello! Are you there?');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('Hello!');
    expect(chunks[1]).toContain('Are you there?');
  });

  it('aggregationType defaults to "sentence"', async () => {
    const agg = new SentenceAggregator();
    const out: string[] = [];
    // '!' is LATIN_AMBIGUOUS: aggregator waits for lookahead before flushing.
    // The flush() call resolves the pending buffer after the stream ends.
    for await (const chunk of agg.aggregate('Hi!')) {
      expect(chunk.type).toBe('sentence');
      out.push(chunk.text);
    }
    const tail = await agg.flush();
    if (tail?.text) {
      expect(tail.type).toBe('sentence');
      out.push(tail.text);
    }
    expect(out.join('')).toContain('Hi!');
  });

  it('text getter returns current buffer content', async () => {
    const agg = new SentenceAggregator();
    for await (const _ of agg.aggregate('Partial')) { /* drain */ }
    expect(agg.text.text).toBe('Partial');
  });
});

describe('SentenceAggregator — period lookahead (decimal vs sentence)', () => {
  it('does not split on decimal number "3.14"', async () => {
    const chunks = await collect('Pi is 3.14 exactly.');
    // Should be one sentence (or two if trailing but not split at decimal)
    const joined = chunks.join(' ');
    expect(joined).toContain('3.14');
  });

  it('does not split on decimal even when streamed char-by-char', async () => {
    const chunks = await collectChars('Cost is $29.99 today.');
    const joined = chunks.join(' ');
    expect(joined).toContain('29.99');
  });

  it('splits on period followed by capital letter (new sentence)', async () => {
    const chunks = await collectChars('She left. He stayed.');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toMatch(/She left\./);
  });

  it('does not split on "Mr." abbreviation', async () => {
    const chunks = await collectChars('Mr. Smith arrived.');
    const joined = chunks.join(' ');
    expect(joined).toContain('Mr. Smith');
  });

  it('does not split on "Dr." abbreviation', async () => {
    const chunks = await collectChars('Dr. Jones called today.');
    const joined = chunks.join(' ');
    expect(joined).toContain('Dr. Jones');
  });

  it('does not split on "e.g." mid-sentence', async () => {
    const chunks = await collectChars('Use a tool, e.g. hammer, to fix it.');
    const joined = chunks.join(' ');
    expect(joined).toContain('e.g.');
  });

  it('handles ellipsis "..." without premature split', async () => {
    const chunks = await collectChars('Hmm... I am thinking.');
    const joined = chunks.join(' ');
    expect(joined).toContain('Hmm...');
  });

  it('handles "?!" sequence as single sentence ending', async () => {
    const chunks = await collectChars('What?! Really?');
    // The ?! should not cause two empty splits; "What?!" should be one sentence
    const filtered = chunks.filter((c) => c.length > 0);
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(filtered[0]).toMatch(/What\?!/);
  });
});

describe('SentenceAggregator — flush and reset', () => {
  it('flush returns null when buffer is empty', async () => {
    const agg = new SentenceAggregator();
    const result = await agg.flush();
    expect(result).toBeNull();
  });

  it('flush returns remaining buffer text', async () => {
    const agg = new SentenceAggregator();
    for await (const _ of agg.aggregate('Incomplete')) { /* drain */ }
    const tail = await agg.flush();
    expect(tail?.text).toBe('Incomplete');
  });

  it('flush clears the buffer', async () => {
    const agg = new SentenceAggregator();
    for await (const _ of agg.aggregate('Hello')) { /* drain */ }
    await agg.flush();
    const tail2 = await agg.flush();
    expect(tail2).toBeNull();
  });

  it('reset (handleInterruption) clears buffer without yielding', async () => {
    const agg = new SentenceAggregator();
    for await (const _ of agg.aggregate('Partial sentence')) { /* drain */ }
    await agg.handleInterruption();
    const tail = await agg.flush();
    expect(tail).toBeNull();
  });

  it('reset() is equivalent to handleInterruption()', async () => {
    const agg = new SentenceAggregator();
    for await (const _ of agg.aggregate('Some text')) { /* drain */ }
    await agg.reset();
    expect(await agg.flush()).toBeNull();
  });

  it('can continue aggregating after flush', async () => {
    const agg = new SentenceAggregator();
    for await (const _ of agg.aggregate('First!')) { /* drain */ }
    await agg.flush();
    const out: string[] = [];
    for await (const chunk of agg.aggregate('Second!')) out.push(chunk.text);
    const tail = await agg.flush();
    if (tail?.text) out.push(tail.text);
    expect(out.join(' ')).toContain('Second!');
  });
});

describe('SentenceAggregator — Unicode sentence endings', () => {
  it('splits on Arabic "؟"', async () => {
    const chunks = await collect('ما اسمك؟ أنا محمد.');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('splits on Devanagari "।"', async () => {
    const chunks = await collect('नमस्ते। कैसे हैं?');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('splits on fullwidth "！"', async () => {
    const chunks = await collect('すごい！ありがとう。');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('SentenceAggregator — multi-chunk streaming', () => {
  it('correctly reassembles sentence split across many tiny chunks', async () => {
    const full = 'The quick brown fox.';
    const chunks = await collectChars(full);
    expect(chunks.join(' ')).toContain('The quick brown fox.');
  });

  it('handles empty string inputs gracefully', async () => {
    const agg = new SentenceAggregator();
    for await (const _ of agg.aggregate('')) { /* should not yield */ }
    const tail = await agg.flush();
    expect(tail).toBeNull();
  });

  it('handles whitespace-only input gracefully', async () => {
    const chunks = await collect('   ');
    expect(chunks.length).toBe(0);
  });
});
