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

function detectLanguage(text: string, language: string): boolean {
  if (language === 'any') {
    return Object.values(PATTERNS).some(pats => pats.some(p => p.test(text)));
  }
  const pats = PATTERNS[language];
  if (!pats) return false;
  // Require at least 2 pattern matches for higher confidence
  return pats.filter(p => p.test(text)).length >= 2;
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
