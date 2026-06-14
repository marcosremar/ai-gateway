import type { RegexMatchRule, RuleContext, RuleResult } from '../types';

/**
 * Cap on the text length a (operator-supplied) regex is tested against. A
 * catastrophic-backtracking pattern can take seconds-to-minutes on a long
 * adversarial input; bounding the input keeps any single match O(cap) and
 * stops a request body from being used to stall the event loop. Real prompts/
 * completions are far below this.
 */
const MAX_REGEX_INPUT_CHARS = 100_000;

export function runRegexMatch(rule: RegexMatchRule, ctx: RuleContext): RuleResult {
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
