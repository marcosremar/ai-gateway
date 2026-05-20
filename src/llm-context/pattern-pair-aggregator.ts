/**
 * PatternPairAggregator — extract delimited blocks from streaming text.
 *
 * Use cases: strip `<thinking>...</thinking>` reasoning blocks before TTS,
 * extract function call args, separate inner monologue. Streaming-safe:
 * pattern can span multiple chunks.
 *
 * Three actions per pattern:
 *   REMOVE    — strip pattern + content (default)
 *   KEEP      — strip delimiters only, content stays inline
 *   AGGREGATE — emit content as separate block
 */

import { type AggregationType, type PatternMatch, SENTENCE_ENDING } from './types';
import { ABBREVIATIONS, endsWithAbbreviation } from './sentence-aggregator';

export type MatchAction = 'remove' | 'keep' | 'aggregate';

type PatternDef = {
  type: string;
  start: string;
  end: string;
  action: MatchAction;
};

export type PatternHandler = (match: PatternMatch) => Promise<void> | void;

const RESERVED = new Set(['sentence', 'token', 'word']);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const LATIN_AMBIGUOUS = new Set(['.', '!', '?', ';', '…']);

export type PatternPairOptions = {
  aggregationType?: AggregationType;
  /**
   * Max chars to buffer before forcing a recovery flush. Protects against
   * unbounded memory growth when an open pattern never closes (malicious
   * input or LLM stuck mid-block). Default 1MB. Set to 0 to disable.
   */
  maxBufferChars?: number;
};

export class PatternPairAggregator {
  private buffer = '';
  private needsLookahead = false;
  private lookaheadSawSpace = false;
  private lastProcessedPosition = 0;
  private readonly patterns = new Map<string, PatternDef>();
  private readonly handlers = new Map<string, PatternHandler>();
  private readonly aggregationType: AggregationType;
  private readonly maxBufferChars: number;

  constructor(opts: PatternPairOptions = {}) {
    this.aggregationType = opts.aggregationType ?? 'sentence';
    this.maxBufferChars = opts.maxBufferChars ?? 1_000_000;
  }

  addPattern(type: string, startPattern: string, endPattern: string, action: MatchAction = 'remove'): this {
    if (RESERVED.has(type)) {
      throw new Error(`pattern type "${type}" is reserved`);
    }
    this.patterns.set(type, { type, start: startPattern, end: endPattern, action });
    return this;
  }

  onPatternMatch(type: string, handler: PatternHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  async *aggregate(text: string): AsyncGenerator<PatternMatch> {
    for (const ch of text) {
      this.buffer += ch;
      const bufferLenBeforePatterns = this.buffer.length;

      const matches = await this.processCompletePatterns();
      this.lastProcessedPosition = this.buffer.length;
      const patternConsumedChar = this.buffer.length < bufferLenBeforePatterns;

      if (matches.length > 0) {
        const action = this.patterns.get(matches[0].type)?.action ?? 'remove';
        if (action === 'aggregate') {
          this.buffer = '';
          this.lastProcessedPosition = 0;
          yield matches[0];
          continue;
        }
      }

      const incomplete = this.matchStartOfPattern();
      if (incomplete) {
        const [startIdx, def] = incomplete;
        if (startIdx === 0 || def.action !== 'aggregate') continue;
        // Yield text before the AGGREGATE pattern starts
        const preText = this.buffer.slice(0, startIdx).trim();
        this.buffer = this.buffer.slice(startIdx);
        this.lastProcessedPosition = 0;
        yield { text: preText, type: this.aggregationType, fullMatch: preText };
        continue;
      }

      if (this.aggregationType !== 'token') {
        const sentence = this.checkSentenceWithLookahead(ch, patternConsumedChar);
        if (sentence) {
          yield { ...sentence, fullMatch: sentence.text };
        }
      }

      // Memory guard: if buffer grows past limit (unclosed pattern + DoS),
      // drop the open pattern context — emit accumulated text up to start
      // delimiter, reset to avoid OOM. Caller may see truncated output but
      // process survives.
      if (this.maxBufferChars > 0 && this.buffer.length > this.maxBufferChars) {
        const incomplete = this.matchStartOfPattern();
        if (incomplete) {
          const [startIdx] = incomplete;
          const safe = this.buffer.slice(0, startIdx).trim();
          this.buffer = '';
          this.lastProcessedPosition = 0;
          this.needsLookahead = false;
          if (safe) yield { text: safe, type: this.aggregationType, fullMatch: safe };
        } else {
          // No open pattern but still oversized — flush as one block.
          const text = this.buffer.trim();
          this.buffer = '';
          this.lastProcessedPosition = 0;
          this.needsLookahead = false;
          if (text) yield { text, type: this.aggregationType, fullMatch: text };
        }
      }
    }

    if (this.aggregationType === 'token' && this.buffer && !this.matchStartOfPattern()) {
      yield { text: this.buffer, type: 'token', fullMatch: this.buffer };
      this.buffer = '';
      this.lastProcessedPosition = 0;
    }
  }

  async flush(): Promise<PatternMatch | null> {
    // Strip any unclosed pattern at end-of-stream so REMOVE-action tags don't
    // leak to downstream consumers (e.g. TTS would otherwise speak "<thinking>"
    // verbatim if the LLM stream cut off mid-block).
    let text = this.buffer;
    const incomplete = this.matchStartOfPattern();
    if (incomplete) {
      const [startIdx, def] = incomplete;
      if (def.action === 'remove') {
        text = text.slice(0, startIdx);
      }
      // For 'keep' / 'aggregate' incomplete patterns we also can't safely emit
      // the unclosed delimiter — drop from start position to be conservative.
      else {
        text = text.slice(0, startIdx);
      }
    } else {
      // Buffer may end with a PARTIAL start-delimiter prefix (e.g. "Hello <thi"
      // when full start is "<thinking>"). matchStartOfPattern only counts full
      // occurrences, so it returns null here — strip the partial prefix
      // ourselves to avoid leaking it to downstream consumers.
      const partialIdx = this.matchPartialStartAtEnd(text);
      if (partialIdx !== null) text = text.slice(0, partialIdx);
    }

    const trimmed = text.trim();
    this.buffer = '';
    this.lastProcessedPosition = 0;
    this.needsLookahead = false;
    this.lookaheadSawSpace = false;
    if (!trimmed) return null;
    return { text: trimmed, type: this.aggregationType, fullMatch: trimmed };
  }

  async handleInterruption(): Promise<void> {
    this.buffer = '';
    this.lastProcessedPosition = 0;
    this.needsLookahead = false;
    this.lookaheadSawSpace = false;
  }

  async reset(): Promise<void> {
    await this.handleInterruption();
  }

  private async processCompletePatterns(): Promise<PatternMatch[]> {
    const found: PatternMatch[] = [];
    for (const def of this.patterns.values()) {
      const re = new RegExp(`${escapeRegex(def.start)}([\\s\\S]*?)${escapeRegex(def.end)}`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(this.buffer)) !== null) {
        const fullMatch = m[0];
        const content = m[1].trim();
        const matchEnd = m.index + fullMatch.length;
        const alreadyProcessed = matchEnd <= this.lastProcessedPosition;
        const pm: PatternMatch = { text: content, type: def.type, fullMatch };

        if (!alreadyProcessed) {
          const handler = this.handlers.get(def.type);
          if (handler) {
            try {
              await handler(pm);
            } catch (err) {
              // Handler errors must not break aggregation. Log via console;
              // ai-gateway tests verify behavior, not log output.
              console.error(`pattern handler ${def.type} failed:`, err);
            }
          }
        }

        if (def.action === 'remove') {
          if (!alreadyProcessed) {
            this.buffer = this.buffer.replace(fullMatch, '');
            re.lastIndex = 0;
          }
        } else {
          found.push(pm);
        }
      }
    }
    return found;
  }

  private matchPartialStartAtEnd(buf: string): number | null {
    for (const def of this.patterns.values()) {
      if (def.start === def.end) continue;
      const start = def.start;
      const max = Math.min(start.length - 1, buf.length);
      for (let len = max; len > 0; len--) {
        if (buf.endsWith(start.slice(0, len))) {
          return buf.length - len;
        }
      }
    }
    return null;
  }

  private matchStartOfPattern(): [number, PatternDef] | null {
    for (const def of this.patterns.values()) {
      // Same-delimiter case (e.g. markdown ```...```): odd occurrence count
      // means we're inside an open block.
      if (def.start === def.end) {
        const count = countOccurrences(this.buffer, def.start);
        if (count % 2 === 1) {
          return [this.buffer.indexOf(def.start), def];
        }
        continue;
      }
      const startCount = countOccurrences(this.buffer, def.start);
      const endCount = countOccurrences(this.buffer, def.end);
      if (startCount > endCount) {
        return [this.buffer.indexOf(def.start), def];
      }
    }
    return null;
  }

  private checkSentenceWithLookahead(char: string, patternConsumedChar = false): { text: string; type: AggregationType } | null {
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
      if (SENTENCE_ENDING.has(char)) {
        // Repeated punctuation (ellipsis "...", "?!", etc.) — keep accumulating.
        return null;
      }
      // Multi-period abbreviation continuation ("i.e.", "e.g.", "a.m."): the
      // preceding partial buffer matches a dotted abbreviation form, so this
      // letter resumes the abbreviation rather than starting a new sentence.
      // Only valid without intervening whitespace — "i.e. Hello" is not "i.e.h".
      if (/[a-zA-Z]/.test(char) && !this.lookaheadSawSpace) {
        const lastWord = this.buffer.split(/\s+/).pop()?.toLowerCase() ?? '';
        if (ABBREVIATIONS.has(lastWord)) {
          this.needsLookahead = false;
          return null;
        }
      }
      this.needsLookahead = false;
      this.lookaheadSawSpace = false;
      // Pattern processing already consumed `char` (it was a closing delimiter).
      // Don't put it back as start of next sentence — yield buffer + empty next.
      if (patternConsumedChar) {
        const sentence = this.buffer.trim();
        this.buffer = '';
        this.lastProcessedPosition = 0;
        return { text: sentence, type: this.aggregationType };
      }
      // Use char.length (not -1) so surrogate-pair emoji slice correctly.
      const sentence = this.buffer.slice(0, -char.length).trim();
      this.buffer = char;
      this.lastProcessedPosition = char.length;
      return { text: sentence, type: this.aggregationType };
    }

    if (!SENTENCE_ENDING.has(char)) return null;
    if (LATIN_AMBIGUOUS.has(char)) {
      // Honor abbreviation list — "Mr.", "Dr.", "i.e." don't end sentences.
      if (endsWithAbbreviation(this.buffer.trimEnd())) return null;
      this.needsLookahead = true;
      this.lookaheadSawSpace = false;
      return null;
    }
    return this.flushSentence();
  }

  private flushSentence(): { text: string; type: AggregationType } {
    const out = { text: this.buffer.trim(), type: this.aggregationType };
    this.buffer = '';
    this.lastProcessedPosition = 0;
    this.lookaheadSawSpace = false;
    return out;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}
