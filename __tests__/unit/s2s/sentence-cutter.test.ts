import { describe, expect, it } from 'vitest';
import { SentenceCutter } from '../../../src/s2s/sentence-cutter';

/** Same cases and properties as docker/speech-stack/test_cut.py: the composed fallback cuts like the GPU path. */
function run(text: string, step: number): string[] {
  const cutter = new SentenceCutter();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step) out.push(...cutter.push(text.slice(i, i + step)));
  out.push(...cutter.end());
  return out;
}

const CASES: Record<string, string[]> = {
  'Bom dia, querida! Hoje tem pão francês, integral e broa de milho. Qual você quer?':
    ['Bom dia, querida!', 'Hoje tem pão francês, integral e broa de milho.', 'Qual você quer?'],
  'Olá, tudo bem com você hoje, amiga? Sim.': ['Olá, tudo bem com você hoje,', 'amiga? Sim.'],
  'O Dr. Silva chegou às 9h30. Pode entrar.': ['O Dr. Silva chegou às 9h30.', 'Pode entrar.'],
  'Custa 3.50 reais, tá bom?': ['Custa 3.50 reais,', 'tá bom?'],
  'Sim.': ['Sim.'],
};

describe('SentenceCutter', () => {
  for (const [text, expected] of Object.entries(CASES)) {
    it(`cuts ${JSON.stringify(text.slice(0, 30))} like the speech-stack`, () => {
      expect(run(text, 1)).toEqual(expected);
      for (const step of [1, 2, 3, 5, 7, 11]) {
        const got = run(text, step);
        expect(got.join(' ')).toBe(text.split(/\s+/).join(' ')); // nothing lost or duplicated
        expect(got.slice(0, -1).every(c => c.split(/\s+/).length >= 2)).toBe(true);
        expect(got.some(c => c.endsWith('Dr.'))).toBe(false);
        expect(got[0].length).toBeLessThanOrEqual(expected[0].length + 10);
      }
    });
  }

  it('cuts a run-on answer at 160 characters on a space', () => {
    const got = run('a'.repeat(5) + (' palavra').repeat(40), 4);
    expect(got.length).toBeGreaterThan(1);
    expect(got.every(c => c.length <= 160)).toBe(true);
  });
});
