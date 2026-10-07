/**
 * Pattern rules of the STT hallucination filter (src/stt-hallucination-filter.ts): what an exact-match blocklist cannot
 * catch because the words vary. Each rule is high-confidence — it drops the whole answer on text alone, in any language.
 *
 * Seen live on Whisper large-v3 over non-speech audio (QA 2026-10-07, `parle-free-stt`), all passing the blocklist:
 *   - "Legenda por Sônia Ruberti" (room tone + music): a subtitle credit with a name the dataset cannot list;
 *   - "E aí ♫ E aí E aí E aí E aí E aí E aí" (keyboard clicks): music symbols and one short phrase looped.
 * Sources: Koenecke et al. (2024), "Careless Whisper: Speech-to-Text Hallucination Harms", ACM FAccT 2024,
 * DOI 10.1145/3630106.3658996 (Whisper invents whole phrases over non-speech); Radford et al. (2023), ICML,
 * arXiv:2212.04356 (Whisper's training captions carry subtitle credits, and its decoder's repetition loops — the reason
 * its own compression_ratio gate exists; this rule catches the short loops that gate misses). The exact limits below
 * (credit lines ≤ 12 words, ≥ 3 repeats covering ≥ 70 % of the words, one-word loops ≥ 4) are DESIGN CHOICES to pilot
 * and pre-register (docs/stt-hallucination-filter.md), checked against the 220+ learner utterances of
 * __tests__/unit/stt-filter/a1-utterances.json (0 dropped, repeated answers like "sim sim" / "não, não" included).
 */

/** Subtitle / caption credit lines (pt, fr, en, es), on the blocklist form of the text (lowercase, no punctuation). */
const CREDIT_LINES: RegExp[] = [
  // pt: "Legenda por …", "Legendas pela comunidade Amara.org", "Legendado por …", "Tradução e legendas …"
  /^legendas? (por|pela|pelo|de|da|do|feitas?|criadas?|realizadas?)(?! favor\b)\b/,
  /^legendad[oa]s? (por|pela|pelo)\b/,
  /^(tradução|transcrição) e legendas?\b/,
  /^legendas pela comunidade\b/,
  // fr: "Sous-titres réalisés par …", "Sous-titrage ST' 501", "Sous-titres par …"
  /^sous titres? (réalisés?|réalisé|faits?|par|fait|de|créés?)\b/,
  /^sous titrage\b/,
  // en: "Subtitles by …", "Captions by …", "Subtitled by …", "Transcribed by …"
  /^(subtitles?|captions?|closed captions?|subtitled|captioned|transcribed|transcription|translated) by\b/,
  // es: "Subtítulos por …", "Subtítulos realizados por …", "Subtitulado por …"
  /^subt[ií]tulos? (por|de|realizados?|hechos?|creados?|en espa[ñn]ol)\b/,
  /^subtitulad[oa] por\b/,
];

const CREDIT_MAX_WORDS = 12;
const MUSIC = /^[♪♫♬♩🎵🎶]$/u;
const isMusicChar = (c: string) => MUSIC.test(c);
/** Share of the words a looped phrase must cover to make the whole answer a loop. */
const LOOP_COVERAGE = 0.7;

export type PatternVerdict = 'pattern_credits' | 'music' | 'repetition' | null;

/** Subtitle credit line ("Legenda por Sônia Ruberti"): `normalized` is the blocklist form of the text. */
function isCreditLine(normalized: string): boolean {
  if (!normalized || normalized.split(' ').length > CREDIT_MAX_WORDS) return false;
  return CREDIT_LINES.some(re => re.test(normalized));
}

/** Music symbols ♪♫ wrapping the text, or text that is mostly symbols / a loop once they are removed. */
function isMusic(raw: string, words: string[]): boolean {
  const chars = [...raw.trim()];
  const symbols = chars.filter(isMusicChar).length;
  if (!symbols) return false;
  const wrapped = isMusicChar(chars[0]) || isMusicChar(chars[chars.length - 1]);
  return wrapped || words.length <= 3 * symbols || longestLoop(words) !== null;
}

/**
 * The same 1–3-word phrase repeated back to back, covering most of the answer: "E aí E aí E aí E aí". Two repeats are a
 * learner's ("sim sim", "não, não"); a one-word loop needs 4 ("sim, sim, sim" stays).
 */
function longestLoop(words: string[]): { size: number; repeats: number } | null {
  for (let size = 1; size <= 3; size++) {
    for (let start = 0; start + size <= words.length; start++) {
      const phrase = words.slice(start, start + size).join(' ');
      let repeats = 1;
      while (words.slice(start + repeats * size, start + (repeats + 1) * size).join(' ') === phrase) repeats++;
      const needed = size === 1 ? 4 : 3;
      if (repeats >= needed && (repeats * size) / words.length >= LOOP_COVERAGE) return { size, repeats };
    }
  }
  return null;
}

/** First pattern rule the answer matches, or null. `raw` is the provider text, `normalized` its blocklist form. */
export function patternVerdict(raw: string, normalized: string): PatternVerdict {
  if (!normalized && ![...raw].some(isMusicChar)) return null;
  const words = normalized ? normalized.split(' ') : [];
  if (isCreditLine(normalized)) return 'pattern_credits';
  if (isMusic(raw, words)) return 'music';
  if (longestLoop(words)) return 'repetition';
  return null;
}
