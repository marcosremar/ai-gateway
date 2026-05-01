import type { ModelWhitelistRule, RuleContext, RuleResult } from '../types';

export function runModelWhitelist(rule: ModelWhitelistRule, ctx: RuleContext): RuleResult {
  const model = ctx.model ?? '';
  const inList = rule.models.some(m => m === model);
  // Default (not=false): pass when model IS in the list
  // Inverted (not=true): pass when model is NOT in the list (blocklist mode)
  const pass = rule.not ? !inList : inList;

  return {
    pass,
    reason: pass ? undefined : rule.not
      ? `Model "${model}" is blocked`
      : `Model "${model}" is not in the allowed list: [${rule.models.join(', ')}]`,
  };
}
