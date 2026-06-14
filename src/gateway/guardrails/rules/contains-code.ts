import type { ContainsCodeRule, RuleContext, RuleResult } from '../types';

// Heuristic patterns per language — look for common structural markers
const PATTERNS: Record<string, RegExp[]> = {
  sql: [
    /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)\b/i,
    /\bFROM\s+\w+/i,
    /\bWHERE\s+\w+/i,
  ],
  python: [
    /\bdef\s+\w+\s*\(/,
    /\bimport\s+\w+/,
    /\bprint\s*\(/,
    /:\s*\n\s+/,
  ],
  javascript: [
    /\bfunction\s+\w+\s*\(/,
    /\b(const|let|var)\s+\w+\s*=/,
    /=>\s*[{(]/,
    /console\.(log|error|warn)\s*\(/,
  ],
  typescript: [
    /\binterface\s+\w+/,
    /:\s*(string|number|boolean|void|any)\b/,
    /\btype\s+\w+\s*=/,
    /\basync\s+function/,
  ],
  html: [
    /<\s*(html|head|body|div|span|p|a|h[1-6])\b/i,
    /<\/\s*\w+\s*>/,
    /<!DOCTYPE\s+html>/i,
  ],
};

/**
 * Cap on the text these heuristic regexes are tested against. Several patterns
 * (e.g. `:\s*\n\s+`, `<\/\s*\w+\s*>`) can backtrack on long adversarial input;
 * bounding the input keeps each `.test()` O(cap) so a giant body can't stall
 * the event loop. Real prompts/completions are far below this.
 */
const MAX_CODE_INPUT_CHARS = 100_000;

/** Minimum pattern hits within a single language to call it "code". */
const MIN_PATTERN_HITS = 2;

function detectLanguage(rawText: string, language: string): boolean {
  const text = rawText.length > MAX_CODE_INPUT_CHARS ? rawText.slice(0, MAX_CODE_INPUT_CHARS) : rawText;
  if (language === 'any') {
    // Require >=2 hits WITHIN ONE language, same threshold as a specific
    // language. The old single-`.some()` flagged code on a lone keyword (e.g.
    // the word "SELECT" or "import" in ordinary prose), a noisy false positive.
    // Demanding two structural markers in the same language cuts that without
    // weakening real-code detection.
    return Object.values(PATTERNS).some(
      pats => pats.filter(p => p.test(text)).length >= MIN_PATTERN_HITS,
    );
  }
  const pats = PATTERNS[language];
  if (!pats) return false;
  // Require at least 2 pattern matches for higher confidence
  return pats.filter(p => p.test(text)).length >= MIN_PATTERN_HITS;
}

export function runContainsCode(rule: ContainsCodeRule, ctx: RuleContext): RuleResult {
  const lang = rule.language ?? 'any';
  const hasCode = detectLanguage(ctx.text, lang);
  const pass = rule.not ? hasCode : !hasCode;

  return {
    pass,
    reason: pass ? undefined : rule.not
      ? `Text does not contain expected ${lang} code`
      : `Text contains ${lang === 'any' ? '' : lang + ' '}code`,
  };
}
