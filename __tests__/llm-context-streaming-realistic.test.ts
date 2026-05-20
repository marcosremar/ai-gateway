/**
 * Realistic streaming scenarios — mirrors actual LLM token output.
 *
 * Tests with: variable chunk sizes, mid-word splits, code blocks,
 * unicode emoji, multilingual text, very fast small chunks.
 */

import { describe, it, expect } from 'vitest';
import { SentenceAggregator } from '../src/llm-context/sentence-aggregator';
import { PatternPairAggregator } from '../src/llm-context/pattern-pair-aggregator';

async function feed(agg: SentenceAggregator, chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of chunks) {
    for await (const a of agg.aggregate(c)) out.push(a.text);
  }
  const tail = await agg.flush();
  if (tail) out.push(tail.text);
  return out;
}

async function feedPattern(agg: PatternPairAggregator, chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of chunks) {
    for await (const a of agg.aggregate(c)) out.push(a.text);
  }
  const tail = await agg.flush();
  if (tail) out.push(tail.text);
  return out;
}

describe('SentenceAggregator — realistic streaming', () => {
  it('handles mid-word splits (LLM tokenizer chunks)', async () => {
    // Simulate Anthropic-style streaming where chunks split mid-word
    const out = await feed(new SentenceAggregator(), [
      'Hel', 'lo wor', 'ld. Th', 'is is a', ' test.',
    ]);
    expect(out).toEqual(['Hello world.', 'This is a test.']);
  });

  it('handles single-char chunks (worst case)', async () => {
    const out = await feed(new SentenceAggregator(), [...'One. Two. Three.']);
    expect(out).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('handles emoji in sentences', async () => {
    const out = await feed(new SentenceAggregator(), ['Hi 👋 there. Bye 👋.']);
    expect(out[0]).toContain('👋');
    expect(out).toHaveLength(2);
  });

  it('handles Portuguese text', async () => {
    const out = await feed(new SentenceAggregator(), [
      'Bom dia. Como vai? Tudo bem!',
    ]);
    expect(out).toEqual(['Bom dia.', 'Como vai?', 'Tudo bem!']);
  });

  it('handles Spanish with inverted punctuation', async () => {
    const out = await feed(new SentenceAggregator(), [
      '¿Cómo estás? ¡Muy bien! Gracias.',
    ]);
    expect(out).toHaveLength(3);
  });

  it('handles Chinese (no Latin disambiguation needed)', async () => {
    const out = await feed(new SentenceAggregator(), ['你好。世界，再见！谢谢。']);
    expect(out).toContain('你好。');
  });

  it('survives empty chunks interleaved', async () => {
    const out = await feed(new SentenceAggregator(), ['', 'Hi.', '', ' Bye.', '']);
    expect(out).toEqual(['Hi.', 'Bye.']);
  });

  it('long conversation never drops content', async () => {
    const sentences = Array.from({ length: 50 }, (_, i) => `Sentence number ${i}.`);
    const stream = sentences.join(' ');
    const chunks = [];
    for (let i = 0; i < stream.length; i += 7) chunks.push(stream.slice(i, i + 7));

    const out = await feed(new SentenceAggregator(), chunks);
    expect(out).toHaveLength(50);
    expect(out[0]).toBe('Sentence number 0.');
    expect(out[49]).toBe('Sentence number 49.');
  });
});

describe('PatternPairAggregator — realistic LLM output', () => {
  it('Claude reasoning model: <thinking> across chunks', async () => {
    const tokens = [
      'Let me ',
      '<thinking>',
      'The user is asking ',
      'about weather. I should ',
      'check the location first.',
      '</thinking>',
      'I need your location ',
      'first. Where are you?',
    ];
    const agg = new PatternPairAggregator();
    agg.addPattern('thinking', '<thinking>', '</thinking>', 'remove');

    const out = await feedPattern(agg, tokens);
    const joined = out.join(' ');
    expect(joined).not.toContain('thinking');
    expect(joined).not.toContain('weather. I should');
    expect(joined).toContain('I need your location');
  });

  it('multiple custom patterns coexist', async () => {
    const collected: Record<string, string[]> = { thinking: [], code: [] };
    const agg = new PatternPairAggregator();
    agg
      .addPattern('thinking', '<thinking>', '</thinking>', 'remove')
      .addPattern('code', '<code>', '</code>', 'aggregate')
      .onPatternMatch('thinking', async (m) => collected.thinking.push(m.text))
      .onPatternMatch('code', async (m) => collected.code.push(m.text));

    await feedPattern(agg, [
      'Here ',
      '<thinking>plan</thinking>',
      'is some ',
      '<code>let x = 1;</code>',
      ' code. ',
      'Done.',
    ]);

    expect(collected.thinking).toEqual(['plan']);
    expect(collected.code).toEqual(['let x = 1;']);
  });

  it('handler errors do not break aggregation', async () => {
    const agg = new PatternPairAggregator();
    agg
      .addPattern('thinking', '<thinking>', '</thinking>', 'remove')
      .onPatternMatch('thinking', async () => {
        throw new Error('handler boom');
      });

    const out = await feedPattern(agg, ['Hi <thinking>x</thinking> there.']);
    expect(out.join(' ')).toContain('Hi  there.');
  });

  it('interruption clears buffered partial pattern', async () => {
    const agg = new PatternPairAggregator();
    agg.addPattern('thinking', '<thinking>', '</thinking>', 'remove');

    for await (const _ of agg.aggregate('Pre <thinking>partial')) { /* discard */ }
    await agg.handleInterruption();

    const out = await feedPattern(agg, ['New message here.']);
    expect(out).toEqual(['New message here.']);
  });
});
