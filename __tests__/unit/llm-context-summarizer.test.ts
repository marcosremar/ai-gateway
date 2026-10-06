/**
 * Unit tests for src/llm-context/context-summarizer.ts
 *
 * Covers:
 *  - Constructor: throws when both limits null
 *  - Constructor: throws on non-positive maxContextTokens
 *  - Constructor: throws on maxUnsummarizedMessages < 1
 *  - Constructor: throws on non-positive targetSummaryTokens
 *  - Constructor: throws on negative minMessagesAfterSummary
 *  - Constructor: valid with only maxContextTokens set (maxUnsummarizedMessages null)
 *  - Constructor: valid with only maxUnsummarizedMessages set (maxContextTokens null)
 *  - estimateTokens: empty array → 0
 *  - estimateTokens: string content
 *  - estimateTokens: multiple messages summed
 *  - estimateTokens: image block → IMAGE_TOKEN_ESTIMATE fixed cost
 *  - estimateTokens: tool_use block → JSON key size estimate
 *  - estimateTokens: tool_result block → content size estimate
 *  - estimateTokens: mixed ContentBlock array
 *  - isAutoSummary: true for zero-width-space-prefixed system message
 *  - isAutoSummary: false for system message without marker
 *  - isAutoSummary: false for non-system role even with marker
 *  - isAutoSummary: false when content is not a string
 *  - stripSummaryMarker: removes zero-width space prefix
 *  - stripSummaryMarker: returns string unchanged when no marker
 *  - trackAppended + shouldSummarize: triggers at maxUnsummarizedMessages
 *  - shouldSummarize: false before threshold
 *  - shouldSummarize: true when estimateTokens ≥ maxContextTokens
 *  - shouldSummarize: false when tokens below threshold
 *  - compact: returns same array when thresholds not crossed
 *  - compact: calls summarize with messages to summarize
 *  - compact: output preserves original system messages
 *  - compact: output contains summary message at position after system
 *  - compact: keeps minMessagesAfterSummary recent messages verbatim
 *  - compact: resets unsummarizedCount to keepCount after compaction
 *  - compact: idempotent when thresholds not crossed after first compact
 *  - compact: replaces prior auto-summary instead of stacking
 *  - compact: concurrent calls share single in-flight promise (summarize called once)
 *  - compact: uses custom summarizationPrompt
 *  - compact: uses custom summaryMessageTemplate {summary} placeholder
 *  - compact: noop when toSummarize is empty (all messages are in keepCount window)
 *  - compact: works when no system messages present
 *  - compact: works when only system messages present
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LLMContextSummarizer,
  isAutoSummary,
  stripSummaryMarker,
  estimateTokens,
  DEFAULT_SUMMARIZATION_PROMPT,
  type SummarizeFn,
  type AutoSummarizeOptions,
} from '../../src/llm-context/context-summarizer';
import type { Message } from '../../src/llm-context/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ZERO_WIDTH_SPACE = '​';

function makeUserMsg(content: string): Message {
  return { role: 'user', content };
}
function makeAssistantMsg(content: string): Message {
  return { role: 'assistant', content };
}
function makeSystemMsg(content: string): Message {
  return { role: 'system', content };
}

function makeSummarizeFn(returnValue = 'summary text'): SummarizeFn {
  return vi.fn(async () => returnValue);
}

/** Build a summarizer with sensible defaults; override via opts. */
function makeSummarizer(summarize?: SummarizeFn, opts?: AutoSummarizeOptions) {
  return new LLMContextSummarizer(
    summarize ?? makeSummarizeFn(),
    { maxContextTokens: 8000, maxUnsummarizedMessages: 20, ...opts },
  );
}

// ── Constructor validation ────────────────────────────────────────────────────

describe('LLMContextSummarizer — constructor', () => {
  it('throws when both maxContextTokens and maxUnsummarizedMessages are null', () => {
    expect(() =>
      new LLMContextSummarizer(makeSummarizeFn(), {
        maxContextTokens: null,
        maxUnsummarizedMessages: null,
      }),
    ).toThrow(/at least one/);
  });

  it('is valid with only maxContextTokens set', () => {
    expect(() =>
      new LLMContextSummarizer(makeSummarizeFn(), {
        maxContextTokens: 4000,
        maxUnsummarizedMessages: null,
      }),
    ).not.toThrow();
  });

  it('is valid with only maxUnsummarizedMessages set', () => {
    expect(() =>
      new LLMContextSummarizer(makeSummarizeFn(), {
        maxContextTokens: null,
        maxUnsummarizedMessages: 10,
      }),
    ).not.toThrow();
  });

  it('throws when maxContextTokens is 0', () => {
    expect(() =>
      new LLMContextSummarizer(makeSummarizeFn(), { maxContextTokens: 0 }),
    ).toThrow(/maxContextTokens must be positive/);
  });

  it('throws when maxContextTokens is negative', () => {
    expect(() =>
      new LLMContextSummarizer(makeSummarizeFn(), { maxContextTokens: -1 }),
    ).toThrow(/maxContextTokens must be positive/);
  });

  it('throws when maxUnsummarizedMessages is 0', () => {
    expect(() =>
      new LLMContextSummarizer(makeSummarizeFn(), {
        maxContextTokens: null,
        maxUnsummarizedMessages: 0,
      }),
    ).toThrow(/maxUnsummarizedMessages must be ≥ 1/);
  });

  it('throws when maxUnsummarizedMessages is negative', () => {
    expect(() =>
      new LLMContextSummarizer(makeSummarizeFn(), {
        maxContextTokens: null,
        maxUnsummarizedMessages: -5,
      }),
    ).toThrow(/maxUnsummarizedMessages must be ≥ 1/);
  });

  it('throws when targetSummaryTokens is 0', () => {
    expect(() =>
      new LLMContextSummarizer(makeSummarizeFn(), { targetSummaryTokens: 0 }),
    ).toThrow(/targetSummaryTokens must be positive/);
  });

  it('throws when targetSummaryTokens is negative', () => {
    expect(() =>
      new LLMContextSummarizer(makeSummarizeFn(), { targetSummaryTokens: -100 }),
    ).toThrow(/targetSummaryTokens must be positive/);
  });

  it('throws when minMessagesAfterSummary is negative', () => {
    expect(() =>
      new LLMContextSummarizer(makeSummarizeFn(), { minMessagesAfterSummary: -1 }),
    ).toThrow(/minMessagesAfterSummary must be ≥ 0/);
  });

  it('accepts minMessagesAfterSummary of 0', () => {
    expect(() =>
      new LLMContextSummarizer(makeSummarizeFn(), { minMessagesAfterSummary: 0 }),
    ).not.toThrow();
  });
});

// ── estimateTokens ────────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('estimates a single string-content message', () => {
    const msgs: Message[] = [{ role: 'user', content: 'abcd' }]; // 4 chars = 1 token + overhead
    const result = estimateTokens(msgs);
    // TOKEN_OVERHEAD_PER_MESSAGE(10) + ceil(4/4)=1 + ceil("user".length/4)=1
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(50); // sanity ceiling
  });

  it('estimate grows with more messages', () => {
    const few: Message[] = [makeUserMsg('hello')];
    const many: Message[] = Array.from({ length: 10 }, (_, i) => makeUserMsg(`message ${i}`));
    expect(estimateTokens(many)).toBeGreaterThan(estimateTokens(few));
  });

  it('estimates image blocks at fixed IMAGE_TOKEN_ESTIMATE (500)', () => {
    const msgWithImage: Message = {
      role: 'user',
      content: [{ type: 'image', url: 'data:image/png;base64,...' }],
    };
    const tokens = estimateTokens([msgWithImage]);
    // IMAGE_TOKEN_ESTIMATE = 500; overhead = 10; role = 1; total ≥ 500
    expect(tokens).toBeGreaterThanOrEqual(500);
  });

  it('estimates tool_use blocks from JSON input size', () => {
    const msgWithTool: Message = {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tu-1',
          name: 'search',
          input: { query: 'hello world' },
        },
      ],
    };
    const tokens = estimateTokens([msgWithTool]);
    expect(tokens).toBeGreaterThan(0);
  });

  it('estimates tool_result blocks from content length', () => {
    const msgWithResult: Message = {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'tu-1',
          content: 'The search result was very long and detailed with lots of information.',
        },
      ],
    };
    const tokens = estimateTokens([msgWithResult]);
    expect(tokens).toBeGreaterThan(0);
  });

  it('handles mixed ContentBlock array (text + image)', () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this image:' },
        { type: 'image', url: 'data:image/png;base64,...' },
      ],
    };
    const tokens = estimateTokens([msg]);
    // Must include image estimate (500) plus text estimate
    expect(tokens).toBeGreaterThanOrEqual(500);
  });

  it('multiple messages are summed, not averaged', () => {
    const single = estimateTokens([makeUserMsg('abc')]);
    const doubled = estimateTokens([makeUserMsg('abc'), makeUserMsg('abc')]);
    expect(doubled).toBeGreaterThan(single);
    // Should be approximately double (within rounding / role overhead)
    expect(doubled).toBeGreaterThanOrEqual(single * 2 - 5);
  });
});

// ── isAutoSummary / stripSummaryMarker ────────────────────────────────────────

describe('isAutoSummary', () => {
  it('returns true for a system message prefixed with zero-width space', () => {
    const msg: Message = { role: 'system', content: `${ZERO_WIDTH_SPACE}Conversation summary: ...` };
    expect(isAutoSummary(msg)).toBe(true);
  });

  it('returns false for a system message without the marker', () => {
    const msg: Message = { role: 'system', content: 'You are a helpful assistant.' };
    expect(isAutoSummary(msg)).toBe(false);
  });

  it('returns false for a user message even if it starts with the marker', () => {
    const msg: Message = { role: 'user', content: `${ZERO_WIDTH_SPACE}something` };
    expect(isAutoSummary(msg)).toBe(false);
  });

  it('returns false for an assistant message with the marker', () => {
    const msg: Message = { role: 'assistant', content: `${ZERO_WIDTH_SPACE}summary` };
    expect(isAutoSummary(msg)).toBe(false);
  });

  it('returns false when content is a ContentBlock array', () => {
    const msg: Message = {
      role: 'system',
      content: [{ type: 'text', text: `${ZERO_WIDTH_SPACE}summary` }],
    };
    expect(isAutoSummary(msg)).toBe(false);
  });
});

describe('stripSummaryMarker', () => {
  it('removes the zero-width space prefix', () => {
    const raw = `${ZERO_WIDTH_SPACE}Conversation summary: a, b, c.`;
    expect(stripSummaryMarker(raw)).toBe('Conversation summary: a, b, c.');
  });

  it('returns the string unchanged when it does not start with the marker', () => {
    const plain = 'You are a helpful assistant.';
    expect(stripSummaryMarker(plain)).toBe(plain);
  });

  it('returns empty string when input is only the marker', () => {
    expect(stripSummaryMarker(ZERO_WIDTH_SPACE)).toBe('');
  });
});

// ── trackAppended + shouldSummarize ──────────────────────────────────────────

describe('trackAppended + shouldSummarize', () => {
  it('shouldSummarize returns false before any threshold is reached', () => {
    const s = makeSummarizer(undefined, { maxUnsummarizedMessages: 3, maxContextTokens: null });
    const msgs: Message[] = [makeUserMsg('hi'), makeAssistantMsg('hello')];
    s.trackAppended();
    s.trackAppended();
    expect(s.shouldSummarize(msgs)).toBe(false);
  });

  it('shouldSummarize returns true once maxUnsummarizedMessages is reached', () => {
    const s = makeSummarizer(undefined, { maxUnsummarizedMessages: 3, maxContextTokens: null });
    s.trackAppended();
    s.trackAppended();
    s.trackAppended(); // count = 3 = threshold
    expect(s.shouldSummarize([makeUserMsg('a')])).toBe(true);
  });

  it('shouldSummarize returns true when token estimate meets maxContextTokens', () => {
    const s = makeSummarizer(undefined, { maxContextTokens: 1, maxUnsummarizedMessages: null });
    // Even a single short message will produce ≥ 1 token estimate
    const msgs: Message[] = [makeUserMsg('x')];
    expect(s.shouldSummarize(msgs)).toBe(true);
  });

  it('shouldSummarize returns false when tokens are below threshold', () => {
    // Set threshold very high so a small message doesn't trigger it
    const s = makeSummarizer(undefined, {
      maxContextTokens: 1_000_000,
      maxUnsummarizedMessages: null,
    });
    const msgs: Message[] = [makeUserMsg('hi')];
    expect(s.shouldSummarize(msgs)).toBe(false);
  });
});

// ── compact ───────────────────────────────────────────────────────────────────

describe('compact — no-op when thresholds not crossed', () => {
  it('returns the same messages array when below all thresholds', async () => {
    const s = makeSummarizer(undefined, {
      maxContextTokens: 1_000_000,
      maxUnsummarizedMessages: 1000,
    });
    const msgs: Message[] = [makeUserMsg('hi'), makeAssistantMsg('hello')];
    const result = await s.compact(msgs);
    expect(result).toBe(msgs); // same reference
  });
});

describe('compact — basic summarization', () => {
  it('calls summarize with the messages that should be summarized', async () => {
    const summarize: SummarizeFn = vi.fn(async () => 'the summary');
    const s = new LLMContextSummarizer(summarize, {
      maxUnsummarizedMessages: 1, // triggers on first trackAppended
      maxContextTokens: null,
      minMessagesAfterSummary: 0,
    });
    const msgs: Message[] = [makeUserMsg('msg1'), makeAssistantMsg('msg2')];
    s.trackAppended();

    await s.compact(msgs);

    expect(summarize).toHaveBeenCalledOnce();
    const [calledWith] = (summarize as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledWith).toEqual(msgs);
  });

  it('output starts with original system messages', async () => {
    const summarize: SummarizeFn = vi.fn(async () => 'sum');
    const s = new LLMContextSummarizer(summarize, {
      maxUnsummarizedMessages: 1,
      maxContextTokens: null,
      minMessagesAfterSummary: 0,
    });
    const sys = makeSystemMsg('You are an assistant.');
    const msgs: Message[] = [sys, makeUserMsg('hello'), makeAssistantMsg('hi')];
    s.trackAppended();

    const result = await s.compact(msgs);

    expect(result[0]).toEqual(sys);
  });

  it('output includes a summary system message after original system messages', async () => {
    const summarize: SummarizeFn = vi.fn(async () => 'compact summary');
    const s = new LLMContextSummarizer(summarize, {
      maxUnsummarizedMessages: 1,
      maxContextTokens: null,
      minMessagesAfterSummary: 0,
    });
    const msgs: Message[] = [makeUserMsg('msg1')];
    s.trackAppended();

    const result = await s.compact(msgs);

    const summaryMsg = result.find(isAutoSummary);
    expect(summaryMsg).toBeDefined();
    expect(typeof summaryMsg!.content).toBe('string');
    expect((summaryMsg!.content as string)).toContain('compact summary');
  });

  it('keeps minMessagesAfterSummary recent messages verbatim at end of output', async () => {
    const summarize: SummarizeFn = vi.fn(async () => 'sum');
    const keepCount = 2;
    const s = new LLMContextSummarizer(summarize, {
      maxUnsummarizedMessages: 1,
      maxContextTokens: null,
      minMessagesAfterSummary: keepCount,
    });
    const msgs: Message[] = [
      makeUserMsg('old1'),
      makeAssistantMsg('old2'),
      makeUserMsg('recent1'),
      makeAssistantMsg('recent2'),
    ];
    s.trackAppended();

    const result = await s.compact(msgs);

    // Last keepCount messages should match the original recent messages
    const last2 = result.slice(-keepCount);
    expect(last2[0]).toEqual(makeUserMsg('recent1'));
    expect(last2[1]).toEqual(makeAssistantMsg('recent2'));
  });

  it('summarize is called with only non-recent messages', async () => {
    const summarize: SummarizeFn = vi.fn(async () => 'sum');
    const s = new LLMContextSummarizer(summarize, {
      maxUnsummarizedMessages: 1,
      maxContextTokens: null,
      minMessagesAfterSummary: 2,
    });
    const msgs: Message[] = [
      makeUserMsg('old'),
      makeAssistantMsg('also old'),
      makeUserMsg('recent1'),
      makeAssistantMsg('recent2'),
    ];
    s.trackAppended();

    await s.compact(msgs);

    const [calledWith] = (summarize as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledWith).toHaveLength(2);
    expect(calledWith[0]).toEqual(makeUserMsg('old'));
    expect(calledWith[1]).toEqual(makeAssistantMsg('also old'));
  });
});

describe('compact — no-op when toSummarize is empty', () => {
  it('returns original messages when all non-system messages fit in keepCount', async () => {
    const summarize: SummarizeFn = vi.fn(async () => 'sum');
    const s = new LLMContextSummarizer(summarize, {
      maxUnsummarizedMessages: 1,
      maxContextTokens: null,
      minMessagesAfterSummary: 10, // keep more than we have
    });
    const msgs: Message[] = [makeUserMsg('a'), makeAssistantMsg('b')];
    s.trackAppended();

    const result = await s.compact(msgs);

    expect(summarize).not.toHaveBeenCalled();
    expect(result).toBe(msgs);
  });
});

describe('compact — counter reset', () => {
  it('resets unsummarizedCount to the kept message count after compaction', async () => {
    const summarize: SummarizeFn = vi.fn(async () => 'sum');
    const s = new LLMContextSummarizer(summarize, {
      maxUnsummarizedMessages: 2,
      maxContextTokens: null,
      minMessagesAfterSummary: 1,
    });
    const msgs: Message[] = [makeUserMsg('a'), makeUserMsg('b'), makeUserMsg('c')];
    s.trackAppended();
    s.trackAppended(); // hits threshold (2)

    const result = await s.compact(msgs);
    expect(summarize).toHaveBeenCalledOnce();

    // After compact, shouldSummarize should be false for the compacted output
    expect(s.shouldSummarize(result)).toBe(false);
  });
});

describe('compact — no stacking of auto-summaries', () => {
  it('replaces a prior auto-summary instead of adding another one', async () => {
    const summarize: SummarizeFn = vi.fn(async () => 'new summary');
    const s = new LLMContextSummarizer(summarize, {
      maxUnsummarizedMessages: 1,
      maxContextTokens: null,
      minMessagesAfterSummary: 0,
    });

    // Simulate a message list that already contains an auto-summary
    const priorSummary: Message = {
      role: 'system',
      content: `${ZERO_WIDTH_SPACE}Conversation summary: old stuff.`,
    };
    const msgs: Message[] = [priorSummary, makeUserMsg('recent')];
    s.trackAppended();

    const result = await s.compact(msgs);

    // Only one auto-summary should exist in the output
    const autoSummaries = result.filter(isAutoSummary);
    expect(autoSummaries).toHaveLength(1);
    expect(autoSummaries[0].content).toContain('new summary');
  });
});

describe('compact — concurrent call deduplication', () => {
  it('calls summarize only once when compact() is called concurrently', async () => {
    let resolveSum!: (s: string) => void;
    const inflightPromise = new Promise<string>((res) => { resolveSum = res; });
    const summarize: SummarizeFn = vi.fn(() => inflightPromise);

    const s = new LLMContextSummarizer(summarize, {
      maxUnsummarizedMessages: 1,
      maxContextTokens: null,
      minMessagesAfterSummary: 0,
    });
    const msgs: Message[] = [makeUserMsg('hello')];
    s.trackAppended();

    const p1 = s.compact(msgs);
    const p2 = s.compact(msgs);

    resolveSum('shared summary');
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(summarize).toHaveBeenCalledOnce();
    expect(r1).toEqual(r2);
  });
});

describe('compact — custom prompt and template', () => {
  it('passes custom summarizationPrompt to summarize fn', async () => {
    const summarize: SummarizeFn = vi.fn(async () => 'sum');
    const customPrompt = 'Be very brief.';
    const s = new LLMContextSummarizer(summarize, {
      maxUnsummarizedMessages: 1,
      maxContextTokens: null,
      minMessagesAfterSummary: 0,
      summarizationPrompt: customPrompt,
    });
    const msgs: Message[] = [makeUserMsg('something')];
    s.trackAppended();

    await s.compact(msgs);

    const [, promptArg] = (summarize as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(promptArg).toBe(customPrompt);
  });

  it('uses DEFAULT_SUMMARIZATION_PROMPT when no custom prompt provided', async () => {
    const summarize: SummarizeFn = vi.fn(async () => 'sum');
    const s = new LLMContextSummarizer(summarize, {
      maxUnsummarizedMessages: 1,
      maxContextTokens: null,
      minMessagesAfterSummary: 0,
    });
    const msgs: Message[] = [makeUserMsg('hello')];
    s.trackAppended();

    await s.compact(msgs);

    const [, promptArg] = (summarize as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(promptArg).toBe(DEFAULT_SUMMARIZATION_PROMPT);
  });

  it('inserts summary text into custom template {summary} placeholder', async () => {
    const summarize: SummarizeFn = vi.fn(async () => 'the facts');
    const s = new LLMContextSummarizer(summarize, {
      maxUnsummarizedMessages: 1,
      maxContextTokens: null,
      minMessagesAfterSummary: 0,
      summaryMessageTemplate: 'Context: {summary}. End.',
    });
    const msgs: Message[] = [makeUserMsg('a')];
    s.trackAppended();

    const result = await s.compact(msgs);
    const summaryMsg = result.find(isAutoSummary)!;
    expect(summaryMsg.content).toContain('Context: the facts. End.');
  });

  it('passes targetSummaryTokens to summarize fn', async () => {
    const summarize: SummarizeFn = vi.fn(async () => 'sum');
    const s = new LLMContextSummarizer(summarize, {
      maxUnsummarizedMessages: 1,
      maxContextTokens: null,
      minMessagesAfterSummary: 0,
      targetSummaryTokens: 1234,
    });
    const msgs: Message[] = [makeUserMsg('hi')];
    s.trackAppended();

    await s.compact(msgs);

    const [, , maxTokensArg] = (summarize as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(maxTokensArg).toBe(1234);
  });
});

describe('compact — no system messages', () => {
  it('works when input has no system messages', async () => {
    const summarize: SummarizeFn = vi.fn(async () => 'sum');
    const s = new LLMContextSummarizer(summarize, {
      maxUnsummarizedMessages: 1,
      maxContextTokens: null,
      minMessagesAfterSummary: 0,
    });
    const msgs: Message[] = [makeUserMsg('a'), makeAssistantMsg('b')];
    s.trackAppended();

    const result = await s.compact(msgs);

    // Output: [summaryMsg]
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.find(isAutoSummary)).toBeDefined();
  });
});

describe('compact — token-based threshold', () => {
  it('triggers compaction when token estimate meets maxContextTokens', async () => {
    const summarize: SummarizeFn = vi.fn(async () => 'sum');
    // A tiny limit so that even a couple of short messages trip it
    const s = new LLMContextSummarizer(summarize, {
      maxContextTokens: 1,
      maxUnsummarizedMessages: null,
      minMessagesAfterSummary: 0,
    });
    const msgs: Message[] = [makeUserMsg('a'), makeUserMsg('b')];

    const result = await s.compact(msgs);

    expect(summarize).toHaveBeenCalled();
    expect(result.find(isAutoSummary)).toBeDefined();
  });
});
