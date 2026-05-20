import { describe, it, expect, vi } from 'vitest';
import { LLMContextSummarizer, estimateTokens } from '../src/llm-context/context-summarizer';
import type { Message } from '../src/llm-context/types';

const sys: Message = { role: 'system', content: 'You are helpful.' };
const turn = (role: 'user' | 'assistant', text: string): Message => ({ role, content: text });

describe('LLMContextSummarizer', () => {
  it('estimateTokens counts text + image blocks', () => {
    const messages: Message[] = [
      { role: 'user', content: 'a'.repeat(40) },
      { role: 'assistant', content: [{ type: 'image', url: 'x' }, { type: 'text', text: 'b'.repeat(20) }] },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(500);
  });

  it('does not summarize below threshold', async () => {
    const summarize = vi.fn(async () => 'SUMMARY');
    const summarizer = new LLMContextSummarizer(summarize, { maxContextTokens: 10_000, maxUnsummarizedMessages: 100 });
    const messages = [sys, turn('user', 'hi'), turn('assistant', 'hello')];
    const out = await summarizer.compact(messages);
    expect(out).toEqual(messages);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('compacts when message count threshold crossed', async () => {
    const summarize = vi.fn(async () => 'TURNS_1_TO_6_SUMMARY');
    const summarizer = new LLMContextSummarizer(summarize, {
      maxContextTokens: null,
      maxUnsummarizedMessages: 6,
      minMessagesAfterSummary: 2,
    });
    const messages: Message[] = [sys];
    for (let i = 0; i < 8; i++) {
      messages.push(turn(i % 2 ? 'assistant' : 'user', `turn ${i}`));
      summarizer.trackAppended();
    }
    const out = await summarizer.compact(messages);
    expect(summarize).toHaveBeenCalledOnce();
    expect(out[0]).toEqual(sys);
    expect(out[1].role).toBe('system');
    expect(out[1].content).toContain('TURNS_1_TO_6_SUMMARY');
    expect(out.length).toBe(4); // sys + summary + 2 recent
  });

  it('preserves recent N messages verbatim', async () => {
    const summarize = vi.fn(async () => 'X');
    const summarizer = new LLMContextSummarizer(summarize, {
      maxContextTokens: null,
      maxUnsummarizedMessages: 4,
      minMessagesAfterSummary: 3,
    });
    const recent = [turn('user', 'recent A'), turn('assistant', 'recent B'), turn('user', 'recent C')];
    const messages = [sys, turn('user', 'old1'), turn('assistant', 'old2'), ...recent];
    for (let i = 0; i < 5; i++) summarizer.trackAppended();
    const out = await summarizer.compact(messages);
    const tail = out.slice(-3);
    expect(tail).toEqual(recent);
  });

  it('rejects invalid config', () => {
    expect(() => new LLMContextSummarizer(async () => '', {
      maxContextTokens: null, maxUnsummarizedMessages: null,
    })).toThrow();
    expect(() => new LLMContextSummarizer(async () => '', {
      maxContextTokens: -1,
    })).toThrow();
  });
});
