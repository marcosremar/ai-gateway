import type { NotNullRule, RuleContext, RuleResult } from '../types';

export function runNotNull(rule: NotNullRule, ctx: RuleContext): RuleResult {
  const isEmpty = !ctx.text || ctx.text.trim().length === 0;
  // Default (not=false): pass when content is present (not empty)
  // Inverted (not=true): pass when content IS empty
  const pass = rule.not ? isEmpty : !isEmpty;

  return {
    pass,
    reason: pass ? undefined : rule.not
      ? 'Expected empty response but content was present'
      : 'Response is empty or null',
  };
}
