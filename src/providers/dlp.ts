export * from '../gateway/providers/cloud/dlp';

import type { DLPConfig } from '../gateway/providers/cloud/dlp';

/**
 * A SECURE-default DLP configuration (#677).
 *
 * `DEFAULT_DLP_CONFIG` ships `enabled: false` and `action: 'flag'` — sensible as
 * a library default (don't surprise callers), but it means a deployment that
 * merely "turns DLP on" without re-reading every field still silently flags-and-
 * forwards PII rather than blocking it. For a compliance feature the safer
 * posture is opt-OUT, not opt-in.
 *
 * This factory returns a config that is enabled, blocks on detection, and turns
 * on the high-confidence built-in detectors (credit card, SSN, email). It does
 * NOT mutate `DEFAULT_DLP_CONFIG` and is NOT wired anywhere — it's the explicit,
 * localized "secure baseline" an operator can pass to `detectPII` /
 * `createDLPMiddleware` instead of hand-assembling one (and forgetting to flip
 * `enabled`/`action`). Override fields via `opts`.
 *
 * Phone / IP / date-of-birth stay OFF by default because their detectors are the
 * most false-positive-prone; enable them deliberately per deployment.
 */
export function secureDefaultDlpConfig(opts: Partial<DLPConfig> = {}): DLPConfig {
  return {
    enabled: true,
    patterns: {
      creditCard: true,
      ssn: true,
      email: true,
      phone: false,
      ipAddress: false,
      dateOfBirth: false,
      ...(opts.patterns ?? {}),
    },
    action: opts.action ?? 'block',
    minMatches: opts.minMatches ?? 1,
    customPatterns: opts.customPatterns,
  };
}
