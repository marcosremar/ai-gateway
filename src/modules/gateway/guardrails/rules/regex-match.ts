import type { RegexMatchRule, RuleContext, RuleResult } from '../types';

export function runRegexMatch(rule: RegexMatchRule, ctx: RuleContext): RuleResult {
  let re: RegExp;
  try {
    re = new RegExp(rule.pattern, 'i');
  } catch {
    return { pass: false, reason: `Invalid regex pattern: ${rule.pattern}` };
  }

  const matched = re.test(ctx.text);
  const pass = rule.not ? !matched : matched;

  return {
    pass,
    reason: pass ? undefined : rule.not
      ? `Text matched forbidden pattern: ${rule.pattern}`
      : `Text did not match required pattern: ${rule.pattern}`,
  };
}
