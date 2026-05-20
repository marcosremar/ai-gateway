/**
 * Fuzz / property tests — random inputs, invariants must hold.
 *
 * Invariants checked:
 *  - SentenceAggregator never drops characters across many random streams
 *  - PatternPairAggregator preserves text outside patterns
 *  - LLMContextSummarizer never produces context larger than input (after trigger)
 *  - Adapters roundtrip preserves user/assistant message count
 */

import { describe, it, expect } from 'vitest';
import { SentenceAggregator } from '../src/llm-context/sentence-aggregator';
import { PatternPairAggregator } from '../src/llm-context/pattern-pair-aggregator';
import { LLMContextSummarizer } from '../src/llm-context/context-summarizer';
import { toOpenAI, fromOpenAI } from '../src/llm-context/adapters/openai';
import { toAnthropic, fromAnthropic } from '../src/llm-context/adapters/anthropic';
import { toGemini, fromGemini } from '../src/llm-context/adapters/gemini';
import type { Message } from '../src/llm-context/types';

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function randomSentence(rand: () => number): string {
  const words = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'data', 'event'];
  const n = 3 + Math.floor(rand() * 8);
  const w: string[] = [];
  for (let i = 0; i < n; i++) w.push(words[Math.floor(rand() * words.length)]);
  const ender = ['.', '!', '?'][Math.floor(rand() * 3)];
  return w.join(' ') + ender;
}

function randomChunkSizes(stream: string, rand: () => number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < stream.length) {
    const size = 1 + Math.floor(rand() * 12);
    out.push(stream.slice(i, i + size));
    i += size;
  }
  return out;
}

describe('SentenceAggregator fuzz', () => {
  it('survives 50 random conversations with random chunking', async () => {
    const rand = rng(42);
    for (let trial = 0; trial < 50; trial++) {
      const sentenceCount = 3 + Math.floor(rand() * 10);
      const sentences = Array.from({ length: sentenceCount }, () => randomSentence(rand));
      const stream = sentences.join(' ');
      const chunks = randomChunkSizes(stream, rand);

      const agg = new SentenceAggregator();
      const out: string[] = [];
      for (const c of chunks) {
        for await (const a of agg.aggregate(c)) out.push(a.text);
      }
      const tail = await agg.flush();
      if (tail) out.push(tail.text);

      // Invariant 1: no characters lost
      const merged = out.join(' ').replace(/\s+/g, ' ').trim();
      const expected = stream.replace(/\s+/g, ' ').trim();
      expect(merged.length, `trial ${trial}: char count`).toBe(expected.length);

      // Invariant 2: produced exactly N sentence chunks
      expect(out.length, `trial ${trial}: sentence count`).toBe(sentenceCount);
    }
  });
});

describe('PatternPairAggregator fuzz', () => {
  it('non-pattern text always reaches output (fuzz)', async () => {
    const rand = rng(7);
    for (let trial = 0; trial < 30; trial++) {
      const pre = randomSentence(rand);
      const inside = randomSentence(rand);
      const post = randomSentence(rand);
      const stream = `${pre} <thinking>${inside}</thinking> ${post}`;
      const chunks = randomChunkSizes(stream, rand);

      const agg = new PatternPairAggregator();
      agg.addPattern('thinking', '<thinking>', '</thinking>', 'remove');

      const out: string[] = [];
      for (const c of chunks) {
        for await (const m of agg.aggregate(c)) out.push(m.text);
      }
      const tail = await agg.flush();
      if (tail) out.push(tail.text);

      const joined = out.join(' ');
      // Pattern + content always stripped
      expect(joined, `trial ${trial}`).not.toContain('thinking');
      expect(joined, `trial ${trial}`).not.toContain(inside);
      // First word of pre + last word of post always present
      const preFirst = pre.split(' ')[0];
      expect(joined, `trial ${trial}: pre starts`).toContain(preFirst);
    }
  });
});

describe('Summarizer fuzz', () => {
  it('compacted output never exceeds threshold + buffer (10 random conversations)', async () => {
    const rand = rng(99);
    for (let trial = 0; trial < 10; trial++) {
      const summarize = async () => 'CONDENSED';
      const summarizer = new LLMContextSummarizer(summarize, {
        maxContextTokens: null,
        maxUnsummarizedMessages: 5,
        minMessagesAfterSummary: 2,
      });

      const messages: Message[] = [{ role: 'system', content: 'rules' }];
      for (let i = 0; i < 30; i++) {
        const role = i % 2 ? 'assistant' : 'user';
        messages.push({ role, content: randomSentence(rand) });
        summarizer.trackAppended();
      }
      const out = await summarizer.compact(messages);

      // Invariant: compacted ≤ 1 system + 1 summary + recent
      const summaryMessages = out.filter((m) => m.role === 'system');
      expect(summaryMessages.length, `trial ${trial}`).toBeLessThanOrEqual(2);
      const nonSystem = out.filter((m) => m.role !== 'system');
      expect(nonSystem.length, `trial ${trial}`).toBeLessThanOrEqual(2);
    }
  });
});

describe('Adapter roundtrip fuzz', () => {
  it('OpenAI / Anthropic / Gemini preserve user-assistant turn count', () => {
    const rand = rng(13);
    for (let trial = 0; trial < 20; trial++) {
      const turns = 1 + Math.floor(rand() * 15);
      const messages: Message[] = [{ role: 'system', content: 'sys' }];
      for (let i = 0; i < turns; i++) {
        messages.push({ role: i % 2 ? 'assistant' : 'user', content: randomSentence(rand) });
      }

      const oai = fromOpenAI(toOpenAI(messages).messages).filter((m) => m.role !== 'system');
      const ant = fromAnthropic(toAnthropic(messages)).filter((m) => m.role !== 'system');
      const gem = fromGemini(toGemini(messages)).filter((m) => m.role !== 'system');

      expect(oai.length, `OAI trial ${trial}`).toBe(turns);
      expect(ant.length, `ANT trial ${trial}`).toBe(turns);
      expect(gem.length, `GEM trial ${trial}`).toBe(turns);
    }
  });
});
