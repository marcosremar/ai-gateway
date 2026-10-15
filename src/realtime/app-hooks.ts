const MAX_INTERCEPT_RULES = 32;
const MAX_RULE_PHRASES = 64;
const MAX_PHRASE_CHARS = 80;
const MAX_SAY_CHARS = 400;
const MAX_DENY_PHRASES = 256;

const TAG = /^[a-z][a-z0-9_.-]{0,39}$/;
const isText = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const optionalVoice = (v: unknown) => v === undefined || isText(v, 128);

function phrasesProblem(list: unknown, max = MAX_RULE_PHRASES): string | null {
  if (list === undefined) return null;
  if (!Array.isArray(list) || list.length > max) return `at most ${max} phrases`;
  return list.every(p => isText(p, MAX_PHRASE_CHARS)) ? null : `a phrase is a non-empty string of at most ${MAX_PHRASE_CHARS} characters`;
}

function sayProblem(line: Record<string, unknown>): string | null {
  if (!isText(line.text, MAX_SAY_CHARS)) return `"text" is a non-empty string of at most ${MAX_SAY_CHARS} characters`;
  return optionalVoice(line.voice) && optionalVoice(line.fallback_voice) ? null : '"voice" and "fallback_voice" are voice ids';
}

function ruleProblem(rule: unknown): string | null {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return 'a rule is an object';
  const r = rule as Record<string, unknown>;
  if (typeof r.tag !== 'string' || !TAG.test(r.tag)) return `"tag" must match ${TAG.source}`;
  if (r.action !== 'drop' && r.action !== 'say') return '"action" is "drop" or "say"';
  const phrases = phrasesProblem(r.contains) ?? phrasesProblem(r.whole);
  if (phrases) return phrases;
  if (![r.contains, r.whole].some(list => Array.isArray(list) && list.length > 0)) return 'a rule needs "contains" or "whole" phrases';
  if (r.question !== undefined && typeof r.question !== 'boolean') return '"question" is a boolean';
  return r.action === 'say' ? sayProblem(r) : null;
}

export function hooksProblem(config: Record<string, unknown>): string | null {
  const { intercepts, say, reply_guard: guard } = config;
  if (guard !== undefined) {
    if (!guard || typeof guard !== 'object' || Array.isArray(guard)) return '"reply_guard" is an object {deny, note?}';
    const g = guard as Record<string, unknown>;
    const problem = !Array.isArray(g.deny) || !g.deny.length ? '"deny" is a non-empty list of phrases' : phrasesProblem(g.deny, MAX_DENY_PHRASES);
    if (problem) return `reply_guard: ${problem}`;
    if (g.note !== undefined && !isText(g.note, MAX_SAY_CHARS)) return `reply_guard: "note" is a non-empty string of at most ${MAX_SAY_CHARS} characters`;
  }
  if (intercepts !== undefined) {
    if (!Array.isArray(intercepts) || intercepts.length > MAX_INTERCEPT_RULES) return `"intercepts" is a list of at most ${MAX_INTERCEPT_RULES} rules`;
    for (const [i, rule] of intercepts.entries()) {
      const problem = ruleProblem(rule);
      if (problem) return `intercepts[${i}]: ${problem}`;
    }
  }
  if (say === undefined) return null;
  if (!say || typeof say !== 'object' || Array.isArray(say)) return '"say" is an object {text, voice?, fallback_voice?, history?, tag?}';
  const problem = sayProblem(say as Record<string, unknown>);
  return problem ? `say: ${problem}` : null;
}
