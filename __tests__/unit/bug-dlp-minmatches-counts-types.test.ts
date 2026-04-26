/**
 * Bug: DLP detectPII() compares minMatches against the count of UNIQUE
 * pattern *types*, not the count of matches. The config field is named
 * "Minimum matches before triggering" — so 5 credit cards should obviously
 * trip a minMatches=2 threshold. Today it doesn't, because that's still
 * only ONE type. Result: anyone setting minMatches > 1 to require multiple
 * PII findings gets a silently weaker filter than the docs imply.
 */
import { describe, it, expect } from 'vitest';
import { detectPII } from '../../src/gateway/providers/cloud/dlp';

describe('detectPII — minMatches counts MATCHES not unique TYPES', () => {
  it('triggers when there are minMatches+ matches of the SAME type', () => {
    const text = 'cards: 4111111111111111, 4222222222222222, 4333333333333333';
    const result = detectPII(text, {
      enabled: true,
      patterns: { creditCard: true },
      action: 'block',
      minMatches: 2, // require at least 2 PII matches
    });
    // 3 credit-card matches, all type 'creditCard' → must trigger.
    expect(result.matches.length).toBeGreaterThanOrEqual(3);
    expect(result.detected).toBe(true);
    expect(result.action).toBe('block');
  });
});
