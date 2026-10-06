/**
 * Cuts a streamed LLM answer into speakable chunks, as soon as each one is safe to voice. Same rules as `cut()` in
 * docker/speech-stack/server.py, so the composed fallback sounds like the GPU path:
 *
 * - a sentence end cuts once the chunk has 2+ words (a one-word "Amiga?" waits: tiny TTS calls cost a round trip and
 *   flatten the intonation) and the word before a "." is not an abbreviation ("Dr.", "Sra.");
 * - a mark at the very end of the text so far waits for the next token ("3." may still become "3.50");
 * - the FIRST chunk also cuts at a clause mark (, ; : —) followed by a space once it has 3+ words, so the first audio
 *   does not wait for a long sentence ("3,50" never cuts: no space after the comma);
 * - anything longer than 160 characters cuts at the last space.
 */

const SENTENCE_END = /[.!?…]+["'»”)\]]*(?=\s|$)/g;
const CLAUSE_END = /[,;:—–](?=\s)/g;
const ABBREVIATIONS = new Set(['sr', 'sra', 'srta', 'dr', 'dra', 'prof', 'profa', 'av', 'etc', 'ex', 'nº', 'n', 'mr', 'mrs', 'st', 'm', 'mme']);

export const MIN_SENTENCE_WORDS = 2;
export const FIRST_MIN_WORDS = 3;
export const MAX_CHUNK_CHARS = 160;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Next speakable chunk and the rest of the buffer, or `null` to wait for more tokens. */
export function cutSentence(buffer: string, first: boolean, final: boolean): { chunk: string | null; rest: string } {
  for (const match of buffer.matchAll(SENTENCE_END)) {
    const end = match.index! + match[0].length;
    if (end === buffer.length && !final) break;
    const head = buffer.slice(0, end);
    const before = buffer.slice(0, match.index).split(/\s+/).filter(Boolean);
    const lastWord = (before[before.length - 1] ?? '').toLowerCase().replace(/^[("'«]+/, '');
    if (match[0].startsWith('.') && ABBREVIATIONS.has(lastWord)) continue;
    if (words(head) >= MIN_SENTENCE_WORDS) return { chunk: head.trim(), rest: buffer.slice(end) };
  }
  if (first) {
    for (const clause of buffer.matchAll(CLAUSE_END)) {
      const end = clause.index! + clause[0].length;
      const head = buffer.slice(0, end);
      if (words(head) >= FIRST_MIN_WORDS) return { chunk: head.trim(), rest: buffer.slice(end) };
    }
  }
  if (buffer.length > MAX_CHUNK_CHARS && buffer.slice(0, MAX_CHUNK_CHARS).includes(' ')) {
    const at = buffer.slice(0, MAX_CHUNK_CHARS).lastIndexOf(' ');
    return { chunk: buffer.slice(0, at).trim(), rest: buffer.slice(at) };
  }
  if (final && buffer.trim()) return { chunk: buffer.trim(), rest: '' };
  return { chunk: null, rest: buffer };
}

/** Feeds tokens, returns the chunks that became speakable. `end()` flushes what is left. */
export class SentenceCutter {
  private buffer = '';
  private first = true;

  push(delta: string): string[] {
    this.buffer += delta;
    return this.drain(false);
  }

  end(): string[] {
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const { chunk, rest } = cutSentence(this.buffer, this.first, final);
      this.buffer = rest;
      if (!chunk) break;
      this.first = false;
      out.push(chunk);
    }
    return out;
  }
}
