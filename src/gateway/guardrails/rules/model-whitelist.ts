import type { ModelWhitelistRule, RuleContext, RuleResult } from '../types';

export function runModelWhitelist(rule: ModelWhitelistRule, ctx: RuleContext): RuleResult {
  const model = ctx.model ?? '';
  // An absent/empty model can never be a legitimately-allowlisted model. In
  // allowlist mode (not=false) it must FAIL even if someone accidentally put an
  // empty string in `rule.models`; in blocklist mode (not=true) an empty model
  // is "not in the blocklist" and passes. Treating empty as never-in-list makes
  // both branches behave correctly and prevents an empty `models` entry from
  // silently allowing unidentified requests through.
  const inList = model.length > 0 && rule.models.some(m => m === model);
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
