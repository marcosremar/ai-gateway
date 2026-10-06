import { describe, expect, it } from 'vitest';
import { createJsonFieldExtractor } from '../../../src/s2s/json-field';

/** Same cases as docker/speech-stack/test_json_field.py: the GPU path and the composed fallback voice the same text. */
function run(text: string, step: number, key = 'utterance') {
  const f = createJsonFieldExtractor(key);
  let out = '';
  let closed = false;
  for (let i = 0; i < text.length; i += step) {
    const part = f.push(text.slice(i, i + step));
    out += part.text;
    closed ||= part.closed;
  }
  return { out, closed };
}

const CASES: Array<[string, string]> = [
  ['{"utterance": "Bom dia! Tudo bem?", "mood": "happy"}', 'Bom dia! Tudo bem?'],
  ['```json\n{"mood": "x", "utterance": "Diz \\"oi\\"\\nlinha"}', 'Diz "oi"\nlinha'],
  ['<think>{"utterance": "não"}</think>{"utterance": "sim, p\\u00e3o"}', 'sim, pão'],
  ['{"meta": {"utterance": "aninhado"}, "utterance": "raiz"}', 'raiz'],
  ['{"mood": "calm"}', ''],
];

describe('createJsonFieldExtractor', () => {
  for (const [text, expected] of CASES) {
    it(`extracts ${JSON.stringify(expected)}`, () => {
      for (const step of [1, 2, 3, 7, 50]) expect(run(text, step)).toEqual({ out: expected, closed: true });
    });
  }
});
