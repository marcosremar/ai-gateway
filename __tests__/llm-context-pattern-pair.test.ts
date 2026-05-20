import { describe, it, expect, vi } from 'vitest';
import { PatternPairAggregator } from '../src/llm-context/pattern-pair-aggregator';

async function collect(agg: PatternPairAggregator, chunks: string[]) {
  const out: Array<{ text: string; type: string }> = [];
  for (const c of chunks) {
    for await (const m of agg.aggregate(c)) out.push({ text: m.text, type: m.type });
  }
  const tail = await agg.flush();
  if (tail) out.push({ text: tail.text, type: tail.type });
  return out;
}

describe('PatternPairAggregator', () => {
  it('REMOVE strips <thinking> blocks before TTS', async () => {
    const agg = new PatternPairAggregator().addPattern('thinking', '<thinking>', '</thinking>', 'remove');
    const out = await collect(agg, ['Hello <thinking>internal</thinking> world.']);
    expect(out).toEqual([{ text: 'Hello  world.', type: 'sentence' }]);
  });

  it('AGGREGATE emits content as separate block', async () => {
    const agg = new PatternPairAggregator().addPattern('code', '<code>', '</code>', 'aggregate');
    const out = await collect(agg, ['Run this <code>let x = 1;</code> ok? ']);
    expect(out).toEqual([
      { text: 'Run this', type: 'sentence' },
      { text: 'let x = 1;', type: 'code' },
      { text: 'ok?', type: 'sentence' },
    ]);
  });

  it('KEEP leaves text intact and fires handler', async () => {
    const handler = vi.fn();
    const agg = new PatternPairAggregator()
      .addPattern('em', '<em>', '</em>', 'keep')
      .onPatternMatch('em', handler);
    const out = await collect(agg, ['Say <em>hello</em> there.']);
    expect(out[0].text).toContain('hello');
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].text).toBe('hello');
  });

  it('handles pattern split across chunks', async () => {
    const agg = new PatternPairAggregator().addPattern('thinking', '<thinking>', '</thinking>', 'remove');
    const out = await collect(agg, ['Pre <thi', 'nking>secret</thi', 'nking> post.']);
    expect(out).toEqual([{ text: 'Pre  post.', type: 'sentence' }]);
  });

  it('fires handler on match', async () => {
    const handler = vi.fn();
    const agg = new PatternPairAggregator()
      .addPattern('thinking', '<thinking>', '</thinking>', 'remove')
      .onPatternMatch('thinking', handler);
    await collect(agg, ['Hi <thinking>reasoning</thinking>.']);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].text).toBe('reasoning');
  });

  it('rejects reserved type names', () => {
    const agg = new PatternPairAggregator();
    expect(() => agg.addPattern('sentence', '<a>', '</a>')).toThrow();
    expect(() => agg.addPattern('token', '<a>', '</a>')).toThrow();
  });
});
