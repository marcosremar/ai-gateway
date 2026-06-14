import type { RegexMatchRule, RuleContext, RuleResult } from '../types';

/**
 * Cap on the text length a (operator-supplied) regex is tested against. A
 * catastrophic-backtracking pattern can take seconds-to-minutes on a long
 * adversarial input; bounding the input keeps any single match O(cap) and
 * stops a request body from being used to stall the event loop. Real prompts/
 * completions are far below this.
 */
const MAX_REGEX_INPUT_CHARS = 100_000;

/**
 * Cap on the operator-supplied PATTERN length itself. An enormous pattern is a
 * separate amplification vector from a long input (compilation + matching cost
 * scale with pattern size too); a real moderation regex is a few hundred chars
 * at most. Reject oversized patterns rather than compiling them.
 */
const MAX_REGEX_PATTERN_CHARS = 4_000;

export function runRegexMatch(rule: RegexMatchRule, ctx: RuleContext): RuleResult {
  if (typeof rule.pattern !== 'string' || rule.pattern.length > MAX_REGEX_PATTERN_CHARS) {
    return { pass: false, reason: 'Invalid regex pattern: too long or not a string' };
  }
  let re: RegExp;
  try {
    re = new RegExp(rule.pattern, 'i');
  } catch {
    return { pass: false, reason: `Invalid regex pattern: ${rule.pattern}` };
  }

  const text =
    ctx.text.length > MAX_REGEX_INPUT_CHARS
      ? ctx.text.slice(0, MAX_REGEX_INPUT_CHARS)
      : ctx.text;
  const matched = re.test(text);
  const pass = rule.not ? !matched : matched;

  return {
    pass,
    reason: pass ? undefined : rule.not
      ? `Text matched forbidden pattern: ${rule.pattern}`
      : `Text did not match required pattern: ${rule.pattern}`,
  };
}
