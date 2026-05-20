import { describe, it, expect } from 'vitest';
import { SentenceAggregator } from '../src/llm-context/sentence-aggregator';

async function collect(agg: SentenceAggregator, chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const chunk of chunks) {
    for await (const a of agg.aggregate(chunk)) out.push(a.text);
  }
  const tail = await agg.flush();
  if (tail) out.push(tail.text);
  return out;
}

describe('SentenceAggregator', () => {
  it('emits one sentence per period+space', async () => {
    const agg = new SentenceAggregator();
    const out = await collect(agg, ['Hello world. ', 'Next one. ']);
    expect(out).toEqual(['Hello world.', 'Next one.']);
  });

  it('streams char-by-char correctly', async () => {
    const agg = new SentenceAggregator();
    const out = await collect(agg, [...'First sentence. Second one.']);
    expect(out).toEqual(['First sentence.', 'Second one.']);
  });

  it('does not split on decimal numbers', async () => {
    const agg = new SentenceAggregator();
    const out = await collect(agg, ['Pi is 3.14 approximately.']);
    expect(out).toEqual(['Pi is 3.14 approximately.']);
  });

  it('REGRESSION: splits when next sentence starts with a digit (period+space+digit)', async () => {
    const agg = new SentenceAggregator();
    const out = await collect(agg, ['We met. 5 minutes later.']);
    expect(out).toEqual(['We met.', '5 minutes later.']);
  });

  it('does not split on common abbreviations', async () => {
    const agg = new SentenceAggregator();
    const out = await collect(agg, ['Mr. Smith said hello.']);
    expect(out).toEqual(['Mr. Smith said hello.']);
  });

  it('handles question and exclamation marks', async () => {
    const agg = new SentenceAggregator();
    const out = await collect(agg, ['Really? Yes! Done.']);
    expect(out).toEqual(['Really?', 'Yes!', 'Done.']);
  });

  it('handles non-Latin sentence-ending punctuation without lookahead', async () => {
    const agg = new SentenceAggregator();
    const out = await collect(agg, ['你好。世界。']);
    expect(out).toEqual(['你好。', '世界。']);
  });

  it('flush returns trailing partial sentence', async () => {
    const agg = new SentenceAggregator();
    const out = await collect(agg, ['Incomplete fragment']);
    expect(out).toEqual(['Incomplete fragment']);
  });

  it('reset clears buffer', async () => {
    const agg = new SentenceAggregator();
    for await (const _ of agg.aggregate('partial ')) { /* consume */ }
    await agg.reset();
    const tail = await agg.flush();
    expect(tail).toBeNull();
  });

  it('token mode passes text through immediately', async () => {
    const agg = new SentenceAggregator({ aggregationType: 'token' });
    const out = await collect(agg, ['hello', ' ', 'world']);
    expect(out).toEqual(['hello', ' ', 'world']);
  });
});
