/**
 * Streams the value of one top-level string field out of a JSON object that arrives in arbitrary chunks, unescaped,
 * as it arrives — so a reply like {"utterance": "Bom dia! …", "mood": …} can be voiced before the JSON is complete.
 *
 * Ported from parle's `createUtteranceExtractor` (babylon-cinema core/speech/sentence-stream.ts): anything before the
 * root object (code fence, whitespace, a <think> block) is skipped; only depth-1 keys are matched.
 */

export interface FieldChunk {
  /** New text of the field's value in this chunk. */
  text: string;
  /** The string closed (or the object ended without it): no more text will come. */
  closed: boolean;
}

const JSON_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';
const PREAMBLE_KEEP = 64;

export function createJsonFieldExtractor(key: string): { push(chunk: string): FieldChunk } {
  let phase: 'seek' | 'object' | 'over' = 'seek';
  let preamble = '';
  let thinking = false;
  let depth = 0;
  let inString = false;
  let escape = false;
  let unicode: string | null = null;
  let readingKey = false;
  let expectKey = false;
  let keyText = '';
  let valueOf: string | null = null;
  let capturing = false;

  const seek = (ch: string): void => {
    preamble = (preamble + ch).slice(-PREAMBLE_KEEP);
    if (!thinking && preamble.endsWith(THINK_OPEN)) thinking = true;
    else if (thinking && preamble.endsWith(THINK_CLOSE)) thinking = false;
    else if (!thinking && ch === '{') {
      phase = 'object';
      depth = 1;
      expectKey = true;
    }
  };

  const stringChar = (ch: string): string | null => {
    if (unicode !== null) {
      unicode += ch;
      if (unicode.length < 4) return null;
      const code = Number.parseInt(unicode, 16);
      unicode = null;
      return Number.isFinite(code) ? String.fromCharCode(code) : null;
    }
    if (escape) {
      escape = false;
      if (ch === 'u') { unicode = ''; return null; }
      return JSON_ESCAPES[ch] ?? ch;
    }
    if (ch === '\\') { escape = true; return null; }
    return ch;
  };

  const structural = (ch: string): void => {
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth <= 0) phase = 'over';
    } else if (depth === 1 && ch === ',') {
      expectKey = true;
      valueOf = null;
    } else if (depth === 1 && ch === ':') valueOf = keyText;
  };

  return {
    push(chunk: string): FieldChunk {
      let text = '';
      let closed = false;
      for (const ch of chunk) {
        if (phase === 'over') break;
        if (phase === 'seek') { seek(ch); continue; }
        if (inString) {
          if (!escape && unicode === null && ch === '"') {
            inString = false;
            if (capturing) { capturing = false; closed = true; phase = 'over'; }
            else if (readingKey) { readingKey = false; expectKey = false; }
            continue;
          }
          const value = stringChar(ch);
          if (value === null) continue;
          if (capturing) text += value;
          else if (readingKey) keyText += value;
          continue;
        }
        if (ch === '"') {
          inString = true;
          readingKey = depth === 1 && expectKey;
          if (readingKey) keyText = '';
          capturing = depth === 1 && !readingKey && valueOf === key;
          continue;
        }
        structural(ch);
      }
      if (phase === 'over' && !closed && !capturing) closed = true;
      return { text, closed };
    },
  };
}
