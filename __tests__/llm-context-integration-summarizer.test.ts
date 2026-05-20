/**
 * Integration: long conversation auto-compaction.
 *
 * Simulates 30+ turn conversation with mock LLM. Verifies:
 *   - summary fires at threshold
 *   - recent N messages preserved verbatim
 *   - compacted context still passes through provider adapters
 *   - re-compaction works after additional turns
 */

import { describe, it, expect, vi } from 'vitest';
import { LLMContextSummarizer, estimateTokens } from '../src/llm-context/context-summarizer';
import { toOpenAI } from '../src/llm-context/adapters/openai';
import { toAnthropic } from '../src/llm-context/adapters/anthropic';
import { toGemini } from '../src/llm-context/adapters/gemini';
import type { Message } from '../src/llm-context/types';

const sys = (text: string): Message => ({ role: 'system', content: text });
const user = (text: string): Message => ({ role: 'user', content: text });
const asst = (text: string): Message => ({ role: 'assistant', content: text });

function mockLLMSummarizer(): ReturnType<typeof vi.fn> {
  return vi.fn(async (msgs: Message[]) => {
    const turnCount = msgs.length;
    const firstText = typeof msgs[0]?.content === 'string' ? msgs[0].content : '';
    return `[Summary of ${turnCount} turns starting with "${firstText.slice(0, 30)}"]`;
  });
}

describe('llm-context summarizer integration', () => {
  it('compacts when message count exceeds threshold', async () => {
    const summarize = mockLLMSummarizer();
    const summarizer = new LLMContextSummarizer(summarize, {
      maxContextTokens: null,
      maxUnsummarizedMessages: 10,
      minMessagesAfterSummary: 4,
    });

    let messages: Message[] = [sys('You are helpful.')];
    for (let i = 0; i < 12; i++) {
      messages.push(i % 2 ? asst(`assistant turn ${i}`) : user(`user turn ${i}`));
      summarizer.trackAppended();
    }

    expect(messages).toHaveLength(13);
    messages = await summarizer.compact(messages);

    expect(summarize).toHaveBeenCalledOnce();
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('system');
    expect(messages[1].content).toContain('Summary');
    expect(messages.length).toBe(6); // sys + summary + 4 recent
  });

  it('does not summarize on every turn — incremental tracking', async () => {
    const summarize = mockLLMSummarizer();
    const summarizer = new LLMContextSummarizer(summarize, {
      maxContextTokens: null,
      maxUnsummarizedMessages: 8,
      minMessagesAfterSummary: 3,
    });

    let messages: Message[] = [sys('S')];
    // First 5 turns — under threshold
    for (let i = 0; i < 5; i++) {
      messages.push(user(`u${i}`));
      summarizer.trackAppended();
    }
    let result = await summarizer.compact(messages);
    expect(summarize).not.toHaveBeenCalled();
    expect(result).toEqual(messages);

    // 4 more turns — crosses threshold
    for (let i = 5; i < 9; i++) {
      messages.push(user(`u${i}`));
      summarizer.trackAppended();
    }
    result = await summarizer.compact(messages);
    expect(summarize).toHaveBeenCalledOnce();
  });

  it('compacted context fits all 3 provider adapters', async () => {
    const summarize = mockLLMSummarizer();
    const summarizer = new LLMContextSummarizer(summarize, {
      maxContextTokens: null,
      maxUnsummarizedMessages: 6,
      minMessagesAfterSummary: 2,
    });

    let messages: Message[] = [sys('Be helpful.')];
    for (let i = 0; i < 8; i++) {
      messages.push(i % 2 ? asst(`response ${i}`) : user(`question ${i}`));
      summarizer.trackAppended();
    }
    messages = await summarizer.compact(messages);

    const oai = toOpenAI(messages);
    expect(oai.messages.length).toBeGreaterThan(0);
    expect(oai.messages[0].role).toBe('system');

    const claude = toAnthropic(messages);
    expect(claude.system).toBeDefined();
    expect(claude.system).toContain('Summary');
    expect(claude.messages.every((m) => m.role !== ('system' as never))).toBe(true);

    const gemini = toGemini(messages);
    expect(gemini.systemInstruction).toBeDefined();
    const allSystemText = (gemini.systemInstruction!.parts as Array<{ text?: string }>)
      .map((p) => p.text ?? '').join(' ');
    expect(allSystemText).toContain('Summary');
  });

  it('handles repeated compactions across many turns', async () => {
    const summarize = mockLLMSummarizer();
    const summarizer = new LLMContextSummarizer(summarize, {
      maxContextTokens: null,
      maxUnsummarizedMessages: 6,
      minMessagesAfterSummary: 2,
    });

    let messages: Message[] = [sys('S')];
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 7; i++) {
        messages.push(user(`r${round}u${i}`));
        summarizer.trackAppended();
      }
      messages = await summarizer.compact(messages);
    }

    expect(summarize).toHaveBeenCalledTimes(4);
    // After 4 rounds: still small (sys + summary + 2 recent)
    expect(messages.length).toBeLessThanOrEqual(6);
  });

  it('token estimate roughly tracks character count', () => {
    const small = [user('hi')];
    const big = [user('a'.repeat(4000))];
    const smallTokens = estimateTokens(small);
    const bigTokens = estimateTokens(big);
    expect(bigTokens).toBeGreaterThan(smallTokens * 50);
    expect(bigTokens).toBeGreaterThanOrEqual(1000);
    expect(bigTokens).toBeLessThanOrEqual(1100);
  });

  it('triggers on token count when maxContextTokens set', async () => {
    const summarize = mockLLMSummarizer();
    const summarizer = new LLMContextSummarizer(summarize, {
      maxContextTokens: 200,
      maxUnsummarizedMessages: null,
      minMessagesAfterSummary: 1,
    });
    // Need at least 2 non-system messages so toSummarize is not empty.
    const messages = [sys('S'), user('x'.repeat(800)), asst('y')];
    await summarizer.compact(messages);
    expect(summarize).toHaveBeenCalledOnce();
  });
});
