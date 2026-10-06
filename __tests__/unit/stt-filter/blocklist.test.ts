import { describe, expect, it } from 'vitest';
import { filterHallucinations, normalizeForBlocklist, normalizeLanguage } from '../../../src/stt-hallucination-filter';
import utterances from './a1-utterances.json';

const say = (text: string, extra: Record<string, unknown> = {}) => ({ text, ...extra });

describe('language and text normalization', () => {
  it('accepts codes and names', () => {
    for (const v of ['pt', 'PT', 'pt-BR', 'Portuguese', 'portuguese', 'português']) expect(normalizeLanguage(v)).toBe('pt');
    expect(normalizeLanguage('French')).toBe('fr');
    expect(normalizeLanguage('')).toBeUndefined();
    expect(normalizeLanguage('Klingon')).toBeUndefined();
  });
  it('maps punctuation to the dataset form', () => {
    expect(normalizeForBlocklist('E aí?')).toBe('e aí');
    expect(normalizeForBlocklist('Legendas pela comunidade Amara.org')).toBe('legendas pela comunidade amara org');
    expect(normalizeForBlocklist('Sous-titres réalisés par…')).toBe('sous titres réalisés par');
  });
});

describe('blocklist: silence hallucinations are dropped', () => {
  const cases: Array<[string, string]> = [
    ['E aí.', 'Portuguese'], ['e aí', 'pt'], ['Obrigado por assistir!', 'pt'], ['Legendas pela comunidade Amara.org', 'Portuguese'],
    ['Inscreva-se no canal', 'pt'], ['Sous-titres réalisés para la communauté d\'Amara.org', 'fr'], ["Merci d'avoir regardé cette vidéo.", 'French'],
    ['Thank you for watching!', 'en'], ['Subtitles by the Amara.org community', 'English'],
    // Whisper emits English boilerplate over Portuguese audio: high-confidence phrases apply in any language.
    ['Thanks for watching', 'pt'],
  ];
  for (const [text, lang] of cases) {
    it(`${lang}: ${text}`, () => {
      const r = filterHallucinations(say(text), lang);
      expect(r.text).toBe('');
      expect(r.reasonCodes.length).toBeGreaterThan(0);
    });
  }
  it('without a language only the high-confidence phrases apply', () => {
    expect(filterHallucinations(say('E aí'), undefined).text).toBe('');
    expect(filterHallucinations(say('Legendas pela comunidade Amara.org'), undefined).text).toBe('');
    expect(filterHallucinations(say('não'), undefined).text).toBe('não');
  });
  it('reasons never carry the transcript', () => {
    const r = filterHallucinations(say('Obrigado por assistir!'), 'pt');
    expect(JSON.stringify([r.reasons, r.reasonCodes])).not.toMatch(/assistir/i);
  });
});

describe('false-positive guards', () => {
  it('a real sentence with good metadata is kept', () => {
    const r = filterHallucinations(say('Eu queria um pão com manteiga, por favor.', { avg_logprob: -0.25, no_speech_prob: 0.02, compression_ratio: 1.4 }), 'pt');
    expect(r.filtered).toBe(false);
  });
  it('one-word learner answers survive the blocklist alone', () => {
    for (const w of ['Sim.', 'Não.', 'Oi!', 'Olá', 'Obrigado.', 'Obrigada!', 'Tchau.', 'Bom dia.', 'Merci.', 'Oui', 'Non', 'Au revoir', 'Thank you']) {
      expect(filterHallucinations(say(w), 'pt').text, w).toBe(w);
    }
  });
  it('an ambiguous phrase is dropped only when the metadata agrees (no_speech_prob high)', () => {
    expect(filterHallucinations(say('Eu não sei.'), 'pt').text).toBe('Eu não sei.');
    expect(filterHallucinations(say('Eu não sei.', { no_speech_prob: 0.7, avg_logprob: -0.3, compression_ratio: 1 }), 'pt').text).toBe('');
    expect(filterHallucinations(say('Eu não sei.', { no_speech_prob: 0.05, avg_logprob: -0.3, compression_ratio: 1 }), 'pt').text).toBe('Eu não sei.');
  });
  it('a one-word answer with high no_speech_prob is dropped by the metadata layer', () => {
    expect(filterHallucinations(say('Sim.', { no_speech_prob: 0.9, avg_logprob: -0.5, compression_ratio: 1 }), 'pt').text).toBe('');
  });
  it('flat metrics (speech-stack replica) are judged as one segment', () => {
    expect(filterHallucinations(say('qualquer coisa', { no_speech_prob: 0.8, avg_logprob: -1.4, compression_ratio: 1 }), 'pt').text).toBe('');
    expect(filterHallucinations(say('qualquer coisa', { no_speech_prob: 0.01, avg_logprob: -0.4, compression_ratio: 1 }), 'pt').text).toBe('qualquer coisa');
  });
  it('repetition loops are dropped (compression_ratio)', () => {
    expect(filterHallucinations(say('sim sim sim sim sim sim sim sim', { compression_ratio: 3.1, no_speech_prob: 0.1, avg_logprob: -0.3 }), 'pt').text).toBe('');
  });
});

describe('false-positive rate on 220 plausible A1 learner utterances', () => {
  const all: Array<[string, string]> = [
    ...utterances.pt.map(t => [t, 'Portuguese'] as [string, string]),
    ...utterances.pt_fr_accent.map(t => [t, 'pt'] as [string, string]),
    ...utterances.fr.map(t => [t, 'French'] as [string, string]),
  ];
  it('blocklist alone (no metadata) drops at most the owner-listed "e aí"-class phrases', () => {
    const dropped = all.filter(([t, l]) => filterHallucinations(say(t), l).text === '').map(([t]) => t);
    console.info(`[stt-filter FP] ${dropped.length}/${all.length} dropped: ${JSON.stringify(dropped)}`);
    expect(all.length).toBeGreaterThanOrEqual(200);
    expect(dropped).toEqual([]);
  });
  it('with healthy metadata nothing is dropped either', () => {
    const meta = { no_speech_prob: 0.05, avg_logprob: -0.35, compression_ratio: 1.3 };
    expect(all.filter(([t, l]) => filterHallucinations(say(t, meta), l).text === '')).toEqual([]);
  });
});
