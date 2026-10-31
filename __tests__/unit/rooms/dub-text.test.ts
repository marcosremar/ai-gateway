import { describe, expect, it } from 'vitest';
import { withoutFiller } from '../../../src/rooms/dub-text';

describe('withoutFiller: the voice loses repetition and filler, never content', () => {
  it('drops a sentence or a phrase said twice in a row', () => {
    expect(withoutFiller('Ici, sur le chemin. Ici, sur le chemin. Ça prend du temps.', 'fr')).toBe('Ici, sur le chemin. Ça prend du temps.');
    expect(withoutFiller('Je ne sais pas le nombre. Je ne sais pas le nombre ici.', 'fr')).toBe('Je ne sais pas le nombre ici.');
    expect(withoutFiller('je pense je pense que oui', 'fr')).toBe('Je pense que oui');
  });

  it('drops filler that stands alone between punctuation', () => {
    expect(withoutFiller('Mais tu continues, tu vois ?', 'fr')).toBe('Mais tu continues?');
    expect(withoutFiller('Dans les Andes, hein, cette pente.', 'fr')).toBe('Dans les Andes, cette pente.');
    expect(withoutFiller('Então, a receita subiu, né?', 'pt-BR')).toBe('Então, a receita subiu?');
  });

  it('keeps the same words inside a real sentence', () => {
    expect(withoutFiller('Tu vois le problème, et il est grave.', 'fr')).toBe('Tu vois le problème, et il est grave.');
    expect(withoutFiller('Eu sabe tudo, cara a cara.', 'pt')).toBe('Eu sabe tudo, cara a cara.');
    expect(withoutFiller('He said no no to that.', 'en')).toBe('He said no no to that.');
    expect(withoutFiller('Accélérez un peu, on est trop près.', 'fr')).toBe('Accélérez un peu, on est trop près.');
  });

  it('keeps numbers, and a language without a list only loses repetition', () => {
    expect(withoutFiller('Plus de 14, plus de 14 personnes.', 'fr')).toBe('Plus de 14 personnes.');
    expect(withoutFiller('hello there hello there', 'ja')).toBe('Hello there');
  });

  it('never leaves nothing', () => {
    expect(withoutFiller('Tu vois ?', 'fr')).toBe('Tu vois ?');
  });
});
