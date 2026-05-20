/**
 * Integration: full streaming pipeline.
 *
 * Realistic flow used by ai-gateway voice agents:
 *
 *   LLM token stream
 *     → PatternPairAggregator (strip <thinking>)
 *       → SentenceAggregator (chunk to sentences)
 *         → TTS queue
 *
 * Verifies modules compose correctly end-to-end.
 */

import { describe, it, expect, vi } from 'vitest';
import { PatternPairAggregator } from '../src/llm-context/pattern-pair-aggregator';
import { SentenceAggregator } from '../src/llm-context/sentence-aggregator';

function streamTokens(full: string, chunkSize = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i < full.length; i += chunkSize) {
    out.push(full.slice(i, i + chunkSize));
  }
  return out;
}

async function runFullPipeline(tokens: string[], onThinking?: (text: string) => void) {
  const stripper = new PatternPairAggregator();
  stripper.addPattern('thinking', '<thinking>', '</thinking>', 'remove');
  if (onThinking) {
    stripper.onPatternMatch('thinking', async (m) => onThinking(m.text));
  }

  const sentencer = new SentenceAggregator();
  const ttsQueue: string[] = [];

  for (const tok of tokens) {
    for await (const stripped of stripper.aggregate(tok)) {
      for await (const sentence of sentencer.aggregate(stripped.text + ' ')) {
        ttsQueue.push(sentence.text);
      }
    }
  }
  const stripperTail = await stripper.flush();
  if (stripperTail) {
    for await (const sentence of sentencer.aggregate(stripperTail.text + ' ')) {
      ttsQueue.push(sentence.text);
    }
  }
  const sentencerTail = await sentencer.flush();
  if (sentencerTail) ttsQueue.push(sentencerTail.text);

  return ttsQueue;
}

describe('llm-context pipeline integration', () => {
  it('strips <thinking> and chunks remaining text into sentences', async () => {
    const llmOutput =
      '<thinking>The user wants a greeting</thinking>Hi there! How are you today? I hope all is well.';
    const tokens = streamTokens(llmOutput, 5);
    const onThinking = vi.fn();
    const queue = await runFullPipeline(tokens, onThinking);

    expect(onThinking).toHaveBeenCalledOnce();
    expect(onThinking.mock.calls[0][0]).toBe('The user wants a greeting');
    const joined = queue.join(' ');
    expect(joined).not.toContain('thinking');
    expect(joined).toContain('Hi there!');
    expect(joined).toContain('How are you today?');
  });

  it('handles multiple thinking blocks in single stream', async () => {
    const llm =
      '<thinking>plan A</thinking>First answer. <thinking>now plan B</thinking>Second answer.';
    const calls: string[] = [];
    const queue = await runFullPipeline(streamTokens(llm, 4), (t) => calls.push(t));
    expect(calls).toEqual(['plan A', 'now plan B']);
    expect(queue.join(' ')).not.toContain('plan A');
    expect(queue.join(' ')).toContain('First answer.');
    expect(queue.join(' ')).toContain('Second answer.');
  });

  it('emits sentences as soon as they complete (low latency)', async () => {
    const stripper = new PatternPairAggregator();
    stripper.addPattern('thinking', '<thinking>', '</thinking>', 'remove');
    const sentencer = new SentenceAggregator();
    const events: Array<{ at: number; text: string }> = [];
    let charsConsumed = 0;

    const llm = 'Hello there. This is a longer sentence that takes more time. Done.';

    for (const ch of llm) {
      charsConsumed++;
      for await (const stripped of stripper.aggregate(ch)) {
        for await (const sentence of sentencer.aggregate(stripped.text)) {
          events.push({ at: charsConsumed, text: sentence.text });
        }
      }
    }
    const tail = await sentencer.flush();
    if (tail) events.push({ at: charsConsumed, text: tail.text });

    // First sentence should land well before the full stream is consumed
    expect(events[0].text).toBe('Hello there.');
    expect(events[0].at).toBeLessThan(charsConsumed);
  });

  it('preserves sentence-internal punctuation (decimals, abbreviations)', async () => {
    const llm = 'Pi is 3.14 approximately. Mr. Smith said hi.';
    const queue = await runFullPipeline(streamTokens(llm, 7));
    expect(queue).toHaveLength(2);
    expect(queue[0]).toBe('Pi is 3.14 approximately.');
    expect(queue[1]).toBe('Mr. Smith said hi.');
  });
});
