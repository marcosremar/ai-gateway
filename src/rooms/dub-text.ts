const CLAUSE_END = /([,;:.!?…]+[\s"'»”)]*)/u;
const SENTENCE_END = /[.!?…]/u;
const MAX_REPEATED_WORDS = 6;

const FILLERS: Readonly<Record<string, readonly string[]>> = {
  fr: ['tu vois', 'vous voyez', 'voyez vous', 'tu sais', 'vous savez', 'hein', 'bon', 'ben', 'quoi', 'mec', 'mon pote', 'n est ce pas', 'voilà', 'enfin', 'bref'],
  pt: ['né', 'tá', 'sabe', 'tipo', 'cara', 'mano', 'entendeu', 'viu', 'olha', 'pois é', 'sabe como é'],
  en: ['you know', 'i mean', 'you see', 'right', 'like', 'well', 'okay', 'ok'],
  es: ['o sea', 'sabes', 'ves', 'bueno', 'pues', 'vale', 'tío'],
  it: ['cioè', 'sai', 'ecco', 'insomma', 'allora'],
  de: ['ne', 'halt', 'weißt du', 'also', 'naja'],
  nl: ['weet je', 'nou', 'zeg maar'],
};

const bare = (text: string): string => text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function withoutRepeatedPhrases(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  for (let size = MAX_REPEATED_WORDS; size >= 1; size--) {
    for (let at = 0; at + 2 * size <= words.length;) {
      const first = bare(words.slice(at, at + size).join(' '));
      const second = bare(words.slice(at + size, at + 2 * size).join(' '));
      if (first && first === second && (size > 1 || first.length > 3)) words.splice(at, size);
      else at++;
    }
  }
  return words.join(' ');
}

function withoutFillerClauses(text: string, language: string): string {
  const fillers = new Set(FILLERS[language.split('-')[0]!.toLowerCase()] ?? []);
  const pieces = text.split(CLAUSE_END);
  const kept: string[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const clause = pieces[i]!, end = pieces[i + 1] ?? '';
    if (!fillers.has(bare(clause))) {
      if (clause.trim() || end) kept.push(clause, end);
    } else if (SENTENCE_END.test(end) && kept.length) {
      kept[kept.length - 1] = end;
    }
  }
  return kept.join('').trim();
}

const capitalized = (text: string): string => text.replace(/^\p{Ll}/u, letter => letter.toUpperCase());

export function withoutFiller(text: string, language: string): string {
  const cleaned = withoutFillerClauses(withoutRepeatedPhrases(text), language);
  return bare(cleaned) && cleaned !== text ? capitalized(cleaned) : text;
}
