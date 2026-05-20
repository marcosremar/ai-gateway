/**
 * SentenceAggregator — buffer streaming LLM tokens until sentence boundary.
 *
 * Drives TTS chunking: synthesize per sentence, not per token. Reduces
 * TTS audio glitches and gives better intonation. Mirrors pipecat
 * pipecat/utils/text/simple_text_aggregator.py.
 *
 * Lookahead disambiguates "$29." (numeric) from "$29. Next" (sentence end).
 * After punctuation, waits for next non-whitespace character before flushing.
 */

import { type Aggregation, type AggregationType, SENTENCE_ENDING } from './types';

const LATIN_AMBIGUOUS = new Set(['.', '!', '?', ';', '…']);

export const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st',
  'inc', 'ltd', 'co', 'corp', 'gov', 'org', 'edu',
  'i.e', 'e.g', 'vs', 'etc', 'cf', 'al',
  'a.m', 'p.m',
]);

export function endsWithAbbreviation(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith('.')) return false;
  const lastWord = trimmed.slice(0, -1).split(/\s+/).pop()?.toLowerCase() ?? '';
  return ABBREVIATIONS.has(lastWord);
}

// Decimal detection happens at LOOKAHEAD time (next char), not period time —
// streaming hasn't seen the next char yet when '.' is consumed.

export type SentenceAggregatorOptions = {
  aggregationType?: AggregationType;
};

export class SentenceAggregator {
  private buffer = '';
  private needsLookahead = false;
  private lookaheadSawSpace = false;
  private readonly aggregationType: AggregationType;

  constructor(opts: SentenceAggregatorOptions = {}) {
    this.aggregationType = opts.aggregationType ?? 'sentence';
  }

  get text(): Aggregation {
    return { text: this.buffer.trim(), type: this.aggregationType };
  }

  async *aggregate(text: string): AsyncGenerator<Aggregation> {
    if (this.aggregationType === 'token') {
      if (text) yield { text, type: 'token' };
      return;
    }

    for (const ch of text) {
      this.buffer += ch;
      const result = this.checkSentenceWithLookahead(ch);
      if (result) yield result;
    }
  }

  /** Flush pending buffer at end of stream. */
  async flush(): Promise<Aggregation | null> {
    if (!this.buffer.trim()) return null;
    const out = { text: this.buffer.trim(), type: this.aggregationType };
    this.buffer = '';
    this.needsLookahead = false;
    this.lookaheadSawSpace = false;
    return out;
  }

  async handleInterruption(): Promise<void> {
    this.buffer = '';
    this.needsLookahead = false;
    this.lookaheadSawSpace = false;
  }

  async reset(): Promise<void> {
    await this.handleInterruption();
  }

  protected checkSentenceWithLookahead(char: string): Aggregation | null {
    if (this.needsLookahead) {
      if (/\s/.test(char)) {
        // Whitespace after the period rules out decimal continuation — the
        // next digit (if any) starts a new token, not a fractional part.
        this.lookaheadSawSpace = true;
        return null;
      }
      // Digit immediately after period = decimal ("3.14"). After whitespace,
      // a digit instead starts a new sentence ("She said. 5 dogs ran.").
      if (/\d/.test(char) && !this.lookaheadSawSpace) {
        this.needsLookahead = false;
        return null;
      }
      // Repeated sentence-ending punctuation = ellipsis "..." or "?!" — keep
      // accumulating; treat the run as a single boundary.
      if (SENTENCE_ENDING.has(char)) {
        return null;
      }
      // Multi-period abbreviation continuation ("i.e.", "e.g.", "a.m.", "p.m.").
      // After "i." the lookahead would otherwise emit "i." as a sentence on the
      // next letter; check the partial buffer against ABBREVIATIONS (which lists
      // these dotted forms without trailing period) before resolving.
      if (/[a-zA-Z]/.test(char) && !this.lookaheadSawSpace) {
        const lastWord = this.buffer.split(/\s+/).pop()?.toLowerCase() ?? '';
        if (ABBREVIATIONS.has(lastWord)) {
          this.needsLookahead = false;
          return null;
        }
      }
      this.needsLookahead = false;
      this.lookaheadSawSpace = false;
      // Lookahead char is the start of the NEXT sentence — keep it in buffer.
      // Use char.length (not -1) so surrogate-pair emoji are sliced correctly.
      const sentence = this.buffer.slice(0, -char.length).trim();
      this.buffer = char;
      return { text: sentence, type: this.aggregationType };
    }

    if (!SENTENCE_ENDING.has(char)) return null;

    const trimmed = this.buffer.trimEnd();
    if (LATIN_AMBIGUOUS.has(char)) {
      if (endsWithAbbreviation(trimmed)) return null;
      this.needsLookahead = true;
      this.lookaheadSawSpace = false;
      return null;
    }

    return this.flushSentence();
  }

  private flushSentence(): Aggregation {
    const out = { text: this.buffer.trim(), type: this.aggregationType };
    this.buffer = '';
    this.lookaheadSawSpace = false;
    return out;
  }
}
